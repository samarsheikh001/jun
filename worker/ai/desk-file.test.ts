import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDesk, deskChanges, deskFromSettings, deskLeaves, parseDeskFile, readModel, readReplyCap, renderDeskFile, updateDeskText, type DeskAi, type DeskIssue } from "./desk-file.ts";
import { changedPaths, defaultFiles, mergeConfigs, parseConfig } from "./config.ts";

const AI: DeskAi = { enabled: true, model: null, models: {}, monthlyReplyCap: 2000 };

/** A desk with most settings changed from the defaults. */
const SETTINGS: Record<string, unknown> = {
  displayName: "Acme",
  color: "#5b4cff",
  mode: "island",
  greetingCard: false,
  islandSurface: "page",
  neon: false,
  buttonStyle: "text",
  theme: "dark",
  radius: 10,
  position: "left",
  sound: false,
  greeting: "Hello there",
  replyTime: "Back in an hour",
  placeholder: "Ask us",
  suggestions: ["How much is it?", "Can I invite my team?"],
  csat: false,
  proactive: false,
  pageControl: true,
  pageControlConfirm: "every-time",
  allowedDomains: ["acme.com", "*.acme.dev"],
  openers: [
    { id: "op_pricing01", path: "/pricing", delay: 20, text: null, hint: "help choosing a plan" },
    { id: "op_docs0001", path: "/docs/*", delay: 45, text: "Stuck? Ask us." },
  ],
  hours: { enabled: true, timezone: "Europe/London", days: [{ day: 1, start: "09:00", end: "17:30" }, { day: 5, start: "10:00", end: "16:00" }], awayMessage: "Away until {when}." },
  assignment: { mode: "round_robin", capacity: 5 },
  logoKey: "logo_abc",
};

const parse = (text: string) => {
  const issues: DeskIssue[] = [];
  const desk = parseDeskFile(text, issues);
  return { desk, issues };
};

