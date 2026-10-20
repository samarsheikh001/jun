// I-19 (D-127): Home's desk assistant, the pure parts shared by the Worker (worker/ai/desk-assistant.ts)
// and the Home page: the tool inputs and their checks, the size cap on what a tool returns, the
// action proposals (the model proposes, the person confirms, the browser calls the desk's own routes),
// the chat history the page sends back each turn, the stream's events and the per-member rate limit.

import { NOTIFICATION_PREF_KEYS, type NotificationPrefs } from "./notifications.ts";
import type { ConversationStatus } from "./protocol.ts";
import { isSourceId, knowledgeLink } from "./knowledge-link.ts";

export { knowledgeLink };

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

// D-133: one propose_* tool per area of the desk (a chat, the agent's files, the desk's settings,
// knowledge, the inbox's setup, the team, …); each call is one card and one change. The Worker checks
// a proposal against the desk's current state before the card is shown (prepareProposal), and the
// browser runs it through the desk's own route on Confirm (web/home/actions.ts).
export const ACTION_TOOLS = [
  "propose_assign",
  "propose_status",
  "propose_handling",
  "propose_tags",
  "propose_note",
  "propose_reply_draft",
  "propose_issue",
  "propose_invite_visitor",
  "propose_contact",
  "propose_agent_file",
  "propose_desk_settings",
  "propose_ai_settings",
  "propose_knowledge",
  "propose_saved_reply",
  "propose_tag",
  "propose_topic",
  "propose_team",
  "propose_notifications",
  "propose_workspace",
  "propose_email",
  "propose_identity_off",
  "propose_bulk",
] as const;
export type ActionTool = (typeof ACTION_TOOLS)[number];
export const isActionTool = (name: string): name is ActionTool => (ACTION_TOOLS as readonly string[]).includes(name);
/** Only owners and admins may do these (the routes check too); agents aren't offered them. */
export const ADMIN_ACTIONS: readonly ActionTool[] = [
  "propose_knowledge",
  "propose_agent_file",
  "propose_desk_settings",
  "propose_ai_settings",
  "propose_tag",
  "propose_topic",
  "propose_team",
  "propose_workspace",
  "propose_email",
  "propose_identity_off",
];

export const PROPOSAL_STATUSES = ["resolved", "open", "pending"] as const satisfies readonly ConversationStatus[];
export const MAX_NOTE = 4000;
/** D-134: most chats one bulk card changes. */
export const MAX_BULK = 50;
export const BULK_OPS = ["status", "assign", "tags", "handling"] as const;
export type BulkOp = (typeof BULK_OPS)[number];

/** One chat on a bulk card: who it's with and the field before → after (readable text, from the Worker). */
export interface BulkItem {
  conversationId: string;
  customer: string;
  before: string;
  after: string;
}
export const MAX_AGENT_FILE = 60_000;

/** One setting a card shows changing: its label, the value now and after (already readable text). */
export interface SettingChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

/** How the model asks to change one agent file; the Worker turns it into the file's text before and after. */
export interface AgentFileEdit {
  action: "write" | "edit" | "append" | "delete";
  text?: string;
  edits?: { find: string; replace: string }[];
}

/** The agent's files the assistant may write (desk.yaml goes through the settings proposals). */
export const AGENT_FILE_PATH =
  /^(?:instructions\.md|website-actions\.yaml|tasks\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|actions\/[a-z][a-z0-9_]*\.yaml|widgets\/[a-z][a-z0-9_-]*\.widget|tests\/[a-zA-Z0-9_-]+\.yaml)$/;

/** The widget inbox's settings the assistant may change (PATCH /inbox; desk.yaml follows). */
export const DESK_SETTING_LABELS = {
  greeting: "Greeting",
  displayName: "Name shown",
  replyTime: "Reply time",
  placeholder: "Message box hint",
  suggestions: "Suggested questions",
  color: "Colour",
  position: "Position",
  mode: "Widget mode",
  greetingCard: "Greeting card",
  theme: "Widget theme",
  radius: "Corner rounding",
  buttonStyle: "Button shows",
  islandSurface: "Island surface",
  sound: "Sounds",
  proactive: "Offer help when something breaks",
  csat: "Ask for a rating",
  pageControl: "Let the AI use your website",
  pageControlConfirm: "Before the AI clicks, types or chooses",
  hours: "Business hours",
  assignment: "Assignment",
  openers: "Page openers",
  allowedDomains: "Allowed websites",
} as const;
export type DeskSettingKey = keyof typeof DESK_SETTING_LABELS;
export const DESK_SETTING_KEYS = Object.keys(DESK_SETTING_LABELS) as DeskSettingKey[];

export const AI_SETTING_LABELS = { enabled: "AI answers chats", provider: "Provider", model: "Model", monthlyReplyCap: "Monthly reply cap" } as const;
export const EMAIL_SETTING_LABELS = { enabled: "Email replies", from: "From address", fromName: "Sender name", replyDomain: "Reply domain" } as const;
export const NOTIFICATION_LABELS: Record<keyof NotificationPrefs, string> = {
  needsPerson: "A chat needs a person",
  assigned: "A chat is assigned to you",
  visitorReply: "A customer replies",
  mention: "Someone mentions you",
  sound: "Sound",
};
export const KNOWLEDGE_EDIT_LABELS = { title: "Title", body: "Text", maxPages: "Pages to read", exclude: "Skipped pages" } as const;

