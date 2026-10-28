import type { Message } from "../../shared/protocol.ts";
import { contactLabel } from "../../shared/notifications.ts";
import {
  backfillText, browserName, cardBlocks, fromSlackText, noteModal, SLACK_IDS, threadText, threadUsername,
  type CardFacts, type SlackMode, type ThreadLine,
} from "../../shared/slack.ts";
import type { ConversationRef, Participant, SendResult } from "../conversation.ts";
import { HttpError } from "../types.ts";
import { changeConversation } from "./conversation-change.ts";
import { BROKEN_CODES, brokenText, SlackError, slackApi, validSlackSignature, type SlackApi, type SlackKeys } from "./slack-api.ts";

// C-09 / T-13 (D-152): team replies from Slack. Out: a chat that needs a person opens a thread in the
// workspace's Slack channel (a card on top, then the chat), its messages follow, and the card updates
// with the chat. In: Slack's events (a teammate's thread reply → a reply to the customer as them) and
// interactivity (the card's buttons; "Add internal note" → a modal → a note). Every request from Slack
// is signature-checked and each event handled once. Rules and research: docs/research/09-slack.md.

export interface SlackConnectionRow {
  workspace_id: string;
  team_id: string;
  team_name: string;
  team_url: string | null;
  bot_user_id: string;
  channel_id: string | null;
  channel_name: string | null;
  mode: SlackMode;
  desk_url: string;
  status: "connected" | "broken";
  last_error: string | null;
  created_at: number;
}

interface ThreadRow {
  conversation_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  through_seq: number;
  card: string | null;
}

export async function loadConnection(env: Env, workspaceId: string): Promise<SlackConnectionRow | null> {
  return env.DB.prepare("SELECT * FROM slack_connections WHERE workspace_id = ?").bind(workspaceId).first<SlackConnectionRow>();
}

/** A connection that posts: connected, a channel picked, and the keys still there. */
async function liveLink(env: Env, workspaceId: string): Promise<{ row: SlackConnectionRow & { channel_id: string }; api: SlackApi } | null> {
  const row = await loadConnection(env, workspaceId);
  if (!row || row.status !== "connected" || !row.channel_id) return null;
  const keys = await env.WORKSPACE_HUB.getByName(workspaceId).slackKeys();
  if (!keys) return null;
  return { row: row as SlackConnectionRow & { channel_id: string }, api: slackApi(env, keys.token) };
}

export async function markBroken(env: Env, workspaceId: string, code: string): Promise<void> {
  await env.DB.prepare("UPDATE slack_connections SET status = 'broken', last_error = ? WHERE workspace_id = ?").bind(brokenText(code), workspaceId).run();
}

// ---------- out: the desk → the thread ----------

export type SlackJob = { kind: "open" } | { kind: "message"; message: Message } | { kind: "card" };

/**
 * Runs one job for a conversation. The Conversation DO runs them one after another (a promise chain),
 * so a thread is opened once and messages arrive in order. Never throws; a broken connection is marked
 * for the admin and stops posting.
 */
export async function runSlackJob(env: Env, ref: ConversationRef, job: SlackJob): Promise<{ opened?: boolean }> {
  let link: Awaited<ReturnType<typeof liveLink>> = null;
  try {
    link = await liveLink(env, ref.workspaceId);
    if (!link) return {};
    const thread = await env.DB.prepare("SELECT * FROM slack_threads WHERE conversation_id = ? AND team_id = ?").bind(ref.conversationId, link.row.team_id).first<ThreadRow>();
    if (job.kind === "open") {
      if (thread) return {};
      await openThread(env, ref, link);
      return { opened: true };
    }
    if (job.kind === "card") {
      if (thread) await updateCard(env, ref, link, thread);
      return {};
    }
    const { message } = job;
    if (!thread) {
      // 'all': a chat's first visitor message opens its thread (the backfill carries the message).
      if (link.row.mode === "all" && message.authorType === "visitor") {
        await openThread(env, ref, link);
        return { opened: true };
      }
      return {};
    }
    if (message.seq <= thread.through_seq) return {};
    const line = await threadLine(env, ref, message);
    if (!line) return {};
    await link.api.postMessage({ channel: thread.channel_id, thread_ts: thread.thread_ts, text: threadText(line), username: threadUsername(line), mrkdwn: true });
    return {};
  } catch (error) {
    if (error instanceof SlackError && BROKEN_CODES.has(error.code)) await markBroken(env, ref.workspaceId, error.code).catch(() => {});
    else console.error("slack job failed", job.kind, error);
    return {};
  }
}

