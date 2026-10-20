import { bulkOutcome, bulkRows, bulkSingle, isBulk, nextTags, runPool, type BulkResult, type Proposal, type ProposalOutcome, type ProposedAction } from "../../shared/desk-assistant.ts";
import type { ConversationSummary } from "../../shared/protocol.ts";
import { api, ApiError, describeError } from "../api.ts";
import { queueInboxIntent } from "../inbox/intents.ts";
import { configuredProviders } from "../inbox/IssueDialog.tsx";
import { navigate } from "../lib/router.ts";
import type { TrackerStatus } from "../settings/IssueTrackersPanel.tsx";

// I-19 (D-127): what Confirm on one of the assistant's cards does. Each one calls the desk's own route
// with this person's session, so the routes' checks apply (agents can't add knowledge, a teammate
// must be in the workspace…). A reply is only ever put in the composer; this never sends to a visitor,
// except D-133's visitor invite, whose exact text the card showed.

const done = (detail: string): ProposalOutcome => ({ status: "done", detail });

export async function runProposal(workspaceId: string, action: ProposedAction): Promise<ProposalOutcome> {
  const p = action.proposal;
  const w = `/workspaces/${workspaceId}`;
  const named = action.labels.target ? `“${action.labels.target}”` : "it";
  try {
    switch (p.kind) {
      case "assign":
        await api(`/conversations/${p.conversationId}`, { method: "PATCH", body: { assigneeId: p.assigneeId } });
        return done(p.assigneeId ? `assigned to ${action.labels.assignee ?? "the teammate"}` : "unassigned");
      case "status":
        await api(`/conversations/${p.conversationId}`, { method: "PATCH", body: { status: p.status } });
        return done(`the chat is now ${p.status}`);
      case "handling":
        await api(`/conversations/${p.conversationId}`, { method: "PATCH", body: { handling: p.handling } });
        return done(p.handling === "ai" ? "the AI has the chat again and answers the customer's next message" : "the team has the chat now; the AI won't answer it");
      case "tags": {
        // The tags as they are now, so a teammate's change since the proposal isn't lost.
        const { conversation } = await api<{ conversation: ConversationSummary }>(`/conversations/${p.conversationId}`);
        const tags = nextTags(conversation.tags, p.add, p.remove);
        await api(`/conversations/${p.conversationId}/tags`, { method: "PUT", body: { tags } });
        return done(tags.length ? `its tags are now ${tags.join(", ")}` : "it has no tags now");
      }
      case "note":
        // An internal note: only the team sees it (never the visitor or the support AI).
        await api(`/conversations/${p.conversationId}/messages`, { body: { clientMsgId: `home:${action.callId}`, body: p.body, internal: true } });
        return done("the note is on the chat");
      case "reply_draft":
        queueInboxIntent(p.conversationId, { draft: p.body });
        navigate(`/inbox/${p.conversationId}`);
        return done("the chat is open with the reply in its composer; it is not sent until the person sends it");
      case "issue": {
        const trackers = await api<TrackerStatus>(`${w}/trackers`);
        if (!configuredProviders(trackers).length) return { status: "failed", detail: "no issue tracker is connected (Settings → Issue trackers)" };
        queueInboxIntent(p.conversationId, { issue: true });
        navigate(`/inbox/${p.conversationId}`);
        return done("the issue dialog is open on the chat for the person to check and file");
      }
      case "invite_visitor":
        await api(`${w}/visitors/${encodeURIComponent(p.sessionId)}/invite`, { body: { body: p.body } });
        return done("the invite is on the visitor's page; if they answer, the chat starts and is assigned to the person");
      case "contact":
        await api(`${w}/contacts/${p.contactId}`, { method: "PATCH", body: { ...(p.name ? { name: p.name } : {}), ...(p.email ? { email: p.email } : {}) } });
        return done("the contact's details are saved");
      case "agent_file":
        return await saveAgentFile(w, action, p);
      case "desk_settings":
        await api(`${w}/inbox`, { method: "PATCH", body: p.patch });
        return done("saved and live on the widget; desk.yaml has a new version, so History on the Agent page can undo it");
      case "ai_settings": {
        // The route takes the whole set: today's values with the asked ones changed (per-job models are kept).
        const { settings } = await api<{ settings: { enabled: boolean; provider: string; model: string | null; monthlyReplyCap: number } }>(`${w}/ai`);
        const next = { enabled: settings.enabled, provider: settings.provider, model: settings.model, monthlyReplyCap: settings.monthlyReplyCap, ...p.patch };
        await api(`${w}/ai`, { method: "PUT", body: next });
        return done("the AI settings are saved and desk.yaml has a new version (History can undo it)");
      }
      case "knowledge_website":
        await api(`${w}/knowledge/websites`, { body: { url: p.url, maxPages: p.maxPages } });
        return done("it's being read now and shows on the Knowledge page");
      case "knowledge_text":
        await api(`${w}/knowledge/snippets`, { body: { title: p.title, body: p.body } });
        return done("the document is in the knowledge");
      case "knowledge_resync":
        await api(`${w}/knowledge/${p.sourceId}/sync`, { body: {} });
        return done(`${named} is being read again (the Knowledge page shows when it's done)`);
      case "knowledge_edit":
        await api(`${w}/knowledge/${p.sourceId}`, { method: "PATCH", body: p.patch });
        return done(p.patch.maxPages !== undefined || p.patch.exclude !== undefined ? "saved; it applies from the next sync" : "saved");
      case "knowledge_remove_page":
        await api(`${w}/knowledge/${p.sourceId}/documents/${p.documentId}`, { method: "DELETE" });
        return done("the page is out of the knowledge");
      case "knowledge_remove":
        await api(`${w}/knowledge/${p.sourceId}`, { method: "DELETE" });
        return done(`${named} is out of the knowledge`);
      case "saved_reply_create":
        await api(`${w}/saved-replies`, { body: { title: p.title, body: p.body } });
        return done("the team can use it from the composer now");
      case "saved_reply_edit":
        await api(`${w}/saved-replies/${p.replyId}`, { method: "PATCH", body: { title: p.title, body: p.body } });
        return done("the saved reply is updated");
      case "saved_reply_delete":
        await api(`${w}/saved-replies/${p.replyId}`, { method: "DELETE" });
        return done(`${named} is deleted`);
      case "tag_rename":
        await api(`${w}/tags/${p.tagId}`, { method: "PATCH", body: { name: p.name } });
        return done(`the tag is “${p.name}” on every chat now`);
      case "tag_delete":
        await api(`${w}/tags/${p.tagId}`, { method: "DELETE" });
        return done(`${named} is gone from every chat`);
      case "topic_rename":
        await api(`${w}/topics/${p.topicId}`, { method: "PATCH", body: { name: p.name } });
        return done(`the topic is “${p.name}” now`);
      case "topic_merge": {
        const r = await api<{ moved: number }>(`${w}/topics/${p.topicId}/merge`, { body: { into: p.into } });
        return done(`${r.moved} chat${r.moved === 1 ? "" : "s"} moved into “${action.labels.detail ?? "the other topic"}” and ${named} is deleted`);
      }
      case "topic_delete":
        await api(`${w}/topics/${p.topicId}`, { method: "DELETE" });
        return done(`${named} is deleted; its chats get a topic again at the next labelling`);
      case "topic_label": {
        const r = await api<{ labeled: number; unlabeled: number; skipped?: string }>(`${w}/topics/label`, { body: {} });
        if (r.skipped) return { status: "failed", detail: r.skipped };
        return done(`${r.labeled} chat${r.labeled === 1 ? "" : "s"} labelled${r.unlabeled ? `, ${r.unlabeled} still without a topic` : ""}`);
      }
      case "team_invite": {
        const r = await api<{ url: string }>(`${w}/invites`, { body: { role: p.role } });
        // The link is for the person only: it shows on the card, and the model is told it was made.
        return { status: "done", detail: `made an invite link for an ${p.role}; it's on the card for the person to copy and send`, link: r.url };
      }
      case "team_revoke_invite":
        await api(`${w}/invites/${p.inviteId}`, { method: "DELETE" });
        return done("the invite link no longer works");
      case "team_role":
        await api(`${w}/members/${p.userId}`, { method: "PATCH", body: { role: p.role } });
        return done(`${action.labels.target ?? "they"} ${p.role === "admin" ? "is an admin" : "is an agent"} now`);
      case "team_remove":
        await api(`${w}/members/${p.userId}`, { method: "DELETE" });
        return done(`${action.labels.target ?? "they"} no longer ${action.labels.target ? "has" : "have"} access`);
      case "notifications":
        await api(`${w}/notifications`, { method: "PUT", body: p.patch });
        return done("your notifications are saved");
      case "workspace_name":
        await api(w, { method: "PATCH", body: { name: p.name } });
        return done(`the workspace is called “${p.name}” (the sidebar shows it after a reload)`);
      case "email_settings":
        await api(`${w}/email`, { method: "PUT", body: p.patch });
        return done("the email settings are saved");
      case "email_test": {
        const r = await api<{ to: string; local?: boolean }>(`${w}/email/test`, { body: p.to ? { to: p.to } : {} });
        return done(`sent to ${r.to}${r.local ? " (this local desk writes it to a file instead of sending it)" : ""}`);
      }
      case "identity_off":
        await api(`${w}/identity`, { method: "DELETE" });
        return done("identity verification is off; turning it on again (Playground → Behaviour) makes a new secret");
      case "bulk":
      case "bulk_delete":
        return await runBulk(workspaceId, action, bulkRows(p).map((i) => i.id), () => {});
    }
  } catch (error) {
    return { status: "failed", detail: describeError(error) };
  }
}