export type Proposal =
  | { kind: "assign"; conversationId: string; /** A user id, or null to unassign. "me" is resolved by the Worker. */ assigneeId: string | null }
  | { kind: "status"; conversationId: string; status: (typeof PROPOSAL_STATUSES)[number] }
  | { kind: "handling"; conversationId: string; handling: "ai" | "human" }
  | { kind: "tags"; conversationId: string; add: string[]; remove: string[] }
  | { kind: "note"; conversationId: string; body: string }
  | { kind: "reply_draft"; conversationId: string; body: string }
  | { kind: "issue"; conversationId: string }
  | { kind: "invite_visitor"; sessionId: string; body: string }
  | { kind: "contact"; contactId: string; name?: string; email?: string; changes: SettingChange[] }
  /** The file's whole text before (null: new) and after (null: deleted), worked out by the Worker; `edit` only until then. */
  | { kind: "agent_file"; path: string; op: "create" | "edit" | "delete"; before: string | null; after: string | null; edit?: AgentFileEdit }
  | { kind: "desk_settings"; patch: Record<string, unknown>; changes: SettingChange[] }
  | { kind: "ai_settings"; patch: { enabled?: boolean; provider?: "workers-ai" | "openai"; model?: string | null; monthlyReplyCap?: number }; changes: SettingChange[] }
  | { kind: "knowledge_website"; url: string; maxPages: number }
  | { kind: "knowledge_text"; title: string; body: string }
  | { kind: "knowledge_resync"; sourceId: string }
  | { kind: "knowledge_edit"; sourceId: string; patch: { title?: string; body?: string; maxPages?: number; exclude?: string[] }; changes: SettingChange[] }
  | { kind: "knowledge_remove_page"; sourceId: string; documentId: string }
  | { kind: "knowledge_remove"; sourceId: string }
  | { kind: "saved_reply_create"; title: string; body: string }
  /** Both fields as they'll be saved (the route takes both); the Worker fills the one not asked for. */
  | { kind: "saved_reply_edit"; replyId: string; title: string; body: string; changes: SettingChange[] }
  | { kind: "saved_reply_delete"; replyId: string }
  | { kind: "tag_rename"; tagId: string; name: string }
  | { kind: "tag_delete"; tagId: string }
  | { kind: "topic_rename"; topicId: string; name: string }
  | { kind: "topic_merge"; topicId: string; into: string }
  | { kind: "topic_delete"; topicId: string }
  | { kind: "topic_label" }
  | { kind: "team_invite"; role: "admin" | "agent" }
  | { kind: "team_revoke_invite"; inviteId: string }
  | { kind: "team_role"; userId: string; role: "admin" | "agent" }
  | { kind: "team_remove"; userId: string }
  | { kind: "notifications"; patch: Partial<NotificationPrefs>; changes: SettingChange[] }
  | { kind: "workspace_name"; name: string }
  | { kind: "email_settings"; patch: { enabled?: boolean; from?: string; fromName?: string; replyDomain?: string }; changes: SettingChange[] }
  | { kind: "email_test"; to: string | null }
  | { kind: "identity_off" }
  /** D-134: one change on several chats; `items` are filled by the Worker (chats it wouldn't change are left out). */
  | {
      kind: "bulk";
      op: BulkOp;
      conversationIds: string[];
      status?: (typeof PROPOSAL_STATUSES)[number];
      assigneeId?: string | null;
      add?: string[];
      remove?: string[];
      handling?: "ai" | "human";
      items: BulkItem[];
    };

export type ProposalKind = Proposal["kind"];
export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  "assign", "status", "handling", "tags", "note", "reply_draft", "issue", "invite_visitor", "contact", "agent_file", "desk_settings", "ai_settings",
  "knowledge_website", "knowledge_text", "knowledge_resync", "knowledge_edit", "knowledge_remove_page", "knowledge_remove",
  "saved_reply_create", "saved_reply_edit", "saved_reply_delete", "tag_rename", "tag_delete", "topic_rename", "topic_merge", "topic_delete", "topic_label",
  "team_invite", "team_revoke_invite", "team_role", "team_remove", "notifications", "workspace_name", "email_settings", "email_test", "identity_off", "bulk",
];

/** What the card names, filled in by the Worker: the conversation's customer, the teammate, the thing changed. */
export interface ProposalLabels {
  conversation?: string;
  assignee?: string;
  /** The saved reply, tag, topic, knowledge source, teammate, visitor or contact by name. */
  target?: string;
  /** A second name: the topic merged into, the knowledge page, a teammate's role now. */
  detail?: string;
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
const SESSION = /^[\w-]{3,100}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Text kept as written (file contents, find/replace), only checked for type and size. */
function raw(input: Input, key: string, max: number, required = false): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) fail(`${key} is required.`);
    return undefined;
  }
  if (typeof v !== "string") return fail(`${key} must be text.`);
  if (v.length > max) fail(`${key} is at most ${max} characters.`);
  return v;
}

function bool(input: Input, key: string): boolean | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return fail(`${key} must be true or false.`);
}

function object(input: Input, key: string): Input {
  const v = callInput(input[key]);
  if (!Object.keys(v).length) fail(`${key} must be an object with at least one setting.`);
  return v;
}

const op = <T extends string>(input: Input, values: readonly T[]): T => oneOf(input, "op", values) ?? fail(`op is required (${values.join(", ")}).`);
const someOf = <T extends Record<string, unknown>>(patch: T, what: string): T => (Object.keys(patch).length ? patch : fail(`Say which ${what} to change.`));
const role = (input: Input): "admin" | "agent" => oneOf(input, "role", ["admin", "agent"] as const) ?? fail("role is required (admin or agent).");

