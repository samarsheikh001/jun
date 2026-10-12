import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskEdit, taskEditInput, taskFilesText, TASK_EDIT_PROMPT } from "./task-ai.ts";
import { readTaskEdit } from "./edit-finish.ts";

const PROC = "skills/order-status/SKILL.md";

test("AI-27: a task's answer writes its procedure and action files, nothing else", () => {
  const answer = `<reply>Added the lookup and the steps.</reply>
<file path="${PROC}">
---
name: order-status
description: The customer asks where their order is.
---
1. Look it up with @look_up_order.
</file>
<file path="tools/look_up_order.yaml">
description: Finds an order.
url: https://api.acme.com/orders/{orderNumber}
</file>
<file path="AGENTS.md">
nope
</file>`;
  const edit = parseTaskEdit(answer, PROC)!;
  assert.equal(edit.reply, "Added the lookup and the steps.");
  assert.deepEqual(Object.keys(edit.files), [PROC, "tools/look_up_order.yaml"]);
  assert.deepEqual(edit.ignored, ["AGENTS.md"]);
  assert.match(edit.files["tools/look_up_order.yaml"]!, /\{orderNumber\}\n$/);
  assert.equal(parseTaskEdit("no tags here", PROC), null);
});

test("AI-27: only files that change are applied; no change is a plain answer", () => {
  const draft = { [PROC]: "---\nname: order-status\ndescription: x\n---\n1. a\n" };
  const same = readTaskEdit(PROC, draft, `<reply>Nothing to do.</reply>\n<file path="${PROC}">\n${draft[PROC]}</file>`);
  assert.ok("result" in same && !same.result.changed);
  const changed = readTaskEdit(PROC, draft, `<reply>New action.</reply>\n<file path="tools/a_b.yaml">\ndescription: d\nurl: https://x.io\n</file>`);
  assert.ok("check" in changed);
  assert.deepEqual(Object.keys(changed.check.files), ["tools/a_b.yaml"]);
  assert.ok("failed" in readTaskEdit(PROC, draft, "nothing"));
});

test("AI-27: the task input carries the actions it uses as files; the prompt allows new ones", () => {
  const text = taskEditInput({
    name: "order-status",
    path: PROC,
    text: "---\nname: order-status\n---\n",
    actions: { "tools/look_up_order.yaml": "description: d\n" },
    context: { actions: [], procedures: [], widgets: [] },
    history: [],
    message: "add a refund step",
    error: { file: taskFilesText({ "tools/x.yaml": "a\n" }), problems: ["tools/x.yaml: bad"] },
  });
  assert.match(text, /<file path="tools\/look_up_order\.yaml">/);
  assert.match(text, /didn't pass the checks[\s\S]*tools\/x\.yaml: bad/);
  assert.match(TASK_EDIT_PROMPT, /create it: write its file as tools\//);
});
