import { PROPOSAL_KINDS, type AskStep, type AskTurn, type ProposalOutcome, type ProposedAction } from "../../shared/desk-assistant.ts";

// D-132: Home's assistant thread kept in this browser (localStorage, per workspace + member), so a reload
// or leaving Home doesn't wipe it; D-134: up to 20 threads, New chat starts another. Pure parts here: what's stored, how it's read back, and the Recent
// questions shown on an empty pane. Never the answer being written; a card still waiting comes back
// settled as expired, so Confirm can't run a stale change.

export type Turn = (AskTurn & { id: number; /** ms the answer took. */ took?: number; stopped?: boolean; /** D-134: next questions, chips under the newest answer. */ followUps?: string[] }) | { id: number; role: "error"; text: string };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type StoredTurn = WithoutId<Turn>;

/** D-134: v2 keeps several threads (v1, D-132, kept one and is read as one). */
export interface Stored {
  v: 2;
  current: string | null;
  threads: { id: string; title: string; updatedAt: number; turns: StoredTurn[] }[];
  /** The member's last questions, newest first, distinct; kept through New chat. */
  recent: string[];
}

export const MAX_TURNS = 30;
export const MAX_BYTES = 200_000;
export const MAX_RECENT = 5;
const MAX_QUESTION = 500;
export const EXPIRED: ProposalOutcome = { status: "cancelled", detail: "expired" };

export const askKey = (workspaceId: string, userId: string) => `jun:ask:${workspaceId}:${userId}`;

