/** Jun page control (MIT License).
 * AI-32 (D-93): the lazy chunk widget-page-control.js. widget.js loads it while the desk's switch is on
 * (Chat widget → Behaviour; /config `pageControl`), unless the snippet has data-page-control="off" (and,
 * in consent mode, after consent). It registers the five page actions from tools.ts as ordinary page
 * actions (JunDesk.registerAction, public/widget-actions.js) so the desk's AI can read the visitor's
 * page and click, type, choose and scroll on it, with the usual risk gate, Confirm card and audit.
 * Always masked here; privacy and the DOM engine are described in tools.ts.
 */
import type { PointMessage } from "../../shared/page-control.ts";
import { createPageTools, type PageTool } from "./tools.ts";

interface Jun {
  registerAction?: (action: PageTool) => () => void;
  _pc?: 1;
}

(function () {
  const J = (window as unknown as { JunDesk?: Jun }).JunDesk;
  if (!J || !J.registerAction || J._pc) return;
  J._pc = 1;

  const tools = createPageTools();
  // The chat frame says which step waits for the visitor's Confirm (jun:point): ring that element.
  const desk = (() => {
    try {
      return new URL((document.currentScript as HTMLScriptElement | null)?.src ?? "").origin;
    } catch {
      return "";
    }
  })();
  const chatFrame = () => document.querySelector("[data-jun-desk]")?.shadowRoot?.querySelector("iframe")?.contentWindow ?? null;
  window.addEventListener("message", (e) => {
    const m = e.data as PointMessage | null;
    if (!m || m.type !== "jun:point" || e.origin !== desk || e.source !== chatFrame()) return;
    tools.point(m.point);
  });
  for (const action of tools.actions) J.registerAction(action);
})();
