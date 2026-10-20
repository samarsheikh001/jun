import { Hono } from "hono";
import { readAskTurns, AssistantInputError, type AskEvent } from "../../shared/desk-assistant.ts";
import { cleanThread, isThreadId, mergeRecent, overCap, readRecent, TOMBSTONE_MS, type ThreadList } from "../../shared/ask-threads.ts";
import { briefWindows, freshBrief, needsPoints, type LiveNeeds } from "../../shared/home-brief.ts";
import { validTimezone } from "../../shared/hours.ts";
import { nextQuestions, runAssistant } from "../ai/desk-assistant.ts";
import { assistantModel, chatNames, loadBriefInput, loadNeedsInput, storeBrief, wordBrief } from "../ai/home-brief.ts";
import { loadAiSettings } from "../ai/providers.ts";
import { recordUsage } from "../ai/topics.ts";
import { requireUser } from "../auth/session.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// I-19 (D-127): Home. GET …/home/brief answers at once with today's cached brief, or the plain one
// written in code while the AI words it (`writing`: the page then POSTs …/home/brief); POST also
// refreshes; GET …/home/needs (D-131) counts "What needs you" now. POST …/home/ask streams one
// answer of the desk assistant as NDJSON (AskEvent); …/home/threads (D-139) keeps the member's assistant threads,
// …/home/recent (D-144) their last questions.
// Members only; the brief and the assistant see what any member of the workspace can see.

export const home = new Hono<AppEnv>();
home.use("/workspaces/:id/home/*", requireUser);

async function member(c: AppContext, workspaceId: string): Promise<{ role: Role; workspaceName: string }> {
  const row = await c.env.DB.prepare("SELECT m.role, w.name FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ?")
    .bind(workspaceId, c.get("user").id)
    .first<{ role: Role; name: string }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return { role: row.role, workspaceName: row.name };
}

function timezoneOf(raw: unknown): string {
  const tz = typeof raw === "string" && raw ? raw : "UTC";
  if (!validTimezone(tz)) throw new HttpError(400, "invalid_field", "Unknown time zone.");
  return tz;
}

/** I-19: questions and refreshes per member (the hub counts, so tabs share it). */
async function takeTurn(c: AppContext, workspaceId: string): Promise<void> {
  const { ok, retryAfterMs } = await c.env.WORKSPACE_HUB.getByName(workspaceId).takeAssistantTurn(c.get("user").id);
  if (!ok) throw new HttpError(429, "rate_limited", `That's a lot of questions: try again in ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} min.`);
}

