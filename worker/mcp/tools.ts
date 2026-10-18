import { parseDocument, stringify } from "yaml";
import { changedPaths, INSTRUCTIONS_PATH, isConfigPath, parseConfig, WEBSITE_ACTIONS_PATH, withCurrentPaths, type AgentConfig, type ConfigFiles, type ConfigIssue, type ToolSpec } from "../ai/config.ts";
import { ConfigConflictError, listVersions, loadConfigFiles, saveConfig } from "../ai/config-store.ts";
import { applyDesk, DESK_PATH, parseDeskFile, updateDeskText, type DeskFile, type DeskIssue } from "../ai/desk-file.ts";
import { DEFAULT_REPLAY_SAMPLE, MAX_REPLAY_SAMPLE, runEval, type EvalEvent } from "../ai/eval.ts";
import { AiUnavailableError, createModel, loadAiSettings } from "../ai/providers.ts";
import { deleteSource, DEFAULT_MAX_PAGES, finishStuckSyncs, type SourceSettings } from "../ai/knowledge.ts";
import { documentInput, DocumentInputError, sourceState, sourceType } from "../ai/knowledge-input.ts";
import { addFileSource, addWebsite, listSources, replaceDocument, resyncSource, type SourceListRow } from "../ai/knowledge-sources.ts";
import { searchKnowledge } from "../ai/search.ts";
import { runTestChat } from "../ai/test-chat.ts";
import { runTool } from "../ai/tools.ts";
import { recordUsage } from "../ai/topics.ts";
import { CHATKIT_AUTHORING_GUIDE } from "../ai/chatkit-authoring.ts";
import { applySavedDesk, generatedDeskFile, loadDeskState } from "../lib/desk.ts";
import { newId } from "../lib/crypto.ts";
import { readTestTurns, testCustomer } from "../lib/agent-input.ts";
import { loadToolSecrets, workerSecretNames } from "../lib/tool-secrets.ts";
import { editFrontmatter, editYaml, readFrontmatter, readYaml, setBody, withJsonKey, type Edit } from "../../shared/agent-files.ts";
import { FILE_FORMAT, MCP_INSTRUCTIONS } from "../../shared/agent-guide.ts";
import { agentLinks } from "../../shared/agent-links.ts";
import { actionSetupProblems, MAX_DESK_SECRETS, MAX_SECRET_VALUE, SECRET_NAME, secretRefs } from "../../shared/action-setup.ts";
import { cardFromResult } from "../../shared/action-try.ts";
import type { SeenPageAction } from "../../shared/actions.ts";
import { curlActionFile, curlActionName, parseCurl } from "../../shared/curl.ts";
import { jinjaNames } from "../../shared/jinja.ts";
import type { TestReply, TestTurn } from "../../shared/test-chat.ts";
import { schemaParams } from "../../shared/widget-schema.ts";
import { WIDGET_TEMPLATES } from "../../shared/widget-templates.ts";
import {
  cardControls, cardFromShape, checkExamples, nodeText, parseWidgetFile, previewWidget, renderSummary, renderWidget, starterWidget, toolButtonInputs, widgetSchema, type WidgetNode,
} from "../../shared/widgets.ts";
import { JUN_VERSION } from "../../shared/version.ts";
import { unifiedDiff } from "../../shared/line-diff.ts";
import { widgetLook } from "../../shared/appearance.ts";
import { workspaceLogos } from "../../shared/workspace-summary.ts";
import { screenshot, type ShotResult } from "./shot.ts";
import { HttpError, type Role } from "../types.ts";
import { ToolError, type JsonSchema, type McpResource, type McpServer, type McpTool, type ToolAnnotations, type ToolResult } from "./server.ts";

// D-86: the MCP server's tools. Each one does what the Agent page does, through the same functions
// (parseConfig, saveConfig, the shared field edits, runTool, runEval, runTestChat…), so a person's own
// AI and the desk get the same results. Every change reads the latest version, edits only what it
// must, is checked by parseConfig and saved as a new version (source "mcp") that goes live at once;
// `dryRun` shows the result without saving. desk.yaml changes are applied like a save on the desk.
// Reading needs any member's token; changing, Try it and the test chat need an owner's or admin's.
// D-87: knowledge tools too, through the Knowledge page's functions (knowledge-sources.ts); knowledge
// isn't versioned, so they change it directly (no commit) and remove_source asks for confirm: true.

export interface McpContext {
  env: Env;
  workspaceId: string;
  user: { id: string; name: string; email: string | null };
  role: Role;
  /** This desk's address, for links to its pages. */
  origin: string;
}

type Args = Record<string, unknown>;
type Tool = McpTool<McpContext>;

// ---------- small helpers ----------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const done = (text: string): ToolResult => ({ text });
const fail = (message: string): never => {
  throw new ToolError(message);
};
const str = (args: Args, key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);
const need = (args: Args, key: string): string => {
  const value = str(args, key)?.trim();
  if (!value) fail(`${key} is required.`);
  return value!;
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** diff_versions' answer is cut here (a whole-config rewrite can be long). */
const MAX_DIFF = 40_000;
const block = (path: string, text: string) => `--- ${path} ---\n${text.endsWith("\n") ? text : `${text}\n`}--- end of ${path} ---`;
const humanize = (name: string) => {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
};

const TASK_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTION_NAME = /^[a-z][a-z0-9_]*$/;
const WIDGET_NAME = /^[a-z][a-z0-9_-]*$/;
const TEST_FILE = /^[a-zA-Z0-9_-]+$/;
const TASK_FILE = /^tasks\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const ACTION_FILE = /^actions\/([a-z][a-z0-9_]*)\.ya?ml$/;
const WIDGET_FILE = /^widgets\/([a-z][a-z0-9_-]*)\.widget$/;
const TEST_PATH = /^tests\/([a-zA-Z0-9_-]+)\.ya?ml$/;

function taskName(args: Args): string {
  const name = need(args, "name");
  if (!TASK_NAME.test(name)) fail(`"${name}" isn't a task name: lowercase letters and digits joined by -, like change-plan.`);
  return name;
}
function actionName(args: Args, key = "name"): string {
  const name = need(args, key);
  if (!ACTION_NAME.test(name)) fail(`"${name}" isn't an action name: a lowercase letter, then lowercase letters, digits and _, like lookup_order.`);
  return name;
}
function widgetName(args: Args, key = "name"): string {
  const name = need(args, key);
  if (!WIDGET_NAME.test(name)) fail(`"${name}" isn't a widget name: a lowercase letter, then lowercase letters, digits, _ and -, like order_status.`);
  return name;
}

/** The path of an existing action (.yaml or .yml), else the .yaml one. */
const actionPath = (files: ConfigFiles, name: string) => (`actions/${name}.yml` in files && !(`actions/${name}.yaml` in files) ? `actions/${name}.yml` : `actions/${name}.yaml`);
const testPath = (files: ConfigFiles, file: string) => (`tests/${file}.yml` in files && !(`tests/${file}.yaml` in files) ? `tests/${file}.yml` : `tests/${file}.yaml`);

function existing(files: ConfigFiles, path: string, what: string): string {
  const text = files[path];
  if (text === undefined) fail(`There's no ${what} (${path}). The list tools show what there is.`);
  return text!;
}

function requireAdmin(ctx: McpContext): void {
  if (ctx.role === "agent") fail("Only owners and admins can change the agent. This token belongs to a teammate with the agent role.");
}

/** The latest saved files (or the built-in default before the first save). */
const latest = (ctx: McpContext) => loadConfigFiles(ctx.env, ctx.workspaceId);

const problemsText = (issues: ConfigIssue[]) => issues.map((i) => `- ${i.path || "(config)"}: ${i.message}`).join("\n");

/** Keys the desk has: Worker secrets and the ones pasted on the desk. */
async function keyNames(ctx: McpContext): Promise<{ worker: Set<string>; desk: Record<string, string> }> {
  const desk = (await ctx.env.WORKSPACE_HUB.getByName(ctx.workspaceId).actionSecrets()) as Record<string, string>;
  return { worker: new Set(workerSecretNames(ctx.env)), desk };
}

/** Warnings about the changed files, as the Agent page shows them (connections, action setup). Never blocks a save. */
async function warningsFor(ctx: McpContext, files: ConfigFiles, config: AgentConfig, changed: string[]): Promise<string[]> {
  const out: string[] = [];
  const links = agentLinks(files);
  const changedActions = new Set(changed.map((p) => ACTION_FILE.exec(p)?.[1]).filter((n): n is string => !!n));
  for (const path of changed) {
    const task = TASK_FILE.exec(path)?.[1];
    for (const name of task ? (links.procedureMissing[task] ?? []) : []) out.push(`${path} uses "${name}" as an action, but there's no actions/${name}.yaml.`);
  }
  const needsKeys = config.tools.some((t) => changedActions.has(t.name) && secretRefs(Object.values(t.headers)).length);
  const keys = needsKeys ? await keyNames(ctx) : null;
  for (const tool of config.tools.filter((t) => changedActions.has(t.name))) {
    for (const problem of actionSetupProblems(tool, (n) => !!keys && (keys.worker.has(n) || n in keys.desk))) out.push(`actions/${tool.name}: ${problem}${problem.includes("key") ? " Store it with set_key." : ""}`);
  }
  // A card's button that runs an action without one of its required inputs.
  const inputsOf = (name: string) => config.tools.find((t) => t.name === name)?.input ?? null;
  for (const widget of config.widgets) {
    const path = `widgets/${widget.name}.widget`;
    const touched = changed.includes(path) || (links.widgetRuns[widget.name] ?? []).some((a) => changedActions.has(a));
    if (!touched) continue;
    try {
      for (const b of toolButtonInputs(previewWidget(widget.name, files[path] ?? ""), inputsOf)) {
        for (const m of b.missing) out.push(`${path}: "${b.label}" runs ${b.tool} without its required input ${m.name}${m.like ? ` (the card has a field "${m.like}": rename it to ${m.name})` : ""}.`);
      }
    } catch {
      // no preview data: nothing to check
    }
  }
  return out;
}

interface Change {
  files: ConfigFiles;
  /** What was done, for the answer and the version's message ("add task refunds"). */
  summary: string;
  /** Files whose text the answer shows (dry runs show every changed file). */
  show?: string[];
  /** Extra lines for the answer. */
  notes?: string[];
}

/**
 * The one way the tools change the agent: the latest version, `change` applied, checked, saved as a
 * new version (unless dryRun), desk.yaml applied. A save that races another one is tried once more
 * on the newer version.
 */
async function commit(ctx: McpContext, args: Args, change: (files: ConfigFiles) => Change | Promise<Change>): Promise<ToolResult> {
  requireAdmin(ctx);
  for (let attempt = 0; ; attempt++) {
    const stored = await latest(ctx);
    const result = await change({ ...stored.files });
    const next = withCurrentPaths(result.files);
    const changed = changedPaths(stored.files, next);
    const notes = result.notes?.length ? `\n${result.notes.join("\n")}` : "";
    if (!changed.length) return done(`Nothing to change: ${result.summary} is already so (version ${stored.version ?? "default"}).${notes}`);
    const { config, issues } = parseConfig(next);
    if (issues.length) {
      const shown = changed.filter((p) => next[p] !== undefined).map((p) => block(p, next[p]!)).join("\n");
      return { isError: true, text: `Nothing was saved: the files have problems.\n${problemsText(issues)}\n\nThe changed file${changed.length === 1 ? "" : "s"} would be:\n${shown}` };
    }
    const warnings = await warningsFor(ctx, next, config, changed);
    const warned = warnings.length ? `\nWarnings (saved anyway):\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
    const changes = changed.map((p) => `${p} (${next[p] === undefined ? "deleted" : stored.files[p] === undefined ? "new" : "changed"})`).join(", ");
    if (args.dryRun === true) {
      const shown = changed.filter((p) => next[p] !== undefined).map((p) => block(p, next[p]!)).join("\n");
      return done(`Dry run, nothing saved: ${result.summary}. It would change ${changes}. No problems.${warned}${notes}\n\n${shown}`);
    }
    const message = (str(args, "message")?.trim() || `MCP: ${result.summary}`).slice(0, 500);
    let saved;
    try {
      saved = await saveConfig(ctx.env, ctx.workspaceId, { files: next, base: stored.version, message, source: "mcp", userId: ctx.user.id });
    } catch (error) {
      if (error instanceof ConfigConflictError && attempt === 0) continue;
      if (error instanceof ConfigConflictError) fail(`Someone else saved the agent at the same time. Nothing was saved; try again. (${error.message})`);
      throw error;
    }
    if (saved.version === null) return { isError: true, text: `Nothing was saved: the files have problems.\n${problemsText(saved.issues)}` };
    try {
      await applySavedDesk(ctx.env, ctx.workspaceId, saved.previous, saved.files);
    } catch (error) {
      fail(`Version ${saved.version} is saved, but desk.yaml couldn't be applied to the desk: ${(error as Error).message}`);
    }
    const shown = (result.show ?? []).filter((p) => saved.files[p] !== undefined).map((p) => block(p, saved.files[p]!)).join("\n");
    return done(`Saved version ${saved.version}, live now: ${result.summary}. Changed ${changes}.${warned}${notes}${shown ? `\n\n${shown}` : ""}`);
  }
}