/** A proposal tool's input → a Proposal (assignee "me" becomes `me`'s id). Throws AssistantInputError. */
export function readProposal(tool: ActionTool, rawInput: unknown, me: string): Proposal {
  const input = callInput(rawInput);
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
    case "propose_handling":
      return { kind: "handling", conversationId: id(input, "conversationId"), handling: oneOf(input, "handling", ["ai", "human"] as const) ?? fail("handling is required (ai or human).") };
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
    case "propose_invite_visitor": {
      const sessionId = str(input, "sessionId", 100, true)!;
      if (!SESSION.test(sessionId)) fail("sessionId must be a visitor's sessionId from live_visitors.");
      const body = str(input, "body", 1000, true)!;
      return { kind: "invite_visitor", sessionId, body };
    }
    case "propose_contact": {
      const contactId = id(input, "contactId");
      const name = str(input, "name", 200);
      const email = str(input, "email", 320);
      if (email && !EMAIL.test(email)) fail("email doesn't look like an email address.");
      if (!name && !email) fail("Give a name or an email to set.");
      return { kind: "contact", contactId, ...(name ? { name } : {}), ...(email ? { email } : {}), changes: [] };
    }
    case "propose_agent_file": {
      const path = str(input, "path", 200, true)!;
      if (path === "desk.yaml") fail("desk.yaml is the desk's settings: use propose_desk_settings or propose_ai_settings.");
      if (!AGENT_FILE_PATH.test(path)) fail("path must be instructions.md, website-actions.yaml, tasks/<name>.md, actions/<name>.yaml, widgets/<name>.widget or tests/<name>.yaml (lowercase names).");
      const action = oneOf(input, "action", ["write", "edit", "append", "delete"] as const) ?? fail("action is required (write, edit, append or delete).");
      const edit: AgentFileEdit = { action };
      if (action === "delete") {
        if (path === "instructions.md") fail("instructions.md can't be deleted (the agent needs it).");
      } else if (action === "edit") {
        const v = input.edits;
        if (!Array.isArray(v) || !v.length) fail("edits is required: a list of { find, replace }.");
        if ((v as unknown[]).length > 20) fail("At most 20 edits at once.");
        edit.edits = (v as unknown[]).map((e) => {
          const one = callInput(e);
          return { find: raw(one, "find", 5000, true)!, replace: raw(one, "replace", 20_000) ?? "" };
        });
      } else edit.text = raw(input, "text", MAX_AGENT_FILE, true)!;
      return { kind: "agent_file", path, op: action === "delete" ? "delete" : "edit", before: null, after: null, edit };
    }
    case "propose_desk_settings": {
      const changes = object(input, "changes");
      for (const key of Object.keys(changes)) if (!(DESK_SETTING_KEYS as string[]).includes(key)) fail(`${key} isn't a setting here. These are: ${DESK_SETTING_KEYS.join(", ")}.`);
      return { kind: "desk_settings", patch: changes, changes: [] };
    }
    case "propose_ai_settings": {
      const provider = str(input, "provider", 40);
      if (provider === "chatgpt") fail("Switching to ChatGPT needs a sign-in in Settings → AI; you can't do it.");
      if (provider !== undefined && provider !== "workers-ai" && provider !== "openai") fail("provider must be workers-ai or openai.");
      const patch: Extract<Proposal, { kind: "ai_settings" }>["patch"] = {};
      const enabled = bool(input, "enabled");
      if (enabled !== undefined) patch.enabled = enabled;
      if (provider) patch.provider = provider as "workers-ai" | "openai";
      const model = str(input, "model", 100);
      if (model) patch.model = model === "default" ? null : model;
      if (input.monthlyReplyCap !== undefined && input.monthlyReplyCap !== null && input.monthlyReplyCap !== "") {
        const cap = Number(input.monthlyReplyCap);
        if (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000) fail("monthlyReplyCap is a whole number from 0 (no limit) to 1000000.");
        patch.monthlyReplyCap = cap;
      }
      return { kind: "ai_settings", patch: someOf(patch, "AI setting"), changes: [] };
    }
    case "propose_knowledge": {
      const kind = oneOf(input, "kind", ["website", "text", "resync", "edit", "remove_page", "remove"] as const) ?? fail("kind is required (website, text, resync, edit, remove_page or remove).");
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
      if (kind === "text") return { kind: "knowledge_text", title: str(input, "title", 200, true)!, body: str(input, "body", 20_000, true)! };
      const sourceId = id(input, "sourceId");
      if (kind === "resync") return { kind: "knowledge_resync", sourceId };
      if (kind === "remove") return { kind: "knowledge_remove", sourceId };
      if (kind === "remove_page") return { kind: "knowledge_remove_page", sourceId, documentId: id(input, "documentId") };
      const patch: Extract<Proposal, { kind: "knowledge_edit" }>["patch"] = {};
      const title = str(input, "title", 200);
      if (title) patch.title = title;
      const body = str(input, "body", 20_000);
      if (body) patch.body = body;
      if (input.maxPages !== undefined && input.maxPages !== null && input.maxPages !== "") {
        const n = Number(input.maxPages);
        if (!Number.isInteger(n) || n < 1 || n > 2000) fail("maxPages is a whole number from 1 to 2000.");
        patch.maxPages = n;
      }
      if (input.exclude !== undefined) {
        const exclude = list(input, "exclude", 500, 300);
        const bad = exclude.filter((s) => !s.startsWith("/") && !/^https?:\/\//.test(s));
        if (bad.length) fail(`exclude takes paths like /blog/ or full URLs: ${bad.slice(0, 3).join(", ")}`);
        patch.exclude = exclude;
      }
      return { kind: "knowledge_edit", sourceId, patch: someOf(patch, "field (title, body, maxPages or exclude)"), changes: [] };
    }
    case "propose_saved_reply": {
      const what = op(input, ["create", "edit", "delete"] as const);
      if (what === "create") return { kind: "saved_reply_create", title: str(input, "title", 80, true)!, body: str(input, "body", 5000, true)! };
      const replyId = id(input, "id");
      if (what === "delete") return { kind: "saved_reply_delete", replyId };
      const title = str(input, "title", 80) ?? "";
      const body = str(input, "body", 5000) ?? "";
      if (!title && !body) fail("Give a new title or body.");
      return { kind: "saved_reply_edit", replyId, title, body, changes: [] };
    }
    case "propose_tag": {
      const what = op(input, ["rename", "delete"] as const);
      const tagId = id(input, "id");
      if (what === "delete") return { kind: "tag_delete", tagId };
      const name = str(input, "name", 40, true)!.replace(/^#/, "");
      if (!TAG.test(name)) fail("Tag names are 1 to 40 characters on one line.");
      return { kind: "tag_rename", tagId, name };
    }
    case "propose_topic": {
      const what = op(input, ["rename", "merge", "delete", "label"] as const);
      if (what === "label") return { kind: "topic_label" };
      const topicId = id(input, "id");
      if (what === "delete") return { kind: "topic_delete", topicId };
      if (what === "merge") {
        const into = id(input, "into");
        if (into === topicId) fail("A topic can't be merged into itself.");
        return { kind: "topic_merge", topicId, into };
      }
      const name = str(input, "name", 40, true)!;
      if (!TAG.test(name)) fail("Topic names are 1 to 40 characters on one line.");
      return { kind: "topic_rename", topicId, name };
    }
    case "propose_team": {
      const what = op(input, ["invite", "revoke_invite", "role", "remove"] as const);
      if (what === "invite") return { kind: "team_invite", role: role(input) };
      if (what === "revoke_invite") return { kind: "team_revoke_invite", inviteId: id(input, "inviteId") };
      const userId = id(input, "userId");
      if (userId === me) fail("You can't change your own role or remove yourself here.");
      return what === "role" ? { kind: "team_role", userId, role: role(input) } : { kind: "team_remove", userId };
    }
    case "propose_notifications": {
      const patch: Partial<NotificationPrefs> = {};
      for (const key of NOTIFICATION_PREF_KEYS) {
        const v = bool(input, key);
        if (v !== undefined) patch[key] = v;
      }
      return { kind: "notifications", patch: someOf(patch, "notification"), changes: [] };
    }
    case "propose_workspace":
      return { kind: "workspace_name", name: str(input, "name", 100, true)! };
    case "propose_email": {
      const what = op(input, ["settings", "test"] as const);
      if (what === "test") {
        const to = str(input, "to", 320);
        if (to && !EMAIL.test(to)) fail("to doesn't look like an email address.");
        return { kind: "email_test", to: to ?? null };
      }
      const patch: Extract<Proposal, { kind: "email_settings" }>["patch"] = {};
      const enabled = bool(input, "enabled");
      if (enabled !== undefined) patch.enabled = enabled;
      for (const key of ["from", "fromName", "replyDomain"] as const) {
        const v = input[key];
        if (typeof v === "string") patch[key] = v.trim().slice(0, 320);
      }
      return { kind: "email_settings", patch: someOf(patch, "email setting"), changes: [] };
    }
    case "propose_identity_off":
      return { kind: "identity_off" };
    case "propose_bulk": {
      const what = op(input, BULK_OPS);
      const v = input.conversationIds;
      const given = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : fail("conversationIds must be a list of conversation ids.");
      const ids: string[] = [];
      for (const x of given as unknown[]) {
        const one = typeof x === "string" ? x.trim() : "";
        if (!ID.test(one)) fail("conversationIds must be conversation ids from a tool result (like cv_…).");
        if (!ids.includes(one)) ids.push(one);
      }
      if (ids.length < 2) fail("Give at least 2 conversations (for one, use the single proposal).");
      if (ids.length > MAX_BULK) fail(`At most ${MAX_BULK} conversations at once.`);
      const base = { kind: "bulk" as const, op: what, conversationIds: ids, items: [] };
      if (what === "status") return { ...base, status: oneOf(input, "status", PROPOSAL_STATUSES) ?? fail("status is required (resolved, open or pending).") };
      if (what === "handling") return { ...base, handling: oneOf(input, "handling", ["ai", "human"] as const) ?? fail("handling is required (ai or human).") };
      if (what === "assign") {
        const who = str(input, "assignee", 80, true)!;
        if (who === "nobody" || who === "unassigned") return { ...base, assigneeId: null };
        if (who === "me") return { ...base, assigneeId: me };
        if (!ID.test(who)) fail("assignee must be me, nobody or a teammate's id from list_teammates.");
        return { ...base, assigneeId: who };
      }
      const add = list(input, "add", 10, 40);
      const remove = list(input, "remove", 10, 40);
      if (!add.length && !remove.length) fail("Give tags to add or remove.");
      for (const t of [...add, ...remove]) if (!TAG.test(t)) fail("Tag names are 1 to 40 characters on one line.");
      return { ...base, add, remove };
    }
  }
}

type Bulk = Extract<Proposal, { kind: "bulk" }>;
const BULK_FIELDS: Record<BulkOp, string> = { status: "Status", assign: "Assignee", tags: "Tags", handling: "Handled by" };
export const bulkField = (op: BulkOp): string => BULK_FIELDS[op];

/** A bulk card's verb for `n` chats: "Resolve 6 chats", "Assign 3 chats to Hana". */
export function bulkVerb(p: Bulk, n: number, assignee?: string): string {
  const chats = `${n} chat${n === 1 ? "" : "s"}`;
  switch (p.op) {
    case "status":
      return p.status === "resolved" ? `Resolve ${chats}` : p.status === "open" ? `Reopen ${chats}` : `Mark ${chats} pending`;
    case "assign":
      return p.assigneeId === null ? `Unassign ${chats}` : `Assign ${chats}${assignee ? ` to ${assignee}` : ""}`;
    case "handling":
      return p.handling === "ai" ? `Hand ${chats} to the AI` : `Take over ${chats}`;
    case "tags":
      return `Update tags on ${chats}`;
  }
}

/** One chat of a bulk card as its single proposal, so Confirm runs it through the same route. */
export function bulkSingle(p: Bulk, conversationId: string): Proposal {
  switch (p.op) {
    case "status":
      return { kind: "status", conversationId, status: p.status! };
    case "assign":
      return { kind: "assign", conversationId, assigneeId: p.assigneeId ?? null };
    case "handling":
      return { kind: "handling", conversationId, handling: p.handling! };
    case "tags":
      return { kind: "tags", conversationId, add: p.add ?? [], remove: p.remove ?? [] };
  }
}

/** A bulk row after it ran (or was left out). */
export interface BulkResult {
  conversationId: string;
  status: "done" | "failed" | "skipped";
  error?: string;
}

/** What the model hears about a bulk run: "5 done, 1 failed: Hana Kim (not found), 2 left out by the person". */
export function bulkOutcome(items: BulkItem[], results: BulkResult[]): ProposalOutcome {
  const name = (id: string) => items.find((i) => i.conversationId === id)?.customer ?? id;
  const done = results.filter((r) => r.status === "done");
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped");
  const parts = [`${done.length} done`];
  if (failed.length) parts.push(`${failed.length} failed: ${failed.slice(0, 5).map((r) => `${name(r.conversationId)} (${clip(r.error ?? "error", 80)})`).join("; ")}`);
  if (skipped.length) parts.push(`${skipped.length} left out by the person`);
  return { status: done.length ? "done" : skipped.length === results.length ? "cancelled" : "failed", detail: parts.join(", "), results };
}

/** Runs `run` over `items`, at most `limit` at a time, in order; resolves when all are done. */
export async function runPool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The conversation a proposal is about, if any (the Worker checks it's in the workspace). */
export const proposalConversation = (p: Proposal): string | null => ("conversationId" in p ? p.conversationId : null);

/**
 * An agent file's text after an edit, or null when it's deleted. `edit` find texts must each be in
 * the file exactly once. Throws AssistantInputError with what to fix.
 */
export function applyAgentFileEdit(path: string, current: string | null, edit: AgentFileEdit): string | null {
  const ending = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);
  let next: string | null;
  if (edit.action === "delete") {
    if (current === null) fail(`There's no ${path} to delete.`);
    next = null;
  } else if (edit.action === "write") next = ending(edit.text ?? "");
  else if (edit.action === "append") next = current === null ? ending(edit.text ?? "") : ending(`${current.replace(/\n+$/, "")}\n${edit.text ?? ""}`);
  else {
    if (current === null) fail(`There's no ${path} yet: use action write to create it.`);
    let text = current!;
    for (const e of edit.edits ?? []) {
      const at = text.indexOf(e.find);
      if (at < 0) fail(`This text isn't in ${path}: “${clip(e.find, 80)}”. Read the file again and copy the text exactly.`);
      if (text.indexOf(e.find, at + 1) >= 0) fail(`This text is in ${path} more than once: “${clip(e.find, 80)}”. Include more of the lines around it.`);
      text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
    }
    next = text;
  }
  if (next === current) fail(`That doesn't change ${path}.`);
  return next;
}

/** A setting's value as the card shows it. */
export function settingText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "default";
  if (value === true) return "on";
  if (value === false) return "off";
  if (typeof value === "string") return clip(value, 200)!;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.length ? clip(value.join(", "), 200)! : "none";
  return clip(JSON.stringify(value), 200)!;
}

