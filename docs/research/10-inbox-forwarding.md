# 10 — Forwarding a support inbox into the desk (C-13), design (as of 2026-10-28)

For C-13: mail sent to a company's support address (support@acme.com) starts a conversation in the desk, the AI and the team answer it, and the answer goes back by email. Builds on C-02 (D-110, D-111), which already sends and receives mail for chats that began in the widget. Nothing here is built. Facts not confirmed are marked *(to check)*.

## 1. What the owner does

1. Sets up email once, as today (Channels → Email): a from address and a reply domain, both done by "Set up and turn on" (D-111).
2. Turns on **Forward a support inbox** on the same page. The desk shows one address to forward to, with a copy button:
   `reply+in-<token>@reply.acme.com`
3. Adds a forwarding rule in their mail provider. The page has a tab each for Gmail, Google Workspace, Microsoft 365 / Outlook and "Other".
4. The page then says "Waiting for the first email…", and once one arrives, "Receiving · last email 3 min ago".

The forwarding address is a subaddress of the `reply@` rule that D-111 already creates, so **no new Cloudflare setup** is needed: subaddressing routes it to the Worker like every `reply+…` address. The token is random (a new one per workspace, rotatable on the page), so nobody can guess the address and mail the desk directly while skipping support@.

### Provider trouble the page should explain