// ---------- schemas ----------

const S = {
  string: (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra }),
  bool: (description: string): JsonSchema => ({ type: "boolean", description }),
  int: (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "integer", description, ...extra }),
  strings: (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description }),
  object: (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "object", description, ...extra }),
};
const SAVE = {
  message: S.string("The version's message in History (default: a line saying what this tool did)."),
  dryRun: S.bool("true: check and show the result without saving anything."),
};
const schema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const REMOVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// ---------- one line per item ----------

function taskLines(config: AgentConfig): string[] {
  return config.skills.map((s) => `- ${s.name}: ${s.description}${s.intent ? ` (intent: ${s.intent.name})` : ""}`);
}
function actionLine(t: ToolSpec, problems: string[] = []): string {
  const call = t.url ? `${t.method} ${t.url}` : "shows its widget only";
  return `- ${t.name}: ${t.description} [${call}${t.widget ? `; card: ${t.widget}` : ""}]${problems.length ? ` NOT READY: ${problems.join(" ")}` : ""}`;
}

async function actionProblems(ctx: McpContext, config: AgentConfig): Promise<Map<string, string[]>> {
  const keys = await keyNames(ctx);
  return new Map(config.tools.map((t) => [t.name, actionSetupProblems(t, (n) => keys.worker.has(n) || n in keys.desk)]));
}

// ---------- widgets: an outline of the rendered card ----------

const OUTLINE_PROPS = ["label", "value", "title", "name", "placeholder", "src", "size", "color"] as const;
function outline(root: WidgetNode, maxLines = 80): string {
  const lines: string[] = [];
  const walk = (node: WidgetNode, depth: number) => {
    if (lines.length >= maxLines) return;
    const props = OUTLINE_PROPS.filter((k) => node[k] !== undefined && typeof node[k] !== "object").map((k) => `${k}=${JSON.stringify(node[k]).slice(0, 60)}`);
    const action = isRecord(node.onClickAction) && typeof node.onClickAction.type === "string" ? ` -> ${node.onClickAction.type}` : "";
    lines.push(`${"  ".repeat(depth)}${node.type}${props.length ? ` ${props.join(" ")}` : ""}${action}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  if (lines.length >= maxLines) lines.push("  …");
  return lines.join("\n");
}

function controlLine(c: ReturnType<typeof cardControls>[number]): string {
  const d = c.does;
  const what = d.kind === "tool" ? `runs the action ${d.name}` : d.kind === "page" ? `runs the website action ${d.name}` : d.kind === "client" ? `goes to the website's own code (${d.type})` : d.kind === "link" ? "opens a link" : d.kind === "dismiss" ? "folds the card" : `sends "${d.type}" to the AI as the customer's choice`;
  return `- "${c.label}": ${what}`;
}

/** Builds a .widget file from typed fields; `base` is an existing file to change (fields left out stay). */
function widgetFile(base: string, args: Args): string {
  let text = base;
  const set = (key: string, value: unknown) => {
    text = withJsonKey(text, key, value === null ? undefined : value);
  };
  if (args.title !== undefined) set("name", args.title);
  if (args.template !== undefined) set("template", typeof args.template === "string" || args.template === null ? args.template : JSON.stringify(args.template));
  for (const key of ["summary", "sample", "jsonSchema", "states", "pageActions"] as const) if (args[key] !== undefined) set(key, args[key]);
  if (args.aiFill !== undefined) set("aiFill", args.aiFill === true ? true : null);
  return text;
}

// ---------- tests ----------

interface TestCaseArgs {
  name?: string;
  message?: string;
  messages?: string[];
  expect?: Record<string, unknown>;
  intent?: string;
  page?: string;
  actions?: unknown[];
}

function caseObject(args: Args): Record<string, unknown> {
  const out: Record<string, unknown> = { name: need(args, "name") };
  if (Array.isArray(args.messages) && args.messages.length) out.messages = args.messages;
  else out.message = need(args, "message");
  for (const key of ["intent", "page", "actions"] as const) if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
  out.expect = isRecord(args.expect) ? args.expect : {};
  return out;
}

function caseIndex(text: string, name: string): number {
  const data = readYaml(text);
  if (!Array.isArray(data)) fail("This tests file isn't a list of cases. Fix it with write_file.");
  const i = (data as unknown[]).findIndex((c) => isRecord(c) && c.name === name);
  if (i < 0) fail(`There's no case named "${name}" in this file. get_tests lists them.`);
  return i;
}

// ---------- desk.yaml ----------

/** Sections whose value is replaced whole (as desk.yaml's writer does). */
const WHOLE = new Set(["ai.models", "hours.days"]);
function mergeDesk(base: Record<string, unknown>, patch: Record<string, unknown>, path: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const at = [...path, key].join(".");
    out[key] = isRecord(value) && isRecord(out[key]) && !WHOLE.has(at) ? mergeDesk(out[key] as Record<string, unknown>, value, [...path, key]) : value;
  }
  return out;
}

async function deskText(ctx: McpContext, files: ConfigFiles): Promise<{ text: string; generated: boolean }> {
  const text = files[DESK_PATH];
  return text === undefined ? { text: await generatedDeskFile(ctx.env, ctx.workspaceId), generated: true } : { text, generated: false };
}

// ---------- test runs ----------

async function models(ctx: McpContext, jobs: ("answer" | "judge")[]) {
  const settings = await loadAiSettings(ctx.env, ctx.workspaceId);
  try {
    return jobs.map((job) => createModel(ctx.env, ctx.workspaceId, settings, job));
  } catch (error) {
    if (error instanceof AiUnavailableError) fail(`The AI isn't available: ${error.message}`);
    throw error;
  }
}

/** The latest files with `files` (path → text, or null to delete) laid over them: what to test before saving. */
function overlay(base: ConfigFiles, value: unknown): ConfigFiles {
  if (value === undefined) return base;
  if (!isRecord(value)) fail("files is an object of path → file text (null deletes a file).");
  const out = { ...base };
  for (const [path, text] of Object.entries(value as Record<string, unknown>)) {
    if (text === null) delete out[path];
    else if (typeof text === "string") out[path.replace(/\\/g, "/")] = text;
    else fail(`files["${path}"] must be the file's text or null.`);
  }
  return withCurrentPaths(out);
}

function replyText(reply: TestReply): string {
  const lines: string[] = [];
  if (reply.pressed?.done) lines.push(`(the card folds to: ${reply.pressed.done})`);
  if (reply.pressed?.failed) lines.push(`(the card opens again with: ${reply.pressed.failed})`);
  for (const call of reply.calls) lines.push(`(called ${call.tool}: ${call.status}${call.httpStatus ? ` ${call.httpStatus}` : ""}${call.pretended ? ", pretended: a change in safe mode" : ""}) ${call.output.slice(0, 300)}`);
  for (const w of reply.widgets) {
    lines.push(`(shows the card ${w.name}, widgetId ${w.id}: ${nodeText(w.root, 200)})`);
    for (const c of cardControls(w.root)) lines.push(`   ${controlLine(c).slice(2)}`);
  }
  if (reply.text) lines.push(reply.text);
  if (reply.pageAction) lines.push(`(asks to run the website action ${reply.pageAction.name} with ${JSON.stringify(reply.pageAction.input)})`);
  if (reply.escalate) lines.push(`(flags a problem for the engineers: ${reply.escalate})`);
  if (reply.handoff) lines.push(`(hands the chat to a person: ${reply.handoff})`);
  if (reply.sources?.length) lines.push(`(sources: ${reply.sources.map((s) => s.title).join(", ")})`);
  return lines.join("\n") || "(no reply)";
}

// ---------- the tools ----------

const tool = (t: Tool): Tool => t;

const GENERAL: Tool[] = [
  tool({
    name: "get_agent",
    title: "Get the agent",
    description: "The support agent at a glance: the live version, its tasks, actions, widgets and tests with one line each, the guardrails, and any problems. Start here.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const stored = await latest(ctx);
      const { config, issues } = parseConfig(stored.files);
      const problems = await actionProblems(ctx, config);
      const tests = Object.keys(stored.files).filter((p) => TEST_PATH.test(p));
      const out = [
        `Version ${stored.version ?? "none yet (the built-in default)"} is live. Workspace ${ctx.workspaceId}; you are ${ctx.user.name} (${ctx.role}).`,
        `Guardrails (instructions.md): maxReplies ${config.maxReplies}; handoffTopics: ${config.handoffTopics.join("; ") || "none"}.`,
        `Tasks (${config.skills.length}):`, ...taskLines(config),
        `Actions (${config.tools.length}):`, ...config.tools.map((t) => actionLine(t, problems.get(t.name))),
        `Widgets (${config.widgets.length}):`, ...config.widgets.map((w) => `- ${w.name}: ${w.title}${w.aiFill ? " (the AI may fill it in: aiFill)" : ""}`),
        `Tests: ${config.evals.length} case(s) in ${tests.join(", ") || "no files"}.`,
        `Website actions: ${Object.keys(config.websiteActionRisk).length + Object.keys(config.websiteActionStatus).length ? `set in ${WEBSITE_ACTIONS_PATH}` : "none set"}. Desk settings: ${DESK_PATH in stored.files ? "desk.yaml" : "no desk.yaml yet (get_desk_settings writes one from the desk)"}.`,
        issues.length ? `Problems:\n${problemsText(issues)}` : "No problems.",
        `Files: ${Object.keys(stored.files).sort().join(", ")}`,
      ];
      return done(out.join("\n"));
    },
  }),
  tool({
    name: "read_file",
    title: "Read a file",
    description: "One config file's text (instructions.md, tasks/<name>.md, actions/<name>.yaml, widgets/<name>.widget, tests/<name>.yaml, website-actions.yaml, desk.yaml), from the live version or an older one.",
    inputSchema: schema({ path: S.string("The file's path, like tasks/refunds.md."), version: S.int("An older version to read from (history lists them). Default: the live one.") }, ["path"]),
    annotations: READ,
    async run(ctx, args) {
      const path = need(args, "path");
      const version = typeof args.version === "number" ? args.version : undefined;
      const stored = await loadConfigFiles(ctx.env, ctx.workspaceId, version);
      if (version !== undefined && stored.version === null) fail(`There's no version ${version}.`);
      if (path === DESK_PATH && stored.files[DESK_PATH] === undefined && version === undefined) {
        return done(`desk.yaml isn't in the config yet; this is it written from the desk's current settings (saving it adds it):\n${block(path, await generatedDeskFile(ctx.env, ctx.workspaceId))}`);
      }
      return done(block(path, existing(stored.files, path, "such file")));
    },
  }),
  tool({
    name: "write_file",
    title: "Write a file",
    description: "Writes one config file whole (creates it or replaces it) and saves a new version. For changes the typed tools don't cover; prefer them, since they keep comments and other keys.",
    inputSchema: schema({ path: S.string("The file's path, like widgets/order_status.widget."), content: S.string("The whole file."), ...SAVE }, ["path", "content"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const path = withCurrentPaths({ [need(args, "path").replace(/\\/g, "/")]: "" });
        const p = Object.keys(path)[0];
        if (!p || !isConfigPath(p)) fail(`"${str(args, "path")}" isn't a config file. Allowed: instructions.md, desk.yaml, website-actions.yaml, tasks/<name>.md, actions/<name>.yaml, tests/<name>.yaml, widgets/<name>.widget.`);
        return { files: { ...files, [p!]: str(args, "content") ?? "" }, summary: `write ${p}` };
      }),
  }),
  tool({
    name: "delete_file",
    title: "Delete a file",
    description: "Deletes one config file and saves a new version. instructions.md can't be deleted.",
    inputSchema: schema({ path: S.string("The file's path."), ...SAVE }, ["path"]),
    annotations: REMOVE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const path = need(args, "path");
        if (path === INSTRUCTIONS_PATH) fail("instructions.md is required; change it with update_instructions instead.");
        existing(files, path, "such file");
        const next = { ...files };
        delete next[path];
        return { files: next, summary: `delete ${path}` };
      }),
  }),
  tool({
    name: "check",
    title: "Check files",
    description: "Checks files without saving: the live version with these files laid over it (null deletes one). Returns the problems the desk would refuse a save for, and warnings.",
    inputSchema: schema({ files: S.object("path → the whole file text, or null to delete it.", { additionalProperties: { type: ["string", "null"] } }) }, ["files"]),
    annotations: READ,
    async run(ctx, args) {
      const stored = await latest(ctx);
      const next = overlay(stored.files, args.files);
      const { config, issues } = parseConfig(next);
      const warnings = await warningsFor(ctx, next, config, changedPaths(stored.files, next));
      return done(
        `${issues.length ? `Problems (a save would be refused):\n${problemsText(issues)}` : "No problems: these files would save."}${warnings.length ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""}`,
      );
    },
  }),
  tool({
    name: "history",
    title: "Version history",
    description: "The agent's saved versions, newest first: who saved each, from where (desk, git, MCP), when, its message and the files it changed.",
    inputSchema: schema({ limit: S.int("How many versions (default 20, at most 50).", { minimum: 1, maximum: 50 }) }),
    annotations: READ,
    async run(ctx, args) {
      const versions = await listVersions(ctx.env, ctx.workspaceId, typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 50) : 20);
      if (!versions.length) return done("Nothing saved yet: the agent runs the built-in default.");
      const from = { dashboard: "the desk", cli: "git (jun push)", mcp: "an AI (MCP)" } as const;
      return done(
        versions
          .map((v) => `v${v.version} · ${from[v.source] ?? v.source} · ${v.createdBy ?? "someone"} · ${new Date(v.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC · ${v.message || "(no message)"}${v.changed ? ` · changed: ${v.changed.join(", ") || "nothing"}` : ""}`)
          .join("\n"),
      );
    },
  }),
  tool({
    name: "diff_versions",
    title: "Compare versions",
    description: "What changed between two versions, as a unified diff per file: from `from` to `to` (default: the live one). Without `from`, the version before `to`. `paths` limits it to some files.",
    inputSchema: schema({
      from: S.int("The older version (default: the one before `to`; 0: the built-in default).", { minimum: 0 }),
      to: S.int("The newer version (default: the live one).", { minimum: 1 }),
      paths: S.strings("Only these files, like tasks/refunds.md."),
    }),
    annotations: READ,
    async run(ctx, args) {
      const to = await loadConfigFiles(ctx.env, ctx.workspaceId, typeof args.to === "number" ? args.to : undefined);
      if (to.version === null) fail(typeof args.to === "number" ? `There's no version ${args.to}.` : "Nothing saved yet: the agent runs the built-in default.");
      const fromVersion = typeof args.from === "number" ? args.from : to.version! - 1;
      if (fromVersion >= to.version!) fail(`from (${fromVersion}) must be older than to (${to.version}).`);
      // Version 0 is the built-in default: there is no row for it, so loadConfigFiles answers with the default.
      const from = await loadConfigFiles(ctx.env, ctx.workspaceId, Math.max(fromVersion, 0));
      if (fromVersion >= 1 && from.version === null) fail(`There's no version ${fromVersion}.`);
      const only = Array.isArray(args.paths) ? new Set(args.paths.map(String)) : null;
      const paths = changedPaths(from.files, to.files).filter((p) => !only || only.has(p));
      const label = `v${fromVersion >= 1 ? fromVersion : "0 (the built-in default)"} → v${to.version}`;
      if (!paths.length) return done(`${label}: no changes${only ? " to those files" : ""}.`);
      const diffs = paths.map((p) => unifiedDiff(p, from.files[p] ?? null, to.files[p] ?? null)).filter(Boolean);
      const text = diffs.join("\n");
      const cut = text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… (cut at ${MAX_DIFF} characters: pass paths to see one file)` : text;
      return done(`${label}: ${plural(paths.length, "file")} changed (${paths.join(", ")}).\n${cut}`);
    },
  }),
  tool({
    name: "restore",
    title: "Restore a version",
    description: "Makes an older version live again, saved as a new version (nothing is lost; history keeps every version). With `paths`, brings back only those files and keeps the rest as they are now (a path the old version doesn't have is deleted).",
    inputSchema: schema({
      version: S.int("The version to bring back (history lists them).", { minimum: 1 }),
      paths: S.strings("Only these files, like tasks/refunds.md (default: every file)."),
      ...SAVE,
    }, ["version"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, async (files) => {
        const v = args.version as number;
        const old = await loadConfigFiles(ctx.env, ctx.workspaceId, v);
        if (old.version === null) fail(`There's no version ${v}.`);
        if (!Array.isArray(args.paths)) return { files: old.files, summary: `restore version ${v}` };
        const paths = [...new Set(args.paths.map(String))];
        if (!paths.length) fail("paths is empty: name the files to bring back, or leave it out for all of them.");
        const unknown = paths.filter((p) => old.files[p] === undefined && files[p] === undefined);
        if (unknown.length) fail(`Neither version ${v} nor the live one has ${unknown.join(", ")}.`);
        const next = { ...files };
        for (const p of paths) {
          if (old.files[p] === undefined) delete next[p];
          else next[p] = old.files[p]!;
        }
        return { files: next, summary: `restore ${paths.join(", ")} from version ${v}`, show: paths };
      }),
  }),
  tool({
    name: "connections",
    title: "Connections",
    description: "How the agent's parts use each other: which tasks use which actions, which action shows which widget, which widget buttons run which actions; and warnings for names used as actions that don't exist.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const { files } = await latest(ctx);
      const l = agentLinks(files);
      const { config } = parseConfig(files);
      const lines: string[] = [];
      for (const t of l.procedures) lines.push(`task ${t}: uses ${(l.procedureUses[t] ?? []).join(", ") || "no actions"}${l.procedureMissing[t]?.length ? `; WARNING: names ${l.procedureMissing[t]!.join(", ")} as actions, which don't exist` : ""}`);
      for (const a of l.actions) lines.push(`action ${a}: ${l.actionWidget[a] ? `shows its result as widget ${l.actionWidget[a]}; ` : ""}used by tasks ${(l.actionUsedBy[a] ?? []).join(", ") || "none"}; run by buttons of ${(l.actionRunFrom[a] ?? []).join(", ") || "no widgets"}`);
      for (const w of l.widgets) lines.push(`widget ${w}: shown by ${(l.widgetShownBy[w] ?? []).join(", ") || "no actions"}${config.widgets.find((x) => x.name === w)?.aiFill ? " and by the AI (aiFill)" : ""}; its buttons run ${(l.widgetRuns[w] ?? []).join(", ") || "no actions"}`);
      const warnings = await warningsFor(ctx, files, config, Object.keys(files));
      return done(`${lines.join("\n") || "Nothing yet."}${warnings.length ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""}`);
    },
  }),
];

