/*! Jun widget loader | MIT License
 * Usage: <script src="https://<your-desk>/widget.js" data-key="wk_..." defer></script>
 *   in <head>, before the site's own scripts: deferred scripts run in document order, so
 *   document.modelContext (below) exists before page code that checks for it once on load.
 * Put it in <head> so it can see errors from the start of the page.
 * Shows the chat: the island or the chat window's greeting card (drawn by an iframe from the desk,
 * loaded straight away), or a plain chat button (widget-button.js) whose chat loads on first open.
 * Captures recent JS errors, failed requests, page navigation, rage and dead clicks (S-02, S-17)
 * and "stuck on a page after an error" (S-13), masked, kept in this tab (sessionStorage, so a
 * reload keeps them), and shares them with support only when the visitor sends a message.
 * data-capture="off" disables capture. Shows the visitor on the desk's live visitor list, one
 * session per browser across tabs (localStorage; bots aren't listed). data-consent="required"
 * waits for JunDesk.consent(true) and stores nothing before it.
 * Page control (AI-32): with "Let the AI use your website" on (desk: Chat widget → Behaviour) the AI may read
 * this page and click, type and choose on it, with the
 * visitor's Confirm for changes; never inside [data-jun-private] or password/card fields (widget-page-control.js).
 * API: window.JunDesk.open() / .close() / .toggle() / .identify(jwt | { name, email, token? }) / .logout() / .consent(bool) / .registerAction(tool)
 *      / .setTheme("light" | "dark" | "auto" | null): follow the site's own dark mode (D-92); null goes back to
 *      the desk's setting. data-theme="dark" on this tag sets it from the first paint.
 *      / .highlight({ sound? }): the island lifts and glows once, to point at it from your own "Ask our AI"
 *      button (W-34; it doesn't open it: open() does). Island mode only. sound: true adds a short cue
 *      when called from a click or key press (browsers block sound otherwise) and the desk's sounds are on.
 * Card actions with ChatKit's handler: "client" (D-51) come to the page, never to the server:
 *   JunDesk.onWidgetAction(function (a) { a.type; a.payload; a.values; a.widget; }) (returns a remover),
 *   or the "jundesk:widget-action" window event (same object as event.detail).
 *      / .reportError({ message, code? }) / .track(name, props?). In island mode, "/" on the page opens it.
 * identify() takes a JWT your backend signs with the desk's identity secret (data-user-token works too), or
 * (V-17) { id, name, email, token? }: without a token they only label the visitor, as not verified; contacts
 * sharing the id or email show as one person on the desk (V-18). data-identify-from="posthog" takes them from
 * PostHog's identify() instead (widget-identify.js).
 * reportError() tells support what failed in your app's own words ("Row 42: missing email"); masked
 * like everything else and kept with the errors above. track() records what the visitor did in your
 * app ("export_started", { format: "csv" }) in the same trail, for the AI and your team.
 * Intents (AI-20): JunDesk.open({ intent: "cancel", onExit: function () { location.href = "/billing/cancel"; } })
 * opens a chat for a purpose. A task in your agent config defines the intent (tasks/<name>.md
 * frontmatter: intent, opening, replies, exit): the chat starts with its opening line and quick
 * replies, and the AI follows that task. If it has an exit ("Cancel anyway"), that button stays
 * visible for the whole chat; one click closes the chat and calls onExit(), where your app goes on
 * (e.g. to its own cancel screen). An intent with an exit but no onExit function opens a plain chat
 * instead (with a console warning): the flow never starts without a way out. Names: [a-z0-9_-], max 40
 * (anything else opens a plain chat).
 * Size: this file runs on every page of every site, so the served (minified) copy stays under 6 KB
 * gzipped (D-38); what only some pages need lives in lazy chunks (widget-*.js, D-138).
 */
