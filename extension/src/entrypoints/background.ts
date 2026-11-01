// Jun for Chrome's service worker (E-01). The toolbar button summons the island on the page (a click
// grants activeTab, so the content script can go in); the island frame asks which tab it's in (only a
// tab the person summoned Jun on); on sites the person allowed for good, the island comes back after
// each page load of a tab it was on, with the chat (kept per tab in storage.session).
import { PAGE_SCRIPT } from "../lib/protocol.ts";
import { siteOf } from "../lib/settings.ts";

const SUMMONED = "jun.tabs";

async function summoned(): Promise<number[]> {
  const s = await browser.storage.session.get(SUMMONED);
  return Array.isArray(s[SUMMONED]) ? (s[SUMMONED] as number[]) : [];
}
async function setSummoned(tabId: number, on: boolean): Promise<void> {
  const ids = (await summoned()).filter((id) => id !== tabId);
  await browser.storage.session.set({ [SUMMONED]: on ? [...ids, tabId] : ids });
}

/** Puts the content script and the island on the tab; `open` opens it for a question. */
async function summon(tabId: number, open: boolean): Promise<boolean> {
  try {
    await setSummoned(tabId, true);
    await browser.scripting.executeScript({ target: { tabId }, files: [PAGE_SCRIPT] });
    await browser.tabs.sendMessage(tabId, { type: "jun:summon", open });
    return true;
  } catch {
    return false; // the browser's own pages, the Web Store, or no access
  }
}

/** The visible part of the tab as a JPEG data URL, the island hidden while it's taken. */
async function shot(tabId: number, windowId: number | undefined): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (!(await summoned()).includes(tabId)) return { ok: false, error: "Click the Jun button on this page first." };
  try {
    await browser.tabs.sendMessage(tabId, { type: "jun:island-hidden", hidden: true });
    const dataUrl = await browser.tabs.captureVisibleTab(windowId ?? browser.windows.WINDOW_ID_CURRENT, { format: "jpeg", quality: 85 });
    return { ok: true, dataUrl };
  } catch {
    return { ok: false, error: "Chrome didn't allow a screenshot here. Click the Jun button on this page, then try again." };
  } finally {
    await browser.tabs.sendMessage(tabId, { type: "jun:island-hidden", hidden: false }).catch(() => undefined);
  }
}

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) void summon(tab.id, true);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = (message as { type?: string } | null)?.type;
    if (sender.id !== browser.runtime.id) return;
    if (type === "jun:tab") {
      // Only our island frame, in a tab the person summoned Jun on.
      const tabId = sender.tab?.id;
      const fromIsland = sender.url?.startsWith(browser.runtime.getURL("/island.html"));
      void summoned().then((ids) => sendResponse(fromIsland && tabId !== undefined && ids.includes(tabId) ? tabId : null));
      return true;
    }
    if (type === "jun:shot") {
      // "Take a screenshot" in the island: the visible tab without the island (it hides for the shot).
      // Needs activeTab (from the toolbar click; it ends when the tab leaves the page).
      const tab = sender.tab;
      const fromIsland = sender.url?.startsWith(browser.runtime.getURL("/island.html"));
      if (!fromIsland || tab?.id === undefined) return;
      void shot(tab.id, tab.windowId).then(sendResponse);
      return true;
    }
    if (type === "jun:dismiss" && sender.tab?.id !== undefined) void setSummoned(sender.tab.id, false);
  });

  // A new page in a tab Jun was on: back on sites the person allowed for good (activeTab ends with the page).
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status !== "complete") return;
    void summoned().then(async (ids) => {
      if (!ids.includes(tabId)) return;
      const site = siteOf(tab.url);
      if ("problem" in site) return;
      if (await browser.permissions.contains({ origins: [site.pattern] })) await summon(tabId, false);
    });
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void setSummoned(tabId, false);
    void browser.storage.session.remove(`jun.chat.${tabId}`);
  });
});
