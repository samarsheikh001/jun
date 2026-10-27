import { Hono } from "hono";
import { requireUser } from "../auth/session.ts";
import { setTelemetry, telemetryState } from "../lib/telemetry.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";

// The desk itself, shared by every workspace on it (D-97's "This desk"): owners only.

export const desk = new Hono<AppEnv>();

async function requireDeskOwner(c: AppContext): Promise<void> {
  const owner = await c.env.DB.prepare("SELECT 1 FROM members WHERE user_id = ? AND role = 'owner' LIMIT 1").bind(c.get("user").id).first();
  if (!owner) throw new HttpError(403, "forbidden", "Only an owner can change this.");
}

// T-20 (D-151): the anonymous daily ping, with exactly what it sends.
desk.get("/desk/telemetry", requireUser, async (c) => {
  await requireDeskOwner(c);
  return c.json(await telemetryState(c.env));
});

desk.put("/desk/telemetry", requireUser, async (c) => {
  await requireDeskOwner(c);
  const body = await readJson(c.req);
  if (typeof body.on !== "boolean") throw new HttpError(400, "invalid", "on must be true or false.");
  await setTelemetry(c.env.DB, body.on);
  return c.json(await telemetryState(c.env));
});
