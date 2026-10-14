// Starter files for `jun init` (beside the generated guide, guide.ts). Keep instructions.md in sync with
// DEFAULT_INSTRUCTIONS_MD in worker/ai/config.ts.

export const TEMPLATE: Record<string, string> = {
  "instructions.md": `---
# Guardrails. Remove a line to use the default.
maxReplies: 8            # AI replies per conversation before a person takes over
handoffTopics:           # always hand these to a person
  - legal or security questions
---
# How to talk to customers

- Be friendly, concise and specific. A few short sentences or a short list.
- Use the customer's name if you know it.
- Don't promise refunds, credits, discounts or timelines unless a procedure says you can.
`,
  "tasks/refund.md": `---
description: The customer asks for a refund, their money back, or to cancel a charge.
---
1. Ask for the order or invoice number if they haven't given it.
2. Explain that refunds are reviewed by the billing team within one business day.
3. Hand off to a person with the order number in the reason.
`,
  "tasks/cancellation.md": `---
description: The customer wants to cancel their subscription or close their account.
# Intent (AI-20): your app opens this chat with JunDesk.open({ intent: "cancel", onExit }).
intent: cancel
opening: "Sorry to see you go. What's the main reason?"
replies: [Too expensive, Not using it enough, Missing a feature, Something isn't working, Switching to another tool, Other]
exit: Cancel anyway       # always on screen, one click: closes the chat and calls your onExit
---
1. If they haven't said why, ask for the main reason, once.
2. Try to fix the real problem first:
   - Something isn't working: explain what failed (the technical context helps) and flag it to the team.
   - Missing a feature: check the sources for it or a workaround.
   - Not using it enough: offer one short tip for what they signed up to do.
3. At most one offer, and only the one that fits their reason (edit these to what you really offer):
   - Too expensive: 50% off the next 3 months (offer: discount_50_3m).
   - Not using it enough: pause the subscription for up to 3 months (offer: pause_3m).
   - Missing a feature, switching to another tool, or other: no offer. Ask what would have made them stay.
4. Before applying an offer with apply_save_offer, say exactly what changes and wait for a clear yes.
   If that action isn't set up, hand off to a person with the accepted offer in the reason.
5. If they say no or still want to cancel, thank them and point them to the "Cancel anyway" button
   (or, if there isn't one in this chat, to Settings → Billing). Never argue or push again.
`,
  "actions/apply_save_offer.yaml.example": `# Rename to apply_save_offer.yaml to enable. It changes the customer's subscription, so the
# cancellation task only calls it after the customer says yes to that exact offer. It needs a
# signed-in customer ({user.id} comes from your identity token, never from the chat).
description: Apply a retention offer the customer accepted to their own subscription. Only after a clear yes.
status: Applying your offer                       # what the customer sees while it runs
method: POST
url: https://api.example.com/billing/save-offers
headers:
  Authorization: Bearer {secrets.ACME_BILLING_KEY}   # Worker secret JUN_SECRET_ACME_BILLING_KEY
input:
  offer:
    type: string
    description: The offer the customer accepted
    enum: [discount_50_3m, pause_3m]
body:
  userId: "{user.id}"
  offer: "{offer}"
pick: [ok, message]                               # only these fields reach the AI
mock: { ok: true, message: "Offer applied" }      # used by jun eval --mock-tools
`,
  "actions/lookup_order.yaml.example": `# Rename to lookup_order.yaml to enable. The AI calls it when a customer asks about an order.
description: Look up an order by its number. Returns status, order date and total.
status: Checking your order                      # what the customer sees while it runs (default "Looking that up")
method: GET
url: https://api.example.com/orders/{orderNumber}
headers:
  Authorization: Bearer {secrets.ACME_API_KEY}   # Worker secret JUN_SECRET_ACME_API_KEY
input:
  orderNumber:
    type: string
    description: The order number, like A-1042
pick: [status, orderedOn, total]                 # only these fields reach the AI
mock: { status: delivered, orderedOn: "2026-09-02", total: "$49.00" }   # used by jun eval --mock-tools
# pages: ["/orders/*", "/account"]               # optional: offer it only on these pages (AI-21)
# widget: order                                  # optional: show the result as widgets/order.widget (W-09)
`,
  "widgets/order.widget.example": `{
  "version": "1.0",
  "name": "Order",
  "template": "{\\"type\\":\\"Card\\",\\"size\\":\\"sm\\",\\"children\\":[{\\"type\\":\\"Row\\",\\"children\\":[{\\"type\\":\\"Title\\",\\"value\\":{{ (\\"Order \\" ~ number) | tojson }},\\"size\\":\\"sm\\"},{\\"type\\":\\"Spacer\\"},{\\"type\\":\\"Badge\\",\\"label\\":{{ (status) | tojson }},\\"color\\":{% if status == \\"delivered\\" %}\\"success\\"{% else %}\\"info\\"{% endif %}}]},{\\"type\\":\\"Divider\\",\\"flush\\":true},{\\"type\\":\\"Row\\",\\"children\\":[{\\"type\\":\\"Caption\\",\\"value\\":\\"Ordered\\"},{\\"type\\":\\"Spacer\\"},{\\"type\\":\\"Text\\",\\"value\\":{{ (orderedOn) | tojson }},\\"size\\":\\"sm\\"}]},{\\"type\\":\\"Row\\",\\"children\\":[{\\"type\\":\\"Caption\\",\\"value\\":\\"Total\\"},{\\"type\\":\\"Spacer\\"},{\\"type\\":\\"Text\\",\\"value\\":{{ (total) | tojson }},\\"size\\":\\"sm\\",\\"weight\\":\\"semibold\\"}]}]}",
  "summary": "Order {{ number }} · {{ status }}",
  "sample": {
    "number": "A-1042",
    "status": "delivered",
    "orderedOn": "2026-09-02",
    "total": "$49.00"
  }
}
`,
  "tests/basics.yaml": `- name: greeting
  message: hi there
  expect:
    outcome: answer

- name: refund goes to a person
  message: I want my money back for order A-1042
  expect:
    outcome: handoff

- name: asks for a human
  message: can I talk to a real person please
  expect:
    outcome: handoff
`,
  "tests/cancellation.yaml": `- name: cancel, too expensive gets the matching offer only
  intent: cancel
  message: Too expensive
  expect:
    outcome: answer
    criteria: Offers at most the 50% off for 3 months, invents no other discount, and doesn't apply anything without a yes.

- name: cancel, insists
  intent: cancel
  messages: [Switching to another tool, No thanks, I just want to cancel]
  expect:
    criteria: Accepts it without arguing and points to the "Cancel anyway" button.
`,
};
