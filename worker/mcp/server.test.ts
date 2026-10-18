import assert from "node:assert/strict";
import { test } from "node:test";
// The protocol only (server.ts is pure). The desk's own tools need a Worker: scripts/e2e-mcp.ts lists and calls them.
import { checkArguments, handleMessage, negotiateVersion, PROTOCOL_VERSIONS, serveMcp, ToolError, type McpServer } from "./server.ts";

const fake: McpServer<{ who: string }> = {
  name: "jun",
  version: "9.9.9",
  instructions: "Use the tools.",
  tools: [
    {
      name: "echo",
      title: "Echo",
      description: "Says it back.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, times: { type: "integer" }, mode: { type: "string", enum: ["loud", "quiet"] } }, required: ["text"], additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: async (ctx, args) => ({ text: `${ctx.who}: ${String(args.text)}` }),
    },
    { name: "boom", title: "Boom", description: "Fails.", inputSchema: { type: "object" }, run: async () => { throw new ToolError("It broke, try another way."); } },
  ],
  listResources: async () => [{ uri: "jun://guide/files", name: "files", mimeType: "text/markdown" }],
  readResource: async (_ctx, uri) => (uri === "jun://guide/files" ? { mimeType: "text/markdown", text: "# Files" } : null),
};
const ctx = { who: "ws" };
const call = (method: string, params?: unknown, id: number | string = 1) => handleMessage(fake, ctx, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test("initialize echoes a supported protocol version, else answers with the newest", async () => {
  for (const v of PROTOCOL_VERSIONS) {
    const res = await call("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal((res?.result as { protocolVersion: string }).protocolVersion, v);
  }
  const res = await call("initialize", { protocolVersion: "2024-11-05" });
  const result = res?.result as { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown>; instructions: string };
  assert.equal(result.protocolVersion, "2025-11-25");
  assert.deepEqual(result.serverInfo, { name: "jun", title: "Jun desk", version: "9.9.9" });
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.equal(result.instructions, "Use the tools.");
  assert.equal(negotiateVersion(undefined), "2025-11-25");
});

test("notifications and responses get no answer; ping answers {}", async () => {
  assert.equal(await handleMessage(fake, ctx, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await handleMessage(fake, ctx, { jsonrpc: "2.0", id: 4, result: {} }), null);
  assert.deepEqual((await call("ping"))?.result, {});
});

test("unknown methods and bad messages are JSON-RPC errors", async () => {
  assert.equal((await call("prompts/list"))?.error?.code, -32601);
  assert.equal((await handleMessage(fake, ctx, { id: 1, method: "ping" }))?.error?.code, -32600);
  assert.equal((await handleMessage(fake, ctx, "hello"))?.error?.code, -32600);
  assert.equal((await call("tools/call", [1, 2]))?.error?.code, -32602);
  assert.equal((await call("tools/call", { name: "nope" }))?.error?.code, -32602);
  assert.equal((await call("tools/call", {}))?.error?.code, -32602);
  assert.equal((await call("resources/read", { uri: "jun://nope" }))?.error?.code, -32002);
});

test("tools/list and tools/call: results, input problems and tool failures as isError", async () => {
  const list = (await call("tools/list"))?.result as { tools: { name: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; title?: string } }[] };
  assert.deepEqual(list.tools.map((t) => t.name), ["echo", "boom"]);
  assert.equal(list.tools[0]!.annotations?.readOnlyHint, true);
  const ok = (await call("tools/call", { name: "echo", arguments: { text: "hi" } }))?.result as { content: { type: string; text: string }[]; isError: boolean };
  assert.deepEqual(ok, { content: [{ type: "text", text: "ws: hi" }], isError: false });
  const missing = (await call("tools/call", { name: "echo", arguments: {} }))?.result as { content: { text: string }[]; isError: boolean };
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /text is required/);
  const typed = (await call("tools/call", { name: "echo", arguments: { text: "a", times: 1.5 } }))?.result as { content: { text: string }[]; isError: boolean };
  assert.match(typed.content[0]!.text, /times must be integer/);
  const failed = (await call("tools/call", { name: "boom" }))?.result as { content: { text: string }[]; isError: boolean };
  assert.deepEqual(failed, { content: [{ type: "text", text: "It broke, try another way." }], isError: true });
});

test("checkArguments: unknown keys, enums, nullable types", () => {
  const schema = { type: "object", properties: { a: { type: ["string", "null"] }, b: { enum: ["x", null] } }, additionalProperties: false };
  assert.equal(checkArguments(schema, { a: null, b: null }), null);
  assert.match(checkArguments(schema, { c: 1 })!, /Unknown argument "c"/);
  assert.match(checkArguments(schema, { b: "y" })!, /must be one of/);
  assert.match(checkArguments(schema, { a: 3 })!, /must be string or null/);
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://desk.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const login = async () => ctx;

test("HTTP: JSON answers, 202 for notifications, 405 for GET, 403 for a foreign Origin, 400 for an unknown protocol header", async () => {
  const res = await serveMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }), fake, login);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal((await serveMcp(post({ jsonrpc: "2.0", method: "notifications/initialized" }), fake, login)).status, 202);
  const get = await serveMcp(new Request("https://desk.example/mcp"), fake, login);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await serveMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" }), fake, login)).status, 403);
  assert.equal((await serveMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://desk.example" }), fake, login)).status, 200);
  assert.equal((await serveMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" }), fake, login)).status, 400);
  const parse = await serveMcp(post("{nope"), fake, login);
  assert.equal(parse.status, 400);
  assert.equal(((await parse.json()) as { error: { code: number } }).error.code, -32700);
  const batch = await serveMcp(post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]), fake, login);
  assert.deepEqual(await batch.json(), [{ jsonrpc: "2.0", id: 1, result: {} }]);
  const refused = await serveMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }), fake, async () => new Response("no", { status: 401 }));
  assert.equal(refused.status, 401);
});