const INSTRUCTIONS: Tool[] = [
  tool({
    name: "get_instructions",
    title: "Get the instructions",
    description: "instructions.md: how the support AI talks to customers (the body), and its guardrails (maxReplies, handoffTopics).",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const { files } = await latest(ctx);
      const { config } = parseConfig(files);
      return done(`maxReplies: ${config.maxReplies}\nhandoffTopics: ${config.handoffTopics.join("; ") || "none"}\n${block(INSTRUCTIONS_PATH, files[INSTRUCTIONS_PATH] ?? "")}`);
    },
  }),
  tool({
    name: "update_instructions",
    title: "Update the instructions",
    description: "Changes instructions.md: the body (persona, tone, rules: Markdown; @action_name names an action), and/or the guardrails. Only what you pass changes; comments stay.",
    inputSchema: schema({
      body: S.string("The new body (everything below the frontmatter), whole."),
      maxReplies: { type: ["integer", "null"], minimum: 1, maximum: 50, description: "AI replies per conversation before a person takes over (1-50). null: the default (8)." },
      handoffTopics: { type: ["array", "null"], items: { type: "string" }, description: "Topics always handed to a person, in plain words. null or []: none." },
      ...SAVE,
    }),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        let text = files[INSTRUCTIONS_PATH] ?? "";
        if (readFrontmatter(text).data === null) fail("instructions.md's frontmatter doesn't parse. Fix it with write_file.");
        const edits: Edit[] = [];
        if (args.maxReplies !== undefined) edits.push({ op: "set", path: ["maxReplies"], value: args.maxReplies });
        if (args.handoffTopics !== undefined) edits.push({ op: "set", path: ["handoffTopics"], value: args.handoffTopics });
        if (edits.length) text = editFrontmatter(text, ...edits);
        if (typeof args.body === "string") text = setBody(text, `${args.body.trim()}\n`);
        return { files: { ...files, [INSTRUCTIONS_PATH]: text }, summary: "update the instructions", show: [INSTRUCTIONS_PATH] };
      }),
  }),
];

const TASK_FIELDS: Record<string, JsonSchema> = {
  description: S.string("When this task applies, in a sentence (the AI picks tasks by it): 'The customer asks for a refund.'"),
  steps: { type: ["string", "array"], items: { type: "string" }, description: "The procedure: Markdown, or a list of steps (numbered for you). Name an action with @action_name. Before an action that changes something, say exactly what changes and wait for a clear yes." },
  intent: { type: ["string", "null"], description: "Optional: the intent name your app opens a chat for this task with (JunDesk.open({ intent })): lowercase letters, digits, _ or -." },
  opening: { type: ["string", "null"], description: "With intent: the chat's first line (one line)." },
  replies: { type: ["array", "null"], items: { type: "string" }, description: "With intent and opening: quick replies (at most 8)." },
  exit: { type: ["string", "null"], description: "With intent: the exit button's label, always on screen (like 'Cancel anyway')." },
};
const stepsText = (steps: unknown) => (Array.isArray(steps) ? steps.map((s, i) => `${i + 1}. ${String(s).trim()}`).join("\n") : String(steps).trim());

const TASKS: Tool[] = [
  tool({
    name: "list_tasks",
    title: "List tasks",
    description: "The agent's tasks (procedures for one job each), with when each applies.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const { config } = parseConfig((await latest(ctx)).files);
      return done(config.skills.length ? taskLines(config).join("\n") : "No tasks yet. create_task adds one.");
    },
  }),
  tool({
    name: "get_task",
    title: "Get a task",
    description: "One task's file (tasks/<name>.md): its description, intent fields and steps.",
    inputSchema: schema({ name: S.string("The task's name, like refunds.") }, ["name"]),
    annotations: READ,
    async run(ctx, args) {
      const name = taskName(args);
      return done(block(`tasks/${name}.md`, existing((await latest(ctx)).files, `tasks/${name}.md`, `task ${name}`)));
    },
  }),
  tool({
    name: "create_task",
    title: "Create a task",
    description: "Adds a task: a procedure for one job (refunds, plan changes…), in plain steps the AI follows.",
    inputSchema: schema({ name: S.string("File name: lowercase letters and digits joined by -, like refunds."), ...TASK_FIELDS, ...SAVE }, ["name", "description", "steps"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = taskName(args);
        const path = `tasks/${name}.md`;
        if (files[path] !== undefined) fail(`There's already a task ${name}. update_task changes it.`);
        const front: Record<string, unknown> = { description: need(args, "description") };
        for (const key of ["intent", "opening", "replies", "exit"] as const) if (args[key] !== undefined && args[key] !== null) front[key] = args[key];
        const text = `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${stepsText(args.steps)}\n`;
        return { files: { ...files, [path]: text }, summary: `add task ${name}`, show: [path] };
      }),
  }),
  tool({
    name: "update_task",
    title: "Update a task",
    description: "Changes a task: only the fields you pass (null removes an intent field); comments stay.",
    inputSchema: schema({ name: S.string("The task's name."), ...TASK_FIELDS, ...SAVE }, ["name"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = taskName(args);
        const path = `tasks/${name}.md`;
        let text = existing(files, path, `task ${name}`);
        if (readFrontmatter(text).data === null) fail(`${path}'s frontmatter doesn't parse. Fix it with write_file.`);
        const edits: Edit[] = (["description", "intent", "opening", "replies", "exit"] as const).filter((k) => args[k] !== undefined).map((k) => ({ op: "set", path: [k], value: args[k] }));
        if (edits.length) text = editFrontmatter(text, ...edits);
        if (args.steps !== undefined) text = setBody(text, `${stepsText(args.steps)}\n`);
        return { files: { ...files, [path]: text }, summary: `update task ${name}`, show: [path] };
      }),
  }),
  tool({
    name: "delete_task",
    title: "Delete a task",
    description: "Deletes a task.",
    inputSchema: schema({ name: S.string("The task's name."), ...SAVE }, ["name"]),
    annotations: REMOVE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = taskName(args);
        existing(files, `tasks/${name}.md`, `task ${name}`);
        const next = { ...files };
        delete next[`tasks/${name}.md`];
        return { files: next, summary: `delete task ${name}` };
      }),
  }),
  tool({
    name: "task_uses",
    title: "What a task uses",
    description: "What a task's steps use: its actions (and whether each is set up), the cards they show and what each card's buttons do, and names used as actions that don't exist.",
    inputSchema: schema({ name: S.string("The task's name.") }, ["name"]),
    annotations: READ,
    async run(ctx, args) {
      const name = taskName(args);
      const { files } = await latest(ctx);
      existing(files, `tasks/${name}.md`, `task ${name}`);
      const links = agentLinks(files);
      const { config } = parseConfig(files);
      const problems = await actionProblems(ctx, config);
      const lines: string[] = [];
      const uses = links.procedureUses[name] ?? [];
      for (const a of uses) {
        const spec = config.tools.find((t) => t.name === a);
        lines.push(spec ? actionLine(spec, problems.get(a)) : `- ${a}: has problems (get_action shows them)`);
        const widget = spec?.widget ? config.widgets.find((w) => w.name === spec.widget) : undefined;
        if (widget?.sample) {
          lines.push(`  shows the card ${widget.name}:`);
          try {
            for (const c of cardControls(renderWidget(widget, widget.sample))) lines.push(`    ${controlLine(c)}`);
          } catch {
            // its problem shows on the widget
          }
        }
      }
      if (/@show_widget\b/.test(files[`tasks/${name}.md`] ?? "")) lines.push(`- show_widget: the AI's own tool, for cards with aiFill: ${config.widgets.filter((w) => w.aiFill).map((w) => w.name).join(", ") || "none yet"}`);
      for (const m of links.procedureMissing[name] ?? []) lines.push(`- WARNING: "${m}" is used as an action, but there's no actions/${m}.yaml (create_action or action_from_curl adds it).`);
      return done(lines.length ? lines.join("\n") : "Its steps use no actions.");
    },
  }),
];

