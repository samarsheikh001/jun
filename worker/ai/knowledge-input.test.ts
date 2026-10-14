import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_KB_FILE_BYTES } from "../../shared/protocol.ts";
import { cleanFileName, documentInput, DocumentInputError, sourceState, sourceType, TOO_LARGE } from "./knowledge-input.ts";

const refused = (args: Record<string, unknown>, message: RegExp | string) =>
  assert.throws(() => documentInput(args), (error: unknown) => error instanceof DocumentInputError && (typeof message === "string" ? error.message === message : message.test(error.message)));

test("text becomes a Markdown file named after the document", () => {
  const input = documentInput({ name: "Refund policy", text: "# Refunds\n\nWithin 30 days." });
  assert.equal(input.title, "Refund policy");
  assert.equal(input.fileName, "Refund policy.md");
  assert.equal(new TextDecoder().decode(input.bytes), "# Refunds\n\nWithin 30 days.");
  // A name that already ends in .md/.txt isn't doubled; unsafe characters are replaced.
  assert.equal(documentInput({ name: "notes.txt", text: "hi" }).fileName, "notes.md");
  assert.equal(documentInput({ name: 'a/b"c', text: "hi" }).fileName, "a_b_c.md");
});

test("base64 with a filename decodes to the file's bytes (data: URLs, line breaks, URL-safe and unpadded too)", () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe]);
  const b64 = btoa(String.fromCharCode(...bytes));
  for (const base64 of [b64, `data:application/pdf;base64,${b64}`, `${b64.slice(0, 4)}\n${b64.slice(4)}`, b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")]) {
    const input = documentInput({ name: "Guide", base64, filename: "guide.pdf" });
    assert.deepEqual([...input.bytes], [...bytes]);
    assert.equal(input.fileName, "guide.pdf");
    assert.equal(input.title, "Guide");
  }
});

test("exactly one of text or base64, a name, a filename with base64", () => {
  refused({ text: "x" }, /name is required/);
  refused({ name: "  ", text: "x" }, /name is required/);
  refused({ name: "x".repeat(201), text: "x" }, /at most 200/);
  refused({ name: "Doc" }, /either text .* or base64/);
  refused({ name: "Doc", text: "x", base64: "eA==", filename: "x.txt" }, /not both/);
  refused({ name: "Doc", text: "   " }, /text is empty/);
  refused({ name: "Doc", base64: "eA==" }, /filename is required/);
  refused({ name: "Doc", base64: "not base64!", filename: "x.txt" }, /isn't valid base64/);
  refused({ name: "Doc", base64: "eA=", filename: "x.txt" }, /isn't valid base64/);
});

test("the upload's size limit applies to text and to base64 (checked before decoding)", () => {
  refused({ name: "Big", text: "a".repeat(MAX_KB_FILE_BYTES + 1) }, TOO_LARGE);
  assert.equal(documentInput({ name: "Max", text: "a".repeat(MAX_KB_FILE_BYTES) }).bytes.byteLength, MAX_KB_FILE_BYTES);
  // Multi-byte characters count as bytes, as in a file.
  refused({ name: "Big", text: "é".repeat(MAX_KB_FILE_BYTES / 2 + 1) }, TOO_LARGE);
  refused({ name: "Big", base64: "A".repeat(Math.ceil(((MAX_KB_FILE_BYTES + 3) * 4) / 3 / 4) * 4), filename: "big.pdf" }, TOO_LARGE);
});

test("cleanFileName matches the upload route's cleaning", () => {
  assert.equal(cleanFileName(" a\\b/c\r\n\"d\0.md "), "a_b_c___d_.md");
  assert.equal(cleanFileName("x".repeat(300)).length, 200);
});

test("a source's type and state in plain words", () => {
  assert.equal(sourceType("website", 200), "website");
  assert.equal(sourceType("website", 1), "page");
  assert.equal(sourceType("file", null), "file");
  assert.equal(sourceType("snippet", null), "text");
  assert.equal(sourceState("website", "pending"), "queued");
  assert.equal(sourceState("website", "syncing"), "crawling");
  assert.equal(sourceState("file", "syncing"), "indexing");
  assert.equal(sourceState("snippet", "ready"), "ready");
  assert.equal(sourceState("file", "error"), "failed");
});