test("D-84: settings → desk.yaml → parse is the same desk, and applying it gives the same settings", () => {
  const desk = deskFromSettings(SETTINGS, { ...AI, model: "gpt-5.5", models: { editor: "gpt-6-astra" } });
  const text = renderDeskFile(desk);
  assert.match(text, /^# desk\.yaml/);
  assert.match(text, /mode: island {2}# island \(/);
  assert.match(text, /greetingCard: false {2}# window: /);
  assert.ok(!text.includes("launcher"), "the old key isn't written");
  assert.match(text, /monday: 09:00-17:30/);
  assert.ok(!/logoKey|logo_abc|logo:/.test(text), "uploads aren't in the file");
  const { desk: back, issues } = parse(text);
  assert.deepEqual(issues, []);
  assert.deepEqual(back, desk);
  const applied = applyDesk(back, {}, { enabled: false, model: null, models: {}, monthlyReplyCap: 10 }, () => "op_new00001");
  const { logoKey: _, ...expected } = SETTINGS;
  assert.deepEqual(applied.settings, { ...expected, openers: [{ id: "op_new00001", path: "/pricing", delay: 20, text: null, hint: "help choosing a plan" }, { id: "op_new00001", path: "/docs/*", delay: 45, text: "Stuck? Ask us." }] });
  assert.deepEqual(applied.ai, { enabled: true, model: "gpt-5.5", models: { editor: "gpt-6-astra" }, monthlyReplyCap: 2000 });
  assert.equal(applied.inboxChanged, true);
});

test("D-84: a fresh desk's file is complete and valid, and applying it to the same desk changes nothing", () => {
  const desk = deskFromSettings({}, AI);
  const text = renderDeskFile(desk);
  assert.deepEqual(parse(text).issues, []);
  assert.match(text, /model: default/);
  assert.match(text, /allowedWebsites: \[\] {2}#/);
  // Its own settings on the same desk: nothing that matters changes (texts become explicit words).
  const applied = applyDesk(parse(text).desk, {}, AI, () => "op_x0000001");
  assert.equal(applied.aiChanged, false);
  assert.deepEqual(deskFromSettings(applied.settings, applied.ai), desk);
});

test("D-84: absent means untouched", () => {
  const { desk, issues } = parse("chat:\n  color: '#112233'\n");
  assert.deepEqual(issues, []);
  const applied = applyDesk(desk, SETTINGS, AI, () => "op_new00001");
  assert.deepEqual(applied.settings, { ...SETTINGS, color: "#112233" });
  assert.equal(applied.aiChanged, false);
  // An empty file, or one with an empty section, changes nothing.
  for (const text of ["", "# nothing yet\n", "hours:\n"]) {
    const r = applyDesk(parse(text).desk, SETTINGS, AI, () => "op_new00001");
    assert.equal(r.inboxChanged || r.aiChanged, false, text);
  }
  // Hours: one key keeps the rest of the stored hours.
  const hours = applyDesk(parse("hours:\n  enabled: false\n").desk, SETTINGS, AI, () => "op_x");
  assert.deepEqual(hours.settings.hours, { ...(SETTINGS.hours as object), enabled: false });
  // Openers on the same page keep their id.
  const openers = applyDesk(parse("chat:\n  openers:\n    - page: /docs/*\n      after: 30\n").desk, SETTINGS, AI, () => "op_new00001");
  assert.deepEqual(openers.settings.openers, [{ id: "op_docs0001", path: "/docs/*", delay: 30, text: null }]);
});

test("D-84: unknown keys and bad values are problems with plain messages", () => {
  const { issues } = parse(`ai:
  enabled: yes please
  model: "not a model!"
  monthlyReplyCap: -1
  temperature: 2
chat:
  colour: red
  color: red
  launcher: rocket
  rounding: 99
  island: { surface: blue }
  allowedWebsites: [not a domain]
  openers:
    - page: pricing
      after: 1
hours:
  timeZone: Mars/Olympus
  days: { monday: 9-5, funday: "09:00-10:00" }
inbox:
  assignment: { mode: everyone }
extra: 1
`);
  const messages = issues.map((i) => i.message);
  assert.ok(issues.every((i) => i.path === "desk.yaml"));
  const expect = [
    /^Unknown key "extra"/,
    /^Unknown key "ai\.temperature"/,
    /^ai\.enabled: use true/,
    /^ai\.model: "not a model!" isn't a model id/,
    /^ai\.monthlyReplyCap: /,
    /^Unknown key "chat\.colour"/,
    /^chat\.color: Colour must look like #2f5bea/,
    /^chat\.launcher: use mode: island or window instead/,
    /^chat\.rounding: Corner rounding must be a whole number from 0 to 24/,
    /^chat\.island\.surface: use dark/,
    /^chat\.allowedWebsites: not a website: not a domain/,
    /^chat\.openers: opener 1: "pricing" must start with \/ or \*/,
    /^hours\.timeZone: use a time zone name/,
    /^hours\.days: "funday" isn't a weekday/,
    /^hours\.days\.monday: use opening and closing times/,
    /^inbox\.assignment\.mode: use manual/,
  ];
  for (const pattern of expect) assert.ok(messages.some((m) => pattern.test(m)), `${pattern} in ${JSON.stringify(messages, null, 1)}`);
  assert.equal(parse("- a\n- b\n").issues[0]!.message, "desk.yaml is a map of sections: ai, chat, hours, inbox.");
  assert.match(parse("chat: [1]\n").issues[0]!.message, /chat must be a group of settings/);
  assert.match(parse("chat: {\n").issues[0]!.message, /^Invalid YAML/);
  assert.match(parse("hours:\n  days: { monday: '17:00-09:00' }\n").issues[0]!.message, /Monday: closing time must be after opening time/);
});

test("D-84: parseConfig checks desk.yaml like the other files", () => {
  const ok = parseConfig({ ...defaultFiles(), "desk.yaml": "chat:\n  theme: dark\n" });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.config.desk, { chat: { theme: "dark" } });
  const bad = parseConfig({ ...defaultFiles(), "desk.yaml": "chat:\n  theme: purple\n" });
  assert.deepEqual(bad.issues, [{ path: "desk.yaml", message: "chat.theme: Theme must be auto, light or dark." }]);
});

test("D-84: the shared checks behind PUT /ai", () => {
  assert.equal(readReplyCap(0), 0);
  assert.throws(() => readReplyCap(1.5), /whole number/);
  assert.equal(readModel(""), null);
  assert.equal(readModel("default"), null);
  assert.equal(readModel(" @cf/meta/llama-3 "), "@cf/meta/llama-3");
  assert.throws(() => readModel("two words"), /isn't a model id/);
});

test("D-84: only the keys a save changed are applied (a stale file elsewhere doesn't undo settings)", () => {
  const prev = parse("ai:\n  enabled: false\nchat:\n  color: '#111111'\n  theme: dark\n").desk;
  const next = parse("ai:\n  enabled: false\nchat:\n  color: '#222222'\n  theme: dark\n").desk;
  assert.deepEqual(deskChanges(prev, next), { chat: { color: "#222222" } });
  assert.deepEqual(deskChanges(null, next), next);
  assert.equal(deskLeaves(deskChanges(next, next)).length, 0);
});

test("D-84: a settings change edits desk.yaml in place: comments and key order stay", () => {
  const before = deskFromSettings(SETTINGS, AI);
  const after = deskFromSettings({ ...SETTINGS, color: "#00aa00", suggestions: ["Only one"] }, AI);
  const text = `# Our desk, kept in git.
chat:
  theme: dark   # the brand is dark
  color: "#5b4cff"  # brand purple
  suggestedQuestions:
    - How much is it?
    - Can I invite my team?
hours:
  enabled: true
`;
  const out = updateDeskText(text, before, after);
  assert.equal(
    out,
    `# Our desk, kept in git.
chat:
  theme: dark # the brand is dark
  color: "#00aa00" # brand purple
  suggestedQuestions:
    - Only one
hours:
  enabled: true
`,
  );
  // Keys the file doesn't have and that didn't change stay out (a partial file stays partial).
  assert.ok(!out.includes("mode"));
  // A key that changed but isn't in the file is added.
  const added = updateDeskText(text, before, deskFromSettings({ ...SETTINGS, mode: "window" }, AI));
  assert.match(added, /mode: window/);
  // Nothing changed: the same text (no new version).
  assert.equal(updateDeskText(text, before, before), text);
  // A key the file has with another value than the desk's is put right.
  assert.match(updateDeskText(text.replace("dark ", "light "), before, before), /theme: dark/);
  // No file yet: the whole file.
  assert.equal(updateDeskText(undefined, before, after), renderDeskFile(after));
  // The edit is still a valid desk.yaml with the new values.
  const { desk, issues } = parse(out);
  assert.deepEqual(issues, []);
  assert.equal(desk.chat?.color, "#00aa00");
});

test("D-84: a dashboard save from an older version merges when the changed files don't overlap", () => {
  const base = { "instructions.md": "a", "desk.yaml": "chat:\n  theme: dark\n" };
  const latest = { ...base, "desk.yaml": "chat:\n  theme: light\n" };
  // The draft changed instructions.md and added a task; the settings page changed desk.yaml.
  const draft = { ...base, "instructions.md": "b", "tasks/x.md": "t" };
  assert.deepEqual(mergeConfigs(base, latest, draft), { "instructions.md": "b", "desk.yaml": "chat:\n  theme: light\n", "tasks/x.md": "t" });
  // Both changed desk.yaml: a conflict.
  assert.equal(mergeConfigs(base, latest, { ...draft, "desk.yaml": "chat:\n  theme: auto\n" }), null);
  // A file the draft removed is removed.
  assert.deepEqual(mergeConfigs({ ...base, README: "r" }, { ...latest, README: "r" }, { ...base }), { ...latest });
  assert.deepEqual(mergeConfigs({ ...base, "tasks/r.md": "r" }, { ...latest, "tasks/r.md": "r" }, base), latest);
  // CLI pushes merge only desk.yaml changes made on the desk.
  assert.deepEqual(mergeConfigs(base, latest, draft, ["desk.yaml"]), mergeConfigs(base, latest, draft));
  assert.equal(mergeConfigs(base, { ...latest, "tasks/r.md": "dashboard" }, draft, ["desk.yaml"]), null);
  assert.deepEqual(changedPaths(base, draft), ["instructions.md", "tasks/x.md"]);
});

test("D-89: an older file's launcher reads as mode + greetingCard, and gives way to them on the next change", () => {
  const read = (launcher: string) => parse(`chat:\n  launcher: ${launcher}\n`);
  assert.deepEqual(read("island").desk.chat, { mode: "island" });
  assert.deepEqual(read("bar").desk.chat, { mode: "island" }, "the removed bar becomes the island");
  assert.deepEqual(read("card").desk.chat, { mode: "window", greetingCard: true });
  assert.deepEqual(read("button").desk.chat, { mode: "window", greetingCard: false });
  for (const l of ["island", "bar", "card", "button"]) assert.deepEqual(read(l).issues, [], l);
  // mode and greetingCard win over launcher.
  assert.deepEqual(parse("chat:\n  launcher: card\n  mode: island\n  greetingCard: false\n").desk.chat, { mode: "island", greetingCard: false });
  // Applied: the stored settings get mode + greetingCard, never launcher.
  const applied = applyDesk(read("button").desk, { launcher: "card", color: "#111111" }, AI, () => "op_x");
  assert.deepEqual(applied.settings, { color: "#111111", mode: "window", greetingCard: false });
  // A settings change rewrites the old key as the new ones; an unrelated change leaves it be.
  const before = deskFromSettings({ launcher: "card" }, AI);
  const text = "chat:\n  launcher: card  # ours\n  theme: auto\n";
  assert.equal(updateDeskText(text, before, deskFromSettings({ launcher: "card", theme: "dark" }, AI)), "chat:\n  launcher: card # ours\n  theme: dark\n");
  const moved = updateDeskText(text, before, deskFromSettings({ mode: "island", greetingCard: true }, AI));
  assert.ok(!moved.includes("launcher"), moved);
  assert.deepEqual(parse(moved).desk.chat, { mode: "island", greetingCard: true, theme: "auto" });
  assert.deepEqual(parse(moved).issues, []);
  // A bad value in mode or greetingCard is a plain problem.
  assert.match(parse("chat:\n  mode: bar\n").issues[0]!.message, /^chat\.mode: Mode must be island or window\./);
  assert.match(parse("chat:\n  greetingCard: yes please\n").issues[0]!.message, /^chat\.greetingCard: The greeting card must be on or off/);
});

