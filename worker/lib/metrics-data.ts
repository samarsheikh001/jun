import {
  AI_OFF_HANDOFF_REASON,
  MAX_METRIC_CONVERSATIONS,
  MAX_STRUGGLE_SNAPSHOTS,
  type ConversationFacts,
  type RatingRow,
  type ReplyRow,
  type SnapshotEvents,
} from "../../shared/metrics.ts";
import { handoffGroupFor } from "../../shared/handoff-groups.ts";

// A-01: the Reports queries, shared by the metrics route and Home's brief and assistant (I-19), so
// they count the same way. One row of facts per conversation, ratings, replies per teammate and the
// struggle snapshots for a period; shared/metrics.ts does the counting.

// The first message of each kind per conversation, via the (conversation_id, seq) index.
// Internal notes and system messages are never replies; an agent's invite (V-07) comes before
// the visitor's first message, so agent replies count from that message on.
export const CONVERSATION_FACTS = `
  SELECT x.*,
    (SELECT a.created_at FROM messages a WHERE a.conversation_id = x.id AND a.author_type = 'agent' AND a.internal = 0 AND a.created_at >= x.firstVisitorAt ORDER BY a.seq LIMIT 1) AS firstAgentAt,
    (SELECT a.author_id FROM messages a WHERE a.conversation_id = x.id AND a.author_type = 'agent' AND a.internal = 0 AND a.created_at >= x.firstVisitorAt ORDER BY a.seq LIMIT 1) AS firstAgentId
  FROM (
    SELECT c.id, c.created_at AS createdAt, c.status = 'resolved' AS resolved,
      (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'visitor') AS firstVisitorAt,
      (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'ai' AND m.internal = 0) AS firstAiAt,
      -- The visitor-facing handoff notice (the internal brief carries the same reason). A chat
      -- that reached the AI while it was off (?5) went to the team: that's not the AI's handoff.
      (SELECT json_extract(m.meta, '$.handoffReason') FROM messages m
        WHERE m.conversation_id = c.id AND m.author_type = 'system' AND m.internal = 0 AND json_extract(m.meta, '$.handoffReason') IS NOT NULL
          AND json_extract(m.meta, '$.handoffReason') <> ?5
        ORDER BY m.seq LIMIT 1) AS handoffReason,
      -- D-126: when that notice was written, for the time from handoff to the team's reply.
      (SELECT m.created_at FROM messages m
        WHERE m.conversation_id = c.id AND m.author_type = 'system' AND m.internal = 0 AND json_extract(m.meta, '$.handoffReason') IS NOT NULL
          AND json_extract(m.meta, '$.handoffReason') <> ?5
        ORDER BY m.seq LIMIT 1) AS handoffAt,
      EXISTS (SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id AND m.author_type = 'system' AND m.internal = 0 AND json_extract(m.meta, '$.handoffReason') = ?5) AS aiOffHandoff,
      -- A-06: the loader sends the page with the visitor's first message; no extra tracking.
      (SELECT json_extract(d.context, '$.page.url') FROM debug_snapshots d WHERE d.conversation_id = c.id ORDER BY d.created_at LIMIT 1) AS startUrl,
      -- A-02: the AI's topic label.
      c.topic_id AS topicId, (SELECT t.name FROM topics t WHERE t.id = c.topic_id) AS topicName
    FROM conversations c
    WHERE c.workspace_id = ?1 AND c.created_at >= ?2 AND c.created_at < ?3
    ORDER BY c.created_at DESC LIMIT ?4
  ) x`;

export interface MetricRows {
  conversations: ConversationFacts[];
  ratings: RatingRow[];
  replies: ReplyRow[];
  members: { userId: string; name: string }[];
  /** Conversations started in [previous.since, previous.until), when asked for. */
  previousTotal: number | null;
  snapshots: SnapshotEvents[];
  /** The conversation rows were capped at MAX_METRIC_CONVERSATIONS. */
  truncated: boolean;
}

/** The rows for conversations created in [since, until) (and the count for the period before, if given). */
export async function loadMetricRows(
  db: D1Database,
  workspaceId: string,
  period: { since: number; until: number; previous?: { since: number; until: number } },
): Promise<MetricRows> {
  const { since, until, previous } = period;
  const [conversations, ratings, replies, members, before, snapshots, groups] = await db.batch([
    db.prepare(CONVERSATION_FACTS).bind(workspaceId, since, until, MAX_METRIC_CONVERSATIONS + 1, AI_OFF_HANDOFF_REASON),
    db.prepare(
      `SELECT conversation_id AS conversationId, rating, CASE WHEN rating = 'bad' THEN comment END AS comment, created_at AS createdAt
       FROM csat_ratings WHERE workspace_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(workspaceId, since, until, MAX_METRIC_CONVERSATIONS),
    db.prepare(
      `SELECT m.author_id AS userId, COUNT(*) AS replies, COUNT(DISTINCT m.conversation_id) AS conversations
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.workspace_id = ? AND m.author_type = 'agent' AND m.internal = 0 AND m.author_id IS NOT NULL AND m.created_at >= ? AND m.created_at < ?
       GROUP BY m.author_id`,
    ).bind(workspaceId, since, until),
    db.prepare("SELECT u.id AS userId, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?").bind(workspaceId),
    // The change against the period before: one count, no per-conversation facts.
    db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ? AND created_at >= ? AND created_at < ?").bind(workspaceId, previous?.since ?? 0, previous?.until ?? 0),
    // A-08: the trails the loader sent with the period's chats (events only, not the whole context).
    db.prepare(
      `SELECT d.conversation_id AS conversationId, json_extract(d.context, '$.page.url') AS pageUrl, json_extract(d.context, '$.events') AS events
       FROM debug_snapshots d JOIN conversations c ON c.id = d.conversation_id
       WHERE d.workspace_id = ? AND c.workspace_id = d.workspace_id AND c.created_at >= ? AND c.created_at < ?
         AND (d.context LIKE '%"rage_click"%' OR d.context LIKE '%"dead_click"%' OR d.context LIKE '%"stuck"%')
       ORDER BY d.created_at DESC LIMIT ?`,
    ).bind(workspaceId, since, until, MAX_STRUGGLE_SNAPSHOTS),
    // D-137: the AI's short groups for handoff reasons, by the reason's loose key.
    db.prepare("SELECT reason_key AS k, grp FROM handoff_groups WHERE workspace_id = ? AND grp IS NOT NULL").bind(workspaceId),
  ]);
  const byKey = new Map((groups!.results as { k: string; grp: string }[]).map((r) => [r.k, r.grp]));
  type Row = Omit<ConversationFacts, "resolved" | "aiOffHandoff"> & { resolved: number; aiOffHandoff: number };
  const rows = (conversations!.results as unknown as Row[]).map((r) => ({ ...r, resolved: r.resolved === 1, aiOffHandoff: r.aiOffHandoff === 1, handoffGroup: handoffGroupFor(r.handoffReason, byKey) }));
  const truncated = rows.length > MAX_METRIC_CONVERSATIONS;
  return {
    conversations: truncated ? rows.slice(0, MAX_METRIC_CONVERSATIONS) : rows,
    ratings: ratings!.results as unknown as RatingRow[],
    replies: replies!.results as unknown as ReplyRow[],
    members: members!.results as unknown as { userId: string; name: string }[],
    previousTotal: previous ? ((before!.results[0] as { n: number } | undefined)?.n ?? null) : null,
    snapshots: snapshots!.results as unknown as SnapshotEvents[],
    truncated,
  };
}
