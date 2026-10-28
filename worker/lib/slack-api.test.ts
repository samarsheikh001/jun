import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackError, slackApi, validSlackSignature } from "./slack-api.ts";

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

test("Slack's request signature: right secret, raw body, recent timestamp", async () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"event_callback","event_id":"Ev1"}';
  const signature = await sign(secret, ts, body);
  assert.equal(await validSlackSignature(secret, ts, signature, body, now), true);
  assert.equal(await validSlackSignature("another-secret", ts, signature, body, now), false);
  assert.equal(await validSlackSignature(secret, ts, signature, `${body} `, now), false);
  // Older than 5 minutes: a replay.
  assert.equal(await validSlackSignature(secret, ts, signature, body, now + 301_000), false);
  assert.equal(await validSlackSignature(secret, null, signature, body, now), false);
  assert.equal(await validSlackSignature(secret, ts, null, body, now), false);
});

const env = {};

test("API calls send the bot token and read Slack's errors", async () => {
  const seen: { url: string; auth: string | null; body: string }[] = [];
  const api = slackApi(env, "xoxb-1", (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
    if (url.endsWith("chat.postMessage")) return Response.json({ ok: true, ts: "1.2", channel: "C1" });
    return Response.json({ ok: false, error: "channel_not_found" });
  }) as typeof fetch);
  const posted = await api.postMessage({ channel: "C1", text: "hi" });
  assert.deepEqual(posted, { ok: true, ts: "1.2", channel: "C1" });
  assert.equal(seen[0]!.url, "https://slack.com/api/chat.postMessage");
  assert.equal(seen[0]!.auth, "Bearer xoxb-1");
  assert.equal(JSON.parse(seen[0]!.body).unfurl_links, false);
  await assert.rejects(api.update({ channel: "C1", ts: "1.2" }), (e: unknown) => e instanceof SlackError && e.code === "channel_not_found");
});

test("a short rate limit is waited out once", async () => {
  let calls = 0;
  const api = slackApi(env, "xoxb-1", (async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ ok: true, ts: "1", channel: "C" });
  }) as typeof fetch);
  await api.postMessage({ channel: "C", text: "x" });
  assert.equal(calls, 2);
});

test("SLACK_API_URL points the client elsewhere", async () => {
  let url = "";
  const api = slackApi({ SLACK_API_URL: "http://127.0.0.1:9/api/" }, "xoxb-1", (async (u: string) => {
    url = u;
    return Response.json({ ok: true, team_id: "T1", team: "Acme", url: "https://acme.slack.com/", user_id: "U0" });
  }) as typeof fetch);
  await api.authTest();
  assert.equal(url, "http://127.0.0.1:9/api/auth.test");
});