const ACTION_FIELDS: Record<string, JsonSchema> = {
  description: S.string("What it returns or does, and when the AI should use it. The AI decides from this."),
  status: { type: ["string", "null"], description: "The one line the customer sees while it runs (≤ 60 characters, no placeholders), like 'Checking your order'." },
  method: { type: "string", enum: ["GET", "POST"], description: "GET (default) or POST (a change)." },
  url: S.string("https://… with {input} placeholders, like https://api.acme.com/orders/{order_id}. Leave out only for an action that just shows its widget."),
  headers: { type: ["object", "null"], additionalProperties: { type: "string" }, description: "Headers. Keys go here as {secrets.NAME} (store the value with set_key); never a key itself." },
  query: { type: ["object", "null"], additionalProperties: { type: "string" }, description: "Query parameters, with placeholders." },
  body: { description: "POST only: the JSON body. A value that is exactly \"{name}\" keeps the input's type. Without it, a POST sends the inputs." },
  input: { type: ["object", "null"], description: "What the AI asks the customer for: name → { type: string|number|integer|boolean, description, required (default true), enum }." },
  pick: { type: ["array", "null"], items: { type: "string" }, description: "Only these top-level response fields reach the AI." },
  mock: { description: "A canned response for test runs with mockTools." },
  pages: { type: ["array", "null"], items: { type: "string" }, description: "Offer it only on these page paths, like /orders/*." },
  widget: { type: ["string", "null"], description: "Show a successful result as this widget (widgets/<name>.widget)." },
  widget_done: { type: ["string", "null"], description: "When a card's button ran it: the line the card folds to (Jinja over the entered values and the result)." },
  widget_failed: { type: ["string", "null"], description: "When a card's button ran it and it failed: the line the card shows." },
};
const ACTION_KEYS = Object.keys(ACTION_FIELDS);

