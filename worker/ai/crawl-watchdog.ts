// D-88: when a website sync counts as stuck, and what the finished source then says. Pure; used by
// finishStuckSyncs in knowledge.ts (the 15-minute cron and the Knowledge list).
//
// A sync finishes when its last page job brings pending_jobs to 0. A Worker killed mid-job (limits,
// eviction, a deploy) never runs that job's `finally`, and dropped queue messages never run at all, so
// the count can stay above 0 (or the claimed pages were never queued) and the source "syncs" forever.

/** No sign of life for this long and a syncing source is finished with what it has. */
export const STUCK_AFTER_MS = 20 * 60 * 1000;

/**
 * Stuck when the newest activity signal (the sync's start, its pages' updated_at, and for syncs from
 * before startedAt existed the source's last sync / creation) is older than STUCK_AFTER_MS.
 */
export function syncIsStuck(now: number, signals: (number | null | undefined)[]): boolean {
  const last = Math.max(0, ...signals.filter((n): n is number => typeof n === "number" && Number.isFinite(n)));
  return now - last > STUCK_AFTER_MS;
}

/** The note a finished, interrupted sync keeps in `error`: null when every claimed page was read. */
export function interruptedNote(indexed: number, unread: number): string | null {
  if (indexed === 0) return "The crawl was interrupted before any page was read. Sync again to retry.";
  if (unread === 0) return null;
  return `Finished with ${unread} ${unread === 1 ? "page" : "pages"} not read (the crawl was interrupted). Sync again to retry ${unread === 1 ? "it" : "them"}.`;
}
