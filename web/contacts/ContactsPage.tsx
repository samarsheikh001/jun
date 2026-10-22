import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { api, describeError } from "../api.ts";
import {
  attributeText, companyLabel, COMPANY_SORTS, contactsView, listQueryString, PEOPLE_SORTS, personLabel,
  type Attributes, type CompanyRow, type CompanySort, type PeopleSort, type PersonRow, type TrailStep,
} from "../../shared/contacts.ts";
import { Pager, TabStrip } from "../inbox/ConversationTable.tsx";
import { formatTime } from "../lib/thread.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectField, SelectOption } from "@/components/ui/select-field.tsx";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";

// V-16 (D-118): every person and company the desk knows. A daily page like Visitors and Reports
// (large title); People and Companies as the inbox's tab strip, search and table; a person's and a
// company's own page. Read-only (what the inbox's side panel already shows agents), except a person's
// Link / Unlink (V-18, D-148).

type Tab = "people" | "companies";

/** A desk link: a real href (new tabs keep the workspace), in-app navigation on a plain click. */
function DeskLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    navigate(to);
  };
  return <a href={deskHref(to)} className={className} onClick={onClick}>{children}</a>;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const statusWord = (s: string) => (s === "resolved" ? "Resolved" : s === "open" ? "Open" : s === "pending" ? "Pending" : s === "snoozed" ? "Snoozed" : s);
const dash = <span className="cv-dash">—</span>;

const AVATAR_COLORS = ["#163300", "#3FA110", "#7C5CE0", "#D28E3D", "#E41E3F", "#2E5C13", "#3B3D42", "#5CA02E"];
function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
function Avatar({ id, label, size = 32 }: { id: string; label: string; size?: number }) {
  const letters = label.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  return <span className="cv-avatar" style={{ width: size, height: size, background: avatarColor(id), fontSize: size * 0.36 }} aria-hidden="true">{letters}</span>;
}

/** The list's state, kept by the page so going back from a person keeps the search and filters. */
interface ListState { q: string; peopleSort: PeopleSort; companySort: CompanySort; company: string; peopleOffset: number; companyOffset: number }
const INITIAL: ListState = { q: "", peopleSort: "last_seen", companySort: "activity", company: "", peopleOffset: 0, companyOffset: 0 };

export function ContactsPage({ workspaceId, path }: { workspaceId: string; path: string }) {
  const view = contactsView(path);
  const [list, setList] = useState<ListState>(INITIAL);
  if (view.view === "person") return <PersonPage key={view.id} workspaceId={workspaceId} contactId={view.id} />;
  if (view.view === "company") return <CompanyPage key={view.id} workspaceId={workspaceId} companyId={view.id} />;
  return <ContactsList workspaceId={workspaceId} tab={view.view} state={list} setState={setList} />;
}

interface Page<T> { rows: T[]; total: number; pageSize: number }

