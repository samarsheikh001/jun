import { Hono } from "hono";
import { requireUser } from "../auth/session.ts";
import { requireMember } from "./conversations.ts";
import { loadDebugContext } from "../lib/conversations.ts";
import {
  CONTACTS_PAGE_SIZE, likePattern, pageTrail, readCompanyQuery, readPeopleQuery,
  type Attributes, type CompanyRow, type PersonRow,
} from "../../shared/contacts.ts";
import { HttpError, type AppEnv } from "../types.ts";

// V-16 (D-118): the Contacts page. Read-only lists of the people and companies the desk knows,
// from D1 as the inbox's side panel shows them (the contact itself, its company and its
// conversations come from the routes in visitors.ts). Members only; no internal notes.

export const contacts = new Hono<AppEnv>();
contacts.use("/workspaces/:id/people/*", requireUser);
contacts.use("/workspaces/:id/companies/*", requireUser);

/** People on the list: identified by the host app, or anonymous with an email or a name an agent gave. */
const KNOWN = "(ct.external_id IS NOT NULL OR ct.email IS NOT NULL OR ct.name IS NOT NULL)";

const PERSON_COLUMNS = `ct.id, ct.name, ct.email, ct.external_id, ct.verified_at, ct.last_seen_at,
  co.id AS company_id, co.name AS company_name, co.external_id AS company_external_id,
  (SELECT COUNT(*) FROM conversations cv WHERE cv.contact_id = ct.id) AS conversations,
  (SELECT COUNT(*) FROM conversations cv WHERE cv.contact_id = ct.id AND cv.status != 'resolved') AS open`;

interface PersonDbRow {
  id: string;
  name: string | null;
  email: string | null;
  external_id: string | null;
  verified_at: number | null;
  last_seen_at: number;
  company_id: string | null;
  company_name: string | null;
  company_external_id: string | null;
  conversations: number;
  open: number;
}

const personRow = (r: PersonDbRow): PersonRow => ({
  id: r.id,
  name: r.name,
  email: r.email,
  externalId: r.external_id,
  verified: r.verified_at !== null,
  lastSeenAt: r.last_seen_at,
  conversations: r.conversations,
  open: r.open,
  company: r.company_id ? { id: r.company_id, name: r.company_name, externalId: r.company_external_id ?? "" } : null,
});

const parseAttributes = (json: string): Attributes => {
  try {
    return JSON.parse(json) as Attributes;
  } catch {
    return {};
  }
};

