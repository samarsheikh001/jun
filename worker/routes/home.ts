import { Hono } from "hono";
import { readAskTurns, AssistantInputError, type AskEvent } from "../../shared/desk-assistant.ts";
import { briefWindows, freshBrief, needsPoints, type LiveNeeds } from "../../shared/home-brief.ts";
import { validTimezone } from "../../shared/hours.ts";
import { runAssistant } from "../ai/desk-assistant.ts";
import { assistantModel, chatNames, loadBriefInput, loadNeedsInput, storeBrief, wordBrief } from "../ai/home-brief.ts";
import { loadAiSettings } from "../ai/providers.ts";
import { recordUsage } from "../ai/topics.ts";
import { requireUser } from "../auth/session.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// I-19 (D-127): Home. GET …/home/brief answers at once with today's cached brief, or the plain one
// written in code while the AI words it (`writing`: the page then POSTs …/home/brief); POST also
// refreshes; GET …/home/needs (D-131) counts "What needs you" now. POST …/home/ask streams one
// answer of the desk assistant as NDJSON (AskEvent).
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
      .then((usage) => {
        emit({ type: "done" });
        return recordUsage(c.env, workspaceId, usage);
      })
      .catch((error: unknown) => {
        console.warn("[home] ask failed:", (error as Error).message?.slice(0, 300));
        emit({ type: "error", message: `The assistant couldn't answer just now (${(error as Error).message?.slice(0, 160) || "unknown error"}). Try again in a moment.` });
      })
      .finally(() => writer.close().catch(() => {})),
  );
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
});
