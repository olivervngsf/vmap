/*
 * app.js — wires the simulation, router and renderer to the DOM.
 *
 * Responsibilities: build the UI (legend, planner), handle pan/zoom/click,
 * run the animation loop, and keep the inspector + itinerary panels live.
 */
(function () {
  var net = VMAP.network;
  var canvas = document.getElementById("map");
  var sim = new VMAP.Simulation(net);
  var router = new VMAP.Router(net);
  var renderer = new VMAP.Renderer(canvas, net, sim);
  renderer.fit();

  // --- view / interaction state ---
  var view = {
    focusLine: null,
    hiddenLines: {},
    selected: null,        // { type:'station'|'vehicle', id }
    endpoints: { from: null, to: null },
    route: null,           // router.plan result
    routePath: null,
    routeSet: null
  };
  var state = { paused: false, speed: 4 };

  /* ---------------- helpers ---------------- */
  function stationName(id) { return net.stationsById[id].name; }

  // Countdown style: "Due" / "1:23"
  function fmtCountdown(sec) {
    if (sec <= 4) return "Due";
    var s = Math.round(sec);
    var m = Math.floor(s / 60);
    return m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }
  // Friendlier duration for itinerary ("~2:10")
  function fmtDur(sec) {
    var s = Math.round(sec);
    var m = Math.floor(s / 60);
    return m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  /* ---------------- legend ---------------- */
  function buildLegend() {
    var ul = document.getElementById("line-list");
    ul.innerHTML = "";
    net.lines.forEach(function (line) {
      var li = document.createElement("li");
      li.className = "line-item";
      li.dataset.line = line.id;
      li.innerHTML =
        '<span class="line-dot" style="background:' + line.color + '"></span>' +
        '<span class="line-meta"><span class="line-name">' + line.name + "</span>" +
        '<span class="line-mode">' + line.mode + "</span></span>";

      // dot toggles visibility; rest toggles focus
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

  /* ---------------- planner selects ---------------- */
  function buildSelects() {
    var sorted = net.stations.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    ["from-select", "to-select"].forEach(function (selId) {
      var sel = document.getElementById(selId);
      sorted.forEach(function (s) {
        var o = document.createElement("option");
        o.value = s.id; o.textContent = s.name;
        sel.appendChild(o);
      });
    });
    document.getElementById("from-select").addEventListener("change", function (e) {
      view.endpoints.from = e.target.value || null;
    });
    document.getElementById("to-select").addEventListener("change", function (e) {
      view.endpoints.to = e.target.value || null;
    });
  }
  function syncSelects() {
    document.getElementById("from-select").value = view.endpoints.from || "";
    document.getElementById("to-select").value = view.endpoints.to || "";
  }

  /* ---------------- trip planning ---------------- */
  function planTrip() {
    var f = view.endpoints.from, t = view.endpoints.to;
    var box = document.getElementById("itinerary");
    if (!f || !t) {
      box.innerHTML = '<p class="no-route">Pick a start and destination to see directions.</p>';
      view.route = view.routePath = view.routeSet = null;
      return;
    }
    if (f === t) {
      box.innerHTML = '<p class="no-route">Start and destination are the same station.</p>';
      view.route = view.routePath = view.routeSet = null;
      return;
    }
    var plan = router.plan(f, t);
    view.route = plan;
    if (!plan) {
      box.innerHTML = '<p class="no-route">No route found.</p>';
      view.routePath = view.routeSet = null;
      return;
    }
    view.routePath = plan.path;
    view.routeSet = {};
    plan.path.forEach(function (id) { view.routeSet[id] = true; });
    renderItinerary();
  }

  function clearTrip() {
    view.endpoints.from = view.endpoints.to = null;
    view.route = view.routePath = view.routeSet = null;
    syncSelects();
    document.getElementById("itinerary").innerHTML =
      '<p class="no-route">Pick a start and destination to see directions.</p>';
  }

  // Re-render the itinerary; called on plan + periodically for live departures.
  function renderItinerary() {
    var plan = view.route;
    if (!plan) return;
    var box = document.getElementById("itinerary");
    var rideCount = plan.steps.filter(function (s) { return s.type === "ride"; }).length;

    var html = '<div class="itin-summary"><b>' + fmtDur(plan.totalTime) + '</b>' +
      '<span>' + rideCount + ' ' + (rideCount === 1 ? "ride" : "rides") + ' · ' +
      plan.transfers + ' transfer' + (plan.transfers === 1 ? "" : "s") + '</span></div>';

    // Start node
    html += stepHTML("#5ad17a", "Start", "<b>" + stationName(plan.path[0]) + "</b>", "#5ad17a", true);

    plan.steps.forEach(function (step) {
      if (step.type === "ride") {
        var line = step.line;
        var dep = sim.nextDeparture(line.id, step.board, step.alight);
        var depTxt = dep === null ? "" :
          ' · <span class="live">departs ' + fmtCountdown(dep) + "</span>";
        var action =
          'Board <span class="pill" style="background:' + line.color + '">' + line.name + "</span><br>" +
          "ride " + step.stops + " stop" + (step.stops === 1 ? "" : "s") +
          " (~" + fmtDur(step.time) + ")" + depTxt;
        html += stepHTML(line.color,
          stationName(step.board), action, line.color, false);
      } else if (step.type === "transfer") {
        var note = "Transfer at <b>" + stationName(step.station) + "</b><br>" +
          step.fromLine.name + " → " + step.toLine.name +
          ' <span class="transfer-note">(~' + fmtDur(VMAP.Router.TRANSFER_TIME) + " change)</span>";
        html += stepHTML("#ffce54", stationName(step.station), note, "#9aa6bd", false);
      }
    });

    // Arrive node
    html += stepHTML("#ff6b6b", "Arrive", "<b>" + stationName(plan.path[plan.path.length - 1]) + "</b>", "#ff6b6b", true, true);
    box.innerHTML = html;
  }

  function stepHTML(nodeColor, station, action, lineColor, isEnd, last) {
    var rail = '<div class="step-rail">' +
      '<div class="step-node" style="background:' + nodeColor + '"></div>' +
      (last ? "" : '<div class="step-line" style="background:' + lineColor + '"></div>') +
      "</div>";
    var body = '<div class="step-body">' +
      '<div class="step-station">' + station + "</div>" +
      '<div class="step-action">' + action + "</div></div>";
    return '<div class="step">' + rail + body + "</div>";
  }

  /* ---------------- inspector ---------------- */
  var inspector = document.getElementById("inspector");
  var inspBody = document.getElementById("inspector-body");

  function openInspector() {
    if (!view.selected) { inspector.classList.add("hidden"); return; }
    inspector.classList.remove("hidden");
    renderInspector();
  }
  document.getElementById("inspector-close").addEventListener("click", function () {
    view.selected = null;
    inspector.classList.add("hidden");
  });

  function renderInspector() {
    if (!view.selected) return;
    if (view.selected.type === "station") renderStationInspector(view.selected.id);
    else renderVehicleInspector(view.selected.id);
  }

  function renderStationInspector(id) {
    var s = net.stationsById[id];
    var chips = s.lines.map(function (lid) {
      var l = net.linesById[lid];
      return '<span class="chip" style="background:' + l.color + '">' + l.name + "</span>";
    }).join("");

    var arr = sim.arrivalsFor(id).slice(0, 6);
    var arrHTML = arr.length ? arr.map(function (a) {
      var eta = fmtCountdown(a.eta);
      var cls = a.eta <= 4 ? "now" : (a.eta <= 30 ? "soon" : "");
      return '<div class="arrival">' +
        '<span class="arr-bullet" style="background:' + a.color + '"></span>' +
        '<span class="arr-dest">' + a.lineName +
        "<small>to " + a.destination + "</small></span>" +
        '<span class="arr-eta ' + cls + '">' + eta + "</span></div>";
    }).join("") : '<p class="no-route">No trains inbound right now…</p>';

    var fromActive = view.endpoints.from === id ? " active" : "";
    var toActive = view.endpoints.to === id ? " active" : "";

    inspBody.innerHTML =
      '<span class="insp-tag">' + (s.interchange ? "Interchange" : "Station") + "</span>" +
      '<h2 class="insp-title">' + s.name + "</h2>" +
      '<p class="insp-sub">' + s.lines.length + " line" + (s.lines.length === 1 ? "" : "s") + " served</p>" +
      '<div class="chips">' + chips + "</div>" +
      '<div class="insp-actions">' +
      '<button class="mini-btn' + fromActive + '" data-set="from">Set as start</button>' +
      '<button class="mini-btn' + toActive + '" data-set="to">Set as destination</button>' +
      "</div>" +
      '<div class="section-h">Live arrivals</div>' + arrHTML;

    inspBody.querySelectorAll("[data-set]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var which = btn.dataset.set;
        view.endpoints[which] = id;
        if (which === "from" && view.endpoints.to === id) view.endpoints.to = null;
        if (which === "to" && view.endpoints.from === id) view.endpoints.from = null;
        syncSelects();
        planTrip();
        renderStationInspector(id);
      });
    });
  }

  // stable pseudo-random occupancy per vehicle
  function occupancy(vid) {
    var h = 0;
    for (var i = 0; i < vid.length; i++) h = (h * 31 + vid.charCodeAt(i)) % 1000;
    var pct = 25 + (h % 70);
    var label = pct < 45 ? "Light" : pct < 75 ? "Moderate" : "Busy";
    return { pct: pct, label: label };
  }

  function renderVehicleInspector(vid) {
    var v = null;
    for (var i = 0; i < sim.vehicles.length; i++) if (sim.vehicles[i].id === vid) { v = sim.vehicles[i]; break; }
    if (!v) { inspector.classList.add("hidden"); view.selected = null; return; }
    var line = net.linesById[v.lineId];
    var nextId = sim.nextStop(v);
    var occ = occupancy(vid);
    var status = (v.dwell > 0 && v.atStation)
      ? "Stopped at <b>" + stationName(v.atStation) + "</b>"
      : "En route to <b>" + stationName(nextId) + "</b>";

    inspBody.innerHTML =
      '<span class="insp-tag">Vehicle · ' + line.mode + "</span>" +
      '<h2 class="insp-title">' + line.name + "</h2>" +
      '<p class="insp-sub">Service ' + vid.toUpperCase() + "</p>" +
      '<div class="chips"><span class="chip" style="background:' + line.color + '">' +
        sim.headsign(v) + "</span></div>" +
      '<div class="section-h">Status</div>' +
      '<p style="font-size:13px;margin:0 0 10px;">' + status + "</p>" +
      '<div class="section-h">Next stop</div>' +
      '<p style="font-size:14px;font-weight:600;margin:0 0 12px;">' + stationName(nextId) + "</p>" +
      '<div class="section-h">Occupancy</div>' +
      '<div style="background:rgba(255,255,255,.08);border-radius:6px;height:10px;overflow:hidden;margin-bottom:6px;">' +
        '<div style="height:100%;width:' + occ.pct + '%;background:' + line.color + ';"></div></div>' +
      '<p style="font-size:12px;color:var(--text-dim);margin:0;">' + occ.label + " · " + occ.pct + "% full</p>";
  }

  /* ---------------- pointer input ---------------- */
  var drag = null;
  canvas.addEventListener("pointerdown", function (e) {
    drag = { x: e.clientX, y: e.clientY, moved: 0, t: Date.now() };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    renderer.panBy(dx, dy);
    drag.x = e.clientX; drag.y = e.clientY;
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
    if (hit) {
      view.selected = hit;
      openInspector();
    } else {
      view.selected = null;
      inspector.classList.add("hidden");
    }
  }

  /* ---------------- controls ---------------- */
  var playBtn = document.getElementById("btn-play");
  playBtn.addEventListener("click", togglePlay);
  function togglePlay() {
    state.paused = !state.paused;
    playBtn.textContent = state.paused ? "▶" : "⏸";
  }
  var speed = document.getElementById("speed"), speedVal = document.getElementById("speed-val");
  speed.addEventListener("input", function () {
    state.speed = parseInt(speed.value, 10);
    speedVal.textContent = state.speed + "×";
  });
  document.getElementById("btn-zoom-in").addEventListener("click", function () {
    renderer.zoomAt(renderer.w / 2, renderer.h / 2, 1.2);
  });
  document.getElementById("btn-zoom-out").addEventListener("click", function () {
    renderer.zoomAt(renderer.w / 2, renderer.h / 2, 0.83);
  });
  document.getElementById("btn-reset").addEventListener("click", function () { renderer.fit(); });

  document.getElementById("btn-route").addEventListener("click", planTrip);
  document.getElementById("btn-clear-route").addEventListener("click", clearTrip);
  document.getElementById("btn-swap").addEventListener("click", function () {
    var f = view.endpoints.from;
    view.endpoints.from = view.endpoints.to;
    view.endpoints.to = f;
    syncSelects();
    planTrip();
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

  /* ---------------- stats ---------------- */
  document.getElementById("stat-stations").textContent = net.stations.length;
  document.getElementById("stat-vehicles").textContent = sim.vehicles.length;

  /* ---------------- main loop ---------------- */
  var last = performance.now();
  var uiAccum = 0;
  function frame(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (!state.paused) sim.update(dt * state.speed);

    renderer.draw(view);
    document.getElementById("clock").textContent = sim.clock();

    // throttle the live text panels (~4 fps) to keep them readable
    uiAccum += dt;
    if (uiAccum > 0.25) {
      uiAccum = 0;
      if (view.selected) renderInspector();
      if (view.route) renderItinerary();
    }
    requestAnimationFrame(frame);
  }

  buildLegend();
  buildSelects();
  clearTrip();
  requestAnimationFrame(frame);
})();
