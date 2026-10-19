// I-19 (D-127): Home's desk assistant, the pure parts shared by the Worker (worker/ai/desk-assistant.ts)
// and the Home page: the tool inputs and their checks, the size cap on what a tool returns, the
// action proposals (the model proposes, the person confirms, the browser calls the desk's own routes),
// the chat history the page sends back each turn, the stream's events and the per-member rate limit.

import type { ConversationStatus } from "./protocol.ts";

export class AssistantInputError extends Error {}

const fail = (message: string): never => {
  throw new AssistantInputError(message);
};

type Input = Record<string, unknown>;

/** A tool call's arguments as an object (some providers send a JSON string). */
export function callInput(raw: unknown): Input {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {};
}

function str(input: Input, key: string, max: number, required = false): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") {
    if (required) fail(`${key} is required.`);
    return undefined;
  }
  if (typeof v !== "string") return fail(`${key} must be text.`);
  const s = v.trim();
  if (!s) {
    if (required) fail(`${key} is required.`);
    return undefined;
  }
  return s.slice(0, max);
}

function oneOf<T extends string>(input: Input, key: string, values: readonly T[]): T | undefined {
  const v = str(input, key, 40);
  if (v === undefined) return undefined;
  if (!(values as readonly string[]).includes(v)) fail(`${key} must be one of ${values.join(", ")}.`);
  return v as T;
}

