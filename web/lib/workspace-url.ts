// D-96: every desk page lives under its workspace, /w/<slug>/…, so each tab and each copied link
// keeps its own workspace. Pages keep using their own paths (/inbox, /agent/tasks…): the router
// takes the prefix off for them and puts it back on links. Pure, so it's tested on Node.
// D-97: `/` is the desk's home (your workspaces) once you have two or more; its settings dialog
// (your account, the desk) is /settings/account and /settings/desk, also without a prefix.

const PREFIX = /^\/w\/([^/?#]+)(?=[/?#]|$)/;
/** Paths that aren't desk pages: the API, the MCP server, the widget, sign-in pages, static files. */
const OUTSIDE = /^\/(?:api|mcp|widget|invite|recover|auth|demo\.html|sw\.js|widget\.js|fonts|geo|onboarding|assets)(?=[/?#.]|$)/;

/** The workspace slug a path names, or null. */
export function slugOf(path: string): string | null {
  const m = path.match(PREFIX);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/** The page's own path: "/w/acme/inbox/cv_1" → "/inbox/cv_1", "/w/acme" → "/". */
export function withoutWorkspace(path: string): string {
  const rest = path.replace(PREFIX, "");
  if (rest === path) return path;
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** A desk path (query and hash allowed) inside a workspace. Leaves full URLs, other workspaces and non-desk paths alone. */
export function withWorkspace(path: string, slug: string | null): string {
  if (!slug || !path.startsWith("/") || path.startsWith("//") || PREFIX.test(path) || OUTSIDE.test(path)) return path;
  const base = `/w/${encodeURIComponent(slug)}`;
  return path === "/" ? base : /^\/[?#]/.test(path) ? base + path.slice(1) : base + path;
}

export interface WorkspaceRef {
  workspaceId: string;
  workspaceSlug: string;
}

/** The desk-level pages (D-97): the home and its settings sections. */
export const HOME_PATHS = ["/", "/settings/account", "/settings/desk"];

/**
 * Which workspace a page load shows, and the address it should have (null: already right).
 * The URL's slug; an old link without one (bookmarks, `?ws=<id>` from older notifications)
 * goes to `?ws=`'s workspace, else `picked` (the last one used on this browser), else the first;
 * an unknown slug goes to the first workspace's inbox. D-97: with two or more workspaces, `/`
 * (and its settings) is the desk's home (`home`, no workspace); with one, `/` is its inbox.
 */
export function deskLocation<M extends WorkspaceRef>(
  all: M[],
  location: { pathname: string; search: string; hash: string },
  picked: string | null,
): { workspace: M | undefined; url: string | null; home?: true } {
  const first = all[0];
  if (!first) return { workspace: undefined, url: null };
  const params = new URLSearchParams(location.search);
  const asked = params.get("ws");
  if (all.length > 1 && asked === null && HOME_PATHS.includes(location.pathname.replace(/(.)\/$/, "$1"))) return { workspace: undefined, url: null, home: true };
  params.delete("ws");
  const rest = params.toString();
  const search = rest ? `?${rest}` : "";
  const slug = slugOf(location.pathname);
  const named = slug === null ? undefined : all.find((m) => m.workspaceSlug === slug);
  if (slug !== null && !named) return { workspace: first, url: withWorkspace("/inbox", first.workspaceSlug) };
  const byId = all.find((m) => m.workspaceId === asked);
  const workspace = byId ?? named ?? all.find((m) => m.workspaceId === picked) ?? first;
  const page = withoutWorkspace(location.pathname);
  const url = withWorkspace((page === "/" ? "/inbox" : page) + search, workspace.workspaceSlug) + location.hash;
  return { workspace, url: url === location.pathname + location.search + location.hash ? null : url };
}
