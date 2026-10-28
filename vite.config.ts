import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { build as rolldown } from "rolldown";
import { minifySync } from "rolldown/utils";
import { defineConfig, type Plugin } from "vite";

/**
 * public/widget.js stays readable in the repo; the copy we serve is minified (it runs on
 * every customer page, budget: 6 KB gzipped, D-38). Keeps the license header.
 */
function minifyLoader(): Plugin {
  return {
    name: "jun:minify-loader",
    apply: "build",
    writeBundle(options) {
      // The lazy chunks are minified the same way: AI-21's page actions, the island's (D-99), D-138's plain button, V-18's identify bridge and D-149's clicks.
      const titles: Record<string, string> = { "widget.js": "widget loader", "widget-actions.js": "page actions", "widget-island.js": "island", "widget-button.js": "chat button", "widget-identify.js": "identify bridge", "widget-clicks.js": "clicks" };
      for (const name of Object.keys(titles)) {
        const file = join(options.dir ?? "", name);
        if (!existsSync(file)) continue;
        const source = readFileSync(file, "utf8");
        if (!source.startsWith("/*!")) continue; // already minified
        const result = minifySync(name, source, { compress: true, mangle: true });
        if (result.errors.length) throw new Error(`${name} minify failed: ${result.errors.map((e) => e.message).join("; ")}`);
        writeFileSync(file, `/*! Jun ${titles[name]} | MIT License | source: public/${name} */\n${result.code}`);
      }
    },
  };
}

/**
 * The widget frame loads on customers' pages, so it's its own build on Preact (preact/compat)
 * instead of React: about 30 KB of JS gzipped instead of about 92 KB (D-41). The dashboard stays
 * on React. `vite dev` serves both pages from one module graph, so the frame runs on React there;
 * check widget changes on a built version too (scripts/deploy.ts, or `wrangler versions upload`).
 */
const PREACT: [RegExp, string][] = [
  [/^react-dom\/client$/, "preact/compat/client"],
  [/^react-dom$/, "preact/compat"],
  [/^react\/jsx-(dev-)?runtime$/, "preact/jsx-runtime"],
  [/^react$/, "preact/compat"],
];
function preactWidget(): Plugin {
  return {
    name: "jun:preact-widget",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "widget",
    resolveId(source, importer, options) {
      const to = PREACT.find(([from]) => from.test(source))?.[1];
      return to ? this.resolve(to, importer, { ...options, skipSelf: true }) : null;
    },
  };
}
/**
 * AI-32 (D-93): widget-page-control.js, the chunk the loader adds on sites with data-page-control="on".
 * One self-contained, minified IIFE (no imports at runtime) from web/page-control/index.ts, bundling
 * @page-agent/page-controller. Its mask overlay (a dynamic import of SimulatorMask + ai-motion) is
 * never used (enableMask: false), so it's swapped for an empty class instead of being inlined.
 * Built after the client build (which empties dist/client) and served on demand by `vite dev`.
 */
