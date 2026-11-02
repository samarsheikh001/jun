// End-to-end test of passkey auth against a running dev server, using a software
// authenticator (P-256 / ES256, "none" attestation) in place of a real device.
//
//   npm run dev            # in one terminal
//   npm run test:e2e       # in another (BASE_URL defaults to http://localhost:5173)
//
// Needs a fresh local database: `rm -rf .wrangler/state` then restart `npm run dev`.

import assert from "node:assert/strict";
import { Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";


const owner = new SoftAuthenticator();
const browser = new Client();

await step("fresh install reports setup needed", async () => {
  const { json } = await browser.call("/me");
  assert.deepEqual(json, { user: null, setupComplete: false });
});

await step("CSRF: cross-origin and non-JSON writes are rejected", async () => {
  assert.equal((await browser.call("/auth/login/options", { body: {}, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await browser.call("/auth/login/options", { body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 400);
});

await step("wrong setup token is refused", async () => {
  const res = await browser.call("/setup/options", { body: { token: "wrong-token-wrong-token", workspaceName: "Acme", name: "Ada", email: "ada@acme.test" } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, "bad_setup_token");
});

await step("setup creates the workspace, owner and passkey, and signs in", async () => {
  const res = await browser.register("/setup", owner, { token: SETUP_TOKEN, workspaceName: "Acme Support", name: "Ada", email: "Ada@Acme.test" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const me = await browser.call("/me");
  assert.equal(me.json.user.name, "Ada");
  assert.equal(me.json.user.email, "ada@acme.test");
  assert.equal(me.json.memberships[0].role, "owner");
  assert.equal(me.json.memberships[0].workspaceName, "Acme Support");
});

await step("setup can't run twice", async () => {
  const res = await new Client().call("/setup/options", { body: { token: SETUP_TOKEN, workspaceName: "X", name: "Eve", email: "eve@x.test" } });
  assert.equal(res.status, 409);
});

await step("sign out, then sign in with the passkey", async () => {
  await browser.call("/auth/logout", { body: {} });
  assert.equal((await browser.call("/me")).json.user, null);
  const res = await browser.login(owner);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await browser.call("/me")).json.user.name, "Ada");
});

await step("a replayed or unknown login is rejected", async () => {
  const stranger = new SoftAuthenticator();
  await stranger.create({ challenge: "x", user: { id: "u" }, rp: {} });
  const res = await new Client().login(stranger);
  assert.equal(res.status, 401);
  // Verifying without a fresh challenge (no challenge cookie) fails too.
  const replay = await new Client().call("/auth/login/verify", { body: { response: await owner.get({ challenge: "old" }) } });
  assert.equal(replay.status, 400);
});

await step("add a second passkey, remove it, but never the last one", async () => {
  const second = new SoftAuthenticator();
  assert.equal((await browser.register("/passkeys", second)).status, 200);
  const list = (await browser.call("/passkeys")).json.passkeys as { id: string }[];
  assert.equal(list.length, 2);
  assert.equal((await browser.call(`/passkeys/${encodeURIComponent(list[1]!.id)}`, { method: "DELETE" })).status, 200);
  const res = await browser.call(`/passkeys/${encodeURIComponent(list[0]!.id)}`, { method: "DELETE" });
  assert.equal(res.status, 409);
});

await step("owner invites an agent; the agent joins with a passkey; the link is single use", async () => {
  const workspaceId = (await browser.call("/me")).json.memberships[0].workspaceId as string;
  const invite = await browser.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  assert.equal(invite.status, 200);
  const token = new URL(invite.json.url).pathname.split("/").pop()!;

  const agentBrowser = new Client();
  assert.equal((await agentBrowser.call(`/invites/${token}`)).json.workspaceName, "Acme Support");
  const res = await agentBrowser.register(`/invites/${token}`, new SoftAuthenticator(), { name: "Grace", email: "grace@acme.test" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const me = (await agentBrowser.call("/me")).json;
  assert.equal(me.memberships[0].role, "agent");

  assert.equal((await new Client().call(`/invites/${token}`)).status, 410);
  const members = (await browser.call(`/workspaces/${workspaceId}/members`)).json.members as { role: string }[];
  assert.deepEqual(members.map((m) => m.role), ["owner", "agent"]);

  // Agents can't create invites.
  assert.equal((await agentBrowser.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } })).status, 403);
});

await step("team roles: admins manage agents only; nobody manages the owner; removal signs out", async () => {
  const workspaceId = (await browser.call("/me")).json.memberships[0].workspaceId as string;
  const base = `/workspaces/${workspaceId}`;
  const join = async (role: "admin" | "agent", name: string, inviter = browser) => {
    const invite = await inviter.call(`${base}/invites`, { body: { role } });
    assert.equal(invite.status, 200, JSON.stringify(invite.json));
    const token = new URL(invite.json.url).pathname.split("/").pop()!;
    const client = new Client();
    const res = await client.register(`/invites/${token}`, new SoftAuthenticator(), { name, email: `${name.toLowerCase()}@acme.test` });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return { client, id: (await client.call("/me")).json.user.id as string };
  };

  const admin = await join("admin", "Linus");
  const ownerId = (await browser.call("/me")).json.user.id as string;

  // Admins can invite agents, not admins.
  assert.equal((await admin.client.call(`${base}/invites`, { body: { role: "admin" } })).status, 403);
  const agent = await join("agent", "Ken", admin.client);

  // Admins can't touch the owner or other admins; they can manage agents.
  assert.equal((await admin.client.call(`${base}/members/${ownerId}`, { method: "DELETE" })).status, 403);
  assert.equal((await admin.client.call(`${base}/members/${ownerId}`, { method: "PATCH", body: { role: "agent" } })).status, 403);
  assert.equal((await admin.client.call(`${base}/members/${agent.id}`, { method: "PATCH", body: { role: "admin" } })).status, 403);
  // Agents can't manage anyone or see invites.
  assert.equal((await agent.client.call(`${base}/members/${admin.id}`, { method: "DELETE" })).status, 403);
  assert.equal((await agent.client.call(`${base}/invites`)).status, 403);

  // Owner promotes and demotes.
  assert.equal((await browser.call(`${base}/members/${agent.id}`, { method: "PATCH", body: { role: "admin" } })).status, 200);
  assert.equal((await browser.call(`${base}/members/${agent.id}`, { method: "PATCH", body: { role: "agent" } })).status, 200);

  // Pending invites can be listed and revoked.
  const pending = await browser.call(`${base}/invites`, { body: { role: "agent" } });
  const token = new URL(pending.json.url).pathname.split("/").pop()!;
  const list = (await browser.call(`${base}/invites`)).json.invites as { id: string }[];
  assert.equal(list.length, 1);
  assert.equal((await browser.call(`${base}/invites/${encodeURIComponent(list[0]!.id)}`, { method: "DELETE" })).status, 200);
  assert.equal((await new Client().call(`/invites/${token}`)).status, 410);

  // Admin removes the agent: the agent is signed out and their account is gone.
  assert.equal((await admin.client.call(`${base}/members/${agent.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await agent.client.call("/passkeys")).status, 401);
  assert.equal((await agent.client.call("/me")).json.user, null);
});

await step("recovery with the setup token adds a new owner passkey", async () => {
  const lostDevice = new SoftAuthenticator();
  const fresh = new Client();
  assert.equal((await fresh.call("/recover/options", { body: { token: "wrong-token-wrong-token" } })).status, 403);
  const res = await fresh.register("/recover", lostDevice, { token: SETUP_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await fresh.call("/me")).json.user.name, "Ada");
});

// D-157: email + password beside passkeys.
await step("password: set one, sign in with it, change it (other browsers signed out), remove rules", async () => {
  assert.equal((await browser.call("/password")).json.hasPassword, false);
  // No password yet: wrong-password and no-account answers look the same.
  const none = await new Client().call("/auth/password", { body: { email: "ada@acme.test", password: "whatever-long-1" } });
  assert.equal(none.status, 401);
  assert.equal(none.json.error.code, "wrong_password");

  assert.equal((await browser.call("/password", { method: "PUT", body: { password: "short" } })).json.error.code, "weak_password");
  assert.equal((await browser.call("/password", { method: "PUT", body: { password: "first long password" } })).status, 200);
  assert.equal((await browser.call("/password")).json.hasPassword, true);

  const other = new Client();
  const signIn = await other.call("/auth/password", { body: { email: "ADA@acme.test", password: "first long password" } });
  assert.equal(signIn.status, 200, JSON.stringify(signIn.json));
  assert.equal((await other.call("/me")).json.user.name, "Ada");
  // Untrimmed: a trailing space is a different password.
  assert.equal((await new Client().call("/auth/password", { body: { email: "ada@acme.test", password: "first long password " } })).status, 401);

  // Changing needs the current one, and signs out the other browser but not this one.
  assert.equal((await browser.call("/password", { method: "PUT", body: { current: "nope nope nope", password: "second long password" } })).status, 403);
  assert.equal((await browser.call("/password", { method: "PUT", body: { current: "first long password", password: "second long password" } })).status, 200);
  assert.equal((await other.call("/me")).json.user, null);
  assert.equal((await browser.call("/me")).json.user.name, "Ada");
  assert.equal((await new Client().call("/auth/password", { body: { email: "ada@acme.test", password: "second long password" } })).status, 200);

  // With a password, the last passkey can go; then the password can't.
  const keys = (await browser.call("/passkeys")).json.passkeys as { id: string }[];
  assert.ok(keys.length >= 1);
  for (const key of keys) assert.equal((await browser.call(`/passkeys/${encodeURIComponent(key.id)}`, { method: "DELETE" })).status, 200);
  assert.equal((await browser.call("/password", { method: "DELETE" })).json.error.code, "last_sign_in");
  // A passkey again, then the password can be removed.
  assert.equal((await browser.register("/passkeys", owner)).status, 200);
  assert.equal((await browser.call("/password", { method: "DELETE" })).status, 200);
  assert.equal((await new Client().call("/auth/password", { body: { email: "ada@acme.test", password: "second long password" } })).status, 401);
});

await step("password: an invitee joins with one; the link stays single use; existing account joins by signing in", async () => {
  const workspaceId = (await browser.call("/me")).json.memberships[0].workspaceId as string;
  const invite = await browser.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  const joiner = new Client();
  assert.equal((await joiner.call(`/invites/${token}/password`, { body: { name: "Hedy", email: "hedy@acme.test", password: "tiny" } })).status, 400);
  const res = await joiner.call(`/invites/${token}/password`, { body: { name: "Hedy", email: "hedy@acme.test", password: "frequency hopping 1942" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await joiner.call("/me")).json.memberships[0].role, "agent");
  assert.equal((await joiner.call("/passkeys")).json.passkeys.length, 0);
  assert.equal((await joiner.call("/password")).json.hasPassword, true);
  // Used: nobody else gets an account from it.
  const again = await new Client().call(`/invites/${token}/password`, { body: { name: "Eve", email: "eve@acme.test", password: "another long one 1" } });
  assert.equal(again.status, 410);
  assert.equal((await new Client().call("/auth/password", { body: { email: "eve@acme.test", password: "another long one 1" } })).status, 401);

  // A second workspace's invite: Hedy signs in with her password and accepts.
  const second = await browser.call("/workspaces", { body: { name: "Second" } });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const secondId = second.json.workspaceId as string;
  const invite2 = await browser.call(`/workspaces/${secondId}/invites`, { body: { role: "agent" } });
  const token2 = new URL(invite2.json.url).pathname.split("/").pop()!;
  const fresh = new Client();
  assert.equal((await fresh.call(`/invites/${token2}/password`, { body: { name: "Hedy", email: "hedy@acme.test", password: "frequency hopping 1942" } })).json.error.code, "email_taken");
  assert.equal((await fresh.call("/auth/password", { body: { email: "hedy@acme.test", password: "frequency hopping 1942" } })).status, 200);
  assert.equal((await fresh.call(`/invites/${token2}/accept`, { body: {} })).status, 200);
  assert.equal((await fresh.call("/me")).json.memberships.length, 2);
});

await step("password: guessing locks the email after 10 misses", async () => {
  const guesser = new Client();
  for (let i = 0; i < 10; i++) {
    assert.equal((await guesser.call("/auth/password", { body: { email: "hedy@acme.test", password: `guess number ${i}` } })).status, 401);
  }
  const locked = await guesser.call("/auth/password", { body: { email: "hedy@acme.test", password: "frequency hopping 1942" } });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, "too_many_attempts");
});

await step("password: the setup token sets a new owner password and signs the owner out elsewhere", async () => {
  const fresh = new Client();
  assert.equal((await fresh.call("/recover/password", { body: { token: "wrong-token-wrong-token", password: "recovered password 1" } })).status, 403);
  assert.equal((await fresh.call("/recover/password", { body: { token: SETUP_TOKEN, password: "recovered password 1" } })).status, 200);
  assert.equal((await fresh.call("/me")).json.user.name, "Ada");
  assert.equal((await browser.call("/me")).json.user, null);
  assert.equal((await browser.call("/auth/password", { body: { email: "ada@acme.test", password: "recovered password 1" } })).status, 200);
});

await step("signed-out requests to protected routes get 401", async () => {
  assert.equal((await new Client().call("/password")).status, 401);
  assert.equal((await new Client().call("/passkeys")).status, 401);
});

summary();
