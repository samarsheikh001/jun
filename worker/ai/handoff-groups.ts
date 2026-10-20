import {
  groupInput,
  groupPrompt,
  HANDOFF_GROUP_BATCH,
  HANDOFF_GROUP_BATCHES,
  parseGroupOutput,
  pendingReasons,
  resolveGroups,
} from "../../shared/handoff-groups.ts";
import { AI_OFF_HANDOFF_REASON } from "../../shared/metrics.ts";
import { TOPIC_LOOKBACK_MS } from "../../shared/topics.ts";
import { completeText, type AgentModel } from "./providers.ts";
import { recordUsage, topicModel, type TopicSkip } from "./topics.ts";

// D-137: names a short group for each new wording of a handoff reason (shared/handoff-groups.ts),
// stored per workspace in handoff_groups by the reason's loose key, so every chat with that wording
// counts under it. Runs with topic labelling (cron, Reports, "Label now") on the same job ("topics"),
// under the same rules: tokens to ai_usage, never while the AI is off or the cap is reached.

const GROUP_TIMEOUT_MS = 60_000;

export interface HandoffGroupRun {
  /** Wordings that got a group in this pass, and the groups it created. */
  grouped: number;
  created: string[];
  /** Looked at but left as written (no usable group). */
  ungrouped: number;
  skipped?: TopicSkip;
}

const REASONS = `
  SELECT json_extract(m.meta, '$.handoffReason') AS reason, COUNT(*) AS n
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE c.workspace_id = ?1 AND c.created_at >= ?2 AND m.author_type = 'system' AND m.internal = 0
    AND json_extract(m.meta, '$.handoffReason') IS NOT NULL AND json_extract(m.meta, '$.handoffReason') <> ?3
  GROUP BY reason ORDER BY n DESC LIMIT 2000`;

/** One pass: up to HANDOFF_GROUP_BATCHES model calls of HANDOFF_GROUP_BATCH new wordings. */
export async function groupHandoffReasons(env: Env, workspaceId: string, options: { now?: number; model?: AgentModel } = {}): Promise<HandoffGroupRun> {
  const run: HandoffGroupRun = { grouped: 0, created: [], ungrouped: 0 };
  const db = env.DB;
  const now = options.now ?? Date.now();
  const [reasons, stored] = await db.batch([
    db.prepare(REASONS).bind(workspaceId, now - TOPIC_LOOKBACK_MS, AI_OFF_HANDOFF_REASON),
    db.prepare("SELECT reason_key AS k, grp FROM handoff_groups WHERE workspace_id = ?").bind(workspaceId),
  ]);
  const rows = stored!.results as { k: string; grp: string | null }[];
  const pending = pendingReasons(reasons!.results as { reason: string | null; n: number }[], new Set(rows.map((r) => r.k)));
  if (pending.length === 0) return run;
  const model = options.model ?? (await topicModel(env, workspaceId));
  if (typeof model === "string") return { ...run, skipped: model };
  const existing = [...new Set(rows.flatMap((r) => (r.grp ? [r.grp] : [])))].sort();

  for (let b = 0; b < HANDOFF_GROUP_BATCHES; b++) {
    const items = pending.slice(b * HANDOFF_GROUP_BATCH, (b + 1) * HANDOFF_GROUP_BATCH);
    if (items.length === 0) break;
    const result = await completeText({
      model: model.model,
      ...model.prompt(groupPrompt(existing)),
      messages: [{ role: "user", content: groupInput(items) }],
      maxOutputTokens: 800 + 25 * items.length,
      temperature: 0,
      abortSignal: AbortSignal.timeout(GROUP_TIMEOUT_MS),
    });
    await recordUsage(env, workspaceId, result.totalUsage);
    const parsed = parseGroupOutput(result.text);
    // Unparseable: nothing stored, the next pass tries these again.
    if (!parsed) {
      console.warn("handoff groups: unparseable model output:", result.text.slice(0, 200));
      break;
    }
    const ids = items.map((_, i) => String(i + 1));
    const { groups, created } = resolveGroups(parsed, ids, existing);
    existing.push(...created);
    run.created.push(...created);
    const stamp = Date.now();
    await db.batch(
      items.map((item, i) =>
        db
          .prepare("INSERT INTO handoff_groups (workspace_id, reason_key, grp, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, reason_key) DO UPDATE SET grp = excluded.grp")
          .bind(workspaceId, item.key, groups.get(ids[i]!) ?? null, stamp),
      ),
    );
    run.grouped += groups.size;
    run.ungrouped += items.length - groups.size;
  }
  return run;
}
