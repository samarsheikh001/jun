import assert from "node:assert/strict";
import test from "node:test";
import { cloudflareProblem, cloudflareTokenUrl, workerNameFromHost, zoneFor } from "./email-setup.ts";

test("the token link pre-fills every permission, all zones, and the name", () => {
  const url = new URL(cloudflareTokenUrl("Jun desk email"));
  assert.equal(url.origin + url.pathname, "https://dash.cloudflare.com/profile/api-tokens");
  const keys = JSON.parse(url.searchParams.get("permissionGroupKeys")!) as { key: string; type: string }[];
  assert.deepEqual(keys.map((k) => k.key), ["zone", "zone_settings", "email_routing_rule", "email_sending", "workers_scripts"]);
  assert.equal(url.searchParams.get("zoneId"), "all");
  assert.equal(url.searchParams.get("name"), "Jun desk email");
});

test("a domain's zone is its longest matching zone", () => {
  const zones = [
    { id: "1", name: "acme.com", accountId: "a" },
    { id: "2", name: "eu.acme.com", accountId: "a" },
    { id: "3", name: "notacme.com", accountId: "a" },
  ];
  assert.equal(zoneFor("acme.com", zones)?.id, "1");
  assert.equal(zoneFor("reply.acme.com", zones)?.id, "1");
  assert.equal(zoneFor("help.eu.acme.com", zones)?.id, "2");
  assert.equal(zoneFor("REPLY.ACME.COM", zones)?.id, "1");
  assert.equal(zoneFor("other.org", zones), null);
  assert.equal(zoneFor("xacme.com", zones), null, "a suffix only counts at a dot");
});

test("the Worker's name comes from its workers.dev address", () => {
  assert.equal(workerNameFromHost("jun-desk.samar.workers.dev"), "jun-desk");
  assert.equal(workerNameFromHost("help.acme.com"), null);
  assert.equal(workerNameFromHost("127.0.0.1"), null);
  assert.equal(workerNameFromHost("a.b.c.workers.dev"), null, "preview URLs aren't the Worker");
});

test("a refused call names the permission to add", () => {
  assert.match(cloudflareProblem(403, "Authentication error", "Email Sending: Edit"), /"Email Sending: Edit"/);
  assert.equal(cloudflareProblem(400, "Zone not found", "Zone: Read"), "Zone not found");
});
