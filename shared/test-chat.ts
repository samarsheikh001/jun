// AI-29: "Test" on a task's page. The admin chats as a customer with the unsaved draft: each message
// goes to `POST …/agent/test-chat` with the chat so far, the Worker runs the same `runAgent` live chats
// use and streams back what the customer would see. Nothing is stored: no conversation, no inbox, no
// audit row. By default it's safe: look-ups (GET) run for real, changes (POST) are answered without
// being made. Pure: the shapes both sides share, and turning a chat into a test case (evals/*.yaml).

import type { AiStep } from "./protocol.ts";
import type { MessageWidget } from "./widgets.ts";

/** At most this many turns go to the server (customer and AI together). */
export const MAX_TEST_TURNS = 40;
/** A customer message in the test chat, at most. */
export const MAX_TEST_MESSAGE = 2000;

/** One turn of the test chat as the browser keeps it (and sends it back with the next message). */
export type TestTurn =
  | { role: "customer"; text: string }
  | { role: "ai"; reply: TestReply };

/** An action the reply called (or, in the safe mode, answered without calling). */
export interface TestCall {
  tool: string;
  status: "ok" | "error";
  httpStatus: number | null;
  /** What the AI read back, shortened. */
  output: string;
  pretended?: true;
}

/** The AI's reply, as the customer would see it, plus what happened behind it. */
export interface TestReply {
  text: string;
  /** It handed the chat to a person, and why. */
  handoff?: string;
  /** It flagged a problem for the engineers. */
  escalate?: string;
  widgets: MessageWidget[];
  calls: TestCall[];
  /** It asked to run an action on the customer's website (in a real chat, they'd confirm it). */
  pageAction?: { name: string; input: Record<string, unknown> };
  /** Knowledge it cited, by title. */
  sources?: { title: string; url: string | null }[];
}

/** The streamed answer, one JSON object per line. */
export type TestChatEvent =
  | { type: "step"; step: AiStep }
  | { type: "text"; text: string }
  | { type: "done"; reply: TestReply }
  | { type: "error"; message: string };

/**
 * A test case (one entry of an evals/*.yaml list) from a test chat: what the customer said, and what
 * the last reply did (its outcome, the actions it called, the card it showed, the website action it
 * asked for), so a later change that breaks it shows up on the Tests page.
 */
export function testCaseFrom(name: string, turns: TestTurn[], page: string | null): Record<string, unknown> | null {
  const said = turns.filter((t): t is { role: "customer"; text: string } => t.role === "customer").map((t) => t.text.trim()).filter(Boolean);
  const last = [...turns].reverse().find((t): t is { role: "ai"; reply: TestReply } => t.role === "ai")?.reply;
  if (!said.length || !last) return null;
  const tools = [...new Set(last.calls.map((c) => c.tool))];
  const expect: Record<string, unknown> = {
    outcome: last.handoff !== undefined ? "handoff" : last.pageAction ? "action" : last.escalate ? "escalate" : "answer",
    ...(tools.length ? { tools } : {}),
    ...(last.widgets.length ? { widget: last.widgets[last.widgets.length - 1]!.name } : {}),
    ...(last.pageAction ? { action: { name: last.pageAction.name } } : {}),
  };
  return {
    name,
    ...(said.length === 1 ? { message: said[0] } : { messages: said }),
    ...(page ? { page } : {}),
    expect,
  };
}
