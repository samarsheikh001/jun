import type { ActionBrief } from "../../shared/action-brief.ts";
import { agentFileEditInput, agentFileEditPrompt, agentFileKind, parseAgentFileEdit, type AgentFileContext } from "../../shared/agent-file-ai.ts";
import { agentLinks } from "../../shared/agent-links.ts";
import type { WidgetEditTurn } from "../../shared/widget-ai.ts";
import { parseConfig, type AgentConfig, type ConfigFiles } from "./config.ts";
import { completeText, createModel, loadAiSettings } from "./providers.ts";
import { recordUsage } from "./topics.ts";

// W-24: an action or a procedure edited by chat on the Agent page, like a widget (W-22,
// widget-edit.ts). One request = one change: the model rewrites the file (prompts in
// shared/agent-file-ai.ts); the whole draft with the new file must pass the config checker for that
// file, else the model gets the problems and one more try. Nothing is saved: the file goes back to
// the admin's draft.

const EDIT_TIMEOUT_MS = 90_000;
const ATTEMPTS = 2;

export type AgentFileEditSkip = "ai_off" | "cap_reached";

export class AgentFileEditError extends Error {}

export interface AgentFileEditResult {
  reply: string;
  /** The whole new file (the one sent, when nothing changed). */
  file: string;
  changed: boolean;
}

/** W-27: each action as the AI editors see it: what it does, its inputs, what it changes and shows. */
export function actionBriefs(config: Pick<AgentConfig, "tools" | "widgets">): ActionBrief[] {
  // W-29: the AI's own tool for cards it fills in itself, when any card allows it.
  const fillable = config.widgets.filter((w) => w.aiFill).map((w) => w.name);
  const showWidget: ActionBrief[] = fillable.length
    ? [{ name: "show_widget", description: `Shows the customer a card the AI fills in itself from what it knows (never account data it doesn't have). Cards: ${fillable.join(", ")}.`, method: "GET", customer: false, inputs: [{ name: "widget", type: "string", required: true, enum: fillable }, { name: "data", type: "string", required: true, description: "The card's data" }] }]
    : [];
  return config.tools.map((t): ActionBrief => ({
    name: t.name,
    description: t.description,
    method: t.method,
    inputs: Object.entries(t.input).map(([name, i]) => ({ name, type: i.type, required: i.required, ...(i.enum ? { enum: i.enum } : {}), ...(i.description ? { description: i.description } : {}) })),
    customer: JSON.stringify([t.url, t.headers, t.query, t.body ?? null]).includes("{user."),
    ...(t.widget ? { widget: t.widget } : {}),
  })).concat(showWidget);
}

/** What else the desk has, so the model can name actions, procedures and widgets correctly. */
function contextOf(files: ConfigFiles, path: string, target: { kind: string; name: string }): AgentFileContext {
  const { config } = parseConfig(files);
  const context: AgentFileContext = {
    actions: actionBriefs(config).filter((a) => !(target.kind === "action" && a.name === target.name)),
    procedures: config.skills.filter((s) => `skills/${s.name}/SKILL.md` !== path).map((s) => ({ name: s.name, description: s.description })),
    widgets: config.widgets.map((w) => w.name),
  };
  if (target.kind === "action") {
    const links = agentLinks(files);
    context.usedBy = [
      ...(links.actionUsedBy[target.name] ?? []).map((p) => `procedure ${p}`),
      ...(links.actionRunFrom[target.name] ?? []).map((w) => `a button in widget ${w}`),
    ];
  }
  return context;
}

/** W-27: a procedure's steps that name actions the desk doesn't have, said in the reply (once). */
function missingNote(files: ConfigFiles, name: string, reply: string): string {
  const missing = (agentLinks(files).procedureMissing[name] ?? []).filter((m) => !reply.includes(m));
  if (!missing.length) return reply;
  const list = missing.map((m) => `@${m}`).join(", ");
  return `${reply} ${missing.length === 1 ? `${list} isn't an action yet` : `${list} aren't actions yet`}: create ${missing.length === 1 ? "it" : "them"} from Connected.`;
}

export async function editAgentFile(
  env: Env,
  workspaceId: string,
  input: { path: string; files: ConfigFiles; message: string; history: WidgetEditTurn[] },
): Promise<AgentFileEditResult | { skipped: AgentFileEditSkip }> {
  const target = agentFileKind(input.path);
  if (!target) throw new AgentFileEditError("Only actions and procedures can be edited here.");
  const text = input.files[input.path];
  if (text === undefined) throw new AgentFileEditError("That file isn't in the draft.");
  const [settings, usage] = await Promise.all([
    loadAiSettings(env, workspaceId),
    env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(workspaceId, new Date().toISOString().slice(0, 7)).first<{ replies: number }>(),
  ]);
  if (!settings.enabled) return { skipped: "ai_off" };
  if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) return { skipped: "cap_reached" };

  const context = contextOf(input.files, input.path, target);
  const model = createModel(env, workspaceId, settings, "editor");
  let failed: { file: string; problems: string[] } | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = await completeText({
      model: model.model,
      ...model.prompt(agentFileEditPrompt(target.kind)),
      messages: [{ role: "user", content: agentFileEditInput({ ...target, path: input.path, text, context, history: input.history, message: input.message, ...(failed ? { error: failed } : {}) }) }],
      maxOutputTokens: 4000,
      temperature: 0.2,
      abortSignal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
    await recordUsage(env, workspaceId, result.totalUsage);
    const edit = parseAgentFileEdit(result.text);
    if (!edit) {
      failed = { file: "(none)", problems: ["The answer had no <file>…</file>."] };
      continue;
    }
    if (edit.file.trim() === text.trim()) return { reply: edit.reply, file: text, changed: false };
    // Checked like a save: the whole draft with this file, problems for this file only.
    const next = { ...input.files, [input.path]: edit.file };
    const problems = parseConfig(next).issues.filter((i) => i.path === input.path).map((i) => i.message);
    if (!problems.length) return { reply: target.kind === "procedure" ? missingNote(next, target.name, edit.reply) : edit.reply, file: edit.file, changed: true };
    failed = { file: edit.file, problems };
  }
  throw new AgentFileEditError(`The AI's change didn't pass the checks (${failed?.problems.join(" ") ?? "no answer"}). Try asking another way.`);
}
