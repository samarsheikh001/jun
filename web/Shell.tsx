import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpIcon, BotIcon, ChannelsIcon, ChartColumnIcon, ChatIcon, ColumnsIcon, ContactsIcon, KeyIcon, FlashIcon, HelpIcon, HomeIcon, InboxIcon, McpIcon, SearchIcon, SettingsIcon, SignOutIcon, UsersIcon } from "@/components/icons";
import { knownUpdate, UPDATE_HELP, useUpdate, type LatestRelease } from "./lib/updates.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarGroupLabel, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar.tsx";
import { DeskIcon } from "./components/DeskIcon.tsx";
import { PageErrorBoundary } from "./components/PageErrorBoundary.tsx";
import { ThemeButton } from "./components/ThemeButton.tsx";
import type { HubClientEvent, HubEvent, LiveVisitor, PresenceEntry } from "../shared/protocol.ts";
import { api, type Me } from "./api.ts";
import { InboxPage } from "./inbox/InboxPage.tsx";
import { WidgetPage, movedFromAppearance, type WidgetTab } from "./appearance/AppearancePage.tsx";
import { AGENT_SECTIONS, AgentPage, agentNavId, movedFromAgentCode } from "./agent/AgentPage.tsx";
import { CommandPalette, ShortcutsHelp } from "./components/CommandPalette.tsx";
import { bridge, isControlTarget, isTypingTarget, modKey } from "./lib/bridge.ts";
import { dispatchShortcut, INITIAL_SHORTCUT_STATE, type ShortcutCommand } from "./lib/commands.ts";
import { KnowledgePage } from "./knowledge/KnowledgePage.tsx";
import { deskServiceWorker, listenForNotificationClicks, notificationPermission, showInPageNotification, tabFocused } from "./lib/notifications.ts";
import { LiveSocket } from "./lib/socket.ts";
import { playChime, unlockSoundOnInteraction } from "./lib/sound.ts";
import { ReportsPage } from "./reports/ReportsPage.tsx";
import { HomePage } from "./home/HomePage.tsx";
import { deskHref, deskPathname, navigate, usePath } from "./lib/router.ts";
import { slugOf, withoutWorkspace } from "./lib/workspace-url.ts";
import { movedFromSettings, SettingsDialog } from "./SettingsDialog.tsx";
import { VisitorsPage } from "./visitors/VisitorsPage.tsx";
import { ContactsPage } from "./contacts/ContactsPage.tsx";
import { STEP_ORDER, useOnboarding, WelcomePage } from "./welcome/WelcomePage.tsx";
import { GetStartedCard } from "./welcome/GetStartedCard.tsx";
import { SkelText } from "@/components/ui/skeleton.tsx";
import { ConnectPage } from "./connect/ConnectPage.tsx";
import { CHANNEL_SECTIONS, channelSection, ChannelsOverview, EmailChannelPage } from "./channels/ChannelsPage.tsx";
import { WorkspaceSwitcher, WorkspaceSwitcherSkeleton } from "./workspaces/WorkspaceSwitcher.tsx";
import { currentWorkspace, goHome, switchWorkspace } from "./workspaces/workspace.ts";

/**
 * D-113: the sidebar by job. The day's work first, then setting up what customers meet, then
 * developers. The icon rail drops the group labels. I-19 (D-127): a workspace opens on Home (the
 * daily brief and the desk assistant), its first entry.
 */
const NAV_GROUPS = [
  {
    label: null,
    items: [
      { id: "home", label: "Home", Icon: HomeIcon },
      { id: "inbox", label: "Inbox", Icon: InboxIcon },
      { id: "visitors", label: "Visitors", Icon: UsersIcon },
      // V-16 (D-118): every person and company the desk knows; companies at /contacts/companies.
      { id: "contacts", label: "Contacts", Icon: ContactsIcon },
      // The page is Reports; /dashboard stays its address.
      { id: "dashboard", label: "Reports", Icon: ChartColumnIcon },
    ],
  },
  {
    label: "Set up",
    items: [
      // Everything about the AI, Knowledge and its settings included (AGENT_SECTIONS).
      { id: "agent", label: "Agent", Icon: BotIcon },
      // D-116: the chat widget's playground at /playground* (was Chat widget at /appearance*, which
      // forwards): its look and behaviour beside the real widget to try; Install until it's on a site.
      { id: "widget", label: "Playground", Icon: ChatIcon, href: "/playground" },
      // D-112: the other ways customers reach you: Email (C-02) at /channels/email; /channels lists them.
      { id: "channels", label: "Channels", Icon: ChannelsIcon, href: "/channels" },
    ],
  },
  {
    label: "Developers",
    // D-86: connect your own AI to the desk's MCP server (/mcp is the server itself).
    items: [{ id: "connect", label: "MCP", Icon: McpIcon }],
  },
] as const;

