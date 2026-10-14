import { sha256 } from "./crypto.ts";

// Personal API tokens (`jun_…`, Settings → Developer → API tokens): the `jun` CLI (AI-18) and the
// desk's MCP server (D-86) send one as `Authorization: Bearer jun_…`. A token acts as the person who
// made it, in one workspace, for the agent's config only. Stored as a SHA-256 hash.

export const TOKEN_PREFIX = "jun_";

export const BAD_TOKEN_MESSAGE = "This API token isn't valid. Create a new one in Settings → Developer → API tokens.";

export interface TokenLogin {
  tokenId: string;
  workspaceId: string;
  user: { id: string; name: string; email: string | null };
}

/** True when the Authorization header carries an API token (valid or not). */
export const hasApiToken = (authorization: string | null | undefined): authorization is string => !!authorization?.startsWith(`Bearer ${TOKEN_PREFIX}`);

/** The token's person and workspace, or null when it isn't a token we know. Marks it used. */
export async function tokenLogin(env: Env, authorization: string, waitUntil: (p: Promise<unknown>) => void): Promise<TokenLogin | null> {
  const hash = await sha256(authorization.slice("Bearer ".length).trim());
  const row = await env.DB.prepare(
    `SELECT t.id, t.workspace_id, u.id AS user_id, u.name, u.email FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
  )
    .bind(hash)
    .first<{ id: string; workspace_id: string; user_id: string; name: string; email: string | null }>();
  if (!row) return null;
  waitUntil(env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run());
  return { tokenId: row.id, workspaceId: row.workspace_id, user: { id: row.user_id, name: row.name, email: row.email } };
}
