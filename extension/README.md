# Jun for Chrome

Ask how to do anything on the page you're on. Jun reads the page, shows you where things are
(a ring and a note on the element) and, when you ask, clicks, types or chooses for you after you
confirm. It runs on your own AI: **Sign in with ChatGPT** (your Plus or Pro plan, the default) or an
OpenAI API key. There is no Jun server.

Feature E-01 (`docs/features.md`), decision D-155, research `docs/research/12-browser-extension.md`.

## Try it

```sh
npm install
npm run build -w extension
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist/chrome-mv3`.
Click the Jun button in the toolbar on any website: the island appears at the bottom of the page.
**Sign in with ChatGPT** on it (or add an OpenAI API key in Settings) and ask. `/` opens it.

`npm run dev -w extension` opens a browser with the extension loaded and reloads it on changes.

## How it works

| Part | Where | What |
|---|---|---|
| Island | `src/entrypoints/island/` | The chat: the widget's island (`web/widget/island.tsx`, `answer.tsx`, the pill `Composer`, `widget.css`) in an extension frame at the bottom of the page. Runs the agent loop (`src/lib/agent.ts`: AI SDK `streamText` with the page tools) against its tab; the chat is kept per tab in `storage.session` |
| Content script | `src/entrypoints/page.content.ts` | Injected on demand with `chrome.scripting` when you summon Jun, never declared on every page. Hosts the island's frame like the widget's loader (`jun:css` sizes and clips it, `/` opens it) and runs the desk's shared page tools (`web/page-control/tools.ts`: `read_page`, `click`, `type_text`, `choose_option`, `scroll_page`, plus `point_at`) |
| Background | `src/entrypoints/background.ts` | The toolbar button summons the island (the click grants `activeTab`); tells the island frame its tab; brings the island back after a page load on sites you allowed |
| Settings | `src/entrypoints/options/` | Your AI, model, masking, when to ask |
| Protocol | `src/lib/protocol.ts` | The panel ↔ page messages |

**Sign in with ChatGPT:** OpenAI's documented flow for open-source, locally hosted apps, the same code
as the desk and the CLI (`packages/llm/src/chatgpt/`). Its redirect must be `http://127.0.0.1:1455/auth/callback`,
which an extension can't listen on, so `src/lib/chatgpt.ts` opens the sign-in in a tab, reads the tab's
address when it reaches the callback (the browser shows a "can't connect" page for a moment) and closes it.
Tokens stay in `chrome.storage.local` (`jun.chatgpt`) and go only to OpenAI.

**Permissions:** `sidePanel`, `activeTab`, `scripting`, `storage`, `api.openai.com`, `auth.openai.com`
and `127.0.0.1:1455` (to read the sign-in callback). Page access is
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

Other providers (Anthropic, Gemini), runs that survive a page load mid-answer (the loop lives in the island frame), several tabs, cross-origin frames, a
Chrome Web Store listing and privacy policy.