/** A message as a thread line; null for what doesn't go to Slack (system lines, what came from Slack, empty). */
async function threadLine(env: Env, ref: ConversationRef, m: Message): Promise<ThreadLine | null> {
  if (m.authorType === "system") return null;
  // A teammate's reply from the thread is already there (notes from the Slack modal aren't: they come as desk notes).
  if (m.meta.via === "slack") return null;
  if (!m.body.trim() && m.attachments.length === 0) return null;
  let author = m.authorName ?? "Teammate";
  if (m.authorType === "visitor") {
    const row = await env.DB.prepare("SELECT ct.id, ct.name, ct.email FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?")
      .bind(ref.conversationId)
      .first<{ id: string; name: string | null; email: string | null }>();
    author = row ? contactLabel(row) : "Customer";
  } else if (m.authorType === "ai") author = "Jun";
  return { authorType: m.authorType, author, body: m.body, attachments: m.attachments, internal: m.internal };
}

async function cardFacts(env: Env, ref: ConversationRef, deskUrl: string): Promise<CardFacts | null> {
  const row = await env.DB.prepare(
    `SELECT c.status, c.handling, c.debug_issue_count, ct.id AS contact_id, ct.name, ct.email, u.name AS assignee, w.slug,
       (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'system' AND m.internal = 1 AND json_extract(m.meta, '$.handoffReason') IS NOT NULL ORDER BY m.seq DESC LIMIT 1) AS brief,
       (SELECT json_extract(m.meta, '$.handoffReason') FROM messages m WHERE m.conversation_id = c.id AND json_extract(m.meta, '$.handoffReason') IS NOT NULL ORDER BY m.seq DESC LIMIT 1) AS reason,
       (SELECT d.context FROM debug_snapshots d WHERE d.conversation_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS context
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN workspaces w ON w.id = c.workspace_id
       LEFT JOIN users u ON u.id = c.assignee_id
     WHERE c.id = ?`,
  )
    .bind(ref.conversationId)
    .first<{
      status: CardFacts["status"]; handling: CardFacts["handling"]; debug_issue_count: number; contact_id: string; name: string | null; email: string | null;
      assignee: string | null; slug: string | null; brief: string | null; reason: string | null; context: string | null;
    }>();
  if (!row) return null;
  let page: string | null = null;
  let browser: string | null = null;
  if (row.context) {
    try {
      const context = JSON.parse(row.context) as { page?: { url?: string }; userAgent?: string };
      if (context.page?.url) page = new URL(context.page.url).pathname;
      browser = browserName(context.userAgent ?? "");
    } catch {
      // an old or odd snapshot: leave the facts out
    }
  }
  // The brief note reads "Handed off to the team. Reason: …\n\n<the AI's brief>".
  const brief = row.brief?.includes("\n\n") ? row.brief.slice(row.brief.indexOf("\n\n") + 2).trim() : null;
  return {
    conversationId: ref.conversationId,
    contact: contactLabel({ id: row.contact_id, name: row.name, email: row.email }),
    contactEmail: row.email,
    status: row.status,
    handling: row.handling,
    assignee: row.assignee,
    reason: row.reason,
    brief: brief || null,
    page,
    browser,
    issues: row.debug_issue_count ?? 0,
    deskUrl: `${deskUrl}${row.slug ? `/w/${row.slug}` : ""}/inbox/${ref.conversationId}`,
  };
}

