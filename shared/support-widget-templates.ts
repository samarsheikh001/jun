// Support templates (D-103): our own starting points for the cards a support desk shows (account,
// plan, orders, invoices, refunds, usage, tickets, a change to confirm), listed before ChatKit
// Studio's gallery on the Widgets page and by the MCP's widget_templates. Each is a whole .widget
// file built here from a readable template: a sample, a JSON Schema, named states and a summary.
// The look follows Studio's gallery: one visual anchor per card (a hero line, a gradient band, a
// product picture or an icon on a coloured tile), labels in secondary text, grouped rows on soft
// surfaces, pill buttons, and colour that carries the status (soft tiles pick light / dark pairs).
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
/** Items of a list, comma-separated (Jinja's own loop.first keeps the JSON valid). */
const each = (list: string, item: string, body: string) => `{% for ${item} in ${list} %}{% if not loop.first %},{% endif %}${body}{% endfor %}`;
/** `{% set name = {status: hue, …}[expr] | default(fallback) %}`: a palette hue per status. */
const hueOf = (name: string, expr: string, hues: Record<string, string>, fallback = "gray") =>
  `{% set ${name} = ${JSON.stringify(hues)}[${expr}] | default(${JSON.stringify(fallback)}) %}`;
/** A soft surface in a hue (Jinja expression `hue`): pale on light, deep on dark. */
const soft = (hue: string) => `{"light":${v(`${hue} ~ "-100"`)},"dark":${v(`${hue} ~ "-900"`)}}`;
/** Text or an icon in a hue, readable on its soft surface and on the card. */
const ink = (hue: string) => `{"light":${v(`${hue} ~ "-600"`)},"dark":${v(`${hue} ~ "-300"`)}}`;
/** An icon (a JSON value or Jinja output) on a rounded tile in a hue. */
const tile = (icon: string, hue: string, size = 40, radius = "lg") =>
  `{"type":"Box","size":${size},"radius":${JSON.stringify(radius)},"background":${soft(hue)},"align":"center","justify":"center","children":[{"type":"Icon","name":${icon},"size":"lg","color":${ink(hue)}}]}`;
/** A label / value line in the gallery's way: secondary text on the left, the value on the right. */
const line = (label: string, expr: string, strong = false) =>
  `{"type":"Row","children":[{"type":"Text","value":${JSON.stringify(label)},"size":"sm","color":"secondary"},{"type":"Spacer"},{"type":"Text","value":${v(expr)},"size":"sm"${strong ? ',"weight":"semibold"' : ""}}]}`;
/** A progress bar: `pct` is a Jinja number expression (0–100), `fill` a colour (JSON or Jinja output). */
const bar = (pct: string, fill: string, height = 6) =>
  `{"type":"Box","height":${height},"radius":"full","background":"alpha-10","children":[{"type":"Box","height":"100%","radius":"full","width":${v(`${pct} ~ "%"`)},"background":${fill}}]}`;
/** A status said in words: "past_due" → "Past due". */
const words = (expr: string) => `${expr} | replace("_", " ") | capitalize`;

const str = (description?: string): JsonSchema => (description ? { type: "string", description } : { type: "string" });
const num = (description?: string): JsonSchema => (description ? { type: "number", description } : { type: "number" });
const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const list = (items: JsonSchema, description?: string): JsonSchema => ({ type: "array", items, ...(description ? { description } : {}) });
const oneOf = (values: string[], description?: string): JsonSchema => ({ type: "string", enum: values, ...(description ? { description } : {}) });

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

// ---------- account ----------

const ACCOUNT_HUES = { active: "green", trialing: "blue", past_due: "red", canceled: "gray" };

