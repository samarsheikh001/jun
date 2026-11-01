// The toolbar button opens the side panel. Opening it ourselves (not openPanelOnActionClick) keeps the
// click an action invocation, so Chrome grants activeTab on that tab; open() must run inside the
// click, before any await. The panel is told, so it looks at the tab again.
export default defineBackground(() => {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  browser.action.onClicked.addListener((tab) => {
    if (tab.windowId !== undefined) void browser.sidePanel.open({ windowId: tab.windowId });
    // No panel open yet: nobody listens, which is fine (it looks when it loads).
    browser.runtime.sendMessage({ type: "jun:clicked" }).catch(() => undefined);
  });
});
