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

  // collapse/expand the trip form (From/To inputs) within the Plan view
  function setPlanCollapsed(collapsed) {
    document.getElementById("view-plan").classList.toggle("form-collapsed", collapsed);
    document.getElementById("plan-toggle").setAttribute("aria-expanded", String(!collapsed));
  }
  function updatePlanHeader() {
    var el = document.getElementById("plan-summary");
    if (view.route && view.endpoints.from && view.endpoints.to) {
      el.innerHTML =
        '<span class="sum-dot" style="background:var(--green)"></span>' + stationName(view.endpoints.from) +
        '<span class="sum-arrow">→</span>' +
        '<span class="sum-dot" style="background:var(--red)"></span>' + stationName(view.endpoints.to);
    } else {
      el.textContent = "Plan a trip";
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
    function fail(msg) { box.innerHTML = '<p class="no-route">' + msg + "</p>"; clearRouteHighlight(); setPlanCollapsed(false); updatePlanHeader(); }
    if (!f || !t) { fail("Pick a start and destination to see directions."); return; }
    if (f === t) { fail("Start and destination are the same station."); return; }
    var plan = router.plan(f, t);
    view.route = plan;
    if (!plan) { fail("No route found."); return; }
    view.routePath = plan.path;
    view.routeSet = {};
    plan.path.forEach(function (id) { view.routeSet[id] = true; });
    renderItinerary();
    fetchFirstDeparture(plan);   // live first-train, best-effort
    updatePlanHeader();
    setPlanCollapsed(true);      // fold the form away to spotlight the itinerary
  }
  function clearRouteHighlight() { view.route = view.routePath = view.routeSet = null; }
  function clearTrip() {
    view.endpoints.from = view.endpoints.to = null;
    view.firstDep = null;
    clearRouteHighlight();
    syncSelects();
    document.getElementById("itinerary").innerHTML = '<p class="no-route">Pick a start and destination to see directions.</p>';
    updatePlanHeader();
    setPlanCollapsed(false);
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
    ["plan", "lines", "detail"].forEach(function (v) {
      document.getElementById("view-" + v).hidden = (v !== name);
    });
    document.getElementById("seg").style.display = (name === "detail") ? "none" : "flex";
    if (name !== "detail") {
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

    detailBody.innerHTML =
      '<span class="insp-tag">' + (s.interchange ? "Interchange" : "Station") + "</span>" +
      '<h2 class="insp-title">' + s.name + "</h2>" +
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
        syncSelects(); planTrip();
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

  function renderVehicleInspector(vid) {
    var v = null;
    for (var i = 0; i < sim.vehicles.length; i++) if (sim.vehicles[i].id === vid) { v = sim.vehicles[i]; break; }
    if (!v) { view.selected = null; showView(lastTab); return; }
    var line = net.linesById[v.lineId];
    detailBody.innerHTML =
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
    el.textContent = ok ? "live" : "offline";
    el.title = ok ? "Real-time BART departures" : "Deploy to enable real-time data";
  }
  function probeLive() {
    VMAP.live.departures("POWL")
      .then(function () { setLiveStatus(true); })
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

  // collapse / expand the trip form
  document.getElementById("plan-toggle").addEventListener("click", function () {
    setPlanCollapsed(!document.getElementById("view-plan").classList.contains("form-collapsed"));
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
    syncSelects(); planTrip();
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

  /* ---------- main loop ---------- */
  var last = performance.now();
  var uiAccum = 0;
  function frame(now) {
    var dt = (now - last) / 1000; last = now;
    sim.update(Math.min(dt, 0.1) * state.speed);
    renderer.draw(view);
    uiAccum += dt;
    if (uiAccum > 0.25) {            // keep the live train detail fresh
      uiAccum = 0;
      if (view.selected && view.selected.type === "vehicle") renderDetail();
    }
    requestAnimationFrame(frame);
  }

  buildLegend();
  buildSelects();
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