const account = {
  id: "account_overview",
  name: "Account overview",
  description: "The signed-in customer: their initial on a gradient, plan and status, seats used as a bar, a link to manage the account.",
  tags: ["account", "profile", "customer", "user", "subscription", "me", "billing", "seats"],
  file: widgetFile({
    name: "Account overview",
    template: [
      hueOf("tone", "status", ACCOUNT_HUES),
      "{% set pct = [((seatsUsed / seats) * 100) | round | int, 100] | min if seats else 0 %}",
      '{"type":"Card","size":"sm","children":[',
      // Who: initial on a gradient, name, email, status.
      '{"type":"Row","gap":3,"align":"center","children":[',
      `{"type":"Box","size":48,"radius":"full","background":"linear-gradient(135deg, #6366F1 0%, #A855F7 100%)","align":"center","justify":"center","children":[{"type":"Text","value":${v("name[:1] | upper")},"size":"lg","weight":"semibold","color":"white"}]},`,
      `{"type":"Col","flex":"auto","children":[{"type":"Title","value":${v("name")},"size":"sm","maxLines":1},{"type":"Text","value":${v('email ~ (" · " ~ company if company else "")')},"size":"sm","color":"secondary","maxLines":1}]},`,
      `{"type":"Badge","label":${v(words("status"))},"color":${v('{"active": "success", "trialing": "info", "past_due": "danger"}[status] | default("secondary")')},"pill":true}`,
      "]},",
      // The plan, on a soft surface, with seats as a bar.
      '{"type":"Box","padding":3,"radius":"xl","background":"surface-secondary","gap":3,"children":[',
      '{"type":"Row","gap":3,"align":"center","children":[',
      tile('"sparkle"', '"indigo"', 36, "md"), ",",
      `{"type":"Col","flex":"auto","children":[{"type":"Text","value":${v('plan ~ " plan"')},"weight":"semibold"},{"type":"Text","value":${v('"Customer since " ~ since')},"size":"sm","color":"secondary"}]},`,
      `{"type":"Col","align":"end","children":[{"type":"Text","value":${v('seatsUsed ~ " / " ~ seats')},"weight":"semibold"},{"type":"Text","value":"seats","size":"sm","color":"secondary"}]}`,
      "]},",
      bar("pct", '{% if pct >= 100 %}"red-500"{% else %}"indigo-500"{% endif %}'),
      "]}",
      `{% if status == "past_due" %},{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"info","color":${ink("tone")}},{"type":"Text","value":${v('notice | default("The last payment didn\'t go through.")')},"size":"sm","color":${ink("tone")}}]}{% elif notice %},{"type":"Text","value":${v("notice")},"size":"sm","color":"secondary"}{% endif %}`,
      `{% if manageUrl %},{"type":"Button","label":{% if status == "past_due" %}"Update payment"{% else %}"Manage account"{% endif %},{% if status == "past_due" %}"style":"primary",{% else %}"variant":"outline",{% endif %}"pill":true,"block":true,"iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":${v("manageUrl")}}}}{% endif %}`,
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
        plan: str("The plan's name, like Team."),
        status: oneOf(Object.keys(ACCOUNT_HUES)),
        seats: num(),
        seatsUsed: num(),
        since: str("When they became a customer, written out."),
        notice: str("Optional: one line to show under the plan (past due has its own)."),
        manageUrl: str("Optional: https link to the account or billing page."),
      },
      ["name", "email", "plan", "status", "seats", "seatsUsed", "since"],
    ),
    states: [
      { name: "Past due", data: { name: "Maya Chen", email: "maya@northwind.io", company: "Northwind", plan: "Team", status: "past_due", seats: 10, seatsUsed: 10, since: "March 2024", manageUrl: "https://example.com/settings/billing" } },
      { name: "Trial", data: { name: "Sam Okafor", email: "sam@lumen.dev", plan: "Team trial", status: "trialing", seats: 5, seatsUsed: 2, since: "October 2026", notice: "Your trial ends on Oct 30." } },
    ],
  }),
};

// ---------- plans ----------

