# Jun for Chrome

Ask how to do anything on the page you're on. Jun reads the page, shows you where things are
(a ring and a note on the element) and, when you ask, clicks, types or chooses for you after you
confirm. It runs on your own AI key; there is no Jun server. MIT licensed.

Feature E-01 (`docs/features.md`), decision D-155, research `docs/research/12-browser-extension.md`.

## Try it

```sh
npm install
npm run build -w extension
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist/chrome-mv3`.
Click the Jun button in the toolbar on any website, add your OpenAI API key in Settings and ask.

`npm run dev -w extension` opens a browser with the extension loaded and reloads it on changes.

## How it works

| Part | Where | What |
|---|---|---|
| Side panel | `src/entrypoints/sidepanel/` | The chat, Confirm cards and settings. Runs the agent loop (`src/lib/agent.ts`: AI SDK `streamText` with the page tools) against the active tab |
| Content script | `src/entrypoints/page.content.ts` | Injected on demand with `chrome.scripting` when you ask, never declared on every page. Runs the desk's shared page tools (`web/page-control/tools.ts`: `read_page`, `click`, `type_text`, `choose_option`, `scroll_page`, plus `point_at`) |
| Background | `src/entrypoints/background.ts` | Opens the panel from the toolbar button (which grants `activeTab`) |
| Protocol | `src/lib/protocol.ts` | The panel ↔ page messages |

**Permissions:** `sidePanel`, `activeTab`, `scripting`, `storage`, and `api.openai.com`. Page access is
per site: the toolbar click gives access until you leave the page, **Allow on <site>** keeps it.

**Privacy:** masking is on by default (emails, card-like numbers, tokens, the address's query values);
you can turn it off in Settings. Password, card and one-time-code fields, hidden inputs and anything
marked `data-jun-private` are never read or touched either way. Page text goes to the AI inside
`<page_content>` markers and the AI is told it's data, not instructions. Clicks, typing and choices
wait for your Confirm unless you chose otherwise. The key is kept in `chrome.storage.local` under its
own key and sent only to OpenAI.

## Tests

- `npm test` (root) runs `src/lib/*.test.ts`, including the agent loop on a mock model.
- `node scripts/e2e-extension.ts` builds a test copy (`JUN_EXT_TEST=1` → `dist-test/`, may reach every
  page), loads it into a throwaway headless Chrome over the DevTools Protocol and runs every tool on
  `scripts/e2e-extension-page.html` (strict CSP, password field, private block). `CHROME_PATH` picks the browser.

## Not yet

Sign in with ChatGPT (needs OpenAI's approval for its open-source programme; its redirect is
loopback-only), other providers, runs that outlive the panel, several tabs, cross-origin frames, a
Chrome Web Store listing and privacy policy.
