# 11 — What Chatbase has that we don't (as of 2026-10-29)

Saved to discuss later; nothing here is agreed or scheduled. Source: Chatbase's docs index (`chatbase.co/docs/llms.txt`, about 250 pages) and the pages for each overlapping feature, checked against our code and `docs/features.md`.

## Gaps, most important first

1. **Abuse protection** (their Build → Guardrails). A per-device message limit with a custom "slow down" message, automatic spam detection, and country blocking. We only have the monthly AI reply cap (`monthlyReplyCap`). One script can spend a month's AI budget. **Recommended before any public launch.**
2. **Drafts, publish and roll back.** Edits go to a draft (the Playground uses it); Publish shows a word-level diff grouped by area; every publish is a version you can compare and go back to. We keep settings as files in git (AI-18), so history exists, but nothing in the dashboard shows or undoes it.
3. **Tests with a simulated customer.** Another model plays the customer from a written scenario over several turns, and each conversation is graded against success criteria. Our Agent → Tests (`web/agent/TestsView.tsx`, `jun eval`) grades one reply to one message.
4. **Ready-made actions.** Stripe, Calendly, Cal.com, Shopify, Salesforce, web search, a lead form with a webhook, transfer to a phone number. We can build each with HTTP actions and cards (AI-05, W-22), but none comes pre-made.
5. **Helpdesk extras.** Priority, custom fields, saved views, CSV export, merging tickets, teams and routing (our I-09, v2), shifts / time off / attendance, trigger rules (I-17, v2), one-click translation of customer messages, AI-drafted replies for a human to edit (I-12, v2), macros (we have saved replies, I-06).
6. **Channels.** WhatsApp (ours is built on the `whatsapp` branch, C-04), Messenger, Instagram, phone (Twilio, SIP). Handoff into Zendesk, Freshdesk, Intercom, HubSpot, Gorgias and others. Zapier and viaSocket. Outbound WhatsApp campaigns.
7. **Developer side.** Public REST API and webhooks (T-03, v2), iOS and Android SDKs (W-13, v3), a hosted help page (K-05, v2), contact import from CSV, install guides for WordPress, Webflow, Wix, Framer and Bubble, HIPAA.

## No longer unique to us

Chatbase now has an MCP server, a CLI, Backstage (manage the agent by chatting with it, like our desk assistant I-19 and MCP AI-31), a card builder with components and states, client-side actions and identity verification.

## Still ours

Struggle detection and debug context (S-01 to S-17), GitHub / Linear issues from a chat (S-08), the live visitor list (V-01), the AI using the customer's website (AI-21, AI-32), and the whole desk on the owner's own Cloudflare account (T-07).

## Suggested for release 1

Neither blocks v1, but both are cheap: a per-visitor message limit (item 1) and conversation export to CSV (item 5). The rest fits v1.1 or v2.
