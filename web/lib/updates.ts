import { useEffect, useState } from "react";
import { compareVersions, JUN_UPSTREAM, JUN_VERSION } from "../../shared/version.ts";

// T-17: is a newer Jun out? The admin's browser asks GitHub for the latest release (at most twice
// a day, the answer kept in localStorage), so the desk itself never calls out and the notice is
// there from the first frame (no pop-in) once it's known. Updating happens in GitHub: the copy's
// Update Jun workflow opens a pull request; merging it deploys.

export interface LatestRelease {
  version: string;
  url: string;
}

const KEY = "jun:latest-release";
const MAX_AGE = 12 * 60 * 60 * 1000;

interface Stored extends LatestRelease {
  checkedAt: number;
}

function stored(): Stored | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Stored> | null;
    return v && typeof v.version === "string" && typeof v.url === "string" && typeof v.checkedAt === "number" ? (v as Stored) : null;
  } catch {
    return null;
  }
}

/** The newer release, if the last check found one (no network: for the first frame). */
export function knownUpdate(): LatestRelease | null {
  const s = stored();
  return s && compareVersions(s.version, JUN_VERSION) > 0 ? { version: s.version, url: s.url } : null;
}

let checking: Promise<void> | null = null;
async function check(): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${JUN_UPSTREAM}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  // 404: no release published yet; remembered like an answer, so it isn't asked on every page load.
  if (!res.ok && res.status !== 404) return; // rate-limited or down: try again next time
  const release = res.ok ? ((await res.json()) as { tag_name?: string; html_url?: string }) : {};
  const found = release.tag_name && release.html_url ? { version: release.tag_name.replace(/^v/, ""), url: release.html_url } : { version: "0.0.0", url: "" };
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...found, checkedAt: Date.now() } satisfies Stored));
  } catch {
    // Storage blocked: the notice still shows for this page view.
  }
}

/** The newer release (or null), refreshed in the background when the last check is old. Admins only. */
export function useUpdate(enabled: boolean): LatestRelease | null {
  const [update, setUpdate] = useState(() => (enabled ? knownUpdate() : null));
  useEffect(() => {
    if (!enabled) return;
    const s = stored();
    if (s && Date.now() - s.checkedAt < MAX_AGE) return;
    let live = true;
    checking ??= check().catch(() => {}).finally(() => (checking = null));
    void checking.then(() => live && setUpdate(knownUpdate()));
    return () => {
      live = false;
    };
  }, [enabled]);
  return update;
}

/** Where owners read how to update (the docs' Upgrade page). */
export const UPDATE_HELP = "https://jun-6ced7499.mintlify.app/deploy/upgrade";