function int(input: Input, key: string, min: number, max: number, fallback: number): number {
  const v = input[key];
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return fail(`${key} must be a number.`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

const ID = /^[A-Za-z0-9_-]{3,80}$/;
function id(input: Input, key: string, required = true): string {
  const v = str(input, key, 80, required);
  if (v === undefined) return "";
  if (!ID.test(v)) fail(`${key} must be an id from a tool result (like cv_…).`);
  return v;
}

/** "2026-10-20" (a day in the viewer's time zone). */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function day(input: Input, key: string): string | undefined {
  const v = str(input, key, 10);
  if (v !== undefined && !(DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) fail(`${key} must be a date like 2026-10-20.`);
  return v;
}

function list(input: Input, key: string, max: number, maxItem: number): string[] {
  const v = input[key];
  if (v === undefined || v === null) return [];
  const items = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : fail(`${key} must be a list.`);
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") fail(`${key} must be a list of text.`);
    const s = (item as string).trim();
    if (s.length > maxItem) fail(`Each of ${key} is at most ${maxItem} characters.`);
    if (s) out.push(s);
  }
  if (out.length > max) fail(`At most ${max} ${key}.`);
  return out;
}

// ---------- read tools ----------

export const STATUS_FILTERS = ["open", "pending", "snoozed", "resolved", "all"] as const;
export const MAX_SEARCH_RESULTS = 20;

export interface ConversationSearch {
  text?: string;
  status: (typeof STATUS_FILTERS)[number];
  handling?: "ai" | "human";
  /** "me", "unassigned" or a teammate's user id. */
  assignee?: string;
  /** A topic's id or name. */
  topic?: string;
  tag?: string;
  /** A customer's name, email or id (their contact). */
  contact?: string;
  /** A company's name or id. */
  company?: string;
  rating?: "good" | "bad";
  /** Only chats whose browser sent errors or failed requests. */
  withErrors: boolean;
  /** Created on or after / on or before these days (viewer's time zone), or in the last `days`. */
  since?: string;
  until?: string;
  days?: number;
  limit: number;
}

export function readConversationSearch(raw: unknown): ConversationSearch {
  const input = callInput(raw);
  const out: ConversationSearch = {
    status: oneOf(input, "status", STATUS_FILTERS) ?? "all",
    withErrors: input.withErrors === true || input.withErrors === "true",
    limit: int(input, "limit", 1, MAX_SEARCH_RESULTS, 10),
  };
  const text = str(input, "text", 200);
  if (text) out.text = text;
  const handling = oneOf(input, "handling", ["ai", "human"] as const);
  if (handling) out.handling = handling;
  const assignee = str(input, "assignee", 80);
  if (assignee) {
    if (assignee !== "me" && assignee !== "unassigned" && !ID.test(assignee)) fail("assignee must be me, unassigned or a teammate's id from list_teammates.");
    out.assignee = assignee;
  }
  for (const key of ["topic", "tag", "contact", "company"] as const) {
    const v = str(input, key, 120);
    if (v) out[key] = v;
  }
  const rating = oneOf(input, "rating", ["good", "bad"] as const);
  if (rating) out.rating = rating;
  const since = day(input, "since");
  if (since) out.since = since;
  const until = day(input, "until");
  if (until) out.until = until;
  if (input.days !== undefined && input.days !== null && input.days !== "") out.days = int(input, "days", 1, 365, 7);
  return out;
}

export const readConversationId = (raw: unknown): { id: string } => ({ id: id(callInput(raw), "id") });

export const METRIC_DAYS = [7, 30, 90] as const;
export function readDays(raw: unknown, fallback: (typeof METRIC_DAYS)[number] = 7): { days: (typeof METRIC_DAYS)[number] } {
  const input = callInput(raw);
  const v = input.days;
  if (v === undefined || v === null || v === "") return { days: fallback };
  const n = Number(v);
  if (!(METRIC_DAYS as readonly number[]).includes(n)) fail("days must be 7, 30 or 90.");
  return { days: n as (typeof METRIC_DAYS)[number] };
}

export function readContactSearch(raw: unknown): { kind: "people" | "companies"; query?: string; company?: string; limit: number } {
  const input = callInput(raw);
  const out: { kind: "people" | "companies"; query?: string; company?: string; limit: number } = {
    kind: oneOf(input, "kind", ["people", "companies"] as const) ?? "people",
    limit: int(input, "limit", 1, 20, 10),
  };
  const query = str(input, "query", 120);
  if (query) out.query = query;
  const company = str(input, "company", 80);
  if (company) {
    if (!ID.test(company)) fail("company must be a company id from find_contacts.");
    out.company = company;
  }
  return out;
}

export const readQuery = (raw: unknown): { query: string } => ({ query: str(callInput(raw), "query", 500, true)! });

export function readAgentFilePath(raw: unknown): { path: string } {
  const path = str(callInput(raw), "path", 200, true)!;
  if (path.startsWith("/") || path.includes("..") || !/^[\w./-]+$/.test(path)) fail("path must be a file path from list_agent_files, like tasks/refunds.md.");
  return { path };
}

export function readAuditQuery(raw: unknown): { conversationId?: string; tool?: string; status?: "ok" | "error"; days: number; limit: number } {
  const input = callInput(raw);
  const out: { conversationId?: string; tool?: string; status?: "ok" | "error"; days: number; limit: number } = { days: int(input, "days", 1, 90, 7), limit: int(input, "limit", 1, 30, 20) };
  if (input.conversationId) out.conversationId = id(input, "conversationId");
  const tool = str(input, "tool", 80);
  if (tool) out.tool = tool;
  const status = oneOf(input, "status", ["ok", "error"] as const);
  if (status) out.status = status;
  return out;
}

export function readIssueQuery(raw: unknown): { conversationId?: string; days: number } {
  const input = callInput(raw);
  return { days: int(input, "days", 1, 365, 30), ...(input.conversationId ? { conversationId: id(input, "conversationId") } : {}) };
}

// ---------- results ----------

/** Most characters one tool result may give the model. */
export const MAX_TOOL_RESULT = 8000;

/** Shortens long strings to `max` characters. */
export const clip = (s: string | null | undefined, max: number): string | null => {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * A tool's result as JSON of at most `max` characters: the longest array in it is cut from the end
 * (repeatedly) and `truncated: true` set, so the model knows there was more. Never invalid JSON.
 */
export function capResult(value: unknown, max = MAX_TOOL_RESULT): string {
  let json = JSON.stringify(value);
  if (json.length <= max) return json;
  const copy = JSON.parse(json) as unknown;
  const arrays: unknown[][] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      arrays.push(v);
      v.forEach(walk);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(copy);
  const root = copy && typeof copy === "object" && !Array.isArray(copy) ? (copy as Record<string, unknown>) : null;
  for (let guard = 0; guard < 10_000 && json.length > max; guard++) {
    const longest = arrays.filter((a) => a.length > 0).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!longest) break;
    longest.pop();
    if (root) root.truncated = true;
    json = JSON.stringify(copy);
  }
  if (json.length <= max) return json;
  return JSON.stringify({ truncated: true, text: json.slice(0, max - 40) });
}

/** Epoch ms → "2026-10-20T14:03Z" (short, readable, sortable). */
export const iso = (t: number | null | undefined): string | null => (typeof t === "number" && t > 0 ? new Date(t).toISOString().slice(0, 16) + "Z" : null);

// ---------- actions: the model proposes, the person confirms ----------

export const ACTION_TOOLS = ["propose_assign", "propose_status", "propose_tags", "propose_note", "propose_reply_draft", "propose_issue", "propose_knowledge"] as const;
export type ActionTool = (typeof ACTION_TOOLS)[number];
export const isActionTool = (name: string): name is ActionTool => (ACTION_TOOLS as readonly string[]).includes(name);
/** Only owners and admins may add knowledge (the route checks too). */
export const ADMIN_ACTIONS: readonly ActionTool[] = ["propose_knowledge"];

export const PROPOSAL_STATUSES = ["resolved", "open", "pending"] as const satisfies readonly ConversationStatus[];
export const MAX_NOTE = 4000;

export type Proposal =
  | { kind: "assign"; conversationId: string; /** A user id, or null to unassign. "me" is resolved by the Worker. */ assigneeId: string | null }
  | { kind: "status"; conversationId: string; status: (typeof PROPOSAL_STATUSES)[number] }
  | { kind: "tags"; conversationId: string; add: string[]; remove: string[] }
  | { kind: "note"; conversationId: string; body: string }
  | { kind: "reply_draft"; conversationId: string; body: string }
  | { kind: "issue"; conversationId: string }
  | { kind: "knowledge_website"; url: string; maxPages: number }
  | { kind: "knowledge_text"; title: string; body: string };

/** What the card names: the conversation's customer, the teammate. Filled in by the Worker. */
export interface ProposalLabels {
  conversation?: string;
  assignee?: string;
}

/** A proposal as the page shows and runs it. */
export interface ProposedAction {
  callId: string;
  tool: ActionTool;
  proposal: Proposal;
  labels: ProposalLabels;
  summary: string;
}

const TAG = /^[^\n]{1,40}$/;

/** A proposal tool's input → a Proposal (assignee "me" becomes `me`'s id). Throws AssistantInputError. */
export function readProposal(tool: ActionTool, raw: unknown, me: string): Proposal {
  const input = callInput(raw);
  switch (tool) {
    case "propose_assign": {
      const conversationId = id(input, "conversationId");
      const who = str(input, "assignee", 80, true)!;
      if (who === "nobody" || who === "unassigned") return { kind: "assign", conversationId, assigneeId: null };
      if (who === "me") return { kind: "assign", conversationId, assigneeId: me };
      if (!ID.test(who)) fail("assignee must be me, nobody or a teammate's id from list_teammates.");
      return { kind: "assign", conversationId, assigneeId: who };
    }
    case "propose_status":
      return { kind: "status", conversationId: id(input, "conversationId"), status: oneOf(input, "status", PROPOSAL_STATUSES) ?? fail("status is required (resolved, open or pending).") };
    case "propose_tags": {
      const conversationId = id(input, "conversationId");
      const add = list(input, "add", 10, 40);
      const remove = list(input, "remove", 10, 40);
      if (!add.length && !remove.length) fail("Give tags to add or remove.");
      for (const t of [...add, ...remove]) if (!TAG.test(t)) fail("Tag names are 1 to 40 characters on one line.");
      return { kind: "tags", conversationId, add, remove };
    }
    case "propose_note":
      return { kind: "note", conversationId: id(input, "conversationId"), body: str(input, "body", MAX_NOTE, true)! };
    case "propose_reply_draft":
      return { kind: "reply_draft", conversationId: id(input, "conversationId"), body: str(input, "body", MAX_NOTE, true)! };
    case "propose_issue":
      return { kind: "issue", conversationId: id(input, "conversationId") };
    case "propose_knowledge": {
      const kind = oneOf(input, "kind", ["website", "text"] as const) ?? fail("kind is required (website or text).");
      if (kind === "website") {
        const url = str(input, "url", 2000, true)!;
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          return fail("url must be a full address, like https://docs.example.com.");
        }
        if (u.protocol !== "https:" && u.protocol !== "http:") fail("url must start with https://.");
        return { kind: "knowledge_website", url: u.toString(), maxPages: int(input, "maxPages", 1, 2000, 1) };
      }
      return { kind: "knowledge_text", title: str(input, "title", 200, true)!, body: str(input, "body", 20_000, true)! };
    }
  }
}

/** The conversation a proposal is about, if any (the Worker checks it's in the workspace). */
export const proposalConversation = (p: Proposal): string | null => ("conversationId" in p ? p.conversationId : null);

/** The card's one-line summary, in the desk's words. */
export function proposalSummary(p: Proposal, labels: ProposalLabels): string {
  const chat = labels.conversation ? `the chat with ${labels.conversation}` : "this chat";
  switch (p.kind) {
    case "assign":
      return p.assigneeId === null ? `Unassign ${chat}` : `Assign ${chat} to ${labels.assignee ?? "a teammate"}`;
    case "status":
      return p.status === "resolved" ? `Resolve ${chat}` : p.status === "open" ? `Reopen ${chat}` : `Mark ${chat} as pending`;
    case "tags": {
      const parts = [p.add.length ? `add ${p.add.map((t) => `“${t}”`).join(", ")}` : "", p.remove.length ? `remove ${p.remove.map((t) => `“${t}”`).join(", ")}` : ""].filter(Boolean);
      const text = parts.join(" and ");
      return `${text.charAt(0).toUpperCase()}${text.slice(1)} on ${chat}`;
    }
    case "note":
      return `Add an internal note to ${chat} (only your team sees it)`;
    case "reply_draft":
      return `Open ${chat} with this reply in the composer (you send it)`;
    case "issue":
      return `Draft an issue from ${chat}`;
    case "knowledge_website":
      return p.maxPages === 1 ? `Add the page ${p.url} to the knowledge` : `Add ${p.url} (up to ${p.maxPages} pages) to the knowledge`;
    case "knowledge_text":
      return `Add the document “${p.title}” to the knowledge`;
  }
}

/** A tag list after a proposal: the current tags minus `remove` plus `add` (case-insensitive, first spelling kept). */
export function nextTags(current: string[], add: string[], remove: string[]): string[] {
  const drop = new Set(remove.map((t) => t.toLowerCase()));
  const out = current.filter((t) => !drop.has(t.toLowerCase()));
  for (const t of add) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

export type ProposalOutcome = { status: "done" | "cancelled" | "failed"; detail?: string };

/** What the model is told after the person pressed Confirm or Cancel. */
export function outcomeLine(outcome: ProposalOutcome): string {
  if (outcome.status === "cancelled") return "The person pressed Cancel: nothing was changed. Don't propose it again unless they ask.";
  if (outcome.status === "failed") return `The person pressed Confirm but it failed: ${outcome.detail ?? "unknown error"}. Nothing was changed.`;
  return `The person pressed Confirm and it was done${outcome.detail ? `: ${outcome.detail}` : ""}.`;
}

// ---------- the chat the page keeps and sends back ----------

export interface AskStep {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done" | "error";
  /** D-129: what the model asked for, one short line (`text: export, limit: 10`). */
  input?: string;
  /** D-129: what came back, one short line ("10 of 23 conversations", or the error). */
  result?: string;
}

export type AskTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; steps?: AskStep[]; proposal?: ProposedAction; outcome?: ProposalOutcome };

export const MAX_TURNS = 40;
export const MAX_TURN_TEXT = 8000;

/** The page's chat as sent with a question: checked and trimmed (newest kept). */
export function readAskTurns(raw: unknown): AskTurn[] {
  if (!Array.isArray(raw)) fail("turns must be a list.");
  const out: AskTurn[] = [];
  for (const t of (raw as unknown[]).slice(-MAX_TURNS)) {
    if (!t || typeof t !== "object") continue;
    const turn = t as Record<string, unknown>;
    const text = typeof turn.text === "string" ? turn.text.slice(0, MAX_TURN_TEXT) : "";
    if (turn.role === "user") {
      if (text.trim()) out.push({ role: "user", text });
    } else if (turn.role === "assistant") {
      const a: AskTurn = { role: "assistant", text };
      const p = turn.proposal as ProposedAction | undefined;
      if (p && typeof p === "object" && typeof p.callId === "string" && /^[a-z0-9]{9}$/.test(p.callId) && isActionTool(String(p.tool)) && p.proposal && typeof p.proposal === "object") {
        a.proposal = { callId: p.callId, tool: p.tool, proposal: p.proposal, labels: {}, summary: typeof p.summary === "string" ? p.summary.slice(0, 300) : "" };
        const o = turn.outcome as ProposalOutcome | undefined;
        if (o && (o.status === "done" || o.status === "cancelled" || o.status === "failed")) a.outcome = { status: o.status, ...(typeof o.detail === "string" ? { detail: o.detail.slice(0, 300) } : {}) };
      }
      if (a.text.trim() || a.proposal) out.push(a);
    }
  }
  while (out[0]?.role === "assistant") out.shift();
  if (!out.length) fail("Ask something first.");
  return out;
}

/** A tool call id for a proposal: 9 lowercase letters and digits (Workers AI's Mistral needs exactly that). */
export function newCallId(random: () => number = Math.random): string {
  let s = "";
  while (s.length < 9) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)];
  return s;
}

