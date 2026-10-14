// End-to-end test of D-84, desk settings as code: desk.yaml beside the agent's files. A config
// without it gets one written from the settings; saving it changes the widget's public config and
// the AI settings; the settings pages write their changes back into it as new versions; an Agent
// draft from an older version still saves when the files don't overlap. No AI calls.

import assert from "node:assert/strict";
import { parse } from "yaml";
import { Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";

const agent = new Client();
let workspaceId = "";
let widgetKey = "";
let token = "";
let original: { inbox: Record<string, unknown>; ai: { enabled: boolean; provider: string; model: string | null; monthlyReplyCap: number } };

const config = () => agent.call(`/workspaces/${workspaceId}/agent`);
const widgetConfig = async () => (await new Client().call(`/widget/${widgetKey}/config`)).json;
const put = (files: Record<string, string>, base: number | null, message = "e2e", client = agent, headers: Record<string, string> = {}) =>
  client.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files, base, message }, headers });

await step("owner signs in", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  const inbox = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox;
  widgetKey = inbox.widgetKey;
  const ai = (await agent.call(`/workspaces/${workspaceId}/ai`)).json.settings;
  original = { inbox: inbox.settings, ai };
  token = (await agent.call(`/workspaces/${workspaceId}/tokens`, { body: { name: "e2e desk.yaml" } })).json.token;
});

await step("a config without desk.yaml gets one written from the current settings (not saved)", async () => {
  const live = (await config()).json;
  const { "desk.yaml": _, ...files } = live.files as Record<string, string>;
  // Save a version without the file (as an old git folder would): settings stay as they are.
  const saved = await put(files, live.version, "without desk.yaml");
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const res = (await config()).json;
  assert.deepEqual(res.generated, ["desk.yaml"]);
  assert.deepEqual(res.issues, []);
  const desk = parse(res.files["desk.yaml"]);
  const look = await widgetConfig();
  assert.equal(desk.chat.color, look.color);
  assert.equal(desk.chat.launcher, look.launcher);
  assert.equal(desk.ai.enabled, original.ai.enabled);
  assert.equal(desk.ai.monthlyReplyCap, original.ai.monthlyReplyCap);
  assert.match(res.files["desk.yaml"], /^# desk\.yaml/);
  // An old version, asked for by number, is as it was saved.
  assert.equal((await agent.call(`/workspaces/${workspaceId}/agent?version=${res.version}`)).json.files["desk.yaml"], undefined);
});

await step("pushing desk.yaml changes the widget's public config and the AI settings", async () => {
  const live = (await config()).json;
  const text = `# Set up from git.
chat:
  color: "#5b4cff"  # brand purple
  greeting: Hello from desk.yaml
  launcher: island
  suggestedQuestions: [How much is it?, Can I invite my team?]
ai:
  monthlyReplyCap: 1234
`;
  // Problems are reported file by file and nothing is saved.
  const bad = await put({ ...live.files, "desk.yaml": "chat:\n  launcher: rocket\n  colour: red\n" }, live.version);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_config");
  assert.ok(bad.json.error.issues.every((i: { path: string }) => i.path === "desk.yaml"), JSON.stringify(bad.json.error.issues));
  assert.ok(bad.json.error.issues.some((i: { message: string }) => /chat\.launcher/.test(i.message)));
  assert.ok(bad.json.error.issues.some((i: { message: string }) => /Unknown key "chat\.colour"/.test(i.message)));

  // A CLI push (API token).
  const pushed = await put({ ...live.files, "desk.yaml": text }, live.version, "desk from git", new Client(), { authorization: `Bearer ${token}` });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
  const look = await widgetConfig();
  assert.equal(look.color, "#5b4cff");
  assert.equal(look.greeting, "Hello from desk.yaml");
  assert.equal(look.launcher, "island");
  assert.deepEqual(look.suggestions, ["How much is it?", "Can I invite my team?"]);
  const ai = (await agent.call(`/workspaces/${workspaceId}/ai`)).json.settings;
  assert.equal(ai.monthlyReplyCap, 1234);
  // Keys the file leaves out are untouched.
  assert.equal(ai.enabled, original.ai.enabled);
  assert.equal(ai.provider, original.ai.provider);
  const after = (await config()).json;
  assert.equal(after.files["desk.yaml"], text);
  assert.deepEqual(after.generated, []);
  assert.deepEqual(after.versions[0].changed, ["desk.yaml"]);
});

await step("a settings page change becomes a version whose desk.yaml has the new value (comments kept)", async () => {
  const before = (await config()).json;
  const res = await agent.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { color: "#123456", theme: "dark" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const after = (await config()).json;
  assert.equal(after.version, before.version + 1);
  assert.equal(after.versions[0].message, "Chat widget settings");
  assert.equal(after.versions[0].source, "dashboard");
  assert.deepEqual(after.versions[0].changed, ["desk.yaml"]);
  const text = after.files["desk.yaml"] as string;
  assert.match(text, /color: "#123456" # brand purple/);
  assert.match(text, /^# Set up from git\./);
  assert.match(text, /theme: dark/);
  assert.equal((await widgetConfig()).color, "#123456");
  // The same value again: no new version.
  await agent.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { color: "#123456" } });
  assert.equal((await config()).json.version, after.version);
  // Hours and assignment are named for what they are; the AI page writes ai: keys.
  await agent.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { hours: { enabled: false, timezone: "Europe/London", days: [{ day: 1, start: "09:00", end: "17:00" }], awayMessage: "Away" } } });
  const hours = (await config()).json;
  assert.equal(hours.versions[0].message, "Business hours");
  assert.equal(parse(hours.files["desk.yaml"]).hours.timeZone, "Europe/London");
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...original.ai, monthlyReplyCap: 777 } });
  const ai = (await config()).json;
  assert.equal(ai.versions[0].message, "AI settings");
  assert.equal(parse(ai.files["desk.yaml"]).ai.monthlyReplyCap, 777);
});

