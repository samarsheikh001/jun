// End-to-end test of M6: identity verification (V-03), merging visitors (V-04), attributes
// (V-05), the live visitor list over the loader's socket (V-01) and agent-started chats (V-07),
// plus the AI using the verified customer in a tool ({user.id}). real AI (E2E_AI_PROVIDER, default ChatGPT) for the last step.

import assert from "node:assert/strict";
import { signIdentityToken } from "../worker/lib/identity.ts";
import { AI_PROVIDER, BASE, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const AI_TIMEOUT = 120_000;
// Unique per run, so the suite can run again on the same database.
const RUN = crypto.randomUUID().slice(0, 8);
const ADA = `ada-${RUN}`;
const GRACE = `grace-${RUN}`;
const ECHO_URL = process.env.ECHO_URL ?? "https://httpbin.org/anything";
const agent = new Client();
let workspaceId = "";
let widgetKey = "";
let secret = "";
let agentName = "";

const userToken = async (sub: string, extra: Record<string, unknown> = {}, key = secret) =>
  signIdentityToken({ sub, exp: Math.floor(Date.now() / 1000) + 600, ...extra }, key);

async function newVisitor() {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  return { visitor, token };
}

async function startConversation(token: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await new Client().call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: crypto.randomUUID(), body, ...extra },
    headers: { "X-Visitor-Token": token },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.conversation;
}

const listConversations = async (token: string) =>
  (await new Client().call(`/widget/${widgetKey}/conversations`, { headers: { "X-Visitor-Token": token } })).json.conversations as { id: string }[];

const identify = (token: string | null, jwt: string) =>
  new Client().call(`/widget/${widgetKey}/identify`, { body: { userToken: jwt }, headers: token ? { "X-Visitor-Token": token } : {} });

await step("owner signs in, turns the AI off for now, and creates an identity secret", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  const me = (await agent.call("/me")).json;
  workspaceId = me.memberships[0].workspaceId;
  agentName = me.user.name;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false, provider: AI_PROVIDER, monthlyReplyCap: 1000 } });
  const res = await agent.call(`/workspaces/${workspaceId}/identity`, { body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  secret = res.json.secret;
  assert.match(secret, /^jis_/);
  assert.equal((await agent.call(`/workspaces/${workspaceId}/identity`)).json.secret, secret);
});

let ada = "";

