import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { api, describeError, type Me } from "../api.ts";
import { navigate, usePath } from "../lib/router.ts";
import { setThemePref, THEME_LABEL, THEME_PREFS, useThemePref } from "../lib/theme.ts";
import { textOn } from "../../shared/appearance.ts";
import type { WorkspaceSummary } from "../../shared/workspace-summary.ts";
import { BotIcon, ChatIcon, CheckIcon, ColumnsIcon, RefreshIcon, GlobeIcon, HandoffIcon, KeyIcon, MonitorIcon, MoonIcon, PlusIcon, SignOutIcon, SunIcon } from "@/components/icons";
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
            <button type="button" data-plain className="ws-card ws-card-new" onClick={() => setCreating(true)}>
              <span className="ws-card-new-icon" aria-hidden="true"><PlusIcon /></span>
              <span className="ws-card-new-name">New workspace</span>
              <span className="muted small">For another website or product.</span>
            </button>
          </li>
        )}
      </ul>
      {list && list.length > 0 && <DeskTotals list={list} />}
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

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const today = () => new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** D-140: a card per workspace (D-143: neutral, its colour only in the mark): its name and a line on how it's doing, over a small inbox panel
 * peeking from the bottom (open chats, who needs a person, AI replies, where the widget is). */
function WorkspaceCard({ workspace: w }: { workspace: WorkspaceSummary }) {
  const href = `/w/${encodeURIComponent(w.workspaceSlug)}/home`;
  const open = (e: MouseEvent) => {
    // A new tab or window keeps the browser's own behaviour.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    switchWorkspace(w);
  };
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const shot = useSiteShot(w, version);
  const refresh = () => {
    setRefreshing(true);
    api(`/workspaces/${encodeURIComponent(w.workspaceId)}/site-shot/refresh`, { body: {} })
      .then(() => setVersion(Date.now()))
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };
  const lede = w.waiting ? `${plural(w.waiting, "chat")} ${w.waiting === 1 ? "needs" : "need"} a person.` : w.open ? "Nothing waiting on a person." : "All quiet.";
  const more = [w.installed ? (w.installedOn ? `Live on ${hostOf(w.installedOn)}` : "Widget installed") : "Widget not installed yet", w.aiOn ? "the AI answers first" : "AI replies are off"].join(", ") + ".";
  return (
    <li>
      <a className="ws-card" href={href} onClick={open}>
        <div className="ws-card-head">
          <WorkspaceMark workspace={w} />
          <span className="ws-card-name">{w.workspaceName}</span>
          <span className="ws-card-role">{ROLE_LABEL[w.role]}</span>
        </div>
        <p className="ws-card-lede"><b>{lede}</b> {more}</p>
        <p className="ws-card-chips"><span>{plural(w.open, "open chat")}</span>{w.waiting > 0 && <span data-warn="">{w.waiting} need a person</span>}</p>
        {/* One window for both: the website's picture once it has loaded, else the inbox at a glance (D-141). */}
        <div className="ws-card-site" aria-hidden="true">
          <div className="ws-card-site-bar"><i /><i /><i /><span>{shot ? hostOf(w.installedOn) : `Inbox · ${today()}`}</span></div>
          {shot ? (
            <img src={shot} alt="" />
          ) : (
            <ul className="ws-card-inbox">
              <li data-on={w.open ? "" : undefined}><span className="ws-check"><ChatIcon /></span>{plural(w.open, "open chat")}</li>
              <li data-warn={w.waiting ? "" : undefined}><span className="ws-check"><HandoffIcon /></span>{w.waiting ? `${w.waiting} need a person` : "No one waiting"}</li>
              <li data-on={w.aiOn ? "" : undefined}><span className="ws-check">{w.aiOn ? <CheckIcon /> : <BotIcon />}</span>AI replies {w.aiOn ? "on" : "off"}</li>
              <li data-on={w.installed ? "" : undefined}><span className="ws-check"><GlobeIcon /></span>{w.installedOn ? hostOf(w.installedOn) : w.installed ? "Installed" : "Not installed"}</li>
            </ul>
          )}
        </div>
      </a>
      {w.installedOn && w.role !== "agent" && (
        <button type="button" data-plain className="ws-card-refresh" onClick={refresh} disabled={refreshing} aria-label="Take a new picture of the website" title="Take a new picture of the website">
          <RefreshIcon className={refreshing ? "spin" : undefined} />
        </button>
      )}
    </li>
  );
}

const hostOf = (origin: string | null) => (origin ? origin.replace(/^https?:\/\//, "") : "");

/** D-141: the picture of the workspace's website (`…/site-shot`), once it has loaded; null while it loads or when
 * there's none, so the card shows its inbox panel instead. */
function useSiteShot(w: WorkspaceSummary, version: number): string | null {
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!w.installedOn) return;
    const src = `/api/workspaces/${encodeURIComponent(w.workspaceId)}/site-shot${version ? `?v=${version}` : ""}`;
    const img = new Image();
    img.onload = () => setReady(src);
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [w.workspaceId, w.installedOn, version]);
  return ready;
}

/** Under the cards (the reference's stat row): the desk's numbers across every workspace you're in. */
function DeskTotals({ list }: { list: WorkspaceSummary[] }) {
  const sum = (f: (w: WorkspaceSummary) => number) => list.reduce((n, w) => n + f(w), 0);
  const stats = [
    { n: list.length, label: list.length === 1 ? "Workspace" : "Workspaces" },
    { n: sum((w) => w.open), label: "Open chats" },
    { n: sum((w) => w.waiting), label: "Need a person" },
    { n: list.filter((w) => w.aiOn).length, label: "With AI replies on" },
  ];
  return (
    <dl className="ws-totals">
      {stats.map((s) => <div key={s.label}><dt>{s.label}</dt><dd>{s.n.toLocaleString()}</dd></div>)}
    </dl>
  );
}

/** The widget's logo (its dark one on the dark theme), or the name's initial on the widget's colour. */
function WorkspaceMark({ workspace: w }: { workspace: WorkspaceSummary }) {
  useThemePref();
  const dark = document.documentElement.dataset.theme === "dark";
  const logo = (dark ? w.logoDarkUrl : null) ?? w.logoUrl;
  if (logo) return <span className="ws-card-mark"><img src={logo} alt="" /></span>;
  return (
    <span className="ws-card-mark ws-card-initial" style={{ background: w.color, color: textOn(w.color) }} aria-hidden="true">
      {w.workspaceName.slice(0, 1).toUpperCase()}
    </span>
  );
}

function WorkspaceCardSkeleton({ name }: { name?: string }) {
  return (
    <li>
      <div className="ws-card ws-card-skel">
        <div className="ws-card-head"><Skeleton className="ws-card-mark" /><span className="ws-card-name">{name ?? <SkelText width={96} />}</span></div>
        <p className="ws-card-lede"><SkelText width="80%" /></p>
        <div className="ws-card-site"><div className="ws-card-site-bar"><i /><i /><i /></div><ul className="ws-card-inbox"><li><SkelText width={90} /></li><li><SkelText width={110} /></li></ul></div>
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
