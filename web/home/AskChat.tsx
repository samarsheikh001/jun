import { useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { isDeskLink, type AskEvent, type AskStep, type AskTurn, type ProposalOutcome, type ProposedAction } from "../../shared/desk-assistant.ts";
import { parseMarkdown } from "../../shared/markdown.ts";
import { ApiError } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { PixelLoader } from "../components/PixelLoader.tsx";
import { ArrowUpIcon, CheckIcon, RefreshIcon, XIcon } from "../components/icons.tsx";
import { deskHref, navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller.tsx";
import { runProposal } from "./actions.ts";

// I-19 (D-127): Home's ask box. A streamed chat with the desk assistant (POST …/home/ask, NDJSON): its
// read steps show as one compact line each, answers link to the desk's own pages, and a proposed
// change is a card with Confirm / Cancel (Confirm runs it through the desk's routes, actions.ts);
// either way the outcome goes back to the model, which carries on. The thread lives for this tab's
// session (a module store, so leaving Home and coming back keeps it), never on the server.

type Turn = (AskTurn & { id: number }) | { id: number; role: "error"; text: string };

interface Thread {
  turns: Turn[];
  /** The answer being written. */
  live: { text: string; steps: AskStep[] } | null;
  /** A card being confirmed. */
  running: string | null;
}

const EMPTY: Thread = { turns: [], live: null, running: null };
const threads = new Map<string, Thread>();
const listeners = new Set<() => void>();
let nextId = 1;
const get = (ws: string) => threads.get(ws) ?? EMPTY;
const set = (ws: string, patch: Partial<Thread>) => {
  threads.set(ws, { ...get(ws), ...patch });
  listeners.forEach((l) => l());
};
function useThread(ws: string): Thread {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => get(ws));
}

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** What the server gets back: the chat without local ids, steps or errors. */
const history = (turns: Turn[]): AskTurn[] =>
  turns.flatMap((t): AskTurn[] => (t.role === "error" ? [] : t.role === "user" ? [{ role: "user", text: t.text }] : [{ role: "assistant", text: t.text, ...(t.proposal ? { proposal: t.proposal } : {}), ...(t.outcome ? { outcome: t.outcome } : {}) }]));

/** One answer from the assistant, after `turns` (which end with a question or a card's outcome). */
async function answer(ws: string, turns: Turn[]): Promise<void> {
  set(ws, { turns, live: { text: "", steps: [] } });
  let text = "";
  let steps: AskStep[] = [];
  let proposal: ProposedAction | undefined;
  let rejected: string | null = null;
  try {
    const response = await fetch(`/api/workspaces/${ws}/home/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tz: timezone(), turns: history(turns) }),
    });
    if (!response.ok || !response.body) {
      const json = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new ApiError(json.error?.code ?? "http_error", json.error?.message ?? `The assistant couldn't answer (${response.status}).`, response.status);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let done = false;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as AskEvent;
        if (event.type === "text") text = event.text;
        else if (event.type === "step") steps = [...steps.filter((s) => s.id !== event.step.id), event.step];
        else if (event.type === "proposal") proposal = event.proposal;
        else if (event.type === "rejected") rejected = event.message;
        else if (event.type === "error") throw new Error(event.message);
        else if (event.type === "done") done = true;
        set(ws, { live: { text, steps } });
      }
    }
    if (!done) throw new Error("The answer stopped before it finished. Try again.");
    const said = text || (rejected ? `I couldn't set that up: ${rejected}` : proposal ? "" : "I don't have an answer to that.");
    set(ws, { turns: [...turns, { id: nextId++, role: "assistant", text: said, ...(steps.length ? { steps } : {}), ...(proposal ? { proposal } : {}) }], live: null });
  } catch (error) {
    set(ws, { turns: [...turns, { id: nextId++, role: "error", text: (error as Error).message || "The assistant couldn't answer." }], live: null });
  }
}

/** A new question. A card nobody pressed is dropped (told to the model as not confirmed). */
function ask(ws: string, text: string): void {
  const t = get(ws);
  if (t.live || t.running || !text.trim()) return;
  const turns = t.turns.map((x): Turn => (x.role === "assistant" && x.proposal && !x.outcome ? { ...x, outcome: { status: "cancelled", detail: "not confirmed" } } : x));
  void answer(ws, [...turns, { id: nextId++, role: "user", text: text.trim() }]);
}

/** Confirm or Cancel on a card; then the model hears how it went and carries on. */
async function decide(ws: string, turnId: number, confirm: boolean): Promise<void> {
  const t = get(ws);
  const turn = t.turns.find((x) => x.id === turnId);
  if (!turn || turn.role !== "assistant" || !turn.proposal || turn.outcome || t.running || t.live) return;
  let outcome: ProposalOutcome = { status: "cancelled" };
  if (confirm) {
    set(ws, { running: turn.proposal.callId });
    outcome = await runProposal(ws, turn.proposal);
  }
  const turns = get(ws).turns.map((x) => (x.id === turnId ? { ...x, outcome } as Turn : x));
  set(ws, { running: null, turns });
  void answer(ws, turns);
}

const STARTERS = [
  "What should I look at today?",
  "Find chats where someone couldn't export",
  "What errors are visitors hitting on billing?",
  "Which knowledge gaps should I fix first?",
];