async function openThread(env: Env, ref: ConversationRef, link: NonNullable<Awaited<ReturnType<typeof liveLink>>>): Promise<void> {
  const facts = await cardFacts(env, ref, link.row.desk_url);
  if (!facts) return;
  const card = cardBlocks(facts);
  const root = await link.api.postMessage({ channel: link.row.channel_id, text: card.text, blocks: card.blocks });
  // What's in the chat so far goes in one message; anything newer is posted on its own.
  const rows = await env.DB.prepare(
    "SELECT seq, author_type, author_id, body, attachments, internal, meta FROM messages WHERE conversation_id = ? ORDER BY seq",
  )
    .bind(ref.conversationId)
    .all<{ seq: number; author_type: Message["authorType"]; author_id: string | null; body: string; attachments: string; internal: number; meta: string }>();
  const through = rows.results.at(-1)?.seq ?? 0;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO slack_threads (conversation_id, workspace_id, team_id, channel_id, thread_ts, through_seq, card, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ref.conversationId, ref.workspaceId, link.row.team_id, root.channel, root.ts, through, card.key, Date.now())
    .run();
  const names = await env.DB.prepare("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?").bind(ref.workspaceId).all<{ id: string; name: string }>();
  const nameOf = new Map(names.results.map((n) => [n.id, n.name]));
  const lines: ThreadLine[] = rows.results
    .filter((r) => r.author_type !== "system")
    .map((r) => ({
      authorType: r.author_type as ThreadLine["authorType"],
      author: r.author_type === "visitor" ? facts.contact : r.author_type === "ai" ? "Jun" : (nameOf.get(r.author_id ?? "") ?? "Teammate"),
      body: r.body,
      attachments: JSON.parse(r.attachments || "[]") as { name: string }[],
      internal: r.internal === 1,
    }));
  const backfill = backfillText(lines);
  if (backfill) await link.api.postMessage({ channel: root.channel, thread_ts: root.ts, text: backfill, mrkdwn: true });
}

async function updateCard(env: Env, ref: ConversationRef, link: NonNullable<Awaited<ReturnType<typeof liveLink>>>, thread: ThreadRow): Promise<void> {
  const facts = await cardFacts(env, ref, link.row.desk_url);
  if (!facts) return;
  const card = cardBlocks(facts);
  if (card.key === thread.card) return;
  await link.api.update({ channel: thread.channel_id, ts: thread.thread_ts, text: card.text, blocks: card.blocks });
  await env.DB.prepare("UPDATE slack_threads SET card = ? WHERE conversation_id = ? AND team_id = ?").bind(card.key, ref.conversationId, thread.team_id).run();
}

// ---------- in: Slack → the desk ----------

/** A Slack user as a teammate in this workspace, matched by email (the same address in Slack and the desk). */
async function teammate(env: Env, api: SlackApi, workspaceId: string, slackUserId: string): Promise<{ member: { userId: string; name: string } | null; slackName: string; email: string | null }> {
  const hub = env.WORKSPACE_HUB.getByName(workspaceId);
  let user = await hub.slackUser(slackUserId);
  if (!user) {
    user = await api.user(slackUserId);
    await hub.setSlackUser(slackUserId, user);
  }
  const row = user.email
    ? await env.DB.prepare("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ? COLLATE NOCASE")
        .bind(workspaceId, user.email)
        .first<{ id: string; name: string }>()
    : null;
  return { member: row ? { userId: row.id, name: row.name } : null, slackName: user.name, email: user.email };
}

async function threadConversation(env: Env, workspaceId: string, teamId: string, channel: string, threadTs: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT conversation_id FROM slack_threads WHERE workspace_id = ? AND team_id = ? AND channel_id = ? AND thread_ts = ?")
    .bind(workspaceId, teamId, channel, threadTs)
    .first<{ conversation_id: string }>();
  return row?.conversation_id ?? null;
}

/** The raw body, checked against the workspace's signing secret. Null when it isn't Slack's. */
async function verified(env: Env, workspaceId: string, request: Request): Promise<{ raw: string; keys: SlackKeys | null; ok: boolean }> {
  const raw = await request.text();
  if (raw.length > 1_000_000) return { raw: "", keys: null, ok: false };
  const keys = await env.WORKSPACE_HUB.getByName(workspaceId).slackKeys();
  const ok = keys ? await validSlackSignature(keys.signingSecret, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), raw) : false;
  return { raw, keys, ok };
}

const notSlack = () => new Response("Not a valid Slack request", { status: 401 });

