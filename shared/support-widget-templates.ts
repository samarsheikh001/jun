// Support templates (D-103): our own starting points for the cards a support desk shows (account,
// plan, orders, invoices, refunds, usage, tickets, a change to confirm), listed before ChatKit
// Studio's gallery on the Widgets page and by the MCP's widget_templates. Each is a whole .widget
// file built here from a readable template: a sample, a JSON Schema, named states and a summary.
// Buttons that run something use `tool:<name>` with a placeholder action name (upgrade_plan,
// order_status, request_refund, apply_change): rename it to the desk's own action.
// shared/widget-templates.test.ts checks every one renders and fits its schema.

import type { JsonSchema } from "./widget-schema.ts";

export interface SupportTemplate {
  id: string;
  name: string;
  description: string;
  /** Words the MCP's widget_templates matches a request against, besides the name and description. */
  tags: string[];
  /** The whole .widget file. */
  file: string;
}

/** A value from the data, as a JSON value in the rendered tree. */
const v = (expr: string) => `{{ (${expr}) | tojson }}`;
/** A label / value line: a caption on the left, the value on the right. */
const line = (label: string, expr: string) =>
  `{"type":"Row","children":[{"type":"Caption","value":${JSON.stringify(label)}},{"type":"Spacer"},{"type":"Text","value":${v(expr)},"size":"sm"}]}`;
/** A status badge: `tones` maps a status to a badge colour (else secondary); the label is the status in words. */
const badge = (expr: string, tones: Record<string, string>) => {
  const branches = Object.entries(tones)
    .map(([status, tone], i) => `{% ${i ? "elif" : "if"} ${expr} == ${JSON.stringify(status)} %}${JSON.stringify(tone)}`)
    .join("");
  return `{"type":"Badge","label":${v(`${expr} | replace("_", " ") | capitalize`)},"color":${branches}{% else %}"secondary"{% endif %}}`;
};
/** Items of a list, comma-separated (Jinja's own loop.first keeps the JSON valid). */
const each = (list: string, item: string, body: string) => `{% for ${item} in ${list} %}{% if not loop.first %},{% endif %}${body}{% endfor %}`;

const str = (description?: string): JsonSchema => (description ? { type: "string", description } : { type: "string" });
const num = (description?: string): JsonSchema => (description ? { type: "number", description } : { type: "number" });
const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const list = (items: JsonSchema, description?: string): JsonSchema => ({ type: "array", items, ...(description ? { description } : {}) });

function widgetFile(f: {
  name: string;
  template: string[];
  summary: string;
  sample: Record<string, unknown>;
  jsonSchema: JsonSchema;
  states?: { name: string; data: Record<string, unknown> }[];
}): string {
  return `${JSON.stringify(
    {
      version: "1.0",
      name: f.name,
      template: f.template.join(""),
      summary: f.summary,
      sample: f.sample,
      jsonSchema: f.jsonSchema,
      ...(f.states?.length ? { states: f.states } : {}),
    },
    null,
    2,
  )}\n`;
}

const ACCOUNT_TONES = { active: "success", trialing: "info", past_due: "danger", canceled: "secondary" };

