import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { finishRegistration, startRegistration } from "../auth/passkeys.ts";
import { createSession, requireUser } from "../auth/session.ts";
import { newId, randomToken, sha256 } from "../lib/crypto.ts";
import { email, object, readJson, text } from "../lib/validate.ts";
import { withFreeSlug, workspaceSlug } from "../lib/workspace-slug.ts";
import { forgetSiteShot, siteOrigin, siteShot } from "../lib/site-shot.ts";
import { dismissedKey, installMarkedKey } from "./onboarding.ts";
import { workspaceSummary, type WorkspaceSummaryRow } from "../../shared/workspace-summary.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function requireRole(c: AppContext, workspaceId: string, allowed: Role[]): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?")
    .bind(workspaceId, c.get("user").id)
    .first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  if (!allowed.includes(row.role)) throw new HttpError(403, "forbidden", "You don't have permission to do that.");
  return row.role;
}

const RANK: Record<Role, number> = { owner: 3, admin: 2, agent: 1 };

/** You can only invite or manage people ranked below you; nobody manages an owner. */
function canManage(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

function parseRole(body: Record<string, unknown>): "admin" | "agent" {
  const role = text(body, "role", { max: 10 });
  if (role !== "admin" && role !== "agent") throw new HttpError(400, "invalid_field", "Role must be admin or agent.");
  return role;
}

async function findMember(c: AppContext, workspaceId: string, userId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?")
    .bind(workspaceId, userId)
    .first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "That person isn't a member of this workspace.");
  return row.role;
}

async function findInvite(c: AppContext, token: string) {
  const invite = await c.env.DB.prepare(
    `SELECT i.token_hash AS tokenHash, i.workspace_id AS workspaceId, i.role, w.name AS workspaceName
     FROM invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<{ tokenHash: string; workspaceId: string; role: Role; workspaceName: string }>();
  if (!invite) throw new HttpError(410, "invite_invalid", "This invite link is invalid, used, or expired.");
  return invite;
}

export const workspaces = new Hono<AppEnv>();

// D-95: one desk, several workspaces (one per website or product), each with its own widget,
// inbox, AI agent, knowledge and team. Owners create them; the desk's sidebar switches between them.
workspaces.post("/workspaces", requireUser, async (c) => {
  const userId = c.get("user").id;
  const owner = await c.env.DB.prepare("SELECT 1 FROM members WHERE user_id = ? AND role = 'owner' LIMIT 1").bind(userId).first();
  if (!owner) throw new HttpError(403, "forbidden", "Only an owner can create workspaces.");
  const name = text(await readJson(c.req), "name", { max: 100 });
  const workspaceId = newId("ws");
  const now = Date.now();
  // D-96: its desk URLs are /w/<slug>/…
  const workspaceSlug = await withFreeSlug(c.env.DB, name, async (slug) => {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)").bind(workspaceId, name, slug, now),
      c.env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(workspaceId, userId, now),
      // Its own website widget, with its own key (as in first-run setup).
      c.env.DB.prepare("INSERT INTO inboxes (id, workspace_id, name, widget_key, created_at) VALUES (?, ?, 'Website', ?, ?)").bind(
        newId("inb"),
        workspaceId,
        `wk_${randomToken(12)}`,
        now,
      ),
    ]);
    return slug;
  });
  return c.json({ workspaceId, workspaceName: name, workspaceSlug, role: "owner" });
});

// D-97: the desk's home, one card per workspace you're in: its widget's look and install, open
// chats, the ones waiting for a person, AI on or off. One query, whatever the number of workspaces.
workspaces.get("/workspaces", requireUser, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT w.id AS workspaceId, w.name AS workspaceName, w.slug AS workspaceSlug, m.role,
       i.widget_key AS widgetKey, i.settings,
       (SELECT value FROM settings s WHERE s.key = 'onboarding_install_marked:' || w.id) AS installMarked,
       (SELECT enabled FROM ai_settings a WHERE a.workspace_id = w.id) AS aiEnabled,
       (SELECT COUNT(*) FROM conversations cv WHERE cv.workspace_id = w.id AND cv.status = 'open') AS open,
       (SELECT COUNT(*) FROM conversations cv WHERE cv.workspace_id = w.id AND cv.status = 'open' AND cv.handling = 'human') AS waiting
     FROM members m JOIN workspaces w ON w.id = m.workspace_id
     LEFT JOIN inboxes i ON i.id = (SELECT id FROM inboxes WHERE workspace_id = w.id ORDER BY created_at LIMIT 1)
     WHERE m.user_id = ? ORDER BY m.created_at`,
  )
    .bind(c.get("user").id)
    .all<WorkspaceSummaryRow>();
  return c.json({ workspaces: rows.results.map(workspaceSummary) });
});

