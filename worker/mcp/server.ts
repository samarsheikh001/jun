// D-86: the desk's MCP server, the protocol half. A person's own AI (Claude Code, Cursor, Codex,
// Claude Desktop…) connects to POST /mcp with an API token and changes the support agent through the
// tools in ./tools.ts. Hand-written (no SDK, no new dependency), stateless "Streamable HTTP": each POST
// is one JSON-RPC message (or, for 2025-03-26 clients, a batch), answered with one application/json
// body; notifications and responses get 202 with no body; GET (a server-to-client SSE stream) is 405,
// since the server never starts a conversation; no Mcp-Session-Id. Checked against the spec pages
// for 2025-11-25 (basic/transports, server/tools, server/resources) on 2026-10-14.
// A long tool (`long`: run_tests, test_chat) answers as an SSE stream when the client accepts one
// (spec: the server MAY answer a POST with text/event-stream and send notifications before the
// response): notifications/progress for the request's progressToken, a comment every 15 s so proxies
// and clients don't give up, then the response. Checked against basic/utilities/progress on 2026-10-18.
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

/** What a tool returns: text for the AI; `isError` when it failed in a way the AI can fix; images after the text. */
export interface ToolResult {
  text: string;
  isError?: boolean;
  images?: { data: string; mimeType: string }[];
}

/** A long tool's progress line: "case 3 of 8 passed". `done`/`total` when it counts. */
export type Progress = (message: string, done?: number, total?: number) => void;

export interface McpTool<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /** Takes long enough to stream progress (see the header). */
  long?: boolean;
  run: (ctx: C, args: Record<string, unknown>, progress: Progress) => Promise<ToolResult>;
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

/** A notification the server sends while it answers a request (progress). */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

const progressToken = (params: Record<string, unknown>): string | number | null => {
  const token = isRecord(params._meta) ? params._meta.progressToken : undefined;
  return typeof token === "string" || typeof token === "number" ? token : null;
};

/**
 * One JSON-RPC message. Null for a notification or a response (nothing to answer). `notify` carries
 * a tool's progress (only when the request asked for it with a progressToken).
 */
export async function handleMessage<C>(server: McpServer<C>, ctx: C, message: unknown, notify?: (n: JsonRpcNotification) => void): Promise<JsonRpcResponse | null> {
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
        const token = progressToken(params);
        let last: number | null = null;
        // The spec wants `progress` to grow with every notification, so a line that doesn't count still moves it on a little.
        const progress: Progress = (text, done, total) => {
          if (token === null || !notify) return;
          const value = done ?? (last ?? 0) + 1;
          last = last !== null && value <= last ? last + 0.01 : value;
          notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: last, ...(total !== undefined ? { total } : {}), message: text } });
        };
        const result: ToolResult = problem ? { text: `${problem} Nothing was changed.`, isError: true } : await runTool(tool, ctx, args, progress);
        const images = (result.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
        return ok(id, { content: [{ type: "text", text: result.text }, ...images], isError: result.isError === true });
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

async function runTool<C>(tool: McpTool<C>, ctx: C, args: Record<string, unknown>, progress: Progress): Promise<ToolResult> {
  try {
    return await tool.run(ctx, args, progress);
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
  if (isLongCall(server, body) && /text\/event-stream/i.test(request.headers.get("accept") ?? "")) return streamAnswer(server, ctx, body);
  const answer = await handleMessage(server, ctx, body);
  return answer ? json(answer, answer.error?.code === INVALID_REQUEST && answer.id === null ? 400 : 200) : new Response(null, { status: 202 });
}

/** A tools/call of a `long` tool. */
function isLongCall<C>(server: McpServer<C>, body: unknown): boolean {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return false;
  const name = body.params.name;
  return server.tools.some((t) => t.name === name && t.long === true);
}

/** How often a streamed answer sends a keep-alive comment. */
export const KEEPALIVE_MS = 15_000;

/** A long call's answer as SSE: progress notifications, keep-alive comments, then the response; then it ends. */
function streamAnswer<C>(server: McpServer<C>, ctx: C, body: unknown): Response {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  // Writes go one after another; a client that hung up only stops the writing, never the tool.
  let chain = Promise.resolve();
  const write = (text: string) => {
    chain = chain.then(() => writer.write(encoder.encode(text))).catch(() => {});
  };
  const event = (message: unknown) => write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  const keepAlive = setInterval(() => write(": working\n\n"), KEEPALIVE_MS);
  void (async () => {
    try {
      const answer = await handleMessage(server, ctx, body, event);
      if (answer) event(answer);
    } finally {
      clearInterval(keepAlive);
      chain = chain.then(() => writer.close()).catch(() => {});
    }
  })();
  return new Response(stream.readable, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