const account = {
  id: "account_overview",
  name: "Account overview",
  description: "The signed-in customer: name, email, plan and status, seats, a link to manage the account.",
  tags: ["account", "profile", "customer", "user", "subscription", "me", "billing"],
  file: widgetFile({
    name: "Account overview",
    template: [
      '{"type":"Card","size":"sm","children":[',
      '{"type":"Row","gap":3,"align":"center","children":[',
      `{"type":"Box","size":40,"radius":"full","background":"alpha-10","align":"center","justify":"center","children":[{"type":"Text","value":${v("name[:1] | upper")},"weight":"semibold"}]},`,
      `{"type":"Col","flex":"auto","children":[{"type":"Text","value":${v("name")},"weight":"semibold"},{"type":"Caption","value":${v("email")}}]},`,
      badge("status", ACCOUNT_TONES),
      "]},",
      '{"type":"Divider","flush":true},',
      '{"type":"Col","gap":2,"children":[',
      '{% if company %}', line("Company", "company"), ",{% endif %}",
      line("Plan", "plan"), ",",
      line("Seats", 'seatsUsed ~ " of " ~ seats ~ " used"'), ",",
      line("Customer since", "since"),
      "]}",
      `{% if manageUrl %},{"type":"Button","label":"Manage account","variant":"outline","block":true,"iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":${v("manageUrl")}}}}{% endif %}`,
      "]}",
    ],
    summary: "{{ name }} · {{ plan }} · {{ status | replace('_', ' ') }}",
    sample: {
      name: "Maya Chen",
      email: "maya@northwind.io",
      company: "Northwind",
      plan: "Team",
      status: "active",
      seats: 10,
      seatsUsed: 7,
      since: "March 2024",
      manageUrl: "https://example.com/settings/account",
    },
    jsonSchema: obj(
      {
        name: str("The customer's name."),
        email: str(),
        company: str("Optional."),
        plan: str("The plan's name."),
        status: { type: "string", enum: Object.keys(ACCOUNT_TONES) },
        seats: num(),
        seatsUsed: num(),
        since: str("When they became a customer, written out."),
        manageUrl: str("Optional: https link to the account page."),
      },
      ["name", "email", "plan", "status", "seats", "seatsUsed", "since"],
    ),
    states: [
      { name: "Past due", data: { name: "Maya Chen", email: "maya@northwind.io", plan: "Team", status: "past_due", seats: 10, seatsUsed: 7, since: "March 2024", manageUrl: "https://example.com/settings/billing" } },
      { name: "Trial", data: { name: "Sam Okafor", email: "sam@lumen.dev", company: "Lumen", plan: "Team trial", status: "trialing", seats: 5, seatsUsed: 2, since: "October 2026" } },
    ],
  }),
};

const plans = {
  id: "plan_picker",
  name: "Plans",
  description: "The customer's plan beside the others, each with its price and highlights; a button to switch runs an action.",
  tags: ["plan", "plans", "pricing", "upgrade", "downgrade", "subscription", "tier", "switch plan"],
  file: widgetFile({
    name: "Plans",
    template: [
      '{"type":"Card","size":"sm","children":[',
      '{"type":"Title","value":"Plans","size":"sm"},',
      '{"type":"Col","gap":2,"children":[',
      each(
        "plans",
        "p",
        [
          `{"type":"Box","key":${v("p.id")},"padding":3,"radius":"lg","gap":2,"border":{"size":1,"color":{% if p.id == current %}"primary"{% else %}"default"{% endif %}},"children":[`,
          '{"type":"Row","align":"center","gap":2,"children":[',
          `{"type":"Text","value":${v("p.name")},"weight":"semibold"},`,
          `{% if p.id == current %}{"type":"Badge","label":"Current","color":"primary"},{% elif p.badge %}{"type":"Badge","label":${v("p.badge")},"color":"discovery"},{% endif %}`,
          '{"type":"Spacer"},',
          `{"type":"Text","value":${v("p.price")},"weight":"semibold"},{"type":"Caption","value":${v("p.period | default('')")}}`,
          "]}",
          `{% if p.features %},{"type":"Caption","value":${v('p.features | join(" · ")')}}{% endif %}`,
          `{% if p.id != current %},{"type":"Button","label":${v('"Switch to " ~ p.name')},"size":"sm","block":true,{% if p.badge %}"style":"primary"{% else %}"variant":"outline"{% endif %},"onClickAction":{"type":"tool:upgrade_plan","payload":{"plan":${v("p.id")}}}}{% endif %}`,
          "]}",
        ].join(""),
      ),
      "]}",
      "]}",
    ],
    summary: "Plans · on {{ current | title }}",
    sample: {
      current: "starter",
      plans: [
        { id: "starter", name: "Starter", price: "$19", period: "/ month", features: ["3 seats", "1,000 chats"] },
        { id: "pro", name: "Pro", price: "$49", period: "/ month", features: ["10 seats", "10,000 chats", "API access"], badge: "Popular" },
        { id: "business", name: "Business", price: "$129", period: "/ month", features: ["Unlimited seats", "SSO", "Priority support"] },
      ],
    },
    jsonSchema: obj({
      current: str("The id of the customer's plan."),
      plans: list(
        obj(
          {
            id: str("Sent to the action as plan."),
            name: str(),
            price: str("Written out, like $49."),
            period: str("Optional, like / month."),
            features: list(str(), "Optional: two or three highlights."),
            badge: str("Optional: a word on the plan you'd recommend, like Popular."),
          },
          ["id", "name", "price"],
        ),
      ),
    }),
  }),
};

