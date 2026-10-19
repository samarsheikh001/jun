import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import {
  agentFileLink,
  bulkOutcome,
  isDeskLink,
  outcomeTitle,
  proposalCard,
  proposalRisk,
  type AskEvent,
  type AskStep,
  type AskTurn,
  type Proposal,
  type ProposalKind,
  type ProposalOutcome,
  type ProposedAction,
  type SettingChange,
} from "../../shared/desk-assistant.ts";
import { unifiedDiff } from "../../shared/line-diff.ts";
import { markdownToPlain, parseMarkdown, tokenCount } from "../../shared/markdown.ts";
import { ApiError } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { formatElapsed } from "../components/PixelLoader.tsx";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  BookOpenIcon,
  BotIcon,
  BugIcon,
  ChartColumnIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  ContactsIcon,
  CopyIcon,
  EditIcon,
  FileIcon,
  GlobeIcon,
  KeyIcon,
  MailIcon,
  NotificationIcon,
  PaletteIcon,
  RageClickIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  StopIcon,
  TagIcon,
  ToolIcon,
  UsersIcon,
} from "../components/icons.tsx";
import { addRecent, askKey, restoreAsk, serialiseAsk, type Turn } from "../lib/ask-store.ts";
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
import { runBulk, runProposal, type BulkRowState } from "./actions.ts";
import { BulkCard } from "./BulkCard.tsx";
import { RecordsTable } from "./RecordsTable.tsx";
import { AskInput, highlight, type AskInputHandle } from "./AskInput.tsx";
import { DeskLink } from "./DeskLink.tsx";

// I-19 (D-127): Home's ask box. A streamed chat with the desk assistant (POST …/home/ask, NDJSON): its
// read steps, answers that link to the desk's own pages, and a proposed change as a card with Confirm /
// Cancel (Confirm runs it through the desk's routes, actions.ts); either way the outcome goes back to the
// model, which carries on. The thread lives in a module store (leaving Home and coming back keeps it) and,
// D-132, in this browser's localStorage per workspace + member (lib/ask-store.ts), never on the server.
// D-129, after beautifului.dev's primitives (patterns, our own code): the steps are the desk's shared
// step trace (a live working line with the time, then "Worked for 4.2s · 3 steps" folding the rows),
// the answer is paced with desk links as inline source chips, then copy and "N sources"; a proposal is
// an approval card; the composer is a pill with a stop button while an answer streams.

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
  /** D-134: the running bulk card's rows. */
  bulkRows: Record<string, BulkRowState> | null;
}

const EMPTY: Thread = { turns: [], live: null, running: null, bulkRows: null };
const threads = new Map<string, Thread>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
/** D-132: each workspace's localStorage key (set by AskChat from the member), its recent questions. */
const keys = new Map<string, string>();
const recents = new Map<string, string[]>();
const recentListeners = new Set<() => void>();
const NO_RECENT: string[] = [];
let nextId = 1;
const get = (ws: string) => threads.get(ws) ?? EMPTY;
const set = (ws: string, patch: Partial<Thread>) => {
  threads.set(ws, { ...get(ws), ...patch });
  listeners.forEach((l) => l());
  const t = get(ws);
  // Saved once a turn is finished or a card settled: never the answer being written.
  if (!t.live && !t.running) save(ws);
};
function useThread(ws: string): Thread {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => get(ws));
}

function save(ws: string): void {
  const key = keys.get(ws);
  if (!key) return;
  try {
    localStorage.setItem(key, serialiseAsk(get(ws).turns, recents.get(ws) ?? []));
  } catch {
    // Storage full or blocked: the thread just doesn't outlive the tab.
  }
}

/** The member's thread from this browser, once per workspace, unless one is already in this tab. */
function bind(ws: string, userId: string): void {
  const key = askKey(ws, userId);
  if (keys.get(ws) === key) return;
  keys.set(ws, key);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    // No storage: start empty.
  }
  const stored = restoreAsk(raw, () => nextId++);
  recents.set(ws, stored.recent);
  recentListeners.forEach((l) => l());
  const t = get(ws);
  if (!t.turns.length && !t.live && stored.turns.length) set(ws, { turns: stored.turns });
}

