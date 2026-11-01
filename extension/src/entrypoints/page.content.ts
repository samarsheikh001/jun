// The part of Jun for Chrome that runs in the page (E-01): injected by the side panel with
// chrome.scripting only when the person asks for help on this site (never declared on every page),
// in the isolated world, so the page's own scripts and CSP don't reach it. It runs the shared page
// tools (web/page-control/tools.ts: the widget's page control plus point_at) and answers the panel's
// requests (src/lib/protocol.ts). It never reads storage or holds the API key.
import { createPageTools } from "../../../web/page-control/tools.ts";
import { readRequest, type PageResponse, type ToolInfo } from "../lib/protocol.ts";

declare global {
  interface Window {
    __junExtension?: true;
  }
}

export default defineContentScript({
  registration: "runtime",
  main() {
    // Injected again before each request (a new page needs it); only the first copy listens.
    if (window.__junExtension) return;
    window.__junExtension = true;

    let mask = true;
    const tools = createPageTools({ mask: () => mask, guide: true });

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return;
      const request = readRequest(message);
      if (!request) return;
      const reply = (r: PageResponse) => sendResponse(r);
      if (request.type === "jun:tools") {
        const list: ToolInfo[] = tools.actions.map((a) => ({ name: a.name, description: a.description, inputSchema: a.inputSchema, risk: a.risk === "auto" ? "auto" : "confirm", status: a.status ?? a.name }));
        reply({ ok: true, result: list });
        return;
      }
      if (request.type === "jun:point") {
        tools.point(request.point);
        reply({ ok: true, result: null });
        return;
      }
      const action = tools.actions.find((a) => a.name === request.name);
      if (!action) {
        reply({ ok: false, error: `No action ${request.name}.` });
        return;
      }
      mask = request.mask;
      action.execute(request.input).then(
        (result) => reply({ ok: true, result }),
        (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true; // answers later
    });
  },
});
