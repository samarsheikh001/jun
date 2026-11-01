import { defineConfig } from "wxt";
import { pageControllerPlugins } from "../web/page-control/build.ts";

// Jun for Chrome (E-01, D-155; docs/research/12-browser-extension.md). Manifest V3, built by WXT.
// Pages are reached only where the person allows it: activeTab (a click on the toolbar button) and
// per-site optional host permissions, never every site at install. The person's own AI is called
// from the side panel, so only its API host is a required permission.
export default defineConfig({
  srcDir: "src",
  outDir: process.env.JUN_EXT_TEST ? "dist-test" : "dist",
  manifest: {
    name: "Jun: help on any page",
    description: "Ask how to do anything on the page you're on. Jun shows you where, or does it after you confirm. Runs on your own AI key.",
    permissions: ["sidePanel", "activeTab", "scripting", "storage"],
    // JUN_EXT_TEST=1: a test build that may reach every page without a click (scripts/e2e-extension.ts).
    host_permissions: ["https://api.openai.com/*", ...(process.env.JUN_EXT_TEST ? ["<all_urls>"] : [])],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    action: { default_title: "Ask Jun about this page" },
  },
  vite: () => ({
    plugins: pageControllerPlugins(),
    oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  }),
});
