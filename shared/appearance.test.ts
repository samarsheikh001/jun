import assert from "node:assert/strict";
import { test } from "node:test";
import { APPEARANCE_DEFAULTS, applyAppearance, islandPalette, launcherOf, logoFor, modeOf, radiusVars, textOn, widgetLook } from "./appearance.ts";

test("appearance: an untouched desk gets the original look", () => {
  assert.deepEqual(widgetLook({}, "Acme", null), {
    workspaceName: "Acme",
    greeting: "Hi! How can we help?",
    color: "#2f5bea",
    position: "right",
    replyTime: "We usually reply in a few minutes",
    logoUrl: null,
    logoDarkUrl: null,
    theme: "auto",
    radius: 16,
    mode: "window",
    greetingCard: true,
    launcher: "card",
    placeholder: "Write a message…",
    suggestions: [],
    neon: true,
    islandSurface: "auto",
    buttonStyle: "logo",
    sound: true,
  });
  // The island's neon border is on unless turned off; anything but false keeps it.
  assert.equal(widgetLook({ neon: false }, "Acme", null).neon, false);
  assert.equal(widgetLook({ neon: "off" }, "Acme", null).neon, true);
  assert.deepEqual(radiusVars(APPEARANCE_DEFAULTS.radius), { "--r-md": "14px", "--r-sm": "8px" });
});

test("appearance: reading is lenient (half-typed drafts, hand-edited rows)", () => {
  const look = widgetLook({ color: "#12", radius: 99, theme: "neon", launcher: 3, greeting: "  ", suggestions: ["  ", "Pricing?", 7, "a", "b", "c"] }, "Acme", null);
  assert.equal(look.color, "#2f5bea");
  assert.equal(look.radius, 16);
  assert.equal(look.theme, "auto");
  assert.equal(look.launcher, "card");
  assert.equal(look.greeting, "Hi! How can we help?");
  assert.deepEqual(look.suggestions, ["Pricing?", "a", "b", "c"]);
  assert.equal(widgetLook({ radius: 0 }, "Acme", null).radius, 0);
});

test("appearance: writing is strict, and empty text clears a field", () => {
  const settings: Record<string, unknown> = { greeting: "Old" };
  applyAppearance(settings, { color: "#FF6600", theme: "dark", radius: 4, mode: "window", greetingCard: true, greeting: " ", placeholder: " Ask   us ", suggestions: [" How much? ", ""] });
  assert.deepEqual(settings, { color: "#ff6600", theme: "dark", radius: 4, mode: "window", greetingCard: true, placeholder: "Ask us", suggestions: ["How much?"] });
  for (const body of [{ color: "blue" }, { position: "top" }, { theme: "neon" }, { launcher: "banner" }, { mode: "bar" }, { mode: "card" }, { greetingCard: "yes" }, { greetingCard: 1 }, { radius: 25 }, { radius: 2.5 }, { radius: "4" }, { placeholder: "x".repeat(61) }, { suggestions: "a" }, { suggestions: ["1", "2", "3", "4", "5"] }, { suggestions: ["x".repeat(81)] }]) {
    assert.throws(() => applyAppearance({}, body), Error, JSON.stringify(body));
  }
  applyAppearance(settings, { suggestions: [] });
  assert.equal(settings.suggestions, undefined);
});

test("appearance: readable text on the brand colour", () => {
  assert.equal(textOn("#2f5bea"), "#ffffff");
  assert.equal(textOn("#ffe066"), "#1c1c1a");
});

test("appearance: the button shows the logo unless set to text; only those two are accepted", () => {
  assert.equal(widgetLook({ buttonStyle: "text" }, "Acme", null).buttonStyle, "text");
  assert.equal(widgetLook({ buttonStyle: "emoji" }, "Acme", null).buttonStyle, "logo");
  const settings: Record<string, unknown> = {};
  applyAppearance(settings, { buttonStyle: "text" });
  assert.equal(settings.buttonStyle, "text");
  assert.throws(() => applyAppearance(settings, { buttonStyle: "big" }), /logo or text/);
});

test("appearance: the reply sound (W-20) is on unless turned off; only true or false is accepted", () => {
  assert.equal(APPEARANCE_DEFAULTS.sound, true);
  assert.equal(widgetLook({ sound: false }, "Acme", null).sound, false);
  assert.equal(widgetLook({ sound: "off" }, "Acme", null).sound, true);
  assert.equal(widgetLook({ sound: 0 }, "Acme", null).sound, true);
  const settings: Record<string, unknown> = {};
  applyAppearance(settings, { sound: false });
  assert.equal(settings.sound, false);
  applyAppearance(settings, { sound: true });
  assert.equal(settings.sound, true);
  for (const sound of ["off", 0, null, "true"]) {
    assert.throws(() => applyAppearance(settings, { sound }), /Sound must be true or false\./);
  }
  assert.equal(settings.sound, true);
});

test("appearance: the island stands out from the page unless set; auto, dark and page are accepted", () => {
  assert.equal(APPEARANCE_DEFAULTS.islandSurface, "auto");
  assert.equal(widgetLook({ islandSurface: "page" }, "Acme", null).islandSurface, "page");
  assert.equal(widgetLook({ islandSurface: "dark" }, "Acme", null).islandSurface, "dark");
  assert.equal(widgetLook({ islandSurface: "auto" }, "Acme", null).islandSurface, "auto");
  assert.equal(widgetLook({ islandSurface: "light" }, "Acme", null).islandSurface, "auto");
  assert.equal(widgetLook({ islandSurface: 1 }, "Acme", null).islandSurface, "auto");
  const settings: Record<string, unknown> = {};
  applyAppearance(settings, { islandSurface: "page" });
  assert.equal(settings.islandSurface, "page");
  applyAppearance(settings, { islandSurface: "dark" });
  assert.equal(settings.islandSurface, "dark");
  for (const islandSurface of ["light", "", null, true]) {
    assert.throws(() => applyAppearance(settings, { islandSurface }), /Island surface must be auto, dark or page\./);
  }
  assert.equal(settings.islandSurface, "dark");
  applyAppearance(settings, { islandSurface: "auto" });
  assert.equal(settings.islandSurface, "auto");
});

