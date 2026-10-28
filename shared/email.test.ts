import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEmailPatch, blockPattern, DEFAULT_EMAIL_SETTINGS, emailOn, emailSettings, forwardAddress, forwardingSettings, gmailConfirmation, htmlToText,
  isAutomatic, isBlocked, messageIds, newReplyToken, parseForwardAddress, parseReplyAddress, renderReplyEmail, replyAddress, replyRuleAddress, replyText,
  sameMailbox, threadHeaders, ticketSubject,
} from "./email.ts";

test("settings: lenient read, strict change", () => {
  assert.deepEqual(emailSettings(undefined), DEFAULT_EMAIL_SETTINGS);
  assert.deepEqual(emailSettings({ enabled: "yes", from: 3 }), DEFAULT_EMAIL_SETTINGS);
  const set = applyEmailPatch(DEFAULT_EMAIL_SETTINGS, { from: " Support@Acme.com ", replyDomain: "@Reply.Acme.com.", fromName: "Acme\nSupport" });
  assert.deepEqual(set, { enabled: false, from: "support@acme.com", fromName: "Acme Support", replyDomain: "reply.acme.com" });
  assert.throws(() => applyEmailPatch(DEFAULT_EMAIL_SETTINGS, { enabled: true }), /from first/);
  assert.throws(() => applyEmailPatch(DEFAULT_EMAIL_SETTINGS, { from: "a@b.co", enabled: true }), /domain customers' replies/);
  assert.throws(() => applyEmailPatch(DEFAULT_EMAIL_SETTINGS, { from: "nope" }), /doesn't look like an email/);
  assert.throws(() => applyEmailPatch(DEFAULT_EMAIL_SETTINGS, { replyDomain: "acme" }), /doesn't look like a domain/);
  const on = applyEmailPatch(set, { enabled: true });
  assert.equal(emailOn(on, true), true);
  assert.equal(emailOn(on, false), false, "no binding, no email");
});

test("reply addresses round-trip; others don't parse", () => {
  const token = newReplyToken();
  assert.match(token, /^[a-z0-9]{24}$/);
  assert.notEqual(token, newReplyToken());
  const address = replyAddress(token, "reply.acme.com");
  assert.deepEqual(parseReplyAddress(address), { token, domain: "reply.acme.com" });
  assert.deepEqual(parseReplyAddress(address.toUpperCase()), { token, domain: "reply.acme.com" }, "case-insensitive");
  assert.equal(address, `reply+${token}@reply.acme.com`, "a subaddress of the routing rule's reply@");
  assert.equal(replyRuleAddress("reply.acme.com"), "reply@reply.acme.com");
  // The first addresses given out (c-<token>@, before D-111) still find their chat, +tag or not.
  assert.deepEqual(parseReplyAddress(`c-${token}@reply.acme.com`), { token, domain: "reply.acme.com" });
  assert.deepEqual(parseReplyAddress(`c-${token}+x@reply.acme.com`), { token, domain: "reply.acme.com" });
  assert.equal(parseReplyAddress("reply@reply.acme.com"), null);
  assert.equal(parseReplyAddress("reply+short@reply.acme.com"), null);
  assert.equal(parseReplyAddress("support@reply.acme.com"), null);
  assert.equal(parseReplyAddress("c-short@reply.acme.com"), null);
});

test("same mailbox ignores case, +tags and display names", () => {
  assert.equal(sameMailbox("Pat@Example.com", "pat+support@example.com"), true);
  assert.equal(sameMailbox("Pat Lee <pat@example.com>", "pat@example.com"), true);
  assert.equal(sameMailbox("pat@example.com", "pat@example.org"), false);
});

test("automatic mail is recognised", () => {
  const h = (headers: Record<string, string>) => (name: string) => headers[name] ?? null;
  assert.equal(isAutomatic(h({}), "pat@example.com"), false);
  assert.equal(isAutomatic(h({ "auto-submitted": "no" }), "pat@example.com"), false);
  assert.equal(isAutomatic(h({ "auto-submitted": "auto-replied" }), "pat@example.com"), true);
  assert.equal(isAutomatic(h({ "x-autoreply": "yes" }), "pat@example.com"), true);
  assert.equal(isAutomatic(h({ precedence: "bulk" }), "pat@example.com"), true);
  assert.equal(isAutomatic(h({ "list-id": "<news.example.com>" }), "pat@example.com"), true);
  assert.equal(isAutomatic(h({}), "MAILER-DAEMON@example.com"), true);
  assert.equal(isAutomatic(h({ "x-jun-desk": "1" }), "pat@example.com"), true, "our own email looping back");
  assert.equal(isAutomatic(h({ "auto-submitted": "auto-forwarded" }), "pat@example.com"), true);
  assert.equal(isAutomatic(h({ "auto-submitted": "auto-forwarded" }), "pat@example.com", { forwarded: true }), false, "a support inbox's forwarding rule");
  assert.equal(isAutomatic(h({ "auto-submitted": "auto-replied" }), "pat@example.com", { forwarded: true }), true);
});

test("reply text cuts the quote and the signature", () => {
  assert.equal(replyText("Thanks, that fixed it!\n\n—— Reply above this line ——\nSam · 1 Oct\nTry again"), "Thanks, that fixed it!");
  assert.equal(replyText("Yes please.\n\nOn Mon, 5 Oct 2026 at 10:00, Acme <c-x@reply.acme.com> wrote:\n> Shall I refund it?"), "Yes please.");
  // Gmail wraps the attribution line.
  assert.equal(replyText("Yes please.\n\nOn Mon, 5 Oct 2026 at 10:00, Acme Support\n<c-abc@reply.acme.com> wrote:\n> Shall I?"), "Yes please.");
  assert.equal(replyText("Ok\r\n\r\n-----Original Message-----\r\nFrom: Acme"), "Ok");
  assert.equal(replyText("Ok\n\n________________________________\nFrom: Acme Support\nSent: Monday\nTo: Pat"), "Ok");
  assert.equal(replyText("From: the start I had this bug.\nStill there."), "From: the start I had this bug.\nStill there.", "a line starting with From: isn't a quote by itself");
  assert.equal(replyText("Done.\n\n-- \nPat Lee\nCEO"), "Done.");
  assert.equal(replyText("Done.\n\nSent from my iPhone"), "Done.");
  assert.equal(replyText("> only a quote"), "> only a quote", "nothing above the quote: keep it all");
});

test("html-only mail becomes text", () => {
  assert.equal(htmlToText("<div>Hi&nbsp;there<br>Line 2</div><blockquote>old</blockquote>"), "Hi there\nLine 2");
  assert.equal(htmlToText("<style>p{}</style><p>a &amp; b</p><p>c</p>"), "a & b\nc");
});

test("the email lists the replies, escaped, with the marker on top", () => {
  const email = renderReplyEmail({
    workspaceName: "Acme",
    messages: [{ author: "Sam", body: "Fixed <b>now</b>", files: [{ name: "log.txt", url: "https://desk.example/api/files/f_1" }] }],
  });
  assert.equal(email.subject, "Re: your conversation with Acme");
  assert.match(email.text, /^—— Reply above this line ——\n\nSam\nFixed <b>now<\/b>\nlog.txt: https:\/\/desk.example\/api\/files\/f_1/);
  assert.match(email.html, /Fixed &lt;b&gt;now&lt;\/b&gt;/);
  assert.doesNotMatch(email.html, /<b>now/);
  const runs = renderReplyEmail({ workspaceName: "Acme", messages: [{ author: "Sam", body: "One", files: [] }, { author: "Sam", body: "Two", files: [] }, { author: "Acme", body: "Three", files: [] }] });
  assert.match(runs.text, /\n\nSam\nOne\n\nTwo\n\nAcme\nThree\n/, "the name once per run of messages");
});

test("thread headers reference earlier messages", () => {
  assert.deepEqual(threadHeaders([]), {});
  assert.deepEqual(threadHeaders(["a@x", "<b@x>"]), { "In-Reply-To": "<b@x>", References: "<a@x> <b@x>" });
});

test("C-13: the forwarding address round-trips and isn't a reply address", () => {
  const token = newReplyToken();
  const address = forwardAddress(token, "reply.acme.com");
  assert.equal(address, `reply+in-${token}@reply.acme.com`);
  assert.deepEqual(parseForwardAddress(address.toUpperCase()), { token, domain: "reply.acme.com" });
  assert.equal(parseReplyAddress(address), null);
  assert.equal(parseForwardAddress(replyAddress(token, "reply.acme.com")), null);
  assert.equal(parseForwardAddress("reply+in-short@reply.acme.com"), null);
  assert.deepEqual(forwardingSettings({ enabled: true, token: "t", confirmation: { code: 1 } }), { enabled: true, token: "t", lastAt: null, confirmation: null });
});

test("C-13: Gmail's forwarding confirmation is recognised", () => {
  const text = [
    "sam@gmail.com has requested to automatically forward mail to your email address",
    "Confirmation code: 123456789",
    "To allow it, click the link below:",
    "https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc.",
  ].join("\n");
  assert.deepEqual(gmailConfirmation("forwarding-noreply@google.com", "(#123456789) Gmail Forwarding Confirmation - Receive Mail from sam@gmail.com", text), {
    code: "123456789",
    link: "https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc",
  });
  assert.equal(gmailConfirmation("sam@gmail.com", "(#123456789) Gmail Forwarding Confirmation", text), null, "only from Google");
  assert.equal(gmailConfirmation("forwarding-noreply@google.com", "Hello", text), null);
});

test("C-13: message ids, ticket subjects, blocked senders", () => {
  assert.deepEqual(messageIds("<a@x.com>  <b@y.com>"), ["a@x.com", "b@y.com"]);
  assert.deepEqual(messageIds("a@x.com"), ["a@x.com"]);
  assert.deepEqual(messageIds(undefined), []);
  assert.equal(ticketSubject("Re: Fwd: RE[2]:  Billing\n page broken "), "Billing page broken");
  assert.equal(ticketSubject(""), "(no subject)");
  assert.equal(ticketSubject("x".repeat(300)).length, 200);
  assert.equal(blockPattern("Spam+x@Junk.io", "address"), "spam@junk.io");
  assert.equal(blockPattern("spam@junk.io", "domain"), "@junk.io");
  assert.ok(isBlocked("spam+y@junk.io", ["spam@junk.io"]));
  assert.ok(isBlocked("other@junk.io", ["@junk.io"]));
  assert.ok(!isBlocked("sam@acme.com", ["@junk.io", "spam@junk.io"]));
});

test("C-13: a ticket's email answers under its subject", () => {
  const email = renderReplyEmail({ workspaceName: "Acme", subject: "Billing page broken", messages: [{ author: "Acme", body: "Fixed", files: [] }] });
  assert.equal(email.subject, "Re: Billing page broken");
});
