import { useCallback, useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { api, describeError, registerPasskey, signInWithPasskey, type Me } from "./api.ts";
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

function SetupPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      await registerPasskey("/setup", { token: v.token, workspaceName: v.workspaceName, name: v.name, email: v.email });
      onDone();
    });
  };
  return (
    <Card title="Set up your desk" subtitle="Create the owner account. You'll sign in with a passkey: your fingerprint, face, or device PIN.">
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" hint="The SETUP_TOKEN you chose when deploying." />
        <Field label="Workspace name" name="workspaceName" required placeholder="Acme Support" />
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{busy ? "Waiting for passkey…" : "Create passkey and finish setup"}</Button>
      </form>
    </Card>
  );
}

function LoginPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Card title="Sign in" subtitle="Use the passkey you created for this desk.">
      {error && <p className="error">{error}</p>}
      <Button disabled={busy} onClick={() => run(async () => { await signInWithPasskey(); onDone(); })}>
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </Button>
      <p className="muted small">New here? Ask your workspace admin for an invite link. Each person creates their own passkey.</p>
      <p className="muted small">Owner lost access to every passkey? <a href="/recover">Recover with the setup token</a></p>
    </Card>
  );
}

function RecoverPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { token } = formValues(e);
    run(async () => {
      await registerPasskey("/recover", { token });
      onDone();
    });
  };
  return (
    <Card title="Recover owner access" subtitle="Enter the setup token to add a new passkey to the owner account.">
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" />
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{busy ? "Waiting for passkey…" : "Add a new passkey"}</Button>
      </form>
      <p className="muted small"><a href="/">Back to sign in</a></p>
    </Card>
  );
}

function InvitePage({ token, signedInAs, onDone }: { token: string; signedInAs: string | null; onDone: () => void }) {
  const [invite, setInvite] = useState<{ workspaceName: string; role: string } | null>(null);
  const { busy, error, run } = useAction();
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    api<{ workspaceName: string; role: string }>(`/invites/${token}`).then(setInvite, (e) => setLoadError(describeError(e)));
  }, [token]);

  if (loadError) return <Card title="Invite not available"><p className="error">{loadError}</p></Card>;
  if (!invite) return null;
  // D-95: already on this desk (another workspace): join with the same account, no new passkey.
  const join = () =>
    run(async () => {
      switchWorkspace(await api<{ workspaceId: string; workspaceSlug: string | null }>(`/invites/${token}/accept`, { body: {} }));
    });
  const role = `You've been invited as ${invite.role === "admin" ? "an admin" : "an agent"}.`;
  if (signedInAs) {
    return (
      <Card title={`Join ${invite.workspaceName}`} subtitle={role}>
        {error && <p className="error">{error}</p>}
        <Button disabled={busy} onClick={join}>{busy ? "Joining…" : `Join as ${signedInAs}`}</Button>
        <p className="muted small">It appears in your workspace menu, next to your others.</p>
      </Card>
    );
  }
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      await registerPasskey(`/invites/${token}`, { name: v.name, email: v.email });
      onDone();
    });
  };
  return (
    <Card title={`Join ${invite.workspaceName}`} subtitle={role}>
      <form onSubmit={submit}>
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{busy ? "Waiting for passkey…" : "Create passkey and join"}</Button>
      </form>
      <p className="muted small">
        Already have an account on this desk?{" "}
        <a href="#" onClick={(e) => { e.preventDefault(); run(async () => { await signInWithPasskey(); switchWorkspace(await api<{ workspaceId: string; workspaceSlug: string | null }>(`/invites/${token}/accept`, { body: {} })); }); }}>
          Sign in to join
        </a>
      </p>
    </Card>
  );
}

/** Signed out: the next page load starts blank, not with the desk's frame. */
function SignedOut({ children }: { children: ReactNode }) {
  useEffect(() => rememberSession(null), []);
  return <>{children}</>;
}