test("appearance: an auto island is near-black until the page behind it is dark (D-99)", () => {
  assert.equal(islandPalette("auto", null), "dark");
  assert.equal(islandPalette("auto", "light"), "dark");
  assert.equal(islandPalette("auto", "dark"), "light");
  assert.equal(islandPalette("dark", "dark"), "dark");
  assert.equal(islandPalette("page", "dark"), "theme");
  assert.equal(islandPalette("page", null), "theme");
});

test("appearance: the dark-background logo (W-21) is used only on dark surfaces, else the main logo", () => {
  const both = widgetLook({}, "Acme", "/logo", "/logo-dark");
  assert.equal(both.logoDarkUrl, "/logo-dark");
  assert.equal(logoFor(both, true), "/logo-dark");
  assert.equal(logoFor(both, false), "/logo");
  // No dark logo: the main one everywhere.
  const main = widgetLook({}, "Acme", "/logo");
  assert.equal(main.logoDarkUrl, null);
  assert.equal(logoFor(main, true), "/logo");
  // Only a dark logo: on dark surfaces only (light ones show the Jun mark).
  const dark = widgetLook({}, "Acme", null, "/logo-dark");
  assert.equal(logoFor(dark, true), "/logo-dark");
  assert.equal(logoFor(dark, false), null);
  assert.equal(logoFor(widgetLook({}, "Acme", null), true), null);
});

test("D-89: old stored launchers read as a mode and a greeting card switch (bar → island)", () => {
  const read = (s: Record<string, unknown>) => {
    const look = widgetLook(s, "Acme", null);
    return [look.mode, look.greetingCard, look.launcher];
  };
  assert.deepEqual(read({ launcher: "island" }), ["island", true, "island"]);
  assert.deepEqual(read({ launcher: "bar" }), ["island", true, "island"]);
  assert.deepEqual(read({ launcher: "card" }), ["window", true, "card"]);
  assert.deepEqual(read({ launcher: "button" }), ["window", false, "button"]);
  assert.deepEqual(read({}), ["window", true, "card"], "the same visible default as before");
  assert.deepEqual(read({ launcher: "rocket" }), ["window", true, "card"]);
  // The new keys win over an old launcher; unreadable ones fall back to it.
  assert.deepEqual(read({ launcher: "card", mode: "island" }), ["island", true, "island"]);
  assert.deepEqual(read({ launcher: "button", mode: "window", greetingCard: true }), ["window", true, "card"]);
  assert.deepEqual(read({ launcher: "button", mode: "bar", greetingCard: "on" }), ["window", false, "button"]);
  assert.deepEqual(read({ mode: "window", greetingCard: false }), ["window", false, "button"]);
  // /config always has a launcher today's cached loaders understand (never "bar").
  for (const launcher of ["island", "bar", "card", "button", undefined, 7]) {
    assert.ok(["island", "card", "button"].includes(widgetLook({ launcher }, "Acme", null).launcher), String(launcher));
  }
  assert.equal(launcherOf("island", false), "island");
  assert.equal(launcherOf("window", true), "card");
  assert.equal(launcherOf("window", false), "button");
  assert.deepEqual(modeOf({}), { mode: APPEARANCE_DEFAULTS.mode, greetingCard: APPEARANCE_DEFAULTS.greetingCard });
});

test("D-89: a settings update stores mode + greetingCard; the old launcher key is still taken and mapped", () => {
  const patch = (settings: Record<string, unknown>, body: Record<string, unknown>) => {
    applyAppearance(settings, body);
    return settings;
  };
  assert.deepEqual(patch({}, { launcher: "bar" }), { mode: "island", greetingCard: true });
  assert.deepEqual(patch({}, { launcher: "island" }), { mode: "island", greetingCard: true });
  assert.deepEqual(patch({}, { launcher: "card" }), { mode: "window", greetingCard: true });
  assert.deepEqual(patch({}, { launcher: "button" }), { mode: "window", greetingCard: false });
  // A stored old launcher is replaced by the new keys, keeping what it meant.
  assert.deepEqual(patch({ launcher: "button" }, { mode: "island" }), { mode: "island", greetingCard: false });
  assert.deepEqual(patch({ launcher: "card" }, { greetingCard: false }), { mode: "window", greetingCard: false });
  // Switching to the island with an old launcher keeps the window's greeting card switch for later.
  assert.deepEqual(patch({ mode: "window", greetingCard: false }, { launcher: "island" }), { mode: "island", greetingCard: false });
  // The new keys win over launcher in one body.
  assert.deepEqual(patch({}, { launcher: "card", mode: "island", greetingCard: false }), { mode: "island", greetingCard: false });
  // Untouched when none of the three is in the body.
  assert.deepEqual(patch({ launcher: "button" }, { color: "#000000" }), { launcher: "button", color: "#000000" });
  assert.throws(() => applyAppearance({}, { launcher: "banner" }), /Launcher must be island, card or button/);
  assert.throws(() => applyAppearance({}, { mode: "bar" }), /Mode must be island or window\./);
  assert.throws(() => applyAppearance({}, { greetingCard: "off" }), /The greeting card must be on or off/);
});