/** The settings that change, label and values before → after; settings left as they are are dropped. */
export function settingChanges(labels: Record<string, string>, before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): SettingChange[] {
  return keys
    .map((key) => ({ key, label: labels[key] ?? key, before: settingText(before[key]), after: settingText(after[key]) }))
    .filter((c) => c.before !== c.after);
}

/** The card's one-line summary, in the desk's words. */
export function proposalSummary(p: Proposal, labels: ProposalLabels): string {
  const chat = labels.conversation ? `the chat with ${labels.conversation}` : "this chat";
  const target = labels.target ? `“${labels.target}”` : "it";
  const list = (changes: SettingChange[]) => changes.map((c) => c.label.toLowerCase()).join(", ");
  switch (p.kind) {
    case "assign":
      return p.assigneeId === null ? `Unassign ${chat}` : `Assign ${chat} to ${labels.assignee ?? "a teammate"}`;
    case "status":
      return p.status === "resolved" ? `Resolve ${chat}` : p.status === "open" ? `Reopen ${chat}` : `Mark ${chat} as pending`;
    case "handling":
      return p.handling === "ai" ? `Hand ${chat} back to the AI (it answers the customer's next message)` : `Take ${chat} over from the AI (the team answers it)`;
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
    case "invite_visitor":
      return `Send ${labels.target ?? "this visitor"} a chat invite on the page they're on`;
    case "contact":
      return `Change ${list(p.changes) || "the details"} of ${labels.target ?? "this contact"}`;
    case "agent_file":
      return p.op === "delete" ? `Delete ${p.path} from the support agent` : p.op === "create" ? `Add ${p.path} to the support agent` : `Change ${p.path} in the support agent`;
    case "desk_settings":
      return `Change the chat widget's ${list(p.changes)}`;
    case "ai_settings":
      return `Change the AI's ${list(p.changes)}`;
    case "knowledge_website":
      return p.maxPages === 1 ? `Add the page ${p.url} to the knowledge` : `Add ${p.url} (up to ${p.maxPages} pages) to the knowledge`;
    case "knowledge_text":
      return `Add the document “${p.title}” to the knowledge`;
    case "knowledge_resync":
      return `Read ${target} again so the knowledge is up to date`;
    case "knowledge_edit":
      return `Change the ${list(p.changes)} of ${target} in the knowledge`;
    case "knowledge_remove_page":
      return `Remove the page ${labels.detail ?? ""} from ${target} in the knowledge`.replace(/\s+/g, " ");
    case "knowledge_remove":
      return `Remove ${target} from the knowledge`;
    case "saved_reply_create":
      return `Add the saved reply “${p.title}” for the team`;
    case "saved_reply_edit":
      return `Change the ${list(p.changes)} of the saved reply ${target}`;
    case "saved_reply_delete":
      return `Delete the saved reply ${target}`;
    case "tag_rename":
      return `Rename the tag ${target} to “${p.name}” on every chat`;
    case "tag_delete":
      return `Delete the tag ${target} from every chat${labels.detail ? ` (${labels.detail})` : ""}`;
    case "topic_rename":
      return `Rename the topic ${target} to “${p.name}”`;
    case "topic_merge":
      return `Merge the topic ${target} into “${labels.detail ?? "the other topic"}”: its chats move and ${target} goes`;
    case "topic_delete":
      return `Delete the topic ${target} (its chats get labelled again later)`;
    case "topic_label":
      return "Label the chats that have no topic yet, now";
    case "team_invite":
      return `Make an invite link for a new ${p.role} (valid for a few days, for one person)`;
    case "team_revoke_invite":
      return "Revoke an invite link that hasn't been used";
    case "team_role":
      return `Make ${labels.target ?? "this teammate"} ${p.role === "admin" ? "an admin" : "an agent"}${labels.detail ? ` (now ${labels.detail})` : ""}`;
    case "team_remove":
      return `Remove ${labels.target ?? "this teammate"} from the workspace`;
    case "notifications":
      return `Change your notifications: ${p.changes.map((c) => `${c.label.toLowerCase()} ${c.after}`).join(", ")}`;
    case "workspace_name":
      return `Rename the workspace to “${p.name}”`;
    case "email_settings":
      return `Change the email replies' ${list(p.changes)}`;
    case "email_test":
      return `Send a test email to ${p.to ?? "your own address"}`;
    case "identity_off":
      return "Turn identity verification off";
    case "bulk": {
      const n = p.items.length;
      if (p.op === "tags") {
        const parts = [p.add?.length ? `add ${p.add.map((t) => `“${t}”`).join(", ")}` : "", p.remove?.length ? `remove ${p.remove.map((t) => `“${t}”`).join(", ")}` : ""].filter(Boolean).join(" and ");
        return `${parts.charAt(0).toUpperCase()}${parts.slice(1)} on ${n} chats`;
      }
      return bulkVerb(p, n, labels.assignee);
    }
  }
}