- **Gmail / Google Workspace (personal forwarding):** Gmail sends a confirmation email to the forwarding address before it forwards anything. That mail will land in the desk. The desk should recognise it (From `forwarding-noreply@google.com`) and show the confirmation code and link on the Channels page instead of opening a ticket *(to check: exact sender and format)*. Workspace admins can instead add a routing rule in the admin console, which needs no confirmation.
- **Microsoft 365:** automatic forwarding to outside addresses is blocked by default by the outbound anti-spam policy (the sender gets NDR `5.7.520`). An admin must turn it on, for everyone or for one mailbox, in Defender → Anti-spam → Outbound policy ([matrixpost](https://blog.matrixpost.net/control-automatic-external-email-forwarding-in-microsoft-365/), [office365itpros](https://office365itpros.com/2020/11/12/microsoft-clamps-down-mail-forwarding-exchange-online/)). The page should say this up front, because it's the most common reason "nothing arrives".
- **Domain already on Cloudflare:** the owner can skip forwarding and route `support@` to the Worker directly with an Email Routing rule. The desk can offer this as one button, since it already holds the Cloudflare token (D-111): a literal rule `support@acme.com` → Worker. This only works if support@ isn't also a real mailbox someone reads.

## 2. What happens to a mail

The Worker's `email()` handler gets a new first branch: the `to` address is `reply+in-<token>@<reply domain>`.

1. **Find the workspace** by the forwarding token (a new column on the inbox settings, see §5). Unknown token or forwarding off → reject ("No such address.").
2. **Drop automatic mail** with the existing `isAutomatic` (bounces, out-of-office, lists, our own `X-Jun-Desk`). Newsletters sent to support@ fall out here, which is what we want.
3. **Read the sender from the `From:` header, not the envelope.** After a forward, the envelope sender is the forwarder (Gmail rewrites it with SRS), and the header `From:` is still the customer. Cloudflare Email Routing already rejects mail that fails SPF *and* DKIM, and it enforces the sender's DMARC policy ([changelog](https://developers.cloudflare.com/changelog/2025-06-30-mail-authentication), [postmaster](https://developers.cloudflare.com/email-routing/postmaster/)). So a spoofed From on a domain with strict DMARC never reaches us. Whether that check looks at the original sender or at the forwarding hop is *(to check: send a forwarded test and log the headers)*.
4. **Thread or start.** Look up `In-Reply-To` and `References` in a new `email_messages` table (§5). If one of them is a mail we sent or received in this workspace, the mail joins that conversation: it goes through the existing `receiveEmail` RPC, with `replyText` cutting the quote, and it reopens a resolved chat. This covers a customer who replies to support@ instead of our reply address, and the copy a reply-all sends to both. Both copies have the same Message-ID, so the existing idempotent `clientMsgId` keeps one message. If nothing matches, it's a **new ticket**.
5. **New ticket:**
   - **Contact:** reuse an *email-only* contact with that address in this workspace, else create one (name from the From display name, `email` set, no visitor token, `verified_at` null). Never attach to a verified contact. If a verified contact has the same email, the existing "Same person" suggestion (0024 contact people) offers the link, and a teammate decides (D-23).
   - **Conversation:** `type = 'ticket'`, the subject in a new `subject` column, `meta.via: "email"` on the first message, and a fresh `email_token`. `handling` follows the AI setting, as the widget does.
   - **First message:** the whole text (HTML → text as today), cut to `MAX_MESSAGE_LENGTH` (10,000), signature trimmed, files kept. Quoted history is cut only if the mail is itself a reply (`In-Reply-To` set) that we didn't match.
   - **Cc'd people:** a note listing them ("Also sent to: …"). Replies go only to the sender in the first version.
6. **Answer.** The AI or a teammate replies in the desk as in any chat. The existing `emailUnseenReplies` sends it, because a ticket never has a widget tab open. The subject becomes `Re: <their subject>` instead of `Re: your conversation with <workspace>`. It's sent from the workspace's from address with `Reply-To: reply+<conversation token>@…` and threads under their mail with `In-Reply-To`/`References` (their Message-ID is stored in the conversation's `EMAIL_IDS_KEY`, as for replies).
7. **Timing:** the 2-minute batch delay stays, so a teammate typing two replies sends one email. Tickets could use a shorter delay. 2 minutes is fine for email; leave it.

## 3. Spam and abuse

A public support address gets junk, and every message the AI answers costs tokens, so:

- Email Routing's SPF/DKIM/DMARC checks run first (above). `isAutomatic` drops bulk mail.
- **Rate limits:** at most 10 new tickets an hour from one address, and 300 a day per workspace (numbers to tune). Mail over a limit is still kept, as a closed ticket marked "Over the limit". Nothing is lost, the AI doesn't answer it, and nobody is paged.
- **Mark as spam** on a ticket: closes it, hides it from the inbox, and blocks the sender's address (or their whole domain, as a choice) for this workspace. Mail from a blocked sender is accepted and dropped, never bounced, so spammers learn nothing.
- **The AI doesn't answer** a sender's first mail while it looks like spam. A cheap check on the first message only (e.g. the existing topic or intent call is asked one extra yes/no question) puts it in the team's queue instead. *(Open question: build this in v1 or wait until spam is a real problem? See §7.)*
- **Loops:** our mail carries `Auto-Submitted: auto-generated` and `X-Jun-Desk`, and inbound drops both. A ticket gets at most 20 emails a day (`MAX_EMAILS_PER_DAY`) and takes at most 30 inbound an hour (`MAX_INBOUND_PER_HOUR`), as today.

## 4. Identity and safety

- An email contact is **never verified** (D-23). The From line comes from the sender, and DMARC only shows that the domain allowed it. The AI gets no `{user.*}` for it, and website actions that need a signed-in user don't run. The AI can still answer from knowledge and run actions that don't need identity.
- Someone who fakes a customer's address gets nothing back: replies go to the From address, which is the real customer.
- The forwarding token and the Cloudflare token stay where tokens live today (hub DO storage). The token is never sent to the model or written to a message.

## 5. Data

- **Migration `0028_email_tickets.sql`:**
  - `conversations.subject TEXT` (null for chats).
  - `email_messages (message_id_hash TEXT PRIMARY KEY, workspace_id TEXT, conversation_id TEXT, created_at INTEGER)`: every Message-ID we send or receive, hashed, so a reply can find its conversation without opening each DO. Old rows can go after a year.
  - `blocked_senders (workspace_id, pattern, created_by, created_at)`: an address or `@domain`.
- **Settings** stay in the widget inbox's `email` settings (as D-110): `forwarding: { enabled, token }` plus the last time a mail arrived (for "Receiving · 3 min ago").
- **No new inbox row.** `inboxes.channel` has a CHECK of `('widget')` only. Changing it means rebuilding the table, and `conversations` references `inboxes` with `ON DELETE CASCADE`, so a careless rebuild deletes every conversation. Tickets go in the widget inbox and are told apart by `type = 'ticket'`, which already exists (D-05).

## 6. The desk

- **Inbox list:** a ticket shows its subject as the title and an envelope icon. A "Chats / Emails" filter is cheap to add.
- **Conversation view:** the subject at the top. Email messages keep line breaks and paragraphs, with a "Show quoted text" fold if a quote survived. The reply box says "Replying by email to sam@acme.com".
- **Channels → Email:** the forwarding section from §1, its status, the Gmail confirmation code when one arrives, and the blocked-senders list.
- **Widget:** nothing changes. A ticket never shows in a visitor's widget, even when the same person later chats, because the contacts aren't linked unless a teammate links them.

## 7. Open questions (with a recommendation)

1. **Should the AI answer emails on its own by default?** Recommend: yes, following the AI setting as chats do, with the spam rules in §3. A per-channel "Emails go straight to the team" switch for owners who want it.
2. **A ticket number in the subject** (`[#1042]`, as Zendesk does)? Recommend: no. Threading by Message-ID and the reply address is enough, and it keeps subjects clean.
3. **The AI spam check in v1?** Recommend: no. Ship rate limits and "Mark as spam" first, and add the check if spam shows up.
4. **Reply to Cc'd people too?** Recommend: later. Track it as a follow-up once someone asks.

## 8. Build order and tests

1. Shared, pure: parse the forwarding address, read the header From, pick a thread from `In-Reply-To`/`References`, build the ticket subject, recognise the Gmail confirmation. Unit tests for each, with real headers from Gmail, Outlook and Apple Mail saved under `shared/fixtures/`.
2. Worker: the new `email()` branch, contact + ticket creation (shared with the widget's start-conversation code rather than copied), `email_messages` writes on send and receive, rate limits, blocked senders.
3. Desk: Channels → Email section, ticket title and icon in the inbox, subject in the conversation view, Mark as spam.
4. E2E: extend `scripts/e2e-email.ts`. Forward a fixture mail to the forwarding address, check that a ticket opens, the AI's reply is emailed with `Re: <subject>`, the customer's reply threads back, a reply-all copy to support@ doesn't duplicate, and a blocked sender's mail disappears.
5. Live check once: forward from a real Gmail account and a real Microsoft 365 mailbox, and log what Cloudflare passes to the Worker (§2 step 3).

Rough size: a few days of work. Most of the hard email handling (sending, receiving, quote cutting, attachments, automatic-mail filtering, threading headers) is already in C-02.
