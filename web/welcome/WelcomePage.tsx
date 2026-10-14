import { useCallback, useEffect, useState, type ComponentType, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { navigate, usePath } from "../lib/router.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { BookOpenIcon, ChatIcon, CheckIcon, CodeIcon, KeyIcon, SparkleIcon, UsersIcon } from "@/components/icons";
import { AiStep } from "./AiStep.tsx";

// T-11: first-run "Get started". One step at a time (`/welcome/<step>`), each doing the one thing it
// needs right here, ticked off from the desk's real state (so doing it in Settings counts too).

export type Step = "account" | "knowledge" | "ai" | "brand" | "install" | "team";

export interface Onboarding {
  steps: Record<Step, boolean>;
  widgetKey: string | null;
  installedOn: string | null;
  dismissed: boolean;
}

export const STEP_ORDER: Step[] = ["account", "knowledge", "ai", "brand", "install", "team"];

type IconType = ComponentType<{ className?: string }>;

/** `cta` is the sidebar card's label for the next step; `pan` moves the header to another part of the sky for each step (vertical %); `tint` colours the step's icon. */
export const STEPS: Record<Step, { title: string; short: string; blurb: string; cta: string; icon: IconType; pan: number; tint: string; optional?: boolean }> = {
  account: { title: "Create your account", short: "Your account", blurb: "You're signed in with a passkey.", cta: "Sign in with a passkey", icon: KeyIcon, pan: 12, tint: "#e8710a" },
  knowledge: { title: "Add your docs", short: "Your docs", blurb: "The AI only answers from what's here, with citations.", cta: "Add your docs", icon: BookOpenIcon, pan: 30, tint: "#2f6fdf" },
  ai: { title: "Set up the AI assistant", short: "AI assistant", blurb: "It answers new chats first and hands off to your team when it can't help.", cta: "Connect ChatGPT", icon: SparkleIcon, pan: 48, tint: "#8b4ff0" },
  brand: { title: "Make the widget yours", short: "Widget look", blurb: "Your colour on the chat button and the widget.", cta: "Pick your colour", icon: ChatIcon, pan: 66, tint: "#d6457a", optional: true },
  install: { title: "Put it on your site", short: "Install", blurb: "One line in your site's <head>; the chat loads only when someone opens it.", cta: "Copy the snippet", icon: CodeIcon, pan: 84, tint: "#138a5e" },
  team: { title: "Invite your team", short: "Your team", blurb: "Teammates take over when the AI hands a chat off.", cta: "Create an invite", icon: UsersIcon, pan: 100, tint: "#c2570c", optional: true },
};

export function useOnboarding(workspaceId: string) {
  const [state, setState] = useState<Onboarding | null>(null);
  const load = useCallback(async () => setState(await api<Onboarding>(`/workspaces/${workspaceId}/onboarding`)), [workspaceId]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  return { state, reload: load };
}

const go = (href: string) => (e: { preventDefault: () => void }) => {
  e.preventDefault();
  navigate(href);
};
const link = (href: string, text: ReactNode) => <a href={href} onClick={go(href)}>{text}</a>;

function Ring({ done, total }: { done: number; total: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg className="wl-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} className="wl-ring-track" />
      <circle cx="12" cy="12" r={r} className="wl-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - done / total)} />
    </svg>
  );
}

export function WelcomePage({ workspaceId, workspaceName, onboarding, reload }: { workspaceId: string; workspaceName: string; onboarding: Onboarding | null; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  const path = usePath();
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [color, setColor] = useState("#2f5bea");

  // Crawls and the first install finish in the background: keep the checklist fresh.
  useEffect(() => {
    const timer = setInterval(() => reload().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [reload]);

  // `/welcome` opens on the first step not done yet; it's then pinned in the URL so ticking it
  // off doesn't jump ahead under the reader.
  const fromPath = path.split("/")[2] as Step | undefined;
  const firstOpen = onboarding ? (STEP_ORDER.find((k) => !onboarding.steps[k]) ?? "team") : null;
  useEffect(() => {
    if (firstOpen && !(fromPath && STEP_ORDER.includes(fromPath))) navigate(`/welcome/${firstOpen}`, { replace: true });
  }, [firstOpen, fromPath]);

  if (!onboarding) return <div className="content muted">Loading…</div>;
  const s = onboarding.steps;
  const current: Step = fromPath && STEP_ORDER.includes(fromPath) ? fromPath : (firstOpen ?? "account");
  const index = STEP_ORDER.indexOf(current);
  const step = STEPS[current];
  const done = s[current];
  const doneCount = STEP_ORDER.filter((k) => s[k]).length;
  const last = index === STEP_ORDER.length - 1;
  const snippet = onboarding.widgetKey ? `<script src="${window.location.origin}/widget.js" data-key="${onboarding.widgetKey}" defer></script>` : "";
  const Icon = step.icon;

  const addSite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url"));
    run(async () => {
      await api(`/workspaces/${workspaceId}/knowledge/websites`, { body: { url } });
      await reload();
    });
  };
  const saveColor = () =>
    run(async () => {
      await api(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { color } });
      await reload();
    });
  const invite = () =>
    run(async () => {
      setInviteUrl((await api<{ url: string }>(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } })).url);
      await reload();
    });
  // Leaving never hides Get started: until it's finished, the sidebar card keeps it a click away
  // (its × hides it for good).
  const next = () => navigate(last ? "/inbox" : `/welcome/${STEP_ORDER[index + 1]}`);
  // Install ticks itself when the loader is first seen on a site; "I've added it" ticks it now
  // (a staging site, or one nobody has visited yet).
  const markInstalled = () =>
    run(async () => {
      await api(`/workspaces/${workspaceId}/onboarding/installed`, { body: {} });
      await reload();
      next();
    });
  const installPending = current === "install" && !done;

  const body: Record<Step, ReactNode> = {
    account: <p className="muted small">Done. Keep your setup token somewhere safe: it's how you get back in if you lose every passkey.</p>,
    knowledge: s.knowledge ? (
      <p className="muted small">Your knowledge is indexed. Add more or check what was read under {link("/knowledge", "Knowledge")}.</p>
    ) : (
      <>
        <form className="row" onSubmit={addSite}>
          <Input name="url" type="url" required placeholder="https://docs.yourcompany.com" aria-label="Docs URL" style={{ flex: 1 }} />
          <Button disabled={busy}>Add website</Button>
        </form>
        <p className="muted small">Paste your help center or docs site; we read its sitemap and re-sync daily. Crawling takes a minute or two, and this step ticks itself off when pages are indexed. Files and snippets are under {link("/knowledge", "Knowledge")}.</p>
      </>
    ),
    ai: <AiStep workspaceId={workspaceId} done={s.ai} reload={reload} />,
    brand: s.brand ? (
      <p className="muted small">Branded. Logo, greeting and side are on the {link("/appearance", "Chat widget")} page; business hours in {link("/settings/inbox", "Settings → Inbox")}.</p>
    ) : (
      <div className="row">
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Brand colour" />
        <Button variant="outline" disabled={busy} onClick={saveColor}>Use this colour</Button>
        <span className="muted small">Logo and greeting on the {link("/appearance", "Chat widget")} page.</span>
      </div>
    ),
    install: (
      <>
        <div className="wl-snippet">
          <code className="small">{snippet}</code>
          <Button size="sm" variant="outline" onClick={async () => { await navigator.clipboard?.writeText(snippet); setCopied(true); }}>{copied ? "Copied ✓" : "Copy"}</Button>
        </div>
        {s.install ? (
          onboarding.installedOn ? (
            <p className="small">✓ Seen on <code>{onboarding.installedOn}</code>.</p>
          ) : (
            <p className="muted small">Marked as added. Once a page with it loads, the site shows here; until then, try the <a href={`/demo.html?key=${onboarding.widgetKey}`} target="_blank" rel="noreferrer">demo page</a>.</p>
          )
        ) : (
          <p className="muted small">
            Put it before your own scripts. This ticks itself off the first time your page loads it; meanwhile, try the{" "}
            <a href={`/demo.html?key=${onboarding.widgetKey}`} target="_blank" rel="noreferrer">demo page</a>. Allowed websites and identity are on the {link("/appearance/install", "Install")} tab.
          </p>
        )}
      </>
    ),
    team: inviteUrl ? (
      <div className="invite">
        <span className="small">Send this link to a teammate (works once, for 7 days):</span>
        <code className="small">{inviteUrl}</code>
      </div>
    ) : s.team ? (
      <p className="muted small">Team invited. Manage people and roles in Settings.</p>
    ) : (
      <Button variant="outline" disabled={busy} onClick={invite}>Create an invite link</Button>
    ),
  };

  return (
    <main className="content">
      <div className="wl">
        <div className="wl-head">
          <h1>Welcome to {workspaceName}'s desk</h1>
          <p className="muted">A few minutes to an AI that answers from your docs on your own site.</p>
        </div>

        <section className="wl-card" aria-labelledby="wl-title">
          <div className="wl-hero">
            <div className="wl-sky" style={{ "--pan": `${step.pan}%` } as CSSProperties} />
            <div className="wl-badge" style={{ color: done ? "#1a7f37" : step.tint }}>
              {done ? <CheckIcon /> : <Icon />}
            </div>
            <span className="wl-pill">{done ? "Done" : `Step ${index + 1}${step.optional ? " · optional" : ""}`}</span>
          </div>
          <div className="wl-main">
            <h2 id="wl-title">{step.title}</h2>
            <p className="wl-blurb">{step.blurb}</p>
            <div className="wl-body">{body[current]}</div>
            {error && <p className="error">{error}</p>}
            <div className="wl-foot">
              <Ring done={doneCount} total={STEP_ORDER.length} />
              <span className="wl-count">{doneCount} of {STEP_ORDER.length} done</span>
              <span className="spacer" />
              {index > 0 && <Button variant="ghost" onClick={() => navigate(`/welcome/${STEP_ORDER[index - 1]}`)}>Back</Button>}
              {!done && !last && <Button variant="ghost" onClick={next}>Skip</Button>}
              <Button variant={done ? "default" : "outline"} disabled={busy} onClick={installPending ? markInstalled : next}>{installPending ? "I've added it" : last ? "Go to the inbox" : "Next"}</Button>
            </div>
          </div>
        </section>

        <nav className="wl-list" aria-label="Setup steps">
          {STEP_ORDER.map((key) => {
            const { short, icon: StepIcon } = STEPS[key];
            return (
              <a key={key} href={`/welcome/${key}`} onClick={go(`/welcome/${key}`)} className={`wl-row ${key === current ? "on" : ""} ${s[key] ? "ok" : ""}`} aria-current={key === current ? "step" : undefined}>
                <StepIcon className="wl-row-icon" />
                <span>{short}</span>
                {STEPS[key].optional && !s[key] && <span className="wl-row-note">optional</span>}
                {s[key] && <CheckIcon className="wl-row-check" />}
              </a>
            );
          })}
        </nav>

        <button type="button" data-plain className="wl-hide" onClick={() => navigate("/inbox")}>
          {doneCount === STEP_ORDER.length ? "All set, go to the inbox" : "Go to the inbox, finish later from the sidebar"}
        </button>
      </div>
    </main>
  );
}
