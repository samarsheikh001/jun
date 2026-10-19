import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { isDeskLink, outcomeTitle, type AskEvent, type AskStep, type AskTurn, type ProposalOutcome, type ProposedAction } from "../../shared/desk-assistant.ts";
import { markdownToPlain, parseMarkdown, tokenCount } from "../../shared/markdown.ts";
import { ApiError } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { formatElapsed } from "../components/PixelLoader.tsx";
import {
  ArrowUpIcon,
  BookOpenIcon,
  BotIcon,
  BugIcon,
  ChartColumnIcon,
  ChatIcon,
  CheckIcon,
  ContactsIcon,
  CopyIcon,
  EditIcon,
  FileIcon,
  GlobeIcon,
  RageClickIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  StopIcon,
  TagIcon,
  ToolIcon,
  UsersIcon,
} from "../components/icons.tsx";
import { deskHref, navigate } from "../lib/router.ts";
import { ApprovalCard, ApprovalOutcome } from "@/components/approval-card.tsx";
import { Chevron, Fold, StepTrace, type TraceStep } from "@/components/agent-steps.tsx";
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
// read steps, answers that link to the desk's own pages, and a proposed change as a card with Confirm /
// Cancel (Confirm runs it through the desk's routes, actions.ts); either way the outcome goes back to the
// model, which carries on. The thread lives for this tab's session (a module store, so leaving Home and
// coming back keeps it), never on the server.
// D-129, after beautifului.dev's primitives (patterns, our own code): the steps are the desk's shared
// step trace (a live working line with the time, then "Worked for 4.2s · 3 steps" folding the rows),
// the answer is paced with desk links as inline source chips, then copy and "N sources"; a proposal is
// an approval card; the composer is a pill with a stop button while an answer streams.

type Turn = (AskTurn & { id: number; /** ms the answer took. */ took?: number; stopped?: boolean }) | { id: number; role: "error"; text: string };
type AssistantTurn = Extract<Turn, { role: "assistant" }>;

interface Live {
  /** The id the finished turn keeps, so the answer stays mounted and its reveal carries on. */
  id: number;
  text: string;
  steps: AskStep[];
  startedAt: number;
}

interface Thread {
  turns: Turn[];
  /** The answer being written. */
  live: Live | null;
  /** A card being confirmed. */
  running: string | null;
}

const EMPTY: Thread = { turns: [], live: null, running: null };
const threads = new Map<string, Thread>();
const controllers = new Map<string, AbortController>();
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
  const live: Live = { id: nextId++, text: "", steps: [], startedAt: Date.now() };
  const controller = new AbortController();
  controllers.set(ws, controller);
  set(ws, { turns, live });
  let text = "";
  let steps: AskStep[] = [];
  let proposal: ProposedAction | undefined;
  let rejected: string | null = null;
  const finish = (extra: Partial<AssistantTurn>, said: string) =>
    set(ws, { turns: [...turns, { id: live.id, role: "assistant", text: said, took: Date.now() - live.startedAt, ...(steps.length ? { steps } : {}), ...(proposal ? { proposal } : {}), ...extra }], live: null });
  try {
    const response = await fetch(`/api/workspaces/${ws}/home/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tz: timezone(), turns: history(turns) }),
      signal: controller.signal,
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
        set(ws, { live: { ...live, text, steps } });
      }
    }
    if (!done) throw new Error("The answer stopped before it finished. Try again.");
    finish({}, text || (rejected ? `I couldn't set that up: ${rejected}` : proposal ? "" : "I don't have an answer to that."));
  } catch (error) {
    if (controller.signal.aborted) {
      // Stopped: keep what was written; a card that wasn't shown yet is dropped.
      proposal = undefined;
      if (text || steps.length) finish({ stopped: true }, text);
      else set(ws, { live: null });
    } else {
      set(ws, { turns: [...turns, { id: nextId++, role: "error", text: (error as Error).message || "The assistant couldn't answer." }], live: null });
    }
  } finally {
    if (controllers.get(ws) === controller) controllers.delete(ws);
  }
}

