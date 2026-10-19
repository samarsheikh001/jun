import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeText, companyLabel, contactsView, likePattern, listQueryString, pageTrail, personLabel, readCompanyQuery, readPeopleQuery } from "./contacts.ts";
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
