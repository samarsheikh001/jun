import { readPing, TELEMETRY_FEATURES, AI_PROVIDERS } from "../shared/telemetry.ts";

// T-20 (D-151): the collector for desks' anonymous daily pings, run by the Jun project at
// telemetry.jun.so (not part of a desk: deployed on its own from this folder, see README.md).
// Stores what `readPing` lets through, one row per desk per day; never the IP address or any
// header. GET /?key=<STATS_KEY> shows the numbers. It also takes jun.so's hosted-Jun waitlist (POST /v1/waitlist,
// emails people chose to leave), in its own database.

interface CollectorEnv {
  DB: D1Database;
  /** The hosted-Jun waitlist (waitlist.sql), apart from the pings. */
  WAITLIST: D1Database;
  /** `wrangler secret put STATS_KEY`: the stats page's key. */
  STATS_KEY?: string;
}

const MAX_BODY = 2048;
const DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(request: Request, env: CollectorEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/ping") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      return receive(request, env);
    }
    if (url.pathname === "/v1/waitlist") return waitlist(request, env);
    if (url.pathname === "/" && request.method === "GET") return stats(url, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;

async function receive(request: Request, env: CollectorEnv): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response("Too large", { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Response("Not JSON", { status: 400 });
  }
  const ping = readPing(raw);
  if (!ping) return new Response("Not a ping", { status: 400 });
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const payload = JSON.stringify(ping);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO desks (id, first_seen, last_seen, version, payload) VALUES (?1, ?2, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET last_seen = ?2, version = ?3, payload = ?4`,
    ).bind(ping.id, now, ping.version, payload),
    env.DB.prepare(
      `INSERT INTO pings (day, id, version, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, id) DO UPDATE SET version = excluded.version, payload = excluded.payload`,
    ).bind(day, ping.id, ping.version, payload),
  ]);
  return new Response(null, { status: 204 });
}

// The site's pages post here from the browser.
const SITE_ORIGINS = new Set(["https://jun.so", "https://www.jun.so", "http://localhost:3000"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SOURCE = /^[a-z0-9-]{1,32}$/;

async function waitlist(request: Request, env: CollectorEnv): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  const cors: Record<string, string> = SITE_ORIGINS.has(origin)
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", vary: "origin" }
    : {};
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
  if (!SITE_ORIGINS.has(origin)) return new Response("Not allowed", { status: 403 });
  const text = await request.text();
  if (text.length > 1024) return new Response("Too large", { status: 413, headers: cors });
  let body: { email?: unknown; source?: unknown; website?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return new Response("Not JSON", { status: 400, headers: cors });
  }
  // `website` is a field people never see: a bot that fills it gets the same answer and nothing is saved.
  if (body.website) return new Response(null, { status: 204, headers: cors });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) return new Response("Not an email", { status: 400, headers: cors });
  const source = typeof body.source === "string" && SOURCE.test(body.source) ? body.source : "site";
  // Already on the list answers the same, so the form doesn't tell anyone who signed up.
  await env.WAITLIST.prepare("INSERT OR IGNORE INTO waitlist (email, created_at, source) VALUES (?, ?, ?)")
    .bind(email, Date.now(), source)
    .run();
  return new Response(null, { status: 204, headers: cors });
}

async function sameKey(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

interface DeskRow { id: string; first_seen: number; last_seen: number; version: string; payload: string }

async function stats(url: URL, env: CollectorEnv): Promise<Response> {
  const key = url.searchParams.get("key") ?? "";
  if (!env.STATS_KEY || !(await sameKey(key, env.STATS_KEY))) return new Response("Not found", { status: 404 });
  const now = Date.now();
  const { results: desks } = await env.DB.prepare("SELECT id, first_seen, last_seen, version, payload FROM desks").all<DeskRow>();
  const { results: days } = await env.DB.prepare(
    "SELECT day, COUNT(*) AS n FROM pings WHERE day >= ? GROUP BY day ORDER BY day",
  ).bind(new Date(now - 30 * DAY_MS).toISOString().slice(0, 10)).all<{ day: string; n: number }>();

  const { results: waiting } = await env.WAITLIST.prepare(
    "SELECT email, created_at, source FROM waitlist ORDER BY created_at DESC",
  ).all<{ email: string; created_at: number; source: string }>();

  const within = (ms: number) => desks.filter((d) => now - d.last_seen < ms);
  const active = within(7 * DAY_MS);
  const pings = active.map((d) => JSON.parse(d.payload) as Record<string, unknown>);
  const tally = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  };
  const share = (list: [string, number][]) =>
    list.map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td><td>${active.length ? Math.round((n / active.length) * 100) : 0}%</td></tr>`).join("");
  const field = (name: string) => tally(pings.map((p) => String(p[name])));
  const listField = (name: string, all: readonly string[]) =>
    all.map((k) => [k, pings.filter((p) => (p[name] as string[]).includes(k)).length] as [string, number]).sort((a, b) => b[1] - a[1]);

  const section = (title: string, rows: string) =>
    `<h2>${title}</h2><table><tr><th></th><th>Desks</th><th>Share</th></tr>${rows || "<tr><td colspan=3>None yet</td></tr>"}</table>`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jun desks</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#1f1a13;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}}
.big{display:flex;gap:24px;flex-wrap:wrap}.big div{min-width:120px}.big b{display:block;font-size:28px}
table{border-collapse:collapse;width:100%;margin-bottom:8px}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #8884}td:not(:first-child),th:not(:first-child){text-align:right}
h2{font-size:15px;margin:28px 0 6px}.muted{opacity:.6}</style>
<h1>Jun desks</h1>
<p class="muted">Anonymous daily pings (T-20). Active = sent a ping in the last 7 days; breakdowns are over active desks.</p>
<div class="big">
<div><b>${within(DAY_MS * 1.5).length}</b>active today</div>
<div><b>${active.length}</b>active, 7 days</div>
<div><b>${within(30 * DAY_MS).length}</b>active, 30 days</div>
<div><b>${desks.length}</b>ever seen</div>
<div><b>${desks.filter((d) => now - d.first_seen < 7 * DAY_MS).length}</b>new this week</div>
</div>
${section("Versions", share(tally(active.map((d) => d.version))))}
${section("Conversations in the last 30 days", share(field("chats30d")))}
${section("Features in use", share(listField("features", TELEMETRY_FEATURES)))}
${section("AI provider", share(listField("providers", AI_PROVIDERS)))}
${section("Workspaces", share(field("workspaces")))}
${section("Team members", share(field("members")))}
${section("Desk age (days)", share(field("age")))}
<h2>Hosted-Jun waitlist (${waiting.length})</h2><table><tr><th>Email</th><th>From</th><th>Joined</th></tr>${waiting.map((w) => `<tr><td>${esc(w.email)}</td><td>${esc(w.source)}</td><td>${new Date(w.created_at).toISOString().slice(0, 10)}</td></tr>`).join("") || "<tr><td colspan=3>Nobody yet</td></tr>"}</table>
<h2>Desks per day</h2><table><tr><th>Day</th><th>Desks</th></tr>${days.map((d) => `<tr><td>${d.day}</td><td>${d.n}</td></tr>`).join("") || "<tr><td colspan=2>None yet</td></tr>"}</table>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