await step("an anonymous visitor identifies with a signed token and becomes a verified contact", async () => {
  const { token } = await newVisitor();
  const conversation = await startConversation(token, "Hi, question about billing");
  // Forged, expired and wrong-secret tokens are refused.
  assert.equal((await identify(token, await userToken(ADA, {}, "wrong secret"))).status, 401);
  assert.equal((await identify(token, await signIdentityToken({ sub: ADA, exp: Math.floor(Date.now() / 1000) - 600 }, secret))).status, 401);

  const res = await identify(token, await userToken(ADA, { email: "ada@acme.test", name: "Ada Lovelace", attributes: { plan: "pro", seats: 12 } }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.token, token, "an anonymous browser keeps its token");
  ada = token;
  const summary = (await agent.call(`/conversations/${conversation.id}`)).json.conversation;
  assert.equal(summary.contact.name, "Ada Lovelace");
  assert.equal(summary.contact.verified, true);
  const contact = (await agent.call(`/workspaces/${workspaceId}/contacts/${summary.contact.id}`)).json.contact;
  assert.deepEqual(contact.attributes, { plan: "pro", seats: 12 });
  assert.equal(contact.externalId, ADA);
});

await step("on a second device, Ada's anonymous chat merges into her contact", async () => {
  const { token } = await newVisitor();
  const phone = await startConversation(token, "Sent from my phone");
  const res = await identify(token, await userToken(ADA, { email: "ada@acme.test", name: "Ada Lovelace" }));
  assert.equal(res.status, 200);
  assert.equal(res.json.token, token);
  const fromPhone = (await listConversations(token)).map((c) => c.id);
  const fromLaptop = (await listConversations(ada)).map((c) => c.id);
  assert.ok(fromPhone.includes(phone.id));
  assert.deepEqual(new Set(fromPhone), new Set(fromLaptop), "both browsers see all of Ada's chats");
  assert.equal(fromLaptop.length, 2);
  assert.equal((await agent.call(`/conversations/${phone.id}`)).json.conversation.contact.verified, true);
});

await step("on a shared computer, another user never inherits Ada's history", async () => {
  const res = await identify(ada, await userToken(GRACE, { name: "Grace Hopper" }));
  assert.equal(res.status, 200);
  assert.notEqual(res.json.token, ada, "a different user gets a different browser token");
  assert.deepEqual(await listConversations(res.json.token), []);
  assert.equal((await listConversations(ada)).length, 2, "Ada's own token still works for Ada");
  // No token at all: same, a fresh token for that user.
  const fresh = await identify(null, await userToken(ADA));
  assert.equal(fresh.status, 200);
  assert.equal((await listConversations(fresh.json.token)).length, 2);
});

await step("V-11: people of one company are grouped; agents see the company and its other people's chats", async () => {
  const acme = { id: "org_acme", name: "Acme", attributes: { plan: "enterprise", seats: 40 } };
  assert.equal((await identify(ada, await userToken(ADA, { name: "Ada Lovelace", company: { name: "No id" } }))).status, 401);
  assert.equal((await identify(ada, await userToken(ADA, { name: "Ada Lovelace", company: acme }))).status, 200);
  const { token } = await newVisitor();
  const graceChat = await startConversation(token, "Our invoices look wrong");
  assert.equal((await identify(token, await userToken(GRACE, { name: "Grace Hopper", company: { ...acme, attributes: { plan: "enterprise", seats: 41 } } }))).status, 200);
  const adaChat = (await listConversations(ada))[0]!;
  const summary = (await agent.call(`/conversations/${adaChat.id}`)).json.conversation;
  const company = (await agent.call(`/workspaces/${workspaceId}/contacts/${summary.contact.id}`)).json.contact.company;
  assert.equal(company.externalId, "org_acme");
  assert.equal(company.name, "Acme");
  assert.deepEqual(company.attributes, { plan: "enterprise", seats: 41 }, "the latest token's attributes win");
  assert.equal(company.people, 2);
  assert.deepEqual(company.conversations.map((c: { id: string }) => c.id), [graceChat.id], "only the other people's chats");
  assert.equal(company.conversations[0].contactName, "Grace Hopper");
});

// V-18 (D-147, D-148): browsers sharing an email or user id are one person on the desk, never in the widget.
const profile = (token: string, body: Record<string, unknown>) =>
  new Client().call(`/widget/${widgetKey}/profile`, { body, headers: { "X-Visitor-Token": token } });
const contactOf = async (conversationId: string) => (await agent.call(`/conversations/${conversationId}`)).json.conversation.contact.id as string;
const contact = async (id: string) => (await agent.call(`/workspaces/${workspaceId}/contacts/${id}`)).json.contact as { verified: boolean; linked: { id: string; verified: boolean }[] };
const personChats = async (id: string) => (await agent.call(`/workspaces/${workspaceId}/contacts/${id}/conversations`)).json.conversations as { id: string; contactId: string }[];
const SAM = `sam-${RUN}@example.test`;
let samFirst = "";
let samSecond = "";
let samSecondToken = "";

await step("V-18: two browsers with one email are one person for agents; each widget sees only its own chats", async () => {
  const first = await newVisitor();
  const second = await newVisitor();
  samSecondToken = second.token;
  assert.equal((await profile(first.token, { name: "Sam", email: SAM })).json.verified, false);
  const chat = await startConversation(first.token, "Where is my invoice?");
  assert.equal((await profile(second.token, { email: SAM.toUpperCase() })).status, 200);
  samFirst = await contactOf(chat.id);
  assert.deepEqual(await listConversations(second.token), [], "the second browser never sees the first one's chat");
  const linked = (await contact(samFirst)).linked;
  assert.equal(linked.length, 1);
  samSecond = linked[0]!.id;
  assert.deepEqual((await personChats(samSecond)).map((c) => [c.id, c.contactId]), [[chat.id, samFirst]], "agents see the person's chats from either browser");
  const people = (await agent.call(`/workspaces/${workspaceId}/people?q=${encodeURIComponent(SAM)}`)).json.people as { id: string; linked?: number; conversations: number }[];
  assert.equal(people.length, 1, "one row per person");
  assert.equal(people[0]!.linked, 1);
  assert.equal(people[0]!.conversations, 1);
});

await step("V-18: a user id links browsers too, and a browser with both joins the two groups", async () => {
  const byId = await newVisitor();
  const both = await newVisitor();
  await profile(byId.token, { id: `u-${RUN}` });
  await profile(both.token, { id: `u-${RUN}`, email: SAM });
  assert.equal((await contact(samFirst)).linked.length, 3);
  // Malformed fields are dropped, never stored.
  assert.equal((await profile(byId.token, { id: "a\nb", email: "not-an-email" })).status, 200);
  assert.equal((await contact(samFirst)).linked.length, 3);
});

await step("V-18: an anonymous browser with a verified user's email joins them for agents, but stays unverified and sees nothing of theirs", async () => {
  const { token } = await newVisitor();
  await profile(token, { email: "ada@acme.test" });
  assert.deepEqual(await listConversations(token), []);
  const adaContact = await contactOf((await listConversations(ada))[0]!.id);
  const adaPerson = await contact(adaContact);
  assert.equal(adaPerson.verified, true);
  assert.equal(adaPerson.linked.length, 1);
  assert.equal(adaPerson.linked[0]!.verified, false);
});

await step("D-148: agents unlink a browser (matching then leaves it alone) and can't link two signed-in users", async () => {
  assert.equal((await agent.call(`/workspaces/${workspaceId}/contacts/${samSecond}/unlink`, { body: {} })).status, 200);
  assert.equal((await contact(samFirst)).linked.length, 2);
  await profile(samSecondToken, { email: SAM, name: "Sam again" });
  assert.equal((await contact(samSecond)).linked.length, 0, "the agent's unlink wins over the matching email");
  assert.equal((await agent.call(`/workspaces/${workspaceId}/contacts/${samSecond}/link`, { body: { with: samFirst } })).status, 200);
  assert.equal((await contact(samFirst)).linked.length, 3);
  const adaContact = await contactOf((await listConversations(ada))[0]!.id);
  const grace = (await agent.call(`/workspaces/${workspaceId}/people?q=${encodeURIComponent("Grace Hopper")}`)).json.people[0].id as string;
  const refused = await agent.call(`/workspaces/${workspaceId}/contacts/${adaContact}/link`, { body: { with: grace } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, "both_verified");
});

let agentHub: TestSocket;
let live: TestSocket;
const SESSION = `e2e${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

await step("the loader's live socket (from the customer's site) shows the visitor to agents", async () => {
  agentHub = new TestSocket(`/api/workspaces/${workspaceId}/ws`, { headers: { cookie: cookieHeader(agent) } });
  await agentHub.opened;
  await agentHub.next((e) => e.type === "visitors");
  live = new TestSocket(`/api/widget/${widgetKey}/live?s=${SESSION}`, { headers: { Origin: "https://customer.example" } });
  await live.opened;
  live.send({ t: "page", url: "https://customer.example/pricing", title: "Pricing", ref: "https://google.com/", start: Date.now() - 65_000, lang: "en-GB", tz: "Europe/London" });
  const seen = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION);
  assert.equal(seen.visitor.page.url, "https://customer.example/pricing");
  assert.equal(seen.visitor.pages, 1);
  assert.equal(seen.visitor.contact, null);
  assert.ok(Date.now() - seen.visitor.startedAt >= 60_000);
  live.send({ t: "page", url: "https://customer.example/billing", title: "Billing" });
  const moved = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION && e.visitor.pages === 2);
  assert.equal(moved.visitor.page.title, "Billing");
  // Bad sessions are refused; visitors never receive inbox events.
  assert.equal((await new Client().call(`/widget/${widgetKey}/live?s=x`)).status, 400);
});

await step("the live socket identifies the visitor (bad tokens are refused)", async () => {
  live.send({ t: "id", token: "nope" });
  assert.equal((await live.next((e) => e.t === "id")).ok, false);
  live.send({ t: "id", token: await userToken(ADA, { name: "Ada Lovelace", email: "ada@acme.test" }) });
  assert.equal((await live.next((e) => e.t === "id")).ok, true);
  const seen = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION && e.visitor.contact?.verified);
  assert.equal(seen.visitor.contact.name, "Ada Lovelace");
  assert.ok(!live.events.some((e) => e.type === "conversation" || e.type === "presence" || e.type === "visitor"));
});

let inviteId = "";
let inviteChat = "";

await step("an agent starts a chat with a live visitor: the invite reaches only their page", async () => {
  const res = await agent.call(`/workspaces/${workspaceId}/visitors/${SESSION}/invite`, { body: { body: "Hi Ada! Anything I can help with on billing?" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const invite = await live.next((e) => e.t === "invite");
  assert.equal(invite.body, "Hi Ada! Anything I can help with on billing?");
  assert.match(invite.from, new RegExp(`^${agentName} from `));
  inviteId = invite.id;
  assert.equal((await agent.call(`/workspaces/${workspaceId}/visitors/nobody-here-123/invite`, { body: { body: "hello?" } })).status, 410);
});

await step("replying to the invite starts a conversation with the agent, assigned to them", async () => {
  const conversation = await startConversation(ada, "Yes please, my invoice looks wrong", { inviteId, sessionId: SESSION });
  assert.equal(conversation.handling, "human");
  assert.ok(conversation.assigneeId, "assigned to the inviting agent");
  inviteChat = conversation.id;
  const messages = (await agent.call(`/conversations/${conversation.id}`)).json.messages;
  assert.deepEqual(messages.map((m: { authorType: string }) => m.authorType), ["agent", "visitor"]);
  assert.equal(messages[0].body, "Hi Ada! Anything I can help with on billing?");
  const inChat = await agentHub.next((e) => e.type === "visitor" && e.visitor.sessionId === SESSION && e.visitor.inChat);
  assert.equal(inChat.visitor.inChat, true);
  // An invite is single use.
  const again = await startConversation(ada, "another one", { inviteId, sessionId: SESSION });
  const againMessages = (await agent.call(`/conversations/${again.id}`)).json.messages;
  assert.deepEqual(againMessages.map((m: { authorType: string }) => m.authorType), ["visitor"]);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const replies = (socket: TestSocket) => socket.events.filter((e) => e.t === "reply").length;

await step("D-128: a public reply signals the visitor's live socket (only the chat's id); a note doesn't", async () => {
  await sleep(2500); // past the throttle window of the invite's own signal
  live.events.length = 0;
  const note = await agent.call(`/conversations/${inviteChat}/messages`, { body: { body: "internal: check her invoice", internal: true } });
  assert.equal(note.status, 200);
  await sleep(2500);
  assert.equal(replies(live), 0, "an internal note sends no signal");
  assert.equal((await agent.call(`/conversations/${inviteChat}/messages`, { body: { body: "Found it, fixing now" } })).status, 200);
  const signal = await live.next((e) => e.t === "reply");
  assert.deepEqual(signal, { t: "reply", conversationId: inviteChat });
  // A burst: one signal now, at most one trailing one for the rest.
  await sleep(2500);
  live.events.length = 0;
  for (const body of ["one", "two", "three"]) await agent.call(`/conversations/${inviteChat}/messages`, { body: { body } });
  await live.next((e) => e.t === "reply");
  await sleep(3000);
  assert.ok(replies(live) <= 1, `at most one trailing signal, got ${replies(live) + 1} in all`);
});

await step("D-128: an anonymous frame links its session; other visitors' sockets hear nothing", async () => {
  live.events.length = 0;
  const { token } = await newVisitor();
  const chat = await startConversation(token, "Anonymous question");
  const session = `e2e${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const mine = new TestSocket(`/api/widget/${widgetKey}/live?s=${session}`, { headers: { Origin: "https://customer.example" } });
  const other = new TestSocket(`/api/widget/${widgetKey}/live?s=x${session}`, { headers: { Origin: "https://customer.example" } });
  await Promise.all([mine.opened, other.opened]);
  const link = (body: unknown, headers: Record<string, string>) => new Client().call(`/widget/${widgetKey}/live/link`, { body, headers });
  assert.equal((await link({ sessionId: session }, {})).status, 401, "needs the visitor token");
  assert.equal((await link({ sessionId: "bad" }, { "X-Visitor-Token": token })).status, 400);
  assert.equal((await link({ sessionId: session }, { "X-Visitor-Token": token })).status, 200);
  assert.equal((await agent.call(`/conversations/${chat.id}/messages`, { body: { body: "Hello there" } })).status, 200);
  assert.deepEqual(await mine.next((e) => e.t === "reply"), { t: "reply", conversationId: chat.id });
  await sleep(500);
  assert.equal(replies(other), 0);
  assert.equal(replies(live), 0, "Ada's socket doesn't hear another contact's chat");
  mine.close();
  other.close();
});

await step("when the visitor leaves, agents see them go", async () => {
  live.close();
  await agentHub.next((e) => e.type === "visitor_left" && e.sessionId === SESSION);
  agentHub.close();
});

await step("the AI looks up the signed-in customer's own account with {user.id}, the desk's key and the customer's own key", async () => {
  // AI-24: a key pasted on the Agent page (never returned, only its last 4) and the customer's own
  // key from their identity token's `secrets` claim, both sent as headers and masked in what comes back.
  const pasted = await agent.call(`/workspaces/${workspaceId}/action-secrets/DESK_KEY`, { method: "PUT", body: { value: "desk_key_0123456789" } });
  assert.equal(pasted.status, 200, JSON.stringify(pasted.json));
  const keys = (await agent.call(`/workspaces/${workspaceId}/action-secrets`)).json.secrets;
  assert.deepEqual(keys.find((k: { name: string }) => k.name === "DESK_KEY"), { name: "DESK_KEY", source: "desk", last4: "6789" });
  assert.ok(!JSON.stringify(keys).includes("desk_key_0123456789"));
  const live = (await agent.call(`/workspaces/${workspaceId}/agent`)).json;
  const files = {
    ...live.files,
    "actions/my_account.yaml": `description: The signed-in customer's own account (plan, seats). Use it for questions about their plan or account.
url: ${ECHO_URL}/accounts/{user.id}
headers:
  X-Desk-Key: '{secrets.DESK_KEY}'
  X-User-Token: 'Bearer {user.secrets.API_TOKEN}'
query:
  plan: '{user.plan}'
  seats: '{user.seats}'
pick: [args, url, headers]
`,
  };
  const saved = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files, base: live.version, message: "my_account tool" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 1000 } });

  const { token } = await newVisitor();
  await identify(token, await userToken(ADA, { name: "Ada Lovelace", email: "ada@acme.test", attributes: { plan: "pro", seats: 12 }, secrets: { API_TOKEN: "usr_tok_0123456789" } }));
  // Plan and seats are also in the prompt (verified attributes), so ask for the account record
  // itself: only the tool has it.
  const conversation = await startConversation(token, "Can you pull up my account record and tell me which plan it shows?");
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversation.id}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  const event = await socket.next(
    (e) => (e.type === "message" && ["ai", "system"].includes(e.message.authorType)) || (e.type === "messages" && e.messages.some((m: { authorType: string }) => ["ai", "system"].includes(m.authorType))),
    AI_TIMEOUT,
  );
  const reply = event.type === "message" ? event.message : event.messages.find((m: { authorType: string }) => ["ai", "system"].includes(m.authorType));
  socket.close();
  assert.equal(reply.authorType, "ai", reply.body);
  assert.match(reply.body, /pro/i, reply.body);
  const actions = (await agent.call(`/conversations/${conversation.id}/actions`)).json.actions;
  const call = actions.find((a: { tool: string }) => a.tool === "my_account");
  assert.ok(call, `expected a my_account call; got ${JSON.stringify(actions)} and reply: ${reply.body}`);
  assert.equal(call.status, "ok");
  assert.ok(call.output.includes(`accounts/${ADA}`), call.output);
  // Both keys went out (the echo has the headers) and neither comes back in the clear.
  assert.match(call.output, /X-Desk-Key/i, call.output);
  assert.match(call.output, /"X-User-Token":\s*"Bearer ••••"/i, call.output);
  assert.ok(!call.output.includes("0123456789"), call.output);
  await agent.call(`/workspaces/${workspaceId}/action-secrets/DESK_KEY`, { method: "DELETE" });
});

