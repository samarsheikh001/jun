import { cleanUrl, redact } from "./debug.ts";

// AI-32 page control (D-93): on sites that opt in (`data-page-control="on"` on the snippet), the
// loader adds five website actions built on alibaba/page-agent's PageController (MIT): read the
// visitor's page, then click, type, choose and scroll by the numbers that read gave. They are
// ordinary page actions (risk gate, Confirm card, steps, audit `page:<name>`, evals); the
// browser side is web/page-control/index.ts (the lazy chunk widget-page-control.js).
//
// They are recognised by name, here and in public/widget-actions.js. A site that registers its own
// action under one of these names replaces ours (the registry keeps the newer one) and gets the same
// treatment: a bigger result for read_page, `index` hidden on the card, always offered. That is
// harmless: those only change sizes and display, never what may run.

export const PAGE_CONTROL_ACTIONS = ["read_page", "click", "type_text", "choose_option", "scroll_page"] as const;
export type PageControlAction = (typeof PAGE_CONTROL_ACTIONS)[number];

export function isPageControl(name: string | undefined): name is PageControlAction {
  return (PAGE_CONTROL_ACTIONS as readonly string[]).includes(name ?? "");
}

/**
 * A step the chat started on a page that then reloaded (a link or form opened a new page) before the
 * page reported back: the frame closes it after the reload so the run goes on. A page-control click
 * that loads a page is how it's meant to work, so it counts as done; any other action may or may not
 * have worked, so it's an error the AI checks.
 */
export function reloadedResult(name: string): { status: "ok" | "error"; result: string } {
  return isPageControl(name)
    ? { status: "ok", result: "Done. A new page loaded: read_page to see it before the next step." }
    : { status: "error", result: "The page reloaded before this reported back, so it may or may not have worked. Check before going on." };
}

/** AI-32: the chat frame → the page: the page-control step waiting for the visitor's Confirm (null: none). */
export interface PointMessage {
  type: "jun:point";
  point: { name: string; index: number; input: Record<string, unknown> } | null;
}

/** A step the visitor's Confirm is waiting on, for the page's highlight (only clicks, typing and choosing). */
export function pointOf(action: { name: string; status: string; risk: string; missing: string[]; input: Record<string, unknown> } | undefined): PointMessage["point"] {
  if (!action || action.status !== "pending" || action.risk === "auto" || action.missing.length) return null;
  if (action.name !== "click" && action.name !== "type_text" && action.name !== "choose_option") return null;
  const index = Number(action.input.index);
  return Number.isInteger(index) && index >= 0 ? { name: action.name, index, input: action.input } : null;
}

/** The chip by the highlighted element: what will happen ("Type “Acme”"), and while waiting, where to say yes. */
export function pointChip(point: { name: string; input: Record<string, unknown> }, waiting = false): string {
  const quote = (v: unknown) => `“${String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}”`;
  const verb = point.name === "type_text" ? `Type ${quote(point.input.text)}` : point.name === "choose_option" ? `Choose ${quote(point.input.option)}` : "Click";
  return waiting ? `${verb} · confirm in the chat` : verb;
}

/**
 * AI-32: the visitor chose "Always allow" for page control on this site: its clicks, typing and
 * choices run without a Confirm, like an `auto` action (reading and scrolling already do). Only
 * page control's own steps that would ask (`confirm`); `human` and the site's own actions never change.
 */
export function allowedToRun<T extends { name: string; risk: string; status: string }>(action: T): T {
  return action.status === "pending" && action.risk === "confirm" && isPageControl(action.name) ? { ...action, risk: "auto" } : action;
}

/**
 * AI-32: the desk's choice for page control's clicks, typing and choices (Chat widget → Behaviour):
 * ask with an "Always allow" button (the default), ask every time, or never ask.
 */
export type PageControlConfirm = "allow-always" | "every-time" | "never";
export const PAGE_CONTROL_CONFIRMS: PageControlConfirm[] = ["allow-always", "every-time", "never"];
export function pageControlConfirm(value: unknown): PageControlConfirm {
  return PAGE_CONTROL_CONFIRMS.includes(value as PageControlConfirm) ? (value as PageControlConfirm) : "allow-always";
}

