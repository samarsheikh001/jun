import type { DebugEvent } from "./debug.ts";

// V-16 (D-118): the Contacts page. Pure parts shared by the Worker's list routes and the desk:
// the list query (search, sort, company filter, page), the LIKE pattern, names, the page trail.

export const CONTACTS_PAGE_SIZE = 50;
const MAX_QUERY = 100;
const MAX_OFFSET = 100_000;

export type PeopleSort = "last_seen" | "open";
export type CompanySort = "activity" | "open" | "name";
export const PEOPLE_SORTS: { value: PeopleSort; label: string }[] = [
  { value: "last_seen", label: "Last seen" },
  { value: "open", label: "Open chats" },
];
export const COMPANY_SORTS: { value: CompanySort; label: string }[] = [
  { value: "activity", label: "Last activity" },
  { value: "open", label: "Open chats" },
  { value: "name", label: "Name" },
];

export type Attributes = Record<string, string | number | boolean>;

/** One row of the People list. */
export interface PersonRow {
  id: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  verified: boolean;
  lastSeenAt: number;
  conversations: number;
  open: number;
  company: { id: string; name: string | null; externalId: string } | null;
}

/** One row of the Companies list. */
export interface CompanyRow {
  id: string;
  externalId: string;
  name: string | null;
  attributes: Attributes;
  people: number;
  open: number;
  conversations: number;
  /** The latest of its people's last visits and its chats' last messages (epoch ms). */
  lastActivityAt: number;
}

export interface ListQuery<S extends string> {
  q: string;
  sort: S;
  offset: number;
  /** People only: a company's id. */
  company: string | null;
}

type Params = { get(name: string): string | null | undefined };

function readQuery<S extends string>(params: Params, sorts: readonly S[]): ListQuery<S> {
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const sortParam = params.get("sort") ?? "";
  const sort = (sorts as readonly string[]).includes(sortParam) ? (sortParam as S) : sorts[0]!;
  const n = Number.parseInt(params.get("offset") ?? "0", 10);
  const offset = Number.isFinite(n) ? Math.min(Math.max(0, n), MAX_OFFSET) : 0;
  const company = (params.get("company") ?? "").trim();
  return { q, sort, offset, company: /^[\w-]{1,64}$/.test(company) ? company : null };
}

/** The People list's query string, made safe: unknown sorts fall back to last seen. */
export const readPeopleQuery = (params: Params) => readQuery<PeopleSort>(params, ["last_seen", "open"]);
/** The Companies list's query string; `company` is ignored there. */
export const readCompanyQuery = (params: Params) => ({ ...readQuery<CompanySort>(params, ["activity", "open", "name"]), company: null });

/** `%text%` for `LIKE ? ESCAPE '\'`: the searcher's own % and _ match themselves. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The query string the desk sends (defaults left out). */
export function listQueryString<S extends string>(query: Partial<ListQuery<S>>, defaultSort: S): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.sort && query.sort !== defaultSort) params.set("sort", query.sort);
  if (query.company) params.set("company", query.company);
  if (query.offset) params.set("offset", String(query.offset));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** How a person is named on the desk: name, else email, else their app's user id. */
export function personLabel(p: { name: string | null; email: string | null; externalId?: string | null }): string {
  return p.name?.trim() || p.email?.trim() || (p.externalId ? `User ${p.externalId}` : "Anonymous visitor");
}

/** A company's name, else its id in the host app. */
export const companyLabel = (c: { name: string | null; externalId: string }) => c.name?.trim() || c.externalId;

/** An attribute's value as text: numbers grouped (12,500), booleans as Yes / No. */
export function attributeText(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
  return value;
}

export type ContactsView = { view: "people" } | { view: "companies" } | { view: "person"; id: string } | { view: "company"; id: string };

/** Which part of the Contacts page a desk path (without the workspace) shows. */
export function contactsView(path: string): ContactsView {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean).slice(1);
  if (parts[0] === "companies") return parts[1] ? { view: "company", id: decodeURIComponent(parts[1]) } : { view: "companies" };
  return parts[0] ? { view: "person", id: decodeURIComponent(parts[0]) } : { view: "people" };
}

export interface TrailStep {
  t: number;
  url: string;
  how?: DebugEvent["how"];
}

export const MAX_TRAIL = 30;

/** The pages of a visit in order (oldest first), from a debug snapshot's navigation events; repeats in a row once. */
export function pageTrail(events: DebugEvent[]): TrailStep[] {
  const steps: TrailStep[] = [];
  for (const e of [...events].filter((e) => e.kind === "navigation" && e.url).sort((a, b) => a.t - b.t)) {
    const last = steps[steps.length - 1];
    if (last && last.url === e.url && e.how !== "reload") continue;
    steps.push(e.how ? { t: e.t, url: e.url!, how: e.how } : { t: e.t, url: e.url! });
  }
  return steps.slice(-MAX_TRAIL);
}

/** V-17 (D-146): the page's unverified word for who its user is. */
export interface ProfileHint {
  name: string | null;
  email: string | null;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `JunDesk.identify({ name, email })` without a token, cleaned: a name of at most 120 characters on one line,
 * a lowercase email of at most 320. Anything missing or malformed is null (the contact keeps what it had):
 * it's page code, so a bad field is dropped rather than refused.
 */
export function readProfileHint(body: Record<string, unknown>): ProfileHint {
  const name = typeof body.name === "string" ? body.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  return { name: name || null, email: email.length <= 320 && EMAIL_PATTERN.test(email) ? email : null };
}
