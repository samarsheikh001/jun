import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../api.ts";
import { DeskLink } from "./DeskLink.tsx";
import { AsteriskIcon, EditIcon, SettingsIcon, XIcon } from "../components/icons.tsx";
import { pageContext } from "../lib/ask-context.ts";
import type { MentionOption } from "../lib/ask-mentions.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { AskChat, AskThreads, newAskChat, useAskStarted } from "./AskChat.tsx";

// D-158: the Home assistant on every desk page, as a panel on the right (Ctrl/⌘ J or the sidebar's
// Assistant). One thread store with Home's, so a chat carries on from page to page. The page's
// subject (a chat, a person, an agent file) rides along as a reference the member can drop.

const KEY = "jun:ask-panel";
const listeners = new Set<() => void>();
let open = (() => {
  try {
    return localStorage.getItem(KEY) === "open";
  } catch {
    return false;
  }
})();

export function setAskPanel(next: boolean): void {
  if (open === next) return;
  open = next;
  try {
    if (next) localStorage.setItem(KEY, "open");
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: open for this tab only.
  }
  listeners.forEach((l) => l());
}

export const toggleAskPanel = (): void => setAskPanel(!open);

export const useAskPanelOpen = (): boolean => useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => open);

/** Focuses the open assistant's prompt bar (the panel's, or Home's). */
export function focusAsk(): void {
  // After the panel's first render (it may open in this same event).
  setTimeout(() => document.querySelector<HTMLTextAreaElement>(".ask-panel .ask-bar textarea, .home-ask .ask-bar textarea")?.focus(), 30);
}

export interface AssistantAi {
  available: boolean;
  reason?: string;
  message?: string;
}

/** Why the assistant can't answer (shown instead of its starters), or null when it can. */
export function assistantOff(ai: AssistantAi | null | undefined, role: "owner" | "admin" | "agent"): ReactNode | null {
  if (!ai || ai.available) return null;
  const settings = <DeskLink href="/settings/ai">Settings → AI</DeskLink>;
  if (ai.reason === "ai_off") return <>The assistant needs the AI, which is off for this workspace: {role === "agent" ? "an admin can turn it on in Settings → AI" : <>turn it on in {settings}</>}.</>;
  return <>{ai.message} {role === "agent" ? null : settings}</>;
}

/** Asked when the panel opens (the AI may have been turned on or off meanwhile). */
function useAssistantAi(workspaceId: string): AssistantAi | null {
  const [ai, setAi] = useState<AssistantAi | null>(null);
  useEffect(() => {
    let live = true;
    api<{ ai: AssistantAi }>(`/workspaces/${workspaceId}/home/ai`).then((r) => live && setAi(r.ai), () => {});
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return ai;
}

/** The page's subject with its name once loaded (people only: a chat's GET would mark its mentions read). */
function usePageContext(workspaceId: string, path: string): MentionOption | null {
  const base = pageContext(path);
  const key = base ? `${base.kind}:${base.id}` : "";
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!base || base.kind !== "contact" || names[key] !== undefined) return;
    let live = true;
    api<{ contact: { name: string | null; email: string | null } }>(`/workspaces/${workspaceId}/contacts/${encodeURIComponent(base.id)}`).then(
      (r) => live && setNames((n) => ({ ...n, [key]: r.contact.name || r.contact.email || "" })),
      () => live && setNames((n) => ({ ...n, [key]: "" })),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return base ? { ...base, label: names[key] || base.label } : null;
}

export function AskPanel({ workspaceId, userId, role, path, overlay }: { workspaceId: string; userId: string; role: "owner" | "admin" | "agent"; path: string; overlay: boolean }) {
  const started = useAskStarted(workspaceId);
  const context = usePageContext(workspaceId, path);
  const ai = useAssistantAi(workspaceId);
  // Dropped for this page only: the next page brings its own.
  const [dropped, setDropped] = useState<string | null>(null);
  const shown = context && dropped !== `${context.kind}:${context.id}` ? context : null;

  // On a phone the panel is the whole screen, so a new page came from one of its links: show it.
  const [firstPath] = useState(path);
  useEffect(() => {
    if (path !== firstPath && matchMedia("(max-width: 640px)").matches) setAskPanel(false);
  }, [path, firstPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("dialog[open], [role=menu], [role=listbox]")) return;
      const panel = document.querySelector(".ask-panel");
      if (panel?.contains(document.activeElement)) setAskPanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="ask-panel" data-overlay={overlay ? "" : undefined} aria-labelledby="ask-panel-title">
      <div className="home-ask-head">
        <h2 id="ask-panel-title" title="Chats, customers, errors, Analytics, knowledge and the agent. Changes wait for your Confirm."><AsteriskIcon aria-hidden="true" />Assistant</h2>
        <div className="home-ask-tools">
          <AskThreads ws={workspaceId} />
          <button type="button" className="home-ask-tool" aria-label="New chat" title="New chat" disabled={!started} onClick={() => { newAskChat(workspaceId); focusAsk(); }}><EditIcon /></button>
          {role !== "agent" && <a className="home-ask-tool" href={deskHref("/settings/ai")} aria-label="AI settings" title="AI settings" onClick={(e) => { e.preventDefault(); navigate("/settings/ai"); }}><SettingsIcon /></a>}
          <button type="button" className="home-ask-tool" aria-label="Close the assistant" title="Close (Esc)" onClick={() => setAskPanel(false)}><XIcon /></button>
        </div>
      </div>
      <AskChat
        workspaceId={workspaceId}
        userId={userId}
        disabled={assistantOff(ai, role)}
        context={shown}
        onDropContext={shown ? () => setDropped(`${shown.kind}:${shown.id}`) : undefined}
      />
    </aside>
  );
}