/**
 * D-133: one agent file, saved the way the Agent page saves (the whole set as a new version, from the
 * version it was read at). The file must still be as the card showed it; a save that races another
 * one is tried once more on the newer version.
 */
async function saveAgentFile(w: string, action: ProposedAction, p: Extract<Proposal, { kind: "agent_file" }>): Promise<ProposalOutcome> {
  for (let attempt = 0; ; attempt++) {
    const agent = await api<{ version: number | null; files: Record<string, string>; generated?: string[] }>(`${w}/agent`);
    if ((agent.files[p.path] ?? null) !== p.before) return { status: "failed", detail: `${p.path} changed since this was proposed: read it again and propose the change on the new text` };
    const files = { ...agent.files };
    // A desk.yaml the desk wrote for display only isn't saved (as on the Agent page).
    for (const path of agent.generated ?? []) delete files[path];
    if (p.after === null) delete files[p.path];
    else files[p.path] = p.after;
    try {
      const saved = await api<{ version: number }>(`${w}/agent`, { method: "PUT", body: { files, base: agent.version, message: `Assistant: ${action.summary}`.slice(0, 500) } });
      return done(`version ${saved.version}; it's live now, and History on the Agent page can undo it`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && attempt === 0) continue;
      if (error instanceof ApiError && Array.isArray(error.detail.issues)) {
        const issues = (error.detail.issues as { path?: string; message?: string }[]).slice(0, 4).map((i) => `${i.path ? `${i.path}: ` : ""}${i.message ?? ""}`);
        return { status: "failed", detail: `the files have problems: ${issues.join("; ")}` };
      }
      throw error;
    }
  }
}

