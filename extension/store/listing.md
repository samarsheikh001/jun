# Chrome Web Store listing: Jun for Chrome

Everything the developer dashboard asks for, ready to paste (https://chrome.google.com/webstore/devconsole).
Images in this folder are made by `node scripts/extension-store-shots.ts`; the package by
`npm run zip -w extension` (→ `extension/dist/`).

## Store listing tab

**Name** (from the manifest): Jun: help on any page

**Summary** (manifest description, ≤ 132 chars):
Ask how to do anything on the page you're on. Jun shows you where, or does it after you confirm. Runs on your ChatGPT plan or your own key.

**Category:** Productivity → Tools (or "Workflow & Planning")
**Language:** English

**Description:**

> Stuck on a website? Ask Jun.
>
> Click the Jun button on any page and ask how to do something: "Where do I download my invoices?", "How do I add a teammate?", "What can I do here?". Jun reads the page you're on and answers in a few short steps, and points at the right button so you can do it yourself.
>
> Want it done for you? Ask, and Jun clicks, types or picks options on the page, one step at a time, after you confirm. You can let it go ahead on sites you trust.
>
> • Guide first: it shows you where things are, it doesn't take over.
> • Your AI: sign in with your ChatGPT account (Plus or Pro), or use your own OpenAI API key. No Jun account, no subscription, no Jun server.
> • Private by default: password, card and one-time-code fields are never read; emails, card numbers and tokens are masked before anything goes to your AI. You decide.
> • Screenshots: show Jun what you see with one click; you check it before it's sent.
> • Open source: every line is on GitHub.
>
> Jun for Chrome is part of Jun, an open-source AI support desk: https://jun.so

**Screenshots** (1280×800): `screenshot-1-rest.png`, `screenshot-2-ask.png`, `screenshot-3-guide.png`
**Small promo tile** (440×280): `promo-tile-440x280.png`
**Store icon** (128×128): `../public/icon/128.png`
**Homepage URL:** https://jun.so
**Support URL:** https://github.com/samarsheikh001/jun/issues

## Privacy practices tab

**Single purpose:**
Help the person with the web page they're on: answer how-to questions about it, point at the elements involved, and carry out steps on the page that they ask for and confirm.

**Permission justifications:**

| Permission | Why |
|---|---|
| `activeTab` | When the person clicks the toolbar button, Jun gets access to that one tab so it can read the page and act on it at their request. |
| `scripting` | Injects Jun's content script (the on-page assistant and its page tools) into the tab the person summoned it on, only then. |
| `storage` | Keeps the person's settings, their sign-in (ChatGPT tokens or API key) and the chat on each tab, in the browser only. |
| Host `https://api.openai.com/*` | Sends the person's question and the page's (masked) text to their own AI to write the answer. |
| Host `https://auth.openai.com/*` | "Sign in with ChatGPT": exchanges the sign-in code for tokens, using OpenAI's documented flow for open-source apps. |
| Host `http://127.0.0.1:1455/*` | OpenAI's sign-in returns to this loopback address; the extension reads the sign-in tab's address there to finish signing in. Nothing is served or fetched there. |
| Optional hosts `https://*/*`, `http://*/*` | Requested for one site at a time, only when the person clicks "Keep Jun on <site>", so Jun can come back on that site's next pages without another click. |
| `web_accessible_resources` (`island.html`) | Jun's chat is drawn in the extension's own frame on the page, so the page can't read it. |

**Remote code:** No. All code is in the package; the AI's replies are text and tool calls from a fixed list (read page, click, type, choose, scroll, point), never code to run.

**Data usage** (check these):
- Authentication information: yes (ChatGPT tokens / API key, stored locally, sent only to OpenAI).
- Website content: yes (the page's text, masked, and screenshots the person sends, to their AI provider at their request).
- Web history: yes (the address of the page they ask about goes with the page text; query values removed while masking is on).
- Everything else: no.

Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://jun.so/extension/privacy

## Distribution

Public, all regions. Free.

## Notes for the reviewer (the "Test instructions" field)

> Jun needs an AI to answer. Easiest: open the extension's options page (Settings), choose "OpenAI API key" and paste this test key: <PASTE A TEST KEY WITH A SMALL SPENDING LIMIT>. Then open any website (e.g. https://en.wikipedia.org), click the Jun toolbar button, and ask "What can I do on this page?" or "Show me the search box". It answers and rings the element on the page. Ask "search for Chrome for me" to see a click/type step wait for Confirm.
