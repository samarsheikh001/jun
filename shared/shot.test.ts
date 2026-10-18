import assert from "node:assert/strict";
import { test } from "node:test";
import { readShot, writeShot, type Shot } from "./shot.ts";

test("shot: a card survives the fragment, compressed and URL-safe", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ type: "Text", value: `Order #${i} shipped` }));
  const shot: Shot = { kind: "card", name: "orders", theme: "dark", root: { type: "Card", children: rows } };
  const fragment = await writeShot(shot);
  assert.match(fragment, /^[A-Za-z0-9_-]+$/);
  assert.ok(fragment.length < JSON.stringify(shot).length / 4, "gzip keeps big cards short");
  assert.deepEqual(await readShot(fragment), shot);
});

test("shot: anything else reads as nothing", async () => {
  assert.equal(await readShot(""), null);
  assert.equal(await readShot("not base64 at all!"), null);
  assert.equal(await readShot(btoa("{}")), null, "not gzipped");
});
