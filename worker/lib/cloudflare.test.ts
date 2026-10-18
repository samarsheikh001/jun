import assert from "node:assert/strict";
import test from "node:test";
import { cloudflareApi, findWorkerName, listZones, runEmailSetup } from "./cloudflare.ts";

type Handler = (method: string, path: string, body: unknown) => { status?: number; result?: unknown; errors?: string[]; totalPages?: number };

/** A fake api.cloudflare.com: records each call, answers from `handler`. */
function fake(handler: Handler) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body, auth: new Headers(init.headers).get("authorization") });
    const r = handler(init.method ?? "GET", path, body);
    const status = r.status ?? 200;
    const ok = status < 400 && !r.errors;
    return new Response(JSON.stringify({ success: ok, errors: (r.errors ?? []).map((message) => ({ code: 1000, message })), result: r.result ?? null, result_info: { total_pages: r.totalPages ?? 1 } }), { status });
  }) as typeof fetch;
  return { call: cloudflareApi("tok", fetcher), calls };
}

const zones = [{ id: "z1", name: "acme.com", accountId: "a1" }];

test("zones are listed across pages with the bearer token", async () => {
  const { call, calls } = fake((_m, path) => ({ result: [{ id: path.includes("page=1") ? "z1" : "z2", name: "x.com", account: { id: "a1" } }], totalPages: 2 }));
  const listed = await listZones(call);
  assert.deepEqual(listed.map((z) => z.id), ["z1", "z2"]);
  assert.equal(calls[0]!.auth, "Bearer tok");
});

test("the Worker is found by workers.dev name, else by its custom domain", async () => {
  const { call } = fake(() => ({ result: [{ hostname: "help.acme.com", service: "jun-desk" }] }));
  assert.equal(await findWorkerName(call, "desk.samar.workers.dev", []), "desk");
  assert.equal(await findWorkerName(call, "help.acme.com", ["a1"]), "jun-desk");
});

test("a fresh domain: sending, routing, subaddressing and the rule are all set up", async () => {
  const { call, calls } = fake((method, path) => (method === "GET" ? { result: [] } : { result: {} }));
  const steps = await runEmailSetup(call, { zones, fromDomain: "acme.com", replyDomain: "reply.acme.com", workerName: "jun-desk" });
  assert.deepEqual(steps.map((s) => [s.id, s.ok]), [["sending", true], ["routing", true], ["subaddress", true], ["rule", true]]);
  const writes = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [
    "POST /zones/z1/email/sending/subdomains",
    "POST /zones/z1/email/routing/dns",
    "PATCH /zones/z1/email/routing",
    "POST /zones/z1/email/routing/rules",
  ]);
  assert.deepEqual(writes[0]!.body, { name: "acme.com" });
  assert.deepEqual(writes[1]!.body, { name: "reply.acme.com" });
  assert.deepEqual(writes[2]!.body, { support_subaddress: true });
  assert.deepEqual(writes[3]!.body, {
    name: "Jun desk: customers' email replies",
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: "reply@reply.acme.com" }],
    actions: [{ type: "worker", value: ["jun-desk"] }],
  });
});

test("done before: nothing is written twice; an old rule is pointed at this Worker", async () => {
  const { call, calls } = fake((method, path) => {
    if (path.endsWith("/sending/subdomains") && method === "GET") return { result: [{ name: "acme.com", enabled: true }] };
    if (path.endsWith("/routing/dns")) return { status: 400, errors: ["Email Routing is already enabled"] };
    if (path.includes("/routing/rules") && method === "GET") return { result: [{ id: "r9", matchers: [{ type: "literal", field: "to", value: "reply@acme.com" }], actions: [{ type: "worker", value: ["old-desk"] }] }] };
    return { result: {} };
  });
  const steps = await runEmailSetup(call, { zones, fromDomain: "acme.com", replyDomain: "acme.com", workerName: "jun-desk" });
  assert.ok(steps.every((s) => s.ok), JSON.stringify(steps));
  assert.equal(steps[0]!.detail, "Already on.");
  assert.equal(steps[1]!.detail, "Already on.");
  assert.ok(!calls.some((c) => c.method === "POST" && c.path.endsWith("/sending/subdomains")));
  assert.ok(calls.some((c) => c.method === "PUT" && c.path === "/zones/z1/email/routing/rules/r9"));
});

test("a missing permission or domain fails only its own steps, and says what to do", async () => {
  const { call } = fake((method, path) => (path.includes("/sending/") ? { status: 403, errors: ["Authentication error"] } : method === "GET" ? { result: [] } : { result: {} }));
  const steps = await runEmailSetup(call, { zones, fromDomain: "acme.com", replyDomain: "reply.other.org", workerName: null });
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  assert.equal(byId.sending!.ok, false);
  assert.match(byId.sending!.detail, /"Email Sending: Edit"/);
  assert.equal(byId.routing!.ok, false);
  assert.match(byId.routing!.detail, /reply\.other\.org isn't a domain in this Cloudflare account/);
});
