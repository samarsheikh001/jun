import { Hono } from "hono";
import { readSlackKeys, slackEventsUrl, slackManifest, slackManifestUrl, SLACK_MODES, type SlackChannel, type SlackMode, type SlackView } from "../../shared/slack.ts";
import { requireUser } from "../auth/session.ts";
import { brokenText, SlackError, slackApi } from "../lib/slack-api.ts";
import { loadConnection } from "../lib/slack.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// C-09 / T-13 (D-152): Channels → Slack. Admins connect the workspace's own Slack app (made from the
// manifest link), pick the channel and when chats open a thread; members see the state. Slack's own
// calls (events, interactivity) are in lib/slack.ts, mounted outside the cookie routes in index.ts.

async function roleIn(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await roleIn(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can do this.");
}

const isLocal = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

async function view(c: AppContext, workspaceId: string, admin: boolean): Promise<SlackView> {
  const origin = new URL(c.req.url).origin;
  const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
  const row = await loadConnection(c.env, workspaceId);
  const keys = admin && row ? await c.env.WORKSPACE_HUB.getByName(workspaceId).slackKeys() : null;
  return {
    connected: Boolean(row),
    teamName: row?.team_name ?? null,
    teamUrl: row?.team_url ?? null,
    channel: row?.channel_id ? { id: row.channel_id, name: row.channel_name ?? row.channel_id } : null,
    mode: row?.mode ?? "handoff",
    status: row?.status ?? null,
    lastError: row?.last_error ?? null,
    tokenLast4: keys ? keys.token.slice(-4) : null,
    manifestUrl: slackManifestUrl(slackManifest(origin, workspaceId, ws?.name ?? "Jun")),
    eventsUrl: slackEventsUrl(origin, workspaceId),
    local: isLocal(origin),
  };
}

async function apiFor(c: AppContext, workspaceId: string) {
  const keys = await c.env.WORKSPACE_HUB.getByName(workspaceId).slackKeys();
  if (!keys) throw new HttpError(400, "not_connected", "Connect Slack first.");
  return slackApi(c.env, keys.token);
}

const slackFailed = (error: unknown): never => {
  if (error instanceof SlackError) throw new HttpError(400, "slack_error", brokenText(error.code));
  throw error;
};

export const slack = new Hono<AppEnv>();
slack.use("/workspaces/:id/slack", requireUser);
slack.use("/workspaces/:id/slack/*", requireUser);

slack.get("/workspaces/:id/slack", async (c) => {
  const workspaceId = c.req.param("id");
  const role = await roleIn(c, workspaceId);
  return c.json(await view(c, workspaceId, role !== "agent"));
});

/**
 * Connects (or reconnects) the workspace's Slack app: its bot token and signing secret, checked with
 * Slack (auth.test). Another Slack workspace than before means picking the channel again; threads
 * already open stay where they are.
 */
slack.put("/workspaces/:id/slack/keys", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  let keys;
  try {
    keys = readSlackKeys(await readJson(c.req));
  } catch (error) {
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  const who = await slackApi(c.env, keys.token).authTest().catch(slackFailed);
  const before = await loadConnection(c.env, workspaceId);
  const sameTeam = before?.team_id === who.team_id;
  await c.env.WORKSPACE_HUB.getByName(workspaceId).setSlackKeys(keys);
  await c.env.DB.prepare(
    `INSERT INTO slack_connections (workspace_id, team_id, team_name, team_url, bot_user_id, channel_id, channel_name, mode, desk_url, status, last_error, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 'handoff', ?6, 'connected', NULL, ?7)
     ON CONFLICT (workspace_id) DO UPDATE SET team_id = ?2, team_name = ?3, team_url = ?4, bot_user_id = ?5, desk_url = ?6, status = 'connected', last_error = NULL,
       channel_id = CASE WHEN ?8 THEN channel_id ELSE NULL END, channel_name = CASE WHEN ?8 THEN channel_name ELSE NULL END`,
  )
    .bind(workspaceId, who.team_id, who.team, who.url ?? null, who.user_id, new URL(c.req.url).origin, Date.now(), sameTeam ? 1 : 0)
    .run();
  return c.json(await view(c, workspaceId, true));
});

/** The channels the bot can see: public ones, and private ones it was invited to. */
slack.get("/workspaces/:id/slack/channels", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const list = await (await apiFor(c, workspaceId)).channels().catch(slackFailed);
  const channels: SlackChannel[] = list
    .map((ch) => ({ id: ch.id, name: ch.name, private: ch.is_private, member: ch.is_member }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ channels });
});

/** The channel chats go to and when they open a thread. A public channel is joined; a private one needs the bot invited first. */
slack.put("/workspaces/:id/slack", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const row = await loadConnection(c.env, workspaceId);
  if (!row) throw new HttpError(400, "not_connected", "Connect Slack first.");
  const body = await readJson(c.req);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.mode !== undefined) {
    if (!SLACK_MODES.includes(body.mode as SlackMode)) throw new HttpError(400, "invalid_field", "mode must be handoff or all.");
    sets.push("mode = ?");
    params.push(body.mode);
  }
  if (body.channelId !== undefined) {
    if (typeof body.channelId !== "string" || !/^[CG][A-Z0-9]{4,}$/.test(body.channelId)) throw new HttpError(400, "invalid_field", "Pick a channel.");
    const api = await apiFor(c, workspaceId);
    const { channel } = await api.info(body.channelId).catch(slackFailed);
    if (channel.is_archived) throw new HttpError(400, "invalid_field", `#${channel.name} is archived. Pick another channel.`);
    if (!channel.is_member) {
      if (channel.is_private) throw new HttpError(400, "invite_bot", `Invite the bot to #${channel.name} first: type /invite @Jun there, then pick it again.`);
      await api.join(channel.id).catch(slackFailed);
    }
    const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
    if (channel.id !== row.channel_id) {
      await api.postMessage({
        channel: channel.id,
        text: `Jun is connected: chats from ${ws?.name ?? "your desk"} that need a person will open a thread here. Reply in a thread to answer the customer.`,
      }).catch(slackFailed);
    }
    sets.push("channel_id = ?", "channel_name = ?", "status = 'connected'", "last_error = NULL");
    params.push(channel.id, channel.name);
  }
  if (!sets.length) throw new HttpError(400, "invalid_body", "Nothing to change.");
  await c.env.DB.prepare(`UPDATE slack_connections SET ${sets.join(", ")} WHERE workspace_id = ?`).bind(...params, workspaceId).run();
  return c.json(await view(c, workspaceId, true));
});

/** Disconnects: the keys are forgotten; threads stay in Slack (and come back if the same Slack workspace connects again). */
slack.delete("/workspaces/:id/slack", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  await c.env.WORKSPACE_HUB.getByName(workspaceId).setSlackKeys(null);
  await c.env.DB.prepare("DELETE FROM slack_connections WHERE workspace_id = ?").bind(workspaceId).run();
  return c.json(await view(c, workspaceId, true));
});

