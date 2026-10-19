import { useCallback, useEffect, useRef, useState } from "react";
import { api, registerPasskey, type Me } from "./api.ts";
import { IssueTrackersPanel } from "./settings/IssueTrackersPanel.tsx";
import { AssignmentPanel, SavedRepliesPanel, TagsPanel, TopicsMovedNote } from "./settings/InboxPanels.tsx";
import { NotificationsPanel } from "./settings/NotificationsPanel.tsx";
import { HoursPanel, type InboxSettings } from "./settings/WidgetPanels.tsx";
import { SettingRow, SettingsCard } from "./settings/layout.tsx";
import { cachedGet, fetchSetting, prefetchSettings, sectionRequests, useSectionReady } from "./settings/settingsData.ts";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";
import { navigate } from "./lib/router.ts";
import { AiPanel, GitCard } from "./agent/AiPanel.tsx";
import { setThemePref, THEME_LABEL, THEME_PREFS, useThemePref, type ThemePref } from "./lib/theme.ts";
import { useAction } from "./useAction.ts";
import { UPDATE_HELP, useUpdate } from "./lib/updates.ts";
import { JUN_VERSION } from "../shared/version.ts";
import { goHome, switchWorkspace, type Membership } from "./workspaces/workspace.ts";
import { NewWorkspaceDialog } from "./workspaces/WorkspaceSwitcher.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  BugIcon, ChevronLeftIcon, ColumnsIcon, InboxIcon, KeyIcon, MonitorIcon, MoonIcon, NotificationIcon, SettingsIcon, SparkleIcon, SunIcon, UsersIcon, XIcon,
} from "@/components/icons";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectField, SelectOption } from "@/components/ui/select-field.tsx";

interface Passkey { id: string; name: string | null; backedUp: number; createdAt: number; lastUsedAt: number | null }
type Role = "owner" | "admin" | "agent";
interface Member { id: string; name: string; email: string | null; role: Role }
interface Invite { id: string; role: Role; createdBy: string; createdAt: number; expiresAt: number }

const RANK: Record<Role, number> = { owner: 3, admin: 2, agent: 1 };
const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

// Town's settings dialog (D-35): a 924×720 modal, a 224px nav on the left (the sections, then the theme
// at the bottom) and one section at a time in the pane. The URL follows the
// open section (/settings/<id>, /settings = the first), so links, the back button and reloads work;
// the page you came from stays behind it.
// D-97: three levels, grouped in the nav and named over each section: this workspace's settings,
// yours (on every workspace) and the desk's (all of its workspaces). The desk's home opens the same
// dialog with only the last two, at /settings/account and /settings/desk.
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", Icon: SettingsIcon, level: "workspace" },
  { id: "ai", label: "AI", Icon: SparkleIcon, level: "workspace" },
  { id: "inbox", label: "Inbox", Icon: InboxIcon, level: "workspace" },
  { id: "team", label: "Team", Icon: UsersIcon, level: "workspace" },
  { id: "notifications", label: "Notifications", Icon: NotificationIcon, level: "workspace" },
  { id: "integrations", label: "Issue trackers", Icon: BugIcon, level: "workspace" },
  { id: "account", label: "Account", Icon: KeyIcon, level: "account" },
  { id: "desk", label: "Desk", Icon: ColumnsIcon, level: "desk" },
] as const;
type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
type Level = (typeof SETTINGS_SECTIONS)[number]["level"];

const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

// Old one-page anchors (bookmarks, other pages' links) → the section that now holds them.
const LEGACY_HASHES: Record<string, string> = {
  // D-120: Topics are managed in Reports' sheet.
  "#topics": "/dashboard/topics",
  "#assignment": "/settings/inbox#assignment",
  "#issue-trackers": "/settings/integrations#issue-trackers",
  "#notifications": "/settings/notifications",
};

/**
 * Settings URLs whose parts moved: the widget's install panels (the Chat widget page's Install and Behaviour tabs), and
 * old links to the AI settings (D-71: Settings → AI). The ChatGPT sign-in still returns to
 * /settings?chatgpt=connected. Null when the URL is still the dialog's.
 */