const ORDER_TONES = { processing: "secondary", shipped: "info", out_for_delivery: "info", delivered: "success", delayed: "warning", canceled: "danger" };
const ORDER_STAGES = ["Ordered", "Shipped", "Out today", "Delivered"];

const order = {
  id: "order_status",
  name: "Order status",
  description: "One order: where it is (ordered → delivered), its items and total, and a tracking link.",
  tags: ["order", "shipping", "delivery", "tracking", "package", "shipment", "where is my order"],
  file: widgetFile({
    name: "Order status",
    template: [
      '{% set stage = {"processing": 1, "shipped": 2, "out_for_delivery": 3, "delivered": 4, "delayed": 2}[status] | default(1) %}',
      '{"type":"Card","size":"sm","children":[',
      '{"type":"Row","align":"start","children":[',
      `{"type":"Col","gap":1,"children":[{"type":"Caption","value":${v('"Order " ~ number')}},{"type":"Title","size":"sm","value":${v('"Delivered " ~ deliveredOn if status == "delivered" else ("Cancelled" if status == "canceled" else "Arriving " ~ eta)')}}]},`,
      '{"type":"Spacer"},',
      badge("status", ORDER_TONES),
      "]}",
      '{% if status != "canceled" %},{"type":"Row","gap":1,"children":[',
      ORDER_STAGES.map(
        (label, i) =>
          `{"type":"Col","flex":1,"gap":1,"children":[{"type":"Box","height":4,"radius":"full","background":{% if stage >= ${i + 1} %}"primary"{% else %}"alpha-10"{% endif %}},{"type":"Caption","size":"sm","value":${JSON.stringify(label)},"color":{% if stage >= ${i + 1} %}"secondary"{% else %}"tertiary"{% endif %}}]}`,
      ).join(","),
      "]}{% endif %},",
      '{"type":"Divider","flush":true},',
      '{"type":"Col","gap":2,"children":[',
      each(
        "items",
        "item",
        `{"type":"Row","gap":2,"children":[{"type":"Text","value":${v("item.name")},"size":"sm","maxLines":1},{"type":"Caption","value":${v('"× " ~ item.quantity')}},{"type":"Spacer"},{"type":"Text","value":${v("item.price")},"size":"sm"}]}`,
      ),
      `,{"type":"Row","children":[{"type":"Text","value":"Total","size":"sm","weight":"semibold"},{"type":"Spacer"},{"type":"Text","value":${v("total")},"size":"sm","weight":"semibold"}]}`,
      "]}",
      `{% if trackingUrl and status != "canceled" %},{"type":"Button","label":"Track package","variant":"outline","block":true,"iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":${v("trackingUrl")}}}}{% endif %}`,
      "]}",
    ],
    summary: "Order {{ number }} · {{ status | replace('_', ' ') }}",
    sample: {
      number: "#10482",
      status: "shipped",
      eta: "Thu, Oct 22",
      items: [
        { name: "Desk lamp, walnut", quantity: 1, price: "$89.00" },
        { name: "USB-C cable, 2 m", quantity: 2, price: "$24.00" },
      ],
      total: "$113.00",
      trackingUrl: "https://example.com/track/10482",
    },
    jsonSchema: obj(
      {
        number: str("The order number customers know, like #10482."),
        status: { type: "string", enum: Object.keys(ORDER_TONES) },
        eta: str("Expected delivery, written out (until delivered)."),
        deliveredOn: str("When it was delivered, written out."),
        items: list(obj({ name: str(), quantity: num(), price: str("Written out, like $24.00.") })),
        total: str("Written out, like $113.00."),
        trackingUrl: str("Optional: the carrier's https tracking page."),
      },
      ["number", "status", "items", "total"],
    ),
    states: [
      { name: "Delivered", data: { number: "#10482", status: "delivered", deliveredOn: "Oct 21", items: [{ name: "Desk lamp, walnut", quantity: 1, price: "$89.00" }], total: "$89.00" } },
      { name: "Delayed", data: { number: "#10511", status: "delayed", eta: "Mon, Oct 26", items: [{ name: "Standing desk", quantity: 1, price: "$499.00" }], total: "$499.00", trackingUrl: "https://example.com/track/10511" } },
      { name: "Cancelled", data: { number: "#10377", status: "canceled", items: [{ name: "Monitor arm", quantity: 1, price: "$129.00" }], total: "$129.00" } },
    ],
  }),
};