/** A new question. A card nobody pressed is dropped (told to the model as not confirmed). */
export function askDesk(ws: string, text: string): void {
  const t = get(ws);
  if (t.live || t.running || !text.trim()) return;
  const turns = t.turns.map((x): Turn => (x.role === "assistant" && x.proposal && !x.outcome ? { ...x, outcome: { status: "cancelled", detail: "not confirmed" } } : x));
  void answer(ws, [...turns, { id: nextId++, role: "user", text: text.trim() }]);
}

const stop = (ws: string) => controllers.get(ws)?.abort();

/** The header's New chat: stops any answer and clears the thread. */
export function newAskChat(ws: string): void {
  stop(ws);
  set(ws, { turns: [], live: null, running: null });
}

/** Whether the thread has anything to clear (the header's New chat is off on an empty one). */
export const useAskStarted = (ws: string): boolean => {
  const t = useThread(ws);
  return t.turns.length > 0 || Boolean(t.live);
};

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
  const turns = get(ws).turns.map((x) => (x.id === turnId ? ({ ...x, outcome } as Turn) : x));
  set(ws, { running: null, turns });
  void answer(ws, turns);
}

const STARTERS = [
  "What should I look at today?",
  "Find chats where someone couldn't export",
  "What errors are visitors hitting on billing?",
  "Which knowledge gaps should I fix first?",
];

// ---------- icons by kind ----------

const TOOL_ICONS: Record<string, () => ReactNode> = {
  search_conversations: () => <SearchIcon />,
  find_contacts: () => <SearchIcon />,
  search_knowledge: () => <SearchIcon />,
  read_conversation: () => <ChatIcon />,
  debug_context: () => <BugIcon />,
  list_issues: () => <BugIcon />,
  report_metrics: () => <ChartColumnIcon />,
  topics_and_handoffs: () => <ChartColumnIcon />,
  struggle_spots: () => <RageClickIcon />,
  live_visitors: () => <GlobeIcon />,
  read_contact: () => <ContactsIcon />,
  read_company: () => <ContactsIcon />,
  list_knowledge: () => <BookOpenIcon />,
  list_agent_files: () => <BotIcon />,
  read_agent_file: () => <FileIcon />,
  list_teammates: () => <UsersIcon />,
};
const toolIcon = (tool: string) => (TOOL_ICONS[tool] ?? (() => <ToolIcon />))();

/** A desk path's icon, for source chips. */
function pathIcon(path: string): ReactNode {
  if (path.startsWith("/inbox")) return <ChatIcon />;
  if (path.startsWith("/contacts")) return <ContactsIcon />;
  if (path.startsWith("/dashboard")) return <ChartColumnIcon />;
  if (path.startsWith("/knowledge")) return <BookOpenIcon />;
  if (path.startsWith("/agent")) return <BotIcon />;
  if (path.startsWith("/visitors")) return <GlobeIcon />;
  if (path.startsWith("/settings")) return <SettingsIcon />;
  return <FileIcon />;
}

const PROPOSAL_ICONS: Record<ProposedAction["proposal"]["kind"], () => ReactNode> = {
  assign: () => <UsersIcon />,
  status: () => <CheckIcon />,
  tags: () => <TagIcon />,
  note: () => <EditIcon />,
  reply_draft: () => <ChatIcon />,
  issue: () => <BugIcon />,
  knowledge_website: () => <BookOpenIcon />,
  knowledge_text: () => <BookOpenIcon />,
};

// ---------- steps ----------

function traceSteps(steps: AskStep[]): TraceStep[] {
  return steps.map((s) => ({
    id: s.id,
    title: s.label,
    icon: toolIcon(s.tool),
    status: s.status,
    ...(s.status !== "running" && s.result && s.status !== "error" ? { chip: s.result } : {}),
    details: [
      ...(s.input ? [{ label: "Asked for", text: s.input, mono: true }] : []),
      ...(s.result ? [{ label: s.status === "error" ? "Error" : "Found", text: s.result, error: s.status === "error" }] : []),
    ],
  }));
}

