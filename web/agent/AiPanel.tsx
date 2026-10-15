import { useCallback, useEffect, useState, type FormEvent } from "react";
import { cachedGet, fetchSetting } from "../settings/settingsData.ts";
import { api } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectField, SelectOption } from "@/components/ui/select-field.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import { ChatgptConnect, type DevChatgpt } from "./ChatgptConnect.tsx";
import { DeskFileNote } from "../components/DeskFileNote.tsx";

export type ProviderId = "openai" | "workers-ai" | "chatgpt";
type AiJob = "answer" | "brief" | "nudge" | "draft" | "topics" | "judge" | "suggestions" | "followups" | "editor";

interface AiState {
  settings: { enabled: boolean; provider: ProviderId; model: string | null; models: Partial<Record<AiJob, string>>; instructions: string; monthlyReplyCap: number };
  defaults: Record<ProviderId, string>;
  /** Jobs with their own default model per provider, used while their field is empty. */
  jobDefaults: Record<ProviderId, Partial<Record<AiJob, string>>>;
  effectiveModels: Record<AiJob, string>;
  openaiKeyConfigured: boolean;
  devChatgpt: DevChatgpt;
  usage: { month: string; replies: number; inputTokens: number; outputTokens: number };
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  "workers-ai": "Workers AI (built in, no key needed)",
  openai: "OpenAI (API key)",
  chatgpt: "ChatGPT sign-in (your plan)",
};

// AI-16: every AI job, in the order shown.
const JOBS: { job: AiJob; label: string; hint: string }[] = [
  { job: "answer", label: "Replies to visitors", hint: "Also the replies evals test." },
  { job: "brief", label: "Handoff briefs", hint: "Fast job: a short summary for your team." },
  { job: "followups", label: "Follow-up questions", hint: "Fast job: questions under an answer from your knowledge." },
  { job: "nudge", label: "Nudges and openers", hint: "Fast job: one line when a visitor gets stuck." },
  { job: "draft", label: "Issue drafts", hint: "Bug reports written from a conversation." },
  { job: "topics", label: "Topic labels", hint: "Fast job: labels for the Dashboard." },
  { job: "judge", label: "Eval grading", hint: "Checks eval replies against your criteria." },
  { job: "suggestions", label: "Suggested questions", hint: "Drafts the chat widget's suggested questions from your knowledge (Appearance page)." },
  { job: "editor", label: "Agent page editing", hint: "Changes a widget, action or task when you ask in its AI chat." },
];
// "Suggested for ChatGPT": the small model for fast jobs, the workspace model for the rest.
const CHATGPT_FAST_MODEL = "gpt-6-luna";
const FAST_JOBS: AiJob[] = ["nudge", "topics", "brief", "followups"];