const PAGE_CONTROL = "widget-page-control.js";
async function bundlePageControl(): Promise<string> {
  const out = await rolldown({
    input: resolve(import.meta.dirname, "web/page-control/index.ts"),
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "jun:no-mask",
        resolveId: (id) => (/SimulatorMask/.test(id) ? "\0jun-no-mask" : null),
        load: (id) => (id === "\0jun-no-mask" ? "export class SimulatorMask {}" : null),
      },
      {
        // executeJavascript is never exposed; its direct eval goes too (no eval on customers' pages,
        // and a direct eval stops the minifier renaming anything around it).
        name: "jun:no-eval",
        transform(code, id) {
          if (!/page-controller[\\/]dist[\\/]lib[\\/]page-controller\.js$/.test(id)) return null;
          const out = code.replace(/\beval\(`[^`]*`\)/, '(() => { throw new Error("Not available in Jun"); })()');
          if (out === code) throw new Error("page-controller changed: check its executeJavascript (vite.config.ts, jun:no-eval)");
          return out;
        },
      },
    ],
    output: {
      format: "iife",
      codeSplitting: false,
      minify: { compress: { dropConsole: true }, mangle: true },
      banner: "/*! Jun page control | MIT License | source: web/page-control/index.ts\n * includes @page-agent/page-controller (https://github.com/alibaba/page-agent), MIT License, Copyright (c) 2026 SimonLuvRamen, Copyright (c) 2026 Alibaba Group Holding Limited */",
    },
  });
  return out.output[0].code;
}
function pageControlChunk(): Plugin {
  return {
    name: "jun:page-control",
    configureServer(server) {
      server.middlewares.use(`/${PAGE_CONTROL}`, (_req, res, next) => {
        bundlePageControl().then((code) => {
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.end(code);
        }, next);
      });
    },
    buildApp: {
      order: "post",
      async handler() {
        writeFileSync(resolve(import.meta.dirname, "dist/client", PAGE_CONTROL), await bundlePageControl());
      },
    },
  };
}

/** Builds the widget environment after the Cloudflare plugin's own build (client + Worker). */
function buildWidget(): Plugin {
  return {
    name: "jun:build-widget",
    apply: "build",
    buildApp: {
      // After the config's buildApp (the Cloudflare plugin's), whose client build empties the folder.
      order: "post",
      async handler(builder) {
        const widget = builder.environments.widget;
        if (widget && !widget.isBuilt) await builder.build(widget);
      },
    },
  };
}

// Builds the dashboard (index.html), the widget frame (widget.html) and the Worker
// (worker/) together; `vite dev` runs them in the Workers runtime with local D1,
// R2 and Durable Objects. public/ (widget.js loader, demo.html) is copied; widget.js gets minified.
const TEST_VARS = ["JUN_EMAIL_DELAY_MS", "JUN_TELEMETRY_URL", "SLACK_API_URL"];

export default defineConfig({
  // JUN_STATE_DIR gives a separate local database (used by the e2e tests so they don't
  // touch your own local desk). Pair with `wrangler ... --persist-to` on the same path.
  // Tailwind (shadcn/ui) only processes CSS that imports it: web/desk.css, the dashboard's sheet.
  // The widget frame keeps its own plain CSS (web/styles.css + web/widget/widget.css).
  plugins: [preactWidget(), react(), tailwindcss(), minifyLoader(), buildWidget(), pageControlChunk(), cloudflare({
    ...(process.env.JUN_STATE_DIR ? { persistState: { path: process.env.JUN_STATE_DIR } } : {}),
    // Test-only vars from the shell: e2e-email's email replies after seconds instead of minutes; the
    // usage ping (T-20) to a local collector.
    ...(TEST_VARS.some((name) => process.env[name])
      ? { config: { vars: Object.fromEntries(TEST_VARS.filter((name) => process.env[name]).map((name) => [name, process.env[name]!])) } }
      : {}),
  })],
  // Listen on 127.0.0.1: dev-only "Sign in with ChatGPT" must return to a 127.0.0.1
  // loopback URL (OpenAI forbids substituting localhost), and on Windows Vite would
  // otherwise bind IPv6 only. http://localhost:5173 still works in browsers.
  server: { host: "127.0.0.1" },
  // shadcn/ui imports: "@/components/ui/…", "@/lib/utils.ts".
  resolve: { alias: { "@": resolve(import.meta.dirname, "web") } },
  // Only the browser build has two pages; the Worker build keeps its own entry.
  environments: {
    client: {
      // The Dashboard's chart is lazy-loaded, so dev would only discover these on first open
      // and answer "504 Outdated Optimize Dep" until a reload: pre-bundle them at startup.
      optimizeDeps: { include: ["motion/react", "d3-scale", "d3-shape"] },
      build: { rollupOptions: { input: { main: "index.html" } } },
    },
    // The widget frame (see preactWidget) and the MCP previews' screenshot page (shot.html): built into
    // the same folder, after the client build.
    widget: {
      consumer: "client",
      build: { outDir: "dist/client", emptyOutDir: false, copyPublicDir: false, rollupOptions: { input: { widget: "widget.html", shot: "shot.html" } } },
    },
  },
});
