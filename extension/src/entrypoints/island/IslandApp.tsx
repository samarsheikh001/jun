// Jun for Chrome's chat (E-01): the widget's island (web/widget/island.tsx, D-39/D-46/D-78/D-80) in an
// extension frame at the bottom of the page, built from the widget's own parts: the Island shell and
// its pill, StatusLine, the answer view (AiAnswer: paced words, steps, the Confirm card), RunSteps and
// the pill Composer, drawn by widget.css on its near-black surface. The content script is its host
// (`jun:css` sizes and clips the frame, as the widget's loader does). The agent loop runs here
// (src/lib/agent.ts) against this tab; the chat is kept per tab in storage.session, so it comes back
// after a page load on sites the person allowed.
import type { ModelMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import type { ActionParam, MessageAction } from "../../../../shared/actions.ts";
import { Composer } from "../../../../web/components/Composer.tsx";
import { AiAnswer, RunSteps, runLine, type ActionControls } from "../../../../web/widget/answer.tsx";
import { Island, IslandChips, IslandControls, IslandRow, IslandTop, RestPill, StatusLine, type IslandSpot, type IslandState } from "../../../../web/widget/island.tsx";
import { runTurn, TurnError, type Decision } from "../../lib/agent.ts";
import { signedIn, signIn } from "../../lib/chatgpt.ts";
import { callPage, hasSiteAccess, islandTarget, requestSiteAccess, type NoTarget, type Target } from "../../lib/page.ts";
import type { ToolInfo } from "../../lib/protocol.ts";
import { DEFAULT_SETTINGS, KEYS_KEY, readKeys, readSettings, SETTINGS_KEY, type Keys, type Settings } from "../../lib/settings.ts";

/** One question and what came of it: the page steps it took and the words after the last one. */
interface Exchange {
  id: string;
  question: string;
  actions: MessageAction[];
  text: string;
  streaming: boolean;
  error: string | null;
  at: number;
}
interface Saved {
  exchanges: Exchange[];
  history: ModelMessage[];
}

const SUGGESTIONS = ["What can I do on this page?", "Show me where the settings are", "Explain this page simply"];
const PLACEHOLDER = "Ask about this page…";
/** The AI's history kept between questions (read_page results are big). */
const MAX_HISTORY = 60;

const toHost = (message: object) => window.parent.postMessage(message, "*");
const chatKey = (tabId: number) => `jun.chat.${tabId}`;
const isTarget = (t: Target | NoTarget | null): t is Target => !!t && "tabId" in t;
let ids = 0;
const nextId = () => `x${Date.now().toString(36)}${++ids}`;

/** A page tool's inputs as the Confirm card's fields (it only shows them; the AI filled them). */
function paramsOf(schema: Record<string, unknown>): Record<string, ActionParam> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const out: Record<string, ActionParam> = {};
  for (const [k, p] of Object.entries(props)) {
    const type = p.type === "integer" || p.type === "number" || p.type === "boolean" ? p.type : "string";
    out[k] = { type, ...(p.description ? { description: p.description } : {}) };
  }
  return out;
}

function toAction(id: string, info: ToolInfo | undefined, name: string, input: Record<string, unknown>): MessageAction {
  return {
    runId: id,
    id,
    name,
    description: info?.description ?? name,
    risk: info?.risk ?? "confirm",
    params: paramsOf(info?.inputSchema ?? {}),
    required: [],
    input,
    missing: [],
    status: "pending",
    result: null,
    canUndo: false,
    ...(info?.status ? { statusLine: info.status } : {}),
  };
}

/** The AI's history from the last ones, starting at a question (never mid-turn). */
function trimHistory(history: ModelMessage[]): ModelMessage[] {
  if (history.length <= MAX_HISTORY) return history;
  const tail = history.slice(-MAX_HISTORY);
  const start = tail.findIndex((m) => m.role === "user");
  return start >= 0 ? tail.slice(start) : [];
}

/** The folded pill's line: the last answer's first sentence, short. */
function summaryOf(ex: Exchange | undefined): string | null {
  const text = ex?.text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const first = text.split(/(?<=[.!?])\s/)[0]!;
  return first.length > 70 ? `${first.slice(0, 69)}…` : first;
}