workspaces.patch("/workspaces/:id", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin"]);
  const name = text(await readJson(c.req), "name", { max: 100 });
  await c.env.DB.prepare("UPDATE workspaces SET name = ? WHERE id = ?").bind(name, workspaceId).run();
  return c.json({ name });
});

workspaces.delete("/workspaces/:id", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  const userId = c.get("user").id;
  await requireRole(c, workspaceId, ["owner"]);
  const body = await readJson(c.req);
  const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
  if (!ws || text(body, "name", { max: 100 }) !== ws.name) throw new HttpError(400, "name_mismatch", "Type the workspace's name exactly to delete it.");
  const other = await c.env.DB.prepare("SELECT 1 FROM members WHERE user_id = ? AND workspace_id != ? LIMIT 1").bind(userId, workspaceId).first();
  if (!other) throw new HttpError(409, "last_workspace", "This is your only workspace. Create another one before deleting this one.");

  // What lives outside D1's cascades: files in R2 and each Durable Object's own storage.
  const db = c.env.DB;
  const [files, inboxes, conversations] = await Promise.all([
    db.prepare("SELECT key FROM files WHERE workspace_id = ?").bind(workspaceId).all<{ key: string }>(),
    db.prepare("SELECT settings FROM inboxes WHERE workspace_id = ?").bind(workspaceId).all<{ settings: string | null }>(),
    db.prepare("SELECT id FROM conversations WHERE workspace_id = ?").bind(workspaceId).all<{ id: string }>(),
  ]);
  const keys = files.results.map((f) => f.key);
  for (const inbox of inboxes.results) {
    try {
      const s = JSON.parse(inbox.settings ?? "{}") as Record<string, unknown>;
      for (const k of [s.logoKey, s.logoDarkKey]) if (typeof k === "string") keys.push(k);
    } catch {
      // Unreadable settings: no logos to remove.
    }
  }

  await db.batch([
    // People who were only in this workspace lose their account (cascades to passkeys and sessions),
    // as when they're removed from their last workspace.
    db.prepare(
      `DELETE FROM users WHERE id IN (SELECT user_id FROM members WHERE workspace_id = ?)
       AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id = users.id AND m.workspace_id != ?)`,
    ).bind(workspaceId, workspaceId),
    // No foreign key on these two.
    db.prepare("DELETE FROM kb_chunks WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM debug_snapshots WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM settings WHERE key IN (?, ?)").bind(dismissedKey(workspaceId), installMarkedKey(workspaceId)),
    // Everything else cascades from the workspace row.
    db.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspaceId),
  ]);

  c.executionCtx.waitUntil(
    (async () => {
      const env = c.env;
      let cursor: string | undefined;
      do {
        const listed = await env.FILES.list({ prefix: `kb/${workspaceId}/`, cursor });
        keys.push(...listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
      await env.WORKSPACE_HUB.getByName(workspaceId).wipe();
      await env.KNOWLEDGE_INDEX.getByName(workspaceId).wipe();
      for (const { id } of conversations.results) await env.CONVERSATION.getByName(id).wipe().catch(() => {});
    })().catch((e: unknown) => console.error("workspace delete cleanup", workspaceId, e)),
  );
  return c.json({ ok: true });
});

// D-142: take the picture again now (owners and admins): drops the kept one, so the next GET shoots afresh.
workspaces.post("/workspaces/:id/site-shot/refresh", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin"]);
  await forgetSiteShot(c.env, workspaceId);
  return c.json({ ok: true });
});