home.get("/workspaces/:id/home/brief", async (c) => {
  const workspaceId = c.req.param("id");
  await member(c, workspaceId);
  const timezone = timezoneOf(c.req.query("tz"));
  const now = Date.now();
  const user = c.get("user");
  const [stored, available] = await Promise.all([
    c.env.DB.prepare("SELECT brief FROM home_briefs WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, user.id).first<{ brief: string }>(),
    assistantModel(c.env, workspaceId),
  ]);
  const ai = "model" in available ? { available: true as const } : { available: false as const, reason: available.skipped, message: available.message };
  const cached = freshBrief(stored?.brief, briefWindows(now, timezone).day, timezone);
  // A plain brief cached while the AI was off is written again once it's on.
  if (cached && !(cached.source === "plain" && ai.available)) return c.json({ brief: cached, writing: false, ai });
  const input = await loadBriefInput(c.env, workspaceId, user.id, timezone, now, (await loadAiSettings(c.env, workspaceId)).enabled);
  const brief = await wordBrief(c.env, workspaceId, input, { name: user.name, workspaceName: "" }, null);
  if (!ai.available) await storeBrief(c.env, workspaceId, user.id, brief);
  return c.json({ brief, writing: ai.available, ai });
});

// D-131: "What needs you" counted now (the brief is cached once a day), plain words, no AI.
home.get("/workspaces/:id/home/needs", async (c) => {
  const workspaceId = c.req.param("id");
  await member(c, workspaceId);
  const timezone = timezoneOf(c.req.query("tz"));
  const points = needsPoints(await loadNeedsInput(c.env, workspaceId, c.get("user").id, timezone, Date.now())).map((p) => ({ ...p, text: p.plain }));
  return c.json({ points, ...(await chatNames(c.env, workspaceId, points)) } satisfies LiveNeeds);
});

home.post("/workspaces/:id/home/brief", async (c) => {
  const workspaceId = c.req.param("id");
  const { workspaceName } = await member(c, workspaceId);
  const body = await readJson(c.req);
  const timezone = timezoneOf(body.tz);
  await takeTurn(c, workspaceId);
  const now = Date.now();
  const user = c.get("user");
  const [available, settings] = await Promise.all([assistantModel(c.env, workspaceId), loadAiSettings(c.env, workspaceId)]);
  const input = await loadBriefInput(c.env, workspaceId, user.id, timezone, now, settings.enabled);
  const brief = await wordBrief(c.env, workspaceId, input, { name: user.name, workspaceName }, "model" in available ? available.model : null);
  await storeBrief(c.env, workspaceId, user.id, brief);
  return c.json({ brief });
});

home.post("/workspaces/:id/home/ask", async (c) => {
  const workspaceId = c.req.param("id");
  const { role, workspaceName } = await member(c, workspaceId);
  const body = await readJson(c.req);
  const timezone = timezoneOf(body.tz);
  let turns;
  try {
    turns = readAskTurns(body.turns);
  } catch (e) {
    if (e instanceof AssistantInputError) throw new HttpError(400, "invalid_field", e.message);
    throw e;
  }
  const available = await assistantModel(c.env, workspaceId);
  if (!("model" in available)) throw new HttpError(400, available.skipped, available.message);
  await takeTurn(c, workspaceId);
  const user = c.get("user");
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const emit = (event: AskEvent) => void writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
  const ctx = { env: c.env, workspaceId, workspaceName, user: { id: user.id, name: user.name }, role, timezone, now: Date.now() };
  c.executionCtx.waitUntil(
    runAssistant(ctx, available.model, turns, emit)
      .then(async (result) => {
        emit({ type: "done" });
        await recordUsage(c.env, workspaceId, result);
        // D-134: chips under the answer, after it's done (the page shows the answer meanwhile).
        const question = turns.findLast((t) => t.role === "user")?.text ?? "";
        if (result.proposed || !result.text.trim()) return;
        try {
          const next = await nextQuestions(available.model, question, result.text, result.steps);
          if (next.questions.length) emit({ type: "followups", questions: next.questions });
          await recordUsage(c.env, workspaceId, next.usage);
        } catch (error) {
          console.warn("[home] follow-ups failed:", (error as Error).message?.slice(0, 200));
        }
      })
      .catch((error: unknown) => {
        console.warn("[home] ask failed:", (error as Error).message?.slice(0, 300));
        emit({ type: "error", message: `The assistant couldn't answer just now (${(error as Error).message?.slice(0, 160) || "unknown error"}). Try again in a moment.` });
      })
      .finally(() => writer.close().catch(() => {})),
  );
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
});

// D-139: the member's assistant threads (D-134), so they follow them across browsers; the page keeps a
// localStorage copy as a cache and syncs by updatedAt (shared/ask-threads.ts). Own threads only.
const threadId = (c: AppContext): string => {
  const id = c.req.param("tid");
  if (!isThreadId(id)) throw new HttpError(400, "invalid_field", "Unknown thread id.");
  return id;
};

home.get("/workspaces/:id/home/threads", async (c) => {
  const workspaceId = c.req.param("id");
  await member(c, workspaceId);
  const userId = c.get("user").id;
  await c.env.DB.prepare("DELETE FROM assistant_threads WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?").bind(workspaceId, userId, Date.now() - TOMBSTONE_MS).run();
  const rows = (await c.env.DB.prepare("SELECT id, title, updated_at, deleted_at FROM assistant_threads WHERE workspace_id = ? AND user_id = ? ORDER BY updated_at DESC").bind(workspaceId, userId).all<{ id: string; title: string; updated_at: number; deleted_at: number | null }>()).results;
  return c.json({
    threads: rows.filter((r) => r.deleted_at === null).map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at })),
    deleted: rows.filter((r) => r.deleted_at !== null).map((r) => ({ id: r.id, deletedAt: r.deleted_at! })),
  } satisfies ThreadList);
});

home.get("/workspaces/:id/home/threads/:tid", async (c) => {
  const workspaceId = c.req.param("id");
  await member(c, workspaceId);
  const id = threadId(c);
  const row = await c.env.DB.prepare("SELECT title, turns, updated_at FROM assistant_threads WHERE workspace_id = ? AND user_id = ? AND id = ? AND deleted_at IS NULL").bind(workspaceId, c.get("user").id, id).first<{ title: string; turns: string; updated_at: number }>();
  if (!row) throw new HttpError(404, "not_found", "No such thread.");
  return c.json({ id, title: row.title, updatedAt: row.updated_at, turns: JSON.parse(row.turns) as unknown[] });
});