function stepsHeader(steps: AskStep[], took?: number): ReactNode {
  const failed = steps.filter((s) => s.status === "error").length;
  const n = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return (
    <>
      {took ? `Worked for ${formatElapsed(took)} · ${n}` : n}
      {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
    </>
  );
}

/** The live line's words (the rows below say what each step is): none once the answer is being written. */
function workingLabel(live: Live): string | null {
  if (live.steps.some((s) => s.status === "running")) return `Working on it · step ${live.steps.length}`;
  if (live.text) return null;
  return live.steps.length ? "Putting it together" : "Thinking";
}

// ---------- the answer ----------

/** A desk link in an answer: a real href (new tabs keep the workspace), in-app on a plain click. */
function DeskLink({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a
      className={className}
      href={deskHref(href)}
      title={title}
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

/** A cited chat or page inline: its icon and the answer's own words for it. */
function SourceChip({ href, children }: { href: string; children: ReactNode }) {
  if (!isDeskLink(href)) return <>{children}</>;
  return (
    <DeskLink href={href} className="ask-src" title={href}>
      <span className="ask-src-icon" aria-hidden="true">{pathIcon(href)}</span>
      <span className="ask-src-text">{children}</span>
    </DeskLink>
  );
}

/** The desk pages an answer links to, once each, in order. */
function answerSources(text: string): { href: string; label: string }[] {
  const out: { href: string; label: string }[] = [];
  for (const m of text.matchAll(/\[([^\]\n]+)\]\((\/[^)\s]+)\)/g)) {
    const [, label, href] = m;
    if (isDeskLink(href!) && !out.some((s) => s.href === href)) out.push({ href: href!, label: label!.replace(/[*_`]/g, "") });
  }
  return out;
}

const TICK_MS = 45;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Tokens to show: paced while an answer streams in (the widget's pace), all at once for history. */
function useReveal(total: number, live: boolean): number {
  const [shown, setShown] = useState(() => (live && !reducedMotion() ? 0 : total));
  useEffect(() => {
    if (shown >= total) return;
    const t = setTimeout(() => setShown((s) => Math.min(total, s + Math.max(1, Math.ceil((total - s) / 10)))), TICK_MS);
    return () => clearTimeout(t);
  }, [shown, total]);
  return Math.min(shown, total);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" data-plain className="ask-icon-btn" aria-label={copied ? "Copied" : "Copy answer"} title={copied ? "Copied" : "Copy"} onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function Sources({ sources }: { sources: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-plain className="ask-sources-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ask-stack" aria-hidden="true">
          {sources.slice(0, 3).map((s) => (
            <span key={s.href}>{pathIcon(s.href)}</span>
          ))}
        </span>
        {sources.length} source{sources.length === 1 ? "" : "s"}
        <Chevron open={open} />
      </button>
      <div className="ask-sources-panel">
        <Fold open={open}>
          <ul className="ask-sources">
            {sources.map((s) => (
              <li key={s.href}>
                <DeskLink href={s.href} className="ask-source">
                  <span className="ask-src-icon" aria-hidden="true">{pathIcon(s.href)}</span>
                  <span className="ask-source-label">{s.label}</span>
                  <span className="ask-source-path">{s.href}</span>
                </DeskLink>
              </li>
            ))}
          </ul>
        </Fold>
      </div>
    </>
  );
}

function Answer({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text, { streaming, paths: isDeskLink }), [text, streaming]);
  const total = tokenCount(blocks);
  const [live] = useState(streaming);
  const shown = useReveal(total, live);
  const done = !streaming && shown >= total;
  const sources = useMemo(() => (done ? answerSources(text) : []), [done, text]);
  return (
    <>
      <div className="md ask-text">
        <Markdown
          blocks={blocks}
          shown={shown}
          wordClass={live ? "ask-word" : undefined}
          cite={(n) => `[${n}]`}
          renderLink={(href, children) => <SourceChip href={href}>{children}</SourceChip>}
          tail={!done && <span className="ask-caret" aria-hidden="true" />}
        />
      </div>
      {done && (
        <div className="ask-tools">
          <CopyButton text={markdownToPlain(text)} />
          {/* One source is already the chip in the text; the list earns its place from two. */}
          {sources.length > 1 && <Sources sources={sources} />}
        </div>
      )}
    </>
  );
}

// ---------- proposals ----------

const CARD_COPY: Record<ProposedAction["proposal"]["kind"], [string, string]> = {
  assign: ["Assign this chat?", "Assign"],
  status: ["Change this chat's status?", "Change status"],
  tags: ["Change this chat's tags?", "Update tags"],
  note: ["Add an internal note?", "Add note"],
  reply_draft: ["Open a reply draft?", "Open draft"],
  issue: ["Draft an issue from this chat?", "Open issue dialog"],
  knowledge_website: ["Add this site to the knowledge?", "Add website"],
  knowledge_text: ["Add this document to the knowledge?", "Add document"],
};

function Chip({ icon, children, tone, href }: { icon?: ReactNode; children: ReactNode; tone?: "add" | "remove"; href?: string }) {
  const body = (
    <>
      {icon && <span className="ask-chip-icon" aria-hidden="true">{icon}</span>}
      <span className="ask-chip-text">{children}</span>
    </>
  );
  const cls = `ask-chip${tone ? ` ${tone}` : ""}`;
  return href ? <DeskLink href={href} className={cls} title="Open this chat">{body}</DeskLink> : <span className={cls}>{body}</span>;
}

/** What changes, as entity chips: the chat, then the tags, teammate, status or page. */
function ProposalChips({ action }: { action: ProposedAction }) {
  const p = action.proposal;
  const chips: ReactNode[] = [];
  if ("conversationId" in p) chips.push(<Chip key="chat" icon={<ChatIcon />} href={`/inbox/${p.conversationId}`}>{action.labels.conversation ?? "This chat"}</Chip>);
  if (p.kind === "assign") chips.push(<Chip key="who" icon={<UsersIcon />}>{p.assigneeId ? (action.labels.assignee ?? "a teammate") : "Nobody"}</Chip>);
  if (p.kind === "status") chips.push(<Chip key="status" icon={<CheckIcon />}>{p.status}</Chip>);
  if (p.kind === "tags") {
    for (const t of p.add) chips.push(<Chip key={`+${t}`} tone="add" icon={<TagIcon />}>+ {t}</Chip>);
    for (const t of p.remove) chips.push(<Chip key={`-${t}`} tone="remove" icon={<TagIcon />}>− {t}</Chip>);
  }
  if (p.kind === "knowledge_website") chips.push(<Chip key="url" icon={<GlobeIcon />}>{p.url}</Chip>, <Chip key="pages">{p.maxPages === 1 ? "1 page" : `up to ${p.maxPages} pages`}</Chip>);
  if (p.kind === "knowledge_text") chips.push(<Chip key="title" icon={<FileIcon />}>{p.title}</Chip>);
  return chips.length ? <div className="ask-chips">{chips}</div> : null;
}

function ProposalCard({ ws, turn, running, blocked, latest }: { ws: string; turn: AssistantTurn; running: boolean; blocked: boolean; latest: boolean }) {
  const action = turn.proposal!;
  const p = action.proposal;
  const body = p.kind === "note" || p.kind === "reply_draft" || p.kind === "knowledge_text" ? p.body : null;
  if (turn.outcome) return <ApprovalOutcome status={turn.outcome.status}>{outcomeTitle(p, action.labels, turn.outcome)}</ApprovalOutcome>;
  const [title, confirmLabel] = CARD_COPY[p.kind];
  return (
    <ApprovalCard
      icon={PROPOSAL_ICONS[p.kind]()}
      title={title}
      confirmLabel={confirmLabel}
      running={running}
      disabled={blocked}
      autoFocus={latest}
      onConfirm={() => settle(ws, turn.id, true)}
      onCancel={() => settle(ws, turn.id, false)}
    >
      <p className="approval-summary">{action.summary}</p>
      <ProposalChips action={action} />
      {body && <p className="approval-preview">{body.length > 600 ? `${body.slice(0, 599)}…` : body}</p>}
      {p.kind === "reply_draft" && <p className="approval-hint">Nothing is sent: the chat opens with this in the composer, for you to edit and send.</p>}
    </ApprovalCard>
  );
}

/** Confirm or Cancel, then the keyboard goes back to the prompt bar. */
function settle(ws: string, turnId: number, confirm: boolean) {
  document.querySelector<HTMLTextAreaElement>(".ask-bar textarea")?.focus({ preventScroll: true });
  void decide(ws, turnId, confirm);
}

// ---------- the turn ----------

/** One answer, live or finished (the same component, so its reveal carries on when it finishes). */
function AssistantRow({ ws, turn, live, thread, latest }: { ws: string; turn: AssistantTurn | null; live: Live | null; thread: Thread; latest: boolean }) {
  const steps = live?.steps ?? turn?.steps ?? [];
  const text = live?.text ?? turn?.text ?? "";
  const working = live ? workingLabel(live) : null;
  return (
    <>
      {(steps.length > 0 || working) && <StepTrace steps={traceSteps(steps)} working={working} since={live?.startedAt} header={stepsHeader(steps, turn?.took)} />}
      {text && <Answer text={text} streaming={Boolean(live)} />}
      {turn?.stopped && <p className="ask-stopped">Stopped</p>}
      {turn?.proposal && <ProposalCard ws={ws} turn={turn} running={thread.running === turn.proposal.callId} blocked={Boolean(thread.live || (thread.running && thread.running !== turn.proposal.callId))} latest={latest} />}
    </>
  );
}

export function AskChat({ workspaceId, disabled }: { workspaceId: string; disabled: ReactNode | null }) {
  const thread = useThread(workspaceId);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const streaming = Boolean(thread.live);
  const busy = Boolean(thread.live || thread.running);
  const send = (text: string) => {
    if (disabled || busy || !text.trim()) return;
    askDesk(workspaceId, text);
    setMessage("");
    input.current?.focus();
  };
  const lastQuestion = [...thread.turns].reverse().find((t) => t.role === "user");
  const empty = thread.turns.length === 0 && !thread.live;
  const lastTurn = thread.turns.at(-1);

  return (
    <div className={`home-chat${empty ? " empty" : ""}`}>
      {!empty && (
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
          <MessageScroller className="wchat-scroller">
            <MessageScrollerViewport aria-label="Chat with the desk assistant">
              <MessageScrollerContent className="wchat-rows" aria-busy={busy}>
                {/* One list, so the live answer keeps its place (and its reveal) when it becomes a turn. */}
                {[...thread.turns, ...(thread.live ? [thread.live] : [])].map((turn) =>
                  !("role" in turn) ? (
                    <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai ask-ai">
                      <AssistantRow ws={workspaceId} turn={null} live={turn} thread={thread} latest={false} />
                    </MessageScrollerItem>
                  ) : turn.role === "user" ? (
                    <MessageScrollerItem key={turn.id} messageId={String(turn.id)} scrollAnchor className="wchat-row-user">
                      <div className="wchat-user">{turn.text}</div>
                    </MessageScrollerItem>
                  ) : turn.role === "error" ? (
                    <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai wchat-error">
                      <p>{turn.text}</p>
                      {lastQuestion && turn === lastTurn && (
                        <Button variant="ghost" size="sm" onClick={() => void answer(workspaceId, thread.turns.slice(0, -1))}>
                          <RefreshIcon /> Try again
                        </Button>
                      )}
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai ask-ai">
                      <AssistantRow ws={workspaceId} turn={turn} live={null} thread={thread} latest={turn === lastTurn && !thread.live} />
                    </MessageScrollerItem>
                  ),
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
            <button key={s} type="button" data-plain className="ask-starter" onClick={() => send(s)}>
              <SearchIcon aria-hidden="true" />
              {s}
            </button>
          ))}
        </div>
      )}
      {disabled && <p className="ask-off">{disabled}</p>}
      <form
        className="ask-bar"
        data-disabled={disabled ? "" : undefined}
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
        {streaming ? (
          <Button type="button" size="icon-sm" aria-label="Stop" title="Stop" onClick={() => stop(workspaceId)}>
            <StopIcon />
          </Button>
        ) : (
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={Boolean(disabled) || busy || !message.trim()}>
            <ArrowUpIcon />
          </Button>
        )}
      </form>
    </div>
  );
}