/** A card that can't be undone or that reaches someone outside the team: red, a plain line, and no Enter to confirm. */
export function proposalRisk(p: Proposal): { tone: "destructive" | "external"; line: string } | null {
  switch (p.kind) {
    case "saved_reply_delete":
    case "tag_delete":
    case "topic_delete":
    case "knowledge_remove_page":
      return { tone: "destructive", line: "This can't be undone." };
    case "topic_merge":
      return { tone: "destructive", line: "This can't be undone: the chats move and the topic is deleted." };
    case "knowledge_remove":
      return { tone: "destructive", line: "This can't be undone: knowledge has no history to bring it back from." };
    case "team_remove":
      return { tone: "destructive", line: "This can't be undone: they lose access at once (and their account, if this was their only workspace)." };
    case "identity_off":
      return { tone: "destructive", line: "This can't be undone: the secret is deleted, signed-in customers become anonymous, and turning it on again makes a new secret." };
    case "invite_visitor":
      return { tone: "external", line: "The visitor sees this message on their screen." };
    case "email_test":
      return { tone: "external", line: "This sends a real email." };
    case "email_settings":
      return p.patch.enabled === true ? { tone: "external", line: "Customers who leave will get the team's replies by email." } : null;
    default:
      return null;
  }
}

/** The card's question and its Confirm button. */
export function proposalCard(p: Proposal): { title: string; confirm: string } {
  const c = (title: string, confirm: string) => ({ title, confirm });
  switch (p.kind) {
    case "assign": return c("Assign this chat?", "Assign");
    case "status": return c("Change this chat's status?", "Change status");
    case "handling": return p.handling === "ai" ? c("Hand this chat back to the AI?", "Hand to AI") : c("Take this chat over from the AI?", "Take over");
    case "tags": return c("Change this chat's tags?", "Update tags");
    case "note": return c("Add an internal note?", "Add note");
    case "reply_draft": return c("Open a reply draft?", "Open draft");
    case "issue": return c("Draft an issue from this chat?", "Open issue dialog");
    case "invite_visitor": return c("Invite this visitor to chat?", "Send invite");
    case "contact": return c("Change this contact?", "Save contact");
    case "agent_file": return p.op === "delete" ? c(`Delete ${p.path}?`, "Delete file") : p.op === "create" ? c(`Add ${p.path}?`, "Add file") : c(`Change ${p.path}?`, "Save change");
    case "desk_settings": return c("Change the chat widget's settings?", "Save settings");
    case "ai_settings": return c("Change the AI settings?", "Save settings");
    case "knowledge_website": return c("Add this site to the knowledge?", "Add website");
    case "knowledge_text": return c("Add this document to the knowledge?", "Add document");
    case "knowledge_resync": return c("Read this source again?", "Re-sync");
    case "knowledge_edit": return c("Change this knowledge source?", "Save source");
    case "knowledge_remove_page": return c("Remove this page from the knowledge?", "Remove page");
    case "knowledge_remove": return c("Remove this knowledge source?", "Remove source");
    case "saved_reply_create": return c("Add a saved reply?", "Add saved reply");
    case "saved_reply_edit": return c("Change this saved reply?", "Save reply");
    case "saved_reply_delete": return c("Delete this saved reply?", "Delete reply");
    case "tag_rename": return c("Rename this tag?", "Rename tag");
    case "tag_delete": return c("Delete this tag?", "Delete tag");
    case "topic_rename": return c("Rename this topic?", "Rename topic");
    case "topic_merge": return c("Merge these topics?", "Merge topics");
    case "topic_delete": return c("Delete this topic?", "Delete topic");
    case "topic_label": return c("Label chats by topic now?", "Label now");
    case "team_invite": return c(`Invite a new ${p.role}?`, "Make invite link");
    case "team_revoke_invite": return c("Revoke this invite link?", "Revoke invite");
    case "team_role": return c("Change this teammate's role?", "Change role");
    case "team_remove": return c("Remove this teammate?", "Remove teammate");
    case "notifications": return c("Change your notifications?", "Save notifications");
    case "workspace_name": return c("Rename the workspace?", "Rename workspace");
    case "email_settings": return c("Change the email settings?", "Save email settings");
    case "email_test": return c("Send a test email?", "Send test email");
    case "identity_off": return c("Turn identity verification off?", "Turn off");
    case "bulk": return c(`Change ${p.items.length} chats?`, bulkVerb(p, p.items.length));
  }
}

