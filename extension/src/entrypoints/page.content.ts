// The part of Jun for Chrome that runs in the page (E-01): injected with chrome.scripting only when the
// person summons Jun (never declared on every page), in the isolated world, so the page's own scripts
// and CSP don't reach it. Two jobs:
//   - the island's host, as the widget's loader is: a transparent extension frame at the bottom of
//     the page (island.html), sized and clipped from what the island reports (`jun:css`), "/" opens it;
//   - the page tools (web/page-control/tools.ts: the widget's page control plus point_at), answering
//     the island's requests (src/lib/protocol.ts). It never reads storage or holds a key or token.
import { createPageTools } from "../../../web/page-control/tools.ts";
import { readRequest, type PageResponse, type ToolInfo } from "../lib/protocol.ts";

declare global {
  interface Window {
    __junExtension?: true;
  }
}

const HOST = "data-jun-desk"; // PRIVATE_SELECTOR skips it: a read never sees the island; pointer.ts starts its glide from it
const Z = 2147483000; // over the page and the pointer layer (pointer.ts, just under it)
const HIDDEN = "display:block;position:fixed;bottom:0;left:0;width:100%;height:120px;border:0;background:none;clip-path:inset(100%)";

export default defineContentScript({
  registration: "runtime",
  main() {
    // Injected again before each request (a new page needs it); only the first copy listens.
    if (window.__junExtension) return;
    window.__junExtension = true;

    let mask = true;
    const tools = createPageTools({ mask: () => mask, guide: true });

    // ---------- the island's frame ----------
    let frame: HTMLIFrameElement | null = null;
    let ready = false;
    let openWhenReady = false;
    const post = (message: object) => frame?.contentWindow?.postMessage(message, "*");

    function mount(open: boolean): void {
      if (frame?.isConnected) {
        if (open) post({ type: "jun:open" });
        return;
      }
      const host = document.createElement("div");
      host.setAttribute(HOST, "extension");
      const root = host.attachShadow({ mode: "open" });
      frame = document.createElement("iframe");
      frame.title = "Jun";
      frame.setAttribute("allow", "clipboard-write");
      frame.style.cssText = `${HIDDEN};z-index:${Z}`;
      frame.src = browser.runtime.getURL("/island.html");
      ready = false;
      openWhenReady = open;
      root.appendChild(frame);
      document.documentElement.appendChild(host);
    }

    function unmount(): void {
      frame?.closest(`[${HOST}]`)?.remove();
      (document.querySelector(`[${HOST}="extension"]`) as HTMLElement | null)?.remove();
      frame = null;
      tools.point(null);
      void browser.runtime.sendMessage({ type: "jun:dismiss" }).catch(() => undefined);
    }

    window.addEventListener("message", (e) => {
      if (!frame || e.source !== frame.contentWindow) return;
      const data = e.data as { type?: string; css?: string } | null;
      if (data?.type === "jun:css" && typeof data.css === "string") frame.style.cssText = `position:fixed;z-index:${Z};${data.css}`;
      else if (data?.type === "jun:ready") {
        ready = true;
        if (openWhenReady) post({ type: "jun:open" });
        openWhenReady = false;
      } else if (data?.type === "jun:close") unmount();
    });

    // "/" opens the island from the page, like the widget's (not while typing in a field).
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || !frame || !ready) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      e.preventDefault();
      post({ type: "jun:open" });
    });

    // ---------- requests ----------
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return;
      const type = (message as { type?: string } | null)?.type;
      if (type === "jun:summon") {
        mount((message as { open?: boolean }).open === true);
        sendResponse({ ok: true, result: null });
        return;
      }
      if (type === "jun:island-hidden") {
        // A screenshot is being taken: out of the picture (and the pointer's ring too), answered once painted.
        const hidden = (message as { hidden?: boolean }).hidden === true;
        if (frame) frame.style.visibility = hidden ? "hidden" : "";
        if (hidden) tools.point(null);
        requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ ok: true, result: null })));
        return true;
      }
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