const plans = {
  id: "plan_picker",
  name: "Plans",
  description: "The customer's plan beside the others: an icon tile, price and highlights per plan, the current one outlined, a Switch button that runs an action.",
  tags: ["plan", "plans", "pricing", "upgrade", "downgrade", "subscription", "tier", "switch plan"],
  file: widgetFile({
    name: "Plans",
    template: [
      '{"type":"Card","size":"sm","children":[',
      `{"type":"Col","gap":1,"children":[{"type":"Title","value":${v('title | default("Choose your plan")')},"size":"md"},{"type":"Text","value":${v('"You\'re on " ~ ((plans | selectattr("id", "eq", current) | first).name | default(current | title)) ~ "."')},"size":"sm","color":"secondary"}]},`,
      '{"type":"Col","gap":2,"children":[',
      each(
        "plans",
        "p",
        [
          `{% set hue = p.color | default(["gray", "indigo", "violet", "amber"][loop.index0 % 4]) %}`,
          `{"type":"Col","key":${v("p.id")},"gap":3,"padding":3,"radius":"xl",`,
          `{% if p.id == current %}"border":{"size":2,"color":${ink("hue")}}{% else %}"background":"surface-secondary"{% endif %},"children":[`,
          '{"type":"Row","gap":3,"align":"center","children":[',
          tile(v('p.icon | default(["star", "sparkle", "bolt", "wreath"][loop.index0 % 4])'), "hue"), ",",
          `{"type":"Col","flex":"auto","children":[{"type":"Row","gap":2,"align":"center","children":[{"type":"Text","value":${v("p.name")},"weight":"semibold"}{% if p.badge and p.id != current %},{"type":"Badge","label":${v("p.badge")},"color":"discovery","pill":true}{% endif %}]},{"type":"Text","value":${v('p.price ~ (" " ~ p.period if p.period else "")')},"size":"sm","color":"secondary"}]}`,
          "]}",
          `{% if p.features %},{"type":"Text","value":${v('p.features | join(" · ")')},"size":"sm","maxLines":2}{% endif %}`,
          `{% if p.id == current %},{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"check-circle-filled","color":${ink("hue")}},{"type":"Text","value":"Your plan","size":"sm","weight":"semibold","color":${ink("hue")}}]}`,
          `{% else %},{"type":"Button","label":${v('"Switch to " ~ p.name')},"size":"sm","pill":true,"block":true,{% if p.badge %}"style":"primary","iconStart":"sparkle"{% else %}"variant":"outline"{% endif %},"onClickAction":{"type":"tool:upgrade_plan","payload":{"plan":${v("p.id")}}}}{% endif %}`,
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
        { id: "pro", name: "Pro", price: "$49", period: "/ month", features: ["10 seats", "10,000 chats", "API"], badge: "Popular" },
        { id: "business", name: "Business", price: "$129", period: "/ month", features: ["Unlimited seats", "SSO", "Priority support"] },
      ],
    },
    jsonSchema: obj(
      {
        current: str("The id of the customer's plan."),
        title: str("Optional heading (default Choose your plan)."),
        plans: list(
          obj(
            {
              id: str("Sent to the action as plan."),
              name: str(),
              price: str("Written out, like $49."),
              period: str("Optional, like / month."),
              features: list(str(), "Optional: two or three highlights."),
              badge: str("Optional: a word on the plan you'd recommend, like Popular. Its button is the main one."),
              color: str("Optional: a palette hue for its tile, like indigo."),
              icon: str("Optional: a ChatKit icon name for its tile."),
            },
            ["id", "name", "price"],
          ),
        ),
      },
      ["current", "plans"],
    ),
  }),
};

// ---------- orders ----------

const ORDER_HUES = { processing: "gray", shipped: "blue", out_for_delivery: "blue", delivered: "green", delayed: "amber", canceled: "red" };
const ORDER_ICONS = { processing: "cube", shipped: "suitcase", out_for_delivery: "map-pin", delivered: "check-circle-filled", delayed: "info", canceled: "empty-circle" };
const ORDER_BANDS = {
  processing: "linear-gradient(135deg, #64748B 0%, #475569 100%)",
  shipped: "linear-gradient(135deg, #378CD1 0%, #2B67AC 100%)",
  out_for_delivery: "linear-gradient(135deg, #378CD1 0%, #2B67AC 100%)",
  delivered: "linear-gradient(135deg, #22A06B 0%, #157F52 100%)",
  delayed: "linear-gradient(135deg, #E8952E 0%, #C46A12 100%)",
  canceled: "linear-gradient(135deg, #8A8F98 0%, #6B7079 100%)",
};
const ORDER_STAGES = ["Ordered", "Shipped", "Out today", "Delivered"];
/** An item's picture, else a cube on a tile. */
const itemPicture = (item: string, size: number) =>
  `{% if ${item}.image %}{"type":"Image","src":${v(`${item}.image`)},"alt":${v(`${item}.name | default("")`)},"size":${size},"radius":"lg","frame":true}{% else %}${tile('"cube"', '"gray"', size)}{% endif %}`;

const order = {
  id: "order_status",
  name: "Order status",
  description: "One order: a coloured band with when it arrives and its progress, the items with their pictures, the total and a tracking link.",
  tags: ["order", "shipping", "delivery", "tracking", "package", "shipment", "where is my order"],
  file: widgetFile({
    name: "Order status",
    template: [
      `{% set stage = {"processing": 1, "shipped": 2, "out_for_delivery": 3, "delivered": 4, "delayed": 2}[status] | default(1) %}`,
      '{"type":"Card","size":"sm","children":[',
      // The band: status, headline and progress, white on the status colour.
      `{"type":"Box","padding":4,"radius":"xl","gap":3,"background":${v(`${JSON.stringify(ORDER_BANDS)}[status] | default("${ORDER_BANDS.processing}")`)},"children":[`,
      `{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":${v(`${JSON.stringify(ORDER_ICONS)}[status] | default("cube")`)},"color":"white"},{"type":"Text","value":${v(words("status"))},"size":"sm","weight":"semibold","color":"white"},{"type":"Spacer"},{"type":"Text","value":${v('"Order " ~ number')},"size":"sm","color":"white"}]},`,
      `{"type":"Title","size":"lg","color":"white","value":${v('"Delivered " ~ deliveredOn if status == "delivered" else ("Cancelled" if status == "canceled" else "Arriving " ~ eta)')}}`,
      '{% if status != "canceled" %},{"type":"Row","gap":1,"children":[',
      ORDER_STAGES.map(
        (label, i) =>
          `{"type":"Col","flex":1,"gap":1,"children":[{"type":"Box","height":4,"radius":"full","background":{% if stage >= ${i + 1} %}"white"{% else %}"rgba(255,255,255,0.3)"{% endif %}},{"type":"Text","size":"xs","value":${JSON.stringify(label)},"color":{% if stage >= ${i + 1} %}"white"{% else %}"rgba(255,255,255,0.7)"{% endif %}}]}`,
      ).join(","),
      "]}{% endif %}",
      "]},",
      // Items with their pictures, then the total.
      '{"type":"Col","gap":3,"children":[',
      each(
        "items",
        "item",
        `{"type":"Row","gap":3,"align":"center","children":[${itemPicture("item", 48)},{"type":"Col","flex":"auto","children":[{"type":"Text","value":${v("item.name")},"size":"sm","weight":"semibold","maxLines":1},{"type":"Text","value":${v('"Qty " ~ item.quantity')},"size":"sm","color":"secondary"}]},{"type":"Text","value":${v("item.price")},"size":"sm"}]}`,
      ),
      "]},",
      '{"type":"Divider","flush":true,"color":"subtle"},',
      line("Total", "total", true),
      `{% if trackingUrl and status != "canceled" and status != "delivered" %},{"type":"Button","label":"Track package","variant":"outline","pill":true,"block":true,"iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":${v("trackingUrl")}}}}{% endif %}`,
      "]}",
    ],
    summary: "Order {{ number }} · {{ status | replace('_', ' ') }}",
    sample: {
      number: "#10482",
      status: "shipped",
      eta: "Thu, Oct 22",
      items: [
        { name: "Blue folding chair", quantity: 2, price: "$40.00", image: "https://widgets.chatkit.studio/blue-chair.png" },
        { name: "Seat cushion, oat", quantity: 2, price: "$24.00" },
      ],
      total: "$64.00",
      trackingUrl: "https://example.com/track/10482",
    },
    jsonSchema: obj(
      {
        number: str("The order number customers know, like #10482."),
        status: oneOf(Object.keys(ORDER_HUES)),
        eta: str("Expected delivery, written out (until delivered)."),
        deliveredOn: str("When it was delivered, written out."),
        items: list(obj({ name: str(), quantity: num(), price: str("Written out, like $24.00."), image: str("Optional: https picture of the product.") }, ["name", "quantity", "price"])),
        total: str("Written out, like $64.00."),
        trackingUrl: str("Optional: the carrier's https tracking page."),
      },
      ["number", "status", "items", "total"],
    ),
    states: [
      { name: "Delivered", data: { number: "#10482", status: "delivered", deliveredOn: "Oct 21", items: [{ name: "Blue folding chair", quantity: 2, price: "$40.00", image: "https://widgets.chatkit.studio/blue-chair.png" }], total: "$40.00" } },
      { name: "Delayed", data: { number: "#10511", status: "delayed", eta: "Mon, Oct 26", items: [{ name: "Standing desk", quantity: 1, price: "$499.00" }], total: "$499.00", trackingUrl: "https://example.com/track/10511" } },
      { name: "Cancelled", data: { number: "#10377", status: "canceled", items: [{ name: "Monitor arm", quantity: 1, price: "$129.00" }], total: "$129.00" } },
    ],
  }),
};

const orders = {
  id: "order_list",
  name: "Recent orders",
  description: "The customer's recent orders as a list with pictures, totals and a coloured status; picking one runs an action (like order_status) for it.",
  tags: ["orders", "order history", "purchases", "list", "recent"],
  file: widgetFile({
    name: "Recent orders",
    template: [
      '{"type":"ListView","limit":5,"children":[',
      `{% if orders | length == 0 %}{"type":"ListViewItem","gap":3,"children":[${tile('"cube"', '"gray"')},{"type":"Col","children":[{"type":"Text","value":"No orders yet","weight":"semibold","size":"sm"},{"type":"Text","value":"Orders you place show up here.","size":"sm","color":"secondary"}]}]}{% endif %}`,
      each(
        "orders",
        "o",
        [
          hueOf("hue", "o.status", ORDER_HUES),
          `{"type":"ListViewItem","key":${v("o.id")},"gap":3,"onClickAction":{"type":"tool:order_status","payload":{"orderId":${v("o.id")}}},"children":[`,
          itemPicture("o", 44), ",",
          `{"type":"Col","flex":"auto","children":[{"type":"Text","value":${v('o.title | default("Order " ~ o.number)')},"size":"sm","weight":"semibold","maxLines":1},{"type":"Text","value":${v('o.date ~ (" · " ~ o.number if o.title else "")')},"size":"sm","color":"secondary","maxLines":1}]},`,
          `{"type":"Col","align":"end","children":[{"type":"Text","value":${v("o.total")},"size":"sm","weight":"semibold"},{"type":"Text","value":${v(words("o.status"))},"size":"sm","color":${ink("hue")}}]}`,
          "]}",
        ].join(""),
      ),
      "]}",
    ],
    summary: "{{ orders | length }} recent orders",
    sample: {
      orders: [
        { id: "ord_10482", number: "#10482", title: "Blue folding chair ×2", date: "Oct 18", total: "$64.00", status: "shipped", image: "https://widgets.chatkit.studio/blue-chair.png" },
        { id: "ord_10377", number: "#10377", title: "Matcha latte kit", date: "Oct 2", total: "$29.00", status: "delivered", image: "https://cdn.openai.com/API/storybook/matcha.png" },
        { id: "ord_10251", number: "#10251", date: "Sep 14", total: "$42.50", status: "canceled" },
      ],
    },
    jsonSchema: obj({
      orders: list(
        obj(
          {
            id: str("Sent to the action as orderId."),
            number: str(),
            title: str("Optional: what was ordered, in a few words."),
            date: str("Written out, like Oct 18."),
            total: str(),
            status: oneOf(Object.keys(ORDER_HUES)),
            image: str("Optional: https picture of the (first) product."),
          },
          ["id", "number", "date", "total", "status"],
        ),
      ),
    }),
    states: [{ name: "No orders", data: { orders: [] } }],
  }),
};

// ---------- invoices ----------

const INVOICE_HUES = { paid: "green", open: "amber", overdue: "red", void: "gray" };

const invoices = {
  id: "invoices",
  name: "Invoices",
  description: "What's due as a big number with Pay now (or All paid up), then recent invoices on soft rows with a status colour and a link each.",
  tags: ["invoice", "invoices", "billing", "receipt", "payment", "charges", "bill", "amount due"],
  file: widgetFile({
    name: "Invoices",
    template: [
      `{% set due = invoices | selectattr("status", "in", ["open", "overdue"]) | list %}`,
      `{% set late = due | selectattr("status", "eq", "overdue") | list %}`,
      '{"type":"Card","size":"sm","children":[',
      // The hero: what's due, or all paid.
      '{"type":"Row","align":"center","gap":3,"children":[',
      '{"type":"Col","flex":"auto","gap":1,"children":[',
      `{"type":"Text","value":{% if due %}"Amount due"{% else %}"Billing"{% endif %},"size":"sm","color":"secondary"},`,
      `{% if due %}{"type":"Title","value":${v("amountDue | default((due | first).amount)")},"size":"2xl"},{"type":"Text","value":${v('(due | length) ~ (" invoice" if due | length == 1 else " invoices") ~ (" · overdue" if late else (" · due " ~ dueOn if dueOn else ""))')},"size":"sm","color":{% if late %}"danger"{% else %}"secondary"{% endif %}}`,
      `{% else %}{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"check-circle-filled","color":"success","size":"lg"},{"type":"Title","value":"All paid up","size":"md"}]}{% endif %}`,
      "]}",
      `{% if due and payUrl %},{"type":"Button","label":"Pay now","style":"primary","pill":true,"onClickAction":{"type":"open_url","payload":{"url":${v("payUrl")}}}}{% endif %}`,
      "]},",
      // The invoices, each on a soft row.
      '{"type":"Col","gap":2,"children":[',
      `{% if invoices | length == 0 %}{"type":"Text","value":"No invoices yet.","size":"sm","color":"secondary"}{% endif %}`,
      each(
        "invoices",
        "inv",
        [
          hueOf("hue", "inv.status", INVOICE_HUES),
          `{"type":"Row","key":${v("inv.number")},"gap":3,"align":"center","padding":{"x":3,"y":2},"radius":"xl","background":"surface-secondary","children":[`,
          tile('"document"', "hue", 36, "md"), ",",
          `{"type":"Col","flex":"auto","children":[{"type":"Text","value":${v("inv.amount")},"size":"sm","weight":"semibold"},{"type":"Text","value":${v('inv.date ~ " · " ~ inv.number')},"size":"sm","color":"secondary","maxLines":1}]},`,
          `{"type":"Text","value":${v(words("inv.status"))},"size":"sm","weight":"medium","color":${ink("hue")}}`,
          `{% if inv.url %},{"type":"Button","iconStart":"external-link","variant":"ghost","size":"sm","pill":true,"onClickAction":{"type":"open_url","payload":{"url":${v("inv.url")}}}}{% endif %}`,
          "]}",
        ].join(""),
      ),
      "]}",
      "]}",
    ],
    summary: "{% if invoices | selectattr('status', 'in', ['open', 'overdue']) | list %}Invoices · {{ amountDue | default('payment') }} due{% else %}Invoices · all paid{% endif %}",
    sample: {
      amountDue: "$49.00",
      dueOn: "Oct 15",
      payUrl: "https://example.com/pay/2041",
      invoices: [
        { number: "INV-2041", date: "Oct 1", amount: "$49.00", status: "open", url: "https://example.com/invoices/2041" },
        { number: "INV-1987", date: "Sep 1", amount: "$49.00", status: "paid", url: "https://example.com/invoices/1987" },
        { number: "INV-1932", date: "Aug 1", amount: "$19.00", status: "paid", url: "https://example.com/invoices/1932" },
      ],
    },
    jsonSchema: obj(
      {
        amountDue: str("Optional: the total due, written out (else the first open invoice's amount)."),
        dueOn: str("Optional: when it's due, written out."),
        payUrl: str("Optional: https link to pay what's due."),
        invoices: list(
          obj(
            {
              number: str(),
              date: str("Written out, like Oct 1."),
              amount: str("Written out, like $49.00."),
              status: oneOf(Object.keys(INVOICE_HUES)),
              url: str("Optional: https link to the invoice."),
            },
            ["number", "date", "amount", "status"],
          ),
        ),
      },
      ["invoices"],
    ),
    states: [
      { name: "All paid", data: { invoices: [{ number: "INV-2041", date: "Oct 1", amount: "$49.00", status: "paid", url: "https://example.com/invoices/2041" }, { number: "INV-1987", date: "Sep 1", amount: "$49.00", status: "paid", url: "https://example.com/invoices/1987" }] } },
      { name: "Overdue", data: { amountDue: "$98.00", payUrl: "https://example.com/pay", invoices: [{ number: "INV-2041", date: "Oct 1", amount: "$49.00", status: "overdue" }, { number: "INV-1987", date: "Sep 1", amount: "$49.00", status: "overdue" }] } },
      { name: "No invoices", data: { invoices: [] } },
    ],
  }),
};

// ---------- refund ----------

const refund = {
  id: "refund_request",
  name: "Refund request",
  description: "A refund form for one order: the order with its picture and amount, a reason to choose and details, sent to an action like request_refund; Not now folds it.",
  tags: ["refund", "return", "money back", "cancel order", "form", "request", "complaint"],
  file: widgetFile({
    name: "Refund request",
    template: [
      `{"type":"Card","size":"sm","asForm":true,`,
      `"confirm":{"label":"Request refund","action":{"type":"tool:request_refund","payload":{"orderId":${v("orderId")}}}},`,
      '"cancel":{"label":"Not now","action":{"type":"dismiss"}},',
      '"children":[',
      `{"type":"Row","gap":2,"align":"center","children":[{"type":"Icon","name":"reload","color":"discovery"},{"type":"Text","value":"Refund request","size":"sm","weight":"semibold","color":"discovery"}]},`,
      // The order, as on a receipt.
      '{"type":"Row","gap":3,"align":"center","children":[',
      itemPicture("order", 64), ",",
      `{"type":"Col","flex":"auto","gap":1,"children":[{"type":"Title","value":${v('order.name | default("Order " ~ orderNumber)')},"size":"sm","maxLines":2},{"type":"Text","value":${v('"Order " ~ orderNumber ~ (" · " ~ order.date if order.date else "")')},"size":"sm","color":"secondary"}]},`,
      `{"type":"Title","value":${v("amount")},"size":"md"}`,
      "]},",
      '{"type":"Divider","flush":true,"color":"subtle"},',
      '{"type":"Col","gap":2,"children":[',
      '{"type":"Label","value":"What went wrong?","fieldName":"reason"},',
      `{"type":"Select","name":"reason","required":true,"placeholder":"Choose a reason","options":[${each("reasons", "r", `{"label":${v("r.label")},"value":${v("r.value")}}`)}]}`,
      "]},",
      '{"type":"Col","gap":2,"children":[',
      '{"type":"Label","value":"Anything else we should know?","fieldName":"details"},',
      '{"type":"Textarea","name":"details","placeholder":"Optional","rows":2}',
      "]}",
      `{% if note %},{"type":"Row","gap":2,"align":"start","padding":3,"radius":"xl","background":"surface-secondary","children":[{"type":"Icon","name":"info","color":"secondary"},{"type":"Text","value":${v("note")},"size":"sm","color":"secondary"}]}{% endif %}`,
      "]}",
    ],
    summary: "Refund · order {{ orderNumber }}",
    sample: {
      orderId: "ord_10482",
      orderNumber: "#10482",
      amount: "$64.00",
      order: { name: "Blue folding chair ×2", date: "Oct 18", image: "https://widgets.chatkit.studio/blue-chair.png" },
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
        order: obj({ name: str("What was ordered, in a few words."), date: str("Optional."), image: str("Optional: https picture of the product.") }, ["name"]),
        reasons: list(obj({ value: str("Sent to the action as reason."), label: str() })),
        note: str("Optional: one line about how refunds work, from your policy."),
      },
      ["orderId", "orderNumber", "amount", "reasons"],
    ),
  }),
};

