import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeText, companyLabel, contactsView, likePattern, listQueryString, pageTrail, personLabel, readCompanyQuery, planPersonLink, readPeopleQuery, readProfileHint } from "./contacts.ts";
import type { LinkRow } from "./contacts.ts";
import type { DebugEvent } from "./debug.ts";

test("readPeopleQuery: defaults, clamps and drops what isn't safe", () => {
  assert.deepEqual(readPeopleQuery(new URLSearchParams("")), { q: "", sort: "last_seen", offset: 0, company: null });
  assert.deepEqual(readPeopleQuery(new URLSearchParams("q=%20sam%20&sort=open&offset=50&company=co_abc")), { q: "sam", sort: "open", offset: 50, company: "co_abc" });
  const odd = readPeopleQuery(new URLSearchParams(`q=${"x".repeat(300)}&sort=drop&offset=-5&company=a'b`));
  assert.equal(odd.q.length, 100);
  assert.equal(odd.sort, "last_seen");
  assert.equal(odd.offset, 0);
  assert.equal(odd.company, null);
  assert.equal(readPeopleQuery(new URLSearchParams("offset=abc")).offset, 0);
  assert.equal(readPeopleQuery(new URLSearchParams("offset=99999999")).offset, 100_000);
});

test("readCompanyQuery: its own sorts, never a company filter", () => {
  assert.deepEqual(readCompanyQuery(new URLSearchParams("sort=name&company=co_1")), { q: "", sort: "name", offset: 0, company: null });
  assert.equal(readCompanyQuery(new URLSearchParams("sort=last_seen")).sort, "activity");
});

test("likePattern: wraps and escapes LIKE's wildcards", () => {
  assert.equal(likePattern("acme"), "%acme%");
  assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
});

test("listQueryString: leaves defaults out", () => {
  assert.equal(listQueryString({ q: "", sort: "last_seen", offset: 0 }, "last_seen"), "");
  assert.equal(listQueryString({ q: "a b", sort: "open", offset: 50, company: "co_1" }, "last_seen"), "?q=a+b&sort=open&company=co_1&offset=50");
});

test("personLabel and companyLabel", () => {
  assert.equal(personLabel({ name: " Sam ", email: "sam@acme.com" }), "Sam");
  assert.equal(personLabel({ name: null, email: "sam@acme.com" }), "sam@acme.com");
  assert.equal(personLabel({ name: "", email: null, externalId: "42" }), "User 42");
  assert.equal(personLabel({ name: null, email: null }), "Anonymous visitor");
  assert.equal(companyLabel({ name: "Acme", externalId: "org_1" }), "Acme");
  assert.equal(companyLabel({ name: null, externalId: "org_1" }), "org_1");
});

test("attributeText", () => {
  assert.equal(attributeText(12500), "12,500");
  assert.equal(attributeText(4.5), "4.5");
  assert.equal(attributeText(true), "Yes");
  assert.equal(attributeText(false), "No");
  assert.equal(attributeText("pro"), "pro");
});

test("contactsView: the page's four views", () => {
  assert.deepEqual(contactsView("/contacts"), { view: "people" });
  assert.deepEqual(contactsView("/contacts/"), { view: "people" });
  assert.deepEqual(contactsView("/contacts/ct_123"), { view: "person", id: "ct_123" });
  assert.deepEqual(contactsView("/contacts/companies"), { view: "companies" });
  assert.deepEqual(contactsView("/contacts/companies/co_9"), { view: "company", id: "co_9" });
});

test("pageTrail: navigation only, oldest first, repeats in a row once (reloads kept)", () => {
  const events: DebugEvent[] = [
    { t: 5, kind: "navigation", url: "/billing" },
    { t: 1, kind: "navigation", url: "/", how: "open" },
    { t: 2, kind: "error", message: "boom" },
    { t: 3, kind: "navigation", url: "/pricing" },
    { t: 4, kind: "navigation", url: "/pricing" },
    { t: 6, kind: "navigation", url: "/billing", how: "reload" },
  ];
  assert.deepEqual(pageTrail(events), [
    { t: 1, url: "/", how: "open" },
    { t: 3, url: "/pricing" },
    { t: 5, url: "/billing" },
    { t: 6, url: "/billing", how: "reload" },
  ]);
  const many = Array.from({ length: 40 }, (_, i): DebugEvent => ({ t: i, kind: "navigation", url: `/p${i}` }));
  const trail = pageTrail(many);
  assert.equal(trail.length, 30);
  assert.equal(trail[0]!.url, "/p10");
});

test("readProfileHint: cleans the page's name and email, drops what's malformed", () => {
  assert.deepEqual(readProfileHint({ name: "  Sam\n  Lee ", email: " Sam@Acme.COM " }), { id: null, name: "Sam Lee", email: "sam@acme.com" });
  assert.deepEqual(readProfileHint({ name: 42, email: "not an email" }), { id: null, name: null, email: null });
  assert.deepEqual(readProfileHint({}), { id: null, name: null, email: null });
  assert.equal(readProfileHint({ id: " u_42 " }).id, "u_42");
  assert.equal(readProfileHint({ id: 42 }).id, "42");
  assert.equal(readProfileHint({ id: "a\nb" }).id, null);
  assert.equal(readProfileHint({ id: "x".repeat(201) }).id, null);
  assert.equal(readProfileHint({ name: "x".repeat(300) }).name?.length, 120);
  assert.equal(readProfileHint({ email: `${"a".repeat(320)}@b.co` }).email, null);
});

test("planPersonLink: links by email or id, one verified contact per person", () => {
  const row = (id: string, o: Partial<LinkRow> = {}): LinkRow => ({ id, personId: null, verified: false, externalId: null, createdAt: 10, lastSeenAt: 10, ...o });
  // Alone: nothing to do.
  assert.equal(planPersonLink(row("a"), []), null);
  // Two anonymous browsers with one email: the older is the main contact.
  assert.deepEqual(planPersonLink(row("b", { createdAt: 20 }), [row("a", { createdAt: 5 })]), { root: "a", members: ["b", "a"] });
  // A verified contact is always the main one.
  assert.deepEqual(planPersonLink(row("b", { createdAt: 1 }), [row("v", { verified: true, externalId: "u1", createdAt: 9 })]), { root: "v", members: ["b", "v"] });
  // A whole group comes along.
  assert.deepEqual(planPersonLink(row("c"), [row("a", { personId: "a" }), row("b", { personId: "a" })]), { root: "a", members: ["c", "a", "b"] });
  // Two verified people are never one: a verified self skips the other's group.
  assert.equal(planPersonLink(row("v1", { verified: true }), [row("v2", { verified: true })]), null);
  assert.deepEqual(planPersonLink(row("v1", { verified: true }), [row("v2", { verified: true }), row("x", { createdAt: 1 })]), { root: "v1", members: ["v1", "x"] });
  // Unverified self matching two verified people: the claimed id wins, else the latest seen.
  const two = [row("v1", { verified: true, externalId: "u1", lastSeenAt: 50 }), row("v2", { verified: true, externalId: "u2", lastSeenAt: 99 })];
  assert.deepEqual(planPersonLink(row("a"), two, "u1"), { root: "v1", members: ["a", "v1"] });
  assert.deepEqual(planPersonLink(row("a"), two), { root: "v2", members: ["a", "v2"] });
  // Already in a verified person's group: stays there.
  assert.deepEqual(planPersonLink(row("a", { personId: "v1" }), two), { root: "v1", members: ["a", "v1"] });
});
