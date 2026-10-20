/*! Jun chat button | MIT License
 * Loaded by widget.js only in window mode with the plain button (desk: Playground → Appearance, D-89):
 * the round button (the company logo, a chat bubble, or "Chat with us"), its unread badge, the chat
 * window's look and the card that offers a chat when something breaks (P-01) or a teammate invites
 * (V-07). The island and the greeting card draw all of this in their own frame. D-138: moved out of
 * widget.js to keep the loader every page runs under its 6 KB budget.
 * widget.js hands over J._b: { root, color, cfg, open, n, card, toggle, go };
 * this file sets J._b.ui, which widget.js calls after each change of open (the chat is shown),
 * n (unread chats) or card (the offer on screen: { text, from? }, or nothing).
 */
(function () {
  var J = window.JunDesk, b = J && J._b;
  if (!b || b.on) return;
  b.on = 1;
  var cfg = b.cfg || {}, wrap = b.root.lastChild, frame = wrap.lastChild, style = document.createElement("style"), box = document.createElement("div");
  style.textContent =
    ".btn,.nudge{position:fixed;right:22px;bottom:88px;z-index:2147483000}button{border:0;padding:0;cursor:pointer}" +
    // D-34: the earlier Jun widget's palette and radii; the open chat has a soft shadow instead of its border.
    ".frame,.nudge{background:#fff;color:#171717;border:1px solid #e5e5e5;border-radius:var(--r,16px)}.nudge{display:none}" +
    // W-04 dark theme ("auto" keeps the light card; the chat itself follows the system). Before .btn, which keeps its colours.
    ".dark>*{background:#171717;color:#f5f5f5;border-color:#2f2f2f}" +
    ".btn{bottom:22px;width:52px;height:52px;border-radius:var(--r,16px);background:var(--c,#2f5bea);color:var(--t,#fff);display:grid;place-items:center}" +
    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e5484d;" +
    "color:#fff;font:600 11px/18px system-ui,sans-serif;display:none}" +
    // The open chat takes the button's corner (the button stays under it); phones get the whole screen (widget.js).
    ".nudge{width:min(380px,max(300px,32vw))}.frame{border:0;box-shadow:0 8px 40px rgba(0,0,0,.16)}" +
    ".nudge{padding:16px 18px;font:14px/1.6 Arial,sans-serif}" +
    // Left side (W-04); the full-screen frame on phones (widget.js's style, after this one) wins over it.
    ".left>*{right:auto;left:22px}" +
    // Opening: the chat grows in from its corner.
    ".o{animation:jo .28s cubic-bezier(.23,1,.32,1);transform-origin:100% 100%}.left .o{transform-origin:0 100%}" +
    "@keyframes jo{from{opacity:0;transform:translateY(10px) scale(.96)}}@media(prefers-reduced-motion:reduce){.o{animation:none}}" +
    ".btn img{width:100%;height:100%;object-fit:cover;border-radius:inherit}.txt .btn{width:auto;padding:0 18px;font:600 14px system-ui,sans-serif}" +
    ".nudge p{margin:0 24px 14px 0}.from{font-size:12px;color:#737373}.go{width:100%;padding:8px 6px;border-radius:calc(var(--r,16px)*.625);background:var(--c,#2f5bea);color:var(--t,#fff);font:12px Arial,sans-serif}" +
    ".x{position:absolute;top:12px;right:12px;width:30px;height:30px;background:none;font-size:23px;font-weight:300;color:#737373}" +
    // Loaded early on a tab whose last page had the plain button, but the desk now has another mode.
    ".card .btn,.island .btn{display:none}";
  box.innerHTML =
    '<div class="nudge" role="dialog" aria-label="Need help?"><button class="x" aria-label="Dismiss">×</button>' +
    '<div class="from"></div><p></p><button class="go">Chat with us</button></div>' +
    '<button class="btn" aria-label="Open chat" aria-expanded="false">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg><span class="badge"></span></button>';
  var card = box.firstChild, button = box.lastChild, badge = button.lastChild;
  b.root.prepend(style);
  // Before the frame: same z-index, so the open chat covers the button.
  frame.before(card, button);

  // W-04: colour, rounding and face from the desk's settings (data-color wins; the desk works out
  // readable text on it, `text`). No settings (the desk couldn't be reached): the default look.
  var c = b.color || cfg.color, face, logo = (cfg.text == "#ffffff" && cfg.logoDarkUrl) || cfg.logoUrl;
  if (c && /^#[0-9a-f]{6}$/i.test(c)) wrap.style.setProperty("--c", c);
  if (cfg.text) wrap.style.setProperty("--t", cfg.text);
  if (cfg.radius != null) wrap.style.setProperty("--r", cfg.radius + "px");
  // W-21: on a dark button colour (white text on it), the logo made for dark backgrounds if there is one.
  if (cfg.buttonStyle == "text") wrap.classList.add("txt"), face = document.createElement("span"), face.textContent = "Chat with us";
  else if (logo) face = document.createElement("img"), face.src = new URL(logo, document.currentScript.src).href, face.alt = "";
  if (face) button.firstChild.replaceWith(face);

  button.onclick = b.toggle;
  card.querySelector(".go").onclick = b.go;
  card.firstChild.onclick = function () { b.card = 0; b.ui(); };

  b.ui = function () {
    var open = !!b.open, n = b.n, o = b.card;
    if (/card|island/.test(wrap.className)) return; // their frame draws all this itself
    frame.style.display = open ? "block" : "";
    frame.classList.toggle("o", open);
    button.setAttribute("aria-expanded", open);
    button.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    // D-138: unread chats, also from a reply that came while the chat was never opened on this page.
    badge.textContent = n > 9 ? "9+" : n;
    badge.style.display = n > 0 && !open ? "block" : "none";
    card.style.display = o && !open ? "block" : "none";
    if (o) card.querySelector("p").textContent = o.text, card.querySelector(".from").textContent = o.from || "";
  };
  b.ui();
})();