const orders = {
  id: "order_list",
  name: "Recent orders",
  description: "The customer's recent orders as a list; picking one runs an action (like order_status) for it.",
  tags: ["orders", "order history", "purchases", "list", "recent"],
  file: widgetFile({
    name: "Recent orders",
    template: [
      '{"type":"ListView","limit":5,"children":[',
      '{% if orders | length == 0 %}{"type":"ListViewItem","children":[{"type":"Icon","name":"cube","color":"secondary"},{"type":"Text","value":"No orders yet","size":"sm","color":"secondary"}]}{% endif %}',
      each(
        "orders",
        "o",
        [
          `{"type":"ListViewItem","key":${v("o.id")},"gap":3,"onClickAction":{"type":"tool:order_status","payload":{"orderId":${v("o.id")}}},"children":[`,
          '{"type":"Box","size":36,"radius":"md","background":"alpha-5","align":"center","justify":"center","children":[{"type":"Icon","name":"cube","color":"secondary"}]},',
          `{"type":"Col","flex":"auto","children":[{"type":"Text","value":${v('"Order " ~ o.number')},"size":"sm","weight":"medium"},{"type":"Caption","value":${v('o.date ~ " · " ~ o.total')}}]},`,
          badge("o.status", ORDER_TONES),
          "]}",
        ].join(""),
      ),
      "]}",
    ],
    summary: "{{ orders | length }} recent orders",
    sample: {
      orders: [
        { id: "ord_10482", number: "#10482", date: "Oct 18", total: "$113.00", status: "shipped" },
        { id: "ord_10377", number: "#10377", date: "Oct 2", total: "$129.00", status: "delivered" },
        { id: "ord_10251", number: "#10251", date: "Sep 14", total: "$42.50", status: "delivered" },
      ],
    },
    jsonSchema: obj({
      orders: list(
        obj({
          id: str("Sent to the action as orderId."),
          number: str(),
          date: str("Written out, like Oct 18."),
          total: str(),
          status: { type: "string", enum: Object.keys(ORDER_TONES) },
        }),
      ),
    }),
    states: [{ name: "No orders", data: { orders: [] } }],
  }),
};

const INVOICE_TONES = { paid: "success", open: "warning", overdue: "danger", void: "secondary" };

