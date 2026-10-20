import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeskLink } from "./desk-assistant.ts";
import { knowledgeLink, sourceIdOf } from "./knowledge-link.ts";

test("knowledge link: a source's page and back (D-139)", () => {
  assert.equal(knowledgeLink("src_Ab-9"), "/knowledge/src_Ab-9");
  assert.equal(knowledgeLink(null), "/knowledge");
  assert.equal(knowledgeLink("../x"), "/knowledge");
  assert.equal(knowledgeLink("a b"), "/knowledge");
  assert.equal(isDeskLink(knowledgeLink("src_1")), true);
  assert.equal(sourceIdOf("/knowledge/src_1"), "src_1");
  assert.equal(sourceIdOf("/knowledge/src_1/"), "src_1");
  assert.equal(sourceIdOf("/knowledge/src_1?q=x"), "src_1");
  assert.equal(sourceIdOf("/knowledge"), null);
  assert.equal(sourceIdOf("/knowledge/"), null);
  assert.equal(sourceIdOf("/knowledge/%E0%A4"), null);
  assert.equal(sourceIdOf("/knowledge/a%20b"), null);
  assert.equal(sourceIdOf("/agent/knowledge/src_1"), null);
});

test("knowledge link: passages keep a valid source id for their card's link", async () => {
  const { stepPassages } = await import("./desk-assistant.ts");
  const p = stepPassages("search_knowledge", { query: "refund" }, { hits: [{ title: "Refunds", text: "Refunds take 5 days.", source: "Docs", sourceId: "src_1", kind: "website", url: null }, { title: "X", text: "y", sourceId: "../bad" }] });
  assert.equal(p?.hits[0]!.sourceId, "src_1");
  assert.equal("sourceId" in p!.hits[1]!, false);
});
