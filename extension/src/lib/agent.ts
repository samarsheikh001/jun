// One answer from the person's own AI (E-01): streamText with the page tools, run from the side
// panel against one tab. Tools that change the page wait for the panel's Confirm card first.
import { createOpenAI } from "@ai-sdk/openai";
import { isStepCount, jsonSchema, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { reloadedResult } from "../../../shared/page-control.ts";
import { callPage, type Target } from "./page.ts";
import { systemPrompt, wrapPage } from "./prompt.ts";
import { pointFor, type ToolInfo } from "./protocol.ts";
import { needsConfirm, type Keys, type Settings } from "./settings.ts";

export const MAX_STEPS = 20;

export type Decision = "yes" | "no" | "always";

export interface StepEvent {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input: Record<string, unknown>;
  label: string;
  result?: string;
}

export interface TurnEvents {
  text(delta: string): void;
  step(step: StepEvent): void;
  /** A click, typing or choice waits for the person; resolves with their answer. */
  confirm(request: { id: string; name: string; input: Record<string, unknown>; description: string }): Promise<Decision>;
}

export interface Turn {
  keys: Keys;
  /** Read on every step, so an "Always allow" mid-turn counts for the next one. */
  settings: () => Settings;
  target: Target;
  tools: ToolInfo[];
  history: ModelMessage[];
  text: string;
  signal: AbortSignal;
  on: TurnEvents;
  /** Tests only: a mock model and page instead of OpenAI and the tab. */
  model?: LanguageModel;
  call?: typeof callPage;
}

/** Thrown for problems the panel shows as they are (no key, the provider refused…). */
export class TurnError extends Error {}

/** The AI's history after the turn (to send with the next one). */
export async function runTurn(turn: Turn): Promise<ModelMessage[]> {
  const { target, on } = turn;
  const { model, mask } = turn.settings();
  if (!turn.model && !turn.keys.openai) throw new TurnError("Add your OpenAI API key in Settings first.");
  const call = turn.call ?? callPage;
  const messages: ModelMessage[] = [...turn.history, { role: "user", content: turn.text }];

  const tools: ToolSet = {};
  for (const info of turn.tools) {
    tools[info.name] = tool({
      description: info.description,
      inputSchema: jsonSchema(info.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (raw, { toolCallId }) => {
        const input = (raw ?? {}) as Record<string, unknown>;
        if (needsConfirm(turn.settings(), info.risk, target.site.origin)) {
          void call(target.tabId, { type: "jun:point", point: pointFor(info.name, input) });
          const decision = await on.confirm({ id: toolCallId, name: info.name, input, description: info.description });
          void call(target.tabId, { type: "jun:point", point: null });
          if (decision === "no") return "The person said no to this step. Don't do it; ask what they'd like instead.";
        }
        const r = await call(target.tabId, { type: "jun:run", name: info.name, input, mask });
        if (r.ok) return info.name === "read_page" ? wrapPage(r.result) : String(r.result ?? "Done.");
        if (r.error === "navigated") return reloadedResult(info.name).result;
        if (r.error === "no-access") throw new Error("Jun lost access to this page (it moved to another site). Ask the person to click the Jun button again.");
        throw new Error(r.error);
      },
    });
  }

  const result = streamText({
    model: turn.model ?? createOpenAI({ apiKey: turn.keys.openai })(model),
    system: systemPrompt({ host: target.site.host, title: target.title }),
    messages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal: turn.signal,
  });

  const status = (name: string) => turn.tools.find((t) => t.name === name)?.status ?? name;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") on.text(part.text);
    else if (part.type === "tool-call") on.step({ id: part.toolCallId, name: part.toolName, status: "running", input: (part.input ?? {}) as Record<string, unknown>, label: status(part.toolName) });
    else if (part.type === "tool-result") {
      const text = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
      on.step({ id: part.toolCallId, name: part.toolName, status: "done", input: (part.input ?? {}) as Record<string, unknown>, label: status(part.toolName), result: part.toolName === "read_page" ? undefined : text.slice(0, 200) });
    } else if (part.type === "tool-error") {
      const message = part.error instanceof Error ? part.error.message : String(part.error);
      on.step({ id: part.toolCallId, name: part.toolName, status: "error", input: (part.input ?? {}) as Record<string, unknown>, label: status(part.toolName), result: message.slice(0, 200) });
    } else if (part.type === "error") {
      throw new TurnError(providerMessage(part.error));
    }
  }
  // Every step's messages (tool calls and their results too), so the next question has the whole turn.
  return [...messages, ...(await result.responseMessages)];
}

/** The provider's error as one line the person can act on. */
export function providerMessage(error: unknown): string {
  const e = error as { statusCode?: number; message?: string } | null;
  if (e?.statusCode === 401) return "OpenAI didn't accept the API key. Check it in Settings.";
  if (e?.statusCode === 404) return "OpenAI doesn't know that model. Check the model name in Settings.";
  if (e?.statusCode === 429) return "OpenAI says you're over your limit or out of credit. Try again later or check your OpenAI account.";
  return e?.message ? `The AI failed: ${e.message.slice(0, 200)}` : "The AI failed. Try again.";
}
