import { Hono } from "hono";
import { validTimezone } from "../../shared/hours.ts";
import { computeMetrics, parsePeriod, periodDays, previousPeriod, type MetricsReport } from "../../shared/metrics.ts";
import { loadAiSettings } from "../ai/providers.ts";
import { kickTopicLabelling } from "../ai/topics.ts";
import { requireUser } from "../auth/session.ts";
import { loadMetricRows } from "../lib/metrics-data.ts";
import { HttpError, type AppEnv } from "../types.ts";

// A-01: core metrics for the last 7, 30 or 90 days. SQL aggregates one row per conversation
// (and per teammate, worker/lib/metrics-data.ts); shared/metrics.ts does the counting, medians and day buckets.

export const metrics = new Hono<AppEnv>();
metrics.use("/workspaces/:id/metrics", requireUser);

/** The Reports report for a period (also Home's assistant's report_metrics tool, I-19). */
export async function loadReport(env: Env, workspaceId: string, days: number, timezone: string, now = Date.now()): Promise<MetricsReport> {
  const { since, until } = periodDays(now, days, timezone);
  const [rows, ai] = await Promise.all([loadMetricRows(env.DB, workspaceId, { since, until, previous: previousPeriod(now, days, timezone) }), loadAiSettings(env, workspaceId)]);
  return computeMetrics({ now, days, timezone, aiEnabled: ai.enabled, ...rows });
}

metrics.get("/workspaces/:id/metrics", async (c) => {
  const workspaceId = c.req.param("id");
  const member = await c.env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first();
  if (!member) throw new HttpError(404, "not_found", "Workspace not found.");

  const days = parsePeriod(c.req.query("days") ?? "7");
  if (!days) throw new HttpError(400, "invalid_field", "days must be 7, 30 or 90.");
  const timezone = c.req.query("tz") || "UTC";
  if (!validTimezone(timezone)) throw new HttpError(400, "invalid_field", "Unknown time zone.");

  // A-02: opening Reports labels chats that went quiet since the last pass, in the background
  // (at most every 5 minutes per workspace; skipped while the AI is off or capped).
  c.executionCtx.waitUntil(kickTopicLabelling(c.env, workspaceId));

  return c.json({ report: await loadReport(c.env, workspaceId, days, timezone) });
});
