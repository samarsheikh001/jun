import { useEffect, useState } from "react";
import { slugOf, withoutWorkspace, withWorkspace } from "./workspace-url.ts";

const listeners = new Set<() => void>();

/**
 * D-96: a desk path as a link in this tab's workspace ("/agent" → "/w/acme/agent"). Use it for
 * every `href` of a desk page, so opening a link in a new tab stays in this workspace.
 */
export function deskHref(path: string): string {
  return withWorkspace(path, slugOf(window.location.pathname));
}

/** The current page's own path, without the workspace prefix. */
export function deskPathname(): string {
  return withoutWorkspace(window.location.pathname);
}

/** Goes to a desk path (in this workspace unless it names another; that's a fresh page load). */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = deskHref(path);
  if (target === window.location.pathname + window.location.search) return;
  const here = slugOf(window.location.pathname);
  const there = slugOf(target);
  if (here && there && here !== there) {
    // Another workspace: nothing from this one stays in memory.
    window.location[options.replace ? "replace" : "assign"](target);
    return;
  }
  window.history[options.replace ? "replaceState" : "pushState"](null, "", target);
  for (const listener of listeners) listener();
}

/** Current page path (without the workspace prefix); re-renders on navigate() and back/forward. */
export function usePath(): string {
  const [path, setPath] = useState(deskPathname);
  useEffect(() => {
    const update = () => setPath(deskPathname());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}
