import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Brief } from "../../shared/home-brief.ts";
import { api, describeError } from "../api.ts";
import { ArrowRightIcon, AsteriskIcon, ChatIcon, ChevronDownIcon, CoffeeIcon, EditIcon, HandoffIcon, RefreshIcon, SettingsIcon, SparkleIcon } from "../components/icons.tsx";
import { deskHref, navigate } from "../lib/router.ts";
import { SkelText } from "@/components/ui/skeleton.tsx";
import { AskChat, askDesk, newAskChat, useAskStarted } from "./AskChat.tsx";

// I-19 (D-127): Home, the page a workspace opens on. The daily brief (numbers worked out on the
// server, worded by the AI when it's on, else written in code; cached per member per day) and,
// below it, the desk assistant's ask box. Every point links to its chats or page.

interface BriefResponse {
  brief: Brief;
  /** The AI is wording today's brief: POST …/home/brief for it. */
  writing: boolean;
  ai: { available: boolean; reason?: string; message?: string };
}

/** Kept for this tab, so coming back to Home shows it at once (then refreshes it quietly). */
const cache = new Map<string, BriefResponse>();
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

type Point = Brief["points"][number];
type Tag = { label: string; hue: "red" | "amber" | "blue" | "violet" | "green" };

/** The pill on a row, after the reference's "2nd ping" / "Today" / "CI failed": what kind of thing it is. */
function tagOf(p: Point): Tag {
  switch (p.id.split(":")[0]) {
    case "unassigned": return { label: "unassigned", hue: "red" };
    case "mine": return { label: "your reply", hue: "amber" };
    case "bad_csat": return { label: "bad rating", hue: "red" };
    case "topic": return { label: "topic spike", hue: "amber" };
    case "page": return { label: "page spike", hue: "amber" };
    case "struggle": return { label: "struggle", hue: "amber" };
    case "error": return { label: "new error", hue: "violet" };
    case "gap": return { label: "knowledge gap", hue: "blue" };
    default: return { label: "all clear", hue: "green" };
  }
}

function DeskLink({ path, className, children, title }: { path: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a
      className={className}
      href={deskHref(path)}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(path);
      }}
    >
      {children}
    </a>
  );
}

