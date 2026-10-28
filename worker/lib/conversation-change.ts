import type { ConversationStatus } from "../../shared/protocol.ts";
import type { ConversationRef } from "../conversation.ts";
import { HttpError } from "../types.ts";
import { notifyTeam } from "./notify.ts";
import { notifyConversationChanged } from "./realtime.ts";

export const STATUSES: ConversationStatus[] = ["open", "pending", "snoozed", "resolved"];

export interface ConversationChange {
  status?: unknown;
  assigneeId?: unknown;
  handling?: unknown;
}

/**
 * A teammate changes a chat's status, assignee or handling: from the desk (PATCH /conversations/:cid)
 * or a Slack thread's buttons (C-09). Throws HttpError for a bad value; tells open views and, for a new
 * assignee, that teammate (I-14; never the one who did it).
 */
export async function changeConversation(
  env: Env,
  ref: ConversationRef,
  body: ConversationChange,
  actor: { id: string; name: string },
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as ConversationStatus)) throw new HttpError(400, "invalid_field", "Unknown status.");
    // W-12: becoming resolved starts a new round the visitor can rate, unless they already rated
    // this round and haven't written since (pending → resolved again doesn't ask twice).
    sets.push(
      `resolution = resolution + (CASE WHEN status != 'resolved' AND ? = 'resolved' AND NOT (
         csat_resolution IS NOT NULL AND csat_resolution = resolution AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.author_type = 'visitor' AND m.created_at > conversations.csat_at)
       ) THEN 1 ELSE 0 END)`,
      "status = ?",
    );
    params.push(body.status, body.status);
  }
  let newAssignee: string | null = null;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null) {
      const member = await env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(ref.workspaceId, String(body.assigneeId)).first();
      if (!member) throw new HttpError(400, "invalid_field", "Assignee must be a member of this workspace.");
      // I-14: tell them, unless it was already theirs (or they assigned themselves: the actor is never notified).
      const current = await env.DB.prepare("SELECT assignee_id FROM conversations WHERE id = ?").bind(ref.conversationId).first<{ assignee_id: string | null }>();
      if (current?.assignee_id !== body.assigneeId) newAssignee = String(body.assigneeId);
    }
    sets.push("assignee_id = ?");
    params.push(body.assigneeId);
  }
  if (body.handling !== undefined) {
    // "Hand back to AI" (or take over without replying).
    if (body.handling !== "ai" && body.handling !== "human") throw new HttpError(400, "invalid_field", "handling must be ai or human.");
    sets.push("handling = ?");
    params.push(body.handling);
  }
  if (sets.length === 0) throw new HttpError(400, "invalid_body", "Nothing to change.");

  await env.DB.prepare(`UPDATE conversations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...params, Date.now(), ref.conversationId)
    .run();
  await notifyConversationChanged(env, ref);
  if (newAssignee) waitUntil(notifyTeam(env, ref, { kind: "assigned", actorId: actor.id, targets: [newAssignee] }, { by: actor.name }));
}
