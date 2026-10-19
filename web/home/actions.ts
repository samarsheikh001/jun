import { nextTags, type ProposalOutcome, type ProposedAction } from "../../shared/desk-assistant.ts";
import type { ConversationSummary } from "../../shared/protocol.ts";
import { api, describeError } from "../api.ts";
import { queueInboxIntent } from "../inbox/intents.ts";
import { configuredProviders } from "../inbox/IssueDialog.tsx";
import { navigate } from "../lib/router.ts";
import type { TrackerStatus } from "../settings/IssueTrackersPanel.tsx";

// I-19 (D-127): what Confirm on one of the assistant's cards does. Each one calls the desk's own route
// with this person's session, so the routes' checks apply (agents can't add knowledge, a teammate
// must be in the workspace…). A reply is only ever put in the composer; this never sends to a visitor.

export async function runProposal(workspaceId: string, action: ProposedAction): Promise<ProposalOutcome> {
  const p = action.proposal;
  try {
    switch (p.kind) {
      case "assign":
        await api(`/conversations/${p.conversationId}`, { method: "PATCH", body: { assigneeId: p.assigneeId } });
        return { status: "done", detail: p.assigneeId ? `assigned to ${action.labels.assignee ?? "the teammate"}` : "unassigned" };
      case "status":
        await api(`/conversations/${p.conversationId}`, { method: "PATCH", body: { status: p.status } });
        return { status: "done", detail: `the chat is now ${p.status}` };
      case "tags": {
        // The tags as they are now, so a teammate's change since the proposal isn't lost.
        const { conversation } = await api<{ conversation: ConversationSummary }>(`/conversations/${p.conversationId}`);
        const tags = nextTags(conversation.tags, p.add, p.remove);
        await api(`/conversations/${p.conversationId}/tags`, { method: "PUT", body: { tags } });
        return { status: "done", detail: tags.length ? `its tags are now ${tags.join(", ")}` : "it has no tags now" };
      }
      case "note":
        // An internal note: only the team sees it (never the visitor or the support AI).
        await api(`/conversations/${p.conversationId}/messages`, { body: { clientMsgId: `home:${action.callId}`, body: p.body, internal: true } });
        return { status: "done", detail: "the note is on the chat" };
      case "reply_draft":
        queueInboxIntent(p.conversationId, { draft: p.body });
        navigate(`/inbox/${p.conversationId}`);
        return { status: "done", detail: "the chat is open with the reply in its composer; it is not sent until the person sends it" };
      case "issue": {
        const trackers = await api<TrackerStatus>(`/workspaces/${workspaceId}/trackers`);
        if (!configuredProviders(trackers).length) return { status: "failed", detail: "no issue tracker is connected (Settings → Issue trackers)" };
        queueInboxIntent(p.conversationId, { issue: true });
        navigate(`/inbox/${p.conversationId}`);
        return { status: "done", detail: "the issue dialog is open on the chat for the person to check and file" };
      }
      case "knowledge_website":
        await api(`/workspaces/${workspaceId}/knowledge/websites`, { body: { url: p.url, maxPages: p.maxPages } });
        return { status: "done", detail: "it's being read now and shows on the Knowledge page" };
      case "knowledge_text":
        await api(`/workspaces/${workspaceId}/knowledge/snippets`, { body: { title: p.title, body: p.body } });
        return { status: "done", detail: "the document is in the knowledge" };
    }
  } catch (error) {
    return { status: "failed", detail: describeError(error) };
  }
}