await step("domain restriction: only allowed websites get the live list, nudges and the chat frame", async () => {
  const bad = await agent.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { allowedDomains: "acme..com" } });
  assert.equal(bad.status, 400);
  const set = await agent.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { allowedDomains: "https://customer.example/, *.shop.example" } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.deepEqual(set.json.settings.allowedDomains, ["customer.example", "*.shop.example"]);

  const allowed = new TestSocket(`/api/widget/${widgetKey}/live?s=allowed123456`, { headers: { Origin: "https://eu.shop.example" } });
  await allowed.opened;
  allowed.close();
  const blocked = new TestSocket(`/api/widget/${widgetKey}/live?s=blocked123456`, { headers: { Origin: "https://copycat.example" } });
  await assert.rejects(blocked.opened);

  const nudge = (origin: string) =>
    fetch(`${BASE}/api/widget/${widgetKey}/nudge`, { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: JSON.stringify({ event: { t: 1, kind: "error", message: "boom" }, page: { url: "https://x/", title: "X" } }) }).then((r) => r.json() as Promise<{ show: boolean; text?: string }>);
  assert.deepEqual(await nudge("https://copycat.example"), { show: false });
  assert.equal((await nudge("https://customer.example")).show, true);

  const frame = await fetch(`${BASE}/widget?key=${widgetKey}`);
  assert.equal(frame.status, 200);
  assert.match(await frame.text(), /<div id="root">|<html/i);
  const csp = frame.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^frame-ancestors 'self' https:\/\/customer\.example:\*/);
  assert.doesNotMatch(csp, /copycat/);

  // Back to "any website" for the other suites.
  await agent.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { allowedDomains: "" } });
  assert.equal((await fetch(`${BASE}/widget?key=${widgetKey}`)).headers.get("content-security-policy"), "frame-ancestors *");
});

summary();
