// The side panel ↔ the page's content script (E-01). One message per request through
// chrome.tabs.sendMessage, answered with a PageResponse. Pure, so it's unit tested.

/** Where WXT writes src/entrypoints/page.content.ts (registration: "runtime", injected on demand). */
export const PAGE_SCRIPT = "/content-scripts/page.js";

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "auto" | "confirm";
  status: string;
}

export type Point = { name: string; index: number; input: Record<string, unknown> };

export type PageRequest =
  | { type: "jun:tools" }
  | { type: "jun:run"; name: string; input: Record<string, unknown>; mask: boolean }
  | { type: "jun:point"; point: Point | null };

export type PageResponse = { ok: true; result: unknown } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A message the content script accepts, or null (anything else is ignored). */
export function readRequest(message: unknown): PageRequest | null {
  if (!isObject(message)) return null;
  if (message.type === "jun:tools") return { type: "jun:tools" };
  if (message.type === "jun:run") {
    if (typeof message.name !== "string" || !message.name) return null;
    return { type: "jun:run", name: message.name, input: isObject(message.input) ? message.input : {}, mask: message.mask !== false };
  }
  if (message.type === "jun:point") {
    const p = message.point;
    if (p === null || p === undefined) return { type: "jun:point", point: null };
    if (!isObject(p) || typeof p.name !== "string" || !Number.isInteger(Number(p.index))) return null;
    return { type: "jun:point", point: { name: p.name, index: Number(p.index), input: isObject(p.input) ? p.input : {} } };
  }
  return null;
}

/** The step a Confirm card waits on, as the page's ring wants it (only clicks, typing and choosing). */
export function pointFor(name: string, input: Record<string, unknown>): Point | null {
  if (name !== "click" && name !== "type_text" && name !== "choose_option") return null;
  const index = Number(input.index);
  return Number.isInteger(index) && index >= 0 ? { name, index, input } : null;
}