const invoices = {
  id: "invoices",
  name: "Invoices",
  description: "Recent invoices with amount, date and status; open ones get a Pay button, the rest a link.",
  tags: ["invoice", "invoices", "billing", "receipt", "payment", "charges", "bill"],
  file: widgetFile({
    name: "Invoices",
    template: [
      `{% set due = invoices | selectattr("status", "in", ["open", "overdue"]) | list %}`,
      '{"type":"Card","size":"sm","children":[',
      `{"type":"Row","align":"center","children":[{"type":"Title","value":"Invoices","size":"sm"},{"type":"Spacer"},{"type":"Caption","value":{% if due %}${v('(due | length) ~ " to pay"')}{% else %}"All paid"{% endif %},"color":{% if due %}"warning"{% else %}"secondary"{% endif %}}]},`,
      '{"type":"Divider","flush":true},',
      '{"type":"Col","gap":3,"children":[',
      '{% if invoices | length == 0 %}{"type":"Caption","value":"No invoices yet."}{% endif %}',
      each(
        "invoices",
        "inv",
        [
          `{"type":"Row","key":${v("inv.number")},"gap":3,"align":"center","children":[`,
          `{"type":"Col","flex":"auto","gap":1,"children":[{"type":"Row","gap":2,"align":"center","children":[{"type":"Text","value":${v("inv.amount")},"size":"sm","weight":"semibold"},${badge("inv.status", INVOICE_TONES)}]},{"type":"Caption","value":${v('inv.date ~ " · " ~ inv.number')}}]}`,
          `{% if inv.status in ["open", "overdue"] and inv.payUrl %},{"type":"Button","label":"Pay now","size":"sm","style":"primary","onClickAction":{"type":"open_url","payload":{"url":${v("inv.payUrl")}}}}`,
          `{% elif inv.url %},{"type":"Button","label":"View","size":"sm","variant":"outline","onClickAction":{"type":"open_url","payload":{"url":${v("inv.url")}}}}{% endif %}`,
          "]}",
        ].join(""),
      ),
      "]}",
      "]}",
    ],
    summary: "{{ invoices | length }} invoices",
    sample: {
      invoices: [
        { number: "INV-2041", date: "Oct 1", amount: "$49.00", status: "open", payUrl: "https://example.com/pay/2041" },
        { number: "INV-1987", date: "Sep 1", amount: "$49.00", status: "paid", url: "https://example.com/invoices/1987" },
        { number: "INV-1932", date: "Aug 1", amount: "$19.00", status: "paid", url: "https://example.com/invoices/1932" },
      ],
    },
    jsonSchema: obj({
      invoices: list(
        obj(
          {
            number: str(),
            date: str("Written out, like Oct 1."),
            amount: str("Written out, like $49.00."),
            status: { type: "string", enum: Object.keys(INVOICE_TONES) },
            url: str("Optional: https link to the invoice."),
            payUrl: str("Optional: https link to pay an open invoice."),
          },
          ["number", "date", "amount", "status"],
        ),
      ),
    }),
    states: [
      { name: "Overdue", data: { invoices: [{ number: "INV-2041", date: "Oct 1", amount: "$49.00", status: "overdue", payUrl: "https://example.com/pay/2041" }, { number: "INV-1987", date: "Sep 1", amount: "$49.00", status: "paid", url: "https://example.com/invoices/1987" }] } },
      { name: "No invoices", data: { invoices: [] } },
    ],
  }),
};

const refund = {
  id: "refund_request",
  name: "Refund request",
  description: "A form for one order: the reason (a choice) and details, sent to an action like request_refund; Not now folds it.",
  tags: ["refund", "return", "money back", "cancel order", "form", "request", "complaint"],
  file: widgetFile({
    name: "Refund request",
    template: [
      `{"type":"Card","size":"sm","asForm":true,`,
      `"confirm":{"label":"Request refund","action":{"type":"tool:request_refund","payload":{"orderId":${v("orderId")}}}},`,
      '"cancel":{"label":"Not now","action":{"type":"dismiss"}},',
      '"children":[',
      `{"type":"Row","align":"start","children":[{"type":"Col","gap":1,"children":[{"type":"Caption","value":"Refund"},{"type":"Title","value":${v('"Order " ~ orderNumber')},"size":"sm"}]},{"type":"Spacer"},{"type":"Text","value":${v("amount")},"weight":"semibold"}]},`,
      '{"type":"Col","gap":2,"children":[',
      '{"type":"Label","value":"Why are you asking for a refund?","fieldName":"reason"},',
      `{"type":"Select","name":"reason","required":true,"placeholder":"Choose a reason","options":[${each("reasons", "r", `{"label":${v("r.label")},"value":${v("r.value")}}`)}]}`,
      "]},",
      '{"type":"Col","gap":2,"children":[',
      '{"type":"Label","value":"Anything else we should know?","fieldName":"details"},',
      '{"type":"Textarea","name":"details","placeholder":"Optional","rows":3}',
      "]}",
      `{% if note %},{"type":"Caption","value":${v("note")}}{% endif %}`,
      "]}",
    ],
    summary: "Refund · order {{ orderNumber }}",
    sample: {
      orderId: "ord_10482",
      orderNumber: "#10482",
      amount: "$113.00",
      reasons: [
        { value: "damaged", label: "It arrived damaged" },
        { value: "wrong_item", label: "I got the wrong item" },
        { value: "not_needed", label: "I don't need it any more" },
        { value: "other", label: "Something else" },
      ],
      note: "Refunds go back to the card you paid with.",
    },
    jsonSchema: obj(
      {
        orderId: str("Sent to the action as orderId."),
        orderNumber: str(),
        amount: str("What would be refunded, written out."),
        reasons: list(obj({ value: str("Sent to the action as reason."), label: str() })),
        note: str("Optional: one line about how refunds work, from your policy."),
      },
      ["orderId", "orderNumber", "amount", "reasons"],
    ),
  }),
};

