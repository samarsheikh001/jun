// D-86: the desk's MCP server, the protocol half. A person's own AI (Claude Code, Cursor, Codex,
// Claude Desktop…) connects to POST /mcp with an API token and changes the support agent through the
// tools in ./tools.ts. Hand-written (no SDK, no new dependency), stateless "Streamable HTTP": each POST
// is one JSON-RPC message (or, for 2025-03-26 clients, a batch), answered with one application/json
// body; notifications and responses get 202 with no body; GET (a server-to-client SSE stream) is 405,
// since the server never starts a conversation; no Mcp-Session-Id. Checked against the spec pages
// for 2025-11-25 (basic/transports, server/tools, server/resources) on 2026-10-14.
// Pure apart from the tools it's given, so the protocol is unit-tested without a Worker.

/** Newest first. A client asking for another version gets the newest (it may then disconnect). */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** JSON-RPC error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** MCP: a resource that doesn't exist. */
export const RESOURCE_NOT_FOUND = -32002;

export type JsonSchema = Record<string, unknown>;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What a tool returns: text for the AI; `isError` when it failed in a way the AI can fix. */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface McpTool<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  run: (ctx: C, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
}

export interface McpServer<C> {
  name: string;
  version: string;
  instructions: string;
  tools: McpTool<C>[];
  listResources: (ctx: C) => Promise<McpResource[]>;
  /** The resource's text, or null when there's no such resource. */
  readResource: (ctx: C, uri: string) => Promise<{ mimeType: string; text: string } | null>;
}

/** A failure the AI can act on: returned as an `isError` tool result with this message. */
export class ToolError extends Error {}

type Id = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rpcError = (id: Id, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

/** The version to answer `initialize` with: the client's when we speak it, else our newest. */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * The arguments against a tool's input schema, one level deep (the tools check the rest): required
 * properties, types, enums, unknown keys. Returns the first problem in plain words, or null.
 */
export function checkArguments(schema: JsonSchema, args: Record<string, unknown>): string | null {
  const props = isRecord(schema.properties) ? schema.properties : {};
  for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
    if (args[key] === undefined) return `${key} is required.`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!isRecord(prop)) {
      if (schema.additionalProperties === false) return `Unknown argument "${key}". Allowed: ${Object.keys(props).join(", ") || "none"}.`;
      continue;
    }
    if (value === undefined) continue;
    const types = (Array.isArray(prop.type) ? prop.type : prop.type === undefined ? [] : [prop.type]) as string[];
    if (types.length) {
      const actual = typeOf(value);
      const fits = types.some((t) => t === actual || (t === "integer" && typeof value === "number" && Number.isInteger(value)) || (t === "number" && typeof value === "number"));
      if (!fits) return `${key} must be ${types.join(" or ")}, not ${actual}.`;
    }
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return `${key} must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(", ")}.`;
  }
  return null;
}

/** One JSON-RPC message. Null for a notification or a response (nothing to answer). */
export async function handleMessage<C>(server: McpServer<C>, ctx: C, message: unknown): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== "2.0") return rpcError(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 message.");
  const hasId = "id" in message && (typeof message.id === "string" || typeof message.id === "number");
  // A response to us (we never send requests) or a notification: nothing to answer.
  if (!("method" in message)) return hasId || "result" in message || "error" in message ? null : rpcError(null, INVALID_REQUEST, "A request needs a method.");
  if (typeof message.method !== "string") return rpcError(hasId ? (message.id as Id) : null, INVALID_REQUEST, "method must be a string.");
  if (!hasId) return null; // notifications/initialized, notifications/cancelled, …
  const id = message.id as Id;
  const params = message.params === undefined ? {} : message.params;
  if (!isRecord(params)) return rpcError(id, INVALID_PARAMS, "params must be an object.");
  try {
    switch (message.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: server.name, title: "Jun desk", version: server.version },
          instructions: server.instructions,
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: server.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: { title: t.title, ...t.annotations } } : {}) })),
        });
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(id, INVALID_PARAMS, "params.name is the tool's name.");
        const tool = server.tools.find((t) => t.name === params.name);
        if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
        if (params.arguments !== undefined && !isRecord(params.arguments)) return rpcError(id, INVALID_PARAMS, "params.arguments must be an object.");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        // Input problems are the AI's to fix: a tool result, not a protocol error (spec: Error Handling).
        const problem = checkArguments(tool.inputSchema, args);
        const result = problem ? { text: `${problem} Nothing was changed.`, isError: true } : await runTool(tool, ctx, args);
        return ok(id, { content: [{ type: "text", text: result.text }], isError: result.isError === true });
      }
      case "resources/list":
        return ok(id, { resources: await server.listResources(ctx) });
      case "resources/templates/list":
        return ok(id, { resourceTemplates: [] });
      case "resources/read": {
        if (typeof params.uri !== "string") return rpcError(id, INVALID_PARAMS, "params.uri is the resource's URI.");
        const read = await server.readResource(ctx, params.uri);
        if (!read) return { jsonrpc: "2.0", id, error: { code: RESOURCE_NOT_FOUND, message: "Resource not found", data: { uri: params.uri } } };
        return ok(id, { contents: [{ uri: params.uri, mimeType: read.mimeType, text: read.text }] });
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  } catch (error) {
    console.error("mcp:", error);
    return rpcError(id, INTERNAL_ERROR, "Something went wrong on the desk.");
  }
}

async function runTool<C>(tool: McpTool<C>, ctx: C, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return await tool.run(ctx, args);
  } catch (error) {
    if (error instanceof ToolError) return { text: error.message, isError: true };
    console.error(`mcp tool ${tool.name}:`, error);
    return { text: `${tool.name} failed: ${(error as Error).message || "something went wrong on the desk"}.`, isError: true };
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/**
 * The HTTP side: one POST, one answer. `login` turns the request into the tools' context, or answers
 * it itself (401 without a token). The Origin check guards against DNS rebinding (spec: a present,
 * foreign Origin is a 403).
 */
export async function serveMcp<C>(request: Request, server: McpServer<C>, login: () => Promise<C | Response>): Promise<Response> {
  if (request.method !== "POST") {
    return json(rpcError(null, -32000, "This MCP endpoint takes POST requests only (no event stream)."), 405, { allow: "POST" });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json(rpcError(null, -32000, "Cross-origin request rejected."), 403);
  const version = request.headers.get("mcp-protocol-version");
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(rpcError(null, -32000, `Unsupported MCP-Protocol-Version ${version}. Supported: ${PROTOCOL_VERSIONS.join(", ")}.`), 400);
  }
  const ctx = await login();
  if (ctx instanceof Response) return ctx;
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json(rpcError(null, PARSE_ERROR, "The body isn't valid JSON."), 400);
  }
  if (Array.isArray(body)) {
    if (!body.length) return json(rpcError(null, INVALID_REQUEST, "An empty batch."), 400);
    const answers = (await Promise.all(body.map((m) => handleMessage(server, ctx, m)))).filter((a): a is JsonRpcResponse => a !== null);
    return answers.length ? json(answers) : new Response(null, { status: 202 });
  }
  const answer = await handleMessage(server, ctx, body);
  return answer ? json(answer, answer.error?.code === INVALID_REQUEST && answer.id === null ? 400 : 200) : new Response(null, { status: 202 });
}
