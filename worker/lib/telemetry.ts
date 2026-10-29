import { JUN_VERSION } from "../../shared/version.ts";
import { buildPing, newInstallId, telemetryOn, TELEMETRY_URL, type DeskFacts, type TelemetryPing } from "../../shared/telemetry.ts";

// T-20 (D-151): the desk's anonymous daily ping (what's in it: `shared/telemetry.ts`). Sent from the
// daily cron run, and from the first cron run after setup so a new desk shows up the same day. The
// install id, the owner's switch and the last send live in the `settings` table.

const ID_KEY = "telemetry_id";
const SWITCH_KEY = "telemetry";
const SENT_KEY = "telemetry_sent";
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_CONTROL_TOOLS = ["read_page", "click", "type_text", "choose_option", "scroll_page"].map((n) => `page:${n}`);

type TelemetryEnv = Env & { JUN_TELEMETRY?: string; JUN_TELEMETRY_URL?: string };

async function setting(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

async function installId(db: D1Database): Promise<string> {
  const id = await setting(db, ID_KEY);
  if (id) return id;
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").bind(ID_KEY, newInstallId()).run();
  return (await setting(db, ID_KEY))!;
}

/** The real counts, read in one batch. Only `buildPing`'s ranges leave the desk. */
export async function deskFacts(db: D1Database, now = Date.now()): Promise<DeskFacts> {
  const since = now - 30 * DAY_MS;
  const marks = PAGE_CONTROL_TOOLS.map(() => "?").join(", ");
  const count = (sql: string, ...args: unknown[]) => db.prepare(`SELECT (${sql}) AS n`).bind(...args);
  const results = await db.batch<{ n: number | string | null }>([
    count("SELECT COUNT(*) FROM workspaces"),
    count("SELECT COUNT(DISTINCT user_id) FROM members"),
    count("SELECT COUNT(*) FROM conversations WHERE created_at >= ?", since),
    count("SELECT value FROM settings WHERE key = 'setup_completed'"),
    count("SELECT group_concat(DISTINCT provider) FROM ai_settings WHERE enabled = 1"),
    count("SELECT COUNT(*) FROM kb_sources"),
    count("SELECT COUNT(*) FROM inboxes WHERE json_extract(settings, '$.email.enabled') = 1"),
    count("SELECT COUNT(*) FROM inboxes WHERE identity_secret IS NOT NULL"),
    count(`SELECT COUNT(*) FROM ai_actions WHERE created_at >= ? AND tool IN (${marks})`, since, ...PAGE_CONTROL_TOOLS),
    count(`SELECT COUNT(*) FROM ai_actions WHERE created_at >= ? AND tool NOT IN (${marks})`, since, ...PAGE_CONTROL_TOOLS),
    count("SELECT COUNT(*) FROM api_tokens"),
    count("SELECT COUNT(*) FROM conversation_issues"),
    count("SELECT COUNT(*) FROM slack_connections WHERE status = 'connected' AND channel_id IS NOT NULL"),
  ]);
  const n = (i: number) => Number(results[i]?.results[0]?.n ?? 0) || 0;
  const providers = String(results[4]?.results[0]?.n ?? "").split(",").filter(Boolean);
  const setupAt = n(3);
  const features: string[] = [];
  if (providers.length) features.push("ai");
  if (n(5)) features.push("knowledge");
  if (n(6)) features.push("email");
  if (n(7)) features.push("identity");
  if (n(8)) features.push("pageControl");
  if (n(9)) features.push("actions");
  if (n(10)) features.push("mcp");
  if (n(11)) features.push("issues");
  if (n(12)) features.push("slack");
  return {
    workspaces: n(0),
    members: n(1),
    chats30d: n(2),
    ageDays: setupAt ? (now - setupAt) / DAY_MS : 0,
    providers,
    features,
  };
}

export interface TelemetryState {
  on: boolean;
  /** JUN_TELEMETRY=off on the Worker: the switch can't turn it back on. */
  offByEnv: boolean;
  lastSentAt: number | null;
  /** Exactly what the next ping sends. */
  preview: TelemetryPing;
}

export async function telemetryState(env: TelemetryEnv): Promise<TelemetryState> {
  const [stored, sent, id, facts] = await Promise.all([setting(env.DB, SWITCH_KEY), setting(env.DB, SENT_KEY), installId(env.DB), deskFacts(env.DB)]);
  return {
    on: telemetryOn(env.JUN_TELEMETRY, stored),
    offByEnv: !telemetryOn(env.JUN_TELEMETRY, null),
    lastSentAt: sent ? Number(sent) : null,
    preview: buildPing(id, JUN_VERSION, facts),
  };
}

export async function setTelemetry(db: D1Database, on: boolean): Promise<void> {
  await putSetting(db, SWITCH_KEY, on ? "on" : "off");
}

/**
 * From the cron: on the daily run, or on any run while it has never been sent (a new desk). Never
 * before the owner account exists, never when off; failures are quiet and retried the next day.
 */
export async function sendTelemetry(env: TelemetryEnv, daily: boolean, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const [stored, sent, setup] = await Promise.all([setting(env.DB, SWITCH_KEY), setting(env.DB, SENT_KEY), setting(env.DB, "setup_completed")]);
    if (!setup || !telemetryOn(env.JUN_TELEMETRY, stored)) return;
    const now = Date.now();
    if (!daily && sent) return;
    if (sent && now - Number(sent) < DAY_MS / 2) return;
    const ping = buildPing(await installId(env.DB), JUN_VERSION, await deskFacts(env.DB, now));
    // The time is saved first, so a collector that's down isn't retried every 15 minutes.
    await putSetting(env.DB, SENT_KEY, String(now));
    await fetchImpl(env.JUN_TELEMETRY_URL || TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `jun-desk/${JUN_VERSION}` },
      body: JSON.stringify(ping),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.warn("telemetry ping failed", error instanceof Error ? error.message : error);
  }
}