export function AiPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/ai`;
  // Settings fetched these when it opened (settingsData): the form starts filled in.
  const initial = cachedGet<AiState>(base);
  const [state, setState] = useState<AiState | null>(initial ?? null);
  const [enabled, setEnabled] = useState(initial?.settings.enabled ?? false);
  const [provider, setProvider] = useState<ProviderId>(initial?.settings.provider ?? "workers-ai");
  const [model, setModel] = useState(initial?.settings.model ?? "");
  const [models, setModels] = useState<Partial<Record<AiJob, string>>>(initial?.settings.models ?? {});
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const next = await fetchSetting<AiState>(base);
    setState(next);
    setEnabled(next.settings.enabled);
    setProvider(next.settings.provider);
    setModel(next.settings.model ?? "");
    setModels(next.settings.models ?? {});
  }, [base]);
  useEffect(() => {
    load().catch(() => {});
    // Back from ChatGPT sign-in (the Shell sends /settings?chatgpt=connected here).
    if (new URLSearchParams(window.location.search).get("chatgpt") === "connected") window.history.replaceState(null, "", "/settings/ai");
  }, [load]);

  if (!state) return null;
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    run(async () => {
      await api(base, {
        method: "PUT",
        body: {
          enabled,
          provider,
          model,
          models,
          monthlyReplyCap: Number(data.get("cap")),
        },
      });
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const workspaceModel = model.trim() || state.defaults[provider];
  const overrides = JOBS.filter(({ job }) => models[job]?.trim()).length;
  const providers: ProviderId[] = ["workers-ai", "openai", ...(state.devChatgpt.available || state.settings.provider === "chatgpt" ? (["chatgpt"] as const) : [])];

  return (
    <SettingsCard
      title="AI replies"
      id="ai-assistant"
      description="When on, the assistant answers new website chats from your Knowledge, with citations, and hands off to your team when it can't help."
      action={<span className="muted small nums">{state.usage.replies} / {state.settings.monthlyReplyCap} replies this month</span>}
    >
      <form onSubmit={save} className="ai-form">
        <SettingRow label="Answer new chats with AI" description="When off, every new chat goes straight to your team.">
          <Switch checked={enabled} onCheckedChange={(value) => setEnabled(value)} disabled={!canEdit} aria-label="Answer new chats with AI" />
        </SettingRow>
        <SettingRow label="Model provider" description="Where the assistant's replies come from." htmlFor="ai-provider">
          <SelectField id="ai-provider" value={provider} onValueChange={(value) => setProvider(value as ProviderId)} disabled={!canEdit}>
            {providers.map((p) => (
              <SelectOption key={p} value={p}>{PROVIDER_LABELS[p]}</SelectOption>
            ))}
          </SelectField>
        </SettingRow>
        {provider === "openai" && !state.openaiKeyConfigured && (
          <p className="small error">Set the <code>OPENAI_API_KEY</code> Worker secret (<code>npx wrangler secret put OPENAI_API_KEY</code>) to use OpenAI.</p>
        )}
        {provider === "chatgpt" && <ChatgptConnect base={base} devChatgpt={state.devChatgpt} canEdit={canEdit} onChange={load} />}
        <SettingRow label="Model" description={<>Optional. Empty uses the provider's default, <code>{state.defaults[provider]}</code>.</>} htmlFor="ai-model">
          <Input id="ai-model" name="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={state.defaults[provider]} disabled={!canEdit} />
        </SettingRow>
        <SettingRow label="Monthly reply cap" description="When reached, chats go straight to your team. The assistant never just goes silent." htmlFor="ai-cap">
          <Input id="ai-cap" name="cap" type="number" min={0} defaultValue={state.settings.monthlyReplyCap} disabled={!canEdit} />
        </SettingRow>
        <details className="job-models" open={overrides > 0}>
          <summary className="small">Advanced: model per task{overrides > 0 ? ` (${overrides} set)` : ""}</summary>
          <div className="job-models-body">
            <p className="small muted">
              Each task uses the model above unless you name another model from the same provider (editing on the Agent page uses the large model by default, shown in its field). Fast jobs (nudge, topics, brief) do well on a small model. If the provider
              doesn't recognise a model here, that task falls back to the model above.
            </p>
            {canEdit && provider === "chatgpt" && (
              <div className="row">
                <Button variant="outline" size="sm" type="button" onClick={() => setModels(Object.fromEntries(FAST_JOBS.map((job) => [job, CHATGPT_FAST_MODEL])))}>
                  Suggested for ChatGPT
                </Button>
                <span className="muted small">{CHATGPT_FAST_MODEL} for the fast jobs; the rest stay on their defaults.</span>
              </div>
            )}
            <div className="job-model-grid">
              {JOBS.map(({ job, label, hint }) => (
                <label className="field" key={job}>
                  <span>{label}</span>
                  <Input
                    name={`model-${job}`}
                    value={models[job] ?? ""}
                    onChange={(e) => setModels((m) => ({ ...m, [job]: e.target.value }))}
                    placeholder={state.jobDefaults?.[provider]?.[job] ?? workspaceModel}
                    disabled={!canEdit}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <small className="muted">{hint}</small>
                </label>
              ))}
            </div>
          </div>
        </details>
        <p className="small muted">
          How it talks and when it hands over are under{" "}
          <a href="/agent" onClick={(e) => { e.preventDefault(); navigate("/agent", { replace: true }); }}>Instructions</a>; tasks, actions and tests are under Agent in the sidebar.
        </p>
        <DeskFileNote />
        {error && <p className="error">{error}</p>}
        {canEdit && <div className="row"><Button disabled={busy}>Save</Button>{saved && <span className="muted small">Saved ✓</span>}</div>}
      </form>
    </SettingsCard>
  );
}

/** Developers can keep the agent's files in git and push them from CI. */
export function GitCard() {
  return (
    <SettingsCard
      id="agent-git"
      title="Keep it in git"
      description="Everything on the Agent pages is a set of text files. Developers can pull them into your Jun checkout, review changes there, run the tests and push them back."
    >
      <p className="small muted">
        Create a token in{" "}
        <a href="/settings/developer#api-tokens" onClick={(e) => { e.preventDefault(); navigate("/settings/developer#api-tokens"); }}>Settings → Developer → API tokens</a>, then run:
      </p>
      <pre className="agent-git-commands">{`npm run jun -- login ${window.location.origin}
npm run jun -- pull support-agent
npm run jun -- eval support-agent
npm run jun -- push support-agent`}</pre>
      {/* D-85 */}
      <p className="small muted">The pulled folder comes with an AGENTS.md guide to its files, so a coding AI (Claude Code, Codex, Cursor) can edit them with you.</p>
      {/* D-86 */}
      <p className="small muted">
        No checkout needed: your AI can also change the agent directly over MCP (
        <a href="/settings/developer#mcp" onClick={(e) => { e.preventDefault(); navigate("/settings/developer#mcp"); }}>Settings → Developer → Connect your AI</a>).
      </p>
    </SettingsCard>
  );
}
