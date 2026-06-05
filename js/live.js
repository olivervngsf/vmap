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

  // Parse a BART ETD root into per-station departure lists.
  function parseStations(root) {
    var out = [];
    var sts = (root && root.station) || [];
    sts.forEach(function (st) {
      var list = [];
      (st.etd || []).forEach(function (group) {
        (group.estimate || []).forEach(function (e) {
          list.push({
            destName: group.destination,
            destAbbr: group.abbreviation,
            minutes: num(e.minutes),
            platform: e.platform,
            direction: e.direction,
            length: parseInt(e.length, 10) || null,
            color: e.hexcolor || null,
            colorName: (e.color || "").toUpperCase(),
            bike: e.bikeflag === "1",
            delay: parseInt(e.delay, 10) || 0
          });
        });
      });
      list.sort(function (a, b) {
        return (a.minutes == null ? 999 : a.minutes) - (b.minutes == null ? 999 : b.minutes);
      });
      out.push({ abbr: st.abbr, name: st.name, list: list });
    });
    return out;
  }

  // Real-time estimated departures for a station -> flat, sorted list.
  function departures(origAbbr) {
    return getJSON({ type: "etd", orig: origAbbr }).then(function (data) {
      var stations = parseStations(data.root);
      var st = stations[0] || { name: null, list: [] };
      return { time: data.root && data.root.time, station: st.name, list: st.list };
    });
  }

  // Real-time departures for EVERY station in one call (orig=ALL).
  function departuresAll() {
    return getJSON({ type: "etd", orig: "ALL" }).then(function (data) {
      return { time: data.root && data.root.time, stations: parseStations(data.root) };
    });
  }

  /* ---- robust accessors (BART JSON sometimes prefixes attributes with "@") ---- */
  function attr(o, name) {
    if (!o) return undefined;
    return o[name] !== undefined ? o[name] : o["@" + name];
  }
  function arr(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

  // line number ("ROUTE 6" -> "6") -> { color, name, abbr }, cached
  var _routes = null;
  function routesIndex() {
    if (_routes) return _routes;
    _routes = getJSON({ type: "routes" }).then(function (d) {
      var idx = {};
      var routes = d.root && d.root.routes;
      arr(routes && routes.route).forEach(function (r) {
        idx[String(attr(r, "number"))] = {
          color: attr(r, "hexcolor"), name: attr(r, "name"),
          abbr: attr(r, "abbr"), colorName: attr(r, "color")
        };
      });
      return idx;
    }).catch(function () { return {}; });
    return _routes;
  }

  // Trip planner: multiple real departures with times, fares and legs.
  function tripPlan(origAbbr, destAbbr) {
    return Promise.all([
      getJSON({ type: "sched", orig: origAbbr, dest: destAbbr }),
      routesIndex()
    ]).then(function (r) {
      var data = r[0], routes = r[1];
      var req = data.root && data.root.schedule && data.root.schedule.request;
      var options = arr(req && req.trip).map(function (t) {
        var legs = arr(attr(t, "leg")).map(function (l) {
          var num = (String(attr(l, "line") || "").match(/\d+/) || [])[0];
          var rt = routes[num] || {};
          var cn = rt.colorName;
          return {
            line: cn ? cn.charAt(0) + cn.slice(1).toLowerCase() + " Line" : (rt.name || "Route " + (num || "?")),
            color: rt.color || "#9aa6bd",
            origin: attr(l, "origin"),
            dest: attr(l, "destination"),
            headAbbr: attr(l, "trainHeadStation"),
            depart: attr(l, "origTimeMin"),
            arrive: attr(l, "destTimeMin"),
            bike: attr(l, "bikeflag") === "1",
            load: parseInt(attr(l, "load"), 10) || null
          };
        }).filter(function (l) { return l.origin && l.dest; });
        return {
          depart: attr(t, "origTimeMin"),
          arrive: attr(t, "destTimeMin"),
          durationMin: parseInt(attr(t, "tripTime"), 10) || null,
          fare: attr(t, "fare") || null,
          transfers: Math.max(0, legs.length - 1),
          legs: legs
        };
      }).filter(function (o) { return o.legs.length; });
      return { options: options };
    });
  }

  // Service advisories (filters out the "no delays" boilerplate).
  function advisories() {
    return getJSON({ type: "bsa" }).then(function (d) {
      var out = [];
      arr(d.root && d.root.bsa).forEach(function (b) {
        var desc = attr(b, "description");
        if (desc && typeof desc === "object") desc = desc["#cdata-section"] || desc["#text"] || "";
        desc = (desc || "").trim();
        if (desc && !/no delays/i.test(desc)) out.push(desc);
      });
      return out;
    });
  }

  return {
    departures: departures, departuresAll: departuresAll,
    tripPlan: tripPlan, advisories: advisories, routesIndex: routesIndex,
    _getJSON: getJSON
  };
})();