/** Which sidebar entry a path belongs to. */
function sectionOf(pagePath: string) {
  return pagePath.startsWith("/home") ? "home"
    : pagePath.startsWith("/knowledge") ? "knowledge"
    : pagePath.startsWith("/agent") ? "agent"
    : pagePath.startsWith("/connect") ? "connect"
    : pagePath.startsWith("/playground") ? "widget"
    : pagePath.startsWith("/channels") ? "channels"
    : pagePath.startsWith("/visitors") ? "visitors"
    : pagePath.startsWith("/contacts") ? "contacts"
    : pagePath.startsWith("/dashboard") || pagePath.startsWith("/reports") ? "dashboard"
    : pagePath.startsWith("/welcome") ? "welcome"
    : "inbox";
}

/** The sidebar entry a page belongs to: Knowledge is listed under Agent (D-113). */
const navOf = (section: ReturnType<typeof sectionOf>) => (section === "knowledge" ? "agent" : section);

/**
 * Who was signed in on this browser last time, for the first frame before /me answers (a
 * per-browser convenience: only the name and workspace shown in the sidebar, never a token).
 */
const LAST_SESSION = "jun:last-session";
export type LastSession = { name: string; workspace: string; admin?: boolean; /** Two or more workspaces: `/` is the desk's home (D-97). */ many?: boolean };
type StoredSession = LastSession & { slug?: string; bySlug?: Record<string, { workspace: string; admin?: boolean }> };
function storedSession(): StoredSession | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_SESSION) ?? "null") as Partial<StoredSession> | null;
    return v && typeof v.name === "string" && typeof v.workspace === "string" ? (v as StoredSession) : null;
  } catch {
    return null;
  }
}
export function lastSession(): LastSession | null {
  const v = storedSession();
  if (!v) return null;
  // D-96: the workspace this tab's URL names, as it was last time (another tab may have shown another one since).
  const here = slugOf(window.location.pathname);
  const seen = here ? v.bySlug?.[here] : undefined;
  return { name: v.name, workspace: seen?.workspace ?? v.workspace, admin: (seen ?? v).admin === true, many: v.many === true };
}
export function rememberSession(session: (LastSession & { slug: string }) | null) {
  try {
    if (session) {
      const bySlug = { ...storedSession()?.bySlug, [session.slug]: { workspace: session.workspace, admin: session.admin === true } };
      localStorage.setItem(LAST_SESSION, JSON.stringify({ ...session, bySlug }));
    } else localStorage.removeItem(LAST_SESSION);
  } catch {
    // Storage blocked: the first frame is just blank next time.
  }
}

/**
 * The first frame of a page load while /me is on its way: the same sidebar as the Shell (same
 * component, entries and footer), the page area empty until the page draws its own skeleton.
 * Nothing in the sidebar moves when the Shell takes over.
 */
