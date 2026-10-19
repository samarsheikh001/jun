import type { AskStep, AskTurn, ProposalOutcome, ProposedAction } from "../../shared/desk-assistant.ts";

// D-132: Home's assistant thread kept in this browser (localStorage, per workspace + member), so a reload
// or leaving Home doesn't wipe it. Pure parts here: what's stored, how it's read back, and the Recent
// questions shown on an empty pane. Never the answer being written; a card still waiting comes back
// settled as expired, so Confirm can't run a stale change.

export type Turn = (AskTurn & { id: number; /** ms the answer took. */ took?: number; stopped?: boolean }) | { id: number; role: "error"; text: string };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type StoredTurn = WithoutId<Turn>;

export interface Stored {
  v: 1;
  turns: StoredTurn[];
  /** The member's last questions, newest first, distinct; kept through New chat. */
  recent: string[];
}

export const MAX_TURNS = 30;
export const MAX_BYTES = 200_000;
export const MAX_RECENT = 5;
const MAX_QUESTION = 500;
export const EXPIRED: ProposalOutcome = { status: "cancelled", detail: "expired" };

export const askKey = (workspaceId: string, userId: string) => `jun:ask:${workspaceId}:${userId}`;

const KINDS = new Set(["assign", "status", "tags", "note", "reply_draft", "issue", "knowledge_website", "knowledge_text"]);
const STEP_STATUS = new Set(["running", "done", "error"]);
const OUTCOME_STATUS = new Set(["done", "cancelled", "failed"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

function readStep(v: unknown): AskStep | null {
  if (!isObj(v) || !str(v.id) || !str(v.tool) || !str(v.label) || !STEP_STATUS.has(v.status as string)) return null;
  return { id: v.id, tool: v.tool, label: v.label, status: v.status === "running" ? "error" : (v.status as AskStep["status"]), ...(str(v.input) ? { input: v.input } : {}), ...(str(v.result) ? { result: v.result } : {}) };
}

function readProposal(v: unknown): ProposedAction | null {
  if (!isObj(v) || !str(v.callId) || !str(v.tool) || !str(v.summary) || !isObj(v.labels) || !isObj(v.proposal) || !KINDS.has(v.proposal.kind as string)) return null;
  const p = v.proposal;
  if (p.kind === "tags" && (!Array.isArray(p.add) || !Array.isArray(p.remove))) return null;
  return v as unknown as ProposedAction;
}

function readOutcome(v: unknown): ProposalOutcome | null {
  if (!isObj(v) || !OUTCOME_STATUS.has(v.status as string)) return null;
  return { status: v.status as ProposalOutcome["status"], ...(str(v.detail) ? { detail: v.detail } : {}) };
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

/** What goes in localStorage: the finished turns without ids, trimmed, and the recent questions. */
export function serialiseAsk(turns: Turn[], recent: string[]): string {
  const stored = turns.map(({ id: _id, ...t }) => t as StoredTurn);
  return JSON.stringify({ v: 1, turns: trimTurns(stored), recent: recent.slice(0, MAX_RECENT) } satisfies Stored);
}

/** A stored value back (fresh ids from `nextId`); anything that doesn't parse is an empty thread. */
export function restoreAsk(raw: string | null, nextId: () => number): { turns: Turn[]; recent: string[] } {
  const empty = { turns: [], recent: [] };
  if (!raw) return empty;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isObj(v) || v.v !== 1) return empty;
  const turns = Array.isArray(v.turns) ? v.turns.map((t) => readTurn(t, nextId())).filter((t): t is Turn => t !== null) : [];
  const recent = Array.isArray(v.recent) ? v.recent.filter(str).slice(0, MAX_RECENT) : [];
  return { turns, recent };
}

/** The recent questions with `question` first, once each (ignoring case and spaces), ≤ MAX_RECENT. */
export function addRecent(recent: string[], question: string): string[] {
  const q = question.trim().replace(/\s+/g, " ").slice(0, MAX_QUESTION);
  if (!q) return recent;
  const same = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase() === q.toLowerCase();
  return [q, ...recent.filter((s) => !same(s))].slice(0, MAX_RECENT);
}