/** POST /api/slack/:workspaceId/events (Slack's Events API). Answers at once; the work runs after. */
export async function handleSlackEvents(env: Env, ctx: ExecutionContext, workspaceId: string, request: Request): Promise<Response> {
  const { raw, keys, ok } = await verified(env, workspaceId, request);
  let body: { type?: string; challenge?: string; team_id?: string; event_id?: string; event?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Not JSON", { status: 400 });
  }
  // Slack checks the URL when the app is created from the manifest, before anyone could paste the
  // signing secret: only then is the challenge answered unsigned (it carries nothing).
  if (body.type === "url_verification" && typeof body.challenge === "string" && (ok || !keys)) return Response.json({ challenge: body.challenge });
  if (!ok) return notSlack();
  if (body.type !== "event_callback" || !body.event || typeof body.event_id !== "string") return new Response(null, { status: 200 });
  const row = await loadConnection(env, workspaceId);
  if (!row || row.team_id !== body.team_id || !keys) return new Response(null, { status: 200 });
  if (!(await env.WORKSPACE_HUB.getByName(workspaceId).slackEventIsNew(body.event_id))) return new Response(null, { status: 200 });
  ctx.waitUntil(onMessageEvent(env, workspaceId, row, slackApi(env, keys.token), body.event).catch((error) => console.error("slack event failed", error)));
  return new Response(null, { status: 200 });
}

type SlackMessageEvent = {
  type?: string; subtype?: string; user?: string; bot_id?: string; text?: string; ts?: string; thread_ts?: string; channel?: string;
  files?: unknown[]; message?: SlackMessageEvent; previous_message?: SlackMessageEvent;
};

