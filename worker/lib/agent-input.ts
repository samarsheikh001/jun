import type { ToolUser } from "../ai/config.ts";
import { MAX_SECRET_VALUE } from "../../shared/action-setup.ts";
import { MAX_TEST_MESSAGE, MAX_TEST_TURNS, type TestPress, type TestReply, type TestTurn } from "../../shared/test-chat.ts";
import { HttpError } from "../types.ts";

// Inputs of the Agent page's test chat and Try it (AI-25, AI-29), checked the same way for the
// dashboard's routes (worker/routes/agent.ts) and the MCP's tools (worker/mcp/tools.ts).

/** AI-29: a test chat sent back with each message, at most (its cards count). */
const MAX_TEST_BODY = 400_000;
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> =>
  isObject(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "").map(([k, s]) => [k, s.slice(0, MAX_SECRET_VALUE)])) : {};

/** AI-25 / AI-29: a test customer the admin typed (for {user.*}), or null. */
export function testCustomer(value: unknown): ToolUser | null {
  if (!isObject(value)) return null;
  const fields = strings(value);
  return { id: fields.id ?? "test-customer", email: fields.email ?? null, name: fields.name ?? null, attributes: strings(value.attributes), secrets: strings(value.secrets) };
}

/** AI-29: the test chat's turns from the body: customer messages and earlier replies (their cards too). */
export function readTestTurns(value: unknown): TestTurn[] {
  if (!Array.isArray(value) || !value.length) throw new HttpError(400, "invalid_field", "turns is the test chat so far.");
  if (JSON.stringify(value).length > MAX_TEST_BODY) throw new HttpError(400, "too_long", "This test chat is too long. Reset it and start again.");
  const turns = value.slice(-MAX_TEST_TURNS).map((t): TestTurn => {
    if (isObject(t) && t.role === "customer" && typeof t.text === "string") {
      // AI-30: a card's button press: which card, the action, what was entered (checked against the card in runTestChat).
      const p = isObject(t.press) ? t.press : null;
      const press: TestPress | null =
        p && typeof p.turn === "number" && typeof p.widgetId === "string" && isObject(p.action) && typeof p.action.type === "string"
          ? {
              turn: p.turn,
              widgetId: p.widgetId,
              action: { type: p.action.type, ...(p.action.payload !== undefined ? { payload: p.action.payload } : {}) },
              values: isObject(p.values) ? (Object.fromEntries(Object.entries(p.values).filter(([, v]) => typeof v === "string" || typeof v === "boolean")) as Record<string, string | boolean>) : {},
              ...(typeof p.item === "string" ? { item: p.item } : {}),
              ...(isObject(p.tool) && typeof p.tool.name === "string" && (p.tool.status === "ok" || p.tool.status === "error")
                ? { tool: { name: p.tool.name, status: p.tool.status, output: typeof p.tool.output === "string" ? p.tool.output.slice(0, 4000) : "", ...(typeof p.tool.done === "string" ? { done: p.tool.done } : {}) } }
                : {}),
            }
          : null;
      return { role: "customer", text: t.text.slice(0, MAX_TEST_MESSAGE), ...(press ? { press } : {}) };
    }
    if (isObject(t) && t.role === "ai" && isObject(t.reply)) {
      const r = t.reply;
      return {
        role: "ai",
        reply: {
          text: typeof r.text === "string" ? r.text.slice(0, 8000) : "",
          ...(typeof r.handoff === "string" ? { handoff: r.handoff } : {}),
          widgets: Array.isArray(r.widgets) ? (r.widgets.filter((w) => isObject(w) && typeof w.name === "string" && isObject(w.root)).slice(0, 6) as unknown as TestReply["widgets"]) : [],
          calls: [],
          ...(isObject(r.pageAction) && typeof r.pageAction.name === "string" ? { pageAction: { name: r.pageAction.name, input: isObject(r.pageAction.input) ? r.pageAction.input : {} } } : {}),
        },
      };
    }
    throw new HttpError(400, "invalid_field", "Each turn is { role: customer, text } or { role: ai, reply }.");
  });
  if (turns.at(-1)?.role !== "customer") throw new HttpError(400, "invalid_field", "The last turn must be the customer's message.");
  return turns;
}

