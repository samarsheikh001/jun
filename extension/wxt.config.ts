import { resolve } from "node:path";
import { defineConfig } from "wxt";
import { pageControllerPlugins } from "../web/page-control/build.ts";

// Jun for Chrome (E-01, D-155; docs/research/12-browser-extension.md). Manifest V3, built by WXT.
// The chat is the widget's island (web/widget/island.tsx and its parts, widget.css), drawn in an
// extension frame the content script puts at the bottom of the page (src/entrypoints/island/): the
// page's CSP can't block an extension frame, and the page can't read into it. Pages are reached only
// where the person allows it: activeTab (a click on the toolbar button) and per-site optional host
// permissions, never every site at install. The person's own AI is called from the island frame, so
// its hosts are the required ones: api.openai.com, auth.openai.com (Sign in with ChatGPT's tokens)
// and 127.0.0.1:1455 (to read the sign-in tab's loopback callback, src/lib/chatgpt.ts).

const ROOT = resolve(import.meta.dirname, "..");
// The widget's components import React; like the widget frame (vite.config.ts, D-41) they run on Preact.
const PREACT: [RegExp, string][] = [
  [/^react-dom\/client$/, "preact/compat/client"],
  [/^react-dom$/, "preact/compat"],
  [/^react\/jsx-(dev-)?runtime$/, "preact/jsx-runtime"],
  [/^react$/, "preact/compat"],
];

export default defineConfig({
  srcDir: "src",
  outDir: process.env.JUN_EXT_TEST ? "dist-test" : "dist",
  manifest: {
    name: "Jun: help on any page",
    description: "Ask how to do anything on the page you're on. Jun shows you where, or does it after you confirm. Runs on your ChatGPT plan or your own key.",
    permissions: ["activeTab", "scripting", "storage"],
    // JUN_EXT_TEST=1: a test build that may reach every page without a click (scripts/e2e-extension.ts).
    host_permissions: ["https://api.openai.com/*", "https://auth.openai.com/*", "http://127.0.0.1:1455/*", ...(process.env.JUN_EXT_TEST ? ["<all_urls>"] : [])],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    action: { default_title: "Ask Jun about this page" },
    // The island frame, put on the page by the content script.
    web_accessible_resources: [{ resources: ["island.html"], matches: ["<all_urls>"] }],
  },
  hooks: {
    // The widget's fonts and mark (web/styles.css and island.tsx load them from the root).
    "build:publicAssets": (_wxt, files) => {
      for (const name of ["fonts/outfit-latin-wght-normal.woff2", "fonts/geist-mono-latin-400-normal.woff2", "fonts/OFL-Outfit.txt", "fonts/OFL-GeistMono.txt", "jun-agent.svg"]) {
        files.push({ absoluteSrc: resolve(ROOT, "public", name), relativeDest: name });
      }
    },
  },
  vite: () => ({
    plugins: [
      ...pageControllerPlugins(),
      {
        name: "jun:preact",
        enforce: "pre" as const,
        async resolveId(this: { resolve: (s: string, i?: string, o?: object) => Promise<unknown> }, source: string, importer?: string, options?: object) {
          const to = PREACT.find(([from]) => from.test(source))?.[1];
          return to ? this.resolve(to, importer, { ...options, skipSelf: true }) : null;
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  }),
});
