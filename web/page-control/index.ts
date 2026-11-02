/** Jun page control (MIT License).
 * AI-32 (D-93): the lazy chunk widget-page-control.js. widget.js loads it while the desk's switch is on
 * (Chat widget → Behaviour; /config `pageControl`), unless the snippet has data-page-control="off" (and,
 * in consent mode, after consent). It registers five ordinary page
 * actions (JunDesk.registerAction, public/widget-actions.js) so the desk's AI can read the visitor's
 * page and click, type, choose and scroll on it, with the usual risk gate, Confirm card and audit.
 *
 * The DOM work is alibaba/page-agent's PageController (@page-agent/page-controller, MIT, Copyright
 * (c) 2026 SimonLuvRamen and Alibaba Group Holding Limited, https://github.com/alibaba/page-agent):
 * only its DOM engine; page-agent's own in-browser LLM isn't used. Never exposed: executeJavascript
 * (its eval is stripped at build time, vite.config.ts), the mask overlay.
 *
 * Privacy (the P1 rule "never capture page text" is relaxed for opted-in sites only):
 *   - never read or touched: the widget, [data-jun-private] and everything in it, password, hidden,
 *     card (autocomplete cc-*) and one-time-code fields (PRIVATE_SELECTOR in shared/page-control.ts);
 *   - every string the AI gets is masked like the debug context (redact: emails, card-like numbers,
 *     tokens, keys) and the URL loses its query values (cleanUrl);
 *   - nothing is read until the AI calls read_page, and no index badges stay on the page.
 */
import { PageController } from "@page-agent/page-controller";
import { controlMessage, MAX_PAGE_READ_RESULT, pageRead, pointChip, PRIVATE_SELECTOR, type PointMessage } from "../../shared/page-control.ts";
import { createPointer } from "./pointer.ts";

interface Action {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk?: "auto" | "confirm" | "human";
  status?: string;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}
interface Jun {
  registerAction?: (action: Action) => () => void;
  _pc?: 1;
}
/** PageController keeps the elements a read numbered in a private map; we check them before acting. */
interface Indexed {
  selectorMap: Map<number, { ref?: Element }>;
}

const IGNORE = "data-page-agent-ignore"; // PageController skips such an element and everything in it

