import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { api, describeError, type Me } from "../api.ts";
import { navigate, usePath } from "../lib/router.ts";
import { setThemePref, THEME_LABEL, THEME_PREFS, useThemePref } from "../lib/theme.ts";
import { textOn } from "../../shared/appearance.ts";
import type { WorkspaceSummary } from "../../shared/workspace-summary.ts";
import { ColumnsIcon, GlobeIcon, KeyIcon, MonitorIcon, MoonIcon, PlusIcon, SignOutIcon, SunIcon } from "@/components/icons";
import { DeskIcon } from "../components/DeskIcon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SkelText, Skeleton } from "@/components/ui/skeleton.tsx";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { PageErrorBoundary } from "../components/PageErrorBoundary.tsx";
import { SettingsDialog } from "../SettingsDialog.tsx";
import { NewWorkspaceDialog } from "./WorkspaceSwitcher.tsx";
import { switchWorkspace } from "./workspace.ts";

// D-97: the desk's home at `/` (with two or more workspaces): one card per workspace you're in,
// after Chatbase's agents grid. Its own frame (no workspace sidebar); its settings dialog has only
// your account and the desk (/settings/account, /settings/desk). A card opens that workspace.

const ROLE_LABEL = { owner: "Owner", admin: "Admin", agent: "Agent" } as const;
const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;
/** Numbers stay fresh while the page is open. */
const REFRESH_MS = 30_000;

export function DeskHome({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const path = usePath();
  const [list, setList] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const load = () => api<{ workspaces: WorkspaceSummary[] }>("/workspaces").then((r) => { setList(r.workspaces); setError(null); }, (e) => setError(describeError(e)));
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    document.title = "Workspaces · Jun";
  }, []);
  if (!me.user) return null;
  const owner = (me.memberships ?? []).some((m) => m.role === "owner");
  const settingsOpen = path.startsWith("/settings");

  return (
    <DeskHomeFrame user={me.user} onSignOut={onSignOut}>
      <div className="home-head">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">One for each website or product, each with its own chat widget, inbox, AI agent and team.</p>
        </div>
      </div>
      {error && !list && <p className="error">{error}</p>}
      <ul className="home-grid" aria-busy={list ? undefined : "true"}>
        {list
          ? list.map((w) => <WorkspaceCard key={w.workspaceId} workspace={w} />)
          : (me.memberships ?? []).map((m) => <WorkspaceCardSkeleton key={m.workspaceId} name={m.workspaceName} />)}
        {owner && (
          <li>
            <button type="button" data-plain className="home-card home-card-new" onClick={() => setCreating(true)}>
              <span className="home-card-new-icon" aria-hidden="true"><PlusIcon /></span>
              <span className="home-card-name">New workspace</span>
              <span className="muted small">For another website or product.</span>
            </button>
          </li>
        )}
      </ul>
      <NewWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
      {settingsOpen && <PageErrorBoundary><SettingsDialog me={me} workspace={undefined} path={path} onClose={() => navigate("/")} /></PageErrorBoundary>}
    </DeskHomeFrame>
  );
}

/** The home's frame: the Jun mark, the theme and your account menu over the page. */
function DeskHomeFrame({ user, onSignOut, children }: { user: { name: string; email?: string | null } | null; onSignOut?: () => void; children: ReactNode }) {
  const pref = useThemePref();
  const next = THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length]!;
  const ThemeIcon = THEME_ICON[pref];
  const themeTitle = `Theme: ${THEME_LABEL[pref]} (switch to ${THEME_LABEL[next]})`;
  return (
    <div className="home">
      <header className="home-bar">
        <a className="brand" href="/" aria-label="Jun: all workspaces"><DeskIcon /><span>Jun</span></a>
        <div className="home-bar-end">
          <Button variant="ghost" size="icon-sm" type="button" onClick={() => setThemePref(next)} aria-label={themeTitle} title={themeTitle}>
            <ThemeIcon />
          </Button>
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" data-plain className="home-user" aria-label="Account" />}>
                <span className="avatar me" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
                <span className="home-user-name">{user.name}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="desk-user-menu-head">
                    <span className="desk-user-name">{user.name}</span>
                    {user.email && <span className="desk-user-sub">{user.email}</span>}
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => navigate("/settings/account")}>
                    <KeyIcon />
                    Your account
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/settings/desk")}>
                    <ColumnsIcon />
                    This desk
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={async () => { await api("/auth/logout", { body: {} }); onSignOut?.(); }}>
                  <SignOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      <main className="home-main">{children}</main>
    </div>
  );
}