/** A proposal as the model sees its own call in the history: file texts left out (they can be long). */
export function proposalForModel(p: Proposal): Record<string, unknown> {
  if (p && typeof p === "object" && p.kind === "agent_file") return { kind: p.kind, path: p.path, op: p.op };
  if (p && typeof p === "object" && p.kind === "bulk") {
    const { items, ...rest } = p;
    return { ...rest, conversationIds: Array.isArray(items) ? items.map((i) => i.conversationId) : p.conversationIds };
  }
  return p as unknown as Record<string, unknown>;
}

/** A tag list after a proposal: the current tags minus `remove` plus `add` (case-insensitive, first spelling kept). */
export function nextTags(current: string[], add: string[], remove: string[]): string[] {
  const drop = new Set(remove.map((t) => t.toLowerCase()));
  const out = current.filter((t) => !drop.has(t.toLowerCase()));
  for (const t of add) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

/** `link`: an invite link the card shows with Copy; it stays in the page and never goes back to the model. */
export type ProposalOutcome = { status: "done" | "cancelled" | "failed"; detail?: string; link?: string; /** D-134: a bulk card's rows. */ results?: BulkResult[] };

/** What the model is told after the person pressed Confirm or Cancel. */
export function outcomeLine(outcome: ProposalOutcome): string {
  if (outcome.status === "cancelled" && outcome.detail === "expired") return "The card expired before the person pressed Confirm (the page was reloaded): nothing was changed. Propose it again if it's still wanted.";
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
  /** D-134: a list of chats or contacts it found, for a Records Table under the turn. */
  table?: StepTable;
  /** D-134: the knowledge passages search_knowledge found, for Context Cards under the turn. */
  passages?: StepPassages;
  /** D-134: Reports' numbers as small charts (Insight Cards) under the turn. */
  charts?: StepChart[];
}

/** D-134: a chart under a turn: chats per day (report_metrics), or ranked counts (topics, handoff reasons). */
export type StepChart =
  | { kind: "days"; days: number; total: number; change: number | null; series: { day: string; chats: number; ai: number; aiResolved: number }[] }
  | { kind: "ranked"; title: string; rows: { label: string; value: number; href?: string; detail?: string }[] };
export const MAX_CHART_ROWS = 8;

/** D-134: what search_knowledge found, as cards: the source, where in it, a bit of the text. */
export interface StepPassages {
  query: string;
  /** D-139: `sourceId` links a card to its source's page (`knowledgeLink`). */
  hits: { title: string; heading: string; source: string; sourceId?: string; kind: string; url: string | null; text: string }[];
}
export const MAX_PASSAGES = 5;

/** D-134: a read tool's list as table rows (≤ MAX_TABLE_ROWS), only what the desk already shows members. */
export type StepTable =
  | { kind: "chats"; total?: number; rows: { id: string; name: string; status: string; assignee: string | null; topic: string | null; last: number | null }[] }
  | { kind: "people"; rows: { id: string; name: string; email: string | null; company: string | null; chats: number; last: number | null }[] }
  | { kind: "companies"; rows: { id: string; name: string; people: number; chats: number; last: number | null }[] };

export const MAX_TABLE_ROWS = 25;

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
  /** D-134: after `done`, 2–3 next questions for chips under the answer (a separate small call). */
  | { type: "followups"; questions: string[] }
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
    read_settings: ["Reading the desk's settings", "Read the desk's settings"],
    list_inbox_setup: ["Reading saved replies, tags and topics", "Read saved replies, tags and topics"],
    read_knowledge_source: ["Reading a knowledge source", "Read a knowledge source"],
    run_tests: ["Running the agent's tests", "Ran the agent's tests"],
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
  savedReplies: ["saved reply", "saved replies"],
  documents: ["page", "pages"],
  cases: ["test", "tests"],
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

/** "2026-10-20T14:03Z" (iso above) → epoch ms, or null. */
const ms = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** D-134: a step's table for the Records Table, from search_conversations or find_contacts' result; else nothing. */
export function stepTable(tool: string, output: unknown): StepTable | undefined {
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
  const list = (key: string) => (Array.isArray(o[key]) ? (o[key] as unknown[]).filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && typeof (r as { id?: unknown }).id === "string").slice(0, MAX_TABLE_ROWS) : []);
  if (tool === "search_conversations") {
    const rows = list("conversations").map((r) => ({ id: r.id as string, name: text(r.customer) ?? "Visitor", status: text(r.status) ?? "", assignee: text(r.assignee), topic: text(r.topic), last: ms(r.lastMessage) }));
    if (!rows.length) return undefined;
    const total = typeof o.total === "number" && o.total > rows.length ? o.total : undefined;
    return { kind: "chats", ...(total ? { total } : {}), rows };
  }
  if (tool === "find_contacts") {
    const people = list("people").map((r) => ({ id: r.id as string, name: text(r.name) ?? text(r.email) ?? "Unnamed", email: text(r.email), company: text((r.company as { name?: unknown } | null)?.name), chats: count(r.chats), last: ms(r.lastSeen) }));
    if (people.length) return { kind: "people", rows: people };
    const companies = list("companies").map((r) => ({ id: r.id as string, name: text(r.name) ?? "Unnamed", people: count(r.people), chats: count(r.chats), last: ms(r.lastActivity) }));
    if (companies.length) return { kind: "companies", rows: companies };
  }
  return undefined;
}