function ContactsList({ workspaceId, tab, state, setState }: { workspaceId: string; tab: Tab; state: ListState; setState: (fn: (s: ListState) => ListState) => void }) {
  const [search, setSearch] = useState(state.q);
  const [people, setPeople] = useState<Page<PersonRow> | null>(null);
  const [companies, setCompanies] = useState<Page<CompanyRow> | null>(null);
  const [options, setOptions] = useState<CompanyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Search as you type, a beat after the last key.
  useEffect(() => {
    if (search.trim() === state.q) return;
    const timer = window.setTimeout(() => setState((s) => ({ ...s, q: search.trim(), peopleOffset: 0, companyOffset: 0 })), 250);
    return () => window.clearTimeout(timer);
  }, [search, state.q, setState]);

  useEffect(() => {
    let live = true;
    const qs = listQueryString({ q: state.q, sort: state.peopleSort, company: state.company || null, offset: state.peopleOffset }, "last_seen");
    api<{ people: PersonRow[]; total: number; pageSize: number }>(`/workspaces/${workspaceId}/people${qs}`).then(
      (r) => { if (live) { setPeople({ rows: r.people, total: r.total, pageSize: r.pageSize }); setError(null); } },
      (err) => { if (live) { setPeople({ rows: [], total: 0, pageSize: 50 }); setError(describeError(err)); } },
    );
    return () => { live = false; };
  }, [workspaceId, state.q, state.peopleSort, state.company, state.peopleOffset]);

  useEffect(() => {
    let live = true;
    const qs = listQueryString({ q: state.q, sort: state.companySort, offset: state.companyOffset }, "activity");
    api<{ companies: CompanyRow[]; total: number; pageSize: number }>(`/workspaces/${workspaceId}/companies${qs}`).then(
      (r) => { if (live) setCompanies({ rows: r.companies, total: r.total, pageSize: r.pageSize }); },
      (err) => { if (live) { setCompanies({ rows: [], total: 0, pageSize: 50 }); setError(describeError(err)); } },
    );
    return () => { live = false; };
  }, [workspaceId, state.q, state.companySort, state.companyOffset]);

  // The company filter's choices: the first 50 by name (a bigger list is a company's own page away).
  useEffect(() => {
    api<{ companies: CompanyRow[] }>(`/workspaces/${workspaceId}/companies?sort=name`).then((r) => setOptions(r.companies), () => setOptions([]));
  }, [workspaceId]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setSearch("");
  };
  const filtered = Boolean(state.q || state.company);

  return (
    <div className="content wide contacts-page">
      <div className="row reports-head">
        <h1>Contacts</h1>
      </div>
      <TabStrip<Tab>
        tabs={[
          { key: "people", label: "People", count: people?.total },
          { key: "companies", label: "Companies", count: companies?.total },
        ]}
        active={tab}
        onChange={(key) => navigate(key === "people" ? "/contacts" : "/contacts/companies", { replace: true })}
        search={{ value: search, onChange: setSearch, placeholder: tab === "people" ? "Search name, email, company" : "Search companies", inputRef, onKeyDown }}
        trailing={null}
      >
        {tab === "people" && options.length > 0 && (
          <SelectField size="sm" className="cv-filter" aria-label="Company" value={state.company || "all"} onValueChange={(v) => setState((s) => ({ ...s, company: v === "all" ? "" : v, peopleOffset: 0 }))}>
            <SelectOption value="all">All companies</SelectOption>
            {options.map((c) => <SelectOption key={c.id} value={c.id}>{companyLabel(c)}</SelectOption>)}
          </SelectField>
        )}
        {tab === "people" ? (
          <SelectField size="sm" className="cv-filter" aria-label="Sort" value={state.peopleSort} onValueChange={(v) => setState((s) => ({ ...s, peopleSort: v as PeopleSort, peopleOffset: 0 }))}>
            {PEOPLE_SORTS.map((s) => <SelectOption key={s.value} value={s.value}>{s.label}</SelectOption>)}
          </SelectField>
        ) : (
          <SelectField size="sm" className="cv-filter" aria-label="Sort" value={state.companySort} onValueChange={(v) => setState((s) => ({ ...s, companySort: v as CompanySort, companyOffset: 0 }))}>
            {COMPANY_SORTS.map((s) => <SelectOption key={s.value} value={s.value}>{s.label}</SelectOption>)}
          </SelectField>
        )}
      </TabStrip>
      {error && <p className="error small">{error}</p>}
      {tab === "people" ? (
        <>
          <PeopleTable rows={people?.rows ?? null} empty={filtered ? "Nobody matches." : "No one yet. People show up here once your site identifies them, or they leave an email in the chat."} />
          {people && <Pager page={Math.floor(state.peopleOffset / people.pageSize)} pageCount={Math.ceil(people.total / people.pageSize)} onPage={(p) => setState((s) => ({ ...s, peopleOffset: p * people.pageSize }))} />}
        </>
      ) : (
        <>
          <CompaniesTable rows={companies?.rows ?? null} empty={state.q ? "No company matches." : "No companies yet. They come from the company claim in your site's identity token (Playground → Behaviour)."} />
          {companies && <Pager page={Math.floor(state.companyOffset / companies.pageSize)} pageCount={Math.ceil(companies.total / companies.pageSize)} onPage={(p) => setState((s) => ({ ...s, companyOffset: p * companies.pageSize }))} />}
        </>
      )}
    </div>
  );
}

const SKELETON_WIDTHS = [[118, 168], [96, 140], [134, 180], [104, 150], [124, 160], [90, 176]] as const;

