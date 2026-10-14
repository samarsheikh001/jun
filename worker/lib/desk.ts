import type { ConfigFiles } from "../ai/config.ts";
import { loadConfigFiles, saveConfig } from "../ai/config-store.ts";
import { applyDesk, deskChanges, deskFromSettings, deskLeaves, DESK_PATH, parseDeskFile, renderDeskFile, sameValue, updateDeskText, type DeskFile } from "../ai/desk-file.ts";
import { loadAiSettings, type AiSettings } from "../ai/providers.ts";
import { newId } from "./crypto.ts";

// D-84: desk.yaml against the stores the app reads (`inboxes.settings` of the widget inbox, and
// `ai_settings`). The file is the editable form: saving it applies what changed; the settings
// pages' changes are written back into it as a new config version.

export interface DeskState {
  inboxId: string | null;
  settings: Record<string, unknown>;
  ai: AiSettings;
}

export async function loadDeskState(env: Env, workspaceId: string): Promise<DeskState> {
  const [inbox, ai] = await Promise.all([
    env.DB.prepare("SELECT id, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ id: string; settings: string }>(),
    loadAiSettings(env, workspaceId),
  ]);
  return { inboxId: inbox?.id ?? null, settings: inbox ? (JSON.parse(inbox.settings) as Record<string, unknown>) : {}, ai };
}

/** The desk's settings as desk.yaml data (every key). */
export const deskOf = (state: DeskState): DeskFile => deskFromSettings(state.settings, state.ai);

/** desk.yaml as it would be written now: for a config that doesn't have one yet. */
export async function generatedDeskFile(env: Env, workspaceId: string): Promise<string> {
  return renderDeskFile(deskOf(await loadDeskState(env, workspaceId)));
}

/** The one write of `ai_settings` (PUT /ai and desk.yaml). */
export async function writeAiSettings(env: Env, workspaceId: string, ai: AiSettings): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_settings (workspace_id, enabled, provider, model, models, instructions, monthly_reply_cap, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider, model = excluded.model, models = excluded.models,
       instructions = excluded.instructions, monthly_reply_cap = excluded.monthly_reply_cap, updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, ai.enabled ? 1 : 0, ai.provider, ai.model, JSON.stringify(ai.models), ai.instructions, ai.monthlyReplyCap, Date.now())
    .run();
}

/** Applies desk.yaml keys to the stores (only those it has). Throws an Error for a bad value (parseConfig reports it first). */
export async function applyDeskFile(env: Env, workspaceId: string, desk: DeskFile): Promise<void> {
  const state = await loadDeskState(env, workspaceId);
  const result = applyDesk(desk, state.settings, state.ai, () => newId("op"));
  if (result.inboxChanged && state.inboxId) {
    await env.DB.prepare("UPDATE inboxes SET settings = ? WHERE id = ?").bind(JSON.stringify(result.settings), state.inboxId).run();
  }
  if (result.aiChanged) await writeAiSettings(env, workspaceId, { ...state.ai, ...result.ai });
}

/**
 * After a config version is saved: applies the keys whose value the saved desk.yaml changed against
 * the previous version's (every key when that had none). A config without desk.yaml changes nothing.
 */
export async function applySavedDesk(env: Env, workspaceId: string, previous: ConfigFiles, saved: ConfigFiles): Promise<void> {
  const text = saved[DESK_PATH];
  if (text === undefined || previous[DESK_PATH] === text) return;
  const before = previous[DESK_PATH] === undefined ? null : parseDeskFile(previous[DESK_PATH]);
  const changes = deskChanges(before, parseDeskFile(text));
  if (deskLeaves(changes).length) await applyDeskFile(env, workspaceId, changes);
}

/**
 * After a settings page changed the stores (`before` = the desk's settings before it): saves a
 * config version whose desk.yaml says the same, editing only the changed keys of the latest one
 * (or writing the whole file). Nothing when no setting in the file changed. Never throws: the
 * settings change itself already happened.
 */
export async function recordDeskChange(env: Env, workspaceId: string, userId: string | null, message: string, before: DeskFile): Promise<number | null> {
  try {
    const after = deskOf(await loadDeskState(env, workspaceId));
    if (sameValue(before, after)) return null;
    const stored = await loadConfigFiles(env, workspaceId);
    const text = updateDeskText(stored.files[DESK_PATH], before, after);
    if (text === stored.files[DESK_PATH]) return null;
    const result = await saveConfig(env, workspaceId, { files: { ...stored.files, [DESK_PATH]: text }, base: stored.version, message, source: "dashboard", userId });
    if (result.version === null) {
      console.warn("desk.yaml: the settings changed, but the config has problems, so no version was saved:", JSON.stringify(result.issues.slice(0, 3)));
      return null;
    }
    return result.version;
  } catch (error) {
    console.warn("desk.yaml: no version saved for a settings change:", (error as Error).message);
    return null;
  }
}
