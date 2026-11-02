import assert from "node:assert/strict";
import { test } from "node:test";
import { contextLabel, pageContext } from "./ask-context.ts";

test("a page's subject becomes the assistant's reference", () => {
  assert.deepEqual(pageContext("/inbox/cv_123"), { kind: "chat", id: "cv_123", label: "" });
  assert.deepEqual(pageContext("/inbox/cv_123?topic=x"), { kind: "chat", id: "cv_123", label: "" });
  assert.deepEqual(pageContext("/contacts/ct_9"), { kind: "contact", id: "ct_9", label: "" });
  assert.equal(pageContext("/contacts/companies/co_1"), null);
  assert.equal(pageContext("/contacts"), null);
  assert.equal(pageContext("/inbox"), null);
  assert.equal(pageContext("/dashboard"), null);
  assert.equal(pageContext("/agent")?.id, "instructions.md");
  assert.equal(pageContext("/agent/tasks/refunds")?.id, "tasks/refunds.md");
  assert.equal(pageContext("/agent/actions/get_order")?.id, "actions/get_order.yaml");
  assert.equal(pageContext("/agent/widgets/order")?.id, "widgets/order.widget");
  assert.equal(pageContext("/agent/tasks"), null);
  assert.equal(pageContext("/agent/tests"), null);
});

test("the chip names the page until the name loads", () => {
  assert.equal(contextLabel({ kind: "chat", id: "cv_1", label: "" }), "This chat");
  assert.equal(contextLabel({ kind: "chat", id: "cv_1", label: "Hana Kim" }), "Hana Kim");
  assert.equal(contextLabel({ kind: "file", id: "tasks/a.md", label: "tasks/a.md" }), "tasks/a.md");
});