function PeopleTable({ rows, empty, showCompany = true }: { rows: PersonRow[] | null; empty: string; showCompany?: boolean }) {
  const columns = showCompany ? 5 : 4;
  return (
    <div className="cv-table-wrap">
      <table className="cv-table contacts-table">
        <thead>
          <tr>
            <th scope="col">Person</th>
            {showCompany && <th scope="col">Company</th>}
            <th scope="col">Chats</th>
            <th scope="col">Open</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows === null ? (
            SKELETON_WIDTHS.map(([name, email], i) => (
              <tr key={i} aria-hidden="true">
                <td>
                  <div className="cv-person">
                    <Skeleton className="cv-avatar cv-skel-avatar" />
                    <div className="cv-person-text"><div className="cv-name"><SkelText width={name} /></div><div className="cv-email"><SkelText width={email} /></div></div>
                  </div>
                </td>
                {showCompany && <td className="cv-text"><SkelText width={72} /></td>}
                <td className="cv-text"><SkelText width={16} /></td>
                <td className="cv-text"><SkelText width={16} /></td>
                <td className="cv-time"><SkelText width={56} /></td>
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr><td colSpan={columns} className="cv-empty">{empty}</td></tr>
          ) : (
            rows.map((p) => {
              const label = personLabel(p);
              return (
                <tr key={p.id} onClick={() => navigate(`/contacts/${p.id}`)}>
                  <td>
                    <div className="cv-person">
                      <Avatar id={p.id} label={label} />
                      <div className="cv-person-text">
                        <div className="cv-name">
                          <DeskLink to={`/contacts/${p.id}`}>{label}</DeskLink>
                          {p.verified && <span className="verified" title="Identity verified by your site"> ✓</span>}
                          {/* V-18: other browsers with the same email or user ID, counted in this row. */}
                          {p.linked ? <span className="muted small" title="Other browsers with the same email or user ID"> · {p.linked + 1} browsers</span> : null}
                        </div>
                        <div className="cv-email">{p.name && p.email ? p.email : p.externalId ? `ID ${p.externalId}` : p.verified ? "Signed in" : "Anonymous visitor"}</div>
                      </div>
                    </div>
                  </td>
                  {showCompany && <td className="cv-text">{p.company ? <DeskLink to={`/contacts/companies/${p.company.id}`} className="contacts-link">{companyLabel(p.company)}</DeskLink> : dash}</td>}
                  <td className="cv-text contacts-num">{p.conversations}</td>
                  <td className="cv-text contacts-num">{p.open > 0 ? <span className="contacts-open">{p.open}</span> : dash}</td>
                  <td className="cv-time">{formatTime(p.lastSeenAt)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Up to two attributes as a short line (plan, MRR…). */
const attributeLine = (attributes: Attributes) => Object.entries(attributes).slice(0, 2).map(([k, v]) => `${k}: ${attributeText(v)}`).join(" · ");

function CompaniesTable({ rows, empty }: { rows: CompanyRow[] | null; empty: string }) {
  return (
    <div className="cv-table-wrap">
      <table className="cv-table contacts-table">
        <thead>
          <tr>
            <th scope="col">Company</th>
            <th scope="col">People</th>
            <th scope="col">Chats</th>
            <th scope="col">Open</th>
            <th scope="col">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {rows === null ? (
            SKELETON_WIDTHS.map(([name, line], i) => (
              <tr key={i} aria-hidden="true">
                <td>
                  <div className="cv-person">
                    <Skeleton className="cv-avatar cv-skel-avatar" />
                    <div className="cv-person-text"><div className="cv-name"><SkelText width={name} /></div><div className="cv-email"><SkelText width={line} /></div></div>
                  </div>
                </td>
                <td className="cv-text"><SkelText width={16} /></td>
                <td className="cv-text"><SkelText width={16} /></td>
                <td className="cv-text"><SkelText width={16} /></td>
                <td className="cv-time"><SkelText width={56} /></td>
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr><td colSpan={5} className="cv-empty">{empty}</td></tr>
          ) : (
            rows.map((co) => {
              const label = companyLabel(co);
              return (
                <tr key={co.id} onClick={() => navigate(`/contacts/companies/${co.id}`)}>
                  <td>
                    <div className="cv-person">
                      <Avatar id={co.id} label={label} />
                      <div className="cv-person-text">
                        <div className="cv-name"><DeskLink to={`/contacts/companies/${co.id}`}>{label}</DeskLink></div>
                        <div className="cv-email">{attributeLine(co.attributes) || (co.name ? `ID ${co.externalId}` : "")}</div>
                      </div>
                    </div>
                  </td>
                  <td className="cv-text contacts-num">{co.people}</td>
                  <td className="cv-text contacts-num">{co.conversations}</td>
                  <td className="cv-text contacts-num">{co.open > 0 ? <span className="contacts-open">{co.open}</span> : dash}</td>
                  <td className="cv-time">{formatTime(co.lastActivityAt)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

interface ConversationItem { id: string; status: string; lastMessageAt: number; preview: string | null; contactId?: string; contactName?: string | null; contactEmail?: string | null }

/** Conversations as the inbox side panel's list; each opens in the inbox. */
function ConversationList({ items, who }: { items: ConversationItem[]; who?: boolean }) {
  return (
    <ul className="contact-history">
      {items.map((h) => (
        <li key={h.id}>
          <DeskLink to={`/inbox/${h.id}`}>
            <span className="small contacts-preview">{h.preview || "Conversation"}</span>
            <span className="muted small">
              {who && <>{personLabel({ name: h.contactName ?? null, email: h.contactEmail ?? null })} · </>}
              <span className={h.status === "resolved" ? undefined : "contacts-open-word"}>{statusWord(h.status)}</span> · {day(h.lastMessageAt)}
            </span>
          </DeskLink>
        </li>
      ))}
    </ul>
  );
}

function Crumbs({ company }: { company?: boolean }) {
  return (
    <nav className="contacts-crumbs small" aria-label="Breadcrumb">
      <DeskLink to="/contacts">Contacts</DeskLink>
      {company && <><span aria-hidden="true">/</span><DeskLink to="/contacts/companies">Companies</DeskLink></>}
    </nav>
  );
}

function Attrs({ attributes }: { attributes: Attributes }) {
  return (
    <>
      {Object.entries(attributes).map(([k, v]) => (
        <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{attributeText(v)}</dd></span>
      ))}
    </>
  );
}

/** The same shape as the inbox side panel's contact (GET …/contacts/:id). */
interface ContactDetails {
  id: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  verified: boolean;
  attributes: Attributes;
  createdAt: number;
  lastSeenAt: number;
  company: { id: string; externalId: string; name: string | null; attributes: Attributes; people: number } | null;
  /** V-18: other contacts that are the same person. */
  linked?: { id: string; name: string | null; email: string | null; verified: boolean; lastSeenAt: number }[];
}

interface Trail { conversationId: string; capturedAt: number | null; page: { url: string; title: string } | null; steps: TrailStep[] }

const HOW_WORD = { open: "Opened", reload: "Reloaded", back: "Back" } as const;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function DetailSkeleton() {
  return (
    <section className="dash-card dash-hero" aria-busy="true">
      <dl className="env small">
        <dt><SkelText width={48} /></dt><dd><SkelText width={160} /></dd>
        <dt><SkelText width={48} /></dt><dd><SkelText width={120} /></dd>
        <dt><SkelText width={48} /></dt><dd><SkelText width={90} /></dd>
      </dl>
    </section>
  );
}

/**
 * V-18 (D-148): the other browsers that are this person, each with Unlink, and Link to add another contact
 * (search by name or email). What an agent decides here, matching by email or user id leaves alone.
 */
function SamePerson({ workspaceId, details, onChange }: { workspaceId: string; details: ContactDetails; onChange: () => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<PersonRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linked = details.linked ?? [];
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound(null);
      return;
    }
    const mine = new Set([details.id, ...(details.linked ?? []).map((l) => l.id)]);
    const timer = window.setTimeout(() => {
      api<{ people: PersonRow[] }>(`/workspaces/${workspaceId}/people?q=${encodeURIComponent(term)}`).then(
        (r) => setFound(r.people.filter((p) => !mine.has(p.id)).slice(0, 6)),
        () => setFound([]),
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, workspaceId, details]);
  const act = async (id: string, path: string, body: Record<string, unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await api(`/workspaces/${workspaceId}/contacts/${path}`, { method: "POST", body });
      setQ("");
      onChange();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  const row = (p: { id: string; name: string | null; email: string | null; verified: boolean; lastSeenAt: number }, name: ReactNode, action: ReactNode) => (
    <li key={p.id}>
      {name}
      {p.verified && <span className="verified" title="Identity verified by your site">✓</span>}
      <span className="muted small">{p.name && p.email ? `${p.email} · ` : ""}last seen {day(p.lastSeenAt)}</span>
      {action}
    </li>
  );
  return (
    <section className="dash-card contacts-same">
      <div className="dash-card-head">
        <h2>Same person</h2>
        <span className="dash-caption">{linked.length === 0 ? "Just this one" : `${linked.length + 1} browsers`}</span>
      </div>
      <p className="muted small">Browsers with the same email or user ID are linked by themselves. Link or unlink one here when that's wrong; each browser's chat still shows only its own conversations.</p>
      {linked.length > 0 && (
        <ul className="contacts-same-list">
          {linked.map((l) => row(l, <DeskLink to={`/contacts/${l.id}`}>{personLabel(l)}</DeskLink>,
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act(l.id, `${encodeURIComponent(l.id)}/unlink`, {})}>{busy === l.id ? "Unlinking…" : "Unlink"}</Button>))}
        </ul>
      )}
      <div className="contacts-same-add">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Link another contact: search a name or email" aria-label="Search contacts to link" maxLength={120} />
        {found && (found.length === 0 ? (
          <p className="muted small">No other contacts match.</p>
        ) : (
          <ul className="contacts-same-list">
            {found.map((p) => row(p, <span>{personLabel(p)}</span>,
              <Button size="sm" disabled={busy !== null} onClick={() => void act(p.id, `${encodeURIComponent(details.id)}/link`, { with: p.id })}>{busy === p.id ? "Linking…" : "Link"}</Button>))}
          </ul>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function PersonPage({ workspaceId, contactId }: { workspaceId: string; contactId: string }) {
  const [details, setDetails] = useState<ContactDetails | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[] | null>(null);
  const [trail, setTrail] = useState<Trail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // bumped after a Link / Unlink
  useEffect(() => {
    const base = `/workspaces/${workspaceId}/contacts/${encodeURIComponent(contactId)}`;
    api<{ contact: ContactDetails }>(base).then((r) => setDetails(r.contact), (err) => setError(describeError(err)));
    api<{ conversations: ConversationItem[] }>(`${base}/conversations`).then((r) => setConversations(r.conversations), () => setConversations([]));
    api<{ trail: Trail | null }>(`/workspaces/${workspaceId}/people/${encodeURIComponent(contactId)}/trail`).then((r) => setTrail(r.trail), () => setTrail(null));
  }, [workspaceId, contactId, version]);

  const label = details ? personLabel(details) : null;
  const open = conversations?.filter((c) => c.status !== "resolved").length ?? 0;
  return (
    <div className="content wide contacts-page">
      <div className="contacts-title">
        <Crumbs />
        <div className="row reports-head">
          {details && <Avatar id={details.id} label={label!} size={40} />}
          <h1>{error ? "Contact not found" : label ?? <SkelText width={180} />}</h1>
          {details?.verified && <span className="verified" title="Identity verified by your site">✓ verified</span>}
        </div>
      </div>
      {error ? (
        <p className="muted">{error}</p>
      ) : !details ? (
        <DetailSkeleton />
      ) : (
        <>
          <div className="dash-grid">
            <section className="dash-card dash-hero">
              <div className="dash-card-head"><h2>Details</h2></div>
              <dl className="env small">
                {details.name && (<><dt>Name</dt><dd>{details.name}</dd></>)}
                {details.email && (<><dt>Email</dt><dd><a href={`mailto:${details.email}`}>{details.email}</a></dd></>)}
                {details.externalId && (<><dt>User ID</dt><dd><code>{details.externalId}</code></dd></>)}
                <Attrs attributes={details.attributes} />
                <dt>First seen</dt><dd>{day(details.createdAt)}</dd>
                <dt>Last seen</dt><dd>{day(details.lastSeenAt)} · {clock(details.lastSeenAt)}</dd>
                {!details.verified && (<><dt /><dd className="muted">Not verified: {details.email || details.name ? "these details came from your website's page, the chat or an agent." : "an anonymous visitor."}</dd></>)}
                {details.linked && details.linked.length > 0 && (
                  <>
                    <dt>Same person</dt>
                    <dd>
                      {details.linked.length === 1 ? "1 other browser" : `${details.linked.length} other browsers`}, matched by email or user ID
                      {!(details.verified || details.linked.some((l) => l.verified)) && " (not verified)"}; their chats are listed here too.
                    </dd>
                  </>
                )}
              </dl>
            </section>
            <section className="dash-card dash-hero">
              <div className="dash-card-head"><h2>Company</h2></div>
              {details.company ? (
                <dl className="env small">
                  <dt>Name</dt><dd><DeskLink to={`/contacts/companies/${details.company.id}`}>{companyLabel(details.company)}</DeskLink></dd>
                  {details.company.name && (<><dt>Company ID</dt><dd><code>{details.company.externalId}</code></dd></>)}
                  <Attrs attributes={details.company.attributes} />
                  <dt>People</dt><dd>{details.company.people === 1 ? "1 person" : `${details.company.people} people`}</dd>
                </dl>
              ) : (
                <p className="muted small">No company. It comes from the company claim in your site's identity token.</p>
              )}
            </section>
          </div>
          <SamePerson workspaceId={workspaceId} details={details} onChange={() => setVersion((v) => v + 1)} />
          <div className="dash-grid">
            <section className="dash-card">
              <div className="dash-card-head">
                <h2>Conversations</h2>
                {conversations && <span className="dash-caption"><span className="strong">{conversations.length}</span>{open > 0 ? ` · ${open} open` : ""}</span>}
              </div>
              {conversations === null ? (
                <Skeleton className="contacts-list-skel" />
              ) : conversations.length === 0 ? (
                <p className="muted small">No conversations yet.</p>
              ) : (
                <ConversationList items={conversations} />
              )}
            </section>
            <section className="dash-card">
              <div className="dash-card-head">
                <h2>Last visit</h2>
                {trail?.capturedAt && <span className="dash-caption">{day(trail.capturedAt)}</span>}
              </div>
              {trail === undefined ? (
                <Skeleton className="contacts-list-skel" />
              ) : !trail || trail.steps.length === 0 ? (
                <p className="muted small">No pages recorded. They're kept when the visitor writes from a page with the widget.</p>
              ) : (
                <>
                  <ol className="contacts-trail">
                    {trail.steps.map((s, i) => (
                      <li key={`${s.t}-${i}`}>
                        <span className="cv-time">{clock(s.t)}</span>
                        <code className="contacts-trail-url">{s.url}</code>
                        {s.how && s.how !== "open" && <span className="dash-row-tag">{HOW_WORD[s.how]}</span>}
                      </li>
                    ))}
                  </ol>
                  <p className="dash-foot">From the chat <DeskLink to={`/inbox/${trail.conversationId}`}>in the inbox</DeskLink>, where the errors and clicks of that visit are too.</p>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function CompanyPage({ workspaceId, companyId }: { workspaceId: string; companyId: string }) {
  const [data, setData] = useState<{ company: CompanyRow; people: PersonRow[]; conversations: ConversationItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ company: CompanyRow; people: PersonRow[]; conversations: ConversationItem[] }>(`/workspaces/${workspaceId}/companies/${encodeURIComponent(companyId)}`).then(setData, (err) => setError(describeError(err)));
  }, [workspaceId, companyId]);
  const co = data?.company;
  return (
    <div className="content wide contacts-page">
      <div className="contacts-title">
        <Crumbs company />
        <div className="row reports-head">
          {co && <Avatar id={co.id} label={companyLabel(co)} size={40} />}
          <h1>{error ? "Company not found" : co ? companyLabel(co) : <SkelText width={180} />}</h1>
        </div>
      </div>
      {error ? (
        <p className="muted">{error}</p>
      ) : !data || !co ? (
        <DetailSkeleton />
      ) : (
        <>
          <section className="dash-card dash-hero">
            <div className="dash-card-head"><h2>Details</h2></div>
            <dl className="env small">
              <dt>Company ID</dt><dd><code>{co.externalId}</code></dd>
              <Attrs attributes={co.attributes} />
              <dt>People</dt><dd>{co.people}</dd>
              <dt>Open chats</dt><dd>{co.open}</dd>
              <dt>Last activity</dt><dd>{day(co.lastActivityAt)} · {clock(co.lastActivityAt)}</dd>
            </dl>
          </section>
          <section className="dash-card">
            <div className="dash-card-head">
              <h2>People</h2>
              <span className="dash-caption"><span className="strong">{co.people}</span>{co.people > data.people.length ? ` · latest ${data.people.length} shown` : ""}</span>
            </div>
            <PeopleTable rows={data.people} empty="No one from this company yet." showCompany={false} />
          </section>
          <section className="dash-card">
            <div className="dash-card-head">
              <h2>Conversations</h2>
              <span className="dash-caption"><span className="strong">{co.conversations}</span>{co.open > 0 ? ` · ${co.open} open` : ""}</span>
            </div>
            {data.conversations.length === 0 ? <p className="muted small">No conversations yet.</p> : <ConversationList items={data.conversations} who />}
          </section>
        </>
      )}
    </div>
  );
}
