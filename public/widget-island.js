/*! Jun island | MIT License
 * Loaded by widget.js for the island (D-39), with J._bd = { host, post, auto, offset, shown, open } (D-138:
 * moved out of widget.js to keep the loader under its budget).
 * "/" on the page opens the island, unless the visitor is typing somewhere on the page.
 * The page's own fixed bars along the bottom (an app's tab bar on phones, a cookie banner) lift the island
 * above them (jun:lift, the frame moves up); data-bottom-offset on the snippet sets the lift instead.
 * Scrolling down tells the frame the visitor is reading (jun:away), so a resting island steps aside.
 * D-99, when the desk's island colour is "auto" (bd.auto): tells the island frame whether
 * the page behind it is dark (jun:backdrop), so it draws itself near-black on light pages and light on
 * dark ones; again whenever that changes (scrolling past a dark section, the site's theme switch).
 * It looks at colours only, never page text: the first element under the island's spot with a solid
 * background colour (or a gradient's colours), up its ancestors; none means a light page. A 1px
 * canvas reads any CSS colour (oklch, color(), …) as sRGB.
 */
(function () {
  var J = window.JunDesk, bd = J && J._bd;
  if (!bd || bd.on) return;
  bd.on = 1;
  addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.key == "/" && !bd.shown() && !e.ctrlKey && !e.metaKey && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) { e.preventDefault(); bd.open(); }
  });
  // Scrolling down the page: the resting island slides away (jun:away) while the visitor scrolls, and
  // comes back once they stop (a pause), scroll up, or reach the top or end of the page. Only the page's
  // own scroll; the frame decides when it may.
  var lastY = scrollY, run = 0, away = false, rest;
  function tell(a) {
    if (a != away) bd.post({ type: "jun:away", away: (away = a) });
  }
  addEventListener("scroll", function () {
    var y = scrollY, d = y - lastY, a = away;
    lastY = y;
    if (!d) return;
    run = (d > 0) == (run > 0) ? run + d : d;
    if (run > 60 && y > 200) a = true;
    if (run < -12 || y < 100 || y + innerHeight > document.documentElement.scrollHeight - 40) a = false;
    tell(a);
    clearTimeout(rest);
    if (away) rest = setTimeout(function () { run = 0; tell(false); }, 900);
  }, { passive: true });
  // The island's middle along the page, from the frame (jun:spot): the visitor can throw it to a side.
  var cx = null;
  addEventListener("message", function (e) {
    if (e.data && e.data.type == "jun:spot" && typeof e.data.cx == "number") cx = e.data.cx, look();
  });
  var timer, paint, set = bd.offset == null || bd.offset === "" ? NaN : +bd.offset;
  bd.lift = 0;
  // How far the page's fixed bars along the bottom (an app's tab bar, a cookie banner) reach up, so the
  // island sits above them. At five points along the bottom edge, from the topmost element there, up its
  // ancestors to the first fixed or sticky one: the widest box on the way that touches the bottom, spans
  // half the page and is at most 40% of its height (an app shell fixed over the whole screen keeps its
  // tab bar). Something that scrolls on the way isn't a bar. data-bottom-offset sets it instead.
  function lift() {
    var h = innerHeight, w = innerWidth, top = h, x, list, el, i, s, r, bar;
    if (set >= 0) return Math.min(set, h * 0.4);
    for (x = 1; x < 6; x++) {
      list = document.elementsFromPoint(w * x / 6, h - 2);
      for (i = 0; i < list.length && (list[i] == bd.host || bd.host.contains(list[i])); i++);
      for (el = list[i], bar = null; el && el != document.body && el != document.documentElement; el = el.parentElement) {
        s = getComputedStyle(el);
        if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight) break;
        r = el.getBoundingClientRect();
        if (r.bottom >= h - 8 && r.height <= h * 0.4 && r.width >= w / 2) bar = r.top;
        if (/fixed|sticky/.test(s.position)) {
          if (bar != null && s.visibility != "hidden" && s.opacity != "0") top = Math.min(top, bar);
          break;
        }
      }
    }
    return Math.round(Math.max(0, h - top));
  }
  // Dark (true), light (false), or null when the value has no solid colour in it.
  function shade(s) {
    var m = s && s.match(/(rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi), n = 0, t = 0, d;
    if (!m) return null;
    paint = paint || document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    m.forEach(function (c) {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = "#0000";
      paint.fillStyle = c;
      paint.fillRect(0, 0, 1, 1);
      d = paint.getImageData(0, 0, 1, 1).data;
      if (d[3] > 127) n++, t += 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
    });
    return n ? t / n < 128 : null;
  }
  function look() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      var up = lift();
      if (up != bd.lift) bd.post({ type: "jun:lift", px: (bd.lift = up) });
      if (!bd.auto) return;
      // The island's middle: 24px from the bottom (12px on phones) plus half its 44px, above the lift.
      var list = document.elementsFromPoint(cx == null ? innerWidth / 2 : cx, innerHeight - up - (innerWidth < 640 ? 34 : 46)), el, dark = null, c;
      for (var i = 0; i < list.length && !el; i++) if (list[i] != bd.host) el = list[i];
      for (; el && dark == null; el = el.parentElement) {
        c = getComputedStyle(el);
        dark = shade(c.backgroundColor);
        if (dark == null) dark = shade(c.backgroundImage);
      }
      if (!dark) dark = false;
      if (dark !== bd.dark) bd.post({ type: "jun:backdrop", dark: (bd.dark = dark) });
    }, 150);
  }
  addEventListener("scroll", look, { passive: true, capture: true });
  addEventListener("resize", look);
  setInterval(look, 2000);
  look();
})();
