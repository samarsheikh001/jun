import type { AiAction } from "../../shared/protocol.ts";
import { formatTime } from "../lib/thread.ts";
import { StepTrace, type TraceStep } from "@/components/agent-steps.tsx";
import { ToolIcon } from "@/components/icons.tsx";

// AI-11: the AI's tool calls as compact chips (agents only; never rendered in the widget).
// A header ("3 tool calls · 1 failed") folds the list; each row folds its details: what the
// model sent, what came back (as stored, already capped by the tool runner), HTTP status, time.
// Only the model's input is stored, never request headers, so tool secrets can't show here.
// D-129: drawn by the desk's shared step trace (`web/components/agent-steps.tsx`), as Home's assistant.

/** `id: 1234, plan: "pro"` — the input, short enough for a chip. */
export function inputSummary(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.join(", ") || "no input";
}

/** Pretty JSON when the stored output is JSON, else the text as is. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function toStep(action: AiAction): TraceStep {
  const failed = action.status === "error";
  return {
    id: action.id,
    title: action.tool,
    icon: <ToolIcon />,
    chip: inputSummary(action.input),
    status: failed ? "error" : "done",
    statusText: failed ? `failed${action.httpStatus ? ` ${action.httpStatus}` : ""}` : "ok",
    details: [
      { label: "Input", text: Object.keys(action.input).length ? JSON.stringify(action.input, null, 2) : "(none)", mono: true },
      ...(action.output ? [{ label: failed ? "Error" : "Result", text: pretty(action.output), mono: true, error: failed }] : []),
    ],
    meta: [action.httpStatus ? `HTTP ${action.httpStatus}` : null, `${action.durationMs} ms`, formatTime(action.createdAt), action.configVersion ? `config v${action.configVersion}` : null].filter(Boolean).join(" · "),
  };
}

/**
 * The AI's tool calls, folded under one header. `defaultOpen` false makes the compact
 * version shown in the thread next to the reply that made the calls.
 */
export function ToolCalls({ actions, defaultOpen = true, className }: { actions: AiAction[]; defaultOpen?: boolean; className?: string }) {
  if (!actions.length) return null;
  const failed = actions.filter((a) => a.status === "error").length;
  return (
    <StepTrace
      className={className ? `tool-calls ${className}` : "tool-calls"}
      defaultOpen={defaultOpen}
      steps={actions.map(toStep)}
      header={
        <>
          {actions.length} tool call{actions.length === 1 ? "" : "s"}
          {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
        </>
      }
    />
  );
}
