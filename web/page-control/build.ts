/**
 * Build plugins for anything that bundles @page-agent/page-controller (the widget's page-control chunk
 * in vite.config.ts, and the browser extension's content script in extension/wxt.config.ts). Plain
 * Rollup-style hooks, so they work as Rolldown and Vite plugins alike.
 */
export function pageControllerPlugins() {
  return [
    {
      // Its mask overlay is never used (enableMask: false): leave it out of the bundle.
      name: "jun:no-mask",
      resolveId: (id: string) => (/SimulatorMask/.test(id) ? "\0jun-no-mask" : null),
      load: (id: string) => (id === "\0jun-no-mask" ? "export class SimulatorMask {}" : null),
    },
    {
      // executeJavascript is never exposed; its direct eval goes too (no eval on anyone's page, the
      // Chrome Web Store's no-remote-code rule, and a direct eval stops the minifier renaming around it).
      name: "jun:no-eval",
      transform(code: string, id: string) {
        if (!/page-controller[\\/]dist[\\/]lib[\\/]page-controller\.js$/.test(id)) return null;
        const out = code.replace(/\beval\(`[^`]*`\)/, '(() => { throw new Error("Not available in Jun"); })()');
        if (out === code) throw new Error("page-controller changed: check its executeJavascript (web/page-control/build.ts, jun:no-eval)");
        return out;
      },
    },
  ];
}