const KINDS = new Set<string>(PROPOSAL_KINDS);
const STEP_STATUS = new Set(["running", "done", "error"]);
const OUTCOME_STATUS = new Set(["done", "cancelled", "failed"]);
const RESULT_STATUS = new Set(["done", "failed", "skipped"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

function readStep(v: unknown): AskStep | null {
  if (!isObj(v) || !str(v.id) || !str(v.tool) || !str(v.label) || !STEP_STATUS.has(v.status as string)) return null;
  const table = readTable(v.table);
  const passages = readPassages(v.passages);
  const charts = Array.isArray(v.charts) ? v.charts.filter((c) => isObj(c) && ((c.kind === "days" && Array.isArray(c.series)) || (c.kind === "ranked" && Array.isArray(c.rows) && str(c.title)))) : [];
  return { id: v.id, tool: v.tool, label: v.label, status: v.status === "running" ? "error" : (v.status as AskStep["status"]), ...(str(v.input) ? { input: v.input } : {}), ...(str(v.result) ? { result: v.result } : {}), ...(table ? { table } : {}), ...(passages ? { passages } : {}), ...(charts.length ? { charts: charts as AskStep["charts"] } : {}) };
}

/** D-134: a step's Context Cards back, if they still look like them. */
function readPassages(v: unknown): AskStep["passages"] | undefined {
  if (!isObj(v) || !str(v.query) || !Array.isArray(v.hits)) return undefined;
  const hits = v.hits.filter((h) => isObj(h) && str(h.title) && str(h.text) && str(h.source) && str(h.kind)).slice(0, 5);
  return hits.length ? ({ query: v.query, hits } as AskStep["passages"]) : undefined;
}

const TABLE_KINDS = new Set(["chats", "people", "companies"]);
/** D-134: a step's Records Table back, if it still looks like one. */
function readTable(v: unknown): AskStep["table"] | undefined {
  if (!isObj(v) || !TABLE_KINDS.has(v.kind as string) || !Array.isArray(v.rows)) return undefined;
  const rows = v.rows.filter((r) => isObj(r) && str(r.id) && str(r.name)).slice(0, 25);
  return rows.length ? ({ ...v, rows } as AskStep["table"]) : undefined;
}

function readProposal(v: unknown): ProposedAction | null {
  if (!isObj(v) || !str(v.callId) || !str(v.tool) || !str(v.summary) || !isObj(v.labels) || !isObj(v.proposal) || !KINDS.has(v.proposal.kind as string)) return null;
  const p = v.proposal;
  if (p.kind === "tags" && (!Array.isArray(p.add) || !Array.isArray(p.remove))) return null;
  if ("changes" in p && !Array.isArray(p.changes)) return null;
  if (p.kind === "bulk" && (!Array.isArray(p.items) || !p.items.every((i) => isObj(i) && str(i.conversationId) && str(i.customer) && str(i.before) && str(i.after)))) return null;
  const text = (x: unknown) => x === null || str(x);
  if (p.kind === "agent_file" && (!str(p.path) || !text(p.before) || !text(p.after))) return null;
  return v as unknown as ProposedAction;
}

function readOutcome(v: unknown): ProposalOutcome | null {
  if (!isObj(v) || !OUTCOME_STATUS.has(v.status as string)) return null;
  const results = Array.isArray(v.results) ? v.results.filter((r): r is NonNullable<ProposalOutcome["results"]>[number] => isObj(r) && str(r.conversationId) && RESULT_STATUS.has(r.status as string)) : [];
  return { status: v.status as ProposalOutcome["status"], ...(str(v.detail) ? { detail: v.detail } : {}), ...(results.length ? { results } : {}) };
}

/** One stored turn back, or null when it doesn't look like one. A waiting card comes back expired. */
function readTurn(v: unknown, id: number): Turn | null {
  if (!isObj(v) || !str(v.text)) return null;
  if (v.role === "user" || v.role === "error") return { id, role: v.role, text: v.text };
  if (v.role !== "assistant") return null;
  const steps = Array.isArray(v.steps) ? v.steps.map(readStep).filter((s): s is AskStep => s !== null) : [];
  const proposal = readProposal(v.proposal);
  const outcome = proposal ? (readOutcome(v.outcome) ?? EXPIRED) : null;
  return {
    id,
    role: "assistant",
    text: v.text,
    ...(steps.length ? { steps } : {}),
    ...(proposal ? { proposal, outcome: outcome! } : {}),
    ...(typeof v.took === "number" ? { took: v.took } : {}),
    ...(v.stopped === true ? { stopped: true } : {}),
    ...(Array.isArray(v.followUps) && v.followUps.every(str) ? { followUps: v.followUps.slice(0, 3) } : {}),
  };
}

/** The last turns that fit: ≤ MAX_TURNS and ≤ MAX_BYTES of JSON, starting at a question. */
export function trimTurns(turns: StoredTurn[], maxBytes = MAX_BYTES): StoredTurn[] {
  let out = turns.slice(-MAX_TURNS);
  const startAtQuestion = () => {
    const i = out.findIndex((t) => t.role === "user");
    out = i < 0 ? [] : out.slice(i);
  };
  startAtQuestion();
  while (out.length && JSON.stringify(out).length > maxBytes) {
    out = out.slice(1);
    startAtQuestion();
  }
  return out;
}

/** A thread's turns as stored: without ids (an invite link made on a card stays in the tab, D-133), trimmed. */
function storedTurns(turns: Turn[]): StoredTurn[] {
  return trimTurns(turns.map(({ id: _id, ...t }) => ("outcome" in t && t.outcome?.link ? { ...t, outcome: { status: t.outcome.status, ...(t.outcome.detail ? { detail: t.outcome.detail } : {}), ...(t.outcome.results ? { results: t.outcome.results } : {}) } } : t) as StoredTurn));
}

/** D-134: one saved conversation with the assistant. */
export interface SavedThread {
  id: string;
  /** Its first question. */
  title: string;
  updatedAt: number;
  turns: Turn[];
}

/** D-134: the member's threads in this browser, which one is open, and their recent questions. */
export interface AskState {
  current: string | null;
  threads: SavedThread[];
  recent: string[];
}

export const MAX_THREADS = 20;
/** All threads together, as JSON (localStorage holds about 5 MB per site). */
export const MAX_TOTAL_BYTES = 1_000_000;

export const newThreadId = (random: () => number = Math.random): string => `t${Date.now().toString(36)}${Math.floor(random() * 1e8).toString(36)}`;

/** A thread's title: its first question, one line. */
export function threadTitle(turns: { role: string; text: string }[]): string {
  const q = turns.find((t) => t.role === "user")?.text ?? "";
  const line = q.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "New chat";
}

/** The threads with `thread` put in (by id; an empty one is taken out), newest first, ≤ MAX_THREADS. */
export function upsertThread(threads: SavedThread[], thread: SavedThread): SavedThread[] {
  const rest = threads.filter((t) => t.id !== thread.id);
  const next = thread.turns.length ? [{ ...thread, title: threadTitle(thread.turns) }, ...rest] : rest;
  return next.sort((x, y) => y.updatedAt - x.updatedAt).slice(0, MAX_THREADS);
}

/** Threads another tab saved, merged into ours: each id once, the newer copy kept; `gone` ids (deleted here) stay out. */
export function mergeThreads(ours: SavedThread[], theirs: SavedThread[], gone: ReadonlySet<string> = new Set()): SavedThread[] {
  const byId = new Map<string, SavedThread>();
  for (const t of [...theirs, ...ours]) {
    if (gone.has(t.id)) continue;
    const had = byId.get(t.id);
    if (!had || t.updatedAt >= had.updatedAt) byId.set(t.id, t);
  }
  return [...byId.values()].sort((x, y) => y.updatedAt - x.updatedAt).slice(0, MAX_THREADS);
}

/** What goes in localStorage (v2): every thread's finished turns, trimmed; the oldest threads go first when it's too big. */
export function serialiseAsk(state: AskState, maxBytes = MAX_TOTAL_BYTES): string {
  let threads = state.threads
    .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, turns: storedTurns(t.turns) }))
    .filter((t) => t.turns.length)
    .sort((x, y) => y.updatedAt - x.updatedAt)
    .slice(0, MAX_THREADS);
  const json = () => JSON.stringify({ v: 2, current: state.current, threads, recent: state.recent.slice(0, MAX_RECENT) } satisfies Stored);
  let out = json();
  while (out.length > maxBytes && threads.length > 1) {
    const drop = threads.findLastIndex((t) => t.id !== state.current);
    threads = threads.filter((_, i) => i !== (drop < 0 ? threads.length - 1 : drop));
    out = json();
  }
  return out;
}