// D-141: a picture of the website the widget runs on, for the desk home's card (404 when there's none).
workspaces.get("/workspaces/:id/site-shot", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin", "agent"]);
  const inbox = await c.env.DB.prepare("SELECT COALESCE(json_extract(settings, '$.seenOn'), json_extract(settings, '$.installedOn')) AS installedOn FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .bind(workspaceId)
    .first<{ installedOn: string | null }>();
  const origin = siteOrigin(inbox?.installedOn ?? null, new URL(c.req.url).origin);
  const shot = origin ? await siteShot(c.env, workspaceId, origin) : null;
  if (!shot) throw new HttpError(404, "not_found", "No picture of this workspace's website.");
  return new Response(shot.body, { headers: { "content-type": shot.type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
});

workspaces.get("/workspaces/:id/members", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin", "agent"]);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, m.role, m.created_at AS joinedAt FROM members m
     JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`,
  )
    .bind(workspaceId)
    .all();
  return c.json({ members: rows.results });
});

workspaces.patch("/workspaces/:id/members/:userId", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  const actor = await requireRole(c, workspaceId, ["owner", "admin"]);
  const role = parseRole(await readJson(c.req));
  const current = await findMember(c, workspaceId, c.req.param("userId"));
  if (!canManage(actor, current) || !canManage(actor, role)) {
    throw new HttpError(403, "forbidden", "You can only manage people with a lower role than yours.");
  }
  await c.env.DB.prepare("UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?")
    .bind(role, workspaceId, c.req.param("userId"))
    .run();
  return c.json({ ok: true });
});

workspaces.delete("/workspaces/:id/members/:userId", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  const userId = c.req.param("userId");
  const actor = await requireRole(c, workspaceId, ["owner", "admin"]);
  if (!canManage(actor, await findMember(c, workspaceId, userId))) {
    throw new HttpError(403, "forbidden", "You can only remove people with a lower role than yours.");
  }
  // Remove the membership; if that was their last workspace, delete the account too
  // (cascades to passkeys and sessions, so they're signed out everywhere).
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId),
    // I-14: their devices stop getting this workspace's notifications.
    c.env.DB.prepare("DELETE FROM push_subscriptions WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId),
    c.env.DB.prepare("DELETE FROM users WHERE id = ? AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = ?)").bind(userId, userId),
  ]);
  return c.json({ ok: true });
});

workspaces.get("/workspaces/:id/invites", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin"]);
  const rows = await c.env.DB.prepare(
    `SELECT i.token_hash AS id, i.role, i.created_at AS createdAt, i.expires_at AS expiresAt, u.name AS createdBy
     FROM invites i JOIN users u ON u.id = i.created_by
     WHERE i.workspace_id = ? AND i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
  )
    .bind(workspaceId, Date.now())
    .all();
  return c.json({ invites: rows.results });
});

workspaces.delete("/workspaces/:id/invites/:inviteId", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin"]);
  await c.env.DB.prepare("DELETE FROM invites WHERE token_hash = ? AND workspace_id = ? AND used_at IS NULL")
    .bind(c.req.param("inviteId"), workspaceId)
    .run();
  return c.json({ ok: true });
});

workspaces.post("/workspaces/:id/invites", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  const actor = await requireRole(c, workspaceId, ["owner", "admin"]);
  const role = parseRole(await readJson(c.req));
  if (!canManage(actor, role)) throw new HttpError(403, "forbidden", "Admins can only invite agents.");

  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO invites (token_hash, workspace_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256(token), workspaceId, role, c.get("user").id, now, now + INVITE_TTL_MS)
    .run();
  return c.json({ url: `${new URL(c.req.url).origin}/invite/${token}`, expiresAt: now + INVITE_TTL_MS });
});

workspaces.get("/invites/:token", async (c) => {
  const invite = await findInvite(c, c.req.param("token"));
  return c.json({ workspaceName: invite.workspaceName, role: invite.role });
});

// D-95: someone with an account on this desk (signed in) joins with it, no new passkey.
workspaces.post("/invites/:token/accept", requireUser, async (c) => {
  const invite = await findInvite(c, c.req.param("token"));
  const userId = c.get("user").id;
  const now = Date.now();
  const used = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now, invite.tokenHash),
    // Already a member: keep the role they have.
    c.env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(
      invite.workspaceId,
      userId,
      invite.role,
      now,
    ),
  ]);
  if (!used[0]?.meta.changes) throw new HttpError(410, "invite_invalid", "This invite link is invalid, used, or expired.");
  return c.json({ workspaceId: invite.workspaceId, workspaceSlug: await workspaceSlug(c.env.DB, invite.workspaceId) });
});

workspaces.post("/invites/:token/options", async (c) => {
  const invite = await findInvite(c, c.req.param("token"));
  const body = await readJson(c.req);
  const user = { id: newId("usr"), name: text(body, "name", { max: 100 }), email: email(body) };
  const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(user.email).first();
  if (taken) throw new HttpError(409, "email_taken", "An account with that email already exists. Sign in with it to join.");
  return c.json(await startRegistration(c, "invite", user, { user, inviteHash: invite.tokenHash, workspaceId: invite.workspaceId, role: invite.role }));
});

workspaces.post("/invites/:token/verify", async (c) => {
  const body = await readJson(c.req);
  type Payload = { userId: string; user: { id: string; name: string; email: string }; inviteHash: string; workspaceId: string; role: Role };
  const invite = await findInvite(c, c.req.param("token"));
  const now = Date.now();
  const { userId } = await finishRegistration<Payload>(c, "invite", object<RegistrationResponseJSON>(body, "response"), (p) => {
    if (p.inviteHash !== invite.tokenHash) throw new HttpError(400, "invite_mismatch", "This passkey was started for a different invite.");
    return [
      c.env.DB.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now, p.inviteHash),
      c.env.DB.prepare("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)").bind(p.user.id, p.user.name, p.user.email, now),
      c.env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(p.workspaceId, p.user.id, p.role, now),
    ];
  });
  await createSession(c, userId);
  return c.json({ ok: true });
});
