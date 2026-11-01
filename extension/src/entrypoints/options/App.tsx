// Jun for Chrome's settings (E-01): the person's AI (Sign in with ChatGPT, or an OpenAI API key),
// the model, masking and when to ask before acting. Opened from the island or chrome://extensions.
import { useEffect, useState } from "react";
import { signedIn, signIn, signOut } from "../../lib/chatgpt.ts";
import { DEFAULT_MODELS, DEFAULT_SETTINGS, KEYS_KEY, readKeys, readSettings, SETTINGS_KEY, type ConfirmMode, type Keys, type Provider, type Settings } from "../../lib/settings.ts";

const CONFIRM_LABELS: Record<ConfirmMode, string> = {
  "allow-always": "Ask, with “Always allow on this site”",
  "every-time": "Ask every time",
  never: "Never ask",
};

export function App() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<Keys>({ openai: "" });
  const [account, setAccount] = useState<{ email: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void Promise.all([browser.storage.local.get([SETTINGS_KEY, KEYS_KEY]), signedIn()]).then(([s, who]) => {
      setSettings(readSettings(s[SETTINGS_KEY]));
      setKeys(readKeys(s[KEYS_KEY]));
      setAccount(who);
      setLoaded(true);
    });
  }, []);
  async function save(next: Settings, nextKeys: Keys) {
    setSettings(next);
    setKeys(nextKeys);
    await browser.storage.local.set({ [SETTINGS_KEY]: next, [KEYS_KEY]: nextKeys });
    setSaved(true);
  }
  if (!loaded) return <div className="app" />;
  return (
    <div className="app page">
      <header className="top">
        <div className="brand">
          <img className="logo" src="/jun-agent.svg" alt="" />
          <div>
            <div className="name">Jun settings</div>
            <div className="sub">Help on any page, on your own AI</div>
          </div>
        </div>
      </header>
      <SettingsView key={String(saved)} settings={settings} keys={keys} account={account} onAccount={setAccount} onSave={save} onDone={() => setSaved(true)} />
      {saved && <p className="foot">Saved. Click the Jun button on any website to ask.</p>}
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

  async function submit(e: { preventDefault(): void }) {
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
    <form className="settings" onSubmit={submit}>
      <div className="field">
        <span className="label">Your AI</span>
        <div className="seg">
          <button type="button" className={provider === "chatgpt" ? "on" : ""} onClick={() => setProvider("chatgpt")}>
            ChatGPT
          </button>
          <button type="button" className={provider === "openai" ? "on" : ""} onClick={() => setProvider("openai")}>
            OpenAI API key
          </button>
        </div>
      </div>
      {provider === "chatgpt" ? (
        <div className="field">
          {props.account ? (
            <div className="account">
              <span>Signed in as {props.account.email}</span>
              <button
                type="button"
                className="link"
                onClick={async () => {
                  await signOut();
                  props.onAccount(null);
                }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <button type="button" className="primary big" disabled={signing} onClick={chatgpt}>
              {signing ? "Finish signing in in the new tab…" : "Sign in with ChatGPT"}
            </button>
          )}
          <small>Uses your ChatGPT plan (Plus or Pro). Your sign-in stays in this browser and goes only to OpenAI. Jun has no server.</small>
          {problem && <small className="bad">{problem}</small>}
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
      <label className="row">
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
        <div className="allowed">
          <span>Always allowed on</span>
          {props.settings.allowed.map((o) => (
            <div key={o} className="site">
              {new URL(o).host}
              <button type="button" className="link" onClick={() => props.onSave({ ...props.settings, allowed: props.settings.allowed.filter((x) => x !== o) }, props.keys)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="submit" className="primary">
        Save
      </button>
    </form>
  );
}
