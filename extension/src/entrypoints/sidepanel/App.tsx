// Jun for Chrome's side panel (E-01): the chat, the Confirm card and the settings. The agent loop
// runs here (src/lib/agent.ts) against the active tab; nothing goes anywhere but the person's AI.
import type { ModelMessage } from "ai";
import { useEffect, useRef, useState } from "preact/hooks";
import { shownDescription, shownInput } from "../../../../shared/page-control.ts";
import { runTurn, TurnError, type Decision, type StepEvent } from "../../lib/agent.ts";
import { signedIn, signIn, signOut } from "../../lib/chatgpt.ts";
import { callPage, currentTarget, hasSiteAccess, requestSiteAccess, type NoTarget, type Target } from "../../lib/page.ts";
import type { ToolInfo } from "../../lib/protocol.ts";
import { DEFAULT_MODELS, DEFAULT_SETTINGS, KEYS_KEY, readKeys, readSettings, SETTINGS_KEY, type ConfirmMode, type Keys, type Provider, type Settings } from "../../lib/settings.ts";

type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "ai"; id: string; text: string }
  | { kind: "step"; id: string; step: StepEvent }
  | { kind: "confirm"; id: string; name: string; input: Record<string, unknown>; description: string; state: "waiting" | Decision }
  | { kind: "error"; id: string; text: string };

const SUGGESTIONS = ["What can I do on this page?", "How do I change my settings here?", "Where do I find my account?"];
const CONFIRM_LABELS: Record<ConfirmMode, string> = {
  "allow-always": "Ask, with “Always allow on this site”",
  "every-time": "Ask every time",
  never: "Never ask",
};

/** Whether the chosen AI can answer: signed in with ChatGPT, or an API key. */
const ready = (s: Settings, k: Keys, account: { email: string } | null) => (s.provider === "chatgpt" ? !!account : !!k.openai);

