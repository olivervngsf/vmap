/*
 * app.js — wires the BART network, live API, router and renderer to the DOM.
 *
 * The map (lines, stations) and the ambient train animation are schematic; the
 * **departures board** and the trip planner's first-train estimate come from
 * the real BART API via VMAP.live (the /api/bart proxy). Everything degrades
 * gracefully when the proxy isn't reachable (e.g. opening the file locally).
 */
(function () {
  var net = VMAP.network;
  var canvas = document.getElementById("map");
  var sim = new VMAP.Simulation(net);             // provides line geometry to the renderer
  var router = new VMAP.Router(net);              // offline fallback routing
  var renderer = new VMAP.Renderer(canvas, net, sim);
  renderer.fit();

  var view = {
    focusLine: null,
    hiddenLines: {},
    selected: null,                 // { type:'station', id }
    endpoints: { from: null, to: null },
    route: null, routePath: null, routeSet: null,
    firstDep: null                  // live next-train for the first leg (offline fallback)
  };
  var state = { liveEnabled: null };
  var depCache = {};                // stationId -> { state, ts, time, list, error }

  /* ---------- helpers ---------- */
  function stationName(id) { return net.stationsById[id].name; }
  function lineShort(line) { return line.colorKey.charAt(0).toUpperCase() + line.colorKey.slice(1) + " Line"; }

  // Reflect which endpoints are set on the A/B field dots (lit when chosen).
  function updateFieldDots() {
    var a = document.querySelector("#from-combo .field-dot");
    var b = document.querySelector("#to-combo .field-dot");
    if (a) a.classList.toggle("set", !!view.endpoints.from);
    if (b) b.classList.toggle("set", !!view.endpoints.to);
  }

  // An endpoint was just chosen (via search, map tap, or swap): give live map
  // feedback — drop the pin, make sure it's on screen, and draw the route when
  // both ends exist.
  function onEndpointChosen(which) {
    updateFieldDots();
    if (which && view.endpoints[which]) renderer.pingEndpoint(which);
    if (view.endpoints.from && view.endpoints.to) {
      if (isMobile()) peekSheet();     // drop the sheet so the route is visible on the map
      renderer.flyToEndpoints(view.endpoints.from, view.endpoints.to);  // zoom out to frame the trip
      planTrip();
    } else if (which && view.endpoints[which]) {
      renderer.flyToStation(net.stationsById[view.endpoints[which]]);   // zoom in on the start
    }
  }

  // index of a station within a line's ordered stop list
  function idxOnLine(line, sid) { return line.stations.indexOf(sid); }
  function terminusToward(line, boardId, alightId) {
    var bi = idxOnLine(line, boardId), ai = idxOnLine(line, alightId);
    return ai > bi ? line.stations[line.stations.length - 1] : line.stations[0];
  }
  function directionToward(boardId, alightId) {
    // BART platforms are North/South; latitude is a good proxy
    return net.stationsById[alightId].lat > net.stationsById[boardId].lat ? "North" : "South";
  }

  /* ---------- legend ---------- */
  function buildLegend() {
    var ul = document.getElementById("line-list");
    ul.innerHTML = "";
    net.lines.forEach(function (line) {
      var li = document.createElement("li");
      li.className = "line-item";
      li.dataset.line = line.id;
      li.innerHTML =
        '<span class="line-dot" style="background:' + line.color + '"></span>' +
        '<span class="line-meta"><span class="line-name">' + lineShort(line) + "</span>" +
        '<span class="line-mode">' + line.name + "</span></span>";
      li.querySelector(".line-dot").addEventListener("click", function (e) {
        e.stopPropagation();
        view.hiddenLines[line.id] = !view.hiddenLines[line.id];
        if (view.hiddenLines[line.id] && view.focusLine === line.id) view.focusLine = null;
        refreshLegend();
      });
      li.addEventListener("click", function () {
        if (view.hiddenLines[line.id]) return;
        showLineStops(line.id);
      });
      ul.appendChild(li);
    });
    refreshLegend();
  }

  // The reference "Blue line" rail: numbered stops with code badges.
  function showLineStops(lineId) {
    var line = net.linesById[lineId];
    view.focusLine = lineId; refreshLegend();
    var rows = line.stations.map(function (sid, i) {
      var s = net.stationsById[sid];
      var n = i + 1, num = (n < 10 ? "0" : "") + n;
      var others = s.codes.filter(function (c) { return c.lineId !== lineId; })
        .map(function (c) { return codeBadge(c); }).join("");
      return '<div class="line-stop" data-abbr="' + sid + '">' +
        '<span class="stop-pin" style="background:' + line.color + ";color:" + textOn(line.color) + '">' + num + "</span>" +
        '<span class="stop-name">' + s.name + "</span>" +
        '<span class="combo-badges" style="margin-left:auto">' + others + "</span></div>";
    }).join("");
    var dt = document.getElementById("line-detail");
    dt.innerHTML =
      '<div class="back-link" id="lines-back">‹ All lines</div>' +
      '<div class="line-stops-head"><span class="code-badge lg" style="background:' + line.color + ";color:" + textOn(line.color) +
        '">' + line.letter + '</span><h2 class="insp-title" style="margin:0">' + lineShort(line) + "</h2></div>" +
      '<p class="insp-sub">' + line.name + " · " + line.stations.length + " stops</p>" +
      '<div class="line-stops">' + rows + "</div>";
    document.getElementById("lines-home").hidden = true;
    dt.hidden = false;
    dt.querySelector("#lines-back").addEventListener("click", function () {
      dt.hidden = true; document.getElementById("lines-home").hidden = false;
      view.focusLine = null; refreshLegend();
    });
    dt.querySelectorAll(".line-stop").forEach(function (row) {
      row.addEventListener("click", function () { view.selected = { type: "station", id: row.dataset.abbr }; openDetail(); });
    });
  }
  function resetLinesView() {
    var dt = document.getElementById("line-detail");
    if (dt) { dt.hidden = true; }
    var home = document.getElementById("lines-home");
    if (home) home.hidden = false;
  }
  function refreshLegend() {
    document.querySelectorAll(".line-item").forEach(function (li) {
      var id = li.dataset.line;
      li.classList.toggle("focused", view.focusLine === id);
      li.classList.toggle("muted", !!view.hiddenLines[id]);
    });
  }

  // spinning "working on it" indicator
  function loadingHTML(msg) {
    return '<div class="loading-row"><span class="spinner" aria-hidden="true"></span><span>' + msg + "</span></div>";
  }

  /* ---------- code badges (the POV layer) ---------- */
  function textOn(hex) {
    var c = (hex || "#888").replace("#", "");
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var n = parseInt(c, 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#0c1422" : "#ffffff";
  }
  function codeBadge(c, big) {
    return '<span class="code-badge' + (big ? " lg" : "") + '" style="background:' + c.color +
      ";color:" + textOn(c.color) + '">' + c.code + "</span>";
  }
  function codeBadges(station, big) {
    return (station.codes || []).map(function (c) { return codeBadge(c, big); }).join("");
  }
  // single code chip for a station on a specific line (used in trip steps)
  function codeChip(lineId, abbr) {
    var map = net.codeByLineStation[lineId]; if (!map) return "";
    var code = map[abbr]; if (!code) return "";
    var color = net.linesById[lineId].color;
    return ' <span class="code-badge" style="background:' + color + ";color:" + textOn(color) + '">' + code + "</span>";
  }
  function legLineId(leg) {
    var key = String(leg.line || "").split(" ")[0].toLowerCase();
    return net.linesById[key] ? key : null;
  }

  /* ---------- type-to-search station pickers ---------- */
  var sortedStations = net.stations.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  function matchStations(q) {
    q = q.trim().toLowerCase();
    if (!q) return sortedStations;
    var starts = [], contains = [];
    sortedStations.forEach(function (s) {
      var name = s.name.toLowerCase();
      var codeHit = (s.codes || []).some(function (c) { return c.code.toLowerCase().indexOf(q) === 0; });
      if (name.indexOf(q) === 0 || codeHit) starts.push(s);
      else if (name.indexOf(q) > 0 || s.id.toLowerCase().indexOf(q) === 0) contains.push(s);
    });
    return starts.concat(contains);
  }
  function buildInputs() {
    makeCombo("from"); makeCombo("to");
  }
  function makeCombo(which) {
    var input = document.getElementById(which + "-input");
    var list = document.getElementById(which + "-list");
    var activeIdx = -1, items = [];

    function render(q) {
      items = matchStations(q).slice(0, 8);
      if (!items.length) { list.innerHTML = '<li class="combo-empty">No station found</li>'; }
      else list.innerHTML = items.map(function (s) {
        return '<li class="combo-item" data-abbr="' + s.id + '">' +
          '<span class="combo-name">' + s.name + "</span>" +
          '<span class="combo-badges">' + codeBadges(s) + "</span></li>";
      }).join("");
      activeIdx = -1;
      list.classList.remove("hidden");
    }
    function close() { list.classList.add("hidden"); }
    function choose(abbr) {
      var s = net.stationsById[abbr]; if (!s) return;
      view.endpoints[which] = abbr;
      input.value = s.name;
      close();
      onEndpointChosen(which);
    }

    input.addEventListener("focus", function () {
      if (isMobile()) expandSheet();   // lift the bottom sheet so the dropdown isn't off-screen
      render(input.value === net._nameOf(view.endpoints[which]) ? "" : input.value);
    });
    input.addEventListener("input", function () { view.endpoints[which] = null; render(input.value); });
    input.addEventListener("keydown", function (e) {
      var rows = list.querySelectorAll(".combo-item");
      if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, rows.length - 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
      else if (e.key === "Enter") { e.preventDefault(); var pick = rows[activeIdx < 0 ? 0 : activeIdx]; if (pick) choose(pick.dataset.abbr); return; }
      else if (e.key === "Escape") { close(); return; }
      else return;
      rows.forEach(function (r, i) { r.classList.toggle("active", i === activeIdx); });
      if (rows[activeIdx]) rows[activeIdx].scrollIntoView({ block: "nearest" });
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
    // mousedown (not click) so it fires before blur closes the list
    list.addEventListener("mousedown", function (e) {
      var li = e.target.closest(".combo-item"); if (!li) return;
      e.preventDefault(); choose(li.dataset.abbr);
    });
  }
  function syncInputs() {
    document.getElementById("from-input").value = net._nameOf(view.endpoints.from);
    document.getElementById("to-input").value = net._nameOf(view.endpoints.to);
  }
  net._nameOf = function (abbr) { return abbr && net.stationsById[abbr] ? net.stationsById[abbr].name : ""; };

  /* ---------- trip planning ---------- */
  function rideMinutes(step) { return Math.max(2, Math.round(step.stops * 2.1)); }
  var TRANSFER_MIN = 4;

  function itinBox() { return document.getElementById("itinerary"); }

  // Animate a freshly-established route onto the map: pins drop, line draws on,
  // camera glides to frame the whole journey.
  function revealRoute() {
    if (!view.routePath || view.routePath.length < 2) return;
    renderer.pingEndpoint("from"); renderer.pingEndpoint("to");
    renderer.animateRoute();
    renderer.flyToRoute(view.routePath);
  }

  function planTrip() {
    var f = view.endpoints.from, t = view.endpoints.to;
    view.firstDep = null; view.tripOptions = null; view.firstLegLive = null;
    function fail(msg) { itinBox().innerHTML = '<p class="no-route">' + msg + "</p>"; clearRouteHighlight(); }
    if (!f || !t) { fail("Pick a start and destination to see directions."); return; }
    if (f === t) { fail("Start and destination are the same station."); return; }
    updateFieldDots();
    itinBox().innerHTML = loadingHTML("Finding trips…");   // spinner shows immediately

    if (state.liveEnabled === false) { localPlan(f, t); return; }
    VMAP.live.tripPlan(f, t).then(function (res) {
      if (f !== view.endpoints.from || t !== view.endpoints.to) return;   // stale
      if (!res.options || !res.options.length) { localPlan(f, t); return; }
      setLiveStatus(true);
      view.tripOptions = res.options;
      view.selectedOption = 0;
      highlightOption(0, true);
      renderOptions();
      fetchFirstLegLive();
    }).catch(function () { localPlan(f, t); });
  }

  // Offline fallback: our own shortest-path over the static network.
  function localPlan(f, t) {
    var plan = router.plan(f, t);
    view.route = plan;
    if (!plan) { itinBox().innerHTML = '<p class="no-route">No route found.</p>'; clearRouteHighlight(); return; }
    view.routePath = plan.path; view.routeSet = {};
    plan.path.forEach(function (id) { view.routeSet[id] = true; });
    renderItinerary();
    revealRoute();
    fetchFirstDeparture(plan);
  }

  function clearRouteHighlight() { view.route = view.routePath = view.routeSet = null; view.tripOptions = null; }
  function clearTrip() {
    view.endpoints.from = view.endpoints.to = null;
    view.firstDep = null; view.firstLegLive = null;
    clearRouteHighlight();
    renderer.clearAnims();
    syncInputs();
    updateFieldDots();
    itinBox().innerHTML = '<p class="no-route">Pick a start and destination to see directions.</p>';
  }

  /* ---------- live multi-option results (bart.gov style + Apple-Maps steps) ---------- */
  function stopCount(aAbbr, bAbbr) {
    for (var k = 0; k < net.lines.length; k++) {
      var st = net.lines[k].stations, ia = st.indexOf(aAbbr), ib = st.indexOf(bAbbr);
      if (ia >= 0 && ib >= 0) return Math.abs(ib - ia);
    }
    return null;
  }
  function legPath(aAbbr, bAbbr) {
    for (var k = 0; k < net.lines.length; k++) {
      var st = net.lines[k].stations, ia = st.indexOf(aAbbr), ib = st.indexOf(bAbbr);
      if (ia >= 0 && ib >= 0) {
        var out = [], step = ia <= ib ? 1 : -1;
        for (var j = ia; j !== ib + step; j += step) out.push(st[j]);
        return out;
      }
    }
    return [aAbbr, bAbbr];
  }
  function optionPath(o) {
    var path = [];
    o.legs.forEach(function (l) {
      var p = legPath(l.origin, l.dest);
      if (path.length && p[0] === path[path.length - 1]) p = p.slice(1);
      path = path.concat(p);
    });
    return path;
  }
  function highlightOption(i, fly) {
    var o = view.tripOptions[i]; if (!o) return;
    var path = optionPath(o);
    view.route = { live: true }; view.routePath = path; view.routeSet = {};
    path.forEach(function (id) { view.routeSet[id] = true; });
    if (fly) revealRoute(); else renderer.animateRoute();
  }
  function nm(abbr) { var s = net.stationsById[abbr]; return s ? s.name : abbr; }

  function advisoriesHTML() {
    if (!view.advisories || !view.advisories.length) return "";
    return '<div class="alert-banner"><span class="alert-ico">⚠</span><div>' +
      view.advisories.map(function (a) { return a; }).join("<br>") + "</div></div>";
  }

  function renderOptions() {
    var opts = view.tripOptions;
    if (!opts) return;
    var html = advisoriesHTML();
    opts.forEach(function (o, i) { html += optionCardHTML(o, i, i === view.selectedOption); });
    var box = itinBox();
    box.innerHTML = html;
    box.querySelectorAll(".opt").forEach(function (el) {
      el.addEventListener("click", function () {
        var i = +el.dataset.i;
        view.selectedOption = i; view.firstLegLive = null;
        highlightOption(i, true);      // draw + frame this option on the map
        fetchFirstLegLive();
        openTripDetail(i);             // open the stop-by-stop detail
      });
    });
  }

  function optionCardHTML(o, i, selected) {
    var pips = o.legs.map(function (l) {
      return '<span class="pip" style="background:' + l.color + '"></span>';
    }).join('<span class="pip-sep"></span>');
    var sub = (o.durationMin ? o.durationMin + " min" : "") +
      " · " + o.transfers + " transfer" + (o.transfers === 1 ? "" : "s");
    return '<div class="opt' + (selected ? " selected" : "") + '" data-i="' + i + '">' +
      '<div class="opt-top"><span class="opt-time">' + o.depart + " → " + o.arrive + "</span>" +
      (o.fare ? '<span class="opt-fare">$' + o.fare + "</span>" : "") + "</div>" +
      '<div class="opt-sub"><span>' + sub + '</span><span class="opt-pips">' + pips + "</span></div>" +
      '<div class="opt-cta">View details<span class="opt-chev">›</span></div></div>';
  }

  /* ---------- trip detail (one option, every stop — Google-Maps style) ---------- */
  function parseClock(s) {           // "6:18 PM" -> minutes since midnight
    var m = /(\d+):(\d+)\s*(AM|PM)?/i.exec(s || ""); if (!m) return null;
    var h = (+m[1]) % 12, min = +m[2];
    if (m[3] && /pm/i.test(m[3])) h += 12;
    return h * 60 + min;
  }
  function fmtClock(mins) {
    mins = ((Math.round(mins) % 1440) + 1440) % 1440;
    var h = Math.floor(mins / 60), m = mins % 60, ap = h < 12 ? "AM" : "PM", h12 = h % 12 || 12;
    return h12 + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }
  function stopLabel(sid, lid) { return nm(sid) + (lid ? codeChip(lid, sid) : ""); }
  function firstLiveSub(fl) {
    if (!fl) return "";
    return (fl.platform ? '<br>Platform <b>' + fl.platform + "</b>" : "") +
      (fl.minutes != null ? (fl.platform ? " · " : "<br>") + '<span class="live">' +
        (fl.minutes === 0 ? "leaving now" : "live in " + fl.minutes + " min") + "</span>" : "");
  }
  // one timeline row: time | rail(node + line down) | name + optional sub
  function tstep(time, size, nodeColor, downColor, label, sub) {
    var node = '<span class="tstep-node' + (size === "sm" ? " sm" : "") + '" style="' +
      (size === "sm" ? "background:" + nodeColor : "border-color:" + nodeColor) + '"></span>';
    var line = '<span class="tstep-line" style="' + (downColor ? "background:" + downColor : "opacity:0") + '"></span>';
    return '<div class="tstep' + (size === "sm" ? " mid" : "") + '">' +
      '<span class="tstep-time">' + (time || "") + "</span>" +
      '<span class="tstep-rail">' + node + line + "</span>" +
      '<div class="tstep-body"><div class="tstep-name">' + label + "</div>" +
      (sub ? '<div class="tstep-sub">' + sub + "</div>" : "") + "</div></div>";
  }
  function tripDetailHTML(o) {
    var legs = o.legs, rows = "", j, k;
    for (j = 0; j < legs.length; j++) {
      var l = legs[j], lid = legLineId(l), path = legPath(l.origin, l.dest);
      var d0 = parseClock(l.depart), d1 = parseClock(l.arrive), N = path.length, nst = N - 1;
      var ride = 'Board <span class="pill" style="background:' + l.color + '">' + l.line + "</span> toward " + nm(l.headAbbr) +
        "<br>" + (nst > 0 ? nst + " stop" + (nst === 1 ? "" : "s") + " · " : "") + l.depart + " – " + l.arrive +
        (j === 0 ? firstLiveSub(view.firstLegLive) : "");
      if (j === 0) {
        rows += tstep(l.depart, "big", "var(--green)", l.color, stopLabel(l.origin, lid), ride);
      } else {                              // transfer station == prev dest == this origin
        rows += tstep(legs[j - 1].arrive, "big", l.color, l.color, stopLabel(l.origin, lid),
          '<span class="xfer">Transfer</span><br>' + ride);
      }
      for (k = 1; k < N - 1; k++) {         // intermediate stops (times interpolated across the leg)
        var t = (d0 != null && d1 != null) ? fmtClock(d0 + (d1 - d0) * k / (N - 1)) : "";
        rows += tstep(t, "sm", l.color, l.color, stopLabel(path[k], lid), "");
      }
    }
    var last = legs[legs.length - 1];
    rows += tstep(last.arrive, "big", "var(--red)", null, stopLabel(last.dest, legLineId(last)), '<span class="arrive">Arrive</span>');

    var head =
      '<div class="trip-head"><div class="trip-route">' +
        '<b>' + nm(legs[0].origin) + "</b><span class=\"trip-arrow\">→</span><b>" + nm(last.dest) + "</b></div>" +
      '<div class="trip-when">' + o.depart + " – " + o.arrive +
        (o.durationMin ? " · " + o.durationMin + " min" : "") + "</div>" +
      '<div class="trip-tags">' + (o.fare ? "$" + o.fare + " · " : "") +
        o.transfers + " transfer" + (o.transfers === 1 ? "" : "s") + "</div></div>";
    return head + advisoriesHTML() + '<div class="tsteps">' + rows + "</div>" +
      (o.fare ? '<div class="trip-cost">Cost <b>$' + o.fare + "</b></div>" : "");
  }
  function openTripDetail(i) {
    var o = view.tripOptions && view.tripOptions[i];
    if (!o) return;
    view.tripDetailOpen = i;
    document.getElementById("trip-body").innerHTML = tripDetailHTML(o);
    showView("trip");
  }

  // Real-time overlay for the first leg: platform + live minutes from ETD.
  function fetchFirstLegLive() {
    var o = view.tripOptions && view.tripOptions[view.selectedOption];
    if (!o) return;
    var leg = o.legs[0];
    VMAP.live.departures(leg.origin).then(function (res) {
      var match = null;
      res.list.forEach(function (d) {
        if (d.destAbbr === leg.headAbbr && d.minutes != null && (!match || d.minutes < match.minutes)) match = d;
      });
      view.firstLegLive = match ? { platform: match.platform, minutes: match.minutes } : null;
      if (view.tripDetailOpen != null) openTripDetail(view.tripDetailOpen);  // refresh the open detail
      else if (view.tripOptions) renderOptions();
    }).catch(function () {});
  }

  function loadAdvisories() {
    VMAP.live.advisories().then(function (list) {
      view.advisories = list;
      if (view.tripOptions) renderOptions();
    }).catch(function () {});
  }

  function fetchFirstDeparture(plan) {
    if (state.liveEnabled === false) return;
    var first = null;
    for (var i = 0; i < plan.steps.length; i++) if (plan.steps[i].type === "ride") { first = plan.steps[i]; break; }
    if (!first) return;
    var board = first.board, wantColor = first.line.colorKey.toUpperCase();
    var wantDir = directionToward(first.board, first.alight);
    VMAP.live.departures(board).then(function (res) {
      var best = null;
      res.list.forEach(function (d) {
        if (d.colorName === wantColor && d.direction === wantDir && d.minutes != null) {
          if (best == null || d.minutes < best) best = d.minutes;
        }
      });
      if (best == null) {
        // relax direction match (color only) as a fallback
        res.list.forEach(function (d) {
          if (d.colorName === wantColor && d.minutes != null && (best == null || d.minutes < best)) best = d.minutes;
        });
      }
      if (best != null && view.route === plan) { view.firstDep = best; renderItinerary(); }
    }).catch(function () {});
  }

  function renderItinerary() {
    var plan = view.route;
    if (!plan) return;
    var box = document.getElementById("itinerary");
    var rides = plan.steps.filter(function (s) { return s.type === "ride"; });
    var total = rides.reduce(function (a, s) { return a + rideMinutes(s); }, 0) + plan.transfers * TRANSFER_MIN;

    var html = '<div class="itin-summary"><b>~' + total + ' min</b>' +
      '<span>' + rides.length + ' ' + (rides.length === 1 ? "ride" : "rides") + ' · ' +
      plan.transfers + ' transfer' + (plan.transfers === 1 ? "" : "s") + '</span></div>';

    html += stepHTML("#5ad17a", "Start", "<b>" + stationName(plan.path[0]) + "</b>", "#5ad17a", false);

    var firstRideSeen = false;
    plan.steps.forEach(function (step) {
      if (step.type === "ride") {
        var line = step.line;
        var toward = stationName(terminusToward(line, step.board, step.alight));
        var live = "";
        if (!firstRideSeen && view.firstDep != null) {
          live = ' · <span class="live">next train ' + (view.firstDep === 0 ? "now" : view.firstDep + " min") + "</span>";
        }
        firstRideSeen = true;
        var action =
          'Board <span class="pill" style="background:' + line.color + '">' + lineShort(line) + "</span> " +
          "toward " + toward + "<br>ride " + step.stops + " stop" + (step.stops === 1 ? "" : "s") +
          " · ~" + rideMinutes(step) + " min" + live +
          '<br><span class="step-alight">↓ get off at <b>' + stationName(step.alight) + "</b></span>";
        html += stepHTML(line.color, stationName(step.board), action, line.color, false);
      } else {
        var note = "Transfer at <b>" + stationName(step.station) + "</b><br>" +
          lineShort(step.fromLine) + " → " + lineShort(step.toLine) +
          ' <span class="transfer-note">(~' + TRANSFER_MIN + " min change)</span>";
        html += stepHTML("#ffce54", stationName(step.station), note, "#9aa6bd", false);
      }
    });

    html += stepHTML("#ff6b6b", "Arrive", "<b>" + stationName(plan.path[plan.path.length - 1]) + "</b>", "#ff6b6b", true);
    box.innerHTML = html;
  }

  function stepHTML(nodeColor, station, action, lineColor, last) {
    var rail = '<div class="step-rail">' +
      '<div class="step-node" style="background:' + nodeColor + '"></div>' +
      (last ? "" : '<div class="step-line" style="background:' + lineColor + '"></div>') + "</div>";
    var body = '<div class="step-body"><div class="step-station">' + station + "</div>" +
      '<div class="step-action">' + action + "</div></div>";
    return '<div class="step">' + rail + body + "</div>";
  }

  /* ---------- panel views (Plan / Lines / Detail) ---------- */
  var body = document.body;
  var panel = document.getElementById("panel");
  var detailBody = document.getElementById("detail-body");
  var lastTab = "plan";
  function isMobile() { return window.matchMedia("(max-width: 880px)").matches; }
  function expandSheet() { if (isMobile()) body.classList.add("sheet-expanded"); }
  function peekSheet() { body.classList.remove("sheet-expanded"); }

  function showView(name) {
    ["plan", "lines", "detail", "trip"].forEach(function (v) {
      document.getElementById("view-" + v).hidden = (v !== name);
    });
    if (name === "lines") resetLinesView();
    if (name !== "trip") view.tripDetailOpen = null;
    var chrome = (name === "detail" || name === "trip");
    document.getElementById("seg").style.display = chrome ? "none" : "flex";
    if (!chrome) {
      lastTab = name;
      document.querySelectorAll(".seg-btn").forEach(function (b) {
        b.classList.toggle("active", b.dataset.tab === name);
      });
    }
    panel.scrollTop = 0;
  }

  function openDetail() {
    if (!view.selected) { showView(lastTab); return; }
    if (view.selected.type === "station") loadDepartures(view.selected.id, true);
    renderDetail();
    showView("detail");
    expandSheet();
  }
  function renderDetail() {
    if (view.selected && view.selected.type === "station") renderStationInspector(view.selected.id);
  }

  // fetch real-time departures into the cache (throttled), then re-render
  function loadDepartures(id, force) {
    if (state.liveEnabled === false) {
      depCache[id] = { state: "disabled" };
      if (sel("station", id)) renderStationInspector(id);
      return;
    }
    var c = depCache[id];
    if (!force && c && c.state === "ok" && Date.now() - c.ts < 15000) { return; }
    depCache[id] = { state: "loading", prev: c && c.list, ts: Date.now() };
    if (sel("station", id)) renderStationInspector(id);
    VMAP.live.departures(id).then(function (res) {
      depCache[id] = { state: "ok", ts: Date.now(), time: res.time, list: res.list, station: res.station };
      if (sel("station", id)) renderStationInspector(id);
      setLiveStatus(true);
    }).catch(function (err) {
      depCache[id] = { state: "error", ts: Date.now(), error: String(err && err.message || err) };
      if (sel("station", id)) renderStationInspector(id);
      setLiveStatus(false);
    });
  }
  function sel(type, id) { return view.selected && view.selected.type === type && view.selected.id === id; }

  function renderStationInspector(id) {
    var s = net.stationsById[id];
    var chips = s.lines.map(function (lid) {
      var l = net.linesById[lid];
      return '<span class="chip" style="background:' + l.color + '">' + lineShort(l) + "</span>";
    }).join("");
    var fromActive = view.endpoints.from === id ? " active" : "";
    var toActive = view.endpoints.to === id ? " active" : "";

    var c = depCache[id] || { state: "loading" };
    var depHTML;
    if (c.state === "disabled") {
      depHTML = '<div class="schematic-note">Live departures come from the BART API and work on the deployed site. ' +
        "Open the Vercel URL to see real-time trains.</div>";
    } else if (c.state === "error") {
      depHTML = '<p class="loading">Couldn\'t reach the BART API right now. Retrying…</p>';
    } else if (c.state === "loading" && !(c.prev && c.prev.length)) {
      depHTML = '<p class="loading">Loading live departures…</p>';
    } else {
      var list = (c.state === "ok" ? c.list : c.prev) || [];
      if (!list.length) depHTML = '<p class="loading">No trains scheduled right now.</p>';
      else depHTML = list.slice(0, 8).map(depRow).join("") +
        (c.time ? '<div class="dep-updated">BART time: ' + c.time + "</div>" : "");
    }

    detailBody.innerHTML =
      '<span class="insp-tag">' + (s.interchange ? "Interchange" : "Station") + "</span>" +
      '<h2 class="insp-title">' + s.name + "</h2>" +
      '<div class="chips" style="margin-bottom:6px">' + codeBadges(s, true) + "</div>" +
      '<p class="insp-sub">' + s.lines.length + " line" + (s.lines.length === 1 ? "" : "s") + " · " + id + "</p>" +
      '<div class="chips">' + chips + "</div>" +
      '<div class="insp-actions">' +
      '<button class="mini-btn' + fromActive + '" data-set="from">Set as start</button>' +
      '<button class="mini-btn' + toActive + '" data-set="to">Set as destination</button></div>' +
      '<div class="section-h">Live departures</div>' + depHTML;

    detailBody.querySelectorAll("[data-set]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var which = btn.dataset.set;
        view.endpoints[which] = id;
        if (which === "from" && view.endpoints.to === id) view.endpoints.to = null;
        if (which === "to" && view.endpoints.from === id) view.endpoints.from = null;
        syncInputs(); onEndpointChosen(which);
        // once both ends are chosen, jump to the Plan view to show directions
        if (view.endpoints.from && view.endpoints.to) { view.selected = null; showView("plan"); expandSheet(); }
        else renderStationInspector(id);
      });
    });
  }

  function depRow(d) {
    var mins = d.minutes === 0 ? '<span class="dep-min now">Now</span>'
      : '<span class="dep-min">' + d.minutes + '<small> min</small></span>';
    var meta = (d.direction || "") + (d.platform ? " · plat " + d.platform : "") +
      (d.length ? " · " + d.length + "-car" : "") + (d.bike ? " · 🚲" : "");
    var late = d.delay > 60 ? ' <span class="late">delayed</span>' : "";
    return '<div class="dep">' +
      '<span class="dep-bullet" style="background:' + (d.color || "#888") + '"></span>' +
      '<span class="dep-main"><span class="dep-dest">' + d.destName + "</span>" +
      '<span class="dep-meta">' + meta + late + "</span></span>" + mins + "</div>";
  }

  /* ---------- live status ---------- */
  function setLiveStatus(ok) {
    state.liveEnabled = ok;
    var el = document.getElementById("live-status");
    el.classList.toggle("ok", ok);
    el.classList.toggle("off", !ok);
    el.textContent = ok ? "live" : "offline";
    el.title = ok ? "Real-time BART data" : "Deploy to enable real-time data";
  }
  function probeLive() {
    VMAP.live.departures("POWL")
      .then(function () { setLiveStatus(true); loadAdvisories(); })
      .catch(function () { setLiveStatus(false); });
  }

  /* ---------- pointer input (mouse drag + touch pan/pinch) ---------- */
  var pointers = new Map();   // pointerId -> {x,y}
  var drag = null;            // single-pointer pan/tap tracker
  var pinchPrev = null;       // {dist, cx, cy} for two-finger gesture

  function pinchState() {
    var it = pointers.values(), a = it.next().value, b = it.next().value;
    var dx = a.x - b.x, dy = a.y - b.y;
    return { dist: Math.hypot(dx, dy), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
  canvas.addEventListener("pointerdown", function (e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: 0 };
    else if (pointers.size === 2) { drag = null; pinchPrev = pinchState(); }
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    var rect = canvas.getBoundingClientRect();
    if (pointers.size >= 2) {
      var ps = pinchState();
      if (pinchPrev) {
        renderer.panBy(ps.cx - pinchPrev.cx, ps.cy - pinchPrev.cy);   // two-finger pan
        renderer.zoomAt(ps.cx - rect.left, ps.cy - rect.top, ps.dist / (pinchPrev.dist || ps.dist));
      }
      pinchPrev = ps;
    } else if (drag) {
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      renderer.panBy(dx, dy); drag.x = e.clientX; drag.y = e.clientY;
    }
  });
  function endPointer(e) {
    var wasTap = drag && drag.moved < 6 && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchPrev = null;
    if (pointers.size === 0) {
      canvas.classList.remove("dragging");
      if (wasTap) handleClick(e);
      drag = null;
    } else if (pointers.size === 1) {
      var it = pointers.values().next().value;   // resume panning with remaining finger
      drag = { x: it.x, y: it.y, moved: 999 };
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 0.89);
  }, { passive: false });

  function handleClick(e) {
    var rect = canvas.getBoundingClientRect();
    var hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top, view);
    if (hit) { view.selected = hit; openDetail(); }
    else { view.selected = null; showView(lastTab); peekSheet(); }
  }

  /* ---------- panel chrome: tabs, collapse, mobile sheet ---------- */
  document.querySelectorAll(".seg-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      view.selected = null;
      showView(b.dataset.tab);
      expandSheet();
    });
  });
  document.getElementById("detail-back").addEventListener("click", function () {
    view.selected = null; showView(lastTab);
  });
  document.getElementById("trip-back").addEventListener("click", function () {
    showView("plan");                 // back to the options list (still rendered)
  });

  // desktop collapse / reopen
  var reopen = document.getElementById("panel-reopen");
  document.getElementById("panel-collapse").addEventListener("click", function () {
    panel.classList.add("collapsed"); reopen.classList.remove("hidden");
  });
  reopen.addEventListener("click", function () {
    panel.classList.remove("collapsed"); reopen.classList.add("hidden");
  });

  // mobile sheet: drag (or tap) the grip to expand / collapse
  var grip = document.getElementById("grip");
  var gripY = null;
  grip.addEventListener("pointerdown", function (e) {
    gripY = e.clientY; try { grip.setPointerCapture(e.pointerId); } catch (_) {}
  });
  grip.addEventListener("pointerup", function (e) {
    if (gripY == null) return;
    var dy = e.clientY - gripY; gripY = null;
    if (dy < -24) body.classList.add("sheet-expanded");
    else if (dy > 24) body.classList.remove("sheet-expanded");
    else body.classList.toggle("sheet-expanded");
  });

  // floating map controls
  document.getElementById("mc-zoom-in").addEventListener("click", function () { renderer.zoomAt(renderer.w / 2, renderer.h / 2, 1.25); });
  document.getElementById("mc-zoom-out").addEventListener("click", function () { renderer.zoomAt(renderer.w / 2, renderer.h / 2, 0.8); });
  document.getElementById("mc-reset").addEventListener("click", function () { renderer.fit(); });

  // planner buttons
  document.getElementById("btn-route").addEventListener("click", planTrip);
  document.getElementById("btn-clear-route").addEventListener("click", clearTrip);
  document.getElementById("btn-swap").addEventListener("click", function () {
    var f = view.endpoints.from; view.endpoints.from = view.endpoints.to; view.endpoints.to = f;
    var sw = document.getElementById("btn-swap");
    sw.classList.remove("spin"); void sw.offsetWidth; sw.classList.add("spin");  // replay spin
    syncInputs(); updateFieldDots();
    if (view.endpoints.from && view.endpoints.to) planTrip();
  });

  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    switch (e.key) {
      case "+": case "=": renderer.zoomAt(renderer.w / 2, renderer.h / 2, 1.2); break;
      case "-": renderer.zoomAt(renderer.w / 2, renderer.h / 2, 0.83); break;
      case "r": case "R": renderer.fit(); break;
      case "ArrowLeft": renderer.panBy(60, 0); break;
      case "ArrowRight": renderer.panBy(-60, 0); break;
      case "ArrowUp": renderer.panBy(0, 60); break;
      case "ArrowDown": renderer.panBy(0, -60); break;
      case "Escape": view.selected = null; showView(lastTab); break;
    }
  });
  window.addEventListener("resize", function () { renderer.resize(); });

  document.getElementById("stat-stations").textContent = net.stations.length;

  /* ---------- render loop (static map; redraws for pan/zoom) ---------- */
  function frame() { renderer.draw(view); requestAnimationFrame(frame); }

  buildLegend();
  buildInputs();
  clearTrip();
  showView("plan");
  probeLive();
  // refresh the open station's live board periodically
  setInterval(function () {
    if (view.selected && view.selected.type === "station" && state.liveEnabled !== false) {
      loadDepartures(view.selected.id, true);
    }
  }, 20000);
  requestAnimationFrame(frame);
})();
