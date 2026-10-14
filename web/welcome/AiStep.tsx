import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { ChatgptConnect, type DevChatgpt } from "../agent/ChatgptConnect.tsx";
import type { ProviderId } from "../agent/AiPanel.tsx";

// T-11 step 3: choose where replies come from and turn the AI on, the same settings as Settings → AI
// (model, cap and per-task models stay there). ChatGPT sign-in (D-27) comes first while it's
// offered: signing in here turns the AI on with it, no second click.

interface AiState {
  settings: { enabled: boolean; provider: ProviderId; model: string | null } & Record<string, unknown>;
  defaults: Record<ProviderId, string>;
  openaiKeyConfigured: boolean;
  devChatgpt: DevChatgpt;
}

const CHOICES: { id: ProviderId; title: string; hint: string }[] = [
  { id: "chatgpt", title: "ChatGPT sign-in", hint: "Sign in with your ChatGPT account; replies use your plan. Only for a private desk." },
  { id: "workers-ai", title: "Workers AI", hint: "Built in: runs on your Cloudflare account, no key needed." },
  { id: "openai", title: "OpenAI", hint: "Your own API key, set as a Worker secret." },
];

const RETURN_TO = "/welcome/ai";

const link = (href: string, text: string) => (
  <a href={href} onClick={(e) => { e.preventDefault(); navigate(href); }}>{text}</a>
);

export function AiStep({ workspaceId, done, reload }: { workspaceId: string; done: boolean; reload: () => Promise<void> }) {
  const base = `/workspaces/${workspaceId}/ai`;
  const [state, setState] = useState<AiState | null>(null);
  const [choice, setChoice] = useState<ProviderId | null>(null);
  const [changing, setChanging] = useState(false);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const next = await api<AiState>(base);
    setState(next);
    // Keep what the admin picked here; a ChatGPT sign-in reloads the state but isn't a save.
    // Before the AI is set up, ChatGPT is the suggestion while it's offered.
    setChoice((c) => c ?? (!next.settings.enabled && next.devChatgpt.available ? "chatgpt" : next.settings.provider));
    return next;
  }, [base]);

  const enable = useCallback(
    async (provider: ProviderId, current: AiState) => {
      await api(base, { method: "PUT", body: { ...current.settings, provider, enabled: true } });
      await load();
      setChanging(false);
      await reload();
    },
    [base, load, reload],
  );

  /** After a sign-in: if the AI isn't on yet, turn it on with ChatGPT. */
  const signedIn = useCallback(async () => {
    const next = await load();
    if (next.devChatgpt.connected && !next.settings.enabled) await enable("chatgpt", next);
  }, [load, enable]);

  useEffect(() => {
    // Back from a local sign-in (the callback lands on /welcome/ai?chatgpt=connected).
    if (new URLSearchParams(window.location.search).get("chatgpt") === "connected") {
      window.history.replaceState(null, "", RETURN_TO);
      signedIn().catch(() => {});
    } else load().catch(() => {});
  }, [load, signedIn]);

  if (!state || !choice) return null;
  const choices = CHOICES.filter((c) => c.id !== "chatgpt" || state.devChatgpt.available || state.settings.provider === "chatgpt");
  const blocked = (choice === "openai" && !state.openaiKeyConfigured) || (choice === "chatgpt" && !state.devChatgpt.connected);
  const label = CHOICES.find((c) => c.id === state.settings.provider)?.title ?? state.settings.provider;
  const model = state.settings.model || state.defaults[state.settings.provider];
  const save = () => run(() => enable(choice, state));

  if (done && !changing)
    return (
      <>
        <p className="muted small">
          On, using <strong>{label}</strong> (<code>{model}</code>){state.settings.provider === "chatgpt" && state.devChatgpt.email ? <> as {state.devChatgpt.email}</> : null}.{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); setChoice(state.settings.provider); setChanging(true); }}>Change</a>
        </p>
        <p className="muted small">How it talks, its tasks and actions are on the {link("/agent", "Agent")} page; the model, monthly cap and per-task models in {link("/settings/ai", "Settings → AI")}.</p>
      </>
    );

  return (
    <>
      <p className="muted small">Choose where its replies come from. You can switch any time in {link("/settings/ai", "Settings → AI")}.</p>
      <div className="settings-choices" role="radiogroup" aria-label="Model provider">
        {choices.map((c) => (
          <label className="settings-choice" key={c.id}>
            <input type="radio" name="ai-provider" value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} />
            <span>
              <strong>{c.title}</strong>
              <span className="muted small">{c.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {choice === "openai" && !state.openaiKeyConfigured && (
        <p className="small">
          Add your key as the <code>OPENAI_API_KEY</code> secret: in Cloudflare, open this Worker → Settings → Variables and Secrets, or run <code>npx wrangler secret put OPENAI_API_KEY</code>. Then reload this page.
        </p>
      )}
      {choice === "chatgpt" && <ChatgptConnect base={base} devChatgpt={state.devChatgpt} canEdit onChange={done ? load : signedIn} returnTo={RETURN_TO} />}
      {error && <p className="error">{error}</p>}
      {/* Signing in turns it on by itself; the button is for the other choices, or a switch back. */}
      {!(choice === "chatgpt" && !state.devChatgpt.connected) && (
        <div className="row">
          <Button disabled={busy || blocked} onClick={save}>{done ? "Save" : "Turn on the AI"}</Button>
          {changing && <Button variant="outline" disabled={busy} onClick={() => setChanging(false)}>Cancel</Button>}
        </div>
      )}
      {changing && choice === "chatgpt" && !state.devChatgpt.connected && (
        <div className="row"><Button variant="outline" disabled={busy} onClick={() => setChanging(false)}>Cancel</Button></div>
      )}
    </>
  );
}