// ---------- usage ----------

const usage = {
  id: "usage_limits",
  name: "Usage",
  description: "Usage against the plan's limits: an icon tile and a bar per meter (amber from 80%, red when full), when it resets, and an upgrade row.",
  tags: ["usage", "limit", "limits", "quota", "credits", "meter", "seats", "storage", "api calls"],
  file: widgetFile({
    name: "Usage",
    template: [
      '{"type":"Card","size":"sm","children":[',
      `{"type":"Row","align":"end","children":[{"type":"Col","gap":1,"children":[{"type":"Text","value":${v('plan ~ " plan"')},"size":"sm","weight":"semibold","color":"discovery"},{"type":"Title","value":${v('title | default("Usage this month")')},"size":"md"}]},{"type":"Spacer"},{"type":"Text","value":${v('"Resets " ~ resetsOn')},"size":"sm","color":"secondary"}]},`,
      '{"type":"Col","gap":4,"children":[',
      each(
        "metrics",
        "m",
        [
          "{% set pct = [((m.used / m.limit) * 100) | round | int, 100] | min if m.limit else 0 %}",
          '{% set hue = "red" if pct >= 100 else ("amber" if pct >= 80 else ["indigo", "sky", "violet", "teal"][loop.index0 % 4]) %}',
          `{"type":"Row","key":${v("m.label")},"gap":3,"align":"center","children":[`,
          tile(v('m.icon | default(["chart", "profile", "document", "bolt"][loop.index0 % 4])'), "hue", 36, "md"), ",",
          '{"type":"Col","flex":"auto","gap":2,"children":[',
          `{"type":"Row","children":[{"type":"Text","value":${v("m.label")},"size":"sm","weight":"semibold"},{"type":"Spacer"},{"type":"Text","value":${v('m.display | default(m.used ~ " of " ~ m.limit)')},"size":"sm","color":{% if pct >= 100 %}"danger"{% else %}"secondary"{% endif %}}]},`,
          bar("pct", v('hue ~ "-500"')),
          "]}",
          "]}",
        ].join(""),
      ),
      "]}",
      `{% if canUpgrade %},{"type":"Col","gap":3,"padding":3,"radius":"xl","background":"surface-secondary","children":[{"type":"Row","gap":3,"align":"center","children":[${tile('"bolt"', '"violet"', 36, "md")},{"type":"Col","flex":"auto","children":[{"type":"Text","value":"Need more room?","size":"sm","weight":"semibold"},{"type":"Text","value":${v('upgradeLine | default("Upgrade any time; the new limits apply at once.")')},"size":"sm","color":"secondary"}]}]},{"type":"Button","label":"Upgrade plan","size":"sm","style":"primary","pill":true,"block":true,"onClickAction":{"type":"tool:upgrade_plan","payload":{}}}]}{% endif %}`,
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
      upgradeLine: "You're out of seats on Starter.",
    },
    jsonSchema: obj(
      {
        plan: str(),
        title: str("Optional heading (default Usage this month)."),
        resetsOn: str("Written out, like Nov 1."),
        metrics: list(
          obj(
            {
              label: str(),
              used: num(),
              limit: num(),
              display: str("Optional: the numbers written out, like 820 of 1,000."),
              icon: str("Optional: a ChatKit icon name for its tile."),
            },
            ["label", "used", "limit"],
          ),
        ),
        canUpgrade: { type: "boolean", description: "Optional: show the upgrade row." },
        upgradeLine: str("Optional: the upgrade row's line."),
      },
      ["plan", "resetsOn", "metrics"],
    ),
  }),
};

