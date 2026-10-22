/*! Jun clicks | MIT License
 * Loaded by widget.js while debug capture is on, with J._c = { push, redact, ok, set } (D-149: moved out of
 * widget.js to keep the loader under its budget). Records rage clicks (S-02) and dead clicks (D-107) in the
 * debug trail through push(); ok() says whether the visitor has consented; set(fn) hands the loader the
 * function it calls whenever the page reacts some other way (navigation, the chat opening, a submit).
 *
 * S-02 rage clicks. Sentry's definitions (docs.sentry.io/product/issues/issue-details/replay-issues/rage-clicks/,
 * checked 2026-10-05): a dead click is a click on a button/input/link with no DOM change or
 * scroll within 7 s; 3+ such clicks in that time are a rage click. Ours is stricter on time:
 * 3+ clicks on the same element within 1 s and 30 px, and nothing in the DOM changes or
 * scrolls from the first click until 1 s after the last.
 * Dead clicks (PostHog's rule, posthog-js dead-clicks-autocapture, checked 2026-10-18): one
 * click on a button or link and nothing changes, scrolls, submits or navigates for 2.5 s.
 * Kept in the trail only (one dead click is no reason to offer help). Not for links that
 * open elsewhere (new tab, download, mail, phone) or the clicks of a rage burst.
 * Recorded: a safe description of the element (never values or arbitrary text) and the count.
 * Only changes a visitor could see count: browser extensions (Matter, password managers)
 * rewrite attributes on their own hidden iframes, often outside <body>, on every click.
 * Hiding something counts.
 */
(function () {
  var J = window.JunDesk, c0 = J && J._c;
  if (!c0 || c0.on) return;
  c0.on = 1;
  var push = c0.push, redact = c0.redact;
  var on = (target, type, fn, capture) => target.addEventListener(type, fn, capture);
  try {
    var burst, waiting = [], mo = new MutationObserver((ms) => {
      if (ms.some((m) => {
        var n = m.target.nodeType == 1 ? m.target : m.target.parentElement;
        return n && document.body.contains(n) && (n.getClientRects().length || /^(class|style|hidden|open)$/.test(m.attributeName) && m.oldValue != n.getAttribute(m.attributeName));
      })) reacted();
    });
    // The page answered every click still waiting.
    var reacted = () => { waiting.forEach((c) => { c.changed = 1; }); waiting = []; mo.disconnect(); };
    c0.set(reacted);
    var settled = (c) => { var i = waiting.indexOf(c); if (i > -1) waiting.splice(i, 1); if (!waiting.length) mo.disconnect(); };
    var targetOf = (el, button) => {
      var t = { tag: el.tagName.toLowerCase() }, role = el.getAttribute("role"), text = button && String(el.innerText || "").replace(/\s+/g, " ").trim();
      ["id", "aria-label", "name"].forEach((a) => { var v = el.getAttribute(a); if (v) t[a == "id" || a == "name" ? a : "label"] = redact(v, 60); });
      if (role) t.role = role.slice(0, 20);
      if (text && text.length <= 40) t.text = redact(text, 40);
      return t;
    };
    on(window, "scroll", () => reacted(), true);
    on(window, "click", (ev) => {
      var el = ev.target, now = Date.now(), b = burst, c = {};
      el = el && el.closest && (el.closest("button,a,[role=button],input") || el);
      // Not typing, media, our own widget, or scripted clicks.
      if (!el || !ev.isTrusted || el.closest("[data-jun-desk],[contenteditable],textarea,select,canvas,video,audio,input:not([type=submit],[type=button])")) return;
      var button = /^(a|button|input)$/i.test(el.tagName) || el.getAttribute("role") == "button";
      if (!waiting.length) mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true });
      waiting.push(c);
      if (!b || b.el != el || now - b.t > 1000 || Math.abs(ev.clientX - b.x) > 30 || Math.abs(ev.clientY - b.y) > 30) {
        b = burst = { el: el, x: ev.clientX, y: ev.clientY, ts: [], first: c };
        setTimeout(() => {
          settled(c);
          if (!c.changed && b.ts.length < 3 && button && c0.ok() && document.body.contains(el) && !el.closest("[target=_blank],[download],[href^='mailto:'],[href^='tel:']")) push({ kind: "dead_click", target: targetOf(el, button) });
        }, 2500);
      } else setTimeout(() => settled(c), 2500);
      b.t = now;
      b.last = c;
      var n = b.ts.push(now);
      if (n < 3 || now - b.ts[n - 3] > 1000) return;
      clearTimeout(b.timer);
      b.timer = setTimeout(() => {
        // A triple click that selected text isn't frustration.
        if (burst != b || b.first.changed || b.last.changed || !c0.ok() || !button && String(getSelection())) return;
        push({ kind: "rage_click", target: targetOf(el, button), count: b.ts.length });
      }, 1000);
    }, true);
  } catch (e) { /* never break the host page */ }
})();