export function ShellSkeleton({ session }: { session: LastSession }) {
  const pagePath = deskPathname();
  const section = sectionOf(pagePath);
  return (
    <SidebarProvider className="shell" aria-busy="true">
      <Sidebar collapsible="icon" className="desk-sidebar">
        <SidebarHeader className="desk-sidebar-head">
          <SidebarTrigger />
          <WorkspaceSwitcherSkeleton name={session.workspace} />
        </SidebarHeader>
        <SidebarContent>
          {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label ?? "work"}>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu aria-label={group.label ?? "Main"}>
              {group.items.map((item) => {
                const { id, label, Icon } = item;
                const active = navOf(section) === id;
                return (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton isActive={active} tooltip={label} render={<a href={deskHref("href" in item ? item.href : `/${id}`)} />}>
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                  {id === "channels" && active && (
                    <SidebarMenuSub aria-label="Channels">
                      {CHANNEL_SECTIONS.map((ch) => (
                        <SidebarMenuSubItem key={ch.id}>
                          <SidebarMenuSubButton isActive={channelSection(pagePath) === ch.id} href={deskHref(ch.path)}>
                            <span>{ch.label}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                  {id === "agent" && active && (
                    <SidebarMenuSub aria-label="Agent">
                      {AGENT_SECTIONS.map((a) => (
                        <SidebarMenuSubItem key={a.id}>
                          {a.group && <span className="agent-nav-group">{a.group}</span>}
                          <SidebarMenuSubButton isActive={agentNavId(pagePath) === a.id} href={deskHref(a.path)}>
                            <span>{a.label}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            {session.admin && <UpdateItem update={knownUpdate()} />}
            <SidebarMenuItem>
              <SidebarMenuButton type="button" tooltip={`Search (${modKey()} K)`}>
                <SearchIcon />
                <span>Search</span>
                <kbd className="ml-auto">{modKey()} K</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <ThemeButton />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton type="button" tooltip="Keyboard shortcuts (?)">
                <HelpIcon />
                <span>Keyboard shortcuts</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton type="button" size="lg" className="desk-user" aria-label="Account">
                <span className="avatar me" aria-hidden="true">{session.name.slice(0, 1).toUpperCase()}</span>
                <span className="desk-user-text">
                  <span className="desk-user-name">{session.name}</span>
                  <span className="desk-user-sub">{session.workspace} · <SkelText width={48} /></span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="desk-inset">
        <header className="desk-mobile-bar">
          <SidebarTrigger />
          <div className="brand"><DeskIcon /><span>Jun</span></div>
        </header>
        <main className="desk-main" />
      </SidebarInset>
    </SidebarProvider>
  );
}

/** T-17: a newer Jun is out (owners and admins): how to update, in the docs. */
function UpdateItem({ update }: { update: LatestRelease | null }) {
  if (!update) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip={`Jun ${update.version} is out: how to update`} className="desk-update" render={<a href={UPDATE_HELP} target="_blank" rel="noreferrer" />}>
        <ArrowUpIcon />
        <span>Update to v{update.version}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export interface Hub {
  subscribe(listener: (event: HubEvent) => void): () => void;
}

/** Signed-in layout: header, navigation, the workspace hub socket, and the current page. */
export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  // Old /settings links to the parts that moved out (widget install, AI settings, the ChatGPT
  // sign-in's return). Loading one: the address is rewritten before the first render. Following
  // one inside the desk: rendered as its new page at once (the dialog never flashes), and the
  // address is replaced before paint.
  useState(() => {
    // D-96: first the address goes under its workspace (/w/<slug>/…; old links without one too).
    currentWorkspace(me);
    const { search, hash } = window.location;
    const pathname = deskPathname();
    const target = movedFromSettings(pathname, search, hash) ?? movedFromAgentCode(pathname) ?? movedFromAppearance(pathname);
    if (target) window.history.replaceState(null, "", deskHref(target));
  });
  const urlPath = usePath();
  const moved = movedFromSettings(urlPath, window.location.search, window.location.hash) ?? movedFromAgentCode(urlPath) ?? movedFromAppearance(urlPath);
  const path = moved ? moved.split("?")[0]! : urlPath;
  useLayoutEffect(() => {
    if (moved) navigate(moved, { replace: true });
  }, [moved]);
  // Settings is a dialog over the page you were on (Town's): /settings… opens it, and the page
  // behind keeps the last other path (the inbox when you land on /settings directly).
  const settingsOpen = path.startsWith("/settings");
  const pageBehind = useRef("/home");
  if (!settingsOpen) pageBehind.current = path;
  const pagePath = settingsOpen ? pageBehind.current : path;
  // Opened from inside the desk (a history entry to go back over) or by loading a /settings URL.
  const openedInDesk = useRef(false);
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (settingsOpen && lastPath.current !== null && !lastPath.current.startsWith("/settings")) openedInDesk.current = true;
    if (!settingsOpen) openedInDesk.current = false;
    lastPath.current = path;
  }, [path, settingsOpen]);
  const closeSettings = useCallback(() => {
    if (openedInDesk.current) window.history.back();
    else navigate(pageBehind.current, { replace: true });
  }, []);
  // D-95: one of your workspaces at a time; D-96: the one the URL names (/w/<slug>/…).
  const workspace = currentWorkspace(me);
  // An older notification's link (?ws=<id>) followed inside this tab: that workspace, same page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const asked = params.get("ws");
    if (asked === null || !workspace) return;
    const other = asked !== workspace.workspaceId ? me.memberships?.find((m) => m.workspaceId === asked) : undefined;
    if (other) return switchWorkspace(other, path);
    params.delete("ws");
    const rest = params.toString();
    navigate(path + (rest ? `?${rest}` : "") + window.location.hash, { replace: true });
  }, [path, workspace, me.memberships]);
  // The next page load draws this sidebar (ShellSkeleton) before /me answers.
  useEffect(() => {
    if (me.user && workspace) rememberSession({ name: me.user.name, workspace: workspace.workspaceName, admin: workspace.role !== "agent", slug: workspace.workspaceSlug, many: (me.memberships?.length ?? 0) > 1 });
  }, [me.user, me.memberships, workspace]);
  const [online, setOnline] = useState<PresenceEntry[]>([]);
  // V-01: kept here (not in the page) because the hub sends the full list only on connect.
  // Null until that first list arrives, so the Visitors page shows its skeleton, not "nobody".
  const [visitors, setVisitors] = useState<LiveVisitor[] | null>(null);
  const listeners = useRef(new Set<(event: HubEvent) => void>());
  const onboarding = useOnboarding(workspace?.workspaceId ?? "");
  // T-17: owners and admins see when a newer Jun is out.
  const update = useUpdate(Boolean(workspace && workspace.role !== "agent"));
  // The sidebar's "Get started" checklist follows what's done elsewhere (Settings, Knowledge…).
  const { reload: reloadOnboarding } = onboarding;
  useEffect(() => {
    if (workspace) reloadOnboarding().catch(() => {});
  }, [path, workspace, reloadOnboarding]);

  useEffect(() => {
    if (path === "/" || path === "") navigate("/home", { replace: true });
  }, [path]);

  useEffect(() => {
    if (!workspace) return;
    // I-14: the hub skips Web Push for you while a desk tab is in front of you.
    const reportFocus = () => socket.send({ type: "focus", focused: tabFocused() } satisfies HubClientEvent);
    const socket = new LiveSocket<HubEvent>({
      url: () => `/api/workspaces/${workspace.workspaceId}/ws`,
      onState: (state) => {
        if (state === "open") reportFocus();
      },
      onEvent: (event) => {
        // Not in front of you: a system notification (in front: the inbox's own toasts and lists).
        if (event.type === "notify" && event.mode === "system" && !tabFocused()) void showInPageNotification(event.notification).catch(() => {});
        // I-14 sound: a chime for the same events, unless this tab is in front and showing that chat.
        if (event.type === "notify" && event.sound !== false && !(tabFocused() && deskPathname() === withoutWorkspace(event.notification.url.split("?")[0]!))) playChime({ emphasis: "strong" });
        if (event.type === "presence") setOnline(event.online);
        if (event.type === "visitors") setVisitors(event.visitors);
        if (event.type === "visitor") setVisitors((list) => [...(list ?? []).filter((v) => v.sessionId !== event.visitor.sessionId), event.visitor]);
        if (event.type === "visitor_left") setVisitors((list) => list && list.filter((v) => v.sessionId !== event.sessionId));
        for (const listener of listeners.current) listener(event);
      },
    });
    window.addEventListener("focus", reportFocus);
    window.addEventListener("blur", reportFocus);
    document.addEventListener("visibilitychange", reportFocus);
    // The service worker shows notifications (in-page ones too) and routes clicks to this tab.
    if (notificationPermission() === "granted") void deskServiceWorker().catch(() => {});
    // Browsers allow sound only after you've interacted with the page.
    unlockSoundOnInteraction();
    const stopClicks = listenForNotificationClicks();
    return () => {
      socket.close();
      window.removeEventListener("focus", reportFocus);
      window.removeEventListener("blur", reportFocus);
      document.removeEventListener("visibilitychange", reportFocus);
      stopClicks();
    };
  }, [workspace]);

  // I-13: the command palette, the "?" sheet and the keyboard shortcuts.
  const [overlay, setOverlay] = useState<"palette" | "help" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const shortcutState = useRef(INITIAL_SHORTCUT_STATE);
  const openOverlay = useCallback((next: "palette" | "help") => {
    setOverlay((current) => {
      if (!current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      return next;
    });
  }, []);
  const afterClose = useRef<(() => void) | null>(null);
  /** Closes the palette or sheet; once it's gone, focus goes back and `then` runs (it may move focus on). */
  const closeOverlay = useCallback((then?: () => void) => {
    afterClose.current = then ?? null;
    setOverlay(null);
  }, []);
  useEffect(() => {
    if (overlay) return;
    // After the commit: while a modal dialog is open the rest of the page is inert and can't take focus.
    const target = returnFocus.current;
    const then = afterClose.current;
    returnFocus.current = null;
    afterClose.current = null;
    if (target?.isConnected) target.focus();
    then?.();
  }, [overlay]);
  const showNotice = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const openHelp = useCallback(() => openOverlay("help"), [openOverlay]);

  useEffect(() => {
    const run = (command: ShortcutCommand) => {
      const { inbox, thread } = bridge;
      switch (command) {
        case "palette": return overlay === "palette" ? closeOverlay() : openOverlay("palette");
        case "help": return openOverlay("help");
        case "go-home": return navigate("/home");
        case "go-inbox": return navigate("/inbox");
        case "go-visitors": return navigate("/visitors");
        case "go-dashboard": return navigate("/dashboard");
        case "go-settings": return navigate("/settings");
        case "next": return inbox?.move(1);
        case "previous": return inbox?.move(-1);
        case "open": return inbox?.openCursor();
        case "search": return inbox?.focusSearch();
        case "resolve": return inbox?.act("resolve");
        case "assign-me": return inbox?.act("assign-me");
        case "reply": return thread?.focusComposer("reply");
        case "note": return thread?.focusComposer("note");
        case "tag": return thread?.startTag();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented && !(e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) return;
      const otherDialog = Array.from(document.querySelectorAll("dialog[open]")).some((d) => !d.classList.contains("palette"));
      const { command, state } = dispatchShortcut(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing || e.key === "Process" || e.keyCode === 229,
          typing: isTypingTarget(e.target) && overlay !== "palette",
          onControl: isControlTarget(e.target),
        },
        shortcutState.current,
        { inbox: deskPathname().startsWith("/inbox"), modal: overlay === "palette" ? "palette" : otherDialog || overlay || settingsOpen ? "other" : "none" },
        Date.now(),
      );
      shortcutState.current = state;
      if (!command) return;
      e.preventDefault();
      run(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay, openOverlay, closeOverlay, settingsOpen]);

  const hub = useMemo<Hub>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );

  if (!workspace || !me.user) return <div className="center muted">You're not a member of any workspace.</div>;
  const section = sectionOf(pagePath);
  const ob = onboarding.state;
  const obDone = ob ? STEP_ORDER.filter((k) => ob.steps[k]).length : 0;
  const showGetStarted = Boolean(ob && !ob.dismissed && obDone < STEP_ORDER.length && workspace.role !== "agent");
  const canEdit = workspace.role !== "agent";
  const conversationId = pagePath.match(/^\/inbox\/([\w-]+)/)?.[1] ?? null;
  // D-91: until the widget is on a site, its sidebar entry carries a dot (it still opens the Playground;
  // D-121: opening straight on the Install sheet was confusing, the page's chip and button lead there).
  const install = ob ? { installed: ob.steps.install, host: ob.installedOn, widgetKey: ob.widgetKey } : null;
  const notInstalled = install !== null && !install.installed;
  const widgetTab: WidgetTab = pagePath.startsWith("/playground/behaviour") ? "behaviour" : pagePath.startsWith("/playground/install") ? "install" : "appearance";

  return (
    // Town's sidebar (D-36): shadcn's Sidebar, collapsing to a 56px icon rail (toggle, or Ctrl/Cmd+B).
    <SidebarProvider className="shell">
      <CloseSheetOnNavigate path={path} />
      <Sidebar collapsible="icon" className="desk-sidebar">
        <SidebarHeader className="desk-sidebar-head">
          <SidebarTrigger />
          <WorkspaceSwitcher current={workspace} all={me.memberships ?? [workspace]} />
        </SidebarHeader>
        <SidebarContent>
          {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label ?? "work"}>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu aria-label={group.label ?? "Main"}>
              {group.items.map((item) => {
                const { id, label, Icon } = item;
                const here = navOf(section) === id;
                const dot = id === "widget" && notInstalled;
                const href = "href" in item ? item.href : `/${id}`;
                return (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    isActive={here && !settingsOpen}
                    tooltip={dot ? `${label} (not installed yet)` : label}
                    render={<a href={deskHref(href)} aria-current={here && !settingsOpen ? "page" : undefined} onClick={(e) => { e.preventDefault(); navigate(href); }} />}
                  >
                    <Icon />
                    <span>{label}{dot && <span className="sr-only">, not installed yet</span>}</span>
                  </SidebarMenuButton>
                  {dot && <span className="nav-dot" aria-hidden="true" />}
                  {id === "visitors" && visitors && visitors.length > 0 && <SidebarMenuBadge className="nav-count">{visitors.length}</SidebarMenuBadge>}
                  {/* The channels open under it while you're there, like the Agent's parts. */}
                  {id === "channels" && here && !settingsOpen && (
                    <SidebarMenuSub aria-label="Channels">
                      {CHANNEL_SECTIONS.map((ch) => {
                        const active = channelSection(pagePath) === ch.id;
                        return (
                          <SidebarMenuSubItem key={ch.id}>
                            <SidebarMenuSubButton
                              isActive={active}
                              href={deskHref(ch.path)}
                              aria-current={active ? "page" : undefined}
                              onClick={(e) => { e.preventDefault(); navigate(ch.path); }}
                            >
                              <span>{ch.label}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  )}
                  {/* The Agent's parts open under it while you're there (Chatbase's "Build"); the icon rail shows only Agent. */}
                  {id === "agent" && here && !settingsOpen && (
                    <SidebarMenuSub aria-label="Agent">
                      {AGENT_SECTIONS.map((a) => {
                        const active = agentNavId(pagePath) === a.id;
                        return (
                          <SidebarMenuSubItem key={a.id}>
                            {a.group && <span className="agent-nav-group">{a.group}</span>}
                            <SidebarMenuSubButton
                              isActive={active}
                              href={deskHref(a.path)}
                              aria-current={active ? "page" : undefined}
                              onClick={(e) => { e.preventDefault(); navigate(a.path); }}
                            >
                              <span>{a.label}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          {ob && showGetStarted && section !== "welcome" && (
            <>
              <div className="desk-sidebar-expanded"><GetStartedCard onboarding={ob} onHide={() => { api(`/workspaces/${workspace.workspaceId}/onboarding/dismiss`, { body: {} }).then(reloadOnboarding).catch(() => {}); }} /></div>
              <SidebarMenu className="desk-sidebar-collapsed">
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip={`Get started (${obDone} of ${STEP_ORDER.length})`} render={<a href={deskHref("/welcome")} onClick={(e) => { e.preventDefault(); navigate("/welcome"); }} />}>
                    <FlashIcon />
                    <span>Get started</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </>
          )}
          <SidebarMenu>
            <UpdateItem update={update} />
            <SidebarMenuItem>
              <SidebarMenuButton type="button" onClick={() => openOverlay("palette")} aria-keyshortcuts="Control+K Meta+K" tooltip={`Search (${modKey()} K)`}>
                <SearchIcon />
                <span>Search</span>
                <kbd className="ml-auto">{modKey()} K</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <ThemeButton />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton type="button" onClick={openHelp} aria-keyshortcuts="Shift+?" tooltip="Keyboard shortcuts (?)">
                <HelpIcon />
                <span>Keyboard shortcuts</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger render={<SidebarMenuButton type="button" size="lg" className="desk-user" aria-label="Account" />}>
                  <span className="avatar me" aria-hidden="true">{me.user.name.slice(0, 1).toUpperCase()}</span>
                  <span className="desk-user-text">
                    <span className="desk-user-name">{me.user.name}</span>
                    <span className="desk-user-sub">{workspace.workspaceName} · {online.length} online</span>
                  </span>
                </DropdownMenuTrigger>
                <AccountMenuContent>
                  {/* Settings lives here, under your name (Town's profile menu), not in the main nav. */}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="desk-user-menu-head">
                      <span className="desk-user-name">{me.user.name}</span>
                      {me.user.email && <span className="desk-user-sub">{me.user.email}</span>}
                    </DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => navigate("/settings")}>
                      <SettingsIcon />
                      Settings
                      <DropdownMenuShortcut>G S</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    {/* D-97: yours on every workspace, and the desk's home with all of them. */}
                    <DropdownMenuItem onClick={() => navigate("/settings/account")}>
                      <KeyIcon />
                      Your account
                    </DropdownMenuItem>
                    {(me.memberships?.length ?? 0) > 1 && (
                      <DropdownMenuItem onClick={goHome}>
                        <ColumnsIcon />
                        All workspaces
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Online now</DropdownMenuLabel>
                    {online.map((o) => (
                      <DropdownMenuItem key={o.userId} disabled>
                        <span className="avatar" aria-hidden="true">{o.name.slice(0, 1).toUpperCase()}</span>
                        {o.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={async () => { await api("/auth/logout", { body: {} }); onSignOut(); }}>
                    <SignOutIcon />
                    Sign out
                  </DropdownMenuItem>
                </AccountMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="desk-inset">
      <header className="desk-mobile-bar">
        <SidebarTrigger />
        <div className="brand"><DeskIcon /><span>Jun</span></div>
      </header>
      <ScrollArea render={<main />} className="desk-main" contentClassName="desk-main-body">
      <PageErrorBoundary key={section}>
      {section === "home" ? (
        <HomePage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} me={me.user} role={workspace.role} hub={hub} />
      ) : section === "knowledge" ? (
        <KnowledgePage workspaceId={workspace.workspaceId} canEdit={canEdit} />
      ) : section === "welcome" ? (
        <WelcomePage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} onboarding={onboarding.state} reload={onboarding.reload} />
      ) : section === "visitors" ? (
        <VisitorsPage workspaceId={workspace.workspaceId} visitors={visitors} />
      ) : section === "contacts" ? (
        <ContactsPage workspaceId={workspace.workspaceId} path={pagePath} />
      ) : section === "dashboard" ? (
        <ReportsPage workspaceId={workspace.workspaceId} path={pagePath} canEdit={canEdit} />
      ) : section === "widget" ? (
        <WidgetPage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} canEdit={canEdit} tab={widgetTab} install={install} reloadInstall={reloadOnboarding} />
      ) : section === "channels" ? (
        channelSection(pagePath) === "email" ? (
          <EmailChannelPage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} canEdit={canEdit} />
        ) : (
          <ChannelsOverview workspaceId={workspace.workspaceId} />
        )
      ) : section === "connect" ? (
        <ConnectPage workspaceId={workspace.workspaceId} tab={pagePath.startsWith("/connect/tokens") ? "tokens" : "connect"} />
      ) : section === "agent" ? (
        <AgentPage workspaceId={workspace.workspaceId} canEdit={canEdit} path={pagePath} />
      ) : (
        <InboxPage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} me={me.user} hub={hub} conversationId={conversationId} />
      )}
      </PageErrorBoundary>
      </ScrollArea>
      {settingsOpen && <PageErrorBoundary><SettingsDialog me={me} workspace={workspace} path={path} onClose={closeSettings} /></PageErrorBoundary>}
      </SidebarInset>
      {overlay === "palette" && <CommandPalette workspaceId={workspace.workspaceId} meId={me.user.id} onClose={closeOverlay} onHelp={openHelp} onToast={showNotice} />}
      {overlay === "help" && <ShortcutsHelp onClose={closeOverlay} />}
      {notice && <div className="toast" role="status"><span>{notice}</span></div>}
    </SidebarProvider>
  );
}

/** The account menu opens beside the sidebar; on phones (the sidebar is a sheet) above the button, so it stays on screen. */
function AccountMenuContent({ children }: { children: ReactNode }) {
  const { isMobile } = useSidebar();
  return <DropdownMenuContent side={isMobile ? "top" : "right"} align={isMobile ? "start" : "end"} className="min-w-56">{children}</DropdownMenuContent>;
}

/** On phones the sidebar is a sheet: going to another page closes it. */
function CloseSheetOnNavigate({ path }: { path: string }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  return null;
}