/** "Don't ask": page control's steps run at once (the desk's website-actions.yaml can still say otherwise). */
export function withPageControlConfirm<T extends { name: string; risk: string }>(actions: T[], confirm: PageControlConfirm): T[] {
  if (confirm !== "never") return actions;
  return actions.map((a) => (isPageControl(a.name) && a.risk === "confirm" ? { ...a, risk: "auto" } : a));
}

/**
 * Which visitor message an AI reply answers: its clientMsgId is `ai:<seq>` (or `ai:<seq>.<n>` for the
 * steps of a run after it). The widget runs a page action only in the tab that sent that message, so a
 * chat open in two tabs doesn't run it on both pages.
 */
export function answersSeq(clientMsgId: string): number | null {
  const m = /^ai:(\d+)(?:\.\d+)?$/.exec(clientMsgId);
  return m ? Number(m[1]) : null;
}

/** The page's actions without page control: the desk's switch (inbox setting `pageControl`) is off. */
export function withoutPageControl<T extends { name: string }>(actions: T[]): T[] {
  return actions.filter((a) => !isPageControl(a.name));
}

/** read_page's result, at most (other actions keep MAX_ACTION_RESULT): a page's text with element numbers. */
export const MAX_PAGE_READ_RESULT = 12000;

/**
 * Never read, never touched: the widget itself, anything a site marks `data-jun-private`, and fields
 * whose values must never leave the page (passwords, card details, one-time codes, hidden inputs).
 * Keep in step with the private-field note in the docs (widget/page-control).
 */
export const PRIVATE_SELECTOR = [
  "[data-jun-desk]",
  "[data-jun-private]",
  "input[type=password]",
  "input[type=hidden]",
  '[autocomplete*="cc-"]',
  '[autocomplete*="one-time-code"]',
  '[autocomplete*="password"]',
].join(",");

/**
 * What PageController's getBrowserState() returns, and (masked, the URL without query values)
 * read_page's result as the AI gets it.
 */
export interface PageRead {
  url: string;
  title: string;
  header: string;
  content: string;
  footer: string;
}

const CUT_NOTE = "\n… (the rest of the page was cut; scroll_page and read_page again to see more)";

/**
 * The masked read, small enough that its JSON fits MAX_PAGE_READ_RESULT (so it's never cut
 * mid-string later). The header names the page by its raw URL: that becomes the clean one.
 */
export function pageRead(state: PageRead, origin: string, max = MAX_PAGE_READ_RESULT): PageRead {
  const path = cleanUrl(state.url, origin);
  const url = path.startsWith("/") ? origin + path : path;
  const header = state.url ? state.header.split(state.url).join(url) : state.header;
  const read: PageRead = { url, title: redact(state.title, 200), header: redact(header, 1000), content: "", footer: redact(state.footer, 200) };
  const content = redact(state.content, max);
  const size = (c: string) => JSON.stringify({ ...read, content: c }).length;
  if (size(content) <= max) return { ...read, content };
  // JSON escapes (tabs, quotes, newlines) make it longer than the text: cut until it fits.
  let keep = content.length;
  for (let over = size(content + CUT_NOTE) - max; over > 0 && keep > 0; over = size(content.slice(0, keep) + CUT_NOTE) - max) keep -= Math.max(over, 50);
  return { ...read, content: content.slice(0, Math.max(0, keep)) + CUT_NOTE };
}

/** A PageController message (or error) as one masked line: its ✅/❌/⚠️ marks out, at most 300 chars. */
export function controlMessage(message: unknown): string {
  return redact(String(message ?? "").replace(/[✅❌⚠]️?/gu, "").replace(/^\s*Error:\s*/, "").replace(/\s+/g, " ").trim(), 300);
}

/** What a step row and the Confirm card show of a page-control action's inputs: its label first, never the element number. */
export function shownInput(action: { name?: string; input: Record<string, unknown> }): Record<string, unknown> {
  if (!isPageControl(action.name)) return action.input;
  const { index: _index, label, ...rest } = action.input;
  return label === undefined || label === "" ? rest : { label, ...rest };
}

/** What the customer reads on the Confirm card and in a step's details (the descriptions are written for the AI). */
const SHOWN: Record<PageControlAction, string> = {
  read_page: "Read this page",
  click: "Click on this page",
  type_text: "Type into a field on this page",
  choose_option: "Choose an option on this page",
  scroll_page: "Scroll this page",
};

export function shownDescription(action: { name?: string; description: string }): string {
  return isPageControl(action.name) ? SHOWN[action.name] : action.description;
}