function WorkspaceCard({ workspace: w }: { workspace: WorkspaceSummary }) {
  const href = `/w/${encodeURIComponent(w.workspaceSlug)}/home`;
  const open = (e: MouseEvent) => {
    // A new tab or window keeps the browser's own behaviour.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    switchWorkspace(w);
  };
  return (
    <li>
      <a className="home-card" href={href} onClick={open}>
        <div className="home-card-top" style={{ "--ws-color": w.color } as CSSProperties}>
          <WorkspaceMark workspace={w} />
        </div>
        <div className="home-card-body">
          <div className="home-card-title">
            <span className="home-card-name">{w.workspaceName}</span>
            <span className="home-card-role">{ROLE_LABEL[w.role]}</span>
          </div>
          <p className={`home-card-site${w.installed ? "" : " muted"}`}>
            <GlobeIcon aria-hidden="true" />
            <span>{w.installedOn ?? (w.installed ? "Installed" : "Not installed")}</span>
          </p>
          <dl className="home-card-stats">
            <div><dt>Open</dt><dd>{w.open}</dd></div>
            <div data-attention={w.waiting > 0 ? "" : undefined}><dt title="Open chats waiting for a person">Need a person</dt><dd>{w.waiting}</dd></div>
            <div><dt>AI replies</dt><dd className="home-card-ai" data-on={w.aiOn ? "" : undefined}>{w.aiOn ? "On" : "Off"}</dd></div>
          </dl>
        </div>
      </a>
    </li>
  );
}

/** The widget's logo (its dark one on the dark theme), or the name's initial on the widget's colour. */
function WorkspaceMark({ workspace: w }: { workspace: WorkspaceSummary }) {
  useThemePref();
  const dark = document.documentElement.dataset.theme === "dark";
  const logo = (dark ? w.logoDarkUrl : null) ?? w.logoUrl;
  if (logo) return <span className="home-card-mark"><img src={logo} alt="" /></span>;
  return (
    <span className="home-card-mark" style={{ background: w.color, color: textOn(w.color) }} aria-hidden="true">
      {w.workspaceName.slice(0, 1).toUpperCase()}
    </span>
  );
}

function WorkspaceCardSkeleton({ name }: { name?: string }) {
  return (
    <li>
      <div className="home-card">
        <div className="home-card-top"><Skeleton className="home-card-mark" /></div>
        <div className="home-card-body">
          <div className="home-card-title"><span className="home-card-name">{name ?? <SkelText width={96} />}</span></div>
          <p className="home-card-site"><SkelText width={120} /></p>
          <dl className="home-card-stats">
            <div><dt>Open</dt><dd><SkelText width={20} /></dd></div>
            <div><dt title="Open chats waiting for a person">Need a person</dt><dd><SkelText width={20} /></dd></div>
            <div><dt>AI replies</dt><dd><SkelText width={24} /></dd></div>
          </dl>
        </div>
      </div>
    </li>
  );
}

/** Before /me answers, on a browser that last saw two or more workspaces: the same frame and cards. */
export function DeskHomeSkeleton({ name }: { name: string }) {
  return (
    <DeskHomeFrame user={{ name }}>
      <div className="home-head">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">One for each website or product, each with its own chat widget, inbox, AI agent and team.</p>
        </div>
      </div>
      <ul className="home-grid" aria-busy="true">
        {[0, 1].map((i) => <WorkspaceCardSkeleton key={i} />)}
      </ul>
    </DeskHomeFrame>
  );
}
