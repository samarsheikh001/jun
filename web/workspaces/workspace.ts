import type { Me } from "../api.ts";
import { deskLocation, withWorkspace } from "../lib/workspace-url.ts";

// D-95: one desk, several workspaces (one per website or product). The desk shows one at a time.
// D-96: the URL names it (/w/<slug>/…), so each tab and each link keeps its own. An old link
// without one goes to `?ws=`'s, else the one used last on this browser, else your first.
// Switching is a fresh page load, so nothing from the last workspace stays in memory.

export type Membership = NonNullable<Me["memberships"]>[number];

const PICKED = "jun:workspace";
let shown: string | undefined;

function picked(): string | null {
  try {
    return localStorage.getItem(PICKED);
  } catch {
    return null;
  }
}

function remember(workspaceId: string) {
  try {
    localStorage.setItem(PICKED, workspaceId);
  } catch {
    // Storage blocked: only old links without a workspace lose the fallback.
  }
}

/** The workspace this page load shows. The first call puts the address under it (/w/<slug>/…). */
export function currentWorkspace(me: Me): Membership | undefined {
  const all = me.memberships ?? [];
  // Decided once per page load.
  const kept = all.find((m) => m.workspaceId === shown);
  if (kept) return kept;
  const { workspace, url } = deskLocation(all, window.location, picked());
  shown = workspace?.workspaceId;
  if (workspace) remember(workspace.workspaceId);
  if (url) window.history.replaceState(window.history.state, "", url);
  return workspace;
}

/** Open another workspace (a fresh page load), on `path`. */
export function switchWorkspace(target: { workspaceId: string; workspaceSlug?: string | null }, path = "/inbox") {
  remember(target.workspaceId);
  window.location.assign(target.workspaceSlug ? withWorkspace(path, target.workspaceSlug) : `${path}?ws=${encodeURIComponent(target.workspaceId)}`);
}
