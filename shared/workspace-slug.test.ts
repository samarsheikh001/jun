import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SLUG, slugBase, slugStem, uniqueSlug } from "./workspace-slug.ts";

test("a slug from the name", () => {
  assert.equal(slugBase("Acme Support"), "acme-support");
  assert.equal(slugBase("  Acme Support (EU)! "), "acme-support-eu");
  assert.equal(slugBase("Café Crème"), "cafe-creme");
  assert.equal(slugBase("jun"), "jun");
  assert.equal(slugBase("日本語"), "workspace");
  assert.equal(slugBase("---"), "workspace");
  const long = slugBase("a".repeat(30) + " " + "b".repeat(30));
  assert.ok(long.length <= MAX_SLUG);
  assert.ok(!long.endsWith("-"));
  assert.equal(slugBase("x".repeat(39) + " y"), "x".repeat(39));
});

test("unique slugs", () => {
  assert.equal(uniqueSlug("acme", []), "acme");
  assert.equal(uniqueSlug("acme", ["acme"]), "acme-2");
  assert.equal(uniqueSlug("acme", ["acme", "acme-2", "acme-3"]), "acme-4");
  const base = "a".repeat(MAX_SLUG);
  const next = uniqueSlug(base, [base]);
  assert.equal(next, "a".repeat(MAX_SLUG - 2) + "-2");
  assert.ok(next.startsWith(slugStem(base)));
});
