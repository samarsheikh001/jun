/*! Jun island | MIT License
 * Loaded by widget.js for the island (D-39), with J._bd = { host, post, auto, shown, open } (D-138: moved
 * out of widget.js to keep the loader under its budget).
 * "/" on the page opens the island, unless the visitor is typing somewhere on the page.
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
  if (!bd.auto) return;
  var timer, paint;
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
      // The island's middle: 24px from the bottom (12px on phones) plus half its 54px.
      var list = document.elementsFromPoint(innerWidth / 2, innerHeight - (innerWidth < 640 ? 39 : 51)), el, dark = null, c;
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