const usage = {
  id: "usage_limits",
  name: "Usage",
  description: "Usage against the plan's limits as bars (amber from 80%, red when full), when it resets, and an upgrade button.",
  tags: ["usage", "limit", "limits", "quota", "credits", "meter", "seats", "storage", "api calls"],
  file: widgetFile({
    name: "Usage",
    template: [
      '{"type":"Card","size":"sm","children":[',
      `{"type":"Row","align":"end","children":[{"type":"Col","gap":1,"children":[{"type":"Caption","value":"Usage this period"},{"type":"Title","value":${v('plan ~ " plan"')},"size":"sm"}]},{"type":"Spacer"},{"type":"Caption","value":${v('"Resets " ~ resetsOn')}}]},`,
      '{"type":"Col","gap":3,"children":[',
      each(
        "metrics",
        "m",
        [
          "{% set pct = [((m.used / m.limit) * 100) | round | int, 100] | min if m.limit else 0 %}",
          `{"type":"Col","key":${v("m.label")},"gap":1,"children":[`,
          `{"type":"Row","children":[{"type":"Text","value":${v("m.label")},"size":"sm"},{"type":"Spacer"},{"type":"Caption","value":${v('m.display | default(m.used ~ " of " ~ m.limit)')},"color":{% if pct >= 100 %}"danger"{% else %}"secondary"{% endif %}}]},`,
          `{"type":"Box","height":6,"radius":"full","background":"alpha-10","children":[{"type":"Box","height":"100%","radius":"full","width":${v('pct ~ "%"')},"background":{% if pct >= 100 %}"danger"{% elif pct >= 80 %}"warning"{% else %}"primary"{% endif %}}]}`,
          "]}",
        ].join(""),
      ),
      "]}",
      `{% if canUpgrade %},{"type":"Button","label":"Upgrade for more","style":"primary","block":true,"onClickAction":{"type":"tool:upgrade_plan","payload":{}}}{% endif %}`,
      "]}",
    ],
    summary: "Usage · resets {{ resetsOn }}",
    sample: {
      plan: "Starter",
      resetsOn: "Nov 1",
      metrics: [
        { label: "Chats", used: 820, limit: 1000, display: "820 of 1,000" },
        { label: "Seats", used: 3, limit: 3 },
        { label: "Storage", used: 1.2, limit: 5, display: "1.2 of 5 GB" },
      ],
      canUpgrade: true,
    },
    jsonSchema: obj(
      {
        plan: str(),
        resetsOn: str("Written out, like Nov 1."),
        metrics: list(
          obj(
            {
              label: str(),
              used: num(),
              limit: num(),
              display: str("Optional: the numbers written out, like 820 of 1,000."),
            },
            ["label", "used", "limit"],
          ),
        ),
        canUpgrade: { type: "boolean", description: "Optional: show the upgrade button." },
      },
      ["plan", "resetsOn", "metrics"],
    ),
  }),
};

const TICKET_TONES = { open: "info", pending: "warning", waiting_on_you: "warning", solved: "success", closed: "secondary" };