function useRecent(ws: string): string[] {
  return useSyncExternalStore((cb) => (recentListeners.add(cb), () => recentListeners.delete(cb)), () => recents.get(ws) ?? NO_RECENT);
}

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** What the server gets back: the chat without local ids, steps or errors. */
const history = (turns: Turn[]): AskTurn[] =>
  turns.flatMap((t): AskTurn[] => (t.role === "error" ? [] : t.role === "user" ? [{ role: "user", text: t.text }] : [{ role: "assistant", text: t.text, ...(t.proposal ? { proposal: t.proposal } : {}), ...(t.outcome ? { outcome: { status: t.outcome.status, ...(t.outcome.detail ? { detail: t.outcome.detail } : {}) } } : {}) }]));

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
  let finished = false;
  const finish = (extra: Partial<AssistantTurn>, said: string) => {
    finished = true;
    set(ws, { turns: [...turns, { id: live.id, role: "assistant", text: said, took: Date.now() - live.startedAt, ...(steps.length ? { steps } : {}), ...(proposal ? { proposal } : {}), ...extra }], live: null });
  };
  const said = () => text || (rejected ? `I couldn't set that up: ${rejected}` : proposal ? "" : "I don't have an answer to that.");
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
        // D-134: the answer is finished at `done`; next questions may follow and go on its turn.
        if (event.type === "followups") {
          if (finished) set(ws, { turns: get(ws).turns.map((t) => (t.id === live.id && t.role === "assistant" ? { ...t, followUps: event.questions } : t)) });
          continue;
        }
        if (finished) continue;
        if (event.type === "text") text = event.text;
        else if (event.type === "step") steps = [...steps.filter((s) => s.id !== event.step.id), event.step];
        else if (event.type === "proposal") proposal = event.proposal;
        else if (event.type === "rejected") rejected = event.message;
        else if (event.type === "error") throw new Error(event.message);
        else if (event.type === "done") {
          done = true;
          finish({}, said());
          continue;
        }
        set(ws, { live: { ...live, text, steps } });
      }
    }
    if (!done) throw new Error("The answer stopped before it finished. Try again.");
  } catch (error) {
    if (finished) return;
    if (controller.signal.aborted) {
      // New chat cleared the thread: nothing to keep.
      if (controllers.get(ws) !== controller) return;
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
  recents.set(ws, addRecent(recents.get(ws) ?? [], text));
  recentListeners.forEach((l) => l());
  save(ws);
  void answer(ws, [...turns, { id: nextId++, role: "user", text: text.trim() }]);
}

const stop = (ws: string) => controllers.get(ws)?.abort();

/** The header's New chat: stops any answer and clears the thread. */
export function newAskChat(ws: string): void {
  stop(ws);
  controllers.delete(ws);
  set(ws, { turns: [], live: null, running: null, bulkRows: null });
}

/** Whether the thread has anything to clear (the header's New chat is off on an empty one). */
export const useAskStarted = (ws: string): boolean => {
  const t = useThread(ws);
  return t.turns.length > 0 || Boolean(t.live);
};

/** Confirm or Cancel on a card; then the model hears how it went and carries on. */
async function decide(ws: string, turnId: number, confirm: boolean, chosen?: string[]): Promise<void> {
  const t = get(ws);
  const turn = t.turns.find((x) => x.id === turnId);
  if (!turn || turn.role !== "assistant" || !turn.proposal || turn.outcome || t.running || t.live) return;
  let outcome: ProposalOutcome = { status: "cancelled" };
  if (confirm) {
    const action = turn.proposal;
    set(ws, { running: action.callId, bulkRows: action.proposal.kind === "bulk" ? {} : null });
    outcome =
      action.proposal.kind === "bulk" && chosen
        ? await runBulk(ws, action, chosen, (id, state) => set(ws, { bulkRows: { ...get(ws).bulkRows, [id]: state } }))
        : await runProposal(ws, action);
  }
  const turns = get(ws).turns.map((x) => (x.id === turnId ? ({ ...x, outcome } as Turn) : x));
  set(ws, { running: null, bulkRows: null, turns });
  void answer(ws, turns);
}

/** D-134: one failed chat of a settled bulk card again; the outcome the model gets next time is updated. */
async function retryBulkRow(ws: string, turnId: number, conversationId: string): Promise<void> {
  const turn = get(ws).turns.find((x) => x.id === turnId);
  if (!turn || turn.role !== "assistant" || turn.proposal?.proposal.kind !== "bulk" || !turn.outcome?.results) return;
  const action = turn.proposal;
  const again = await runBulk(ws, action, [conversationId], () => {});
  const row = again.results?.find((r) => r.conversationId === conversationId);
  if (!row) return;
  const current = get(ws).turns.find((x) => x.id === turnId);
  if (!current || current.role !== "assistant" || !current.outcome?.results) return;
  const results = current.outcome.results.map((r) => (r.conversationId === conversationId ? row : r));
  const outcome = bulkOutcome((action.proposal as Extract<Proposal, { kind: "bulk" }>).items, results);
  set(ws, { turns: get(ws).turns.map((x) => (x.id === turnId ? ({ ...x, outcome } as Turn) : x)) });
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
  read_settings: () => <SettingsIcon />,
  list_inbox_setup: () => <TagIcon />,
  read_knowledge_source: () => <BookOpenIcon />,
  run_tests: () => <CheckIcon />,
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

/** A card's icon by what it changes. */
function proposalIcon(kind: ProposalKind): ReactNode {
  if (kind === "assign" || kind.startsWith("team_")) return <UsersIcon />;
  if (kind === "status") return <CheckIcon />;
  if (kind === "handling" || kind === "agent_file" || kind === "ai_settings") return <BotIcon />;
  if (kind === "tags" || kind.startsWith("tag_") || kind.startsWith("topic_")) return <TagIcon />;
  if (kind === "note" || kind.startsWith("saved_reply_")) return <EditIcon />;
  if (kind === "reply_draft" || kind === "invite_visitor") return <ChatIcon />;
  if (kind === "issue") return <BugIcon />;
  if (kind === "contact") return <ContactsIcon />;
  if (kind.startsWith("knowledge_")) return <BookOpenIcon />;
  if (kind === "notifications") return <NotificationIcon />;
  if (kind.startsWith("email_")) return <MailIcon />;
  if (kind === "identity_off") return <KeyIcon />;
  if (kind === "desk_settings") return <PaletteIcon />;
  return <SettingsIcon />;
}

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

function Chip({ icon, children, tone, href, title }: { icon?: ReactNode; children: ReactNode; tone?: "add" | "remove"; href?: string; title?: string }) {
  const body = (
    <>
      {icon && <span className="ask-chip-icon" aria-hidden="true">{icon}</span>}
      <span className="ask-chip-text">{children}</span>
    </>
  );
  const cls = `ask-chip${tone ? ` ${tone}` : ""}`;
  return href ? <DeskLink href={href} className={cls} title={title ?? "Open"}>{body}</DeskLink> : <span className={cls}>{body}</span>;
}

/** Where a proposal's thing lives in the desk, for its chip. */
function targetHref(p: Proposal): string | undefined {
  if (p.kind === "contact") return `/contacts/${p.contactId}`;
  if (p.kind === "agent_file") return p.op === "delete" ? undefined : agentFileLink(p.path);
  if (p.kind.startsWith("knowledge_")) return "/knowledge";
  if (p.kind.startsWith("saved_reply_") || p.kind.startsWith("tag_")) return "/settings/inbox";
  if (p.kind.startsWith("topic_")) return "/dashboard/topics";
  if (p.kind.startsWith("team_")) return "/settings/team";
  return undefined;
}

/** What changes, as entity chips: the chat, then the tags, teammate, status, page or thing changed. */
function ProposalChips({ action }: { action: ProposedAction }) {
  const p = action.proposal;
  const { labels } = action;
  const chips: ReactNode[] = [];
  if ("conversationId" in p) chips.push(<Chip key="chat" icon={<ChatIcon />} href={`/inbox/${p.conversationId}`} title="Open this chat">{labels.conversation ?? "This chat"}</Chip>);
  if (p.kind === "assign") chips.push(<Chip key="who" icon={<UsersIcon />}>{p.assigneeId ? (labels.assignee ?? "a teammate") : "Nobody"}</Chip>);
  if (p.kind === "status") chips.push(<Chip key="status" icon={<CheckIcon />}>{p.status}</Chip>);
  if (p.kind === "handling") chips.push(<Chip key="handling" icon={p.handling === "ai" ? <BotIcon /> : <UsersIcon />}>{p.handling === "ai" ? "AI" : "Team"}</Chip>);
  if (p.kind === "tags") {
    for (const t of p.add) chips.push(<Chip key={`+${t}`} tone="add" icon={<TagIcon />}>+ {t}</Chip>);
    for (const t of p.remove) chips.push(<Chip key={`-${t}`} tone="remove" icon={<TagIcon />}>− {t}</Chip>);
  }
  if (p.kind === "knowledge_website") chips.push(<Chip key="url" icon={<GlobeIcon />}>{p.url}</Chip>, <Chip key="pages">{p.maxPages === 1 ? "1 page" : `up to ${p.maxPages} pages`}</Chip>);
  if (p.kind === "knowledge_text" || p.kind === "saved_reply_create") chips.push(<Chip key="title" icon={<FileIcon />}>{p.title}</Chip>);
  if (p.kind === "agent_file") chips.push(<Chip key="file" icon={<FileIcon />} href={targetHref(p)} title="Open on the Agent page">{p.path}</Chip>);
  if (labels.target && p.kind !== "workspace_name") chips.push(<Chip key="target" icon={proposalIcon(p.kind)} href={targetHref(p)}>{labels.target}</Chip>);
  if (p.kind === "tag_rename" || p.kind === "topic_rename") chips.push(<Chip key="name" tone="add" icon={<TagIcon />}>{p.name}</Chip>);
  if (p.kind === "topic_merge" && labels.detail) chips.push(<Chip key="into" tone="add" icon={<TagIcon />}>into {labels.detail}</Chip>);
  if ((p.kind === "knowledge_remove_page" || p.kind === "tag_delete") && labels.detail) chips.push(<Chip key="detail" tone={p.kind === "knowledge_remove_page" ? "remove" : undefined}>{labels.detail}</Chip>);
  if (p.kind === "team_invite" || p.kind === "team_role") chips.push(<Chip key="role" icon={<UsersIcon />}>{p.role}</Chip>);
  if (p.kind === "email_test") chips.push(<Chip key="to" icon={<MailIcon />}>{p.to ?? "your email"}</Chip>);
  return chips.length ? <div className="ask-chips">{chips}</div> : null;
}

/** Settings before → after, one row each. */
function ChangeRows({ changes }: { changes: SettingChange[] }) {
  return (
    <dl className="approval-changes">
      {changes.map((c) => (
        <div key={c.key}>
          <dt>{c.label}</dt>
          <dd>
            <span className="was">{c.before}</span>
            <span aria-label="becomes"> → </span>
            <span className="now">{c.after}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** An agent file's change as diff lines: added and removed lines coloured, hunks marked. */
function FileDiff({ path, before, after }: { path: string; before: string | null; after: string | null }) {
  const lines = useMemo(() => unifiedDiff(path, before, after).split("\n").slice(2), [path, before, after]);
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  return (
    <div className="approval-diff-wrap">
      <p className="approval-diff-count">
        <span className="add">+{added}</span> <span className="del">−{removed}</span> {added + removed === 1 ? "line" : "lines"}
      </p>
      <pre className="approval-diff" aria-label={`Changes to ${path}`}>
        {lines.map((line, i) => (
          <span key={i} className={line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : undefined}>
            {line.startsWith("@@") ? "⋯" : <><span className="sign" aria-hidden="true">{line[0] === " " ? "" : line[0] === "-" ? "−" : line[0]}</span>{line.slice(1)}</>}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

const clipped = (text: string) => (text.length > 600 ? `${text.slice(0, 599)}…` : text);

/** The card's body under its chips: the text that goes out, the settings that change, the file's diff. */
function ProposalBody({ action }: { action: ProposedAction }) {
  const p = action.proposal;
  switch (p.kind) {
    case "note":
    case "reply_draft":
    case "knowledge_text":
    case "saved_reply_create":
      return (
        <>
          <p className="approval-preview">{clipped(p.body)}</p>
          {p.kind === "reply_draft" && <p className="approval-hint">Nothing is sent: the chat opens with this in the composer, for you to edit and send.</p>}
        </>
      );
    case "invite_visitor":
      return <p className="approval-preview">{clipped(p.body)}</p>;
    case "agent_file":
      return <FileDiff path={p.path} before={p.before} after={p.after} />;
    case "contact":
    case "desk_settings":
    case "ai_settings":
    case "knowledge_edit":
    case "saved_reply_edit":
    case "notifications":
    case "email_settings":
      return <ChangeRows changes={p.changes} />;
    case "workspace_name":
      return <ChangeRows changes={[{ key: "name", label: "Name", before: action.labels.target ?? "", after: p.name }]} />;
    case "team_invite":
      return <p className="approval-hint">The link shows here after Confirm, for you to copy and send. It works once, for one person.</p>;
    default:
      return null;
  }
}

/** An invite link made by Confirm: shown here only (never sent to the assistant), with Copy. */
function InviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ask-invite-link">
      <code>{url}</code>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => {});
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function ProposalCard({ ws, turn, running, blocked, latest, bulkRows }: { ws: string; turn: AssistantTurn; running: boolean; blocked: boolean; latest: boolean; bulkRows: Record<string, BulkRowState> | null }) {
  const action = turn.proposal!;
  const p = action.proposal;
  if (p.kind === "bulk")
    return (
      <BulkCard
        action={action}
        outcome={turn.outcome}
        running={running}
        rows={bulkRows}
        blocked={blocked}
        latest={latest}
        onConfirm={(chosen) => settle(ws, turn.id, true, chosen)}
        onCancel={() => settle(ws, turn.id, false)}
        onRetry={(id) => retryBulkRow(ws, turn.id, id)}
      />
    );
  if (turn.outcome) {
    return (
      <>
        <ApprovalOutcome status={turn.outcome.status}>{outcomeTitle(p, action.labels, turn.outcome)}</ApprovalOutcome>
        {turn.outcome.link && <InviteLink url={turn.outcome.link} />}
      </>
    );
  }
  const { title, confirm } = proposalCard(p);
  const risk = proposalRisk(p);
  return (
    <ApprovalCard
      icon={proposalIcon(p.kind)}
      title={title}
      confirmLabel={confirm}
      running={running}
      disabled={blocked}
      autoFocus={latest}
      tone={risk?.tone}
      warning={risk?.line}
      onConfirm={() => settle(ws, turn.id, true)}
      onCancel={() => settle(ws, turn.id, false)}
    >
      <p className="approval-summary">{action.summary}</p>
      <ProposalChips action={action} />
      <ProposalBody action={action} />
    </ApprovalCard>
  );
}

/** Confirm or Cancel, then the keyboard goes back to the prompt bar. */
function settle(ws: string, turnId: number, confirm: boolean, chosen?: string[]) {
  document.querySelector<HTMLTextAreaElement>(".ask-bar textarea")?.focus({ preventScroll: true });
  void decide(ws, turnId, confirm, chosen);
}

/** D-134: the newest answer's next questions as chips; one asks it. */
function NextQuestions({ ws, questions, busy }: { ws: string; questions: string[]; busy: boolean }) {
  return (
    <div className="ask-next" role="group" aria-label="Ask next">
      {questions.map((q, i) => (
        <button key={q} type="button" data-plain className="ask-next-chip" style={{ animationDelay: `${i * 60}ms` }} disabled={busy} onClick={() => askDesk(ws, q)}>
          <ArrowRightIcon aria-hidden="true" />
          <span>{q}</span>
        </button>
      ))}
    </div>
  );
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
      {steps.map((s) => s.table && <RecordsTable key={`t-${s.id}`} table={s.table} />)}
      {text && <Answer text={text} streaming={Boolean(live)} />}
      {turn?.stopped && <p className="ask-stopped">Stopped</p>}
      {latest && turn && !turn.proposal && turn.followUps && turn.followUps.length > 0 && <NextQuestions ws={ws} questions={turn.followUps} busy={Boolean(thread.running)} />}
      {turn?.proposal && <ProposalCard ws={ws} turn={turn} running={thread.running === turn.proposal.callId} blocked={Boolean(thread.live || (thread.running && thread.running !== turn.proposal.callId))} latest={latest} bulkRows={thread.running === turn.proposal.callId ? thread.bulkRows : null} />}
    </>
  );
}

/** `userId`: the member, so the thread is kept in this browser for them (D-132); without it, this tab only. */
export function AskChat({ workspaceId, userId, disabled }: { workspaceId: string; userId?: string; disabled: ReactNode | null }) {
  // Before the first paint, so a reload opens on the kept thread.
  useLayoutEffect(() => {
    if (userId) bind(workspaceId, userId);
  }, [workspaceId, userId]);
  const thread = useThread(workspaceId);
  const recent = useRecent(workspaceId);
  const [message, setMessage] = useState("");
  const input = useRef<AskInputHandle>(null);
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
                      <div className="wchat-user">{highlight(turn.text)}</div>
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
        <div className="ask-empty">
          <p className="ask-intro">Ask about chats, customers, errors, Reports, knowledge or the agent. Changes wait for your Confirm.</p>
          {recent.length > 0 && (
            <div className="ask-recent" role="group" aria-labelledby="ask-recent-title">
              <h3 id="ask-recent-title">Recent</h3>
              <ul>
                {recent.map((q) => (
                  <li key={q}>
                    <button type="button" data-plain className="ask-recent-row" title={q} onClick={() => send(q)}>
                      <ClockIcon aria-hidden="true" />
                      <span>{q}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
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
        <AskInput
          ref={input}
          ws={workspaceId}
          value={message}
          onChange={setMessage}
          onSend={send}
          onNewChat={() => {
            newAskChat(workspaceId);
            input.current?.focus();
          }}
          disabled={Boolean(disabled)}
          placeholder={disabled ? "The assistant needs the AI on" : "Ask, @ to mention a chat or person, / for commands"}
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
