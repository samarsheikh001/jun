import assert from "node:assert/strict";
import { test } from "node:test";
import { editFrontmatter, editYaml, freshName, readFrontmatter, readYaml, setBody, withJsonKey } from "./agent-files.ts";

const AGENTS = `---
# Guardrails. Remove a line to use the default.
maxReplies: 8            # AI replies per conversation before a person takes over
handoffTopics:           # always hand these to a person
  - legal or security questions
---
# How to talk to customers

- Be friendly.
`;

test("frontmatter edits keep comments, other keys and the body", () => {
  const out = editFrontmatter(AGENTS, { op: "set", path: ["maxReplies"], value: 5 });
  assert.match(out, /# Guardrails\. Remove a line/);
  assert.match(out, /maxReplies: 5 +# AI replies per conversation/);
  assert.match(out, /- legal or security questions/);
  assert.ok(out.endsWith("# How to talk to customers\n\n- Be friendly.\n"));
  const topics = editFrontmatter(out, { op: "set", path: ["handoffTopics"], value: ["legal", "refunds over $500"] });
  assert.deepEqual(readFrontmatter(topics).data?.handoffTopics, ["legal", "refunds over $500"]);
  assert.match(topics, /# always hand these to a person/);
});

test("frontmatter is created when missing and dropped when emptied", () => {
  const added = editFrontmatter("Body\n", { op: "set", path: ["maxReplies"], value: 3 });
  assert.equal(added, "---\nmaxReplies: 3\n---\nBody\n");
  assert.equal(editFrontmatter(added, { op: "set", path: ["maxReplies"], value: "" }), "Body\n");
  assert.equal(setBody(AGENTS, "New body\n").split("---\n").at(-1), "New body\n");
});

test("yaml edits: rename a map key in place, remove an emptied map, push and remove list items", () => {
  const tool = "description: Find an order\nheaders:\n  Authorization: Bearer {secrets.KEY}\ninput:\n  id:\n    type: string\n  email:\n    type: string\n";
  const renamed = editYaml(tool, { op: "rename", path: ["input"], from: "id", to: "order_id" });
  assert.deepEqual(Object.keys((readYaml(renamed) as { input: object }).input), ["order_id", "email"]);
  const noHeaders = editYaml(tool, { op: "set", path: ["headers", "Authorization"], value: "" });
  assert.ok(!noHeaders.includes("headers"));
  const evals = editYaml("- name: a\n  message: hi\n", { op: "push", path: [], value: { name: "b", message: "yo" } });
  assert.deepEqual((readYaml(evals) as { name: string }[]).map((c) => c.name), ["a", "b"]);
  assert.deepEqual(readYaml(editYaml(evals, { op: "remove", path: [], index: 0 })), [{ name: "b", message: "yo" }]);
});

test("a file that doesn't parse is left alone", () => {
  assert.equal(readYaml("a: [1"), null);
  assert.equal(editYaml("a: [1", { op: "set", path: ["a"], value: 2 }), "a: [1");
  assert.equal(freshName("detail", ["detail", "detail_2"]), "detail_3");
});

test("MCP edits: a test case pushed onto a list keeps the file's comments; a map key set or removed in place", () => {
  const tests = "# Order questions\n- name: asks for a human # keep\n  message: a person please\n  expect: { outcome: handoff }\n";
  const pushed = editYaml(tests, { op: "push", path: [], value: { name: "status", message: "Where is A-1?", expect: { tools: ["lookup_order"] } } });
  assert.ok(pushed.startsWith("# Order questions\n"));
  assert.match(pushed, /# keep/);
  assert.deepEqual((readYaml(pushed) as { name: string }[]).map((c) => c.name), ["asks for a human", "status"]);
  assert.equal(readYaml(editYaml(pushed, { op: "remove", path: [], index: 0 })) instanceof Array, true);

  const site = "# How website actions run\nadd_to_cart: confirm # asked\n";
  const set = editYaml(site, { op: "set", path: ["checkout"], value: { run: "human", status: "Checking out" } });
  assert.match(set, /# asked/);
  assert.deepEqual(readYaml(set), { add_to_cart: "confirm", checkout: { run: "human", status: "Checking out" } });
  assert.deepEqual(readYaml(editYaml(set, { op: "set", path: ["add_to_cart"], value: null })), { checkout: { run: "human", status: "Checking out" } });

  const action = "description: Look up an order\n# the order API\nurl: https://api.acme.com/orders/{id}\ninput:\n  id: { type: string }\n";
  const updated = editYaml(action, { op: "set", path: ["status"], value: "Checking your order" }, { op: "set", path: ["widget"], value: "order" });
  assert.match(updated, /# the order API/);
  assert.equal((readYaml(updated) as { status: string }).status, "Checking your order");
});

test("withJsonKey: sets and removes a widget file's key, others keep their order", () => {
  const file = '{\n  "version": "1.0",\n  "name": "Order",\n  "template": "{}"\n}\n';
  const set = withJsonKey(file, "aiFill", true);
  assert.deepEqual(Object.keys(JSON.parse(set)), ["version", "name", "template", "aiFill"]);
  assert.deepEqual(Object.keys(JSON.parse(withJsonKey(set, "name", undefined))), ["version", "template", "aiFill"]);
  assert.equal(withJsonKey("not json", "version", "1.0"), '{\n  "version": "1.0"\n}\n');
});

test("a map emptied to {} grows as a block map again, comments kept", () => {
  const text = editYaml("# edited in the dashboard\n\n{}\n", { op: "set", path: ["add_to_cart"], value: { run: "auto" } });
  assert.equal(text, "# edited in the dashboard\n\nadd_to_cart:\n  run: auto\n");
});