// ---------- ticket ----------

const TICKET_HUES = { open: "blue", pending: "amber", waiting_on_you: "amber", solved: "green", closed: "gray" };

const ticket = {
  id: "ticket_status",
  name: "Ticket status",
  description: "A support ticket or bug report: subject and status beside a tinted tile, and the latest update as a message from whoever has it.",
  tags: ["ticket", "case", "issue", "bug", "request", "status", "support ticket", "follow up"],
  file: widgetFile({
    name: "Ticket status",
    template: [
      hueOf("tone", "status", TICKET_HUES),
      '{"type":"Card","size":"sm","children":[',
      '{"type":"Row","gap":3,"align":"start","children":[',
      tile(`{% if status in ["solved", "closed"] %}"check-circle-filled"{% else %}"lifesaver"{% endif %}`, "tone", 40, "full"), ",",
      '{"type":"Col","flex":"auto","gap":1,"children":[',
      `{"type":"Row","gap":2,"children":[{"type":"Text","value":${v('"Ticket " ~ number')},"size":"sm","color":"secondary"},{"type":"Spacer"},{"type":"Text","value":${v(words("status"))},"size":"sm","weight":"semibold","color":${ink("tone")}}]},`,
      `{"type":"Title","value":${v("subject")},"size":"sm","maxLines":2}`,
      `{% if priority %},{"type":"Row","gap":2,"children":[{"type":"Badge","label":${v('priority | capitalize ~ " priority"')},"color":${v('{"urgent": "danger", "high": "warning"}[priority] | default("secondary")')},"pill":true}]}{% endif %}`,
      "]}",
      "]},",
      // The latest update, as a message.
      `{% if latest %}{"type":"Box","padding":3,"radius":"xl","background":"surface-secondary","gap":2,"children":[`,
      '{"type":"Row","gap":2,"align":"center","children":[',
      `{% if assigneeAvatar %}{"type":"Image","src":${v("assigneeAvatar")},"alt":${v('assignee | default("")')},"size":24,"radius":"full"}{% else %}{"type":"Box","size":24,"radius":"full","background":"indigo-500","align":"center","justify":"center","children":[{"type":"Text","value":${v('(assignee | default("Support"))[:1] | upper')},"size":"xs","weight":"semibold","color":"white"}]}{% endif %},`,
      `{"type":"Text","value":${v('assignee | default("Support team")')},"size":"sm","weight":"semibold","maxLines":1},{"type":"Spacer"},{"type":"Text","value":${v("updated")},"size":"sm","color":"tertiary"}`,
      "]},",
      `{"type":"Text","value":${v("latest")},"size":"sm"}`,
      `]}{% else %}${line("Updated", "updated")}{% endif %}`,
      `{% if url %},{"type":"Button","label":"View ticket","variant":"outline","pill":true,"block":true,"iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":${v("url")}}}}{% endif %}`,
      "]}",
    ],
    summary: "Ticket {{ number }} · {{ status | replace('_', ' ') }}",
    sample: {
      number: "#4821",
      subject: "CSV export times out for large workspaces",
      status: "open",
      priority: "high",
      assignee: "James Hills",
      assigneeAvatar: "https://widgets.chatkit.studio/jameshills.png",
      updated: "2 hours ago",
      latest: "We found the cause and a fix is in review. I'll write here as soon as it ships.",
      url: "https://example.com/tickets/4821",
    },
    jsonSchema: obj(
      {
        number: str(),
        subject: str(),
        status: oneOf(Object.keys(TICKET_HUES)),
        priority: str("Optional: low, normal, high or urgent."),
        assignee: str("Optional: who has it."),
        assigneeAvatar: str("Optional: https picture of them."),
        updated: str("Written out, like 2 hours ago."),
        latest: str("Optional: the latest public update."),
        url: str("Optional: https link to the ticket."),
      },
      ["number", "subject", "status", "updated"],
    ),
    states: [
      { name: "Solved", data: { number: "#4790", subject: "Can't invite a teammate", status: "solved", assignee: "Rohan Mehta", assigneeAvatar: "https://widgets.chatkit.studio/rohanmehta.png", updated: "Yesterday", latest: "Invites work again after yesterday's fix. Thanks for your patience!" } },
      { name: "Waiting on you", data: { number: "#4833", subject: "Webhook signature doesn't match", status: "waiting_on_you", assignee: "Support team", updated: "10 min ago", latest: "Could you send us the request ID from the failing call?" } },
    ],
  }),
};

