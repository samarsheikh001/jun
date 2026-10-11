import { applyWidgetEdit, parseWidgetEdit, widgetEditInput, widgetEditPrompt, type WidgetEditTurn } from "../../shared/widget-ai.ts";
import { CHATKIT_AUTHORING_GUIDE } from "./chatkit-authoring.ts";
import { describeActions } from "../../shared/action-brief.ts";
import { checkExamples, MAX_WIDGET_JSON, parseWidgetFile, previewWidget, toolButtonInputs } from "../../shared/widgets.ts";
import { actionBriefs } from "./agent-file-edit.ts";
import { parseConfig, type ConfigFiles } from "./config.ts";
import { completeText, createModel, loadAiSettings } from "./providers.ts";
import { recordUsage } from "./topics.ts";

// W-22: a widget edited by chat on the Agent page. One request = one change: the model rewrites
// the template (shared/widget-ai.ts has the prompt and parsing), the new file must parse, render
// its sample and pass the widget checks, else the model gets the error and one more try. Nothing is
// saved: the file goes back to the admin's draft. Tokens count toward the month's usage, like other
// AI jobs.

// ChatKit Studio's guide for agents (about 16k tokens) with our rules after it; built once.
const PROMPT = widgetEditPrompt(CHATKIT_AUTHORING_GUIDE);
const EDIT_TIMEOUT_MS = 90_000;
const ATTEMPTS = 2;

export type WidgetEditSkip = "ai_off" | "cap_reached";

export class WidgetEditError extends Error {}

export interface WidgetEditResult {
  reply: string;
  /** The whole new .widget file (the one sent, when nothing changed). */
  file: string;
  /** False when the model left the widget as it was (it couldn't, or said why not). */
  changed: boolean;
}

/** W-27: buttons whose action would run without a required input, said in the reply. */
function inputsNote(buttons: ReturnType<typeof toolButtonInputs>, reply: string): string {
  const gaps = buttons.filter((b) => b.missing.length);
  if (!gaps.length) return reply;
  const parts = gaps.map((b) => `"${b.label}" runs ${b.tool} without ${b.missing.map((m) => (m.like ? `${m.name} (the field ${m.like} isn't named ${m.name})` : m.name)).join(", ")}`);
  return `${reply} Note: ${parts.join("; ")}.`;
}

export async function editWidget(
  env: Env,
  workspaceId: string,
  input: { name: string; file: string; message: string; history: WidgetEditTurn[]; files?: ConfigFiles },
): Promise<WidgetEditResult | { skipped: WidgetEditSkip }> {
  const [settings, usage] = await Promise.all([
    loadAiSettings(env, workspaceId),
    env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(workspaceId, new Date().toISOString().slice(0, 7)).first<{ replies: number }>(),
  ]);
  if (!settings.enabled) return { skipped: "ai_off" };
  if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) return { skipped: "cap_reached" };

  let current: Record<string, unknown>;
  try {
    current = JSON.parse(input.file) as Record<string, unknown>;
  } catch {
    throw new WidgetEditError("This widget's file isn't valid JSON. Fix it in Code first.");
  }
  const template = typeof current.template === "string" ? current.template : "";
  const summary = typeof current.summary === "string" ? current.summary : null;
  const schema = typeof current.jsonSchema === "object" && current.jsonSchema !== null && !Array.isArray(current.jsonSchema) && Object.keys(current.jsonSchema).length ? (current.jsonSchema as Record<string, unknown>) : undefined;

  // W-27: the desk's actions (from the draft), so buttons and fields fit the actions they run.
  const config = input.files ? parseConfig(input.files).config : null;
  const actions = config ? describeActions(actionBriefs(config)) : undefined;
  const inputsOf = (tool: string) => config?.tools.find((t) => t.name === tool)?.input ?? null;

  const model = createModel(env, workspaceId, settings, "editor");
  let failed: { template: string; message: string } | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = await completeText({
      model: model.model,
      ...model.prompt(PROMPT),
      messages: [{ role: "user", content: widgetEditInput({ name: input.name, template, sample: current.sample, summary, ...(schema ? { schema } : {}), ...(actions ? { actions } : {}), history: input.history, message: input.message, ...(failed ? { error: failed } : {}) }) }],
      maxOutputTokens: 6000,
      temperature: 0.2,
      abortSignal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
    await recordUsage(env, workspaceId, result.totalUsage);
    let edit;
    try {
      edit = parseWidgetEdit(result.text);
    } catch (error) {
      failed = { template: "(see your sample)", message: (error as Error).message };
      continue;
    }
    if (!edit) {
      failed = { template: "(none)", message: "The answer had no <template>…</template>." };
      continue;
    }
    const changed =
      edit.template.trim() !== template.trim() ||
      (edit.sample !== undefined && JSON.stringify(edit.sample) !== JSON.stringify(current.sample)) ||
      (edit.summary !== undefined && edit.summary !== (summary ?? "")) ||
      (edit.schema !== undefined && JSON.stringify(edit.schema) !== JSON.stringify(schema ?? null));
    if (!changed) return { reply: edit.reply, file: input.file, changed: false };
    const file = applyWidgetEdit(input.file, edit);
    try {
      if (file.length > MAX_WIDGET_JSON * 2) throw new Error("The widget is too big.");
      const tree = previewWidget(input.name, file);
      // W-30: the example data and states must still fit the widget's parameters.
      checkExamples(parseWidgetFile(input.name, file));
      return { reply: config ? inputsNote(toolButtonInputs(tree, inputsOf), edit.reply) : edit.reply, file, changed: true };
    } catch (error) {
      failed = { template: edit.template, message: (error as Error).message };
    }
  }
  throw new WidgetEditError(`The AI's change didn't work (${failed?.message ?? "no answer"}). Try asking another way.`);
}
