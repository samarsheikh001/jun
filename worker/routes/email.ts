import { Hono } from "hono";
import { applyEmailPatch, emailOn, emailProblems, isEmail, replyAddress } from "../../shared/email.ts";
import { requireUser } from "../auth/session.ts";
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
  // The desk's own address, for links to files in the emails (the Conversation DO doesn't know it).
  const deskUrl = new URL(c.req.url).origin;
  await c.env.DB.prepare("UPDATE inboxes SET settings = json_set(json_set(settings, '$.email', json(?)), '$.emailDeskUrl', ?) WHERE id = ?")
    .bind(JSON.stringify(next), deskUrl, loaded.inboxId)
    .run();
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
