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
  var sim = new VMAP.Simulation(net);
  var router = new VMAP.Router(net);
  var renderer = new VMAP.Renderer(canvas, net, sim);
  renderer.fit();

  var view = {
    focusLine: null,
    hiddenLines: {},
    selected: null,                 // { type:'station'|'vehicle', id }
    endpoints: { from: null, to: null },
    route: null, routePath: null, routeSet: null,
    firstDep: null                  // live next-train for the first leg
  };
  var state = { paused: false, speed: 5, liveEnabled: null };
  var depCache = {};                // stationId -> { state, ts, time, list, error }

  /* ---------- helpers ---------- */
  function stationName(id) { return net.stationsById[id].name; }
  function lineShort(line) { return line.colorKey.charAt(0).toUpperCase() + line.colorKey.slice(1) + " Line"; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function localClock() { var d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }

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
        view.focusLine = view.focusLine === line.id ? null : line.id;
        refreshLegend();
      });
      ul.appendChild(li);
    });
    refreshLegend();
  }
  function refreshLegend() {
    document.querySelectorAll(".line-item").forEach(function (li) {
      var id = li.dataset.line;
      li.classList.toggle("focused", view.focusLine === id);
      li.classList.toggle("muted", !!view.hiddenLines[id]);
    });
  }

  /* ---------- planner selects ---------- */
  function buildSelects() {
    var sorted = net.stations.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    ["from-select", "to-select"].forEach(function (selId) {
      var sel = document.getElementById(selId);
      sorted.forEach(function (s) {
        var o = document.createElement("option");
        o.value = s.id; o.textContent = s.name;
        sel.appendChild(o);
      });
    });
    document.getElementById("from-select").addEventListener("change", function (e) { view.endpoints.from = e.target.value || null; });
    document.getElementById("to-select").addEventListener("change", function (e) { view.endpoints.to = e.target.value || null; });
  }
  function syncSelects() {
    document.getElementById("from-select").value = view.endpoints.from || "";
    document.getElementById("to-select").value = view.endpoints.to || "";
  }

  /* ---------- trip planning ---------- */
  function rideMinutes(step) { return Math.max(2, Math.round(step.stops * 2.1)); }
  var TRANSFER_MIN = 4;

  function planTrip() {
    var f = view.endpoints.from, t = view.endpoints.to;
    var box = document.getElementById("itinerary");
    view.firstDep = null;
    if (!f || !t) { box.innerHTML = '<p class="no-route">Pick a start and destination to see directions.</p>'; clearRouteHighlight(); return; }
    if (f === t) { box.innerHTML = '<p class="no-route">Start and destination are the same station.</p>'; clearRouteHighlight(); return; }
    var plan = router.plan(f, t);
    view.route = plan;
    if (!plan) { box.innerHTML = '<p class="no-route">No route found.</p>'; clearRouteHighlight(); return; }
    view.routePath = plan.path;
    view.routeSet = {};
    plan.path.forEach(function (id) { view.routeSet[id] = true; });
    renderItinerary();
    fetchFirstDeparture(plan);   // live first-train, best-effort
  }
  function clearRouteHighlight() { view.route = view.routePath = view.routeSet = null; }
  function clearTrip() {
    view.endpoints.from = view.endpoints.to = null;
    view.firstDep = null;
    clearRouteHighlight();
    syncSelects();
    document.getElementById("itinerary").innerHTML = '<p class="no-route">Pick a start and destination to see directions.</p>';
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

  /* ---------- inspector ---------- */
  var inspector = document.getElementById("inspector");
  var inspBody = document.getElementById("inspector-body");

  function openInspector() {
    if (!view.selected) { inspector.classList.add("hidden"); return; }
    inspector.classList.remove("hidden");
    if (view.selected.type === "station") loadDepartures(view.selected.id, true);
    renderInspector();
  }
  document.getElementById("inspector-close").addEventListener("click", function () {
    view.selected = null; inspector.classList.add("hidden");
  });

  function renderInspector() {
    if (!view.selected) return;
    if (view.selected.type === "station") renderStationInspector(view.selected.id);
    else renderVehicleInspector(view.selected.id);
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

    inspBody.innerHTML =
      '<span class="insp-tag">' + (s.interchange ? "Interchange" : "Station") + "</span>" +
      '<h2 class="insp-title">' + s.name + "</h2>" +
      '<p class="insp-sub">' + s.lines.length + " line" + (s.lines.length === 1 ? "" : "s") + " · " + id + "</p>" +
      '<div class="chips">' + chips + "</div>" +
      '<div class="insp-actions">' +
      '<button class="mini-btn' + fromActive + '" data-set="from">Set as start</button>' +
      '<button class="mini-btn' + toActive + '" data-set="to">Set as destination</button></div>' +
      '<div class="section-h">Live departures</div>' + depHTML;

    inspBody.querySelectorAll("[data-set]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var which = btn.dataset.set;
        view.endpoints[which] = id;
        if (which === "from" && view.endpoints.to === id) view.endpoints.to = null;
        if (which === "to" && view.endpoints.from === id) view.endpoints.from = null;
        syncSelects(); planTrip(); renderStationInspector(id);
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

  function renderVehicleInspector(vid) {
    var v = null;
    for (var i = 0; i < sim.vehicles.length; i++) if (sim.vehicles[i].id === vid) { v = sim.vehicles[i]; break; }
    if (!v) { inspector.classList.add("hidden"); view.selected = null; return; }
    var line = net.linesById[v.lineId];
    inspBody.innerHTML =
      '<span class="insp-tag">Train · schematic</span>' +
      '<h2 class="insp-title">' + lineShort(line) + "</h2>" +
      '<p class="insp-sub">' + line.name + "</p>" +
      '<div class="chips"><span class="chip" style="background:' + line.color + '">toward ' + sim.headsign(v) + "</span></div>" +
      '<div class="section-h">Heading to</div>' +
      '<p style="font-size:14px;font-weight:600;margin:0 0 10px;">' + stationName(sim.nextStop(v)) + "</p>" +
      '<div class="schematic-note">Train positions here are a schematic animation — BART\'s public API doesn\'t broadcast live train locations. ' +
      "For real-time predictions, click a <b>station</b> to see its live departures board.</div>";
  }

  /* ---------- live status ---------- */
  function setLiveStatus(ok) {
    state.liveEnabled = ok;
    var el = document.getElementById("live-status");
    el.classList.toggle("ok", ok);
    el.classList.toggle("off", !ok);
    el.textContent = ok ? "live: BART API" : "live: offline";
    el.title = ok ? "Real-time departures are live" : "Deploy to Vercel to enable real-time data";
  }
  function probeLive() {
    VMAP.live.departures("POWL")
      .then(function () { setLiveStatus(true); })
      .catch(function () { setLiveStatus(false); });
  }

  /* ---------- pointer input ---------- */
  var drag = null;
  canvas.addEventListener("pointerdown", function (e) {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId); canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    renderer.panBy(dx, dy); drag.x = e.clientX; drag.y = e.clientY;
  });
  canvas.addEventListener("pointerup", function (e) {
    canvas.classList.remove("dragging");
    if (drag && drag.moved < 6) handleClick(e);
    drag = null;
  });
  canvas.addEventListener("pointercancel", function () { drag = null; canvas.classList.remove("dragging"); });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 0.89);
  }, { passive: false });

  function handleClick(e) {
    var rect = canvas.getBoundingClientRect();
    var hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top, view);
    if (hit) { view.selected = hit; openInspector(); }
    else { view.selected = null; inspector.classList.add("hidden"); }
  }

  /* ---------- controls ---------- */
  var playBtn = document.getElementById("btn-play");
  playBtn.addEventListener("click", togglePlay);
  function togglePlay() { state.paused = !state.paused; playBtn.textContent = state.paused ? "▶" : "⏸"; }
  var speed = document.getElementById("speed"), speedVal = document.getElementById("speed-val");
  speed.addEventListener("input", function () { state.speed = parseInt(speed.value, 10); speedVal.textContent = state.speed + "×"; });
  document.getElementById("btn-zoom-in").addEventListener("click", function () { renderer.zoomAt(renderer.w / 2, renderer.h / 2, 1.2); });
  document.getElementById("btn-zoom-out").addEventListener("click", function () { renderer.zoomAt(renderer.w / 2, renderer.h / 2, 0.83); });
  document.getElementById("btn-reset").addEventListener("click", function () { renderer.fit(); });
  document.getElementById("btn-route").addEventListener("click", planTrip);
  document.getElementById("btn-clear-route").addEventListener("click", clearTrip);
  document.getElementById("btn-swap").addEventListener("click", function () {
    var f = view.endpoints.from; view.endpoints.from = view.endpoints.to; view.endpoints.to = f;
    syncSelects(); planTrip();
  });
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    switch (e.key) {
      case " ": e.preventDefault(); togglePlay(); break;
      case "+": case "=": renderer.zoomAt(renderer.w / 2, renderer.h / 2, 1.2); break;
      case "-": renderer.zoomAt(renderer.w / 2, renderer.h / 2, 0.83); break;
      case "r": case "R": renderer.fit(); break;
      case "ArrowLeft": renderer.panBy(60, 0); break;
      case "ArrowRight": renderer.panBy(-60, 0); break;
      case "ArrowUp": renderer.panBy(0, 60); break;
      case "ArrowDown": renderer.panBy(0, -60); break;
    }
  });
  window.addEventListener("resize", function () { renderer.resize(); });

  /* ---------- attribution ---------- */
  var attr = document.createElement("div");
  attr.className = "attribution";
  attr.innerHTML = 'Real-time data: <a href="https://api.bart.gov" target="_blank" rel="noopener">BART API</a> · map is schematic';
  document.body.appendChild(attr);

  document.getElementById("stat-stations").textContent = net.stations.length;

  /* ---------- main loop ---------- */
  var last = performance.now();
  var uiAccum = 0;
  function frame(now) {
    var dt = (now - last) / 1000; last = now;
    if (!state.paused) sim.update(Math.min(dt, 0.1) * state.speed);
    renderer.draw(view);
    document.getElementById("clock").textContent = localClock();
    uiAccum += dt;
    if (uiAccum > 0.25) {
      uiAccum = 0;
      if (view.selected && view.selected.type === "vehicle") renderInspector();
    }
    requestAnimationFrame(frame);
  }

  buildLegend();
  buildSelects();
  clearTrip();
  probeLive();
  // refresh the open station's live board periodically
  setInterval(function () {
    if (view.selected && view.selected.type === "station" && state.liveEnabled !== false) {
      loadDepartures(view.selected.id, true);
    }
  }, 20000);
  requestAnimationFrame(frame);
})();
