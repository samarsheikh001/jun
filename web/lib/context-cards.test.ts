import assert from "node:assert/strict";
import { test } from "node:test";
import { stepPassages } from "../../shared/desk-assistant.ts";
import { domainOf, excerpt, queryWords } from "./context-cards.ts";

test("context cards: passages and excerpts (D-134)", () => {
  assert.deepEqual(queryWords("How do I export my data to CSV?"), ["export", "data", "csv"]);
  const parts = excerpt("Intro. You can export your data as CSV from Settings.", "export csv");
  assert.deepEqual(parts.filter((p) => p.match).map((p) => p.text), ["export", "CSV"]);
  assert.equal(parts.map((p) => p.text).join(""), "Intro. You can export your data as CSV from Settings.");
  const long = `${"word ".repeat(100)}refund policy here ${"tail ".repeat(100)}`;
  const cut = excerpt(long, "refund", 100).map((p) => p.text).join("");
  assert.ok(cut.startsWith("…") && cut.endsWith("…") && cut.includes("refund"));
  assert.ok(cut.length <= 104);
  assert.deepEqual(excerpt("plain", ""), [{ text: "plain", match: false }]);
  assert.equal(domainOf("https://www.acme.com/docs"), "acme.com");
  assert.equal(domainOf(null), null);
  const p = stepPassages("search_knowledge", { query: "refunds" }, JSON.stringify({ hits: [{ title: "Refunds", heading: "Policy", url: null, source: "Help doc", kind: "snippet", text: "We refund within 30 days." }, { bad: 1 }] }));
  assert.deepEqual(p, { query: "refunds", hits: [{ title: "Refunds", heading: "Policy", source: "Help doc", kind: "snippet", url: null, text: "We refund within 30 days." }] });
  assert.equal(stepPassages("search_conversations", {}, { hits: [] }), undefined);
  assert.equal(stepPassages("search_knowledge", { query: "x" }, { hits: [] }), undefined);
});