home.put("/workspaces/:id/home/threads/:tid", async (c) => {
  const workspaceId = c.req.param("id");
  await member(c, workspaceId);
  const id = threadId(c);
  const userId = c.get("user").id;
  const thread = cleanThread(await readJson(c.req));
  if (!thread.ok) throw new HttpError(400, thread.code, thread.message);
  // The newer copy wins; a thread deleted after this copy last changed stays deleted.
  const result = await c.env.DB.prepare(
    `INSERT INTO assistant_threads (workspace_id, user_id, id, title, turns, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (workspace_id, user_id, id) DO UPDATE SET title = excluded.title, turns = excluded.turns, updated_at = excluded.updated_at, deleted_at = NULL
     WHERE (assistant_threads.deleted_at IS NULL AND excluded.updated_at > assistant_threads.updated_at) OR (assistant_threads.deleted_at IS NOT NULL AND excluded.updated_at > assistant_threads.deleted_at)`,
  ).bind(workspaceId, userId, id, thread.title, thread.turns, thread.updatedAt).run();
  const kept = (result.meta.changes ?? 0) > 0;
  if (kept) {
    // At most MAX_SERVER_THREADS live threads: the oldest become tombstones.
    const live = (await c.env.DB.prepare("SELECT id, title, updated_at FROM assistant_threads WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL").bind(workspaceId, userId).all<{ id: string; title: string; updated_at: number }>()).results;
    const drop = overCap(live.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at })));
    if (drop.length) {
      const now = Date.now();
      await c.env.DB.batch(drop.map((d) => c.env.DB.prepare("UPDATE assistant_threads SET turns = '[]', deleted_at = ? WHERE workspace_id = ? AND user_id = ? AND id = ?").bind(now, workspaceId, userId, d)));
    }
  }
  const row = await c.env.DB.prepare("SELECT updated_at, deleted_at FROM assistant_threads WHERE workspace_id = ? AND user_id = ? AND id = ?").bind(workspaceId, userId, id).first<{ updated_at: number; deleted_at: number | null }>();
  return c.json({ id, kept, updatedAt: row?.updated_at ?? thread.updatedAt, deleted: row?.deleted_at != null });
});

home.delete("/workspaces/:id/home/threads/:tid", async (c) => {
  const workspaceId = c.req.param("id");
  await member(c, workspaceId);
  const id = threadId(c);
  const now = Date.now();
  // A tombstone, so another browser's cached copy isn't uploaded again.
  await c.env.DB.prepare(
    `INSERT INTO assistant_threads (workspace_id, user_id, id, title, turns, updated_at, deleted_at) VALUES (?, ?, ?, '', '[]', ?, ?)
     ON CONFLICT (workspace_id, user_id, id) DO UPDATE SET title = '', turns = '[]', deleted_at = excluded.deleted_at`,
  ).bind(workspaceId, c.get("user").id, id, now, now).run();
  return c.json({ ok: true });
});

// D-144: the member's recent questions. PUT sends this browser's list; the answer is it merged with the
// one kept here (newest first, each question once, ≤ 5), which is stored and becomes both sides' list.
home.put("/workspaces/:id/home/recent", async (c) => {
  const workspaceId = c.req.param("id");
  await member(c, workspaceId);
  const userId = c.get("user").id;
  const body = await readJson(c.req);
  if (!Array.isArray(body.recent)) throw new HttpError(400, "invalid_body", "recent must be a list of { q, at }.");
  const now = Date.now();
  const row = await c.env.DB.prepare("SELECT questions FROM assistant_recent WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId).first<{ questions: string }>();
  let kept: unknown = [];
  try {
    kept = row ? JSON.parse(row.questions) : [];
  } catch {
    // A broken row is replaced.
  }
  const recent = mergeRecent(readRecent(kept, now), readRecent(body.recent, now));
  const json = JSON.stringify(recent);
  if (json !== row?.questions)
    await c.env.DB.prepare("INSERT INTO assistant_recent (workspace_id, user_id, questions, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, user_id) DO UPDATE SET questions = excluded.questions, updated_at = excluded.updated_at")
      .bind(workspaceId, userId, json, now)
      .run();
  return c.json({ recent });
});