const ACTIONS: Tool[] = [
  tool({
    name: "list_actions",
    title: "List actions",
    description: "The agent's actions (HTTP requests it may make), with what each calls and whether it's ready (keys added, a real address).",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const { config } = parseConfig((await latest(ctx)).files);
      const problems = await actionProblems(ctx, config);
      return done(config.tools.length ? config.tools.map((t) => actionLine(t, problems.get(t.name))).join("\n") : "No actions yet. create_action or action_from_curl adds one.");
    },
  }),
  tool({
    name: "get_action",
    title: "Get an action",
    description: "One action's file (actions/<name>.yaml), whether it's set up, and what uses it.",
    inputSchema: schema({ name: S.string("The action's name.") }, ["name"]),
    annotations: READ,
    async run(ctx, args) {
      const name = actionName(args);
      const { files } = await latest(ctx);
      const path = actionPath(files, name);
      const text = existing(files, path, `action ${name}`);
      const { config, issues } = parseConfig(files);
      const spec = config.tools.find((t) => t.name === name);
      const links = agentLinks(files);
      const problems = spec ? (await actionProblems(ctx, config)).get(name) ?? [] : issues.filter((i) => i.path === path).map((i) => i.message);
      return done(
        `${problems.length ? `Not ready: ${problems.join(" ")}` : "Ready."}\nUsed by tasks: ${(links.actionUsedBy[name] ?? []).join(", ") || "none"}; run by buttons of: ${(links.actionRunFrom[name] ?? []).join(", ") || "no widgets"}.\n${block(path, text)}`,
      );
    },
  }),
  tool({
    name: "create_action",
    title: "Create an action",
    description: "Adds an action: one HTTP request the AI may make (look up an order, change a plan…). Put keys in headers as {secrets.NAME} and store them with set_key.",
    inputSchema: schema({ name: S.string("File name: a lowercase letter, then lowercase letters, digits and _, like lookup_order."), ...ACTION_FIELDS, ...SAVE }, ["name", "description"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = actionName(args);
        const path = actionPath(files, name);
        if (files[path] !== undefined) fail(`There's already an action ${name}. update_action changes it.`);
        const data: Record<string, unknown> = {};
        for (const key of ACTION_KEYS) if (args[key] !== undefined && args[key] !== null) data[key] = args[key];
        return { files: { ...files, [path]: stringify(data, { lineWidth: 0 }) }, summary: `add action ${name}`, show: [path] };
      }),
  }),
  tool({
    name: "action_from_curl",
    title: "Action from a curl command",
    description: "Adds an action from a curl command (from the company's API docs), like the desk's New action: method, address, query, headers and body. Keys in it are stored on the desk (write-only) and the file gets {secrets.NAME}. Turn the values that change per customer into {placeholders} with update_action afterwards.",
    inputSchema: schema({
      curl: S.string("The curl command."),
      description: S.string("What it returns or does, and when the AI should use it."),
      name: S.string("File name (default: from the address, like look_up_order)."),
      status: S.string("The line the customer sees while it runs (default 'Working on it')."),
      ...SAVE,
    }, ["curl", "description"]),
    annotations: WRITE,
    async run(ctx, args) {
      let req;
      try {
        req = parseCurl(need(args, "curl"));
      } catch (error) {
        fail((error as Error).message);
      }
      const request = req!;
      const name = str(args, "name") ? actionName(args) : curlActionName(request);
      if (!ACTION_NAME.test(name)) fail(`Pass a name: "${name}" isn't an action name.`);
      const stored: string[] = [];
      const missing: string[] = [];
      const result = await commit(ctx, args, (files) => {
        const path = actionPath(files, name);
        if (files[path] !== undefined) fail(`There's already an action ${name}. Pass another name.`);
        const text = curlActionFile(request, { description: need(args, "description"), ...(str(args, "status") ? { status: str(args, "status")! } : {}) });
        return { files: { ...files, [path]: text }, summary: `add action ${name} from a curl command`, show: [path], notes: request.notes.map((n) => `Note: ${n}`) };
      });
      if (result.isError || args.dryRun === true) return result;
      // Its keys, kept on the desk (a key already there keeps its value), as the desk's New action does.
      const hub = ctx.env.WORKSPACE_HUB.getByName(ctx.workspaceId);
      const desk = (await hub.actionSecrets()) as Record<string, string>;
      const worker = new Set(workerSecretNames(ctx.env));
      for (const key of request.keys) {
        if (worker.has(key.name) || key.name in desk) continue;
        if (!key.value) missing.push(key.name);
        else if (Object.keys(desk).length + stored.length < MAX_DESK_SECRETS) {
          await hub.setActionSecret(key.name, key.value.slice(0, MAX_SECRET_VALUE));
          stored.push(key.name);
        } else missing.push(key.name);
      }
      const keys = [
        stored.length ? `Stored the key${stored.length === 1 ? "" : "s"} ${stored.join(", ")} on the desk (write-only; the file says {secrets.NAME}).` : "",
        missing.length ? `The command had a stand-in for ${missing.join(", ")}: store the real key${missing.length === 1 ? "" : "s"} with set_key.` : "",
      ].filter(Boolean);
      return { text: `${result.text}${keys.length ? `\n${keys.join("\n")}` : ""}` };
    },
  }),
  tool({
    name: "update_action",
    title: "Update an action",
    description: "Changes an action: only the fields you pass (null removes one); comments and other keys stay. A map (headers, query, input) is replaced whole.",
    inputSchema: schema({ name: S.string("The action's name."), ...ACTION_FIELDS, ...SAVE }, ["name"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = actionName(args);
        const path = actionPath(files, name);
        const text = existing(files, path, `action ${name}`);
        if (readYaml(text) === null) fail(`${path} doesn't parse as YAML. Fix it with write_file.`);
        const edits: Edit[] = ACTION_KEYS.filter((k) => args[k] !== undefined).map((k) => ({ op: "set", path: [k], value: args[k] }));
        return { files: { ...files, [path]: editYaml(text, ...edits) }, summary: `update action ${name}`, show: [path] };
      }),
  }),
  tool({
    name: "delete_action",
    title: "Delete an action",
    description: "Deletes an action. Tasks that mention it are reported in the warnings.",
    inputSchema: schema({ name: S.string("The action's name."), ...SAVE }, ["name"]),
    annotations: REMOVE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = actionName(args);
        const path = actionPath(files, name);
        existing(files, path, `action ${name}`);
        const next = { ...files };
        delete next[path];
        const users = agentLinks(files).actionUsedBy[name] ?? [];
        return { files: next, summary: `delete action ${name}`, notes: users.length ? [`Tasks that mention it: ${users.join(", ")}. Update their steps.`] : [] };
      }),
  }),
  tool({
    name: "try_action",
    title: "Try an action",
    description: "Calls one action once for real, with the inputs you give (like Try it on the desk). A POST really makes its change. Uses the live version, or `file` (an unsaved actions/<name>.yaml) to try a change first. Nothing is saved.",
    inputSchema: schema({
      name: S.string("The action's name."),
      input: S.object("The inputs, name → value."),
      customer: S.object("A test customer for {user.*}: { id, email, name, attributes: {…}, secrets: {…} }."),
      file: S.string("Optional: an unsaved version of the action's file to try instead."),
    }, ["name"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async run(ctx, args) {
      requireAdmin(ctx);
      const name = actionName(args);
      const { files } = await latest(ctx);
      const draft = typeof args.file === "string" ? { ...files, [actionPath(files, name)]: args.file } : files;
      const { config, issues } = parseConfig(draft);
      const spec = config.tools.find((t) => t.name === name);
      if (!spec) {
        const problem = issues.find((i) => i.path === actionPath(draft, name));
        fail(problem ? `Fix this first: ${problem.message}` : `There's no action ${name}.`);
      }
      const secrets = await loadToolSecrets(ctx.env, ctx.workspaceId);
      const { action, result } = await runTool(spec!, isRecord(args.input) ? args.input : {}, { secrets, user: testCustomer(args.customer), widgets: config.widgets }, "mcptry");
      const card = action.status === "ok" && result !== undefined && !spec!.widget && cardFromResult(humanize(name), result) ? `\nThe result is JSON: widget_from_data can make a card for it (attachTo: "${name}").` : "";
      return {
        isError: action.status !== "ok",
        text: `${action.status === "ok" ? "OK" : "Failed"}${action.httpStatus ? ` (HTTP ${action.httpStatus})` : ""} in ${action.durationMs} ms.${action.widget?.error ? ` Its widget didn't draw: ${action.widget.error}` : ""}\nWhat the AI reads (keys masked):\n${action.output}${card}`,
      };
    },
  }),
  tool({
    name: "action_status",
    title: "Action status",
    description: "Whether each action (or one) is ready to be offered to the AI, and what's missing; plus the keys the desk has (names only, with the last 4 characters of a pasted one).",
    inputSchema: schema({ name: S.string("One action's name (default: all).") }),
    annotations: READ,
    async run(ctx, args) {
      const { config } = parseConfig((await latest(ctx)).files);
      const keys = await keyNames(ctx);
      const name = str(args, "name");
      const tools = name ? config.tools.filter((t) => t.name === name) : config.tools;
      if (name && !tools.length) fail(`There's no working action ${name} (get_action shows its problems).`);
      const lines = tools.map((t) => {
        const problems = actionSetupProblems(t, (n) => keys.worker.has(n) || n in keys.desk);
        return `- ${t.name}: ${problems.length ? `not offered to the AI: ${problems.join(" ")}` : "ready"}`;
      });
      const names = [...new Set([...keys.worker, ...Object.keys(keys.desk)])].sort();
      const keyLines = names.map((n) => (keys.worker.has(n) ? `- ${n}: a Worker secret (JUN_SECRET_${n})` : `- ${n}: stored on the desk, ends in ${keys.desk[n]!.slice(-4)}`));
      return done(`${lines.join("\n") || "No actions."}\nKeys:\n${keyLines.join("\n") || "- none"}`);
    },
  }),
  tool({
    name: "set_key",
    title: "Set a key",
    description: "Stores a key an action uses as {secrets.NAME} on the desk (or removes it). Write-only: no tool ever returns its value. A Worker secret JUN_SECRET_<NAME> of the same name wins.",
    inputSchema: schema({ name: S.string("UPPER_SNAKE_CASE, like ACME_API_KEY."), value: S.string("The key itself."), remove: S.bool("true: remove the stored key instead.") }, ["name"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run(ctx, args) {
      requireAdmin(ctx);
      const name = need(args, "name");
      if (!SECRET_NAME.test(name)) fail("Key names are UPPER_SNAKE_CASE, like API_KEY.");
      const hub = ctx.env.WORKSPACE_HUB.getByName(ctx.workspaceId);
      if (args.remove === true) {
        await hub.setActionSecret(name, null);
        return done(`Removed the stored key ${name}.`);
      }
      const value = str(args, "value")?.trim() ?? "";
      if (!value) fail("Pass the key as value (or remove: true).");
      if (value.length > MAX_SECRET_VALUE) fail(`A key is at most ${MAX_SECRET_VALUE} characters.`);
      const desk = (await hub.actionSecrets()) as Record<string, string>;
      if (!(name in desk) && Object.keys(desk).length >= MAX_DESK_SECRETS) fail(`At most ${MAX_DESK_SECRETS} keys. Remove one you no longer use.`);
      await hub.setActionSecret(name, value);
      const worker = workerSecretNames(ctx.env).includes(name);
      return done(`Stored ${name} (ends in ${value.slice(-4)}).${worker ? ` Note: the Worker secret JUN_SECRET_${name} is set too, and it wins.` : ""} Actions use it as {secrets.${name}} in a header.`);
    },
  }),
];

const WIDGET_FIELDS: Record<string, JsonSchema> = {
  title: S.string("The card's title on the desk (the file's name key)."),
  template: { type: ["string", "object"], description: "A Jinja template that renders the ChatKit component tree as JSON (values with | tojson); or the tree itself as an object for a fixed card. See jun://guide/chatkit-widgets." },
  sample: { type: ["object", "null"], description: "Example data the template must render with (the action's JSON result)." },
  jsonSchema: { type: ["object", "null"], description: "The data's JSON Schema; sample and states must fit it." },
  summary: { type: ["string", "null"], description: "One-line Jinja template for the folded chat (≤ 200 characters)." },
  states: { type: ["array", "null"], items: { type: "object" }, description: "Named examples: [{ name, data }] (at most 10)." },
  aiFill: S.bool("true: the AI may show this card with data it fills in (show_widget; needs sample)."),
  pageActions: { type: ["array", "null"], items: { type: "string" }, description: "Website actions whose result this card shows." },
};

const WIDGETS: Tool[] = [
  tool({
    name: "list_widgets",
    title: "List widgets",
    description: "The agent's widgets (cards a result is shown as), with what shows each and what its buttons run.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const { files } = await latest(ctx);
      const { config } = parseConfig(files);
      const links = agentLinks(files);
      return done(
        config.widgets.map((w) => `- ${w.name}: ${w.title}; shown by ${(links.widgetShownBy[w.name] ?? []).join(", ") || "no action"}${w.aiFill ? " and the AI (aiFill)" : ""}; buttons run ${(links.widgetRuns[w.name] ?? []).join(", ") || "no actions"}`).join("\n") ||
          "No widgets yet. create_widget (fromTemplate: widget_templates lists them) or widget_from_data adds one.",
      );
    },
  }),
  tool({
    name: "get_widget",
    title: "Get a widget",
    description: "One widget's file (widgets/<name>.widget, ChatKit widget JSON), its parameters and what its controls do.",
    inputSchema: schema({ name: S.string("The widget's name.") }, ["name"]),
    annotations: READ,
    async run(ctx, args) {
      const name = widgetName(args);
      const path = `widgets/${name}.widget`;
      const text = existing((await latest(ctx)).files, path, `widget ${name}`);
      const lines: string[] = [];
      try {
        const spec = parseWidgetFile(name, text);
        const s = widgetSchema(spec);
        if (s) lines.push(`Parameters:\n${schemaParams(s).map((p) => `- ${p.path}: ${p.type}${p.required ? ", required" : ""}${p.description ? ` (${p.description})` : ""}`).join("\n")}`);
        if (spec.sample) lines.push(`Controls:\n${cardControls(renderWidget(spec, spec.sample)).map(controlLine).join("\n") || "- none"}`);
      } catch (error) {
        lines.push(`Problem: ${(error as Error).message}`);
      }
      return done(`${lines.join("\n")}\n${block(path, text)}`);
    },
  }),
  tool({
    name: "create_widget",
    title: "Create a widget",
    description: "Adds a widget (a card). Start from a gallery template (fromTemplate; widget_templates lists them), or pass a template and sample, or nothing for a starter card. Show it from an action with update_action widget: <name>.",
    inputSchema: schema({ name: S.string("File name: a lowercase letter, then lowercase letters, digits, _ and -."), fromTemplate: S.string("A gallery template's id, like flight_tracker."), ...WIDGET_FIELDS, ...SAVE }, ["name"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = widgetName(args);
        const path = `widgets/${name}.widget`;
        if (files[path] !== undefined) fail(`There's already a widget ${name}. update_widget changes it.`);
        let base: string;
        if (str(args, "fromTemplate")) {
          const t = WIDGET_TEMPLATES.find((x) => x.id === args.fromTemplate);
          if (!t) fail(`There's no template "${String(args.fromTemplate)}". widget_templates lists them.`);
          base = t!.file;
        } else if (args.template !== undefined) base = `${JSON.stringify({ version: "1.0", name: humanize(name) }, null, 2)}\n`;
        else base = starterWidget(humanize(name));
        return { files: { ...files, [path]: widgetFile(base, args) }, summary: `add widget ${name}`, show: args.dryRun === true ? [path] : [] };
      }),
  }),
  tool({
    name: "update_widget",
    title: "Update a widget",
    description: "Changes a widget's fields (null removes one); other keys stay.",
    inputSchema: schema({ name: S.string("The widget's name."), ...WIDGET_FIELDS, ...SAVE }, ["name"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = widgetName(args);
        const path = `widgets/${name}.widget`;
        const text = existing(files, path, `widget ${name}`);
        return { files: { ...files, [path]: widgetFile(text, args) }, summary: `update widget ${name}` };
      }),
  }),
  tool({
    name: "delete_widget",
    title: "Delete a widget",
    description: "Deletes a widget. An action that shows it must drop its widget: first (the save is refused otherwise).",
    inputSchema: schema({ name: S.string("The widget's name."), ...SAVE }, ["name"]),
    annotations: REMOVE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = widgetName(args);
        existing(files, `widgets/${name}.widget`, `widget ${name}`);
        const next = { ...files };
        delete next[`widgets/${name}.widget`];
        return { files: next, summary: `delete widget ${name}` };
      }),
  }),
  tool({
    name: "widget_templates",
    title: "Widget templates",
    description: "ChatKit Studio's gallery of ready cards (flight tracker, events, purchases, charts…): id, name, what it shows and its data's parameters. create_widget fromTemplate copies one.",
    inputSchema: schema({}),
    annotations: READ,
    async run() {
      return done(
        WIDGET_TEMPLATES.map((t) => {
          let params = "";
          try {
            const s = widgetSchema(parseWidgetFile(t.id, t.file));
            params = s ? schemaParams(s).filter((p) => !p.path.includes(".") && !p.path.includes("[")).map((p) => p.path).join(", ") : "";
          } catch {
            // listed anyway
          }
          return `- ${t.id}: ${t.name}. ${t.description}${params ? ` Data: ${params}.` : ""}`;
        }).join("\n"),
      );
    },
  }),
  tool({
    name: "get_widget_template",
    title: "Get a widget template",
    description: "One gallery template's whole .widget file.",
    inputSchema: schema({ id: S.string("The template's id, like ride_status.") }, ["id"]),
    annotations: READ,
    async run(_ctx, args) {
      const t = WIDGET_TEMPLATES.find((x) => x.id === args.id);
      if (!t) fail(`There's no template "${String(args.id)}". widget_templates lists them.`);
      return done(block(`${t!.id}.widget`, t!.file));
    },
  }),
  tool({
    name: "preview_widget",
    title: "Preview a widget",
    description: "Renders a widget through the desk's renderer with its sample (or a named state, or data you pass): a picture of the card as customers see it, problems, an outline of the card, what each control does, and a link to see it on the desk. Look at the picture before you call a card done.",
    inputSchema: schema({
      name: S.string("A saved widget's name (or the name for `file`)."),
      file: S.string("Optional: an unsaved .widget file to render instead."),
      state: S.string("A named state to render (states in the file)."),
      data: S.object("Data to render with instead of the sample."),
      theme: S.string("The chat's theme to draw it in (default light).", { enum: ["light", "dark"] }),
    }),
    annotations: READ,
    async run(ctx, args) {
      const name = str(args, "name") ? widgetName(args) : "preview";
      const { files } = await latest(ctx);
      const text = typeof args.file === "string" ? args.file : existing(files, `widgets/${name}.widget`, `widget ${name}`);
      const problems: string[] = [];
      let spec;
      try {
        spec = parseWidgetFile(name, text);
      } catch (error) {
        return { isError: true, text: `Problem: ${(error as Error).message}` };
      }
      try {
        checkExamples(spec);
      } catch (error) {
        problems.push((error as Error).message);
      }
      const state = str(args, "state");
      const named = state ? spec.states?.find((s) => s.name === state) : undefined;
      if (state && !named) problems.push(`There's no state "${state}" (states: ${spec.states?.map((s) => s.name).join(", ") || "none"}).`);
      const data = isRecord(args.data) ? args.data : named?.data ?? spec.sample;
      let root: WidgetNode | null = null;
      try {
        root = data ? renderWidget(spec, data) : previewWidget(name, text);
      } catch (error) {
        problems.push((error as Error).message);
      }
      let summaryLine = "";
      try {
        summaryLine = data ? renderSummary(spec, data) : "";
      } catch (error) {
        problems.push(`summary: ${(error as Error).message}`);
      }
      const { config } = parseConfig(files);
      const inputsOf = (n: string) => config.tools.find((t) => t.name === n)?.input ?? null;
      const missing = root ? toolButtonInputs(root, inputsOf).flatMap((b) => b.missing.map((m) => `"${b.label}" runs ${b.tool} without its required input ${m.name}.`)) : [];
      const saved = files[`widgets/${name}.widget`] !== undefined;
      const theme = args.theme === "dark" ? "dark" : "light";
      const shot: ShotResult | null = root ? await screenshot(ctx.env, ctx.origin, { kind: "card", name, root, theme }, { width: 380, height: 1200, selector: ".shot-card" }) : null;
      return {
        isError: problems.length > 0,
        ...(shot && "image" in shot ? { images: [shot.image] } : {}),
        text: [
          problems.length ? `Problems:\n${problems.map((p) => `- ${p}`).join("\n")}` : "No problems.",
          shot && "image" in shot ? `The picture shows it in the ${theme} theme, at the chat window's width.` : shot ? `No picture: ${shot.skipped}.` : "",
          ...missing.map((m) => `Warning: ${m}`),
          summaryLine ? `Folded line: ${summaryLine}` : "",
          root ? `Card:\n${outline(root)}` : "",
          root ? `Controls:\n${cardControls(root).map(controlLine).join("\n") || "- none"}` : "",
          saved ? `See it on the desk: ${ctx.origin}/agent/widgets/${name}${typeof args.file === "string" ? " (shows the saved version)" : ""}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  }),
  tool({
    name: "widget_from_data",
    title: "Widget from data",
    description: "Makes a first card from an example of the data it shows: a JSON result (data), or a website action's result shape (websiteAction). Optionally shows it from an action (attachTo).",
    inputSchema: schema({
      name: S.string("The new widget's name."),
      title: S.string("The card's title (default: from the name)."),
      data: S.object("An example JSON result, like try_action returns."),
      websiteAction: S.string("A website action's name (website_actions lists them with their result shapes)."),
      attachTo: S.string("An action that should show its result as this card (sets its widget:)."),
      ...SAVE,
    }, ["name"]),
    annotations: WRITE,
    async run(ctx, args) {
      const name = widgetName(args);
      const title = str(args, "title") ?? humanize(name);
      let file: string | null = null;
      if (isRecord(args.data)) file = cardFromResult(title, args.data);
      else if (str(args, "websiteAction")) {
        const seen = ((await ctx.env.WORKSPACE_HUB.getByName(ctx.workspaceId).pageActions()) as SeenPageAction[]).find((a) => a.name === args.websiteAction);
        if (!seen) fail(`The desk hasn't seen a website action ${String(args.websiteAction)}. website_actions lists them.`);
        if (!seen!.shape) fail(`${seen!.name} hasn't returned a JSON result on the site yet, so its shape isn't known. Pass data instead.`);
        file = cardFromShape(title, seen!.name, seen!.shape!);
      } else fail("Pass data (an example result) or websiteAction.");
      if (!file) fail("That data has no fields to show (it needs a JSON object or a list of them).");
      const attach = str(args, "attachTo") ? actionName(args, "attachTo") : null;
      return commit(ctx, args, (files) => {
        const path = `widgets/${name}.widget`;
        if (files[path] !== undefined) fail(`There's already a widget ${name}.`);
        const next = { ...files, [path]: file! };
        if (attach) {
          const ap = actionPath(files, attach);
          next[ap] = editYaml(existing(files, ap, `action ${attach}`), { op: "set", path: ["widget"], value: name });
        }
        return { files: next, summary: `add widget ${name}${attach ? ` shown by ${attach}` : ""}`, show: [path] };
      });
    },
  }),
];

const CASE_FIELDS: Record<string, JsonSchema> = {
  message: S.string("The customer's message."),
  messages: S.strings("Or several messages, one per turn."),
  expect: S.object("What a good reply does: { outcome: answer|handoff|escalate|action, tools: [action names it must call], criteria: 'a sentence a judge checks', action: name or { name, input }, widget: name }."),
  intent: S.string("Run the case as a chat opened with this intent."),
  page: S.string("The page path the customer is on, like /pricing."),
  actions: { type: "array", items: { type: "object" }, description: "Website actions on the page: [{ name, description, inputSchema, risk, mock }]." },
};

const TESTS: Tool[] = [
  tool({
    name: "list_tests",
    title: "List tests",
    description: "The agent's test cases (tests/*.yaml): file, name, the customer's message and what's expected.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const { config } = parseConfig((await latest(ctx)).files);
      return done(config.evals.map((c) => `- ${c.file} · ${c.name}: "${c.messages.join(" / ").slice(0, 120)}" expects ${JSON.stringify(c.expect)}`).join("\n") || "No test cases yet. add_test_case adds one.");
    },
  }),
  tool({
    name: "get_tests",
    title: "Get a tests file",
    description: "A tests file's text (tests/<file>.yaml); without file, all of them.",
    inputSchema: schema({ file: S.string("The file's name without tests/ and .yaml, like basics.") }),
    annotations: READ,
    async run(ctx, args) {
      const { files } = await latest(ctx);
      const file = str(args, "file");
      const paths = file ? [testPath(files, file)] : Object.keys(files).filter((p) => TEST_PATH.test(p)).sort();
      if (!paths.length) return done("No tests files yet.");
      return done(paths.map((p) => block(p, existing(files, p, "tests file"))).join("\n"));
    },
  }),
  tool({
    name: "add_test_case",
    title: "Add a test case",
    description: "Adds a test case to tests/<file>.yaml (created if needed): a customer message and what a good reply does.",
    inputSchema: schema({ file: S.string("The tests file (default: basics)."), name: S.string("The case's name, unique in the file."), ...CASE_FIELDS, ...SAVE }, ["name"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const file = str(args, "file")?.trim() || "basics";
        if (!TEST_FILE.test(file)) fail("file is letters, digits, _ and -, like basics.");
        const path = testPath(files, file);
        const item = caseObject(args);
        const text = files[path];
        if (text === undefined || !text.trim()) return { files: { ...files, [path]: stringify([item], { lineWidth: 0 }) }, summary: `add test case "${item.name}"` };
        const data = readYaml(text);
        if (!Array.isArray(data)) fail(`${path} isn't a list of cases. Fix it with write_file.`);
        if ((data as unknown[]).some((c) => isRecord(c) && c.name === item.name)) fail(`${path} already has a case named "${String(item.name)}". update_test_case changes it.`);
        return { files: { ...files, [path]: editYaml(text, { op: "push", path: [], value: item }) }, summary: `add test case "${String(item.name)}"` };
      }),
  }),
  tool({
    name: "update_test_case",
    title: "Update a test case",
    description: "Changes a test case's fields (only those you pass; null removes one).",
    inputSchema: schema({ file: S.string("The tests file (default: basics)."), name: S.string("The case's name."), newName: S.string("A new name."), ...CASE_FIELDS, ...SAVE }, ["name"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const path = testPath(files, str(args, "file")?.trim() || "basics");
        const text = existing(files, path, "tests file");
        const name = need(args, "name");
        const i = caseIndex(text, name);
        const edits: Edit[] = [];
        if (str(args, "newName")) edits.push({ op: "set", path: [i, "name"], value: args.newName });
        if (args.message !== undefined) edits.push({ op: "set", path: [i, "message"], value: args.message }, { op: "set", path: [i, "messages"], value: null });
        if (args.messages !== undefined) edits.push({ op: "set", path: [i, "messages"], value: args.messages }, { op: "set", path: [i, "message"], value: null });
        for (const key of ["expect", "intent", "page", "actions"] as const) if (args[key] !== undefined) edits.push({ op: "set", path: [i, key], value: args[key] });
        return { files: { ...files, [path]: editYaml(text, ...edits) }, summary: `update test case "${name}"` };
      }),
  }),
  tool({
    name: "delete_test_case",
    title: "Delete a test case",
    description: "Deletes a test case (and the file, when it was its last case).",
    inputSchema: schema({ file: S.string("The tests file (default: basics)."), name: S.string("The case's name."), ...SAVE }, ["name"]),
    annotations: REMOVE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const path = testPath(files, str(args, "file")?.trim() || "basics");
        const text = existing(files, path, "tests file");
        const name = need(args, "name");
        const next = { ...files, [path]: editYaml(text, { op: "remove", path: [], index: caseIndex(text, name) }) };
        const left = readYaml(next[path]!);
        if (Array.isArray(left) && left.length === 0) delete next[path];
        return { files: next, summary: `delete test case "${name}"` };
      }),
  }),
  tool({
    name: "run_tests",
    title: "Run tests",
    description: "Runs the test cases (tests/*.yaml) with the real AI against the live version, or with `files` laid over it to test a change before saving. replay: true also replays recent real conversations (slow). Real actions are called unless mockTools: true.",
    inputSchema: schema({
      cases: S.strings("Only the cases with these names (default: all)."),
      files: S.object("Unsaved changes to test: path → file text (null deletes).", { additionalProperties: { type: ["string", "null"] } }),
      mockTools: S.bool("true: actions return their mock: response instead of being called."),
      replay: S.bool("true: also replay recent real conversations and report which answers would change (slow)."),
      sample: S.int("With replay: how many conversations (default 20, at most 50).", { minimum: 1, maximum: MAX_REPLAY_SAMPLE }),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    long: true,
    async run(ctx, args, progress) {
      const stored = await latest(ctx);
      const candidateFiles = overlay(stored.files, args.files);
      const parsed = parseConfig(candidateFiles);
      if (parsed.issues.length) return { isError: true, text: `Fix these first:\n${problemsText(parsed.issues)}` };
      const only = Array.isArray(args.cases) ? new Set(args.cases.map(String)) : null;
      const candidate = only ? { ...parsed.config, evals: parsed.config.evals.filter((c) => only.has(c.name)) } : parsed.config;
      if (only && !candidate.evals.length) fail(`No case has those names. list_tests lists them.`);
      const replay = args.replay === true;
      if (!candidate.evals.length && !replay) return done("There are no test cases. add_test_case adds one.");
      const [model, judgeModel] = await models(ctx, ["answer", "judge"]);
      const workspace = await ctx.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(ctx.workspaceId).first<{ name: string }>();
      const events: EvalEvent[] = [];
      // One progress line per case or replayed conversation, counted against the start's totals.
      let total = 0;
      let finished = 0;
      const onEvent = (e: EvalEvent) => {
        events.push(e);
        if (e.type === "start") {
          total = e.cases + e.conversations;
          progress(`Running ${plural(e.cases, "case")}${e.conversations ? ` and replaying ${plural(e.conversations, "conversation")}` : ""}…`, 0, total);
        }
        if (e.type === "case") progress(`${e.pass ? "PASS" : "FAIL"} ${e.name}`, ++finished, total);
        if (e.type === "replay") progress(`Replayed "${e.question.slice(0, 60)}": ${e.verdict}`, ++finished, total);
      };
      await runEval(
        {
          env: ctx.env,
          workspaceId: ctx.workspaceId,
          workspaceName: workspace?.name ?? "this company",
          model: model!,
          judgeModel: judgeModel!,
          live: parseConfig(stored.files, stored.version).config,
          candidate,
          sample: replay ? Math.min(Math.max(typeof args.sample === "number" ? args.sample : DEFAULT_REPLAY_SAMPLE, 1), MAX_REPLAY_SAMPLE) : 0,
          mockTools: args.mockTools === true,
        },
        onEvent,
        { cases: true, replay },
      );
      const lines: string[] = [];
      for (const e of events) {
        if (e.type === "case") lines.push(`${e.pass ? "PASS" : "FAIL"} ${e.file} · ${e.name}${e.pass ? "" : `: ${e.failures.join("; ")}`}\n  outcome ${e.result.outcome}; called ${e.result.tools.join(", ") || "nothing"}; reply: ${e.result.reply.replace(/\s+/g, " ").slice(0, 400)}`);
        if (e.type === "replay" && e.verdict === "changed") lines.push(`CHANGED "${e.question.slice(0, 120)}": ${e.why}`);
        if (e.type === "error") lines.push(`ERROR (${e.scope}): ${e.message}`);
      }
      const end = events.find((e): e is Extract<EvalEvent, { type: "done" }> => e.type === "done");
      const head = end ? `${end.cases.passed} passed, ${end.cases.failed} failed${replay ? `; replay: ${end.replay.same} same, ${end.replay.changed} changed, ${end.replay.errors} errors` : ""}.` : "The run didn't finish.";
      return { isError: !end || end.cases.failed > 0, text: `${head}\n${lines.join("\n")}` };
    },
  }),
  tool({
    name: "test_chat",
    title: "Test chat",
    description: "Chats with the agent as a customer, like a task's Test tab: each message gets the reply the customer would see, the actions it called and the cards it showed. Safe by default: changes (POST actions) are answered without being made, unless real: true. Nothing is stored. To continue a chat or press a card's button, pass back the turns it returns.",
    inputSchema: schema({
      messages: S.strings("The customer's messages, sent one after another."),
      turns: { type: "array", items: { type: "object" }, description: "The chat so far, as a previous test_chat returned it." },
      press: S.object("Press a card's button after the messages: { reply: the AI reply's number in this chat (1 = first), widgetId, action: { type, payload }, values: { field: value }, item, label }."),
      files: S.object("Unsaved changes to chat with: path → file text (null deletes).", { additionalProperties: { type: ["string", "null"] } }),
      real: S.bool("true: POST actions really make their changes."),
      customer: S.object("A test customer for {user.*}: { id, email, name, attributes, secrets }."),
      page: S.string("The page path the customer is on, like /billing."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    long: true,
    async run(ctx, args, progress) {
      requireAdmin(ctx);
      const stored = await latest(ctx);
      const files = overlay(stored.files, args.files);
      const { config, issues } = parseConfig(files);
      if (issues.length) return { isError: true, text: `Fix these first:\n${problemsText(issues)}` };
      const turns: TestTurn[] = Array.isArray(args.turns) ? (JSON.parse(JSON.stringify(args.turns)) as TestTurn[]) : [];
      const messages = Array.isArray(args.messages) ? args.messages.filter((m): m is string => typeof m === "string" && m.trim() !== "") : [];
      const steps: TestTurn[] = messages.map((text) => ({ role: "customer", text }));
      if (isRecord(args.press)) {
        const p = args.press;
        // Default: the last reply (the one the messages above get, or the chat's last).
        const n = typeof p.reply === "number" ? p.reply : turns.filter((t) => t.role === "ai").length + messages.length;
        if (!isRecord(p.action) || typeof p.action.type !== "string" || typeof p.widgetId !== "string") fail("press needs widgetId and action: { type, payload } (test_chat lists them under each card).");
        steps.push({ role: "customer", text: typeof p.label === "string" ? p.label : String((p.action as Record<string, unknown>).type), press: { turn: n, widgetId: p.widgetId as string, action: p.action as { type: string }, values: isRecord(p.values) ? (p.values as Record<string, string | boolean>) : {}, ...(typeof p.item === "string" ? { item: p.item } : {}) } });
      }
      if (!steps.length) fail("Pass messages (or a press).");
      const [model] = await models(ctx, ["answer"]);
      const [workspace, seen] = await Promise.all([
        ctx.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(ctx.workspaceId).first<{ name: string }>(),
        ctx.env.WORKSPACE_HUB.getByName(ctx.workspaceId).pageActions() as Promise<SeenPageAction[]>,
      ]);
      const page = str(args, "page")?.startsWith("/") ? str(args, "page")!.slice(0, 300) : null;
      const out: string[] = [];
      for (const step of steps) {
        if (step.role !== "customer") continue;
        if (step.press) {
          // The press names an AI reply by its number; the turn index is where that reply sits.
          const ai = turns.map((t, i) => (t.role === "ai" ? i : -1)).filter((i) => i >= 0);
          const at = ai[step.press.turn - 1];
          if (at === undefined) fail(`There's no AI reply ${step.press.turn} in this chat to press a button on.`);
          step.press.turn = at!;
        }
        turns.push(step);
        progress(`Customer: ${step.press ? `presses "${step.text}"` : step.text.slice(0, 80)}`, out.length + 0.5, steps.length);
        const checked = readTestTurns(turns);
        let reply: TestReply | null = null;
        let error = "";
        const usage = await runTestChat(
          { env: ctx.env, workspaceId: ctx.workspaceId, workspaceName: workspace?.name ?? "this company", model: model!, config, turns: checked, real: args.real === true, user: testCustomer(args.customer), page, seen: seen.slice(0, 60) },
          (e) => {
            if (e.type === "done") reply = e.reply;
            if (e.type === "error") error = e.message;
          },
        );
        await recordUsage(ctx.env, ctx.workspaceId, usage);
        // A tool: button's run stays on the press, so later turns give the AI its result.
        const last = checked.at(-1);
        if (step.press && last?.role === "customer" && last.press?.tool) step.press.tool = last.press.tool;
        if (!reply) return { isError: true, text: `${out.join("\n\n")}\n\nThe AI couldn't answer: ${error || "no reply"}.` };
        turns.push({ role: "ai", reply });
        const number = turns.filter((t) => t.role === "ai").length;
        out.push(`Customer: ${step.press ? `[presses "${step.text}"]` : step.text}\nAI reply ${number}:\n${replyText(reply)}`);
        progress(`AI reply ${number} written`, out.length, steps.length);
      }
      const state = JSON.stringify(turns);
      return done(`${out.join("\n\n")}\n\n${state.length <= 60_000 ? `To continue this chat (or press a button), pass these turns back:\n${state}` : "(The chat is too long to continue; start a new one.)"}${args.real === true ? "" : "\n(Safe mode: POST actions were answered without making changes.)"}`);
    },
  }),
];

const WEBSITE: Tool[] = [
  tool({
    name: "website_actions",
    title: "Website actions",
    description: "The actions the company's website offers the agent (registered with WebMCP / JunDesk.registerAction), as the desk last saw them: inputs, how each runs, its status line and its result's shape.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const [seen, { files }] = await Promise.all([ctx.env.WORKSPACE_HUB.getByName(ctx.workspaceId).pageActions() as Promise<SeenPageAction[]>, latest(ctx)]);
      const { config } = parseConfig(files);
      if (!seen.length) return done("The desk hasn't seen any website actions yet (they show up once the site registers some and a visitor opens the chat).");
      return done(
        seen
          .map((a) => {
            const run = config.websiteActionRisk[a.name];
            return `- ${a.name}: ${a.description}\n  inputs: ${a.params.join(", ") || "none"}; runs: ${run ? `${run} (set in ${WEBSITE_ACTIONS_PATH})` : `${a.risk ?? "confirm"} (the site's own setting)`}; status line: ${config.websiteActionStatus[a.name] ?? a.statusLine ?? "(from its name)"}${a.widget ? `; card: ${a.widget}` : ""}${a.shape ? `\n  result shape: ${JSON.stringify(a.shape).slice(0, 600)}` : ""}`;
          })
          .join("\n"),
      );
    },
  }),
  tool({
    name: "set_website_action",
    title: "Set how a website action runs",
    description: "Sets how one website action runs (website-actions.yaml): auto (without asking), confirm (the customer confirms first) or human (a person does it), and the line the customer sees while it runs. null clears a setting.",
    inputSchema: schema({
      name: S.string("The website action's name."),
      run: { type: ["string", "null"], enum: ["auto", "confirm", "human", null], description: "auto, confirm or human; null: the site's own setting." },
      status: { type: ["string", "null"], description: "One line while it runs (≤ 60 characters); null: the default." },
      ...SAVE,
    }, ["name"]),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, (files) => {
        const name = need(args, "name");
        const text = files[WEBSITE_ACTIONS_PATH] ?? "";
        const data = text.trim() ? readYaml(text) : {};
        if (!isRecord(data)) fail(`${WEBSITE_ACTIONS_PATH} doesn't parse as a map. Fix it with write_file.`);
        const current = isRecord(data) ? data[name] : undefined;
        const was = isRecord(current) ? current : current === undefined ? {} : { run: current };
        const run = args.run !== undefined ? args.run : was.run;
        const status = args.status !== undefined ? args.status : was.status;
        const value = run === null || run === undefined ? (status ? { status } : null) : status ? { run, status } : run;
        const next = text.trim() ? editYaml(text, { op: "set", path: [name], value }) : value === null ? "" : stringify({ [name]: value });
        const out = { ...files };
        if (next.trim() && !/^\{\}\s*$/.test(next.trim())) out[WEBSITE_ACTIONS_PATH] = next;
        else delete out[WEBSITE_ACTIONS_PATH];
        return { files: out, summary: `set website action ${name}`, show: [WEBSITE_ACTIONS_PATH] };
      }),
  }),
];

const DESK: Tool[] = [
  tool({
    name: "get_desk_settings",
    title: "Get the desk settings",
    description: "desk.yaml: the desk's settings as code (ai: switches and models; chat: the chat widget's look, texts, allowed websites, openers; hours: business hours; inbox: assignment). Written from the desk when the config has none yet.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      const { files } = await latest(ctx);
      const { text, generated } = await deskText(ctx, files);
      return done(`${generated ? "The config has no desk.yaml yet: this is the desk's current settings as one (update_desk_settings adds it).\n" : ""}${block(DESK_PATH, text)}\nAs data: ${JSON.stringify(parseDeskFile(text))}`);
    },
  }),
  tool({
    name: "update_desk_settings",
    title: "Update the desk settings",
    description: "Changes desk settings by section; only the keys you pass change (comments stay), and they apply to the desk at once. Sections: ai { enabled, model, models, monthlyReplyCap }, chat { name, color, mode (island|window), greetingCard, button, position, island { surface, glow }, theme, greeting, replyTime, placeholder, suggestedQuestions, askForRating, allowedWebsites, offerHelpOnErrors, openers, … }, hours { enabled, timeZone, days: { monday: \"09:00-17:30\" }, awayMessage }, inbox { assignment: { mode: manual|round_robin, capacity } }. ai.models and hours.days are replaced whole. get_desk_settings shows every key.",
    inputSchema: schema({
      ai: S.object("AI switches: { enabled, model, models, monthlyReplyCap }."),
      chat: S.object("The chat widget: look, texts, allowed websites, openers."),
      hours: S.object("Business hours: { enabled, timeZone, days, awayMessage }."),
      inbox: S.object("Assignment: { assignment: { mode, capacity } }."),
      ...SAVE,
    }),
    annotations: WRITE,
    run: (ctx, args) =>
      commit(ctx, args, async (files) => {
        const patch: Record<string, unknown> = {};
        for (const key of ["ai", "chat", "hours", "inbox"] as const) if (args[key] !== undefined) patch[key] = args[key];
        if (!Object.keys(patch).length) fail("Pass at least one section: ai, chat, hours or inbox.");
        const { text } = await deskText(ctx, files);
        if (parseDocument(text).errors.length) fail("desk.yaml doesn't parse. Fix it with write_file.");
        const before = parseDeskFile(text);
        const after = mergeDesk(before as Record<string, unknown>, patch) as DeskFile;
        return { files: { ...files, [DESK_PATH]: updateDeskText(text, before, after) }, summary: `update desk settings (${Object.keys(patch).join(", ")})`, show: args.dryRun === true ? [DESK_PATH] : [] };
      }),
  }),
  tool({
    name: "preview_chat",
    title: "Preview the chat widget",
    description: "A picture of the website chat as customers see it, closed (the island, greeting card or button) or open, on a light or dark page: the live look, or with `chat` changes laid over it before you save them (the same keys as update_desk_settings' chat). Nothing is saved.",
    inputSchema: schema({
      chat: S.object("Unsaved chat settings to show, like { color: \"#0f766e\", mode: \"island\" } (default: the live look)."),
      open: S.bool("true: the chat opened (default: closed, as a visitor first sees it)."),
      page: S.string("The website's colour behind it (default light).", { enum: ["light", "dark"] }),
    }),
    annotations: READ,
    async run(ctx, args) {
      const [state, inbox, { files }] = await Promise.all([
        loadDeskState(ctx.env, ctx.workspaceId),
        ctx.env.DB.prepare("SELECT i.widget_key AS widgetKey, w.name FROM inboxes i JOIN workspaces w ON w.id = i.workspace_id WHERE i.workspace_id = ? ORDER BY i.created_at LIMIT 1")
          .bind(ctx.workspaceId)
          .first<{ widgetKey: string; name: string }>(),
        latest(ctx),
      ]);
      if (!inbox) fail("This workspace has no chat widget yet.");
      let settings = state.settings;
      if (args.chat !== undefined) {
        if (!isRecord(args.chat)) fail("chat must be an object of chat settings.");
        // The draft the same way update_desk_settings would write it, applied to a copy of the settings.
        const { text } = await deskText(ctx, files);
        const issues: DeskIssue[] = [];
        const desk = mergeDesk(parseDeskFile(text) as Record<string, unknown>, { chat: args.chat }) as DeskFile;
        parseDeskFile(stringify(desk), issues);
        if (issues.length) fail(`Those chat settings have problems:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`);
        try {
          settings = applyDesk(desk, state.settings, state.ai, () => newId("op")).settings;
        } catch (error) {
          fail(`Those chat settings have a problem: ${(error as Error).message}`);
        }
      }
      const look = widgetLook(settings, inbox!.name, ...(Object.values(workspaceLogos(inbox!.widgetKey, settings)) as [string | null, string | null]));
      const open = args.open === true;
      const page = args.page === "dark" ? "dark" : "light";
      const shot = await screenshot(ctx.env, ctx.origin, { kind: "chat", key: inbox!.widgetKey, look, open, page }, { width: 520, height: open ? 760 : 360 });
      const what = `${look.mode === "island" ? "The island" : look.greetingCard ? "The chat window with its greeting card" : "The chat window with a button"}, ${open ? "open" : "closed"}, on a ${page} page: colour ${look.color}, theme ${look.theme}${look.mode === "island" ? `, island colour ${look.islandSurface}` : ""}.${args.chat !== undefined ? " (Unsaved changes: update_desk_settings saves them.)" : ""}`;
      return "image" in shot ? { text: what, images: [shot.image] } : { text: `${what}\nNo picture: ${shot.skipped}.` };
    },
  }),
];

// ---------- knowledge (D-87) ----------

/** Runs a Knowledge page function; its expected failures (HttpError) come back as messages the AI can act on. */
async function knowledgeCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError || error instanceof DocumentInputError) fail(error.message);
    throw error;
  }
}