(function () {
  var script = document.currentScript, J;
  if (!script || window.JunDesk) return;
  var attr = (name) => script.getAttribute("data-" + name);
  var on = (target, type, fn, capture) => target.addEventListener(type, fn, capture);
  var key = attr("key");
  if (!key) return console.warn("Jun: no data-key");
  var origin = new URL(script.src).origin, api = origin + "/api/widget/" + encodeURIComponent(key);
  var color = attr("color"); // overrides the desk's branding colour
  // D-92: the site's theme (data-theme, JunDesk.setTheme) wins over the desk's; deskTheme is that.
  var themes = /^(light|dark|auto)$/, theme = attr("theme"), deskTheme, pageControl;
  if (!themes.test(theme)) theme = null;

  // ---------- debug capture (P1). Same masking rules as shared/debug.ts. ----------
  var events = [], reacted = () => {}; // reacted: the page answered pending clicks (set below)
  var capture = attr("capture") != "off";
  // S-13 state for the current page (path).
  var pagePath = location.pathname, pageIssue, seen = 0, stuckSent, stuckMs = 180000;
  var nativeFetch = window.fetch;

  function redact(s, max) {
    max = max || 500;
    return String(s == null ? "" : s).slice(0, max * 2)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
      .replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1[token]")
      .replace(/\b(sk|pk|rk)_(live|test)_[\w]+/gi, "[key]")
      .replace(/((?:pass(?:word)?|passwd|secret|token|api[_-]?key|auth\w*|session\w*|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, "$1[redacted]")
      .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]")
      .slice(0, max);
  }
  function parse(u) { try { return new URL(String(u), location.href); } catch (e) {} }
  // Campaign tags keep their values (utm_source=google): they name an ad, never a person.
  var UTM = /^utm_(source|medium|campaign|term|content)$/;
  var utmValue = (v) => redact(v, 80).replace(/[\s&#=?]+/g, "-");
  function cleanUrl(u) {
    var x = parse(u), q = [];
    if (!x) return redact(String(u).split(/[?#]/)[0], 300);
    x.searchParams.forEach((v, k) => { if (q.indexOf(k) < 0 && q.length < 10) q.push(k); });
    var path = redact(x.pathname, 300) + (q.length ? "?" + q.map((k) => redact(k, 40) + "=" + (UTM.test(k) ? utmValue(x.searchParams.get(k)) : "…")).join("&") : "") +
      // Hash routers (#/settings) keep the route, without its own query; plain anchors are dropped.
      (/^#!?\//.test(x.hash) ? redact(x.hash.split("?")[0], 200) : "");
    return x.origin == location.origin ? path : x.origin + path;
  }
  // This page, masked: for the trail's snapshot, the live visitor list and a nudge.
  var here = () => ({ url: location.origin + cleanUrl(location.href), title: redact(document.title, 200) });
  // Registrable domain, roughly: the last two labels, or three for "co.uk"-style suffixes.
  function site(h) { var p = h.split("."), n = p.length; return p.slice(n > 2 && p[n - 2].length < 4 && p[n - 1].length < 3 ? -3 : -2).join("."); }
  function push(e) {
    e.t = Date.now();
    events.push(e);
    if (events.length > 40) events.shift();
    store("jun:e", JSON.stringify(events)); // survives a reload in this tab (not before consent)
    // S-13: remember this page's latest problem (a successful submit clears it). Any failed
    // request counts (a GET 404 doesn't nudge by itself), but not asset loads, and a request that
    // got no response (status 0) only when it went to the page's own site: ad blockers and privacy
    // tools block third-party requests (analytics, trackers) all the time.
    var x, k = e.kind, net = k == "network" && !/^failed to load/.test(e.message) &&
      (e.status || e.url[0] == "/" || (x = parse(e.url)) && site(x.hostname) == site(location.hostname));
    if (/error$|rage/.test(k) || net) pageIssue = k;
    // P-01: offer a chat for JS errors, the app's own (reportError), S-02, S-13 and failed API
    // calls, not 404s on GETs. Nothing leaves the page before consent (V-06).
    if (nudged || open || !consented || !(/error$|rage|stuck/.test(k) || net && (!e.status || e.status > 499 || e.method != "GET"))) return;
    nudgeEvent = e;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(showNudge, /rage|stuck/.test(k) ? 0 : 1200); // errors come in bursts; wait for things to settle (rage clicks already waited)
  }
  // Our own traffic (the chat iframe, uploads) isn't the customer's problem.
  function ours(u) { var x = parse(u); return x && x.origin == origin && /^\/(api\/(widget|files)|widget)/.test(x.pathname); }
  var stackOf = (err) => redact(err && err.stack || "", 800).split("\n").slice(0, 5).join("\n") || undefined;

  if (capture) {
    try {
      on(window, "error", (e) => {
        var el = e.target, src = el && el != window && (el.src || el.href);
        if (src) {
          if (!ours(src)) push({ kind: "network", method: "GET", url: cleanUrl(src), status: 0, message: "failed to load " + String(el.tagName).toLowerCase() });
        } else {
          push({ kind: "error", message: redact(e.message || (e.error && e.error.message)), source: e.filename ? cleanUrl(e.filename) + ":" + e.lineno : undefined, stack: stackOf(e.error) });
        }
      }, true);
      on(window, "unhandledrejection", (e) => {
        var r = e.reason;
        push({ kind: "error", message: "Unhandled rejection: " + redact(r && r.message || r), stack: stackOf(r) });
      });

      // fetch and XHR: record failures (4xx/5xx, or no response at all: err); a successful
      // non-GET means a save went through (S-13).
      var request = (method, url) => {
        var started = Date.now();
        method = String(method || "GET").toUpperCase();
        return !ours(url) && ((status, err) => {
          if (status > 399 || err) push({ kind: "network", method: method, url: cleanUrl(url), status: status, message: err && redact(err.message), durationMs: Date.now() - started });
          else if (status > 199 && status < 300 && method != "GET") pageIssue = 0;
        });
      };
      if (nativeFetch) {
        window.fetch = function (input, init) {
          var done = request(init && init.method || input && input.method, input && input.url || input);
          var p = nativeFetch.apply(this, arguments);
          return done ? p.then((res) => { done(res.status); return res; }, (err) => { done(0, err || {}); throw err; }) : p;
        };
      }

      // Not "open"/"send": vars are function-scoped and `open` is the chat's state below.
      var xhr = XMLHttpRequest.prototype, xhrOpen = xhr.open, xhrSend = xhr.send;
      xhr.open = function (method, url) { this.__jun = [method, url]; return xhrOpen.apply(this, arguments); };
      xhr.send = function () {
        var x = this, done = x.__jun && request(x.__jun[0], x.__jun[1]);
        if (done) on(x, "loadend", () => done(x.status, !x.status && {}));
        return xhrSend.apply(this, arguments);
      };

      // S-02 rage clicks. Sentry's definitions (docs.sentry.io/product/issues/issue-details/replay-issues/rage-clicks/,
      // checked 2026-10-05): a dead click is a click on a button/input/link with no DOM change or
      // scroll within 7 s; 3+ such clicks in that time are a rage click. Ours is stricter on time:
      // 3+ clicks on the same element within 1 s and 30 px, and nothing in the DOM changes or
      // scrolls from the first click until 1 s after the last.
      // Dead clicks (PostHog's rule, posthog-js dead-clicks-autocapture, checked 2026-10-18): one
      // click on a button or link and nothing changes, scrolls, submits or navigates for 2.5 s.
      // Kept in the trail only (one dead click is no reason to offer help). Not for links that
      // open elsewhere (new tab, download, mail, phone) or the clicks of a rage burst.
      // Recorded: a safe description of the element (never values or arbitrary text) and the count.
      // Only changes a visitor could see count: browser extensions (Matter, password managers)
      // rewrite attributes on their own hidden iframes, often outside <body>, on every click.
      // Hiding something counts.
      var burst, waiting = [], mo = new MutationObserver((ms) => {
        if (ms.some((m) => {
          var n = m.target.nodeType == 1 ? m.target : m.target.parentElement;
          return n && document.body.contains(n) && (n.getClientRects().length || /^(class|style|hidden|open)$/.test(m.attributeName) && m.oldValue != n.getAttribute(m.attributeName));
        })) reacted();
      });
      // The page answered every click still waiting.
      reacted = () => { waiting.forEach((c) => { c.changed = 1; }); waiting = []; mo.disconnect(); };
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
            if (!c.changed && b.ts.length < 3 && button && consented && document.body.contains(el) && !el.closest("[target=_blank],[download],[href^='mailto:'],[href^='tel:']")) push({ kind: "dead_click", target: targetOf(el, button) });
          }, 2500);
        } else setTimeout(() => settled(c), 2500);
        b.t = now;
        b.last = c;
        var n = b.ts.push(now);
        if (n < 3 || now - b.ts[n - 3] > 1000) return;
        clearTimeout(b.timer);
        b.timer = setTimeout(() => {
          // A triple click that selected text isn't frustration.
          if (burst != b || b.first.changed || b.last.changed || !consented || !button && String(getSelection())) return;
          push({ kind: "rage_click", target: targetOf(el, button), count: b.ts.length });
        }, 1000);
      }, true);

      // S-13 stuck on a form: on this page for 3+ visible minutes (hidden tab time doesn't count)
      // after a real problem, with no successful submit since. A plain timer would be the cut timed pop-up (N-02).
      on(window, "submit", () => { pageIssue = 0; reacted(); }, true);
    } catch (e) { /* never break the host page */ }
  }

  // Visible time on this page (path), for S-13 and P-01 page openers. Runs with capture off too:
  // openers send nothing captured (pageIssue stays unset without capture, so no S-13).
  setInterval(() => {
    if (!document.hidden) seen += 1000;
    if (seen >= stuckMs && pageIssue && !stuckSent && consented) {
      stuckSent = 1;
      push({ kind: "stuck", url: cleanUrl(location.pathname), seconds: seen / 1000, issue: pageIssue });
    }
    // P-01: the first opener rule (Settings) for this path whose visible seconds are up; the desk
    // sends its line. Not after an error nudge, a card, or once the chat was opened (setOpen clears them).
    if (openers && !nudged && !nudgeTimer && consented) openers.some((r) =>
      seen >= r.delay * 1000 && RegExp(r.match).test(pagePath) && (nudgeEvent = { kind: "opener", id: r.id }, openers = 0, !showNudge()));
  }, 1000);

  // Page changes feed both the debug trail and the live visitor list.
  // Only real changes: popstate and hashchange both fire for one hash route, and a replaceState
  // that changes a query value or a plain #anchor cleans to the same URL.
  var lastUrl;
  function nav() {
    var u = cleanUrl(location.href);
    reacted();
    if (u == lastUrl) return;
    lastUrl = u;
    if (location.pathname != pagePath) { pagePath = location.pathname; pageIssue = seen = stuckSent = 0; }
    if (capture) push({ kind: "navigation", url: u });
    viewed();
  }
  try {
    ["pushState", "replaceState"].forEach((name) => {
      var orig = history[name];
      history[name] = function () { var r = orig.apply(this, arguments); nav(); return r; };
    });
    on(window, "popstate", nav);
    on(window, "hashchange", nav);
  } catch (e) {}

  // ---------- live visitor (V-01), identity (V-03), consent (V-06) ----------
  // data-consent="required": store nothing and stay off the visitor list until JunDesk.consent(true).
  var consented = attr("consent") != "required";
  var userToken = attr("user-token") || null, who;
  var sid, sess, counted, live, liveTries = 0;
  // sessionStorage, or localStorage with `local`; nothing before consent.
  function store(k, v, local) { try { if (!consented) return null; var s = local ? localStorage : sessionStorage; if (v === 0) s.removeItem(k); else if (v != null) s.setItem(k, v); return s.getItem(k); } catch (e) { return null; } }
  var liveSend = (m) => { if (live && live.readyState == 1) live.send(JSON.stringify(m)); };
  // Crawlers, uptime checks and automated browsers never join the visitor list (PostHog drops them too).
  var bot = navigator.webdriver || /bot\b|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|phantom/i.test(navigator.userAgent);

  // The trail survives a reload in this tab (it broke, they refreshed, then asked): the last 30 minutes.
  if (capture) {
    try { events = JSON.parse(store("jun:e")).filter((e) => e.t > Date.now() - 18e5).concat(events).slice(-40); } catch (e) {}
    // How this page was reached: a reload is worth knowing about.
    var how = ((performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || {}).type;
    push({ kind: "navigation", url: lastUrl = cleanUrl(location.href), how: { reload: "reload", back_forward: "back" }[how] || "open" });
  }

  // One session for the whole browser, shared by its tabs (PostHog's rule): a new one after 30
  // minutes without a page view or a visible tab, or after 24 hours. It keeps where the visit
  // came from (referrer, campaign tags) and the pages viewed, so a reload or a second tab adds to it.
  function session(fresh) {
    var now = Date.now(), s, x = parse(document.referrer), q = {}, n = 0;
    try { s = JSON.parse(store("jun:session", null, 1)); } catch (e) {}
    s = s || sess; // storage off: this tab's own
    if (fresh || !s || !s.id || now - s.last > 18e5 || now - s.start > 864e5) {
      try { new URLSearchParams(location.search).forEach((v, k) => { var m = UTM.exec(k); if (m && v) q[m[1]] = utmValue(v), n++; }); } catch (e) {}
      // Another page of this same site isn't where they came from.
      // The id: 96 random bits as "12-255-0-…" (the desk accepts [A-Za-z0-9_-]{8,64}).
      s = { id: crypto.getRandomValues(new Uint8Array(12)).join("-"), start: now, pages: 0, ref: x && site(x.hostname) != site(location.hostname) ? cleanUrl(document.referrer) : "", utm: n ? q : null };
    }
    s.last = now;
    store("jun:session", JSON.stringify(s), 1);
    return sess = s;
  }
  // A page view (load or in-app navigation) counts for the session; its id changes after 30 idle minutes.
  function viewed() {
    if (!live) return;
    if (session().id != sid) return disconnect(), connect();
    count();
    sendPage();
  }
  function count() { sess.pages++; store("jun:session", JSON.stringify(sess), 1); }
  function sendPage() {
    var m = here();
    m.t = "page";
    m.ref = sess.ref, m.utm = sess.utm, m.pages = sess.pages, m.start = sess.start, m.lang = navigator.language;
    try { m.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    liveSend(m);
  }
  function connect() {
    if (!consented || live) return;
    if (pageControl) chunk("page-control");
    // V-18: data-identify-from="posthog" labels the visitor from PostHog's identify (widget-identify.js). After consent.
    if (attr("identify-from")) chunk("identify");
    if (bot) return;
    sid = session().id;
    if (counted != sid) counted = sid, count(); // this page, once per session (not on reconnects)
    var ws = live = new WebSocket(api.replace(/^http/, "ws") + "/live?s=" + sid);
    // D-128: jun:live lets the frame link this socket to its chats (it holds the visitor token).
    ws.onopen = () => { liveTries = 0; if (userToken) liveSend({ t: "id", token: userToken }); sendPage(); post({ type: "jun:live", sessionId: sid }); };
    ws.onmessage = (e) => {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      // V-07: a teammate started a chat from the desk's visitor list.
      if (m.t == "invite" && !open) showCard({ text: String(m.body).slice(0, 1000), inviteId: m.id, from: m.from }), post({ type: "jun:invite" });
      // D-128: a reply in one of this browser's chats (just its id): the frame refetches its list.
      // D-138: with the plain button the chat may not be loaded on this page yet: load it (hidden),
      // so it counts what's unread (jun:unread, the button's badge) and shows the reply when opened.
      if (m.t == "reply") post({ type: "jun:reply", id: m.conversationId }), load();
    };
    // Reconnect with backoff, unless this socket was replaced or dropped on purpose.
    ws.onclose = () => { if (live != ws) return; live = null; if (liveTries < 8) setTimeout(connect, 1000 * Math.pow(2, liveTries++)); };
  }
  function disconnect() { var ws = live; live = null; if (ws) ws.close(); }
  // A visible tab keeps the session going (a hidden one doesn't, so 30 idle minutes end it).
  setInterval(() => { if (live && live.readyState == 1) { live.send("ping"); if (!document.hidden && session().id != sid) disconnect(), connect(); } }, 30000);

  // ---------- proactive help (P-01): offer a chat when something really breaks ----------
  var nudged, nudgeTimer, nudgeEvent, openers; // push() and the ticker decide when (P-01)
  // An offer to chat (what the chat starts with if they take it): { text, inviteId?, from?, page? }.
  // The card and island frames show it themselves; the plain button's card is widget-button.js's.
  function showCard(o) {
    nudged = 1;
    if (/card|island/.test(wrap.className)) return pendingOpener = o, proactive();
    b.card = o;
    b.ui();
  }
  // The desk words it from what failed (S-11). Plain-text POST: no CORS preflight.
  function showNudge() {
    if (nudged || open) return;
    nativeFetch(api + "/nudge", { method: "POST", body: JSON.stringify({ event: nudgeEvent, page: here() }) })
      .then((r) => r.json()).then((res) => { if (res.show && res.text && !nudged && !open) showCard(res); }).catch(() => {});
  }

  // ---------- the chat ----------
  // A shadow root with the chat's frame; the plain button (widget-button.js) adds itself here too.
  var host = document.createElement("div");
  host.setAttribute("data-jun-desk", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML =
    "<style>" +
    ":host{all:initial}.w:not(.on){visibility:hidden}" +
    // The open chat's box, in the plain button's corner (the card and the island resize and place it, jun:css).
    ".frame{position:fixed;right:22px;bottom:22px;z-index:2147483000;width:min(380px,max(300px,32vw));height:min(540px,100dvh - 44px);border:0;display:none}" +
    "@media(max-width:768px){.frame{inset:0;width:100%;height:100dvh;border-radius:0}}" +
    // The card's and the island's frame is always shown (D-90: the card's never resizes; it morphs inside,
    // clipped by jun:css) and draws its own edge, unseen until it has sized itself: before that it's the
    // default box, painted dark by a dark-mode browser.
    ".self .frame{display:block}.self .frame:not(.sized){visibility:hidden}" +
    '</style><div class="w"><iframe class="frame" title="Chat" allow="clipboard-write; display-capture; autoplay"></iframe></div>';

  var wrap = root.lastChild, frame = wrap.firstChild, open, pendingOpener, onExit;
  // Unread chats (the frame's jun:unread), kept for this tab's next pages: the plain button's badge.
  var unreadBefore = +store("jun:unread") || 0;
  // What widget-button.js draws from (see its header); b.ui() redraws, a no-op until it has loaded.
  var b = {
    root: root, color: color, n: unreadBefore, ui: () => {},
    toggle: () => setOpen(!open),
    go: () => { pendingOpener = b.card; setOpen(true); },
  };
  // W-04: colour, side and launcher from the desk's settings, so changing them needs no new snippet.
  // Hidden until then, however long they take: guessing showed the plain button, then swapped it for the
  // island. Only when the desk can't be reached does the button show, in the default colour.
  var launcherKey = "jun:launcher:" + key, lastLauncher = store(launcherKey), chunks = {}; // chunks: see chunk()
  function brand(cfg) {
    b.cfg = cfg;
    if (cfg) {
      openers = !open && cfg.openers;
      // The desk's mode changed since this tab's last page: forget the early frame's box.
      if (lastLauncher && lastLauncher != cfg.launcher) wrap.classList.remove(lastLauncher, "self"), frame.style.cssText = "", frame.classList.remove("sized");
      store(launcherKey, cfg.launcher);
      // W-04: side, dark theme, and the launcher (the card and the island load the frame now).
      // D-89: the desk keeps sending `launcher` (island | card | button) from its mode and greeting card switch.
      wrap.classList.add(cfg.position, cfg.launcher); // "left", "island", "card"
      deskTheme = cfg.theme;
      if (cfg.launcher != "button") wrap.classList.add("self"), load();
      // AI-32 (D-93): the desk's switch; data-page-control="off" keeps this site out. After consent (connect).
      pageControl = cfg.pageControl && attr("page-control") != "off";
      if (pageControl && consented) chunk("page-control");
      // The island's extras (widget-island.js): "/" opens it (D-39), and an "auto" island is drawn
      // against the page behind it (D-99): that chunk watches the colour there.
      if (cfg.launcher == "island") J._bd = { host: host, post: post, auto: cfg.islandSurface == "auto", shown: () => open, open: () => setOpen(true) }, chunk("island");
    }
    if (!cfg || cfg.launcher == "button") chunk("button");
    paintTheme();
    wrap.classList.add("on");
  }
  // Only .dark is styled ("auto" keeps the light button and card; the chat follows the system).
  var paintTheme = () => wrap.classList.toggle("dark", (theme || deskTheme) == "dark");
  nativeFetch(api + "/config?color=" + encodeURIComponent(color || "")).then((r) => { if (!r.ok) throw r; return r.json(); }).then(brand, () => brand());
  // The island and the card draw themselves in their frame (unseen until it has sized itself), so on this
  // tab's next pages it starts loading before the settings answer; the plain button's chunk too.
  if (/^(island|card)$/.test(lastLauncher)) wrap.classList.add(lastLauncher, "on", "self"), load();
  if (lastLauncher == "button") chunk("button");
  // D-138: unread chats from an earlier page: the frame loads (hidden) to keep the count right.
  if (unreadBefore) load();

  // The offer waiting for the frame (it answers jun:proactive-shown).
  var proactive = () => post({ type: "jun:proactive", opener: pendingOpener, sessionId: sid });
  function post(message) {
    if (frame.contentWindow) frame.contentWindow.postMessage(message, origin);
  }

  // The chat loads on first open (the card and the island draw themselves, so they load straight away).
  function load() {
    if (!frame.src) frame.src = origin + "/widget?key=" + encodeURIComponent(key) + (consented ? "" : "&persist=0");
  }
  // Lazy chunks, each loaded once (added scripts run async): widget-actions.js (below),
  // widget-button.js, widget-island.js and widget-page-control.js (AI-32).
  var actionQueue = [];
  function chunk(name) {
    if (chunks[name]) return;
    chunks[name] = 1;
    var s = document.createElement("script");
    s.src = origin + "/widget-" + name + ".js";
    document.head.appendChild(s);
  }
  // AI-21 page actions (D-40): WebMCP tools the page registers, offered to the AI. The code lives in
  // widget-actions.js, loaded on first use; until then registrations queue here. Without native
  // WebMCP, a small shim takes document.modelContext.registerTool calls so early page code works.
  if (document.modelContext) chunk("actions");
  else document.modelContext = {
    jun: 1, q: [],
    registerTool: function (t, o) { this.q.push([t, o]); chunk("actions"); },
    getTools: function () { var q = this.q; chunk("actions"); return new Promise((r) => q.push([0, r])); }, // answered by widget-actions.js
  };
  // The plain button's badge: unread chats while the chat is closed; opening it counts as seen (as before D-138).
  function unread(n) { store("jun:unread", (b.n = !open && n || 0) || 0); }
  function setOpen(next) {
    reacted();
    open = b.open = next;
    if (open) b.card = 0, unread(0), load(), openers = 0;
    b.ui();
    post({ type: open ? "jun:open" : "jun:close" });
    if (open && pendingOpener) proactive();
  }

  on(window, "message", (e) => {
    if (e.origin != origin || !e.data || e.source != frame.contentWindow) return;
    var type = e.data.type;
    // The frame says when it's listening; tell it whether it's currently shown.
    if (type == "jun:ready") {
      post({ type: "jun:session", sessionId: sid || null, userToken: userToken, who: who, persist: consented, theme: theme });
      post({ type: open ? "jun:open" : "jun:close" });
      if (pendingOpener) proactive();
      var bd = J._bd;
      if (bd && bd.dark != null) post({ type: "jun:backdrop", dark: bd.dark });
    }
    if (type == "jun:proactive-shown") pendingOpener = null;
    if (type == "jun:open" || type == "jun:close") setOpen(type == "jun:open");
    // The card and island frames size and clip themselves (they know what they show); only our own frame gets here.
    // Our widget answering a click (opening, the island growing) is the page reacting: not a dead click.
    if (type == "jun:css") frame.style.cssText = e.data.css, frame.classList.add("sized"), reacted();
    // AI-20: the intent's exit button ("Cancel anyway"): close, then hand back to the host app, once.
    // After a reload the page's onExit is gone: the chat still closes (the exit itself was recorded by the frame).
    if (type == "jun:exit") {
      var done = onExit;
      onExit = 0;
      setOpen(false);
      if (done) done();
    }
    if (type == "jun:context-request") {
      // The debug snapshot, and (AI-21) what this page offers the AI right now. The frame adds the
      // browser's own details (userAgent, language, timezone: the same there). events is empty when
      // capture is off (postMessage sends a copy).
      var a = J._a, id = e.data.id;
      var reply = (actions) => post({ type: "jun:context", id: id, context: { page: here(), viewport: { w: innerWidth, h: innerHeight }, capturedAt: Date.now(), events: events }, actions: actions });
      if (a) a.list(reply); else reply();
    }
    if ((type == "jun:run" || type == "jun:undo") && J._a) J._a.handle(e.data, post);
    // D-51: a card action for the page (ChatKit's handler: "client").
    if (type == "jun:widget") try { dispatchEvent(new CustomEvent("jundesk:widget-action", { detail: e.data.action })); } catch (x) {}
    if (type == "jun:unread") unread(Number(e.data.count)), b.ui();
  });

  J = window.JunDesk = {
    // AI-20: open({ intent, onExit }) starts an intent's chat (see the header). The frame checks the
    // name (a bad one opens a plain chat) and whether the intent needs onExit.
    open: (o) => {
      if (o && o.intent) pendingOpener = { intent: o.intent, exit: !!(onExit = typeof o.onExit == "function" && o.onExit) };
      setOpen(true);
    },
    close: () => setOpen(false),
    highlight: (o) => post({ type: "jun:highlight", sound: !!(o && o.sound) }),
    toggle: b.toggle,
    // D-92: "light", "dark" or "auto" (the visitor's system) from the site's own theme switch; null = the desk's.
    setTheme: (t) => {
      theme = themes.test(t) ? t : null;
      paintTheme();
      post({ type: "jun:theme", theme: theme });
    },
    // Signed-in user: a JWT from your backend, or (V-17) { id, name, email, token? }: without a token only a label
    // agents see as not verified. The chat and the visitor list then know who it is.
    identify: (t) => {
      var o = t && typeof t == "object";
      who = o ? { id: t.id, name: t.name, email: t.email } : 0;
      userToken = (o ? t.token : t) || null;
      if (userToken) liveSend({ t: "id", token: userToken });
      post({ type: "jun:identify", userToken: userToken, who: who });
    },
    // On sign-out: forget this browser's chat identity so the next person starts fresh.
    logout: () => {
      userToken = who = null;
      post({ type: "jun:identify", userToken: null });
      disconnect();
      sid = null;
      session(1);
      connect();
    },
    // S-12: the app says what failed, in its own words. Same masking as shared/debug.ts.
    reportError: (err) => {
      try {
        var m = err && typeof err.message == "string" && err.message.trim();
        if (!m || !capture || !consented) return;
        var e = { kind: "app_error", message: redact(m, 300) };
        var c = typeof err.code == "string" && redact(err.code, 60).replace(/[^\w.-]/g, "");
        if (c) e.code = c;
        push(e);
      } catch (x) { /* never break the host page */ }
    },
    // What the visitor did in your app ("export_started", { format: "csv" }): joins the trail, so
    // the AI and your team see it beside errors. Up to 10 properties: strings (masked, ≤ 100), numbers, booleans.
    track: (name, props) => {
      try {
        name = typeof name == "string" && name.trim().slice(0, 60).replace(/[^\w.:\/ -]/g, "");
        if (!name || !capture || !consented) return;
        var e = { kind: "app_event", name: redact(name, 60) }, p = {}, n = 0;
        for (var k in props) {
          var v = props[k], t = typeof v;
          if (n < 10 && /^[\w.-]{1,40}$/.test(k) && (t == "string" || t == "boolean" || t == "number" && isFinite(v))) p[k] = t == "string" ? redact(v, 100) : v, n++;
        }
        if (n) e.props = p;
        push(e);
      } catch (x) { /* never break the host page */ }
    },
    consent: (yes) => {
      // Withdrawn: forget the trail and the session this page stored.
      if (!yes) store("jun:e", 0), store("jun:session", 0, 1), store("jun:unread", 0);
      consented = Boolean(yes);
      if (consented) store("jun:e", JSON.stringify(events));
      post({ type: "jun:consent", persist: consented });
      if (consented) connect();
      else disconnect();
    },
    // AI-21: a WebMCP tool ({ name, description, inputSchema, execute, annotations }) plus extras
    // (pages, key, element, context, available, undo, risk); see widget-actions.js. Returns a remover.
    _q: actionQueue,
    _b: b, // for widget-button.js
    _id: () => userToken, // for widget-identify.js: a signed user is never relabelled
    onWidgetAction: (fn) => {
      var h = (e) => fn(e.detail);
      on(window, "jundesk:widget-action", h);
      return () => removeEventListener("jundesk:widget-action", h);
    },
    registerAction: (t) => {
      var r = { t: t }; // widget-actions.js sets r.off; r.dead once removed
      if (J._a) r.off = J._a.register(t);
      else { actionQueue.push(r); chunk("actions"); }
      return () => { r.dead = true; if (r.off) r.off(); };
    },
  };
  // For code that loaded before this script (e.g. the React hook): the API is there now.
  try { dispatchEvent(new Event("jundesk:ready")); } catch (e) {}
  connect();

  // Loaded from <head> (recommended, for early error capture) there's no body yet.
  if (document.body) document.body.appendChild(host);
  else on(document, "DOMContentLoaded", () => document.body.appendChild(host));
})();
