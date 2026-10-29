import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, bucketsOf, buildPing, newInstallId, readPing, telemetryOn } from "./telemetry.ts";

test("counts become ranges", () => {
  const chats = [0, 1, 11, 101, 1001, 10001];
  assert.equal(bucket(0, chats), "0");
  assert.equal(bucket(1, chats), "1-10");
  assert.equal(bucket(10, chats), "1-10");
  assert.equal(bucket(250, chats), "101-1000");
  assert.equal(bucket(50000, chats), "10001+");
  assert.equal(bucket(1, [1, 2, 6]), "1");
  assert.equal(bucket(4, [1, 2, 6]), "2-5");
  assert.equal(bucket(0, [1, 2, 6]), "0");
  assert.deepEqual(bucketsOf([1, 2, 6]), ["0", "1", "2-5", "6+"]);
});

test("a ping carries ranges and known names only", () => {
  const ping = buildPing(newInstallId(), "0.1.6", {
    workspaces: 3, members: 7, chats30d: 42, ageDays: 12,
    providers: ["openai", "workers-ai", "mystery"], features: ["email", "ai", "secret-thing"],
  });
  assert.equal(ping.workspaces, "2-5");
  assert.equal(ping.members, "6-20");
  assert.equal(ping.chats30d, "11-100");
  assert.equal(ping.age, "7-29");
  assert.deepEqual(ping.providers, ["workers-ai", "openai"]);
  assert.deepEqual(ping.features, ["ai", "email"]);
  assert.deepEqual(readPing(JSON.parse(JSON.stringify(ping))), ping);
});

test("the collector refuses anything else", () => {
  const ping = buildPing(newInstallId(), "0.1.6", { workspaces: 1, members: 1, chats30d: 0, ageDays: 0, providers: [], features: [] });
  assert.ok(readPing(ping));
  assert.equal(readPing({ ...ping, url: "https://example.com" }), null);
  assert.equal(readPing({ ...ping, id: "acme-inc" }), null);
  assert.equal(readPing({ ...ping, members: "7" }), null);
  assert.equal(readPing({ ...ping, version: "1.0.0; drop table" }), null);
  assert.equal(readPing({ ...ping, features: ["ai", "ai"] }), null);
  assert.ok(readPing({ ...ping, features: ["slack"] }), "slack is a known feature");
  assert.equal(readPing({ ...ping, providers: ["anthropic"] }), null);
  assert.equal(readPing([ping]), null);
});

test("on unless the env or the owner turns it off", () => {
  assert.equal(telemetryOn(undefined, null), true);
  assert.equal(telemetryOn(undefined, "off"), false);
  assert.equal(telemetryOn("off", null), false);
  assert.equal(telemetryOn("FALSE", null), false);
  assert.equal(telemetryOn("on", null), true);
});
