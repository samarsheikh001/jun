// The side panel's way into the tab (E-01): which site it shows, the person's per-site permission,
// injecting the content script on demand and asking it to run a tool.
import { PAGE_SCRIPT, type PageRequest, type PageResponse } from "./protocol.ts";
import { siteOf, type Site } from "./settings.ts";

export type Target = { tabId: number; title: string; site: Site };
export type NoTarget = { problem: "no-tab" | "no-access" | "restricted"; host?: string; pattern?: string };

/** The active tab of the panel's window and its site. Without access Chrome hides the URL. */
export async function currentTarget(): Promise<Target | NoTarget> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { problem: "no-tab" };
  const site = siteOf(tab.url);
  if ("problem" in site) return { problem: site.problem };
  return { tabId: tab.id, title: tab.title ?? "", site };
}

/** Whether Jun keeps access to this site (an "Allow on this site" given before). activeTab alone lasts until the tab navigates away. */
export async function hasSiteAccess(pattern: string): Promise<boolean> {
  return browser.permissions.contains({ origins: [pattern] });
}

/** Asks Chrome for lasting access to one site. Must run inside the person's click. */
export async function requestSiteAccess(pattern: string): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** Injects the content script (a no-op when it's there). False: no access to this page. */
export async function inject(tabId: number): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [PAGE_SCRIPT] });
    return true;
  } catch {
    return false;
  }
}

/** One request to the page. A page that navigated away mid-request answers `{ ok: false, error: "navigated" }`. */
export async function callPage(tabId: number, request: PageRequest): Promise<PageResponse> {
  if (!(await inject(tabId))) return { ok: false, error: "no-access" };
  try {
    const response = (await browser.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
    return response ?? { ok: false, error: "navigated" };
  } catch {
    // The page unloaded (a click opened a new page) before it answered.
    return { ok: false, error: "navigated" };
  }
}
