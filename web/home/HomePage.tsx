import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Brief, BriefSection } from "../../shared/home-brief.ts";
import { api, describeError } from "../api.ts";
import { ArrowRightIcon, ChatIcon, RefreshIcon, SparkleIcon } from "../components/icons.tsx";
import { deskHref, navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import { SkelText } from "@/components/ui/skeleton.tsx";
import { AskChat, askDesk } from "./AskChat.tsx";

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

const SECTIONS: { id: BriefSection; label: string }[] = [
  { id: "yesterday", label: "Since yesterday" },
  { id: "needs", label: "Needs you" },
  { id: "unusual", label: "What's unusual" },
];

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

/** D-129 (after beautifului.dev's Insight Cards): a point's numbers in Geist Mono, the words as written. */
function withNumbers(text: string): ReactNode[] {
  return text.split(/(\d(?:[\d,.:]*\d)?(?:%|[hms]\b)?)/).map((part, i) => (i % 2 ? <span key={i} className="brief-num">{part}</span> : part));
}

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${name.split(/\s+/)[0]}`;
}

function BriefView({ data, writing, refreshing, onRefresh, error, onAsk }: { data: BriefResponse; writing: boolean; refreshing: boolean; onRefresh: () => void; error: string | null; onAsk: ((question: string) => void) | null }) {
  const { brief } = data;
  const time = new Date(brief.generatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const source = writing ? "Writing it up…" : brief.source === "ai" ? `Written by the AI from your desk's numbers at ${time}` : `From your desk's numbers at ${time}`;
  return (
    <section className="dash-card dash-hero home-brief" aria-labelledby="brief-title" aria-busy={writing || refreshing}>
      <div className="dash-card-head">
        <h2 id="brief-title">Today's brief</h2>
        <div className="home-brief-tools">
          <span className="dash-caption">{source}</span>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={writing || refreshing} title="Count everything again and write a new brief">
            <RefreshIcon className={refreshing ? "spin" : undefined} /> Refresh
          </Button>
        </div>
      </div>
      <p className={`brief-headline${writing ? " writing" : ""}`}>{brief.headline}</p>
      {error && <p className="error small">{error}</p>}
      <div className="brief-grid">
        {SECTIONS.map((section) => {
          const points = brief.points.filter((p) => p.section === section.id);
          if (!points.length) return null;
          return (
            <div key={section.id} className="brief-col">
              <h3>
                {section.label} <span className="brief-count">{points.length}</span>
              </h3>
              <ul className="brief-points">
                {points.map((p) => (
                  <li key={p.id} className={`brief-point ${p.tone}`}>
                    <span className="brief-mark" aria-hidden="true" />
                    <div className="brief-body">
                      <p>{withNumbers(p.text)}</p>
                      {(p.link || p.chats.length > 0 || (onAsk && !writing)) && (
                        <div className="brief-links">
                          {p.link && (
                            <DeskLink path={p.link.path} className="brief-link">
                              {p.link.label} <ArrowRightIcon aria-hidden="true" />
                            </DeskLink>
                          )}
                          {p.chats.slice(0, p.link?.path.startsWith("/inbox/") ? 0 : 3).map((id) => (
                            <DeskLink key={id} path={`/inbox/${id}`} className="brief-chat" title="Open this chat">
                              <ChatIcon aria-hidden="true" />
                              <span>{brief.chatNames?.[id] ?? "Chat"}</span>
                            </DeskLink>
                          ))}
                          {p.chats.length > 3 && !p.link?.path.startsWith("/inbox/") && <span className="brief-more">+{p.chats.length - 3}</span>}
                          {onAsk && !writing && (
                            <button type="button" data-plain className="brief-ask" title="Ask the assistant about this" onClick={() => onAsk(`Tell me more about this, and what I should do: “${p.text}”`)}>
                              <SparkleIcon aria-hidden="true" /> Ask
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BriefSkeleton() {
  return (
    <section className="dash-card dash-hero home-brief" aria-hidden="true">
      <div className="dash-card-head">
        <h2>Today's brief</h2>
        <div className="home-brief-tools"><span className="dash-caption"><SkelText width={180} /></span></div>
      </div>
      <p className="brief-headline"><SkelText width="min(520px, 90%)" /></p>
      <div className="brief-grid">
        {SECTIONS.map((section) => (
          <div key={section.id} className="brief-col">
            <h3>{section.label}</h3>
            <ul className="brief-points">
              {[0, 1].map((i) => (
                <li key={i} className="brief-point info">
                  <span className="brief-mark" />
                  <div className="brief-body">
                    <p><SkelText width="100%" /><br /><SkelText width="70%" /></p>
                    <div className="brief-links"><span className="brief-link"><SkelText width={80} /></span></div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
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

  const askAbout = (question: string) => {
    askDesk(workspaceId, question);
    document.getElementById("ask-title")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };

  return (
    <div className="content wide home">
      {/* The brief on the left, the assistant docked on the right (stacked under it on narrow screens). */}
      <div className="home-main-col">
        <div className="row reports-head home-head">
          <h1>Home</h1>
          <span className="home-greeting">{greeting(me.name)}</span>
        </div>
        {data ? <BriefView data={data} writing={writing} refreshing={refreshing} onRefresh={refresh} error={error} onAsk={off ? null : askAbout} /> : error ? <section className="dash-card dash-hero"><p className="error">{error}</p></section> : <BriefSkeleton />}
      </div>
      <section className="dash-card home-ask" aria-labelledby="ask-title">
        <div className="dash-card-head home-ask-head">
          <h2 id="ask-title"><SparkleIcon aria-hidden="true" />Ask about your desk</h2>
          <span className="dash-caption">Chats, customers, errors, Reports, knowledge and the agent. Changes wait for your Confirm.</span>
        </div>
        {data ? <AskChat workspaceId={workspaceId} disabled={off} /> : <div className="home-chat empty"><div className="skel-composer"><SkelText width={220} /></div></div>}
      </section>
    </div>
  );
}
