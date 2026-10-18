import assert from "node:assert/strict";
import { test } from "node:test";
import { findTemplates, WIDGET_TEMPLATES } from "./widget-templates.ts";
import { checkExamples, parseWidgetFile, previewWidget, renderWidget } from "./widgets.ts";

// W-23: every template on the Widgets page's Templates tab is a working widget file.

test("widget templates: each parses, renders its sample and passes the widget checks", () => {
  assert.ok(WIDGET_TEMPLATES.length >= 19);
  assert.equal(new Set(WIDGET_TEMPLATES.map((t) => t.id)).size, WIDGET_TEMPLATES.length, "unique ids");
  for (const t of WIDGET_TEMPLATES) {
    assert.match(t.id, /^[a-z][a-z0-9_]*$/, `${t.id}: usable as a widget name`);
    assert.ok(t.name && t.description, `${t.id}: name and description`);
    const spec = parseWidgetFile(t.id, t.file);
    assert.ok(spec.sample, `${t.id}: has example data`);
    assert.doesNotThrow(() => previewWidget(t.id, t.file), `${t.id}: renders`);
    // W-30: Studio's own schema comes with it, and its example fits it.
    assert.equal(spec.schema?.type, "object", `${t.id}: has Studio's schema`);
    assert.doesNotThrow(() => checkExamples(spec), `${t.id}: example fits the schema`);
    // Studio's demo image paths point at Studio, never at the desk.
    assert.ok(!/"\/(?!\/)[^"]+\.(?:png|jpe?g|gif|webp|svg)"/i.test(JSON.stringify(spec.sample)), `${t.id}: no root-relative images`);
  }
});

// D-103: our support templates come first, each with states, a summary and words to find it by.
test("support templates: listed first, with a summary, a schema and words to find them by", () => {
  const support = WIDGET_TEMPLATES.filter((t) => t.group === "support");
  assert.ok(support.length >= 9);
  assert.deepEqual(WIDGET_TEMPLATES.slice(0, support.length), support, "support templates come first");
  for (const t of support) {
    const spec = parseWidgetFile(t.id, t.file);
    assert.ok(spec.summary, `${t.id}: has a summary`);
    assert.ok(t.tags.length >= 3, `${t.id}: has tags`);
    for (const s of spec.states ?? []) assert.doesNotThrow(() => renderWidget(spec, s.data), `${t.id}: state ${s.name} renders`);
    // The look comes from the chat's palette: no hex colours or gradients.
    assert.ok(!/#[0-9a-f]{3,8}\b|gradient/i.test(JSON.parse(t.file).template), `${t.id}: no fixed colours`);
  }
});

test("findTemplates: the closest template first", () => {
  assert.equal(findTemplates("show the customer's invoices")[0]?.id, "invoices");
  assert.equal(findTemplates("where is my order")[0]?.id, "order_status");
  assert.equal(findTemplates("upgrade plan")[0]?.id, "plan_picker");
  assert.equal(findTemplates("refund form")[0]?.id, "refund_request");
  assert.equal(findTemplates("api usage quota")[0]?.id, "usage_limits");
  assert.equal(findTemplates("weather")[0]?.group, "gallery");
  assert.equal(findTemplates("").length, WIDGET_TEMPLATES.length);
  assert.deepEqual(findTemplates("xyzzy"), []);
});