export type BulkRowState = { status: "queued" | "running" | "done" | "failed"; error?: string };
/** Chats run at once on a bulk card. */
const BULK_CONCURRENCY = 3;

/**
 * D-134: a bulk card's rows (chats; D-144: or things deleted), each through its single action's route
 * (so the same checks apply), three at a time; `onRow` reports each row's state as it goes. The rows
 * not in `chosen` are left out.
 */
export async function runBulk(workspaceId: string, action: ProposedAction, chosen: string[], onRow: (id: string, state: BulkRowState) => void): Promise<ProposalOutcome> {
  const p = action.proposal;
  if (!isBulk(p)) return { status: "failed", detail: "not a bulk change" };
  const rows = bulkRows(p);
  const results = new Map<string, BulkResult>();
  for (const row of rows) if (!chosen.includes(row.id)) results.set(row.id, { id: row.id, status: "skipped" });
  const todo = rows.filter((i) => chosen.includes(i.id));
  todo.forEach((i) => onRow(i.id, { status: "queued" }));
  await runPool(todo, BULK_CONCURRENCY, async (row) => {
    onRow(row.id, { status: "running" });
    const labels = p.kind === "bulk" ? { ...action.labels, conversation: row.name } : { ...action.labels, target: row.name };
    const outcome = await runProposal(workspaceId, { ...action, proposal: bulkSingle(p, row.id), labels });
    const ok = outcome.status === "done";
    results.set(row.id, { id: row.id, status: ok ? "done" : "failed", ...(ok ? {} : { error: outcome.detail ?? "failed" }) });
    onRow(row.id, ok ? { status: "done" } : { status: "failed", error: outcome.detail ?? "failed" });
  });
  return bulkOutcome(rows, rows.map((i) => results.get(i.id)!));
}