/** A teammate wrote in a chat's thread: the customer gets it as their reply. */
export async function onMessageEvent(env: Env, workspaceId: string, row: SlackConnectionRow, api: SlackApi, raw: Record<string, unknown>): Promise<void> {
  const ev = raw as SlackMessageEvent;
  if (ev.type !== "message" || !ev.channel) return;
  const tell = (user: string, threadTs: string, text: string) => api.postEphemeral({ channel: ev.channel, user, thread_ts: threadTs, text }).catch(() => {});

  // An edit of a reply that already went out: the customer keeps the first version.
  if (ev.subtype === "message_changed") {
    const m = ev.message;
    if (!m?.user || m.bot_id || !m.thread_ts || m.thread_ts === m.ts || m.text === ev.previous_message?.text) return;
    const cid = await threadConversation(env, workspaceId, row.team_id, ev.channel, m.thread_ts);
    if (!cid) return;
    const sent = await env.DB.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND client_msg_id = ?").bind(cid, `slack:${m.ts}`).first();
    if (sent) await tell(m.user, m.thread_ts, "Edits aren't sent on: the customer has the first version. Write a new reply to correct it.");
    return;
  }
  if (ev.subtype && ev.subtype !== "file_share" && ev.subtype !== "thread_broadcast") return;
  // Our own posts, other apps' posts, and anything outside a thread.
  if (ev.bot_id || !ev.user || ev.user === row.bot_user_id || !ev.ts || !ev.thread_ts || ev.thread_ts === ev.ts) return;
  const conversationId = await threadConversation(env, workspaceId, row.team_id, ev.channel, ev.thread_ts);
  if (!conversationId) return;
  const ref: ConversationRef = { conversationId, workspaceId };
  const body = fromSlackText(ev.text ?? "");
  if (ev.files?.length) await tell(ev.user, ev.thread_ts, "Files from Slack aren't sent to the customer yet. Attach it in the desk (Open in desk on the card).");
  if (!body) return;
  const who = await teammate(env, api, workspaceId, ev.user);
  const conversation = env.CONVERSATION.getByName(conversationId);
  if (!who.member) {
    await tell(ev.user, ev.thread_ts, `This didn't go to the customer: ${who.email ? `${who.email} isn't` : "your Slack account has no email that matches"} a teammate on this Jun desk. Use the same email in Slack and Jun, or ask an admin to invite you. It's kept as a note.`);
    await conversation.addNote(ref, `${who.slackName} wrote in Slack, but isn't a teammate on this desk, so the customer didn't get it:\n\n${body}`, `slack:${ev.ts}`);
    return;
  }
  const participant: Participant = { role: "agent", userId: who.member.userId, name: who.member.name };
  const result = (await conversation.receiveSlack(ref, participant, { clientMsgId: `slack:${ev.ts}`, body })) as SendResult;
  if (!result.ok) await tell(ev.user, ev.thread_ts, `This didn't go to the customer: ${result.message}`);
}

/** POST /api/slack/:workspaceId/actions (Slack's interactivity): the card's buttons, the note shortcut and its modal. */
export async function handleSlackActions(env: Env, ctx: ExecutionContext, workspaceId: string, request: Request): Promise<Response> {
  const { raw, keys, ok } = await verified(env, workspaceId, request);
  if (!ok || !keys) return notSlack();
  let payload: SlackPayload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "") as SlackPayload;
  } catch {
    return new Response("Bad payload", { status: 400 });
  }
  const row = await loadConnection(env, workspaceId);
  if (!row || payload.team?.id !== row.team_id || !payload.user?.id) return new Response(null, { status: 200 });
  const api = slackApi(env, keys.token);
  const reply = (text: string) => {
    if (payload.response_url) {
      ctx.waitUntil(fetch(payload.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }) }).catch(() => {}));
    }
  };

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    const change = action?.action_id === SLACK_IDS.assign ? "assign" : action?.action_id === SLACK_IDS.close ? "close" : action?.action_id === SLACK_IDS.reopen ? "reopen" : null;
    if (!change || typeof action?.value !== "string") return new Response(null, { status: 200 });
    const conversationId = action.value;
    ctx.waitUntil(
      (async () => {
        const inWorkspace = await env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND workspace_id = ?").bind(conversationId, workspaceId).first();
        if (!inWorkspace) return;
        const who = await teammate(env, api, workspaceId, payload.user!.id);
        if (!who.member) return reply("Only teammates on this Jun desk can do that. Use the same email in Slack and Jun.");
        const actor = { id: who.member.userId, name: who.member.name };
        const body = change === "assign" ? { assigneeId: actor.id } : { status: change === "close" ? "resolved" : "open" };
        try {
          await changeConversation(env, { conversationId, workspaceId }, body, actor, (p) => ctx.waitUntil(p));
        } catch (error) {
          reply(error instanceof HttpError ? error.message : "That didn't work. Try again in the desk.");
        }
      })().catch((error) => console.error("slack button failed", error)),
    );
    return new Response(null, { status: 200 });
  }

  if (payload.type === "message_action" && payload.callback_id === SLACK_IDS.noteShortcut) {
    const channel = payload.channel?.id ?? "";
    const threadTs = payload.message?.thread_ts ?? payload.message?.ts ?? "";
    const conversationId = channel && threadTs ? await threadConversation(env, workspaceId, row.team_id, channel, threadTs) : null;
    if (!conversationId || !payload.trigger_id) {
      reply("Use *Add internal note* on a message in a chat's thread from Jun.");
      return new Response(null, { status: 200 });
    }
    const contact = await env.DB.prepare("SELECT ct.id, ct.name, ct.email FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?")
      .bind(conversationId)
      .first<{ id: string; name: string | null; email: string | null }>();
    // The trigger lasts 3 seconds: open the modal before answering.
    await api.openView(payload.trigger_id, noteModal(conversationId, contact ? contactLabel(contact) : "the customer")).catch((error) => console.error("slack modal failed", error));
    return new Response(null, { status: 200 });
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === SLACK_IDS.noteModal) {
    const errors = (text: string) => Response.json({ response_action: "errors", errors: { [SLACK_IDS.noteBlock]: text } });
    let conversationId = "";
    try {
      conversationId = String((JSON.parse(payload.view.private_metadata ?? "{}") as { c?: string }).c ?? "");
    } catch {
      // fall through: not found below
    }
    const text = (payload.view.state?.values?.[SLACK_IDS.noteBlock]?.[SLACK_IDS.noteInput]?.value ?? "").trim();
    if (!text) return errors("Write the note first.");
    const inWorkspace = conversationId ? await env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND workspace_id = ?").bind(conversationId, workspaceId).first() : null;
    if (!inWorkspace) return errors("This chat isn't on the desk any more.");
    const who = await teammate(env, api, workspaceId, payload.user.id);
    if (!who.member) return errors("Only teammates on this Jun desk can add notes. Use the same email in Slack and Jun.");
    const participant: Participant = { role: "agent", userId: who.member.userId, name: who.member.name };
    // A note from the desk's side: it shows in the thread like a note written in the desk.
    const result = (await env.CONVERSATION.getByName(conversationId).send({ conversationId, workspaceId }, participant, { clientMsgId: `slack-note:${payload.view.id}`, body: text, internal: true })) as SendResult;
    if (!result.ok) return errors(result.message);
    return new Response(null, { status: 200 });
  }
  return new Response(null, { status: 200 });
}

interface SlackPayload {
  type?: string;
  callback_id?: string;
  trigger_id?: string;
  response_url?: string;
  team?: { id?: string };
  user?: { id: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: { action_id?: string; value?: string }[];
  view?: { id?: string; callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } };
}
