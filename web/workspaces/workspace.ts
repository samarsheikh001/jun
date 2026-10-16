import type { Me } from "../api.ts";

// D-95: one desk, several workspaces (one per website or product). The desk shows one at a time:
// the one a link names (`?ws=`, as notifications do), else the one picked last on this browser,
// else your first. Switching reloads the page, so nothing from the last workspace stays in memory.

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
    // Storage blocked: the switch still works for this page load (it's in the URL).
  }
}

/** The workspace this page load shows. A `?ws=` it honours is remembered and taken off the URL. */
export function currentWorkspace(me: Me): Membership | undefined {
  const all = me.memberships ?? [];
  // Decided once per page load (the URL's ws is gone after the first call).
  const kept = all.find((m) => m.workspaceId === shown);
  if (kept) return kept;
  const params = new URLSearchParams(window.location.search);
  const asked = params.get("ws");
  const chosen = all.find((m) => m.workspaceId === asked) ?? all.find((m) => m.workspaceId === picked()) ?? all[0];
  shown = chosen?.workspaceId;
  if (asked !== null) {
    if (chosen && chosen.workspaceId === asked) remember(asked);
    params.delete("ws");
    const rest = params.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
  }
  return chosen;
}

/** Open another workspace (a fresh page load), on `path`. */
export function switchWorkspace(workspaceId: string, path = "/inbox") {
  remember(workspaceId);
  window.location.assign(`${path}?ws=${encodeURIComponent(workspaceId)}`);
}