/** D-130 (after the user's "Morning digest" reference): the headline's counts as soft blue chips, a number with the word after it. */
function withChips(text: string): ReactNode[] {
  return text
    .split(/(\d(?:[\d,.:]*\d)?%?(?:\s+(?!and\b|or\b|of\b|to\b|on\b|in\b|the\b)[A-Za-z’'-]+)?)/)
    .map((part, i) => (i % 2 ? <span key={i} className="digest-chip">{part}</span> : part));
}

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${name.split(/\s+/)[0]}`;
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
const today = () => new Date().toLocaleDateString("en-CA");

function DigestHead({ day, refresh }: { day: string; refresh?: ReactNode }) {
  return (
    <div className="digest-head">
      <h1><CoffeeIcon aria-hidden="true" />Today's brief<span className="digest-day"> · {day}</span></h1>
      {refresh}
    </div>
  );
}

/** A row of "What needs you" / "What's unusual": the sentence (the whole row opens its link), its pill, then its chats. */
function DigestRow({ p, names, onAsk }: { p: Point; names: Record<string, string> | undefined; onAsk: ((question: string) => void) | null }) {
  const tag = tagOf(p);
  const chats = p.link?.path.startsWith("/inbox/") ? [] : p.chats.slice(0, 3);
  const askButton = onAsk && (
    <button type="button" data-plain className="brief-ask" title="Ask the assistant about this" onClick={() => onAsk(`Tell me more about this, and what I should do: “${p.text}”`)}>
      <SparkleIcon aria-hidden="true" /> Ask
    </button>
  );
  return (
    <li className={`digest-row${p.link ? " linked" : ""}`}>
      <div className="digest-row-main">
        {p.link ? <DeskLink path={p.link.path} className="digest-row-text" title={p.link.label}>{p.text}</DeskLink> : <span className="digest-row-text">{p.text}</span>}
        <span className="digest-row-side">
          {!chats.length && askButton}
          <span className={`digest-tag ${tag.hue}`}>{tag.label}</span>
        </span>
      </div>
      {chats.length > 0 && (
        <div className="digest-row-extra">
          {chats.map((id) => (
            <DeskLink key={id} path={`/inbox/${id}`} className="brief-chat" title="Open this chat">
              <ChatIcon aria-hidden="true" />
              <span>{names?.[id] ?? "Chat"}</span>
            </DeskLink>
          ))}
          {p.chats.length > 3 && <span className="brief-more">+{p.chats.length - 3}</span>}
          {askButton}
        </div>
      )}
    </li>
  );
}

function DigestGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="digest-group" open>
      <summary><ChevronDownIcon aria-hidden="true" />{label}</summary>
      <ul className="digest-rows">{children}</ul>
    </details>
  );
}

function BriefView({ data, me, writing, refreshing, onRefresh, error, onAsk }: { data: BriefResponse; me: string; writing: boolean; refreshing: boolean; onRefresh: () => void; error: string | null; onAsk: ((question: string) => void) | null }) {
  const { brief } = data;
  const time = new Date(brief.generatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/\s/g, "");
  const ask = writing ? null : onAsk;
  const of = (section: Point["section"]) => brief.points.filter((p) => p.section === section);
  const needs = of("needs");
  const unusual = of("unusual");
  const yesterday = of("yesterday");
  return (
    <section className="digest" aria-labelledby="brief-title" aria-busy={writing || refreshing}>
      <DigestHead
        day={dayLabel(brief.day)}
        refresh={
          <button type="button" className="home-ask-tool" onClick={onRefresh} disabled={writing || refreshing} aria-label="Refresh" title="Count everything again and write a new brief">
            <RefreshIcon className={refreshing ? "spin" : undefined} />
          </button>
        }
      />
      <div className="digest-sheet">
        <div className="digest-meta">
          <span id="brief-title">{greeting(me)}</span>
          <span title={brief.source === "ai" ? "Written by the AI from your desk's numbers" : "From your desk's numbers"}>{writing ? "writing…" : `as of ${time}`}</span>
        </div>
        <p className={`digest-headline${writing ? " writing" : ""}`}>{withChips(brief.headline)}</p>
        {error && <p className="error small">{error}</p>}
        {needs.length > 0 && <DigestGroup label="What needs you">{needs.map((p) => <DigestRow key={p.id} p={p} names={brief.chatNames} onAsk={ask} />)}</DigestGroup>}
        {unusual.length > 0 && <DigestGroup label="What's unusual">{unusual.map((p) => <DigestRow key={p.id} p={p} names={brief.chatNames} onAsk={ask} />)}</DigestGroup>}
        {yesterday.length > 0 && (
          <ul className="digest-list" aria-label="Since yesterday">
            {yesterday.map((p) => {
              const Icon = p.id === "reasons" ? HandoffIcon : ChatIcon;
              const body = <><Icon aria-hidden="true" /><span>{p.text}</span>{p.link && <ArrowRightIcon className="digest-arrow" aria-hidden="true" />}</>;
              return <li key={p.id}>{p.link ? <DeskLink path={p.link.path} className="digest-item" title={p.link.label}>{body}</DeskLink> : <div className="digest-item">{body}</div>}</li>;
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function BriefSkeleton({ me }: { me: string }) {
  return (
    <section className="digest" aria-hidden="true">
      <DigestHead day={dayLabel(today())} />
      <div className="digest-sheet">
        <div className="digest-meta"><span>{greeting(me)}</span><span><SkelText width={70} /></span></div>
        <p className="digest-headline"><SkelText width="90%" /><br /><SkelText width="50%" /></p>
        <DigestGroup label="What needs you">
          {[0, 1].map((i) => <li key={i} className="digest-row"><div className="digest-row-main"><span className="digest-row-text"><SkelText width="80%" /></span></div></li>)}
        </DigestGroup>
      </div>
    </section>
  );
}

export function HomePage({ workspaceId, me, role }: { workspaceId: string; workspaceName: string; me: { id: string; name: string }; role: "owner" | "admin" | "agent" }) {
  const [data, setData] = useState<BriefResponse | null>(() => cache.get(workspaceId) ?? null);
  const [writing, setWriting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const write = useCallback(
    async (refresh: boolean) => {
      const r = await api<{ brief: Brief }>(`/workspaces/${workspaceId}/home/brief`, { body: { tz: timezone(), refresh } });
      setData((d) => {
        const next = d ? { ...d, brief: r.brief, writing: false } : null;
        if (next) cache.set(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  useEffect(() => {
    let live = true;
    api<BriefResponse>(`/workspaces/${workspaceId}/home/brief?tz=${encodeURIComponent(timezone())}`).then(
      (r) => {
        if (!live) return;
        cache.set(workspaceId, r);
        setData(r);
        if (!r.writing) return;
        setWriting(true);
        write(false)
          .catch((e: unknown) => live && setError(`The AI couldn't write today's brief (${describeError(e)}); these are the numbers.`))
          .finally(() => live && setWriting(false));
      },
      (e: unknown) => live && setError(describeError(e)),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, write]);

  const refresh = () => {
    setRefreshing(true);
    setError(null);
    write(true)
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setRefreshing(false));
  };

  const ai = data?.ai;
  const settingsLink = role === "agent" ? "an admin can turn it on in Settings → AI" : <>turn it on in <DeskLink path="/settings/ai">Settings → AI</DeskLink></>;
  const off: ReactNode | null = !ai || ai.available
    ? null
    : ai.reason === "ai_off"
      ? <>The assistant needs the AI, which is off for this workspace: {settingsLink}.</>
      : <>{ai.message} {role === "agent" ? null : <DeskLink path="/settings/ai">Settings → AI</DeskLink>}</>;

  const started = useAskStarted(workspaceId);
  const askAbout = (question: string) => {
    askDesk(workspaceId, question);
    document.getElementById("ask-title")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };

  return (
    <div className="content wide home">
      {/* The brief on the left, the assistant docked on the right (stacked under it on narrow screens). */}
      <div className="home-main-col">
        {data ? <BriefView data={data} me={me.name} writing={writing} refreshing={refreshing} onRefresh={refresh} error={error} onAsk={off ? null : askAbout} /> : error ? <section className="digest"><DigestHead day={dayLabel(today())} /><div className="digest-sheet"><p className="error">{error}</p></div></section> : <BriefSkeleton me={me.name} />}
      </div>
      <section className="dash-card home-ask" aria-labelledby="ask-title">
        <div className="home-ask-head">
          <h2 id="ask-title" title="Chats, customers, errors, Reports, knowledge and the agent. Changes wait for your Confirm."><AsteriskIcon aria-hidden="true" />Assistant</h2>
          <div className="home-ask-tools">
            <button type="button" className="home-ask-tool" aria-label="New chat" title="New chat" disabled={!started} onClick={() => newAskChat(workspaceId)}><EditIcon /></button>
            {role !== "agent" && <a className="home-ask-tool" href={deskHref("/settings/ai")} aria-label="AI settings" title="AI settings" onClick={(e) => { e.preventDefault(); navigate("/settings/ai"); }}><SettingsIcon /></a>}
          </div>
        </div>
        {data ? <AskChat workspaceId={workspaceId} disabled={off} /> : <div className="home-chat empty"><div className="skel-composer"><SkelText width={220} /></div></div>}
      </section>
    </div>
  );
}
