import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backfillText, browserName, cardBlocks, fromSlackText, readSlackKeys, slackManifest, slackManifestUrl, SLACK_IDS, threadText, threadUsername, toSlackText,
  type CardFacts,
} from "./slack.ts";

test("the manifest points Slack at this workspace's addresses", () => {
  const m = slackManifest("https://desk.example.com", "ws_1", "Acme") as {
    display_information: { name: string };
    settings: { event_subscriptions: { request_url: string; bot_events: string[] }; interactivity: { request_url: string }; socket_mode_enabled: boolean };
    oauth_config: { scopes: { bot: string[] } };
    features: { shortcuts: { callback_id: string; type: string }[] };
  };
  assert.equal(m.display_information.name, "Acme support");
  assert.equal(m.settings.event_subscriptions.request_url, "https://desk.example.com/api/slack/ws_1/events");
  assert.equal(m.settings.interactivity.request_url, "https://desk.example.com/api/slack/ws_1/actions");
  assert.deepEqual(m.settings.event_subscriptions.bot_events, ["message.channels", "message.groups"]);
  assert.equal(m.settings.socket_mode_enabled, false);
  assert.ok(m.oauth_config.scopes.bot.includes("chat:write.customize"));
  assert.ok(m.oauth_config.scopes.bot.includes("users:read.email"));
  assert.ok(m.oauth_config.scopes.bot.includes("commands"));
  assert.deepEqual(m.features.shortcuts.map((s) => [s.type, s.callback_id]), [["message", SLACK_IDS.noteShortcut]]);
  // Slack caps an app's name at 35 characters.
  assert.ok((slackManifest("https://d", "w", "A very long workspace name that goes on") as { display_information: { name: string } }).display_information.name.length <= 35);
  const url = slackManifestUrl(m as unknown as Record<string, unknown>);
  assert.ok(url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="));
  assert.deepEqual(JSON.parse(decodeURIComponent(url.split("manifest_json=")[1]!)), m);
});

test("pasted keys are checked for shape", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(readSlackKeys({ token: " xoxb-123-456-abcdefghij ", signingSecret: secret }), { token: "xoxb-123-456-abcdefghij", signingSecret: secret });
  assert.throws(() => readSlackKeys({ token: "xoxp-123-456-abcdefghij", signingSecret: secret }), /xoxb-/);
  assert.throws(() => readSlackKeys({ token: "xoxb-123-456-abcdefghij", signingSecret: "nope" }), /Signing Secret/);
});

test("text going to Slack escapes only what Slack treats as markup", () => {
  assert.equal(toSlackText("a < b & c > d <@U123>"), "a &lt; b &amp; c &gt; d &lt;@U123&gt;");
});

test("text coming from Slack reads as plain text", () => {
  assert.equal(fromSlackText("See <https://acme.com/docs|the docs> &amp; <https://x.io>"), "See the docs (https://acme.com/docs) & https://x.io");
  assert.equal(fromSlackText("Write to <mailto:help@acme.com|help@acme.com>"), "Write to help@acme.com");
  assert.equal(fromSlackText("<!here> thanks <@U1>, see <#C123|billing>", { U1: "Ana" }), "thanks @Ana, see #billing");
  assert.equal(fromSlackText("<@U9|bo> 3 &lt; 4"), "@bo 3 < 4");
  assert.equal(fromSlackText("hi <@U2>"), "hi");
});

test("thread lines carry who wrote them, and notes say they're internal", () => {
  const line = { authorType: "visitor" as const, author: "Sam", body: "a < b", attachments: [{ name: "shot.png" }], internal: false };
  assert.equal(threadText(line), "a &lt; b\n📎 shot.png");
  assert.equal(threadUsername(line), "Sam (customer)");
  assert.equal(threadUsername({ authorType: "ai", author: "Jun" }), "Jun (AI)");
  assert.match(threadText({ ...line, authorType: "agent", author: "Ana", internal: true }), /^🔒 \*Note\*/);
  assert.equal(threadText({ ...line, body: "x".repeat(5000), attachments: [] }).length, 3500);
});

test("the backfill quotes the public chat so far", () => {
  const lines = [
    { authorType: "visitor" as const, author: "Sam", body: "Billing page\nis broken", attachments: [], internal: false },
    { authorType: "agent" as const, author: "Ana", body: "secret note", attachments: [], internal: true },
    { authorType: "ai" as const, author: "Jun", body: "Let me get someone", attachments: [], internal: false },
  ];
  const text = backfillText(lines)!;
  assert.match(text, /\*Earlier in this chat\*/);
  assert.match(text, /> \*Sam:\* Billing page is broken/);
  assert.match(text, /> \*AI:\* Let me get someone/);
  assert.doesNotMatch(text, /secret note/);
  assert.equal(backfillText([lines[1]!]), null);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...lines[0]!, body: `m${i}` }));
  assert.match(backfillText(many)!, /_8 earlier messages in the desk_/);
});

const facts: CardFacts = {
  conversationId: "cnv_1",
  contact: "Sam Lee",
  contactEmail: "sam@acme.com",
  status: "open",
  handling: "human",
  assignee: null,
  reason: "Refund request",
  brief: "Wants a refund for <the> double charge.",
  page: "/billing",
  browser: "Chrome on macOS",
  issues: 2,
  deskUrl: "https://desk.example.com/w/acme/inbox/cnv_1",
};

test("the card shows the chat and its buttons", () => {
  const card = cardBlocks(facts);
  const json = JSON.stringify(card.blocks);
  assert.match(json, /Sam Lee · sam@acme.com/);
  assert.match(json, /Waiting for the team/);
  assert.match(json, /Refund request/);
  assert.match(json, /&lt;the&gt;/);
  assert.match(json, /2 errors in the browser/);
  const actions = (card.blocks as { type: string; elements?: { action_id?: string; value?: string; url?: string }[] }[]).find((b) => b.type === "actions")!.elements!;
  assert.deepEqual(actions.map((a) => a.action_id), [SLACK_IDS.assign, SLACK_IDS.close, SLACK_IDS.open]);
  assert.equal(actions[0]!.value, "cnv_1");
  assert.equal(actions[2]!.url, facts.deskUrl);
});

test("the card's key changes only when what it shows changes", () => {
  const a = cardBlocks(facts);
  assert.equal(cardBlocks({ ...facts }).key, a.key);
  const assigned = cardBlocks({ ...facts, assignee: "Ana" });
  assert.notEqual(assigned.key, a.key);
  assert.match(assigned.text, /Ana has it/);
  const closed = cardBlocks({ ...facts, status: "resolved" });
  const ids = (closed.blocks as { type: string; elements?: { action_id?: string }[] }[]).find((b) => b.type === "actions")!.elements!.map((e) => e.action_id);
  assert.deepEqual(ids, [SLACK_IDS.reopen, SLACK_IDS.open]);
});

test("browser names", () => {
  assert.equal(browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"), "Chrome on macOS");
  assert.equal(browserName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
  assert.equal(browserName(""), null);
});