// ---------- confirm a change ----------

const change = {
  id: "confirm_change",
  name: "Confirm a change",
  description: "Before an action changes something: an icon, the question, what changes (from → to) on a soft panel, what it costs, Confirm and Cancel.",
  tags: ["confirm", "confirmation", "change", "approve", "yes", "review", "update", "cancel subscription", "before"],
  file: widgetFile({
    name: "Confirm a change",
    template: [
      `{% set hue = color | default("indigo") %}`,
      '{"type":"Card","size":"sm",',
      `"confirm":{"label":${v('confirmLabel | default("Confirm")')},"action":{"type":"tool:apply_change","payload":${v("payload | default({})")}}},`,
      '"cancel":{"label":"Cancel","action":{"type":"dismiss"}},',
      '"children":[',
      '{"type":"Col","align":"center","gap":3,"padding":{"top":2},"children":[',
      `{"type":"Box","padding":3,"radius":"full","background":${v('hue ~ "-500"')},"children":[{"type":"Icon","name":${v('icon | default("sparkle")')},"size":"2xl","color":"white"}]},`,
      `{"type":"Col","align":"center","gap":1,"children":[{"type":"Title","value":${v("title")},"size":"md","textAlign":"center"}{% if description %},{"type":"Text","value":${v("description")},"size":"sm","color":"secondary","textAlign":"center"}{% endif %}]}`,
      "]},",
      '{"type":"Col","gap":2,"padding":3,"radius":"xl","background":"surface-secondary","children":[',
      each(
        "changes",
        "c",
        `{"type":"Row","gap":2,"align":"center","children":[{"type":"Text","value":${v("c.label")},"size":"sm","color":"secondary"},{"type":"Spacer"}{% if c.from %},{"type":"Text","value":${v("c.from")},"size":"sm","color":"tertiary","lineThrough":true},{"type":"Icon","name":"chevron-right","size":"sm","color":"tertiary"}{% endif %},{"type":"Text","value":${v("c.to")},"size":"sm","weight":"semibold"}]}`,
      ),
      "]}",
      `{% if note %},{"type":"Row","gap":2,"align":"start","children":[{"type":"Icon","name":"info","color":"secondary"},{"type":"Text","value":${v("note")},"size":"sm","color":"secondary"}]}{% endif %}`,
      "]}",
    ],
    summary: "{{ title }}",
    sample: {
      title: "Switch to Pro?",
      description: "Your team gets the new limits right away.",
      icon: "bolt",
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
        icon: str("Optional: a ChatKit icon name (default sparkle)."),
        color: str("Optional: a palette hue for the icon, like indigo or red."),
        changes: list(obj({ label: str(), from: str("Optional: the value now."), to: str("The value after.") }, ["label", "to"])),
        note: str("Optional: the cost or anything the customer must know before saying yes."),
        confirmLabel: str("Optional: the button, like Switch to Pro (default Confirm)."),
        payload: { type: "object", description: "Optional: what the action gets when they confirm." },
      },
      ["title", "changes"],
    ),
    states: [
      {
        name: "Cancel subscription",
        data: {
          title: "Cancel your subscription?",
          description: "You keep everything until the end of this period.",
          icon: "empty-circle",
          color: "red",
          changes: [{ label: "Plan", from: "Pro", to: "Cancelled" }, { label: "Access until", to: "Nov 1, 2026" }],
          confirmLabel: "Cancel subscription",
          payload: { cancel: true },
        },
      },
    ],
  }),
};

export const SUPPORT_TEMPLATES: SupportTemplate[] = [account, plans, order, orders, invoices, refund, usage, ticket, change];