const slow: McpServer<{ who: string }> = {
  ...fake,
  tools: [
    {
      name: "slow",
      title: "Slow",
      description: "Counts, with a picture.",
      inputSchema: { type: "object" },
      long: true,
      run: async (_ctx, _args, progress) => {
        progress("Starting…", 0, 2);
        progress("one", 1, 2);
        progress("still one");
        progress("two", 2, 2);
        return { text: "done", images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }] };
      },
    },
  ],
};

test("tools/call: images follow the text; progress only with a progressToken, always growing", async () => {
  const sent: { params: { progress: number; total?: number; message: string; progressToken: unknown } }[] = [];
  const res = await handleMessage(slow, ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", _meta: { progressToken: "t1" } } }, (n) => sent.push(n as never));
  assert.deepEqual((res?.result as { content: unknown[] }).content, [{ type: "text", text: "done" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
  assert.deepEqual(sent.map((n) => n.params.message), ["Starting…", "one", "still one", "two"]);
  assert.ok(sent.every((n) => n.params.progressToken === "t1"));
  const values = sent.map((n) => n.params.progress);
  assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]!), `growing: ${values.join(", ")}`);
  const quiet: unknown[] = [];
  await handleMessage(slow, ctx, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow" } }, (n) => quiet.push(n));
  assert.equal(quiet.length, 0);
});

test("HTTP: a long tool answers as an event stream (progress, then the response) when the client takes one", async () => {
  const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow", _meta: { progressToken: 5 } } };
  const res = await serveMcp(post(call), slow, login);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const events = (await res.text()).split("\n\n").filter((e) => e.startsWith("event: message")).map((e) => JSON.parse(e.split("\ndata: ")[1]!) as { method?: string; id?: number });
  assert.deepEqual(events.map((e) => e.method ?? `response ${e.id}`), [...Array(4).fill("notifications/progress"), "response 7"]);
  // JSON-only clients get plain JSON.
  const plain = await serveMcp(post(call, { accept: "application/json" }), slow, login);
  assert.equal(plain.headers.get("content-type"), "application/json");
  assert.equal(((await plain.json()) as { id: number }).id, 7);
});
