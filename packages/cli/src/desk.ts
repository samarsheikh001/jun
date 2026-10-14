import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { GUIDE_FILES, GUIDE_MARKER } from "./guide.ts";
import { TEMPLATE } from "./template.ts";

// `jun` commands for a deployed desk: login, init, pull, push, eval (support agent as code).

export interface DeskLogin {
  url: string;
  token: string;
  workspaceId: string;
  workspaceName: string;
  user: string;
}

/** Version the folder was last pulled/pushed at, so push can spot dashboard edits made since. */
export const VERSION_FILE = ".jun-version";

function loginPath(): string {
  return process.env.JUN_HOME ? join(process.env.JUN_HOME, "desk.json") : join(homedir(), ".jun", "desk.json");
}

export async function loadLogin(): Promise<DeskLogin> {
  if (process.env.JUN_DESK_URL && process.env.JUN_DESK_TOKEN) {
    // CI: no login file needed.
    const who = await whoami(process.env.JUN_DESK_URL, process.env.JUN_DESK_TOKEN);
    return who;
  }
  try {
    return JSON.parse(await readFile(loginPath(), "utf8")) as DeskLogin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Not logged in to a desk. Run `jun login https://your-desk.example.com` (or set JUN_DESK_URL and JUN_DESK_TOKEN).");
    throw error;
  }
}

async function api<T>(login: Pick<DeskLogin, "url" | "token">, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${login.url}/api${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${login.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: { code: string; message: string; issues?: Issue[]; current?: number | null } };
  if (!response.ok) throw new DeskError(response.status, json.error?.code ?? "error", json.error?.message ?? `HTTP ${response.status}`, json.error);
  return json;
}

interface Issue {
  path: string;
  message: string;
}

export class DeskError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: { issues?: Issue[]; current?: number | null } | undefined;

  constructor(status: number, code: string, message: string, detail?: { issues?: Issue[]; current?: number | null }) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function whoami(url: string, token: string): Promise<DeskLogin> {
  const base = url.replace(/\/+$/, "");
  const me = await api<{ user: { name: string }; workspace: { id: string; name: string } }>({ url: base, token }, "/cli/whoami");
  return { url: base, token, workspaceId: me.workspace.id, workspaceName: me.workspace.name, user: me.user.name };
}

export async function login(url: string, token: string): Promise<DeskLogin> {
  if (!/^https?:\/\//.test(url)) throw new Error("Usage: jun login https://your-desk.example.com");
  if (!token.startsWith("jun_")) throw new Error("That doesn't look like an API token (they start with jun_). Create one in Settings → API tokens.");
  const result = await whoami(url, token);
  const path = loginPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(result, null, 2), { mode: 0o600 });
  await rename(temp, path);
  return result;
}

// D-84: desk.yaml holds the desk's settings (chat widget, AI switches, hours, assignment).
// D-85: the persona is instructions.md; AGENTS.md, CLAUDE.md and README.md are the generated guide.
const INSTRUCTIONS = "instructions.md";
const CONFIG_PATH = /^(instructions\.md|desk\.yaml|website-actions\.yaml|tasks\/[^/]+\.md|actions\/[^/]+\.ya?ml|tests\/[^/]+\.ya?ml|widgets\/[^/]+\.widget)$/;
/** D-83: the layout before the rename. Still read (the desk stores it in the new layout); `jun pull` moves it. */
const OLD_CONFIG_PATH = /^(skills\/[^/]+\/SKILL\.md|tools\/[^/]+\.ya?ml|evals\/[^/]+\.ya?ml)$/;
const OLD_FOLDERS = ["skills", "tools", "evals"];
/** D-85: written by `jun pull` / `jun init` for people and coding AIs; never sent. */
const GUIDE_PATHS = Object.keys(GUIDE_FILES);
/** A guide file `jun pull` wrote, or the README `jun init` wrote before D-85. */
const isGenerated = (text: string) => {
  const start = text.replace(/\r\n/g, "\n").trimStart();
  return start.startsWith(GUIDE_MARKER) || start.startsWith("# Support agent\n\nThis folder is your Jun support agent, as code.");
};

/**
 * Reads the config files under `dir` (paths with forward slashes). Other files are skipped; the
 * guide files quietly. D-85: an AGENTS.md with no instructions.md that isn't the generated guide is
 * the persona from before the rename: it's read as instructions.md (`oldPersona`).
 */
export async function readFolder(dir: string): Promise<{ files: Record<string, string>; skipped: string[]; oldPersona: boolean }> {
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  let agents: string | undefined;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const path = relative(dir, full).split(sep).join("/");
        if (CONFIG_PATH.test(path) || OLD_CONFIG_PATH.test(path)) files[path] = await readFile(full, "utf8");
        else if (path === "AGENTS.md") agents = await readFile(full, "utf8");
        else if (!GUIDE_PATHS.includes(path)) skipped.push(path);
      }
    }
  }
  await walk(dir);
  const oldPersona = agents !== undefined && !(INSTRUCTIONS in files) && !agents.trimStart().startsWith(GUIDE_MARKER);
  if (oldPersona) files[INSTRUCTIONS] = agents!;
  return { files, skipped, oldPersona };
}

