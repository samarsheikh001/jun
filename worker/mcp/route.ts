import { BAD_TOKEN_MESSAGE, hasApiToken, tokenLogin } from "../lib/api-token.ts";
import { serveMcp } from "./server.ts";
import { mcpServer, memberRole } from "./tools.ts";

// D-86: POST /mcp, outside /api (MCP clients are given one URL). Authenticated with a personal API
// token only (Authorization: Bearer jun_…): the token's workspace is the one the tools act on. No
// cookies are read, so the CSRF guard of /api doesn't apply; the Origin check is in serveMcp.
// OAuth (for claude.ai's connectors) is a follow-up.

const NO_TOKEN = "Send an API token: Authorization: Bearer jun_… Create one in Settings → Developer → API tokens.";

function refuse(status: 401 | 403, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": 'Bearer realm="jun"' } : {}) },
  });
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return serveMcp(request, mcpServer, async () => {
    const authorization = request.headers.get("authorization");
    if (!hasApiToken(authorization)) return refuse(401, NO_TOKEN);
    const login = await tokenLogin(env, authorization, (p) => ctx.waitUntil(p));
    if (!login) return refuse(401, BAD_TOKEN_MESSAGE);
    const role = await memberRole(env, login.workspaceId, login.user.id);
    if (!role) return refuse(403, "This token's person is no longer a member of the workspace.");
    return { env, workspaceId: login.workspaceId, user: login.user, role, origin: new URL(request.url).origin };
  });
}
