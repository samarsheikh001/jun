import { useSyncExternalStore } from "react";
import { api } from "../api.ts";
import { currentSubscription, endpointHash } from "../lib/notifications.ts";

// Settings' data, fetched all at once when the dialog opens (`prefetchSettings`) and kept for the
// session, so a section opens with its numbers already there instead of filling in card by card.
// Panels start from `cachedGet` and refresh through `fetchSetting`, which updates the store. A
// section shows its skeleton until every one of its requests has answered (`useSectionReady`), then
// appears whole.

const cache = new Map<string, unknown>();
/** Requests that answered (or failed): a failed one doesn't hold its section back. */
const settled = new Set<string>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  for (const listener of listeners) listener();
};

/** The last answer for a GET, if there is one. */
export function cachedGet<T>(url: string): T | undefined {
  return cache.get(url) as T | undefined;
}

/** A GET whose answer is kept for the next time the panel opens. Always a fresh request. */
export function fetchSetting<T>(url: string): Promise<T> {
  const request = api<T>(url).then(
    (value) => {
      cache.set(url, value);
      return value;
    },
  ).finally(() => {
    settled.add(url);
    if (inflight.get(url) === request) inflight.delete(url);
    notify();
  });
  inflight.set(url, request);
  return request;
}

/** Which of this browser's push subscriptions is this device (a hash of its endpoint), or null. */
export const THIS_DEVICE = "push:this-device";
function loadThisDevice(): Promise<string | null> {
  const request = currentSubscription()
    .catch(() => null)
    .then((s) => (s ? endpointHash(s.endpoint) : null))
    .then((hash) => {
      cache.set(THIS_DEVICE, hash);
      return hash;
    })
    .finally(() => {
      settled.add(THIS_DEVICE);
      notify();
    });
  return request;
}

type SectionId = "general" | "ai" | "inbox" | "team" | "notifications" | "integrations" | "account" | "desk";

/** Every GET a section's panels make on opening. `deskOwner`: an owner somewhere on the desk. */
export function sectionRequests(id: SectionId, workspaceId: string, canInvite: boolean, deskOwner = false): string[] {
  const ws = `/workspaces/${workspaceId}`;
  switch (id) {
    case "general": return [];
    case "ai": return [`${ws}/ai`];
    case "inbox": return [`${ws}/inbox`, `${ws}/saved-replies`, `${ws}/tags`];
    case "team": return [`${ws}/members`, ...(canInvite ? [`${ws}/invites`] : [])];
    case "notifications": return [`${ws}/notifications`, `${ws}/push/subscriptions`, THIS_DEVICE];
    case "integrations": return [`${ws}/trackers`];
    case "account": return ["/passkeys"];
    case "desk": return deskOwner ? ["/desk/telemetry"] : [];
  }
}

const WORKSPACE_SECTIONS: SectionId[] = ["general", "ai", "inbox", "team", "notifications", "integrations"];

/**
 * On opening the dialog: every section's data in parallel (each URL once if it's already on its way).
 * No workspace (the desk's home, D-97): only your account's and the desk's.
 */
export function prefetchSettings(workspaceId: string | null, canInvite: boolean, deskOwner = false) {
  const ids: SectionId[] = [...(workspaceId ? WORKSPACE_SECTIONS : []), "account", "desk"];
  for (const id of ids) {
    for (const url of sectionRequests(id, workspaceId ?? "", canInvite, deskOwner)) {
      if (inflight.has(url)) continue;
      if (url === THIS_DEVICE) void loadThisDevice();
      else void fetchSetting(url).catch(() => {});
    }
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** True once every request the section needs has answered at least once. */
export function useSectionReady(urls: string[]): boolean {
  useSyncExternalStore(subscribe, () => version);
  return urls.every((url) => settled.has(url));
}