// ---------- the stream ----------

export type AskEvent =
  | { type: "text"; text: string }
  | { type: "step"; step: AskStep }
  | { type: "proposal"; proposal: ProposedAction }
  /** The model proposed something that didn't pass the checks; nothing to confirm. */
  | { type: "rejected"; tool: string; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** What a step's line says while it runs ("Searching conversations…") and once done. */
export function stepLabel(tool: string, input: Record<string, unknown>, done: boolean): string {
  const q = (k: string) => (typeof input[k] === "string" && input[k] ? ` “${clip(input[k] as string, 40)}”` : "");
  const map: Record<string, [string, string]> = {
    search_conversations: [`Searching conversations${q("text")}`, `Searched conversations${q("text")}`],
    read_conversation: ["Reading a conversation", "Read a conversation"],
    debug_context: ["Reading its debug context", "Read its debug context"],
    report_metrics: ["Reading Reports", "Read Reports"],
    topics_and_handoffs: ["Reading topics and handoff reasons", "Read topics and handoff reasons"],
    struggle_spots: ["Looking at struggle spots", "Looked at struggle spots"],
    live_visitors: ["Checking who's on the site", "Checked who's on the site"],
    find_contacts: [`Looking up contacts${q("query")}`, `Looked up contacts${q("query")}`],
    read_contact: ["Reading a contact", "Read a contact"],
    read_company: ["Reading a company", "Read a company"],
    list_knowledge: ["Listing knowledge sources", "Listed knowledge sources"],
    search_knowledge: [`Searching the knowledge${q("query")}`, `Searched the knowledge${q("query")}`],
    list_agent_files: ["Listing the agent's files", "Listed the agent's files"],
    read_agent_file: [`Reading ${typeof input.path === "string" ? clip(input.path, 40) : "an agent file"}`, `Read ${typeof input.path === "string" ? clip(input.path, 40) : "an agent file"}`],
    ai_audit: ["Reading the AI's action log", "Read the AI's action log"],
    list_issues: ["Listing filed issues", "Listed filed issues"],
    list_teammates: ["Listing teammates", "Listed teammates"],
  };
  const pair = map[tool];
  if (!pair) return done ? "Done" : "Working";
  return done ? pair[1] : `${pair[0]}…`;
}

/** D-129: a step's input as one short line for its open row: `text: export, limit: 10`. */
export function stepInput(input: Record<string, unknown>): string | undefined {
  const parts = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length ? clip(parts.join(", "), 160)! : undefined;
}

const RESULT_NOUNS: Record<string, [string, string]> = {
  hits: ["match", "matches"],
  conversations: ["conversation", "conversations"],
  messages: ["message", "messages"],
  people: ["person", "people"],
  companies: ["company", "companies"],
  teammates: ["teammate", "teammates"],
  visitors: ["visitor", "visitors"],
  sources: ["source", "sources"],
  files: ["file", "files"],
  issues: ["issue", "issues"],
  topics: ["topic", "topics"],
  actions: ["action", "actions"],
  spots: ["spot", "spots"],
};

/** D-129: a tool's result as one short line ("10 of 23 conversations", "3 matches", the error), or nothing when it has no list. */
export function stepResult(output: unknown): string | undefined {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.error === "string") return clip(o.error, 120)!;
  // A known list first (a conversation's messages, not its tags), else the first list there is.
  const lists = Object.entries(o).filter(([, v]) => Array.isArray(v));
  const entry = lists.find(([k]) => k in RESULT_NOUNS) ?? lists[0];
  if (!entry) return undefined;
  const [key, list] = entry as [string, unknown[]];
  const n = list.length;
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const [one, many] = RESULT_NOUNS[key] ?? [words.replace(/s$/, ""), words];
  const total = typeof o.total === "number" && o.total > n ? o.total : null;
  // One record read (a conversation, a contact): whose it is first.
  const who = typeof o.customer === "string" ? `${clip(o.customer, 40)} · ` : typeof o.name === "string" ? `${clip(o.name, 40)} · ` : "";
  return total !== null ? `${n} of ${total} ${many}` : `${who}${n} ${n === 1 ? one : many}${o.truncated ? "+" : ""}`;
}

