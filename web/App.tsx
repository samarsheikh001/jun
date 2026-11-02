import { useCallback, useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { api, describeError, registerPasskey, signInWithPasskey, signInWithPassword, type Me } from "./api.ts";
import { lastSession, rememberSession, Shell, ShellSkeleton } from "./Shell.tsx";
import { useAction } from "./useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Card as UiCard } from "@/components/ui/card.tsx";
import { DeskIcon } from "./components/DeskIcon.tsx";
import { onDeskHome, switchWorkspace } from "./workspaces/workspace.ts";
import { DeskHome, DeskHomeSkeleton } from "./workspaces/DeskHome.tsx";
import { HOME_PATHS } from "./lib/workspace-url.ts";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<Me>("/me").then(setMe, (e) => setLoadError(describeError(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const path = window.location.pathname;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  const done = () => {
    window.history.replaceState(null, "", "/inbox");
    refresh();
  };

  if (loadError) return <Card title="Can't reach Jun"><p className="error">{loadError}</p></Card>;
  if (!me) {
    // Signed in here last time: the desk's own frame at once (the page draws its skeleton next);
    // otherwise a blank page, so the sign-in card doesn't follow a flash of the desk.
    const session = path.startsWith("/invite/") || path === "/recover" ? null : lastSession();
    // D-97: the desk's home, when this browser last saw two or more workspaces.
    if (session?.many && HOME_PATHS.includes(path)) return <DeskHomeSkeleton name={session.name} />;
    return session ? <ShellSkeleton session={session} /> : null;
  }
  if (invite?.[1]) return <InvitePage token={invite[1]} signedInAs={me.user?.name ?? null} onDone={done} />;
  if (path === "/recover") return <RecoverPage onDone={done} />;
  // T-11: a fresh desk goes straight to "Get started".
  if (!me.setupComplete) return <SetupPage onDone={() => { window.history.replaceState(null, "", "/welcome"); refresh(); }} />;
  if (!me.user) return <SignedOut><LoginPage onDone={refresh} /></SignedOut>;
  // D-97: `/` with two or more workspaces is the desk's home; anything else is one workspace.
  if (onDeskHome(me)) return <DeskHome me={me} onSignOut={refresh} />;
  return <Shell me={me} onSignOut={refresh} />;
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="center">
      <UiCard className="auth-card w-full max-w-[416px] gap-0 p-6">
        <div className="brand"><DeskIcon /><span>Jun</span></div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </UiCard>
    </main>
  );
}

function Field({ label, hint, ...props }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <Input {...props} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

const formValues = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

type Method = "passkey" | "password";

const MIN_PASSWORD = 10;

function NewPasswordField() {
  return <Field label="Password" name="password" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters.`} />;
}

/** D-157: switches a form between a passkey and a password. */
function MethodSwitch({ method, onChange }: { method: Method; onChange: (m: Method) => void }) {
  return (
    <p className="muted small">
      <button type="button" className="link-button" onClick={() => onChange(method === "passkey" ? "password" : "passkey")}>
        {method === "passkey" ? "Use a password instead" : "Use a passkey instead"}
      </button>
    </p>
  );
}

function SetupPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [method, setMethod] = useState<Method>("passkey");
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    const body = { token: v.token, workspaceName: v.workspaceName, name: v.name, email: v.email };
    run(async () => {
      if (method === "passkey") await registerPasskey("/setup", body);
      else await api("/setup/password", { body: { ...body, password: v.password } });
      onDone();
    });
  };
  const subtitle = method === "passkey"
    ? "Create the owner account. You'll sign in with a passkey: your fingerprint, face, or device PIN."
    : "Create the owner account. You'll sign in with your email and a password.";
  return (
    <Card title="Set up your desk" subtitle={subtitle}>
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" hint="The SETUP_TOKEN you chose when deploying." />
        <Field label="Workspace name" name="workspaceName" required placeholder="Acme Support" />
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {method === "password" && <NewPasswordField />}
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{method === "passkey" ? (busy ? "Waiting for passkey…" : "Create passkey and finish setup") : busy ? "Setting up…" : "Finish setup"}</Button>
      </form>
      <MethodSwitch method={method} onChange={setMethod} />
    </Card>
  );
}

/** Email + password sign-in; `then` runs after it (joining an invite). */
function PasswordSignIn({ busy, run, then }: { busy: boolean; run: (fn: () => Promise<void>) => void; then: () => Promise<void> | void }) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      await signInWithPassword(v.email ?? "", v.password ?? "");
      await then();
    });
  };
  return (
    <form onSubmit={submit}>
      <Field label="Email" name="email" type="email" required autoComplete="username" />
      <Field label="Password" name="password" type="password" required autoComplete="current-password" />
      <Button variant="outline" disabled={busy}>{busy ? "Signing in…" : "Sign in with password"}</Button>
    </form>
  );
}

function LoginPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Card title="Sign in" subtitle="Use your passkey, or the email and password you set for this desk.">
      {error && <p className="error">{error}</p>}
      <Button disabled={busy} onClick={() => run(async () => { await signInWithPasskey(); onDone(); })}>
        {busy ? "Waiting…" : "Sign in with passkey"}
      </Button>
      <div className="auth-or">or</div>
      <PasswordSignIn busy={busy} run={run} then={onDone} />
      <p className="muted small">New here? Ask your workspace admin for an invite link.</p>
      <p className="muted small">Owner locked out? <a href="/recover">Recover with the setup token</a></p>
    </Card>
  );
}

function RecoverPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [method, setMethod] = useState<Method>("passkey");
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      if (method === "passkey") await registerPasskey("/recover", { token: v.token });
      else await api("/recover/password", { body: { token: v.token, password: v.password } });
      onDone();
    });
  };
  return (
    <Card
      title="Recover owner access"
      subtitle={method === "passkey" ? "Enter the setup token to add a new passkey to the owner account." : "Enter the setup token to set a new password on the owner account. Other browsers signed in as the owner are signed out."}
    >
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" />
        {method === "password" && <NewPasswordField />}
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{method === "passkey" ? (busy ? "Waiting for passkey…" : "Add a new passkey") : busy ? "Saving…" : "Set new password"}</Button>
      </form>
      <MethodSwitch method={method} onChange={setMethod} />
      <p className="muted small"><a href="/">Back to sign in</a></p>
    </Card>
  );
}

function InvitePage({ token, signedInAs, onDone }: { token: string; signedInAs: string | null; onDone: () => void }) {
  const [invite, setInvite] = useState<{ workspaceName: string; role: string } | null>(null);
  const { busy, error, run } = useAction();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("passkey");
  const [existing, setExisting] = useState(false);
  useEffect(() => {
    api<{ workspaceName: string; role: string }>(`/invites/${token}`).then(setInvite, (e) => setLoadError(describeError(e)));
  }, [token]);

  if (loadError) return <Card title="Invite not available"><p className="error">{loadError}</p></Card>;
  if (!invite) return null;
  // D-95: already on this desk (another workspace): join with the same account, no new sign-in.
  const accept = async () => {
    switchWorkspace(await api<{ workspaceId: string; workspaceSlug: string | null }>(`/invites/${token}/accept`, { body: {} }));
  };
  const role = `You've been invited as ${invite.role === "admin" ? "an admin" : "an agent"}.`;
  if (signedInAs) {
    return (
      <Card title={`Join ${invite.workspaceName}`} subtitle={role}>
        {error && <p className="error">{error}</p>}
        <Button disabled={busy} onClick={() => run(accept)}>{busy ? "Joining…" : `Join as ${signedInAs}`}</Button>
        <p className="muted small">It appears in your workspace menu, next to your others.</p>
      </Card>
    );
  }
  if (existing) {
    return (
      <Card title={`Join ${invite.workspaceName}`} subtitle="Sign in with your account on this desk to join.">
        {error && <p className="error">{error}</p>}
        <Button disabled={busy} onClick={() => run(async () => { await signInWithPasskey(); await accept(); })}>
          {busy ? "Waiting…" : "Sign in with passkey"}
        </Button>
        <div className="auth-or">or</div>
        <PasswordSignIn busy={busy} run={run} then={accept} />
        <p className="muted small"><button type="button" className="link-button" onClick={() => setExisting(false)}>Create a new account instead</button></p>
      </Card>
    );
  }
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      if (method === "passkey") await registerPasskey(`/invites/${token}`, { name: v.name, email: v.email });
      else await api(`/invites/${token}/password`, { body: { name: v.name, email: v.email, password: v.password } });
      onDone();
    });
  };
  return (
    <Card title={`Join ${invite.workspaceName}`} subtitle={role}>
      <form onSubmit={submit}>
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {method === "password" && <NewPasswordField />}
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{method === "passkey" ? (busy ? "Waiting for passkey…" : "Create passkey and join") : busy ? "Joining…" : "Create account and join"}</Button>
      </form>
      <MethodSwitch method={method} onChange={setMethod} />
      <p className="muted small">
        Already have an account on this desk?{" "}
        <button type="button" className="link-button" onClick={() => setExisting(true)}>Sign in to join</button>
      </p>
    </Card>
  );
}

/** Signed out: the next page load starts blank, not with the desk's frame. */
function SignedOut({ children }: { children: ReactNode }) {
  useEffect(() => rememberSession(null), []);
  return <>{children}</>;
}
