/*
 * live.js — talks to the real BART API through the /api/bart proxy.
 *
 * The proxy injects the API key and adds CORS headers (BART's API has neither
 * CORS nor an env-safe key story for the browser). Everything here degrades
 * gracefully: if the proxy isn't reachable (e.g. opening index.html from disk),
 * callers get a rejected promise and the UI shows a friendly fallback.
 */
window.VMAP = window.VMAP || {};

VMAP.live = (function () {
  var BASE = "/api/bart";

  function getJSON(params) {
    var usp = new URLSearchParams(params).toString();
    return fetch(BASE + "?" + usp, { headers: { "Accept": "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("proxy " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        return data;
      });
  }

  function num(v) {
    if (v == null) return null;
    if (/leaving/i.test(v)) return 0;
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  // Real-time estimated departures for a station -> flat, sorted list.
  function departures(origAbbr) {
    return getJSON({ type: "etd", orig: origAbbr }).then(function (data) {
      var root = data && data.root;
      var st = root && root.station && root.station[0];
      var out = [];
      if (!st || !st.etd) return { time: root && root.time, station: st && st.name, list: out };
      st.etd.forEach(function (group) {
        (group.estimate || []).forEach(function (e) {
          out.push({
            destName: group.destination,
            destAbbr: group.abbreviation,
            minutes: num(e.minutes),
            platform: e.platform,
            direction: e.direction,        // "North" / "South"
            length: parseInt(e.length, 10) || null,
            color: e.hexcolor || null,
            colorName: (e.color || "").toUpperCase(),
            bike: e.bikeflag === "1",
            delay: parseInt(e.delay, 10) || 0
          });
        });
      });
      out.sort(function (a, b) {
        var am = a.minutes == null ? 999 : a.minutes;
        var bm = b.minutes == null ? 999 : b.minutes;
        return am - bm;
      });
      return { time: root && root.time, station: st.name, list: out };
    });
  }

  return { departures: departures, _getJSON: getJSON };
})();