(function () {
  const J = (window as unknown as { JunDesk?: Jun }).JunDesk;
  if (!J || !J.registerAction || J._pc) return;
  J._pc = 1;

  let pc: PageController | null = null;
  let read = false;
  // What's about to happen, shown on the page (pointer.ts): the chat frame says which step waits for
  // the visitor's Confirm (jun:point); a step that runs gets the pointer's glide and click.
  const pointer = createPointer();
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
    const at = m.point && read ? (controller() as unknown as Indexed).selectorMap.get(Number(m.point.index))?.ref : undefined;
    pointer.show(at && at.isConnected && !at.closest(PRIVATE_SELECTOR) ? at : null, m.point ? pointChip(m.point, true) : "");
  });
  // Made on first use, so nothing happens on the page until the AI reads it. (Its constructor marks
  // React roots data-page-agent-not-interactive: they carry every listener, so aren't buttons.)
  const controller = () => (pc ??= new PageController({ enableMask: false, viewportExpansion: -1, highlightOpacity: 0, highlightLabelOpacity: 0 }));

  /** Private elements in the page, its open shadow roots and same-origin frames (PageController walks all three). */
  function privates(root: Document | ShadowRoot, out: Element[] = []): Element[] {
    root.querySelectorAll(PRIVATE_SELECTOR).forEach((el) => out.push(el));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) privates(el.shadowRoot, out);
      if (el instanceof HTMLIFrameElement && !el.closest(PRIVATE_SELECTOR)) {
        try {
          if (el.contentDocument) privates(el.contentDocument, out);
        } catch {
          // another site's frame: PageController can't read it either
        }
      }
    });
    return out;
  }

  /** Reads the page with the private parts hidden from PageController, then takes its index badges away. */
  async function withPrivatesHidden<T>(fn: () => Promise<T>): Promise<T> {
    const marked = privates(document).filter((el) => !el.hasAttribute(IGNORE));
    marked.forEach((el) => el.setAttribute(IGNORE, "true"));
    try {
      return await fn();
    } finally {
      marked.forEach((el) => el.removeAttribute(IGNORE));
      // Its badges go, and so does the (then empty) box it drew them in: nothing of ours stays on the page.
      controller()
        .cleanUpHighlights()
        .then(() => {
          const box = document.getElementById("playwright-highlight-container");
          if (box && !box.childElementCount) box.remove();
        })
        .catch(() => undefined);
    }
  }

  /** The element a read gave this number, if it's still on the page and isn't private. */
  function element(input: Record<string, unknown>): { el: Element; index: number; label: string } {
    const index = typeof input.index === "number" ? input.index : Number(input.index);
    if (!read) throw new Error("Read the page first (read_page), then use a number from it.");
    if (!Number.isInteger(index) || index < 0) throw new Error("No element number: use one from the latest read_page.");
    const el = (controller() as unknown as Indexed).selectorMap.get(index)?.ref;
    if (!el) throw new Error(`The latest read_page has no element ${index}.`);
    if (!el.isConnected) throw new Error(`Element ${index} isn't on the page any more: read_page again.`);
    if (el.closest(PRIVATE_SELECTOR)) throw new Error("That element is private: the customer has to use it themselves.");
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : `element ${index}`;
    return { el, index, label };
  }

  /** PageController's result: its message (masked) when it worked, else an error the AI gets as "Failed: …". */
  function done(r: { success: boolean; message: string }, ok: string): string {
    if (!r.success) throw new Error(controlMessage(r.message) || "That didn't work.");
    return /new tab/i.test(r.message) ? `${ok} It opened in a new tab.` : ok;
  }

  const number = { type: "integer", minimum: 0, description: "The element's number from the latest read_page (always fill it)." };
  const label = { type: "string", description: "What it is, as the visitor sees it, like 'Save button' (always fill it)." };
  const actions: Action[] = [
    {
      name: "read_page",
      description: "See what's on the visitor's screen: the page's text and the buttons, links and fields you can use, each with a number.",
      inputSchema: { type: "object", properties: {} },
      risk: "auto",
      status: "Reading the page",
      async execute() {
        const state = await withPrivatesHidden(() => controller().getBrowserState());
        read = true;
        return pageRead(state, location.origin, MAX_PAGE_READ_RESULT);
      },
    },
    {
      name: "click",
      description: "Click a button, link or other element on the visitor's page, by its number from read_page.",
      inputSchema: { type: "object", properties: { index: number, label } },
      status: "Clicking",
      async execute(input) {
        const { el, index, label } = element(input);
        return done(await pointer.act(el, pointChip({ name: "click", input }), () => controller().clickElement(index)), `Clicked ${label}.`);
      },
    },
    {
      name: "type_text",
      description: "Type text into a field on the visitor's page, by its number from read_page. It replaces what the field had.",
      inputSchema: { type: "object", properties: { index: number, text: { type: "string", description: "What to type." }, label }, required: ["text"] },
      status: "Typing",
      async execute(input) {
        const { el, index, label } = element(input);
        const text = typeof input.text === "string" ? input.text : String(input.text ?? "");
        return done(await pointer.act(el, pointChip({ name: "type_text", input }), () => controller().inputText(index, text)), `Typed into ${label}.`);
      },
    },
    {
      name: "choose_option",
      description: "Choose an option in a dropdown (select) on the visitor's page, by its number from read_page.",
      inputSchema: { type: "object", properties: { index: number, option: { type: "string", description: "The option's text, as shown." }, label }, required: ["option"] },
      status: "Choosing",
      async execute(input) {
        const { el, index, label } = element(input);
        const wanted = String(input.option ?? "").trim();
        // PageController wants the option's exact text; the AI may get its case or spaces wrong.
        const match = el instanceof HTMLSelectElement ? Array.from(el.options).find((o) => o.textContent?.trim().toLowerCase() === wanted.toLowerCase()) : undefined;
        const chosen = match?.textContent?.trim() ?? wanted;
        return done(await pointer.act(el, pointChip({ name: "choose_option", input: { option: chosen } }), () => controller().selectOption(index, chosen)), `Chose ${chosen} in ${label}.`);
      },
    },
    {
      name: "scroll_page",
      description: "Scroll the visitor's page up or down by one screen.",
      inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["down", "up"], description: "Which way." } }, required: ["direction"] },
      risk: "auto",
      status: "Scrolling",
      async execute(input) {
        // PageController scrolls only after a read (its numbers may point at a scrolling box).
        if (!read) {
          await withPrivatesHidden(() => controller().updateTree());
          read = true;
        }
        const r = await controller().scroll({ down: input.direction !== "up", numPages: 1 });
        if (!r.success) throw new Error(controlMessage(r.message) || "Couldn't scroll.");
        return controlMessage(r.message) || "Scrolled.";
      },
    },
  ];
  for (const action of actions) J.registerAction(action);
})();
