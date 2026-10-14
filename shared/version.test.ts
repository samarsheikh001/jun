import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareVersions, JUN_VERSION, nextVersion, parseVersion } from "./version.ts";

test("the version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(JUN_VERSION, pkg.version);
});

test("versions parse with or without a v", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("0.10.0"), [0, 10, 0]);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("1.2.3-beta"), null);
});

test("versions compare by number, not text", () => {
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
  assert.ok(compareVersions("v1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
});

test("release bumps", () => {
  assert.equal(nextVersion("0.1.9", "patch"), "0.1.10");
  assert.equal(nextVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.9", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.9", "v0.3.0"), "0.3.0");
  assert.throws(() => nextVersion("0.1.0", "huge"));
});
