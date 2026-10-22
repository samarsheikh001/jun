import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { describeBrowser, describeIssueKind, describeProps, describeTarget, formatDuration, formatEventTime, isIssue, type DebugContext, type DebugEvent } from "../../shared/debug.ts";
import type { AiAction, ConversationSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { ToolCalls } from "./ToolCalls.tsx";

interface ContextResponse {
  context: Omit<DebugContext, "events"> | null;
  events: DebugEvent[];
  issueCount: number;
}

function EventRow({ event, timezone }: { event: DebugEvent; timezone: string }) {
  const time = formatEventTime(event.t, timezone);
  if (event.kind === "navigation") {
    return (
      <li className="ev nav">
        <span className="ev-time">{time}</span>
        <span>{event.how === "reload" ? "Reloaded" : event.how === "back" ? "Went back to" : "Visited"} <code>{event.url}</code></span>
      </li>
    );
  }
  if (event.kind === "network") {
    return (
      <li className={`ev ${isIssue(event) ? "bad" : ""}`}>
        <span className="ev-time">{time}</span>
        <span>
          <strong>{event.method ?? "GET"}</strong> <code>{event.url}</code>{" "}
          <span className="status">{event.status ? event.status : "failed"}</span>
          {event.durationMs != null && <span className="muted"> · {event.durationMs} ms</span>}
          {event.message && <div className="muted small">{event.message}</div>}
        </span>
      </li>
    );
  }
  if (event.kind === "rage_click") {
    // S-02: clicked the same thing again and again; the page didn't change.
    return (
      <li className="ev bad">
        <span className="ev-time">{time}</span>
        <span>
          <strong>Rage click</strong> ×{event.count} on <code>{describeTarget(event.target)}</code>
          <div className="muted small">Clicked repeatedly within a second; nothing on the page changed</div>
        </span>
      </li>
    );
  }
  if (event.kind === "dead_click") {
    // One click the page never answered (PostHog's dead click: nothing changed for 2.5 s).
    return (
      <li className="ev warn">
        <span className="ev-time">{time}</span>
        <span>
          <strong>Dead click</strong> on <code>{describeTarget(event.target)}</code>
          <div className="muted small">Nothing on the page changed for 2.5 s</div>
        </span>
      </li>
    );
  }
  if (event.kind === "stuck") {
    // S-13: still on the page a while after something failed, with no successful submit.
    return (
      <li className="ev warn">
        <span className="ev-time">{time}</span>
        <span>
          <strong>Stuck</strong> for {formatDuration(event.seconds ?? 0)} on <code>{event.url}</code>
          <div className="muted small">After {describeIssueKind(event.issue)}; no successful form submit since</div>
        </span>
      </li>
    );
  }
  if (event.kind === "app_event") {
    // V-15: something the visitor did in the app (JunDesk.track).
    return (
      <li className="ev">
        <span className="ev-time">{time}</span>
        <span>
          <code>{event.name}</code>
          {event.props && <div className="muted small">{describeProps(event.props)}</div>}
        </span>
      </li>
    );
  }
  if (event.kind === "app_error") {
    // S-12: the customer's app said what failed (JunDesk.reportError).
    return (
      <li className="ev bad">
        <span className="ev-time">{time}</span>
        <span>
          <strong>{event.message}</strong>
          <div className="muted small">Reported by the app{event.code && <> · <code>{event.code}</code></>}</div>
        </span>
      </li>
    );
  }
  return (
    <li className="ev bad">
      <span className="ev-time">{time}</span>
      <span>
        <strong>{event.message || "JavaScript error"}</strong>
        {event.source && <div className="muted small"><code>{event.source}</code></div>}
        {event.stack && (
          <details>
            <summary className="small">Stack</summary>
            <pre>{event.stack}</pre>
          </details>
        )}
      </span>
    </li>
  );
}

/**
 * P1: what the visitor's browser saw (errors, failed requests, pages visited) next to the
 * conversation, so agents don't have to ask "what browser are you on?".
 */
/** AI-11: what the AI looked up while answering, with what it sent and got back. */
function AiActions({ actions }: { actions: AiAction[] }) {
  if (!actions.length) return null;
  return (
    <>
      <h3>AI actions</h3>
      <ToolCalls actions={actions} />
    </>
  );
}

interface ContactDetails {
  name: string | null;
  externalId: string | null;
  email: string | null;
  verified: boolean;
  attributes: Record<string, string | number | boolean>;
  createdAt: number;
  lastSeenAt: number;
  /** V-11: the account they belong to, from the identity token's `company` claim. */
  company: {
    externalId: string;
    name: string | null;
    attributes: Record<string, string | number | boolean>;
    people: number;
    conversations: (PastConversation & { contactName: string | null; contactEmail: string | null })[];
  } | null;
  /** V-18: other contacts that are the same person (other browsers sharing the email or user id). */
  linked?: { id: string; name: string | null; email: string | null; verified: boolean; lastSeenAt: number }[];
}

interface PastConversation {
  id: string;
  status: string;
  lastMessageAt: number;
  preview: string | null;
  /** V-18: the contact (browser) the chat came from; another one when it's linked to this person. */
  contactId?: string;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * I-08: who the customer is (verified details from the host app, or what an agent noted for
 * an anonymous visitor) and their other conversations.
 */
function ContactCard({ workspaceId, contact, conversationId, refreshKey }: { workspaceId: string; contact: ConversationSummary["contact"]; conversationId: string; refreshKey: number }) {
  const base = `/workspaces/${workspaceId}/contacts/${contact.id}`;
  const [details, setDetails] = useState<ContactDetails | null>(null);
  const [history, setHistory] = useState<PastConversation[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ contact: ContactDetails }>(base).then((r) => setDetails(r.contact), () => setDetails(null));
    api<{ conversations: PastConversation[] }>(`${base}/conversations`).then((r) => setHistory(r.conversations), () => setHistory([]));
  }, [base, refreshKey, contact.name, contact.email, contact.verified]);
  if (!details) return null;

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError(null);
    try {
      await api(base, { method: "PATCH", body: { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? "") } });
      setDetails({ ...details, name: String(data.get("name") ?? "") || null, email: String(data.get("email") ?? "") || null });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const others = history.filter((h) => h.id !== conversationId);

  return (
    <>
      <div className="row">
        <h3>Customer {details.verified && <span className="verified" title="Identity verified by your site">✓ verified</span>}</h3>
        <span className="spacer" />
        {!details.verified && !editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>}
      </div>
      {editing ? (
        <form className="contact-edit" onSubmit={save}>
          <Input name="name" defaultValue={details.name ?? ""} placeholder="Name" maxLength={200} autoFocus />
          <Input name="email" type="email" defaultValue={details.email ?? ""} placeholder="Email" maxLength={320} />
          <div className="row">
            <Button size="sm">Save</Button>
            <Button variant="outline" size="sm" type="button" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
          {error && <span className="error small">{error}</span>}
        </form>
      ) : (
        <dl className="env small">
          {details.name && (<><dt>Name</dt><dd>{details.name}</dd></>)}
          {details.email && (
            <>
              <dt>Email</dt>
              {/* W-08: the desk doesn't send email; reply from your own mail client if they've left. */}
              <dd>{details.email} · <a href={`mailto:${details.email}?subject=${encodeURIComponent("Re: your chat with us")}`}>Reply by email</a></dd>
            </>
          )}
          {details.externalId && (<><dt>User ID</dt><dd><code>{details.externalId}</code></dd></>)}
          {Object.entries(details.attributes).map(([k, v]) => (
            <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{String(v)}</dd></span>
          ))}
          <dt>First seen</dt><dd>{day(details.createdAt)}</dd>
          {!details.verified && !details.name && !details.email && (<><dt /><dd className="muted">Anonymous visitor. Add a name or email if they tell you.</dd></>)}
          {/* V-17: a page's identify() without a token, the chat's email ask or an agent: a label, not proof. */}
          {!details.verified && (details.name || details.email) && (<><dt /><dd className="muted">Not verified: anyone could have typed these, so don't share account details on their strength.</dd></>)}
          {/* V-18 (D-147): the same email or user id on other browsers: one person here, each browser's widget still its own. */}
          {details.linked && details.linked.length > 0 && (
            <>
              <dt>Same person</dt>
              <dd>
                {details.linked.length === 1 ? "1 other browser" : `${details.linked.length} other browsers`}, matched by email or user ID
                {!(details.verified || details.linked.some((l) => l.verified)) && " (not verified)"}
                {" · "}<a href={deskHref(`/contacts/${contact.id}`)} onClick={(e) => { e.preventDefault(); navigate(`/contacts/${contact.id}`); }}>Manage</a>
              </dd>
            </>
          )}
        </dl>
      )}
      {details.company && <CompanyCard company={details.company} />}
      {others.length > 0 && (
        <>
          <h3>Other conversations ({others.length})</h3>
          <ul className="contact-history">
            {others.map((h) => (
              <li key={h.id}>
                <a href={deskHref(`/inbox/${h.id}`)} onClick={(e) => { e.preventDefault(); navigate(`/inbox/${h.id}`); }}>
                  <span className="small">{h.preview || "Conversation"}</span>
                  <span className="muted small">{h.status === "resolved" ? "Resolved" : h.status === "open" ? "Open" : h.status} · {day(h.lastMessageAt)}{h.contactId && h.contactId !== contact.id && " · other browser"}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

const statusWord = (s: string) => (s === "resolved" ? "Resolved" : s === "open" ? "Open" : s);

/** V-11: the customer's company (B2B): its details and its other people's latest chats. */
function CompanyCard({ company }: { company: NonNullable<ContactDetails["company"]> }) {
  return (
    <>
      <h3>Company</h3>
      <dl className="env small">
        <dt>Name</dt><dd>{company.name ?? <code>{company.externalId}</code>}</dd>
        {company.name && (<><dt>Company ID</dt><dd><code>{company.externalId}</code></dd></>)}
        {Object.entries(company.attributes).map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{String(v)}</dd></span>
        ))}
        <dt>People</dt><dd>{company.people === 1 ? "1 person signed in" : `${company.people} people signed in`}</dd>
      </dl>
      {company.conversations.length > 0 && (
        <>
          <h3>Their team's conversations</h3>
          <ul className="contact-history">
            {company.conversations.map((h) => (
              <li key={h.id}>
                <a href={deskHref(`/inbox/${h.id}`)} onClick={(e) => { e.preventDefault(); navigate(`/inbox/${h.id}`); }}>
                  <span className="small">{h.preview || "Conversation"}</span>
                  <span className="muted small">{h.contactName ?? h.contactEmail ?? "Someone"} · {statusWord(h.status)} · {day(h.lastMessageAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** The side panel's scroller: the root keeps the border, the viewport the grid layout. */
function Panel({ className = "", children }: { className?: string; children: ReactNode }) {
  return <ScrollArea render={<aside />} className={`debug-panel ${className}`} contentClassName="debug-panel-body">{children}</ScrollArea>;
}

/** `actions` (AI-11) are loaded by the thread, which also shows them next to each AI reply. */
export function DebugPanel({ conversationId, workspaceId, contact, refreshKey, actions }: { conversationId: string; workspaceId: string; contact: ConversationSummary["contact"]; refreshKey: number; actions: AiAction[] }) {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);

  useEffect(() => {
    api<ContextResponse>(`/conversations/${conversationId}/context`).then(setData, () => setData(null));
  }, [conversationId, refreshKey]);

  if (!data) return <Panel className="muted small">Loading…</Panel>;
  if (!data.context) {
    return (
      <Panel>
        <ContactCard workspaceId={workspaceId} contact={contact} conversationId={conversationId} refreshKey={refreshKey} />
        <AiActions actions={actions} />
        <h3>Browser</h3>
        <p className="muted small">No browser details for this conversation. They appear when the visitor writes from a page with the widget installed.</p>
      </Panel>
    );
  }
  const { context } = data;
  const shown = onlyIssues ? data.events.filter(isIssue) : data.events;
  return (
    <Panel>
      <ContactCard workspaceId={workspaceId} contact={contact} conversationId={conversationId} refreshKey={refreshKey} />
      <AiActions actions={actions} />
      <h3>Browser</h3>
      <dl className="env small">
        <dt>Page</dt>
        <dd><code>{context.page.url}</code>{context.page.title && <div className="muted">{context.page.title}</div>}</dd>
        <dt>Browser</dt>
        <dd>{describeBrowser(context.userAgent)}</dd>
        <dt>Screen</dt>
        <dd>{context.viewport.w}×{context.viewport.h}</dd>
        <dt>Locale</dt>
        <dd>{context.language}{context.timezone && ` · ${context.timezone}`}</dd>
      </dl>
      <div className="row">
        <h3>What happened</h3>
        <span className="spacer" />
        {data.issueCount > 0 && <span className="issue-count">⚠ {data.issueCount}</span>}
      </div>
      <label className="check small">
        <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Errors only
      </label>
      {shown.length === 0 ? (
        <p className="muted small">Nothing went wrong in their browser.</p>
      ) : (
        <ol className="timeline small">
          {shown.map((e, i) => (
            <EventRow key={`${e.t}-${i}`} event={e} timezone={context.timezone} />
          ))}
        </ol>
      )}
      <p className="muted small">Captured by the widget in the visitor's browser and masked (emails, tokens, query values). No request bodies.</p>
    </Panel>
  );
}