export function movedFromSettings(path: string, search: string, hash: string): string | null {
  if (!path.startsWith("/settings")) return null;
  const sub = path.replace(/^\/settings\/?/, "").split("/")[0] ?? "";
  if (sub === "widget") return "/playground/install";
  // D-120: Topics moved to Reports (a sheet over the page).
  if (sub === "inbox" && hash === "#topics") return "/dashboard/topics";
  // D-86: Connect your AI and API tokens are the MCP page now.
  if (sub === "developer") return hash === "#api-tokens" ? "/connect/tokens" : "/connect";
  if (!sub && (hash === "#ai-assistant" || new URLSearchParams(search).get("chatgpt") === "connected")) return `/settings/ai${search}`;
  return null;
}

/**
 * Open while the URL is /settings…; `onClose` leaves it (back to the page behind). `workspace`:
 * the one you're in; none on the desk's home, which has only your account and the desk.
 */
export function SettingsDialog({ me, workspace, path, onClose }: { me: Me; workspace: Membership | undefined; path: string; onClose: () => void }) {
  const sub = path.replace(/^\/settings\/?/, "").split("/")[0] ?? "";
  const sections = workspace ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.filter((s) => s.level !== "workspace");
  const section = sections.find((s) => s.id === sub) ?? sections[0]!;
  // Phones show the nav as a list first (Town's mobile layout); a section URL opens straight on it.
  const [mobileList, setMobileList] = useState(!sub);
  const pane = useRef<HTMLDivElement>(null);
  const themePref = useThemePref();
  // Every section's data at once, so switching sections never waits or fills in piece by piece.
  useEffect(() => {
    prefetchSettings(workspace?.workspaceId ?? null, Boolean(workspace && workspace.role !== "agent"));
  }, [workspace]);

  useEffect(() => {
    if (sub && !sections.some((s) => s.id === sub)) return navigate(workspace ? "/settings" : "/settings/account", { replace: true });
    if (sub) return;
    const { hash } = window.location;
    if (workspace && LEGACY_HASHES[hash]) navigate(LEGACY_HASHES[hash], { replace: true });
  }, [sub, sections, workspace]);
  // A new section starts at the top (an #anchor scrolls itself into view).
  useEffect(() => {
    if (!window.location.hash) pane.current?.scrollTo(0, 0);
  }, [section.id]);

  if (!me.user) return null;
  const workspaceId = workspace?.workspaceId ?? "";
  const role: Role = workspace?.role ?? "agent";
  const canEdit = role !== "agent";
  const open = (id: SectionId) => {
    setMobileList(false);
    navigate(`/settings/${id}`, { replace: true });
  };

  const nextTheme = THEME_PREFS[(THEME_PREFS.indexOf(themePref) + 1) % THEME_PREFS.length]!;
  const ThemeIcon = THEME_ICON[themePref];

  const groups: { level: Level; label: string }[] = [
    ...(workspace ? [{ level: "workspace" as const, label: `Workspace · ${workspace.workspaceName}` }] : []),
    { level: "account", label: "You" },
    { level: "desk", label: "This desk" },
  ];
  const nav = (
    <>
      {groups.map((g) => (
        <div key={g.level} className="settings-nav-group" role="group" aria-label={g.label}>
          <span className="settings-nav-label">{g.label}</span>
          {sections.filter((s) => s.level === g.level).map(({ id, label, Icon }) => (
            <button key={id} type="button" data-plain className="settings-nav-item" aria-current={id === section.id ? "page" : undefined} onClick={() => open(id)}>
              <Icon />
              <span>{label}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
  // Over each section: whose settings these are.
  const scope = section.level === "workspace"
    ? <>Only <b>{workspace?.workspaceName}</b>: its chat widget, inbox, AI and team.</>
    : section.level === "account"
      ? <>Yours, the same in every workspace on this desk.</>
      : <>The whole desk: every workspace on it.</>;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="settings-dialog" showCloseButton={false} data-view={mobileList ? "list" : "section"} initialFocus={pane}>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <aside className="settings-nav" aria-label="Settings sections">
          {nav}
          <div className="settings-nav-foot">
            <button type="button" data-plain className="settings-nav-tile" onClick={() => setThemePref(nextTheme)} aria-label={`Theme: ${THEME_LABEL[themePref]} (switch to ${THEME_LABEL[nextTheme]})`}>
              <ThemeIcon />
              <span>Theme</span>
              <span className="settings-nav-tile-value">{THEME_LABEL[themePref]}</span>
            </button>
          </div>
        </aside>
        <div className="settings-pane" ref={pane} tabIndex={-1}>
          <nav className="settings-mobile-nav" aria-label="Settings sections">{nav}</nav>
          <button type="button" data-plain className="settings-back" onClick={() => setMobileList(true)}>
            <ChevronLeftIcon />
            Settings
          </button>
          <div className="settings-sections">
            <p className="settings-scope" data-level={section.level}>{scope}</p>
            <Section id={section.id} me={me} workspace={workspace} workspaceId={workspaceId} canEdit={canEdit} role={role} myId={me.user.id} />
          </div>
        </div>
        <DialogClose className="settings-close" aria-label="Close settings">
          <XIcon />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/** Each section's cards, for its skeleton: the same titles in the same order. */
const SECTION_CARDS: Record<SectionId, (canInvite: boolean) => string[]> = {
  general: () => ["Workspace"],
  ai: () => ["AI replies", "Keep it in git"],
  inbox: () => ["Assignment", "Business hours", "Saved replies", "Tags", "Topics"],
  team: (canInvite) => ["Members", ...(canInvite ? ["Invite people"] : [])],
  notifications: () => ["This device", "Notify me when"],
  integrations: () => ["Issue trackers", "GitHub", "Linear"],
  account: () => ["Your account", "Your passkeys"],
  desk: () => ["This desk"],
};

/** A section shows only once all of its data is in (fetched when Settings opened), then all at once. */
type SectionProps = { id: SectionId; me: Me; workspace: Membership | undefined; workspaceId: string; canEdit: boolean; role: Role; myId: string };

function Section(props: SectionProps) {
  const canInvite = props.role !== "agent";
  const ready = useSectionReady(sectionRequests(props.id, props.workspaceId, canInvite));
  if (!ready) {
    // Straight in the section list (no wrapper), so the cards keep their dividers.
    return (
      <>
        {SECTION_CARDS[props.id](canInvite).map((title) => (
          <SettingsCard key={title} title={title} description={<SkelText width={360} />}>
            <Skeleton className="settings-skel-body" aria-busy="true" aria-label="Loading" />
          </SettingsCard>
        ))}
      </>
    );
  }
  return <SectionPanels {...props} />;
}

function SectionPanels({ id, me, workspace, workspaceId, canEdit, role, myId }: SectionProps) {
  switch (id) {
    case "general":
      return workspace ? <GeneralPanel me={me} workspace={workspace} /> : null;
    case "ai":
      return (
        <>
          <AiPanel workspaceId={workspaceId} canEdit={canEdit} />
          <GitCard />
        </>
      );
    case "inbox":
      return (
        <>
          <AssignmentPanel workspaceId={workspaceId} canEdit={canEdit} />
          <WidgetSettings workspaceId={workspaceId} canEdit={canEdit} />
          <SavedRepliesPanel workspaceId={workspaceId} />
          <TagsPanel workspaceId={workspaceId} canEdit={canEdit} />
          <TopicsMovedNote />
        </>
      );
    case "team":
      return <TeamPanel workspaceId={workspaceId} myRole={role} myId={myId} />;
    case "notifications":
      return <NotificationsPanel workspaceId={workspaceId} />;
    case "integrations":
      return <IssueTrackersPanel workspaceId={workspaceId} canEdit={canEdit} />;
    case "account":
      return (
        <>
          <AccountPanel me={me} />
          <PasskeysPanel />
        </>
      );
    case "desk":
      return <DeskPanel me={me} onHome={!workspace} />;
  }
}

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", agent: "Agent" };

/** The workspace's General: its name and your role in it; D-95: owners and admins rename it, owners delete it. */
function GeneralPanel({ me, workspace }: { me: Me; workspace: Membership }) {
  return (
    <>
      <SettingsCard title="Workspace" description="This website or product: its name, and what you can do in it.">
        {workspace.role === "agent"
          ? <SettingRow label="Name"><span className="setting-row-value">{workspace.workspaceName}</span></SettingRow>
          : <WorkspaceNameRow workspace={workspace} />}
        <SettingRow label="Your role" description="Owners and admins change workspace settings; agents answer chats."><span className="setting-row-value">{ROLE_LABEL[workspace.role]}</span></SettingRow>
      </SettingsCard>
      {workspace.role === "owner" && <DeleteWorkspaceCard workspace={workspace} others={(me.memberships ?? []).filter((m) => m.workspaceId !== workspace.workspaceId)} />}
    </>
  );
}

/** D-97: yours, on every workspace: who you're signed in as, and this browser's theme. */
function AccountPanel({ me }: { me: Me }) {
  const themePref = useThemePref();
  return (
    <SettingsCard title="Your account" description="One account for every workspace you're in on this desk.">
      <SettingRow label="Name"><span className="setting-row-value">{me.user?.name}</span></SettingRow>
      {me.user?.email && <SettingRow label="Email"><span className="setting-row-value">{me.user.email}</span></SettingRow>}
      <SettingRow label="Theme" description="Saved in this browser.">
        <SelectField value={themePref} onValueChange={(value) => setThemePref(value as ThemePref)} aria-label="Theme">
          {THEME_PREFS.map((p) => <SelectOption key={p} value={p}>{THEME_LABEL[p]}</SelectOption>)}
        </SelectField>
      </SettingRow>
    </SettingsCard>
  );
}

/** D-97: the desk itself, shared by all of its workspaces: Jun's version, and the workspaces. */
function DeskPanel({ me, onHome }: { me: Me; onHome: boolean }) {
  const all = me.memberships ?? [];
  const admin = all.some((m) => m.role !== "agent");
  const owner = all.some((m) => m.role === "owner");
  const [creating, setCreating] = useState(false);
  return (
    <SettingsCard title="This desk" description="Shared by every workspace on it: one Jun, deployed to your Cloudflare account.">
      <VersionRow admin={admin} />
      <SettingRow
        label="Workspaces"
        description={owner ? "One for each website or product, each with its own widget, inbox, AI agent and team." : "The ones you're in. Owners create new ones."}
      >
        <div className="row">
          <span className="setting-row-value">{all.length === 1 ? "1 workspace" : `${all.length} workspaces`}</span>
          {all.length > 1 && !onHome && <Button size="sm" variant="outline" onClick={goHome}>All workspaces</Button>}
          {owner && <Button size="sm" variant="outline" onClick={() => setCreating(true)}>New workspace</Button>}
        </div>
      </SettingRow>
      <NewWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
    </SettingsCard>
  );
}

function WorkspaceNameRow({ workspace }: { workspace: Membership }) {
  const [name, setName] = useState(workspace.workspaceName);
  const { busy, error, run } = useAction();
  const changed = name.trim() !== "" && name.trim() !== workspace.workspaceName;
  const save = () =>
    run(async () => {
      await api(`/workspaces/${workspace.workspaceId}`, { method: "PATCH", body: { name } });
      // The sidebar, the switcher and every page read the name from /me: start fresh with it.
      window.location.reload();
    });
  return (
    <SettingRow
      label="Name"
      htmlFor="ws-rename"
      description={error ? <span className="error">{error}</span> : "Shown in the sidebar, and to customers until the chat widget has its own name."}
    >
      <form className="ws-rename" onSubmit={(e) => { e.preventDefault(); if (changed) save(); }}>
        <Input id="ws-rename" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        {changed && <Button size="sm" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>}
      </form>
    </SettingRow>
  );
}

function DeleteWorkspaceCard({ workspace, others }: { workspace: Membership; others: Membership[] }) {
  const [typed, setTyped] = useState("");
  const { busy, error, run } = useAction();
  const next = others[0];
  const remove = () =>
    run(async () => {
      await api(`/workspaces/${workspace.workspaceId}`, { method: "DELETE", body: { name: typed } });
      // D-97: two or more left: the desk's home; else the one that's left.
      if (others.length > 1) goHome();
      else if (next) switchWorkspace(next);
    });
  return (
    <SettingsCard
      title="Delete workspace"
      description="Deletes its conversations, contacts, knowledge, AI agent, chat widget and API tokens for good; its widget stops working on your website. Teammates who are only in this workspace lose their account."
    >
      {next ? (
        <SettingRow label="Confirm" htmlFor="ws-delete" description={error ? <span className="error">{error}</span> : <>Type <b>{workspace.workspaceName}</b> to delete it.</>}>
          <form className="ws-rename" onSubmit={(e) => { e.preventDefault(); if (typed === workspace.workspaceName) remove(); }}>
            <Input id="ws-delete" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
            <Button size="sm" variant="destructive" disabled={busy || typed !== workspace.workspaceName}>{busy ? "Deleting…" : "Delete"}</Button>
          </form>
        </SettingRow>
      ) : (
        <p className="small muted">This is your only workspace. To delete it, first create another one from the workspace menu at the top of the sidebar.</p>
      )}
    </SettingsCard>
  );
}

/** T-17: this desk's Jun version, and for owners and admins whether a newer one is out. */
function VersionRow({ admin }: { admin: boolean }) {
  const update = useUpdate(admin);
  return (
    <SettingRow
      label="Version"
      description={update ? <>Jun v{update.version} is out. Your repo's Update Jun workflow opens a pull request with it; merging deploys it. <a href={UPDATE_HELP} target="_blank" rel="noreferrer">How to update</a></> : "Updates come as pull requests to your copy of the repo."}
    >
      <span className="setting-row-value">
        v{JUN_VERSION}
        {update && <> · <a href={update.url} target="_blank" rel="noreferrer">v{update.version} is out</a></>}
      </span>
    </SettingRow>
  );
}

function PasskeysPanel() {
  const [passkeys, setPasskeys] = useState<Passkey[]>(() => cachedGet<{ passkeys: Passkey[] }>("/passkeys")?.passkeys ?? []);
  const { busy, error, run } = useAction();
  const loadPasskeys = useCallback(async () => {
    setPasskeys((await fetchSetting<{ passkeys: Passkey[] }>("/passkeys")).passkeys);
  }, []);
  useEffect(() => {
    loadPasskeys().catch(() => {});
  }, [loadPasskeys]);

  return (
    <SettingsCard
      title="Your passkeys"
      description="Add a passkey on a second device so you can't get locked out."
      action={<Button disabled={busy} onClick={() => run(async () => { await registerPasskey("/passkeys"); await loadPasskeys(); })}>Add passkey</Button>}
    >
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {passkeys.map((p) => (
          <li key={p.id}>
            <span>{p.name ?? "Passkey"} {p.backedUp ? <em className="tag">synced</em> : null}</span>
            <span className="muted small">added {date(p.createdAt)} · last used {date(p.lastUsedAt)}</span>
            {passkeys.length > 1 && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }); await loadPasskeys(); })}>Remove</Button>
            )}
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

function TeamPanel({ workspaceId, myRole, myId }: { workspaceId: string; myRole: Role; myId: string }) {
  const [members, setMembers] = useState<Member[]>(() => cachedGet<{ members: Member[] }>(`/workspaces/${workspaceId}/members`)?.members ?? []);
  const [invites, setInvites] = useState<Invite[]>(() => cachedGet<{ invites: Invite[] }>(`/workspaces/${workspaceId}/invites`)?.invites ?? []);
  const [inviteRole, setInviteRole] = useState<"agent" | "admin">("agent");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const canInvite = myRole === "owner" || myRole === "admin";
  const base = `/workspaces/${workspaceId}`;

  const load = useCallback(async () => {
    // Both at once, applied together, so the cards don't fill in one after the other.
    const [m, i] = await Promise.all([fetchSetting<{ members: Member[] }>(`${base}/members`), canInvite ? fetchSetting<{ invites: Invite[] }>(`${base}/invites`) : null]);
    setMembers(m.members);
    if (i) setInvites(i.invites);
  }, [base, canInvite]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const createInvite = () =>
    run(async () => {
      setCopied(false);
      setInviteUrl((await api<{ url: string }>(`${base}/invites`, { body: { role: inviteRole } })).url);
      await load();
    });

  const copy = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
  };

  return (
    <>
      <SettingsCard
        title="Members"
        description={<>Each person signs in with their own passkey.{myRole === "owner" && " Admins can invite and manage agents; only you can manage admins."}</>}
      >
        {error && <p className="error">{error}</p>}
        <ul className="list">
          {members.map((m) => {
            const manageable = RANK[myRole] > RANK[m.role];
            return (
              <li key={m.id}>
                <span>{m.name}{m.id === myId && <span className="muted"> (you)</span>}</span>
                <span className="muted small">{m.email}</span>
                {manageable ? (
                  <>
                    <SelectField
                      value={m.role}
                      disabled={busy}
                      aria-label={`Role for ${m.name}`}
                      onValueChange={(value) => run(async () => { await api(`${base}/members/${m.id}`, { method: "PATCH", body: { role: value } }); await load(); })}
                    >
                      <SelectOption value="agent">agent</SelectOption>
                      {myRole === "owner" && <SelectOption value="admin">admin</SelectOption>}
                    </SelectField>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (!confirm(`Remove ${m.name}? They'll be signed out and lose access.`)) return; run(async () => { await api(`${base}/members/${m.id}`, { method: "DELETE" }); await load(); }); }}>
                      Remove
                    </Button>
                  </>
                ) : (
                  <em className="tag">{m.role}</em>
                )}
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      {canInvite && (
        <SettingsCard title="Invite people" description="Invite links work once and expire after 7 days.">
          <SettingRow label="Role" description="What the person can do once they join.">
            <div className="row">
              <SelectField value={inviteRole} onValueChange={(value) => setInviteRole(value as "agent" | "admin")} aria-label="Invite role">
                <SelectOption value="agent">Agent</SelectOption>
                {myRole === "owner" && <SelectOption value="admin">Admin</SelectOption>}
              </SelectField>
              <Button disabled={busy} onClick={createInvite}>Create invite link</Button>
            </div>
          </SettingRow>
          {inviteUrl && (
            <div className="invite">
              <span className="small">Send this link to the person you're inviting. It's shown only once.</span>
              <div className="row">
                <code>{inviteUrl}</code>
                <Button size="sm" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</Button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <div className="settings-group">
              <h3>Pending invites</h3>
              <ul className="list">
                {invites.map((i) => (
                  <li key={i.id}>
                    <span>{i.role === "admin" ? "Admin" : "Agent"} invite</span>
                    <span className="muted small">by {i.createdBy} · expires {date(i.expiresAt)}</span>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`${base}/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" }); await load(); })}>Revoke</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SettingsCard>
      )}
    </>
  );
}

/** I-10 hours (the widget's look, W-04, is on the Widget page). */
function WidgetSettings({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const url = `/workspaces/${workspaceId}/inbox`;
  const [inbox, setInbox] = useState<{ widgetKey: string; settings: InboxSettings } | null>(() => cachedGet<{ inbox: { widgetKey: string; settings: InboxSettings } | null }>(url)?.inbox ?? null);
  useEffect(() => {
    fetchSetting<{ inbox: { widgetKey: string; settings: InboxSettings } | null }>(url).then((r) => setInbox(r.inbox), () => {});
  }, [url]);
  if (!inbox) return null;
  return <HoursPanel workspaceId={workspaceId} settings={inbox.settings} canEdit={canEdit} onSaved={(settings) => setInbox({ ...inbox, settings })} />;
}