/** get_source lists at most this many pages, and cuts a document's text here. */
const MAX_PAGES_LISTED = 300;
const MAX_SOURCE_TEXT = 40_000;
const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, "Z") : "never");

function sourceLine(s: SourceListRow, maxPages: number | null): string {
  const type = sourceType(s.kind, maxPages);
  const state = sourceState(s.kind, s.status);
  const where = s.kind === "website" ? s.url : s.fileName ? `"${s.title}" (${s.fileName})` : `"${s.title}"`;
  const counts = [
    ...(s.kind === "website" ? [`${plural(s.pageCount, "page")}${maxPages && type === "website" ? ` (up to ${maxPages})` : ""}`] : []),
    plural(s.chunkCount, "chunk"),
    ...(s.chunksWithoutVectors > 0 ? [`${s.chunksWithoutVectors} without vectors (keyword search only until a re-index)`] : []),
  ];
  return `- ${s.id} · ${type} · ${where} · ${state} · ${counts.join(", ")} · last sync ${when(s.lastSyncedAt)}${s.error ? ` · ${state === "failed" ? "error" : "note"}: ${s.error}` : ""}`;
}

const KNOWLEDGE: Tool[] = [
  tool({
    name: "list_knowledge",
    title: "List the knowledge",
    description: "The knowledge the AI answers from (the desk's Knowledge page): each source's id, type (website, page, file, text), URL or name, state (queued, crawling, indexing, ready, failed), page and chunk counts, last sync and any error. Crawls and indexing run in the background: call this again to follow them.",
    inputSchema: schema({}),
    annotations: READ,
    async run(ctx) {
      await finishStuckSyncs(ctx.env, ctx.workspaceId);
      const sources = await listSources(ctx.env, ctx.workspaceId);
      if (!sources.length) return done("No knowledge yet. add_website crawls a site; add_document adds text or a file.");
      const caps = await ctx.env.DB.prepare("SELECT id, json_extract(settings, '$.maxPages') AS maxPages FROM kb_sources WHERE workspace_id = ? AND kind = 'website'")
        .bind(ctx.workspaceId)
        .all<{ id: string; maxPages: number | null }>();
      const maxPages = new Map(caps.results.map((r) => [r.id, r.maxPages ?? DEFAULT_MAX_PAGES]));
      return done(`${plural(sources.length, "source")}, newest first:\n${sources.map((s) => sourceLine(s, maxPages.get(s.id) ?? null)).join("\n")}`);
    },
  }),
  tool({
    name: "get_source",
    title: "Get a source",
    description: "One knowledge source in detail. A website: every page it read (URL, title, chunks, when it changed) and the pages left out. A document: its text, from the original for text and Markdown, else what was indexed from it (PDF, DOCX), so you can change it with update_document.",
    inputSchema: schema({ id: S.string("The source's id (list_knowledge shows it).") }, ["id"]),
    annotations: READ,
    async run(ctx, args) {
      const id = need(args, "id");
      const source = (await listSources(ctx.env, ctx.workspaceId)).find((s) => s.id === id);
      if (!source) fail(`There's no source ${id}. list_knowledge shows the ids.`);
      const row = (await ctx.env.DB.prepare("SELECT body, settings FROM kb_sources WHERE id = ?").bind(id).first<{ body: string | null; settings: string }>())!;
      const settings = JSON.parse(row.settings) as SourceSettings;
      const head = sourceLine(source!, source!.kind === "website" ? (settings.maxPages ?? DEFAULT_MAX_PAGES) : null);
      if (source!.kind === "website") {
        const pages = await ctx.env.DB.prepare(
          `SELECT d.url, d.title, d.updated_at AS updatedAt, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunks
           FROM kb_documents d WHERE d.source_id = ? AND d.content_hash IS NOT NULL ORDER BY d.url LIMIT ?`,
        )
          .bind(id, MAX_PAGES_LISTED)
          .all<{ url: string; title: string | null; updatedAt: number; chunks: number }>();
        const lines = pages.results.map((p) => `- ${p.url}${p.title ? ` · "${p.title}"` : ""} · ${plural(p.chunks, "chunk")} · changed ${when(p.updatedAt)}`);
        const more = source!.pageCount > pages.results.length ? `\n… and ${source!.pageCount - pages.results.length} more.` : "";
        const left = settings.exclude?.length ? `\nLeft out (never read): ${settings.exclude.join(", ")}` : "";
        const blocked = settings.disallow?.length ? `\nrobots.txt blocks: ${settings.disallow.slice(0, 20).join(", ")}` : "";
        return done(`${head}\nPages:\n${lines.join("\n") || "- none yet"}${more}${left}${blocked}`);
      }
      // A document: the original text where it is text, else the indexed chunks in order.
      let content: string | null = null;
      let from = "the original";
      if (source!.kind === "snippet") content = row.body ?? "";
      else if (settings.file && (settings.file.format === "markdown" || settings.file.format === "text")) content = (await (await ctx.env.FILES.get(settings.file.key))?.text()) ?? null;
      if (content === null) {
        from = `what was indexed from the ${settings.file?.format ?? "file"} (the original isn't text)`;
        const chunks = await ctx.env.DB.prepare("SELECT heading, text FROM kb_chunks WHERE source_id = ? ORDER BY position").bind(id).all<{ heading: string; text: string }>();
        content = chunks.results.map((c) => (c.heading ? `## ${c.heading}\n${c.text}` : c.text)).join("\n\n");
      }
      const cut = content.length > MAX_SOURCE_TEXT ? `${content.slice(0, MAX_SOURCE_TEXT)}\n… (cut at ${MAX_SOURCE_TEXT} characters)` : content;
      return done(`${head}\nText (${from}):\n${block(settings.file?.name ?? source!.title, cut || "(empty)")}`);
    },
  }),
  tool({
    name: "update_document",
    title: "Update a document",
    description: "Replaces a document's content in place (same id, re-indexed in the background), like uploading a new version of it: `text` (plain text or Markdown) or `base64` + `filename` for a file. get_source shows the current text. Knowledge isn't versioned, so the old content is gone: ask the person first unless they asked for the change. Websites change on the site: resync_source them instead.",
    inputSchema: schema({
      id: S.string("The document's source id (list_knowledge shows it)."),
      name: S.string("A new title (default: the current one)."),
      text: S.string("The new content as plain text or Markdown."),
      base64: S.string("A new file's bytes, base64-encoded (instead of text)."),
      filename: S.string("With base64: the file's name, like returns-policy.pdf."),
    }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run(ctx, args) {
      requireAdmin(ctx);
      const id = need(args, "id");
      const current = await ctx.env.DB.prepare("SELECT title FROM kb_sources WHERE id = ? AND workspace_id = ?").bind(id, ctx.workspaceId).first<{ title: string }>();
      if (!current) fail(`There's no source ${id}. list_knowledge shows the ids.`);
      const replaced = await knowledgeCall(async () => {
        const input = documentInput({ ...args, name: str(args, "name")?.trim() || current!.title });
        return replaceDocument(ctx.env, ctx.workspaceId, id, { name: input.fileName, title: input.title, bytes: input.bytes });
      });
      if (!replaced) fail(`There's no source ${id}.`);
      return done(`Replaced "${str(args, "name")?.trim() || current!.title}" (${id}, ${replaced!.format}, ${replaced!.size} bytes): ${replaced!.kind === "snippet" ? "re-indexed" : "re-indexing in the background; list_knowledge shows when it's ready"}.`);
    },
  }),
  tool({
    name: "add_website",
    title: "Add a website",
    description: "Crawls a website (its sitemap, else links from the start page, within the start URL's folder) or one page into the knowledge, like Add website on the Knowledge page. Answers at once with the source's id; the crawl runs in the background (list_knowledge shows when it's ready).",
    inputSchema: schema({
      url: S.string("The start URL, like https://docs.example.com (http or https)."),
      maxPages: S.int(`The most pages to read, 1–2000 (default ${DEFAULT_MAX_PAGES}). 1: only this page.`, { minimum: 1, maximum: 2000 }),
    }, ["url"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(ctx, args) {
      requireAdmin(ctx);
      const { id, title, maxPages } = await knowledgeCall(() => addWebsite(ctx.env, ctx.workspaceId, args));
      return done(`Added ${maxPages === 1 ? "the page" : "the website"} ${title} (${id}): ${maxPages === 1 ? "reading it" : `crawling up to ${plural(maxPages, "page")}`} in the background. list_knowledge shows when it's ready.`);
    },
  }),
  tool({
    name: "add_document",
    title: "Add a document",
    description: "Adds a document to the knowledge, like a file upload on the Knowledge page: `name` plus either `text` (plain text or Markdown) or `base64` + `filename` for a file (PDF, DOCX, Markdown or plain text, up to 10 MB). Indexed in the background; list_knowledge shows when it's ready.",
    inputSchema: schema({
      name: S.string("The document's title in the Knowledge list (the AI's citations show it)."),
      text: S.string("The content as plain text or Markdown (headings help the AI quote the right part)."),
      base64: S.string("A file's bytes, base64-encoded (instead of text)."),
      filename: S.string("With base64: the file's name, like returns-policy.pdf; its extension says what it is (.pdf, .docx, .md, .txt)."),
    }, ["name"]),
    annotations: WRITE,
    async run(ctx, args) {
      requireAdmin(ctx);
      const added = await knowledgeCall(async () => {
        const input = documentInput(args);
        return addFileSource(ctx.env, ctx.workspaceId, { name: input.fileName, title: input.title, bytes: input.bytes });
      });
      return done(`Added "${added.title}" (${added.id}, ${added.format}, ${added.size} bytes): indexing in the background. list_knowledge shows when it's ready; then search_knowledge finds it.`);
    },
  }),
  tool({
    name: "resync_source",
    title: "Re-sync a source",
    description: "Re-crawls a website or re-indexes a file or text now, like the sync / re-index button on the Knowledge page (websites also re-sync daily on their own). Runs in the background.",
    inputSchema: schema({ id: S.string("The source's id (list_knowledge shows it).") }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(ctx, args) {
      requireAdmin(ctx);
      const id = need(args, "id");
      const kind = await resyncSource(ctx.env, ctx.workspaceId, id);
      if (!kind) fail(`There's no source ${id}. list_knowledge shows the ids.`);
      return done(kind === "snippet" ? `Re-indexed ${id}.` : `${kind === "website" ? "Re-crawling" : "Re-indexing"} ${id} in the background. list_knowledge shows when it's ready.`);
    },
  }),
  tool({
    name: "remove_source",
    title: "Remove a source",
    description: "Deletes a knowledge source and everything indexed from it (its pages, chunks, vectors and an uploaded file). Can't be undone: knowledge isn't versioned. Ask the person first, then pass confirm: true.",
    inputSchema: schema({ id: S.string("The source's id (list_knowledge shows it)."), confirm: S.bool("true: the person agreed; remove it for good.") }, ["id"]),
    annotations: REMOVE,
    async run(ctx, args) {
      requireAdmin(ctx);
      const id = need(args, "id");
      const source = await ctx.env.DB.prepare("SELECT url, title FROM kb_sources WHERE id = ? AND workspace_id = ?").bind(id, ctx.workspaceId).first<{ url: string | null; title: string }>();
      if (!source) fail(`There's no source ${id}. list_knowledge shows the ids.`);
      const what = `"${source!.title}"${source!.url ? ` (${source!.url})` : ""}`;
      if (args.confirm !== true) {
        fail(`Not removed. Removing ${what} deletes it and everything indexed from it, and can't be undone: knowledge has no history or restore. Ask the person, then call remove_source again with confirm: true.`);
      }
      if (!(await deleteSource(ctx.env, ctx.workspaceId, id))) fail(`There's no source ${id}.`);
      return done(`Removed ${what} (${id}) and its index. The AI no longer answers from it.`);
    },
  }),
  tool({
    name: "search_knowledge",
    title: "Search the knowledge",
    description: "Runs a question through the same search the support AI uses (meaning + keywords, reranked) and shows what it would get: each result's source, page title and URL, the text and its score. Use it to check whether the AI can already answer something before writing a task for it.",
    inputSchema: schema({ query: S.string("A customer's question, in their words."), limit: S.int("How many results, 1–10 (default 5; the AI gets 5).", { minimum: 1, maximum: 10 }) }, ["query"]),
    annotations: READ,
    async run(ctx, args) {
      const query = need(args, "query");
      if (query.length > 1000) fail("query is at most 1000 characters.");
      const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.round(args.limit), 1), 10) : 5;
      const hits = await searchKnowledge(ctx.env, ctx.workspaceId, query, limit);
      if (!hits.length) return done("Nothing found: the AI has no knowledge for this. Add it (add_website, add_document) or write a task.");
      const ids = hits.map((h) => h.id);
      const rows = await ctx.env.DB.prepare(
        `SELECT c.id, s.id AS sourceId, s.title FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE c.id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all<{ id: string; sourceId: string; title: string }>();
      const sources = new Map(rows.results.map((r) => [r.id, r]));
      const lines = hits.map((h, i) => {
        const source = sources.get(h.id);
        const text = h.text.length > 600 ? `${h.text.slice(0, 600)}…` : h.text;
        return `${i + 1}. ${h.title}${h.heading ? ` › ${h.heading}` : ""}${h.url ? ` (${h.url})` : ""} · score ${h.score.toFixed(3)}${source ? ` · source ${source.sourceId} "${source.title}"` : ""}\n${text}`;
      });
      return done(lines.join("\n\n"));
    },
  }),
];

export const MCP_TOOLS: Tool[] = [...GENERAL, ...INSTRUCTIONS, ...TASKS, ...ACTIONS, ...WIDGETS, ...TESTS, ...WEBSITE, ...DESK, ...KNOWLEDGE];

// ---------- resources ----------

const GUIDES: (McpResource & { text: () => string })[] = [
  { uri: "jun://guide/files", name: "file-format", title: "The agent's file format", description: "Every file and key of the support agent's config, with examples.", mimeType: "text/markdown", text: () => FILE_FORMAT },
  { uri: "jun://guide/chatkit-widgets", name: "chatkit-widgets", title: "ChatKit widget authoring guide", description: "OpenAI ChatKit Studio's guide for AIs that write widgets (components, props, layout).", mimeType: "text/markdown", text: () => CHATKIT_AUTHORING_GUIDE },
  {
    uri: "jun://guide/jinja",
    name: "jinja",
    title: "Jinja in widget templates",
    description: "The filters and tests the desk's Jinja engine supports (a subset; no eval).",
    mimeType: "text/markdown",
    text: () => {
      const { filters, tests } = jinjaNames();
      return `# Jinja in Jun widget templates\n\nTemplates render a ChatKit component tree as JSON: write every value with \`| tojson\`. The engine is a subset of Jinja (no eval, step and size limits; a missing field is empty, not an error).\n\nFilters: ${filters.join(", ")}\n\nTests: ${tests.join(", ")}\n`;
    },
  },
];

const FILE_URI = "jun://file/";
const mimeOf = (path: string) => (path.endsWith(".md") ? "text/markdown" : path.endsWith(".widget") ? "application/json" : "application/yaml");

export const mcpServer: McpServer<McpContext> = {
  name: "jun",
  version: JUN_VERSION,
  instructions: MCP_INSTRUCTIONS,
  tools: MCP_TOOLS,
  async listResources(ctx) {
    const { files } = await latest(ctx);
    const paths = Object.keys(files);
    if (!paths.includes(DESK_PATH)) paths.push(DESK_PATH);
    return [
      ...GUIDES.map(({ text: _, ...r }) => r),
      ...paths.sort().map((path) => ({ uri: `${FILE_URI}${path}`, name: path, title: path, description: "A file of the live agent config.", mimeType: mimeOf(path) })),
    ];
  },
  async readResource(ctx, uri) {
    const guide = GUIDES.find((g) => g.uri === uri);
    if (guide) return { mimeType: guide.mimeType, text: guide.text() };
    if (!uri.startsWith(FILE_URI)) return null;
    const path = decodeURIComponent(uri.slice(FILE_URI.length));
    const { files } = await latest(ctx);
    if (files[path] !== undefined) return { mimeType: mimeOf(path), text: files[path]! };
    if (path === DESK_PATH) return { mimeType: mimeOf(path), text: await generatedDeskFile(ctx.env, ctx.workspaceId) };
    return null;
  },
};

/** The token's role in its workspace, or null when they're no longer a member. */
export async function memberRole(env: Env, workspaceId: string, userId: string): Promise<Role | null> {
  const row = await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId).first<{ role: Role }>();
  return row?.role ?? null;
}
