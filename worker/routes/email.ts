import { Hono } from "hono";
import { applyEmailPatch, emailOn, emailProblems, isEmail, replyAddress, type EmailSettings } from "../../shared/email.ts";
import { requireUser } from "../auth/session.ts";
import { cloudflareTokenUrl, workerNameFromHost, type SetupResult } from "../../shared/email-setup.ts";
import { cloudflareApi, CloudflareError, findWorkerName, listZones, runEmailSetup } from "../lib/cloudflare.ts";
import { canSendEmail, EmailSendError, loadEmailSettings, sendEmail } from "../lib/email.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// C-02: Channels → Email. Settings live in the widget inbox's settings (`email`); members read them,
// owners and admins change them and send a test.

async function roleIn(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function emailStatus(c: AppContext, workspaceId: string) {
  const loaded = await loadEmailSettings(c.env.DB, workspaceId);
  if (!loaded) throw new HttpError(404, "not_found", "No widget inbox.");
  const canSend = canSendEmail(c.env);
  const { settings } = loaded;
  return {
    settings,
    canSend,
    on: emailOn(settings, canSend),
    problems: emailProblems(settings, canSend),
    // What a conversation's reply address looks like (the real ones carry a random token).
    replyExample: settings.replyDomain ? replyAddress("…", settings.replyDomain) : null,
  };
}

/** Saves the email settings, and the desk's own address for links to files in the emails (the Conversation DO doesn't know it). */
async function saveEmailSettings(c: AppContext, inboxId: string, next: EmailSettings) {
  const deskUrl = new URL(c.req.url).origin;
  await c.env.DB.prepare("UPDATE inboxes SET settings = json_set(json_set(settings, '$.email', json(?)), '$.emailDeskUrl', ?) WHERE id = ?")
    .bind(JSON.stringify(next), deskUrl, inboxId)
    .run();
}

async function requireAdmin(c: AppContext, workspaceId: string) {
  if ((await roleIn(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can do this.");
}

/**
 * D-111: the Cloudflare connection for the one-button setup: whether a token is saved (its last 4
 * only), the domains it sees and this desk's Worker. A token that stopped working says why.
 */
async function cloudflareStatus(c: AppContext, workspaceId: string) {
  const token = await c.env.WORKSPACE_HUB.getByName(workspaceId).cloudflareToken();
  const host = new URL(c.req.url).hostname;
  const base = { tokenUrl: cloudflareTokenUrl("Jun desk email"), workerName: workerNameFromHost(host) };
  if (!token) return { ...base, connected: false, last4: null, domains: [] as string[], error: null };
  try {
    const call = cloudflareApi(token);
    const zones = await listZones(call);
    const workerName = await findWorkerName(call, host, zones.map((z) => z.accountId));
    return { ...base, connected: true, last4: token.slice(-4), domains: zones.map((z) => z.name).sort(), workerName, error: null };
  } catch (error) {
    const refused = error instanceof CloudflareError && (error.status === 401 || error.status === 403);
    const message = refused ? "Cloudflare refused the token (revoked, expired, or no Zone: Read)." : error instanceof CloudflareError ? error.message : "Couldn't reach Cloudflare.";
    return { ...base, connected: true, last4: token.slice(-4), domains: [] as string[], error: message };
  }
}

export const email = new Hono<AppEnv>();
email.use("/workspaces/:id/email", requireUser);
email.use("/workspaces/:id/email/*", requireUser);

email.get("/workspaces/:id/email", async (c) => {
  const workspaceId = c.req.param("id");
  await roleIn(c, workspaceId);
  return c.json(await emailStatus(c, workspaceId));
});

email.put("/workspaces/:id/email", async (c) => {
  const workspaceId = c.req.param("id");
  if ((await roleIn(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
  const body = await readJson(c.req);
  const loaded = await loadEmailSettings(c.env.DB, workspaceId);
  if (!loaded) throw new HttpError(404, "not_found", "No widget inbox.");
  let next;
  try {
    next = applyEmailPatch(loaded.settings, body);
  } catch (error) {
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  await saveEmailSettings(c, loaded.inboxId, next);
  return c.json(await emailStatus(c, workspaceId));
});

// A test email to the admin (or an address they name), from the saved settings: proves the from
// address's domain is onboarded before customers depend on it.
email.post("/workspaces/:id/email/test", async (c) => {
  const workspaceId = c.req.param("id");
  if ((await roleIn(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can do this.");
  const body = await readJson(c.req);
  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim().toLowerCase() : c.get("user").email;
  if (!to || !isEmail(to)) throw new HttpError(400, "invalid_field", "Say which address to send the test to.");
  const loaded = await loadEmailSettings(c.env.DB, workspaceId);
  if (!loaded?.settings.from) throw new HttpError(400, "not_configured", "Save a from address first.");
  const workspace = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
  const name = workspace?.name ?? "Jun";
  const reply = loaded.settings.replyDomain ? replyAddress("test", loaded.settings.replyDomain) : null;
  const text = [
    `This is a test from ${name}'s support desk.`,
    "",
    "Replies to customers will come from this address. When a customer answers one, their email goes to an address like",
    reply ?? "(no reply domain yet)",
    "and lands in the conversation.",
  ].join("\n");
  try {
    await sendEmail(c.env, loaded.settings, name, { to, subject: `Test email from ${name}`, text, html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` });
  } catch (error) {
    if (error instanceof EmailSendError) throw new HttpError(400, "send_failed", `It didn't send: ${error.message}.`);
    throw error;
  }
  return c.json({ ok: true, to });
});

// D-111: set email up from the desk. The admin pastes a Cloudflare API token (made from the link the
// page gives, with the permissions ticked); it's checked by listing the domains it can see, then
// kept in the workspace hub (never D1, never returned).
email.get("/workspaces/:id/email/cloudflare", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  return c.json(await cloudflareStatus(c, workspaceId));
});

email.put("/workspaces/:id/email/cloudflare", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new HttpError(400, "invalid_field", "That doesn't look like a Cloudflare API token. Copy the whole token Cloudflare shows once you create it.");
  let zones;
  try {
    zones = await listZones(cloudflareApi(token));
  } catch (error) {
    const refused = error instanceof CloudflareError && (error.status === 401 || error.status === 403);
    throw new HttpError(400, "token_refused", refused ? "Cloudflare refused that token. Check you copied all of it, and that it has Zone: Read." : `Couldn't check the token: ${(error as Error).message}.`);
  }
  if (zones.length === 0) throw new HttpError(400, "no_domains", "That token can't see any domains. Make it for all zones (or the domain you'll use), or add a domain to Cloudflare first.");
  await c.env.WORKSPACE_HUB.getByName(workspaceId).setCloudflareToken(token);
  return c.json(await cloudflareStatus(c, workspaceId));
});

email.delete("/workspaces/:id/email/cloudflare", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  await c.env.WORKSPACE_HUB.getByName(workspaceId).setCloudflareToken(null);
  return c.json(await cloudflareStatus(c, workspaceId));
});

/**
 * One button: Email Sending for the from address's domain, Email Routing (with subaddressing) for
 * the reply domain, the rule sending reply@ to this Worker. The addresses are saved either way;
 * email replies turn on only when every step worked.
 */
email.post("/workspaces/:id/email/cloudflare/setup", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const token = await c.env.WORKSPACE_HUB.getByName(workspaceId).cloudflareToken();
  if (!token) throw new HttpError(400, "not_connected", "Connect Cloudflare first.");
  const loaded = await loadEmailSettings(c.env.DB, workspaceId);
  if (!loaded) throw new HttpError(404, "not_found", "No widget inbox.");
  let next: EmailSettings;
  try {
    next = applyEmailPatch(loaded.settings, { from: body.from, fromName: body.fromName, replyDomain: body.replyDomain });
  } catch (error) {
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  if (!next.from) throw new HttpError(400, "invalid_field", "Say which address replies come from.");
  if (!next.replyDomain) throw new HttpError(400, "invalid_field", "Say which domain customers' answers go to.");
  const typed = typeof body.workerName === "string" ? body.workerName.trim().toLowerCase() : "";
  const typedWorker = /^[a-z0-9-]{1,63}$/.test(typed) ? typed : null;

  const call = cloudflareApi(token);
  let zones;
  try {
    zones = await listZones(call);
  } catch (error) {
    throw new HttpError(400, "token_refused", `Cloudflare refused the saved token (${(error as Error).message}). Connect it again.`);
  }
  const host = new URL(c.req.url).hostname;
  const workerName = typedWorker ?? (await findWorkerName(call, host, zones.map((z) => z.accountId)));
  const steps = await runEmailSetup(call, { zones, fromDomain: next.from.slice(next.from.indexOf("@") + 1), replyDomain: next.replyDomain, workerName });
  if (steps.every((s) => s.ok)) {
    if (canSendEmail(c.env)) {
      next = { ...next, enabled: true };
      steps.push({ id: "save", label: "Turn on email replies", ok: true, detail: "On. Send yourself a test to check the whole way." });
    } else {
      steps.push({ id: "save", label: "Turn on email replies", ok: false, detail: "This desk was deployed without the send_email binding. Update Jun and deploy again." });
    }
  }
  await saveEmailSettings(c, loaded.inboxId, next);
  const result: SetupResult = { ok: steps.every((s) => s.ok), steps };
  return c.json({ ...result, status: await emailStatus(c, workspaceId) });
});