/** D-129: the line a card shows once it's settled ("Tagged · export-issue", "Cancelled"). */
export function outcomeTitle(p: Proposal, labels: ProposalLabels, outcome: ProposalOutcome): string {
  if (outcome.status === "cancelled") return outcome.detail === "not confirmed" ? "Not confirmed" : "Cancelled";
  if (outcome.status === "failed") return `Didn't work${outcome.detail ? `: ${outcome.detail}` : ""}`;
  switch (p.kind) {
    case "assign":
      return p.assigneeId === null ? "Unassigned" : `Assigned · ${labels.assignee ?? "a teammate"}`;
    case "status":
      return p.status === "resolved" ? "Resolved" : p.status === "open" ? "Reopened" : "Marked pending";
    case "tags":
      return [p.add.length ? `Tagged · ${p.add.join(", ")}` : "", p.remove.length ? `Untagged · ${p.remove.join(", ")}` : ""].filter(Boolean).join(" · ");
    case "note":
      return "Note added";
    case "reply_draft":
      return "Draft opened in the chat";
    case "issue":
      return "Issue dialog opened";
    case "knowledge_website":
      return "Adding to knowledge";
    case "knowledge_text":
      return `Added · ${p.title}`;
  }
}

// ---------- rate limit ----------

export interface RateLimit {
  windowMs: number;
  max: number;
}
/** Questions (and brief refreshes) per member: a burst limit and a daily one. */
export const ASK_LIMITS: RateLimit[] = [
  { windowMs: 10 * 60_000, max: 30 },
  { windowMs: 24 * 60 * 60_000, max: 300 },
];

