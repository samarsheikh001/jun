/*! Jun identify bridge | MIT License
 * Loaded by widget.js when its script tag has data-identify-from="posthog" (V-18, D-147), after consent.
 * Labels the chat's visitor with who PostHog says the user is, so a site that already calls
 * posthog.identify() doesn't need its own JunDesk.identify() call: the user id (PostHog's distinct_id once
 * identified) and the name and email from identify()'s person properties ($set, else the ones PostHog keeps
 * for flags). Like JunDesk.identify({ id, name, email }) without a token it's only a label, shown as not
 * verified: it links contacts that are the same person on the desk, never unlocks history or {user.*}
 * actions. A visitor signed in with a token (JunDesk.identify(jwt)) is left as it is.
 */
(function () {
  var J = window.JunDesk;
  if (!J || J._ib) return;
  J._ib = 1;
  var last = "", tries = 0;
  function str(v) { return typeof v == "string" || typeof v == "number" ? String(v) : undefined; }
  function label(id, props) {
    if (J._id()) return;
    props = props || {};
    var who = { id: id, name: str(props.name) || [str(props.first_name), str(props.last_name)].filter(Boolean).join(" ") || undefined, email: str(props.email) };
    var k = JSON.stringify(who);
    if (k != last && (who.id || who.email)) last = k, J.identify(who);
  }
  function stored(ph) {
    try { return ph.get_property("$stored_person_properties") || {}; } catch (e) { return {}; }
  }
  function start() {
    var ph = window.posthog;
    if (!ph || !ph.__loaded || typeof ph.on != "function") {
      // PostHog may load after us: look again for ~15 s.
      if (++tries < 30) setTimeout(start, 500);
      return;
    }
    var identified = () => { try { return ph.get_property("$user_state") == "identified"; } catch (e) { return false; } };
    if (identified()) label(str(ph.get_distinct_id()), stored(ph));
    ph.on("eventCaptured", function (e) {
      if (!e || (e.event != "$identify" && e.event != "$set")) return;
      var p = e.properties || {}, set = e.$set || p.$set || {};
      if (identified()) label(str(p.distinct_id) || str(ph.get_distinct_id()), Object.assign({}, stored(ph), set));
    });
  }
  start();
})();
