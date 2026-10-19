import { BRIEF_SYSTEM, briefPoints, briefPrompt, briefWindows, plainBrief, readBriefAnswer, type Brief, type BriefInput, type WaitingChat } from "../../shared/home-brief.ts";
import type { AuthorType } from "../../shared/protocol.ts";
import type { SnapshotEvents } from "../../shared/metrics.ts";
import { contactLabel } from "../../shared/notifications.ts";
import { loadMetricRows } from "../lib/metrics-data.ts";
import { editorSettings } from "./edit-stream.ts";
import { AiUnavailableError, completeText, createModel, type AgentModel } from "./providers.ts";
import { recordUsage } from "./topics.ts";

// I-19 (D-127): the rows behind Home's daily brief and the AI pass that words it. The numbers are
// worked out in shared/home-brief.ts; the model gets a compact facts JSON and only writes sentences,
// each checked against its point's numbers. Cached per member per day in D1 (home_briefs).

/** Most debug snapshots of chats with browser problems the brief reads (nine days). */
const MAX_ISSUE_SNAPSHOTS = 2000;
const MAX_WAITING = 200;

/** Whether Home's AI (brief words and the ask box) can run now, and its model; else why not. */
export type AssistantAvailability = { model: AgentModel } | { skipped: "ai_off" | "cap_reached" | "unavailable"; message: string };

export async function assistantModel(env: Env, workspaceId: string): Promise<AssistantAvailability> {
  const settings = await editorSettings(env, workspaceId);
  if ("skipped" in settings) {
    return settings.skipped === "ai_off"
      ? { skipped: "ai_off", message: "The AI is off for this workspace. Turn it on in Settings → AI to ask questions here." }
      : { skipped: "cap_reached", message: "This month's AI cap is reached, so the assistant is paused until next month (Settings → AI)." };
  }
  try {
    return { model: createModel(env, workspaceId, settings, "assistant") };
  } catch (error) {
    if (error instanceof AiUnavailableError) return { skipped: "unavailable", message: error.message };
    throw error;
  }
}

/** Everything the brief counts, for one member, read in one batch plus the Reports queries. */
export async function loadBriefInput(env: Env, workspaceId: string, userId: string, timezone: string, now: number, aiEnabled: boolean): Promise<BriefInput> {
  const w = briefWindows(now, timezone);
  const db = env.DB;
  const [rows, [issues, waiting]] = await Promise.all([
    loadMetricRows(db, workspaceId, { since: w.baselineSince, until: w.until }),
    db.batch([
      db.prepare(
        `SELECT d.conversation_id AS conversationId, json_extract(d.context, '$.page.url') AS pageUrl, json_extract(d.context, '$.events') AS events
         FROM debug_snapshots d JOIN conversations c ON c.id = d.conversation_id
         WHERE d.workspace_id = ? AND c.workspace_id = d.workspace_id AND c.created_at >= ? AND c.created_at < ? AND c.debug_issue_count > 0
         ORDER BY d.created_at DESC LIMIT ?`,
      ).bind(workspaceId, w.baselineSince, w.until, MAX_ISSUE_SNAPSHOTS),
      db.prepare(
        `SELECT c.id, c.assignee_id, c.last_message_at, c.last_message_author, ct.id AS contact_id, ct.name, ct.email
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
         WHERE c.workspace_id = ? AND c.status = 'open' AND c.handling = 'human' ORDER BY c.last_message_at LIMIT ?`,
      ).bind(workspaceId, MAX_WAITING),
    ]),
  ]);
  return {
    now,
    timezone,
    aiEnabled,
    userId,
    facts: rows.conversations,
    ratings: rows.ratings,
    struggles: rows.snapshots,
    issues: issues!.results as unknown as SnapshotEvents[],
    waiting: (waiting!.results as { id: string; assignee_id: string | null; last_message_at: number; last_message_author: AuthorType | null; contact_id: string; name: string | null; email: string | null }[]).map(
      (r): WaitingChat => ({ id: r.id, contact: contactLabel({ id: r.contact_id, name: r.name, email: r.email }), assigneeId: r.assignee_id, lastMessageAt: r.last_message_at, lastAuthor: r.last_message_author }),
    ),
    members: rows.members,
  };
}

/** The brief with the customer's name for each chat it links to. */
async function withChatNames(env: Env, workspaceId: string, brief: Brief): Promise<Brief> {
  const ids = [...new Set(brief.points.flatMap((p) => p.chats))];
  if (!ids.length) return brief;
  const rows = await env.DB.prepare(
    `SELECT c.id, ct.id AS contact_id, ct.name, ct.email FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.workspace_id = ? AND c.id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(workspaceId, ...ids)
    .all<{ id: string; contact_id: string; name: string | null; email: string | null }>();
  return { ...brief, chatNames: Object.fromEntries(rows.results.map((r) => [r.id, contactLabel({ id: r.contact_id, name: r.name, email: r.email })])) };
}

/** The points worded by the AI (sentences that fail the check keep the plain words), or the plain brief; with the chats' names. */
export async function wordBrief(
  env: Env,
  workspaceId: string,
  input: BriefInput,
  who: { name: string; workspaceName: string },
  model: AgentModel | null,
): Promise<Brief> {
  const points = briefPoints(input);
  const meta = { day: briefWindows(input.now, input.timezone).day, timezone: input.timezone, generatedAt: input.now };
  if (!model) return withChatNames(env, workspaceId, plainBrief(points, meta));
  try {
    const { text, totalUsage } = await completeText({
      model: model.model,
      ...model.prompt(BRIEF_SYSTEM),
      messages: [{ role: "user", content: briefPrompt(points, who) }],
      maxOutputTokens: 1500,
      temperature: 0.3,
    });
    await recordUsage(env, workspaceId, totalUsage);
    return await withChatNames(env, workspaceId, readBriefAnswer(text, points, meta) ?? plainBrief(points, meta));
  } catch (error) {
    console.warn("[home] brief: the AI couldn't word it:", (error as Error).message?.slice(0, 200));
    return withChatNames(env, workspaceId, plainBrief(points, meta));
  }
}

export async function storeBrief(env: Env, workspaceId: string, userId: string, brief: Brief): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO home_briefs (workspace_id, user_id, day, timezone, brief, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET day = ?3, timezone = ?4, brief = ?5, created_at = ?6`,
  )
    .bind(workspaceId, userId, brief.day, brief.timezone, JSON.stringify(brief), brief.generatedAt)
    .run();
}