const ticket = {
  id: "ticket_status",
  name: "Ticket status",
  description: "A support ticket or bug report: subject, status, who has it, the latest update and a link.",
  tags: ["ticket", "case", "issue", "bug", "request", "status", "support ticket", "follow up"],
  file: widgetFile({
    name: "Ticket status",
    template: [
      '{"type":"Card","size":"sm","children":[',
      `{"type":"Row","align":"center","children":[{"type":"Caption","value":${v('"Ticket " ~ number')}},{"type":"Spacer"},${badge("status", TICKET_TONES)}]},`,
      `{"type":"Title","value":${v("subject")},"size":"sm","maxLines":2},`,
      '{"type":"Col","gap":2,"children":[',
      '{% if assignee %}', line("With", "assignee"), ",{% endif %}",
      '{% if priority %}', line("Priority", "priority | capitalize"), ",{% endif %}",
      line("Updated", "updated"),
      "]}",
      `{% if latest %},{"type":"Box","padding":3,"radius":"lg","background":"alpha-5","gap":1,"children":[{"type":"Caption","value":"Latest update"},{"type":"Text","value":${v("latest")},"size":"sm"}]}{% endif %}`,
      `{% if url %},{"type":"Button","label":"View ticket","variant":"outline","block":true,"iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":${v("url")}}}}{% endif %}`,
      "]}",
    ],
    summary: "Ticket {{ number }} · {{ status | replace('_', ' ') }}",
    sample: {
      number: "#4821",
      subject: "CSV export times out for large workspaces",
      status: "open",
      priority: "high",
      assignee: "Priya, Support",
      updated: "2 hours ago",
      latest: "Our engineers found the cause and a fix is in review. We'll write here when it ships.",
      url: "https://example.com/tickets/4821",
    },
    jsonSchema: obj(
      {
        number: str(),
        subject: str(),
        status: { type: "string", enum: Object.keys(TICKET_TONES) },
        priority: str("Optional: low, normal, high or urgent."),
        assignee: str("Optional: who has it."),
        updated: str("Written out, like 2 hours ago."),
        latest: str("Optional: the latest public update."),
        url: str("Optional: https link to the ticket."),
      },
      ["number", "subject", "status", "updated"],
    ),
    states: [{ name: "Solved", data: { number: "#4790", subject: "Can't invite a teammate", status: "solved", updated: "Yesterday", latest: "Invites work again after yesterday's fix." } }],
  }),
};

const change = {
  id: "confirm_change",
  name: "Confirm a change",
  description: "Before an action changes something: what changes (from → to) and what it costs, with Confirm and Cancel.",
  tags: ["confirm", "confirmation", "change", "approve", "yes", "review", "update", "cancel subscription", "before"],
  file: widgetFile({
    name: "Confirm a change",
    template: [
      '{"type":"Card","size":"sm",',
      `"confirm":{"label":${v('confirmLabel | default("Confirm")')},"action":{"type":"tool:apply_change","payload":${v("payload | default({})")}}},`,
      '"cancel":{"label":"Cancel","action":{"type":"dismiss"}},',
      '"children":[',
      `{"type":"Col","gap":1,"children":[{"type":"Title","value":${v("title")},"size":"sm"}{% if description %},{"type":"Caption","value":${v("description")}}{% endif %}]},`,
      '{"type":"Col","gap":2,"children":[',
      each(
        "changes",
        "c",
        `{"type":"Row","gap":2,"align":"center","children":[{"type":"Caption","value":${v("c.label")}},{"type":"Spacer"}{% if c.from %},{"type":"Text","value":${v("c.from")},"size":"sm","color":"tertiary"},{"type":"Icon","name":"chevron-right","size":"sm","color":"tertiary"}{% endif %},{"type":"Text","value":${v("c.to")},"size":"sm","weight":"semibold"}]}`,
      ),
      "]}",
      `{% if note %},{"type":"Box","padding":3,"radius":"lg","background":"alpha-5","children":[{"type":"Text","value":${v("note")},"size":"sm"}]}{% endif %}`,
      "]}",
    ],
    summary: "{{ title }}",
    sample: {
      title: "Switch to Pro?",
      description: "Your team gets the new limits right away.",
      changes: [
        { label: "Plan", from: "Starter", to: "Pro" },
        { label: "Price", from: "$19 / month", to: "$49 / month" },
        { label: "Seats", from: "3", to: "10" },
      ],
      note: "You'll pay $30.00 today for the rest of this month.",
      confirmLabel: "Switch to Pro",
      payload: { plan: "pro" },
    },
    jsonSchema: obj(
      {
        title: str("A question, like Switch to Pro?"),
        description: str("Optional."),
        changes: list(obj({ label: str(), from: str("Optional: the value now."), to: str("The value after.") }, ["label", "to"])),
        note: str("Optional: the cost or anything the customer must know before saying yes."),
        confirmLabel: str("Optional: the button, like Switch to Pro (default Confirm)."),
        payload: { type: "object", description: "Optional: what the action gets when they confirm." },
      },
      ["title", "changes"],
    ),
  }),
};

export const SUPPORT_TEMPLATES: SupportTemplate[] = [account, plans, order, orders, invoices, refund, usage, ticket, change];