let ids = 0;
const nextId = () => `i${++ids}`;
const isTarget = (t: Target | NoTarget | null): t is Target => !!t && "tabId" in t;

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<Keys>({ openai: "" });
  const [loaded, setLoaded] = useState(false);
  const [account, setAccount] = useState<{ email: string } | null>(null); // signed in with ChatGPT
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [target, setTarget] = useState<Target | NoTarget | null>(null);
  const [kept, setKept] = useState(true); // lasting access to the target's site
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<ModelMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const answers = useRef(new Map<string, (d: Decision) => void>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void Promise.all([browser.storage.local.get([SETTINGS_KEY, KEYS_KEY]), signedIn()]).then(([s, who]) => {
      const loadedKeys = readKeys(s[KEYS_KEY]);
      const loadedSettings = readSettings(s[SETTINGS_KEY]);
      setSettings(loadedSettings);
      setKeys(loadedKeys);
      setAccount(who);
      if (!ready(loadedSettings, loadedKeys, who)) setView("settings");
      setLoaded(true);
    });
  }, []);

  // Which page the panel works on: the window's active tab, looked at again when it changes.
  useEffect(() => {
    let timer = 0;
    const look = () => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const t = await currentTarget();
        setTarget(t);
        setKept(isTarget(t) ? await hasSiteAccess(t.site.pattern) : true);
      }, 100);
    };
    look();
    const onUpdated = (_id: number, change: { url?: string; status?: string }) => (change.url || change.status === "complete" ? look() : undefined);
    const onMessage = (m: unknown) => ((m as { type?: string } | null)?.type === "jun:clicked" ? look() : undefined);
    browser.tabs.onActivated.addListener(look);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.runtime.onMessage.addListener(onMessage);
    window.addEventListener("focus", look);
    return () => {
      browser.tabs.onActivated.removeListener(look);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener("focus", look);
    };
  }, []);

  useEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [items]);

  async function save(next: Settings, nextKeys = keys) {
    settingsRef.current = next;
    setSettings(next);
    setKeys(nextKeys);
    await browser.storage.local.set({ [SETTINGS_KEY]: next, [KEYS_KEY]: nextKeys });
  }

  const update = (id: string, fn: (item: Item) => Item) => setItems((all) => all.map((i) => (i.id === id ? fn(i) : i)));

  async function send(text: string) {
    text = text.trim();
    if (!text || busy) return;
    if (!ready(settingsRef.current, keys, account)) return setView("settings");
    const t = await currentTarget();
    setTarget(t);
    if (!isTarget(t)) return;
    setDraft("");
    setBusy(true);
    setItems((all) => [...all, { kind: "user", id: nextId(), text }]);
    const controller = new AbortController();
    abort.current = controller;
    let aiId = "";
    try {
      const tools = await callPage(t.tabId, { type: "jun:tools" });
      if (!tools.ok) throw new TurnError(tools.error === "no-access" ? "Jun can't see this page. Click the Jun button in the toolbar on it, then ask again." : "Jun couldn't start on this page. Reload it and try again.");
      history.current = await runTurn({
        keys,
        settings: () => settingsRef.current,
        target: t,
        tools: tools.result as ToolInfo[],
        history: history.current,
        text,
        signal: controller.signal,
        on: {
          text(delta) {
            if (!aiId) {
              aiId = nextId();
              const id = aiId;
              setItems((all) => [...all, { kind: "ai", id, text: delta }]);
            } else update(aiId, (i) => (i.kind === "ai" ? { ...i, text: i.text + delta } : i));
          },
          step(step) {
            aiId = ""; // text after a step is a new bubble
            setItems((all) => (all.some((i) => i.id === step.id) ? all.map((i) => (i.id === step.id && i.kind === "step" ? { ...i, step } : i)) : [...all, { kind: "step", id: step.id, step }]));
          },
          confirm(request) {
            aiId = "";
            const id = `c-${request.id}`;
            setItems((all) => [...all, { kind: "confirm", id, name: request.name, input: request.input, description: request.description, state: "waiting" }]);
            return new Promise<Decision>((resolve) => {
              const done = (d: Decision) => {
                answers.current.delete(id);
                update(id, (i) => (i.kind === "confirm" ? { ...i, state: d } : i));
                resolve(d);
              };
              answers.current.set(id, done);
              controller.signal.addEventListener("abort", () => done("no"), { once: true });
            });
          },
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        const text = error instanceof TurnError ? error.message : error instanceof Error ? `Something went wrong: ${error.message}` : "Something went wrong.";
        setItems((all) => [...all, { kind: "error", id: nextId(), text }]);
      }
    } finally {
      abort.current = null;
      setBusy(false);
      void callPage(t.tabId, { type: "jun:point", point: null });
    }
  }

  async function answer(id: string, decision: Decision) {
    if (decision === "always" && isTarget(target)) {
      const origin = target.site.origin;
      if (!settings.allowed.includes(origin)) await save({ ...settings, allowed: [...settings.allowed, origin] });
    }
    answers.current.get(id)?.(decision);
  }

  function newChat() {
    abort.current?.abort();
    history.current = [];
    setItems([]);
  }

  if (!loaded) return <div class="app" />;

  return (
    <div class="app">
      <header class="top">
        <div class="brand">
          <span class="logo">J</span>
          <div>
            <div class="name">Jun</div>
            <div class="sub">{isTarget(target) ? target.site.host : "Help on any page"}</div>
          </div>
        </div>
        <div class="actions">
          {view === "chat" && items.length > 0 && (
            <button class="ghost" onClick={newChat} title="New chat">
              New
            </button>
          )}
          <button class="ghost" onClick={() => setView(view === "chat" ? "settings" : "chat")}>
            {view === "chat" ? "Settings" : "Done"}
          </button>
        </div>
      </header>

      {view === "settings" ? (
        <SettingsView settings={settings} keys={keys} account={account} onAccount={setAccount} onSave={save} onDone={() => setView("chat")} />
      ) : (
        <>
          <Access target={target} kept={kept} onKeep={async (pattern) => setKept(await requestSiteAccess(pattern))} />
          <div class="list" ref={list}>
            {items.length === 0 ? (
              <div class="empty">
                <p class="hello">Ask how to do anything on this page.</p>
                <p class="muted">Jun reads the page, shows you where things are, and does steps for you after you confirm.</p>
                <div class="chips">
                  {SUGGESTIONS.map((s) => (
                    <button class="chip" key={s} disabled={!isTarget(target) || busy} onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              items.map((item) => <Row key={item.id} item={item} onAnswer={answer} />)
            )}
            {busy && !items.some((i) => i.kind === "confirm" && i.state === "waiting") && <div class="thinking">Working…</div>}
          </div>
          <form
            class="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <textarea
              value={draft}
              rows={2}
              placeholder={isTarget(target) ? "Ask about this page…" : "Open a website to ask about it"}
              disabled={!isTarget(target)}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
            />
            {busy ? (
              <button type="button" class="primary" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" class="primary" disabled={!draft.trim() || !isTarget(target)}>
                Send
              </button>
            )}
          </form>
          <p class="foot">{settings.mask ? "Masked: emails, card numbers and tokens are hidden from the AI." : "Not masked: the page's text goes to your AI as it is."} Passwords and card fields are never read.</p>
        </>
      )}
    </div>
  );
}

function Access(props: { target: Target | NoTarget | null; kept: boolean; onKeep: (pattern: string) => void }) {
  const { target } = props;
  if (!target) return null;
  if (!isTarget(target)) {
    const text =
      target.problem === "restricted"
        ? "Jun can't work on the browser's own pages or the Chrome Web Store."
        : "Open a website, then click the Jun button in the toolbar so Jun can see it.";
    return <div class="note">{text}</div>;
  }
  if (props.kept) return null;
  return (
    <div class="note">
      Jun can see this page until you leave it.{" "}
      <button class="link" onClick={() => props.onKeep(target.site.pattern)}>
        Allow on {target.site.host}
      </button>{" "}
      to keep helping across its pages.
    </div>
  );
}

function Row(props: { item: Item; onAnswer: (id: string, d: Decision) => void }) {
  const { item } = props;
  if (item.kind === "user") return <div class="msg user">{item.text}</div>;
  if (item.kind === "ai") return <div class="msg ai">{item.text}</div>;
  if (item.kind === "error") return <div class="msg error">{item.text}</div>;
  if (item.kind === "step") {
    const { step } = item;
    const shown = shownInput({ name: step.name, input: step.input });
    const label = typeof shown.label === "string" ? ` · ${shown.label}` : "";
    return (
      <div class={`step ${step.status}`} title={step.result ?? ""}>
        <span class="dot" />
        <span>
          {step.label}
          {label}
          {step.status === "error" && step.result ? `: ${step.result}` : ""}
        </span>
      </div>
    );
  }
  const shown = shownInput({ name: item.name, input: item.input });
  const waiting = item.state === "waiting";
  return (
    <div class={`confirm ${waiting ? "" : "settled"}`}>
      <div class="title">{shownDescription({ name: item.name, description: item.description })}</div>
      <dl>
        {Object.entries(shown).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
      {waiting ? (
        <div class="buttons">
          <button class="primary" onClick={() => props.onAnswer(item.id, "yes")}>
            Confirm
          </button>
          <button class="ghost" onClick={() => props.onAnswer(item.id, "no")}>
            Cancel
          </button>
          <button class="link" onClick={() => props.onAnswer(item.id, "always")}>
            Always allow on this site
          </button>
        </div>
      ) : (
        <div class="muted">{item.state === "no" ? "Cancelled" : "Confirmed"}</div>
      )}
    </div>
  );
}

function SettingsView(props: {
  settings: Settings;
  keys: Keys;
  account: { email: string } | null;
  onAccount: (a: { email: string } | null) => void;
  onSave: (s: Settings, k: Keys) => Promise<void>;
  onDone: () => void;
}) {
  const [provider, setProvider] = useState<Provider>(props.settings.provider);
  const [key, setKey] = useState(props.keys.openai);
  const [model, setModel] = useState(props.settings.model);
  const [mask, setMask] = useState(props.settings.mask);
  const [confirm, setConfirm] = useState<ConfirmMode>(props.settings.confirm);
  const [signing, setSigning] = useState(false);
  const [problem, setProblem] = useState("");
  const canAnswer = (p: Provider) => (p === "chatgpt" ? !!props.account : !!key.trim());

  const settingsNow = (p = provider) => readSettings({ ...props.settings, provider: p, model, mask, confirm });

  async function submit(e: Event) {
    e.preventDefault();
    await props.onSave(settingsNow(), { openai: key.trim() });
    if (canAnswer(provider)) props.onDone();
  }

  async function chatgpt() {
    setSigning(true);
    setProblem("");
    try {
      const who = await signIn();
      props.onAccount(who);
      setProvider("chatgpt");
      await props.onSave(settingsNow("chatgpt"), { openai: key.trim() });
      props.onDone();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSigning(false);
    }
  }

  return (
    <form class="settings" onSubmit={submit}>
      <div class="field">
        <span class="label">Your AI</span>
        <div class="seg">
          <button type="button" class={provider === "chatgpt" ? "on" : ""} onClick={() => setProvider("chatgpt")}>
            ChatGPT
          </button>
          <button type="button" class={provider === "openai" ? "on" : ""} onClick={() => setProvider("openai")}>
            OpenAI API key
          </button>
        </div>
      </div>
      {provider === "chatgpt" ? (
        <div class="field">
          {props.account ? (
            <div class="account">
              <span>Signed in as {props.account.email}</span>
              <button
                type="button"
                class="link"
                onClick={async () => {
                  await signOut();
                  props.onAccount(null);
                }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <button type="button" class="primary big" disabled={signing} onClick={chatgpt}>
              {signing ? "Finish signing in in the new tab…" : "Sign in with ChatGPT"}
            </button>
          )}
          <small>Uses your ChatGPT plan (Plus or Pro). Your sign-in stays in this browser and goes only to OpenAI. Jun has no server.</small>
          {problem && <small class="bad">{problem}</small>}
        </div>
      ) : (
        <label>
          <span>OpenAI API key</span>
          <input type="password" value={key} placeholder="sk-…" autoComplete="off" onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          <small>Kept in this browser only and sent only to OpenAI. Jun has no server.</small>
        </label>
      )}
      <label>
        <span>Model</span>
        <input value={model} placeholder={DEFAULT_MODELS[provider]} onInput={(e) => setModel((e.target as HTMLInputElement).value)} />
      </label>
      <label class="row">
        <input type="checkbox" checked={mask} onChange={(e) => setMask((e.target as HTMLInputElement).checked)} />
        <span>
          Mask the page before it goes to the AI
          <small>Hides emails, card-like numbers, tokens and the address's query values. Password, card and one-time-code fields are never read either way.</small>
        </span>
      </label>
      <label>
        <span>Before Jun clicks, types or chooses</span>
        <select value={confirm} onChange={(e) => setConfirm((e.target as HTMLSelectElement).value as ConfirmMode)}>
          {(Object.keys(CONFIRM_LABELS) as ConfirmMode[]).map((m) => (
            <option key={m} value={m}>
              {CONFIRM_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      {props.settings.allowed.length > 0 && (
        <div class="allowed">
          <span>Always allowed on</span>
          {props.settings.allowed.map((o) => (
            <div key={o} class="site">
              {new URL(o).host}
              <button type="button" class="link" onClick={() => props.onSave({ ...props.settings, allowed: props.settings.allowed.filter((x) => x !== o) }, props.keys)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="submit" class="primary">
        Save
      </button>
    </form>
  );
}