export function IslandApp() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<Keys>({ openai: "" });
  const [account, setAccount] = useState<{ email: string } | null>(null);
  const [target, setTarget] = useState<Target | NoTarget | null>(null);
  const [kept, setKept] = useState(true);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [waitingId, setWaitingId] = useState<string | null>(null);
  const [runOpened, setRunOpened] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [spot, setSpot] = useState<IslandSpot>("center");
  const [notice, setNotice] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const history = useRef<ModelMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const decide = useRef<((d: Decision) => void) | null>(null);
  const allowNext = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const restored = useRef(false);

  // Settings, the sign-in, this tab and its chat; then tell the host we're here.
  useEffect(() => {
    void (async () => {
      const [s, who, t] = await Promise.all([browser.storage.local.get([SETTINGS_KEY, KEYS_KEY]), signedIn(), islandTarget()]);
      setSettings(readSettings(s[SETTINGS_KEY]));
      setKeys(readKeys(s[KEYS_KEY]));
      setAccount(who);
      setTarget(t);
      if (isTarget(t)) {
        setKept(await hasSiteAccess(t.site.pattern));
        const saved = (await browser.storage.session.get(chatKey(t.tabId)))[chatKey(t.tabId)] as Saved | undefined;
        if (saved?.exchanges?.length) {
          setExchanges(saved.exchanges);
          history.current = saved.history ?? [];
        }
      }
      restored.current = true;
      toHost({ type: "jun:ready" });
    })();
    const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== "local") return;
      if (changes[SETTINGS_KEY]) setSettings(readSettings(changes[SETTINGS_KEY].newValue));
      if (changes[KEYS_KEY]) setKeys(readKeys(changes[KEYS_KEY].newValue));
      if (changes["jun.chatgpt"]) void signedIn().then(setAccount);
    };
    browser.storage.onChanged.addListener(onStorage);
    const onMessage = (e: MessageEvent) => {
      if (e.source === window.parent && (e.data as { type?: string } | null)?.type === "jun:open") setOpen(true);
    };
    window.addEventListener("message", onMessage);
    return () => {
      browser.storage.onChanged.removeListener(onStorage);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  // Keep the chat for this tab (it comes back after a page load), once nothing is moving.
  useEffect(() => {
    if (!restored.current || busy || !isTarget(target)) return;
    void browser.storage.session.set({ [chatKey(target.tabId)]: { exchanges, history: history.current } satisfies Saved });
  }, [exchanges, busy, target]);

  const ready = settings.provider === "chatgpt" ? !!account : !!keys.openai;
  const update = (id: string, fn: (ex: Exchange) => Exchange) => setExchanges((all) => all.map((ex) => (ex.id === id ? fn(ex) : ex)));
  const updateAction = (exId: string, runId: string, fn: (a: MessageAction) => MessageAction) =>
    update(exId, (ex) => ({ ...ex, actions: ex.actions.map((a) => (a.runId === runId ? fn(a) : a)) }));

  async function send(text: string) {
    text = text.trim();
    if (!text || busy) return;
    setNotice(null);
    if (!ready) {
      setNotice(settings.provider === "chatgpt" ? "Sign in with ChatGPT first." : "Add your OpenAI API key in Settings first.");
      return;
    }
    const t = await islandTarget();
    setTarget(t);
    if (!isTarget(t)) {
      setNotice(t.problem === "restricted" ? "Jun can't work on this page." : "Click the Jun button in the toolbar again on this page.");
      return;
    }
    const exId = nextId();
    setExchanges((all) => [...all, { id: exId, question: text, actions: [], text: "", streaming: true, error: null, at: Date.now() }]);
    setBusy(true);
    setRunOpened(false);
    setShowAll(false);
    const controller = new AbortController();
    abort.current = controller;
    let tools: ToolInfo[] = [];
    try {
      const list = await callPage(t.tabId, { type: "jun:tools" });
      if (!list.ok) throw new TurnError(list.error === "no-access" ? "Jun can't see this page any more. Click the Jun button in the toolbar again." : "Jun couldn't start on this page. Reload it and try again.");
      tools = list.result as ToolInfo[];
      history.current = trimHistory(
        await runTurn({
          keys,
          settings: () => settingsRef.current,
          target: t,
          tools,
          history: history.current,
          text,
          signal: controller.signal,
          on: {
            text(delta) {
              update(exId, (ex) => ({ ...ex, text: ex.text + delta }));
            },
            step(step) {
              if (step.status === "running") {
                // A new step: the words so far were the AI saying what it'll do; the answer comes after.
                update(exId, (ex) => (ex.actions.some((a) => a.runId === step.id) ? ex : { ...ex, text: "", actions: [...ex.actions, toAction(step.id, tools.find((x) => x.name === step.name), step.name, step.input)] }));
                return;
              }
              setRunningId((r) => (r === step.id ? null : r));
              updateAction(exId, step.id, (a) => (a.status === "cancelled" ? a : { ...a, status: step.status === "done" ? "ok" : "error", result: step.result ?? null }));
            },
            running(id) {
              setRunningId(id);
            },
            confirm(request) {
              setWaitingId(request.id);
              allowNext.current = false;
              return new Promise<Decision>((resolve) => {
                const done = (d: Decision) => {
                  decide.current = null;
                  setWaitingId(null);
                  if (d === "no") updateAction(exId, request.id, (a) => ({ ...a, status: "cancelled" }));
                  resolve(d);
                };
                decide.current = done;
                controller.signal.addEventListener("abort", () => done("no"), { once: true });
              });
            },
          },
        }),
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof TurnError ? error.message : error instanceof Error ? `Something went wrong: ${error.message}` : "Something went wrong.";
        update(exId, (ex) => ({ ...ex, error: message }));
      }
    } finally {
      update(exId, (ex) => ({ ...ex, streaming: false, actions: ex.actions.map((a) => (a.status === "pending" ? { ...a, status: "cancelled" } : a)) }));
      abort.current = null;
      setBusy(false);
      setRunningId(null);
      setWaitingId(null);
      void callPage(t.tabId, { type: "jun:point", point: null });
    }
  }

  async function answer(d: Decision) {
    if (d === "always" && isTarget(target)) {
      const origin = target.site.origin;
      const next = { ...settingsRef.current, allowed: [...new Set([...settingsRef.current.allowed, origin])] };
      settingsRef.current = next;
      setSettings(next);
      await browser.storage.local.set({ [SETTINGS_KEY]: next });
    }
    decide.current?.(d);
  }

  function newChat() {
    abort.current?.abort();
    history.current = [];
    setExchanges([]);
    setShowAll(false);
    setOpen(false);
  }

  async function chatgpt() {
    setSigning(true);
    setNotice(null);
    try {
      setAccount(await signIn());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSigning(false);
    }
  }

  // ---------- what the island shows ----------
  const last = exchanges.at(-1);
  const waitingAction = last?.actions.find((a) => a.runId === waitingId) ?? null;
  const isRunning = (a: MessageAction) => a.runId === runningId;
  const streamText = last?.streaming ? last.text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim() : "";
  const streamLine = streamText && streamText.length <= 60 && !last!.text.includes("\n") && !runOpened ? streamText : null;
  const working = busy && !waitingAction && !runOpened && (!last?.text || Boolean(streamLine));
  const state: IslandState = !open ? "rest" : showAll ? "panel" : !last ? "open" : working ? "thinking" : "answer";
  const cardOnly = Boolean(waitingAction) && !runOpened;
  const label = streamLine ?? (last?.actions.length ? runLine(last.actions, isRunning, true).now : "Thinking…");
  const summary = summaryOf(last);
  const hug = state === "thinking" || (state === "rest" && Boolean(summary || waitingAction));
  const autoFold = open && state === "answer" && !busy && !waitingAction && last && !last.error ? () => setOpen(false) : null;

  const controls: ActionControls = {
    running: false,
    onInput: () => undefined,
    onRun: () => void answer(allowNext.current ? "always" : "yes"),
    onCancel: () => void answer("no"),
    onUndo: () => undefined,
    ...(settings.confirm === "allow-always" ? { onAllowAlways: () => void (allowNext.current = true) } : {}),
  };

  const row = (
    <IslandRow logoUrl={null}>
      <div className="w-composer-wrap">
        <Composer pill attach={false} placeholder={isTarget(target) ? PLACEHOLDER : "Click the Jun button on a website"} upload={() => Promise.reject(new Error("No uploads here"))} onSend={(body) => void send(body)} />
      </div>
    </IslandRow>
  );
  const corner = <IslandControls onEnd={exchanges.length ? newChat : () => toHost({ type: "jun:close" })} onMinimize={() => setOpen(false)} />;

  // Sign-in, lasting access to this site, and what went wrong: quiet chips over the row.
  const chips: { label: string; run: () => void; primary?: true }[] = [];
  if (!ready && settings.provider === "chatgpt") chips.push({ label: signing ? "Finish signing in in the new tab…" : "Sign in with ChatGPT", run: () => void chatgpt(), primary: true });
  if (!ready && settings.provider === "openai") chips.push({ label: "Add your API key", run: () => void browser.runtime.openOptionsPage(), primary: true });
  if (ready && isTarget(target) && !kept) chips.push({ label: `Keep Jun on ${target.site.host}`, run: () => void requestSiteAccess(target.site.pattern).then(setKept) });
  chips.push({ label: "Settings", run: () => void browser.runtime.openOptionsPage() });
  const foot = (
    <div className="i-foot" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", paddingTop: 8 }}>
      {chips.map((c) => (
        // The one step that's needed first (signing in) is a real button; the rest stay quiet chips.
        <button key={c.label} type="button" className={c.primary ? "w-act-btn" : "i-pill-chip"} disabled={signing && c.primary} onClick={c.run}>
          {c.label}
        </button>
      ))}
    </div>
  );

  const exchangeView = (ex: Exchange, latest: boolean) => {
    const steps = ex.actions.filter((a) => !(latest && a.runId === waitingId));
    return (
      <div key={ex.id}>
        <div className="msg own">
          <div className="bubble">{ex.question}</div>
        </div>
        <div className="msg other ai">
          {steps.length > 0 && <RunSteps actions={steps} isRunning={isRunning} busy={latest && busy} />}
          {ex.text && (
            <AiAnswer key={`${ex.id}:${ex.actions.length}`} answer={{ body: ex.text, sources: [], followUps: [], streaming: ex.streaming, latest, steps: [] }} cardTheme="dark" />
          )}
          {latest && waitingAction && (
            <AiAnswer answer={{ body: "", sources: [], followUps: [], streaming: false, latest: true, steps: [], action: waitingAction, createdAt: ex.at }} controls={controls} cardTheme="dark" />
          )}
          {ex.error && <p className="i-error" role="alert">{ex.error}</p>}
        </div>
      </div>
    );
  };

  return (
    <Island state={state} live={Boolean(last?.streaming && last.text)} onOpen={() => setOpen(true)} autoFold={autoFold} hug={hug} quiet={!waitingAction} spot={spot} onSpot={setSpot}>
      {state === "rest" && (
        <RestPill
          logoUrl={null}
          suggestions={SUGGESTIONS}
          placeholder={PLACEHOLDER}
          unread={null}
          summary={summary}
          chat={exchanges.length > 0}
          waiting={waitingAction ? "Confirm · tap to finish" : null}
          onOpen={() => setOpen(true)}
        />
      )}
      {state === "open" && (
        <div className="i-open">
          {ready && <IslandChips questions={SUGGESTIONS} onPick={(q) => void send(q)} />}
          {notice && <p className="i-error" role="alert">{notice}</p>}
          {foot}
          {row}
          {corner}
        </div>
      )}
      {state === "thinking" && <StatusLine logoUrl={null} label={label} onOpen={last?.actions.length ? () => setRunOpened(true) : undefined} />}
      {state === "answer" && last && (
        <div className={`i-answer${cardOnly ? " i-card" : ""}`}>
          <IslandTop who={null} view={cardOnly ? { label: "Show chat", run: () => setRunOpened(true) } : exchanges.length > 1 ? { label: "Earlier", run: () => setShowAll(true) } : null} exit={null} />
          <div className="i-body" role="log">
            {cardOnly && waitingAction ? (
              <AiAnswer answer={{ body: "", sources: [], followUps: [], streaming: false, latest: true, steps: [], action: waitingAction, createdAt: last.at }} controls={controls} cardTheme="dark" />
            ) : (
              exchangeView(last, true)
            )}
            {notice && <p className="i-error" role="alert">{notice}</p>}
          </div>
          {row}
          {corner}
        </div>
      )}
      {state === "panel" && (
        <div className="i-panel">
          <IslandTop who={null} view={{ label: "Latest", run: () => setShowAll(false) }} exit={null} />
          <div className="i-body i-log" role="log">
            {exchanges.map((ex, i) => exchangeView(ex, i === exchanges.length - 1))}
          </div>
          {row}
          {corner}
        </div>
      )}
    </Island>
  );
}
