import { newId } from "../lib/crypto.ts";
import { changedPaths, defaultFiles, mergeConfigs, parseConfig, withCurrentPaths, type AgentConfig, type ConfigFiles, type ConfigIssue } from "./config.ts";
import { DESK_PATH } from "./desk-file.ts";

// Agent config versions in D1 (AI-18). Git is where teams keep history; the desk keeps
// every saved version too, so dashboard edits and `jun push` never silently overwrite each other.

export interface ConfigVersion {
  version: number;
  message: string;
  source: "dashboard" | "cli";
  createdBy: string | null;
  createdAt: number;
  /** D-84: the files this version changed against the one before it (null for versions saved before this was kept). */
  changed: string[] | null;
}

export interface StoredConfig {
  /** null = never saved: the built-in default (built from the old Settings guidance). */
  version: number | null;
  files: ConfigFiles;
}

export async function loadConfigFiles(env: Env, workspaceId: string, version?: number): Promise<StoredConfig> {
  const row = await env.DB.prepare(
    version === undefined
      ? "SELECT version, files FROM agent_configs WHERE workspace_id = ? ORDER BY version DESC LIMIT 1"
      : "SELECT version, files FROM agent_configs WHERE workspace_id = ? AND version = ?",
  )
    .bind(...(version === undefined ? [workspaceId] : [workspaceId, version]))
    .first<{ version: number; files: string }>();
  // D-83: versions saved before the rename read in the current layout.
  if (row) return { version: row.version, files: withCurrentPaths(JSON.parse(row.files) as ConfigFiles) };
  const legacy = await env.DB.prepare("SELECT instructions FROM ai_settings WHERE workspace_id = ?").bind(workspaceId).first<{ instructions: string }>();
  return { version: null, files: defaultFiles(legacy?.instructions ?? "") };
}

/** The live config. Files that fail validation are left out (they were rejected on save anyway). */
export async function loadAgentConfig(env: Env, workspaceId: string): Promise<AgentConfig> {
  const stored = await loadConfigFiles(env, workspaceId);
  return parseConfig(stored.files, stored.version).config;
}

export class ConfigConflictError extends Error {
  constructor(readonly current: number | null) {
    super(`The config changed since you loaded it (now version ${current ?? "default"}). Pull the latest first, or save with force.`);
  }
}

/** A version's files; null = the built-in default (what a desk has before its first save). */
async function filesAt(env: Env, workspaceId: string, version: number | null): Promise<ConfigFiles> {
  if (version !== null) {
    const row = await env.DB.prepare("SELECT files FROM agent_configs WHERE workspace_id = ? AND version = ?").bind(workspaceId, version).first<{ files: string }>();
    if (row) return withCurrentPaths(JSON.parse(row.files) as ConfigFiles);
  }
  const legacy = await env.DB.prepare("SELECT instructions FROM ai_settings WHERE workspace_id = ?").bind(workspaceId).first<{ instructions: string }>();
  return defaultFiles(legacy?.instructions ?? "");
}

export interface SavedConfig {
  version: number;
  issues: [];
  /** What was saved: the input, or (D-84) the latest version with the input's changes merged in. */
  files: ConfigFiles;
  /** The latest version's files before this save (the built-in default when there was none). */
  previous: ConfigFiles;
}

/**
 * Saves a new version. `base` is the version the edit started from; if someone saved in
 * between, it's a conflict unless `force`, or (D-84) unless the two changed different files: then
 * the latest version gets this edit's files on top. Returns validation issues instead of saving.
 */
export async function saveConfig(
  env: Env,
  workspaceId: string,
  input: { files: ConfigFiles; base: number | null; force?: boolean; message: string; source: ConfigVersion["source"]; userId: string | null },
): Promise<SavedConfig | { version: null; issues: ConfigIssue[] }> {
  let files = withCurrentPaths(input.files); // D-83: an old folder from `jun push`
  const { issues } = parseConfig(files);
  if (issues.length) return { version: null, issues };
  const current = await env.DB.prepare(
    "SELECT MAX(version) AS v, MAX(CASE WHEN source = 'dashboard' THEN version END) AS d FROM agent_configs WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .first<{ v: number | null; d: number | null }>();
  const latest = current?.v ?? null;
  const previous = await filesAt(env, workspaceId, latest);
  // Dashboard saves must start from the latest version (two people editing in the browser).
  // CLI pushes come from git, which is their source of truth: they only conflict with
  // dashboard edits made since the pusher's last pull, which would otherwise be lost.
  const conflict = input.source === "dashboard" ? latest !== input.base : current?.d != null && current.d > (input.base ?? 0);
  if (!input.force && conflict) {
    // D-84: the settings pages save versions too (desk.yaml), so an open draft often starts from an
    // older one. Different files changed: merge. CLI pushes merge only desk.yaml changes.
    const base = await filesAt(env, workspaceId, input.base);
    const merged = mergeConfigs(base, previous, files, input.source === "cli" ? [DESK_PATH] : undefined);
    if (!merged || parseConfig(merged).issues.length) throw new ConfigConflictError(latest);
    files = merged;
  }
  const version = (latest ?? 0) + 1;
  // UNIQUE (workspace_id, version) turns a race between two saves into an error, not a lost update.
  await env.DB.prepare(
    "INSERT INTO agent_configs (id, workspace_id, version, files, message, source, created_by, created_at, changed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId("cfg"), workspaceId, version, JSON.stringify(files), input.message.slice(0, 500), input.source, input.userId, Date.now(), JSON.stringify(changedPaths(previous, files)))
    .run();
  return { version, issues: [], files, previous };
}

export async function listVersions(env: Env, workspaceId: string, limit = 50): Promise<ConfigVersion[]> {
  const rows = await env.DB.prepare(
    `SELECT c.version, c.message, c.source, u.name AS createdBy, c.created_at AS createdAt, c.changed
     FROM agent_configs c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.workspace_id = ? ORDER BY c.version DESC LIMIT ?`,
  )
    .bind(workspaceId, limit)
    .all<Omit<ConfigVersion, "changed"> & { changed: string | null }>();
  return rows.results.map((r) => ({ ...r, changed: r.changed ? (JSON.parse(r.changed) as string[]) : null }));
}