/** Whether one more request fits, given the earlier ones' times; the times to keep either way. */
export function takeTurn(times: number[], now: number, limits: RateLimit[] = ASK_LIMITS): { ok: boolean; times: number[]; retryAfterMs: number } {
  const longest = Math.max(...limits.map((l) => l.windowMs));
  const kept = times.filter((t) => t > now - longest && t <= now).sort((a, b) => a - b);
  let retryAfterMs = 0;
  for (const l of limits) {
    const inWindow = kept.filter((t) => t > now - l.windowMs);
    if (inWindow.length >= l.max) retryAfterMs = Math.max(retryAfterMs, inWindow[inWindow.length - l.max]! + l.windowMs - now);
  }
  if (retryAfterMs > 0) return { ok: false, times: kept, retryAfterMs };
  return { ok: true, times: [...kept, now], retryAfterMs: 0 };
}

// ---------- desk links in answers ----------

/** The Agent page that shows an agent file. */
export function agentFileLink(path: string): string {
  if (path === "instructions.md") return "/agent";
  const m = /^(tasks|actions|widgets)\/([\w-]+)\.(?:md|yaml|widget)$/.exec(path);
  if (m) return `/agent/${m[1]}/${m[2]}`;
  if (path.startsWith("tests/")) return "/agent/tests";
  if (path === "website-actions.yaml") return "/agent/actions";
  if (path === "desk.yaml") return "/agent/desk.yaml";
  return "/agent";
}

/** Paths an answer may link to (Markdown `[label](/inbox/cv_1)`); anything else stays text. */
const DESK_LINK = /^\/(?:home|inbox|visitors|contacts|dashboard|knowledge|agent|playground|channels|connect|settings)(?:[/?#][\w\-./?=&%#:~+]*)?$/;
export const isDeskLink = (href: string): boolean => DESK_LINK.test(href) && !href.includes("//");