/** D-134: a report_metrics or topics_and_handoffs step's charts; else nothing. */
export function stepCharts(tool: string, output: unknown): StepChart[] | undefined {
  if (tool !== "report_metrics" && tool !== "topics_and_handoffs") return undefined;
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
  const rows = (key: string) => (Array.isArray(o[key]) ? (o[key] as unknown[]).filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object") : []);
  const out: StepChart[] = [];
  if (tool === "report_metrics") {
    const series = rows("perDay")
      .filter((d) => typeof d.day === "string" && DAY.test(d.day))
      .slice(-90)
      .map((d) => ({ day: d.day as string, chats: count(d.chats), ai: count(d.ai), aiResolved: count(d.aiResolved) }));
    const c = (o.conversations ?? {}) as Record<string, unknown>;
    if (series.length > 1) out.push({ kind: "days", days: count(o.days) || series.length, total: count(c.total), change: typeof c.changePercent === "number" ? c.changePercent : null, series });
  } else {
    const topics = rows("topics").filter((t) => typeof t.name === "string" && count(t.chats) > 0).slice(0, MAX_CHART_ROWS);
    if (topics.length)
      out.push({
        kind: "ranked",
        title: "Topics",
        rows: topics.map((t) => ({
          label: t.name as string,
          value: count(t.chats),
          ...(typeof t.link === "string" && isDeskLink(t.link) ? { href: t.link } : {}),
          ...(count(t.aiChats) ? { detail: `${count(t.aiChats)} with the AI · ${count(t.aiResolved)} resolved by it · ${count(t.handedOff)} handed off` } : {}),
        })),
      });
    const reasons = rows("handoffReasons").filter((r) => typeof r.reason === "string" && count(r.chats) > 0).slice(0, MAX_CHART_ROWS);
    if (reasons.length) out.push({ kind: "ranked", title: "Handoff reasons", rows: reasons.map((r) => ({ label: clip(r.reason as string, 80)!, value: count(r.chats) })) });
  }
  return out.length ? out : undefined;
}

/** D-134: a search_knowledge step's passages for the Context Cards; else nothing. */
export function stepPassages(tool: string, input: Record<string, unknown>, output: unknown): StepPassages | undefined {
  if (tool !== "search_knowledge") return undefined;
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const raw = value && typeof value === "object" && Array.isArray((value as { hits?: unknown }).hits) ? ((value as { hits: unknown[] }).hits as Record<string, unknown>[]) : [];
  const hits = raw
    .filter((h) => h && typeof h === "object" && typeof h.text === "string")
    .slice(0, MAX_PASSAGES)
    .map((h) => ({ title: text(h.title) ?? "Untitled", heading: text(h.heading) ?? "", source: text(h.source) ?? text(h.title) ?? "Knowledge", ...(isSourceId(h.sourceId) ? { sourceId: h.sourceId } : {}), kind: text(h.kind) ?? "website", url: text(h.url), text: clip(h.text as string, 500)! }));
  return hits.length ? { query: clip(typeof input.query === "string" ? input.query : "", 200)!, hits } : undefined;
}

/** D-129: the line a card shows once it's settled ("Tagged · export-issue", "Cancelled"). */
export function outcomeTitle(p: Proposal, labels: ProposalLabels, outcome: ProposalOutcome): string {
  if (outcome.status === "cancelled") return outcome.detail === "not confirmed" ? "Not confirmed" : outcome.detail === "expired" ? "Expired" : "Cancelled";
  if (outcome.status === "failed") return `Didn't work${outcome.detail ? `: ${outcome.detail}` : ""}`;
  const named = (verb: string, name?: string) => (name ? `${verb} · ${name}` : verb);
  switch (p.kind) {
    case "assign":
      return p.assigneeId === null ? "Unassigned" : `Assigned · ${labels.assignee ?? "a teammate"}`;
    case "status":
      return p.status === "resolved" ? "Resolved" : p.status === "open" ? "Reopened" : "Marked pending";
    case "handling":
      return p.handling === "ai" ? "Handed back to the AI" : "Taken over from the AI";
    case "tags":
      return [p.add.length ? `Tagged · ${p.add.join(", ")}` : "", p.remove.length ? `Untagged · ${p.remove.join(", ")}` : ""].filter(Boolean).join(" · ");
    case "note":
      return "Note added";
    case "reply_draft":
      return "Draft opened in the chat";
    case "issue":
      return "Issue dialog opened";
    case "invite_visitor":
      return named("Invite sent", labels.target);
    case "contact":
      return named("Contact saved", labels.target);
    case "agent_file":
      return `${p.op === "delete" ? "Deleted" : p.op === "create" ? "Added" : "Saved"} · ${p.path}${outcome.detail?.startsWith("version ") ? ` · ${outcome.detail.split(";")[0]}` : ""}`;
    case "desk_settings":
      return "Widget settings saved";
    case "ai_settings":
      return "AI settings saved";
    case "knowledge_website":
      return "Adding to knowledge";
    case "knowledge_text":
      return `Added · ${p.title}`;
    case "knowledge_resync":
      return named("Re-syncing", labels.target);
    case "knowledge_edit":
      return named("Source saved", labels.target);
    case "knowledge_remove_page":
      return named("Page removed", labels.detail);
    case "knowledge_remove":
      return named("Source removed", labels.target);
    case "saved_reply_create":
      return `Saved reply added · ${p.title}`;
    case "saved_reply_edit":
      return `Saved reply changed · ${p.title}`;
    case "saved_reply_delete":
      return named("Saved reply deleted", labels.target);
    case "tag_rename":
      return `Tag renamed · ${p.name}`;
    case "tag_delete":
      return named("Tag deleted", labels.target);
    case "topic_rename":
      return `Topic renamed · ${p.name}`;
    case "topic_merge":
      return named("Topics merged", labels.detail);
    case "topic_delete":
      return named("Topic deleted", labels.target);
    case "topic_label":
      return "Topics labelled";
    case "team_invite":
      return `Invite link made · ${p.role}`;
    case "team_revoke_invite":
      return "Invite revoked";
    case "team_role":
      return `${labels.target ?? "Teammate"} is now ${p.role === "admin" ? "an admin" : "an agent"}`;
    case "team_remove":
      return named("Removed", labels.target);
    case "notifications":
      return "Notifications saved";
    case "workspace_name":
      return `Renamed · ${p.name}`;
    case "email_settings":
      return "Email settings saved";
    case "email_test":
      return named("Test email sent", outcome.detail?.replace(/^sent to /, ""));
    case "identity_off":
      return "Identity verification off";
    case "bulk": {
      const r = outcome.results ?? [];
      const done = r.filter((x) => x.status === "done").length;
      const failed = r.filter((x) => x.status === "failed").length;
      const verb = p.op === "status" ? (p.status === "resolved" ? "Resolved" : p.status === "open" ? "Reopened" : "Marked pending") : p.op === "assign" ? (p.assigneeId === null ? "Unassigned" : "Assigned") : p.op === "handling" ? (p.handling === "ai" ? "Handed to the AI" : "Taken over") : "Tags updated";
      return `${verb} · ${done} chat${done === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;
    }
  }
}

// ---------- follow-up questions (D-134) ----------

export const MAX_NEXT_QUESTIONS = 3;
const NEXT_MAX_CHARS = 70;

/** The small call after an answer: what the person might ask next. As the widget's follow-ups (D-42), never asked of the answer itself. */
export const NEXT_QUESTIONS_SYSTEM = `You suggest what a support team member might ask their desk assistant next. The assistant reads the desk (chats, customers, companies, Reports, topics, errors, knowledge, the support agent's files, the team) and proposes changes for them to confirm.
Write 2 or 3 short follow-up questions (under 60 characters each) in the person's words and language, each one the natural next step after the answer: dig into something it named, compare, or act on it. Don't repeat the question or ask what the answer already says.
One question per line, nothing else: no numbering, no quotes, no introduction.`;

/** The call's input: the question, the answer and the tools it used (labels only). */
export function nextQuestionsInput(question: string, answer: string, steps: string[]): string {
  return `Their question:
${question.slice(0, 1000)}

The assistant's answer:
${answer.slice(0, 2500)}${steps.length ? `

What it looked at: ${steps.slice(0, 8).join("; ")}` : ""}`;
}

/** The call's output as chips: one per line, cleaned, distinct, not the question again, ≤ 3. */
export function readNextQuestions(text: string, question = ""): string[] {
  const out: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const line of text.split(/\n/)) {
    const q = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["'“‘]+|["'”’]+$/g, "").replace(/\*\*/g, "").trim();
    if (q.length < 4 || q.length > NEXT_MAX_CHARS || /[\[\]()]|https?:/.test(q) || same(q, question) || out.some((o) => same(o, q))) continue;
    out.push(q);
    if (out.length === MAX_NEXT_QUESTIONS) break;
  }
  return out;
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