/** A stored value back (fresh ids from `nextId`); v1 (one thread, D-132) becomes one saved thread; anything that doesn't parse is empty. */
export function restoreAsk(raw: string | null, nextId: () => number, now = Date.now()): AskState {
  const empty: AskState = { current: null, threads: [], recent: [] };
  if (!raw) return empty;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isObj(v)) return empty;
  const turnsOf = (list: unknown) => (Array.isArray(list) ? list.map((t) => readTurn(t, nextId())).filter((t): t is Turn => t !== null) : []);
  const recent = Array.isArray(v.recent) ? v.recent.filter(str).slice(0, MAX_RECENT) : [];
  if (v.v === 1) {
    const turns = turnsOf(v.turns);
    if (!turns.length) return { ...empty, recent };
    const id = "t-v1";
    return { current: id, threads: [{ id, title: threadTitle(turns), updatedAt: now, turns }], recent };
  }
  if (v.v !== 2 || !Array.isArray(v.threads)) return empty;
  const threads = v.threads
    .filter((t): t is Record<string, unknown> => isObj(t) && str(t.id) && typeof t.updatedAt === "number")
    .map((t) => {
      const turns = turnsOf(t.turns);
      return { id: t.id as string, title: str(t.title) && t.title ? t.title : threadTitle(turns), updatedAt: t.updatedAt as number, turns };
    })
    .filter((t) => t.turns.length)
    .slice(0, MAX_THREADS);
  const current = str(v.current) && threads.some((t) => t.id === v.current) ? v.current : null;
  return { current, threads, recent };
}

/** D-139: a thread as the server keeps it (PUT …/home/threads/:id): its finished turns, trimmed, no invite links. */
export function serverThread(t: SavedThread): { title: string; updatedAt: number; turns: StoredTurn[] } {
  return { title: t.title || threadTitle(t.turns), updatedAt: t.updatedAt, turns: storedTurns(t.turns) };
}

/** D-139: a thread from the server (GET …/home/threads/:id) read like a stored one (a waiting card comes back expired); null when empty or not one. */
export function readServerThread(v: unknown, nextId: () => number): SavedThread | null {
  if (!isObj(v) || !str(v.id) || typeof v.updatedAt !== "number" || !Array.isArray(v.turns)) return null;
  const turns = v.turns.map((t) => readTurn(t, nextId())).filter((t): t is Turn => t !== null);
  if (!turns.length) return null;
  return { id: v.id, title: str(v.title) && v.title ? v.title : threadTitle(turns), updatedAt: v.updatedAt, turns };
}

/** The recent questions with `question` first, once each (ignoring case and spaces), ≤ MAX_RECENT. */
export function addRecent(recent: string[], question: string): string[] {
  const q = question.trim().replace(/\s+/g, " ").slice(0, MAX_QUESTION);
  if (!q) return recent;
  const same = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase() === q.toLowerCase();
  return [q, ...recent.filter((s) => !same(s))].slice(0, MAX_RECENT);
}