async function rmdirIfEmpty(path: string): Promise<void> {
  if ((await readdir(path).catch(() => null))?.length === 0) await rm(path, { recursive: true });
}

async function readVersion(dir: string): Promise<number | null> {
  try {
    const n = Number((await readFile(join(dir, VERSION_FILE), "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const writeVersion = (dir: string, version: number | null) => (version === null ? Promise.resolve() : writeFile(join(dir, VERSION_FILE), `${version}\n`));

function printIssues(issues: Issue[]): void {
  for (const issue of issues) console.error(`  ✘ ${issue.path || "(config)"}: ${issue.message}`);
}

export async function init(dir: string): Promise<void> {
  const existing = await readdir(dir).catch(() => []);
  if (existing.length) throw new Error(`${dir} isn't empty. Use \`jun pull ${dir}\` to download your desk's config instead.`);
  const all = { ...TEMPLATE, ...GUIDE_FILES };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  console.log(`Created ${dir}/ with ${Object.keys(all).length} files:`);
  for (const path of Object.keys(all)) console.log(`  ${path}${GUIDE_PATHS.includes(path) ? "  (guide, rewritten by jun pull)" : ""}`);
  console.log(`\nNext: edit them, then \`jun eval ${dir}\` and \`jun push ${dir}\`.`);
}

export async function pull(dir: string): Promise<void> {
  const desk = await loadLogin();
  const config = await api<{ version: number | null; files: Record<string, string> }>(desk, `/workspaces/${desk.workspaceId}/agent`);
  // Remove config files that no longer exist on the desk; leave anything else alone.
  const { files: local, oldPersona } = await readFolder(dir).catch(() => ({ files: {} as Record<string, string>, oldPersona: false }));
  for (const path of Object.keys(local)) if (!(path in config.files)) await rm(join(dir, path), { force: true });
  for (const [path, text] of Object.entries(config.files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  // D-85: the guide for people and coding AIs, rewritten every time (it isn't config). A file of
  // that name someone wrote themselves stays (an old persona AGENTS.md is in instructions.md now).
  const kept: string[] = [];
  for (const [path, text] of Object.entries(GUIDE_FILES)) {
    const current = await readFile(join(dir, path), "utf8").catch(() => null);
    const own = current !== null && !isGenerated(current) && !(path === "AGENTS.md" && oldPersona);
    if (own) kept.push(path);
    else await writeFile(join(dir, path), text);
  }
  if (kept.length) console.log(`Kept your own ${kept.join(", ")} (not generated by jun pull; delete ${kept.length === 1 ? "it" : "them"} to get the guide).`);
  if (oldPersona) console.log("Moved the persona from AGENTS.md to instructions.md. AGENTS.md is now a guide to these files for coding AIs (Claude Code, Codex, Cursor…).");
  // D-83: files in the old layout were just replaced by the new one; drop the folders they leave empty.
  if (Object.keys(local).some((p) => OLD_CONFIG_PATH.test(p))) {
    const skills = await readdir(join(dir, "skills")).catch(() => [] as string[]);
    for (const name of skills) await rmdirIfEmpty(join(dir, "skills", name));
    for (const name of OLD_FOLDERS) await rmdirIfEmpty(join(dir, name));
    console.log("Moved the folder to the current layout: tasks/<name>.md, actions/, tests/ (was skills/<name>/SKILL.md, tools/, evals/).");
  }
  await writeVersion(dir, config.version);
  console.log(`Pulled ${Object.keys(config.files).length} config files (${config.version === null ? "built-in default config" : `version ${config.version}`}) from ${desk.workspaceName} into ${dir}/.`);
}

export async function push(dir: string, options: { message?: string; force?: boolean }): Promise<void> {
  const desk = await loadLogin();
  const { files, skipped, oldPersona } = await readFolder(dir);
  if (!files[INSTRUCTIONS]) throw new Error(`${dir}/instructions.md not found. Run \`jun init ${dir}\` or \`jun pull ${dir}\` first.`);
  for (const path of skipped) console.warn(`  (skipped ${path}: not a config file)`);
  if (oldPersona) console.warn(`  AGENTS.md is the old name of instructions.md: pushed as instructions.md. Run \`jun pull ${dir}\` after pushing to rename it.`);
  if (Object.keys(files).some((p) => OLD_CONFIG_PATH.test(p))) {
    console.warn(`  This folder uses the old layout (skills/<name>/SKILL.md, tools/, evals/); the desk stores it as tasks/<name>.md, actions/, tests/. Run \`jun pull ${dir}\` after pushing to move the files.`);
  }
  try {
    const result = await api<{ version: number; summary: { skills: string[]; tools: string[]; evals: number } }>(desk, `/workspaces/${desk.workspaceId}/agent`, {
      method: "PUT",
      body: { files, base: await readVersion(dir), force: Boolean(options.force), message: options.message ?? "" },
    });
    await writeVersion(dir, result.version);
    const s = result.summary;
    console.log(`Pushed version ${result.version} to ${desk.workspaceName}: ${s.skills.length} tasks, ${s.tools.length} actions, ${s.evals} test cases. It's live now.`);
  } catch (error) {
    if (error instanceof DeskError && error.code === "invalid_config") {
      console.error("Not pushed: the config has errors.");
      printIssues(error.detail?.issues ?? []);
      process.exitCode = 1;
      return;
    }
    if (error instanceof DeskError && error.code === "conflict") {
      throw new Error(`Someone edited the agent in the dashboard since your last pull (desk is at version ${error.detail?.current}). Run \`jun pull ${dir}\`, merge with git, then push again — or \`jun push --force\` to overwrite.`);
    }
    throw error;
  }
}

interface ReplyView {
  outcome: string;
  reply: string;
  tools: string[];
}

type EvalEvent =
  | { type: "start"; liveVersion: number | null; cases: number; conversations: number }
  | { type: "case"; file: string; name: string; pass: boolean; failures: string[]; result: ReplyView }
  | { type: "replay"; conversationId: string; question: string; verdict: "same" | "changed"; why: string; live: ReplyView; candidate: ReplyView }
  | { type: "error"; scope: string; message: string }
  | { type: "done"; cases: { passed: number; failed: number }; replay: { same: number; changed: number; errors: number } };

const clip = (text: string, n = 280) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const tools = (v: ReplyView) => (v.tools.length ? ` [${v.tools.join(", ")}]` : "");

export async function evaluate(dir: string, options: { sample?: number; mockTools?: boolean; cases?: boolean; replay?: boolean; json?: boolean; failOnChange?: boolean }): Promise<void> {
  const desk = await loadLogin();
  const { files } = await readFolder(dir);
  if (!files[INSTRUCTIONS]) throw new Error(`${dir}/instructions.md not found.`);
  const response = await fetch(`${desk.url}/api/workspaces/${desk.workspaceId}/agent/eval`, {
    method: "POST",
    headers: { authorization: `Bearer ${desk.token}`, "content-type": "application/json" },
    body: JSON.stringify({ files, sample: options.sample, mockTools: options.mockTools, cases: options.cases, replay: options.replay }),
  });
  if (!response.ok || !response.body) {
    const json = (await response.json().catch(() => ({}))) as { error?: { message?: string; issues?: Issue[] } };
    console.error(`Eval didn't run: ${json.error?.message ?? `HTTP ${response.status}`}`);
    printIssues(json.error?.issues ?? []);
    process.exitCode = 1;
    return;
  }

  let failed = false;
  let buffer = "";
  const decoder = new TextDecoder();
  const handle = (event: EvalEvent) => {
    if (options.json) {
      console.log(JSON.stringify(event));
    } else if (event.type === "start") {
      console.log(`Evaluating ${dir}/ against ${desk.workspaceName} (live: ${event.liveVersion === null ? "default config" : `version ${event.liveVersion}`})`);
      console.log(`${event.cases} test case${event.cases === 1 ? "" : "s"}, ${event.conversations} recent conversation${event.conversations === 1 ? "" : "s"} to replay\n`);
    } else if (event.type === "case") {
      console.log(`${event.pass ? "✔" : "✘"} ${event.file} › ${event.name}`);
      for (const f of event.failures) console.log(`    ${f}`);
      if (!event.pass) console.log(`    reply (${event.result.outcome})${tools(event.result)}: ${clip(event.result.reply)}`);
    } else if (event.type === "replay") {
      if (event.verdict === "same") {
        console.log(`= ${clip(event.question, 80)}`);
      } else {
        console.log(`\n≠ ${clip(event.question, 120)}   (${event.why})`);
        console.log(`    live (${event.live.outcome})${tools(event.live)}: ${clip(event.live.reply)}`);
        console.log(`    new  (${event.candidate.outcome})${tools(event.candidate)}: ${clip(event.candidate.reply)}\n`);
      }
    } else if (event.type === "error") {
      console.log(`! ${event.scope}: ${event.message}`);
    } else if (event.type === "done") {
      const c = event.cases;
      const r = event.replay;
      console.log(`\nCases: ${c.passed} passed, ${c.failed} failed.  Replay: ${r.changed} changed, ${r.same} unchanged${r.errors ? `, ${r.errors} errors` : ""}.`);
      if (c.failed || (options.failOnChange && r.changed)) failed = true;
    }
    if (event.type === "error") failed = true;
  };
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handle(JSON.parse(line) as EvalEvent);
  }
  if (buffer.trim()) handle(JSON.parse(buffer) as EvalEvent);
  if (failed) process.exitCode = 1;
}