await step("an Agent draft from an older version still saves when it changed other files; overlapping changes conflict", async () => {
  const opened = (await config()).json;
  // While the draft is open, someone changes the widget on the Chat widget page.
  await agent.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { greeting: "Changed meanwhile" } });
  const latest = (await config()).json;
  assert.equal(latest.version, opened.version + 1);
  // The draft changed only instructions.md: merged on top of the latest.
  const agentsMd = `${opened.files["instructions.md"]}\n- Draft edit from e2e-desk.\n`;
  const merged = await put({ ...opened.files, "instructions.md": agentsMd }, opened.version, "instructions");
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  const now = (await config()).json;
  assert.equal(now.files["instructions.md"], agentsMd);
  assert.match(now.files["desk.yaml"], /greeting: Changed meanwhile/);
  assert.equal((await widgetConfig()).greeting, "Changed meanwhile");
  assert.deepEqual(now.versions[0].changed, ["instructions.md"]);
  // A draft that changed desk.yaml too, from before the settings change: a conflict.
  const conflict = await put({ ...opened.files, "desk.yaml": opened.files["desk.yaml"].replace("theme: dark", "theme: light") }, opened.version);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.json));
  assert.equal(conflict.json.error.code, "conflict");
});

await step("put the desk back as it was", async () => {
  const s = original.inbox;
  const res = await agent.call(`/workspaces/${workspaceId}/inbox`, {
    method: "PATCH",
    body: {
      color: s.color ?? "#2f5bea",
      theme: s.theme ?? "auto",
      launcher: s.launcher ?? "card",
      greeting: s.greeting ?? "",
      suggestions: s.suggestions ?? [],
      ...(s.hours ? { hours: s.hours } : {}),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: original.ai })).status, 200);
});

summary();
