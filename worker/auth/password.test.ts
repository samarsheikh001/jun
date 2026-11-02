import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURE_WINDOW_MS, hashPassword, isLocked, passwordProblem, verifyPassword } from "./password-hash.ts";

test("a hash verifies its own password and nothing else", async () => {
  const hash = await hashPassword("correct horse battery", 1000);
  assert.match(hash, /^pbkdf2-sha256\$1000\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("correct horse batterY", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("the same password hashes differently each time (salted)", async () => {
  const [a, b] = await Promise.all([hashPassword("same password here", 1000), hashPassword("same password here", 1000)]);
  assert.notEqual(a, b);
});

test("unicode forms of one password match", async () => {
  const hash = await hashPassword("café au lait!", 1000);
  assert.equal(await verifyPassword("café au lait!", hash), true);
});

test("a malformed or foreign hash never verifies", async () => {
  for (const stored of ["", "plain", "bcrypt$10$x$y", "pbkdf2-sha256$abc$x$y", "pbkdf2-sha256$999999999$AAAA$AAAA"]) {
    assert.equal(await verifyPassword("anything", stored), false, stored);
  }
});

test("password rules: length, not blank, not one repeated character, not the email", () => {
  assert.match(passwordProblem("short")!, /at least 10/);
  assert.match(passwordProblem("x".repeat(201))!, /at most 200/);
  assert.match(passwordProblem("          ")!, /only spaces/);
  assert.match(passwordProblem("aaaaaaaaaaaa")!, /more than one/);
  assert.match(passwordProblem("samar@example.com!", "samar@example.com")!, /email/);
  assert.match(passwordProblem("Samarsheikh2026", "samarsheikh@example.com")!, /email/);
  assert.equal(passwordProblem("a perfectly fine passphrase", "samar@example.com"), null);
  // A short local part isn't a reason to refuse.
  assert.equal(passwordProblem("ab-cd-ef-gh-ij", "ab@example.com"), null);
});

test("guessing locks only past the limit and inside the window", () => {
  const now = 1_000_000_000;
  assert.equal(isLocked(null, 10, now), false);
  assert.equal(isLocked({ count: 9, window_start: now - 1000 }, 10, now), false);
  assert.equal(isLocked({ count: 10, window_start: now - 1000 }, 10, now), true);
  assert.equal(isLocked({ count: 50, window_start: now - FAILURE_WINDOW_MS }, 10, now), false);
});
