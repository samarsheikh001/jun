// D-139: Home's assistant threads on the server (D1 `assistant_threads`, per member per workspace). Pure
// parts shared by the Worker's routes (worker/routes/home.ts) and the page's sync (web/home/AskChat.tsx):
// what a stored thread may hold and how the two sides' lists are reconciled. The browser keeps its
// localStorage copy as a cache; the newer copy of a thread (by `updatedAt`) wins on either side.

export const MAX_SERVER_THREADS = 20;
/** One thread's turns as JSON (the same cap as the browser's, ask-store's MAX_BYTES). */
export const MAX_THREAD_BYTES = 200_000;
export const MAX_THREAD_TURNS = 30;
export const MAX_TITLE = 200;
/** Tombstones of deleted threads are kept this long, then forgotten. */
export const TOMBSTONE_MS = 30 * 24 * 3600_000;

const THREAD_ID = /^t[\w-]{1,48}$/;
export const isThreadId = (v: unknown): v is string => typeof v === "string" && THREAD_ID.test(v);

export interface ThreadMeta {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ThreadList {
  threads: ThreadMeta[];
  /** Threads deleted (or trimmed) on the server: a browser drops its cached copy unless it changed later. */
  deleted: { id: string; deletedAt: number }[];
}

export type CleanThread = { ok: true; title: string; updatedAt: number; turns: string } | { ok: false; code: "invalid_body" | "too_large"; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A PUT body checked for storing: a title, a time, and the turns as JSON without local ids and without
 * any outcome's `link` (an invite link made on a card stays on the card, D-133). Too big is `too_large`.
 */
export function cleanThread(body: unknown, now = Date.now()): CleanThread {
  if (!isObj(body)) return { ok: false, code: "invalid_body", message: "Send the thread as an object." };
  const { title, updatedAt, turns } = body;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) return { ok: false, code: "invalid_body", message: "updatedAt must be a time in ms." };
  if (!Array.isArray(turns) || !turns.length) return { ok: false, code: "invalid_body", message: "turns must be a non-empty list." };
  if (turns.length > MAX_THREAD_TURNS) return { ok: false, code: "too_large", message: `At most ${MAX_THREAD_TURNS} turns.` };
  const clean = turns.map((t: unknown) => {
    if (!isObj(t) || typeof t.role !== "string" || typeof t.text !== "string") return null;
    const { id: _id, ...rest } = t;
    if (isObj(rest.outcome) && "link" in rest.outcome) {
      const { link: _link, ...outcome } = rest.outcome;
      rest.outcome = outcome;
    }
    return rest;
  });
  if (clean.some((t) => t === null)) return { ok: false, code: "invalid_body", message: "Each turn needs a role and text." };
  const json = JSON.stringify(clean);
  if (json.length > MAX_THREAD_BYTES) return { ok: false, code: "too_large", message: "That thread is too long to keep." };
  const line = (typeof title === "string" ? title : "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || "New chat";
  // A clock far ahead mustn't pin a thread to the top for ever.
  return { ok: true, title: line, updatedAt: Math.min(Math.floor(updatedAt), now + 60_000), turns: json };
}

/** Threads past the cap, oldest first out: the ids to turn into tombstones. */
export function overCap(threads: ThreadMeta[], max = MAX_SERVER_THREADS): string[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(max).map((t) => t.id);
}

export interface SyncPlan {
  /** On the server and newer there (or not here): fetch. */
  download: string[];
  /** Here and newer here (or not on the server, and not deleted there since): upload. */
  upload: string[];
  /** Deleted on the server after this copy last changed: drop here. */
  remove: string[];
}

/** What a browser does with the server's list, by `updatedAt` per id; `gone` are ids deleted in this tab. */
export function planSync(local: ThreadMeta[], server: ThreadList, gone: ReadonlySet<string> = new Set()): SyncPlan {
  const there = new Map(server.threads.map((t) => [t.id, t]));
  const deleted = new Map(server.deleted.map((d) => [d.id, d.deletedAt]));
  const here = new Map(local.map((t) => [t.id, t]));
  const plan: SyncPlan = { download: [], upload: [], remove: [] };
  for (const t of server.threads) {
    if (gone.has(t.id)) continue;
    const mine = here.get(t.id);
    if (!mine || t.updatedAt > mine.updatedAt) plan.download.push(t.id);
  }
  for (const t of local) {
    if (gone.has(t.id)) continue;
    const theirs = there.get(t.id);
    const deletedAt = deleted.get(t.id);
    if (!theirs && deletedAt !== undefined && deletedAt >= t.updatedAt) plan.remove.push(t.id);
    else if (!theirs || t.updatedAt > theirs.updatedAt) plan.upload.push(t.id);
  }
  return plan;
}

// ---------- D-144: the member's recent questions, merged across browsers ----------

export const MAX_RECENT = 5;
export const MAX_RECENT_QUESTION = 500;

/** One question asked, and when (ms); the newest asking counts. */
export interface RecentQuestion {
  q: string;
  at: number;
}

const recentKey = (q: string) => q.trim().replace(/\s+/g, " ").toLowerCase();

/** Several lists as one: each question once (ignoring case and spaces, its newest time kept), newest first, ≤ MAX_RECENT. */
export function mergeRecent(...lists: RecentQuestion[][]): RecentQuestion[] {
  const byKey = new Map<string, RecentQuestion>();
  for (const r of lists.flat()) {
    const key = recentKey(r.q);
    if (!key) continue;
    const had = byKey.get(key);
    if (!had || r.at > had.at) byKey.set(key, { q: r.q.trim().replace(/\s+/g, " "), at: r.at });
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, MAX_RECENT);
}

/** A stored or sent list read leniently: `{ q, at }` items (or bare strings, D-132's shape, timed newest first before `now`); merged. */
export function readRecent(v: unknown, now = Date.now()): RecentQuestion[] {
  if (!Array.isArray(v)) return [];
  const out: RecentQuestion[] = [];
  v.slice(0, 20).forEach((r, i) => {
    if (typeof r === "string") out.push({ q: r.slice(0, MAX_RECENT_QUESTION), at: now - 1000 * (i + 1) });
    else if (isObj(r) && typeof r.q === "string" && typeof r.at === "number" && Number.isFinite(r.at) && r.at > 0) out.push({ q: r.q.slice(0, MAX_RECENT_QUESTION), at: Math.min(Math.floor(r.at), now + 60_000) });
  });
  return mergeRecent(out);
}