/** A desk link in an answer: a real href (new tabs keep the workspace), in-app on a plain click. */
function DeskLink({ href, children }: { href: string; children: ReactNode }) {
  if (!isDeskLink(href)) return <>{children}</>;
  return (
    <a
      className="md-a"
      href={deskHref(href)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

function Answer({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="md ask-text">
      <Markdown blocks={parseMarkdown(text, { streaming: Boolean(streaming), paths: isDeskLink })} cite={(n) => `[${n}]`} renderLink={(href, children) => <DeskLink href={href}>{children}</DeskLink>} />
    </div>
  );
}

function StepIcon({ status }: { status: AskStep["status"] }) {
  if (status === "running") return <span className="ask-step-dot" aria-hidden="true" />;
  return status === "done" ? <CheckIcon aria-hidden="true" /> : <XIcon aria-hidden="true" />;
}

/** The read steps: each its own line while they run; afterwards folded under "N steps" when there are several. */
function Steps({ steps, live }: { steps: AskStep[]; live?: boolean }) {
  if (!steps.length) return null;
  const list = (
    <ul className="ask-steps-list">
      {steps.map((s) => (
        <li key={s.id} className={`ask-step ${s.status}`}>
          <StepIcon status={s.status} />
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
  if (live || steps.length <= 2) return <div className="ask-steps">{list}</div>;
  return (
    <details className="ask-steps">
      <summary>{steps.length} steps · {steps.at(-1)!.label}</summary>
      {list}
    </details>
  );
}

function ProposalCard({ ws, turn, running }: { ws: string; turn: Extract<Turn, { role: "assistant" }>; running: boolean }) {
  const action = turn.proposal!;
  const p = action.proposal;
  const body = p.kind === "note" || p.kind === "reply_draft" ? p.body : p.kind === "knowledge_text" ? p.body : null;
  const outcome = turn.outcome;
  return (
    <div className={`ask-card${outcome ? ` ${outcome.status}` : ""}`} role="group" aria-label="Proposed change">
      <p className="ask-card-summary">{action.summary}</p>
      {body && <p className="ask-card-body">{body.length > 600 ? `${body.slice(0, 599)}…` : body}</p>}
      {p.kind === "note" && <p className="ask-card-hint">Internal note: your team sees it, the customer never does.</p>}
      {p.kind === "reply_draft" && <p className="ask-card-hint">Nothing is sent: the chat opens with this in the composer, for you to edit and send.</p>}
      {outcome ? (
        <p className="ask-card-outcome">
          {outcome.status === "done" ? <><CheckIcon aria-hidden="true" /> Done{outcome.detail ? `: ${outcome.detail}` : ""}</> : outcome.status === "failed" ? <><XIcon aria-hidden="true" /> Didn't work: {outcome.detail}</> : outcome.detail === "not confirmed" ? "Not confirmed" : "Cancelled"}
        </p>
      ) : (
        <div className="ask-card-actions">
          <Button size="sm" disabled={running} onClick={() => void decide(ws, turn.id, true)}>{running ? "Working…" : "Confirm"}</Button>
          <Button size="sm" variant="ghost" disabled={running} onClick={() => void decide(ws, turn.id, false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

export function AskChat({ workspaceId, disabled }: { workspaceId: string; disabled: ReactNode | null }) {
  const thread = useThread(workspaceId);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = Boolean(thread.live || thread.running);
  const send = (text: string) => {
    if (disabled || busy || !text.trim()) return;
    ask(workspaceId, text);
    setMessage("");
    input.current?.focus();
  };
  const lastQuestion = [...thread.turns].reverse().find((t) => t.role === "user");
  const empty = thread.turns.length === 0 && !thread.live;

  return (
    <div className={`home-chat${empty ? " empty" : ""}`}>
      {!empty && (
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
          <MessageScroller className="wchat-scroller">
            <MessageScrollerViewport aria-label="Chat with the desk assistant">
              <MessageScrollerContent className="wchat-rows" aria-busy={busy}>
                {thread.turns.map((turn) =>
                  turn.role === "user" ? (
                    <MessageScrollerItem key={turn.id} messageId={String(turn.id)} scrollAnchor className="wchat-row-user">
                      <div className="wchat-user">{turn.text}</div>
                    </MessageScrollerItem>
                  ) : turn.role === "error" ? (
                    <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai wchat-error">
                      <p>{turn.text}</p>
                      {lastQuestion && turn === thread.turns.at(-1) && (
                        <Button variant="ghost" size="sm" onClick={() => void answer(workspaceId, thread.turns.slice(0, -1))}>
                          <RefreshIcon /> Try again
                        </Button>
                      )}
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai ask-ai">
                      {turn.steps && <Steps steps={turn.steps} />}
                      {turn.text && <Answer text={turn.text} />}
                      {turn.proposal && <ProposalCard ws={workspaceId} turn={turn} running={thread.running === turn.proposal.callId} />}
                    </MessageScrollerItem>
                  ),
                )}
                {thread.live && (
                  <MessageScrollerItem messageId="live" className="wchat-ai ask-ai wchat-pending" role="status">
                    <Steps steps={thread.live.steps} live />
                    {thread.live.text ? <Answer text={thread.live.text} streaming /> : <PixelLoader label={thread.live.steps.length ? "Looking into it" : "Thinking"} />}
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
      {empty && !disabled && (
        <div className="ask-starters" role="group" aria-label="Try asking">
          {STARTERS.map((s) => (
            <button key={s} type="button" className="wchat-idea" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {disabled && <p className="ask-off">{disabled}</p>}
      <form
        className="wchat-composer ask-composer"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send(message);
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={message}
          disabled={Boolean(disabled)}
          placeholder={disabled ? "The assistant needs the AI on" : "Ask about chats, customers, errors, Reports…"}
          aria-label="Ask the desk assistant"
          maxLength={2000}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(message);
            }
          }}
        />
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={Boolean(disabled) || busy || !message.trim()}>
          <ArrowUpIcon />
        </Button>
      </form>
    </div>
  );
}