contacts.get("/workspaces/:id/people", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const query = readPeopleQuery({ get: (k) => c.req.query(k) });
  const where = [`ct.workspace_id = ?`, KNOWN];
  const binds: unknown[] = [workspaceId];
  if (query.company) {
    where.push("ct.company_id = ?");
    binds.push(query.company);
  }
  if (query.q) {
    where.push(`(ct.name LIKE ? ESCAPE '\\' OR ct.email LIKE ? ESCAPE '\\' OR ct.external_id LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')`);
    const like = likePattern(query.q);
    binds.push(like, like, like, like);
  }
  const from = `FROM contacts ct LEFT JOIN companies co ON co.id = ct.company_id WHERE ${where.join(" AND ")}`;
  const order = query.sort === "open" ? "open DESC, ct.last_seen_at DESC, ct.id" : "ct.last_seen_at DESC, ct.id";
  const db = c.env.DB;
  const [rows, total] = await db.batch([
    db.prepare(`SELECT ${PERSON_COLUMNS} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, CONTACTS_PAGE_SIZE, query.offset),
    db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds),
  ]);
  return c.json({
    people: (rows!.results as unknown as PersonDbRow[]).map(personRow),
    total: (total!.results[0] as { n: number }).n,
    offset: query.offset,
    pageSize: CONTACTS_PAGE_SIZE,
  });
});

// The page trail of a person's last visit: the navigation events of their latest conversation's
// debug snapshots (the same masked context the inbox's side panel shows), oldest first.
contacts.get("/workspaces/:id/people/:contactId/trail", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const latest = await c.env.DB.prepare(
    `SELECT d.conversation_id FROM debug_snapshots d JOIN conversations cv ON cv.id = d.conversation_id
     WHERE cv.contact_id = ? AND cv.workspace_id = ? ORDER BY d.created_at DESC LIMIT 1`,
  )
    .bind(c.req.param("contactId"), workspaceId)
    .first<{ conversation_id: string }>();
  if (!latest) return c.json({ trail: null });
  const { context, events } = await loadDebugContext(c.env.DB, latest.conversation_id);
  return c.json({
    trail: {
      conversationId: latest.conversation_id,
      capturedAt: context?.capturedAt ?? null,
      page: context?.page ?? null,
      steps: pageTrail(events),
    },
  });
});

const COMPANY_COLUMNS = `co.id, co.external_id, co.name, co.attributes, co.updated_at,
  (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = co.id) AS people,
  (SELECT MAX(ct.last_seen_at) FROM contacts ct WHERE ct.company_id = co.id) AS last_seen_at,
  (SELECT COUNT(*) FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.company_id = co.id) AS conversations,
  (SELECT COUNT(*) FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.company_id = co.id AND cv.status != 'resolved') AS open,
  (SELECT MAX(cv.last_message_at) FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE ct.company_id = co.id) AS last_message_at`;

interface CompanyDbRow {
  id: string;
  external_id: string;
  name: string | null;
  attributes: string;
  updated_at: number;
  people: number;
  last_seen_at: number | null;
  conversations: number;
  open: number;
  last_message_at: number | null;
}

const companyRow = (r: CompanyDbRow): CompanyRow => ({
  id: r.id,
  externalId: r.external_id,
  name: r.name,
  attributes: parseAttributes(r.attributes),
  people: r.people,
  open: r.open,
  conversations: r.conversations,
  lastActivityAt: Math.max(r.updated_at, r.last_seen_at ?? 0, r.last_message_at ?? 0),
});

contacts.get("/workspaces/:id/companies", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const query = readCompanyQuery({ get: (k) => c.req.query(k) });
  const where = ["co.workspace_id = ?"];
  const binds: unknown[] = [workspaceId];
  if (query.q) {
    where.push(`(co.name LIKE ? ESCAPE '\\' OR co.external_id LIKE ? ESCAPE '\\')`);
    const like = likePattern(query.q);
    binds.push(like, like);
  }
  const from = `FROM companies co WHERE ${where.join(" AND ")}`;
  const activity = "MAX(co.updated_at, COALESCE(last_seen_at, 0), COALESCE(last_message_at, 0))";
  const order = query.sort === "open" ? `open DESC, ${activity} DESC, co.id`
    : query.sort === "name" ? "COALESCE(co.name, co.external_id) COLLATE NOCASE, co.id"
    : `${activity} DESC, co.id`;
  const db = c.env.DB;
  const [rows, total] = await db.batch([
    db.prepare(`SELECT ${COMPANY_COLUMNS} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, CONTACTS_PAGE_SIZE, query.offset),
    db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds),
  ]);
  return c.json({
    companies: (rows!.results as unknown as CompanyDbRow[]).map(companyRow),
    total: (total!.results[0] as { n: number }).n,
    offset: query.offset,
    pageSize: CONTACTS_PAGE_SIZE,
  });
});

/** A company's page: its details, its people (the latest 200) and their latest 50 conversations. */
contacts.get("/workspaces/:id/companies/:companyId", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const companyId = c.req.param("companyId");
  const db = c.env.DB;
  const [company, people, chats] = await db.batch([
    db.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies co WHERE co.id = ? AND co.workspace_id = ?`).bind(companyId, workspaceId),
    db.prepare(`SELECT ${PERSON_COLUMNS} FROM contacts ct LEFT JOIN companies co ON co.id = ct.company_id WHERE ct.company_id = ? AND ct.workspace_id = ? ORDER BY ct.last_seen_at DESC LIMIT 200`).bind(companyId, workspaceId),
    db.prepare(
      `SELECT cv.id, cv.status, cv.last_message_at AS lastMessageAt, cv.last_message_preview AS preview, ct.id AS contactId, ct.name AS contactName, ct.email AS contactEmail
       FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
       WHERE ct.company_id = ? AND cv.workspace_id = ? ORDER BY cv.last_message_at DESC LIMIT 50`,
    ).bind(companyId, workspaceId),
  ]);
  const row = company!.results[0] as CompanyDbRow | undefined;
  if (!row) throw new HttpError(404, "not_found", "Company not found.");
  return c.json({
    company: companyRow(row),
    people: (people!.results as unknown as PersonDbRow[]).map(personRow),
    conversations: chats!.results,
  });
});
