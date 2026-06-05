/*
 * renderer.js — all Canvas drawing + the camera (pan/zoom) math.
 *
 * The renderer owns the camera; app.js drives it (panBy / zoomAt / fit) and
 * passes a `view` object each frame describing what's selected, hidden,
 * focused, or part of a planned route.
 */
window.VMAP = window.VMAP || {};

VMAP.Renderer = (function () {
  var geom = VMAP.geom;

  function Renderer(canvas, net, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.net = net;
    this.sim = sim;
    this.dpr = window.devicePixelRatio || 1;
    this.cam = { scale: 1, tx: 0, ty: 0 };
    this.camTarget = null;          // {scale,tx,ty} the camera eases toward
    this._epAnim = {};              // which -> t0 (endpoint drop-in start)
    this._routeAnim = 0;            // t0 of the route draw-on reveal
    // honor the OS "reduce motion" setting — keep feedback, drop the animation
    this.reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this._buildSegMap();
    this.resize();
  }

  /* ---- easing + motion ---- */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  var now = function () { return (window.performance && performance.now) ? performance.now() : Date.now(); };

  // The map's left third is covered by the panel on desktop; bias framing right.
  Renderer.prototype._leftInset = function () { return this.w > 820 ? 372 : 0; };

  Renderer.prototype.pingEndpoint = function (which) { if (!this.reduceMotion) this._epAnim[which] = now(); };
  Renderer.prototype.animateRoute = function () { this._routeAnim = this.reduceMotion ? 0 : now(); };
  Renderer.prototype.clearAnims = function () { this._epAnim = {}; this._routeAnim = 0; this.camTarget = null; };

  // Ease the camera to frame a world-space bounding box (respecting the panel).
  Renderer.prototype.flyToBounds = function (minX, minY, maxX, maxY, pad) {
    pad = pad == null ? 150 : pad;
    var inset = this._leftInset();
    var availW = this.w - inset - 40, availH = this.h - 40;
    var sx = availW / (maxX - minX + pad * 2), sy = availH / (maxY - minY + pad * 2);
    var scale = Math.max(0.3, Math.min(2.4, Math.min(sx, sy)));
    var cx = inset + (this.w - inset) / 2, cy = this.h / 2;
    var target = { scale: scale, tx: cx - (minX + maxX) / 2 * scale, ty: cy - (minY + maxY) / 2 * scale };
    if (this.reduceMotion) { this.cam.scale = target.scale; this.cam.tx = target.tx; this.cam.ty = target.ty; this.camTarget = null; }
    else this.camTarget = target;
  };
  Renderer.prototype.flyToRoute = function (pathIds) {
    if (!pathIds || pathIds.length < 2) return;
    var net = this.net, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    pathIds.forEach(function (id) {
      var s = net.stationsById[id]; if (!s) return;
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    });
    this.flyToBounds(minX, minY, maxX, maxY, 170);
  };
  // Zoom IN and center on a single station (when only the start is chosen).
  Renderer.prototype.flyToStation = function (s) {
    if (!s) return;
    var inset = this._leftInset(), availW = this.w - inset - 40;
    var scale = Math.max(1.2, Math.min(2.2, availW / 520));   // show A + some context
    var cx = inset + (this.w - inset) / 2, cy = this.h / 2;
    var target = { scale: scale, tx: cx - s.x * scale, ty: cy - s.y * scale };
    if (this.reduceMotion) { this.cam.scale = target.scale; this.cam.tx = target.tx; this.cam.ty = target.ty; this.camTarget = null; }
    else this.camTarget = target;
  };
  // Zoom OUT to frame both endpoints (the moment B is chosen, before results).
  Renderer.prototype.flyToEndpoints = function (aId, bId) {
    var a = this.net.stationsById[aId], b = this.net.stationsById[bId];
    if (!a || !b) return;
    this.flyToBounds(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), 180);
  };

  Renderer.prototype.resize = function () {
    // The canvas is a full-viewport fixed element; measuring the window avoids
    // relying on layout timing (getBoundingClientRect can read stale/default
    // sizes before first layout).
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  };

  Renderer.prototype.worldToScreen = function (p) {
    return { x: p.x * this.cam.scale + this.cam.tx, y: p.y * this.cam.scale + this.cam.ty };
  };
  Renderer.prototype.screenToWorld = function (p) {
    return { x: (p.x - this.cam.tx) / this.cam.scale, y: (p.y - this.cam.ty) / this.cam.scale };
  };

  Renderer.prototype.panBy = function (dx, dy) {
    this.camTarget = null;          // user takes control
    this.cam.tx += dx; this.cam.ty += dy;
  };
  Renderer.prototype.zoomAt = function (sx, sy, factor) {
    this.camTarget = null;
    var before = this.screenToWorld({ x: sx, y: sy });
    this.cam.scale = Math.max(0.3, Math.min(3.2, this.cam.scale * factor));
    var after = this.worldToScreen(before);
    this.cam.tx += sx - after.x;
    this.cam.ty += sy - after.y;
  };

  // Frame the whole network with padding.
  Renderer.prototype.fit = function () {
    var xs = this.net.stations.map(function (s) { return s.x; });
    var ys = this.net.stations.map(function (s) { return s.y; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var padX = 150, padY = 120;
    var sx = this.w / (maxX - minX + padX * 2);
    var sy = this.h / (maxY - minY + padY * 2);
    this.cam.scale = Math.max(0.3, Math.min(2.4, Math.min(sx, sy)));
    this.cam.tx = (this.w - (minX + maxX) * this.cam.scale) / 2;
    this.cam.ty = (this.h - (minY + maxY) * this.cam.scale) / 2;
  };

  /* ---------------- drawing ---------------- */

  Renderer.prototype.draw = function (view) {
    var ctx = this.ctx, cam = this.cam;

    // critically-damped camera glide toward any active target
    if (this.camTarget) {
      var t = this.camTarget, k = 0.16;
      cam.scale += (t.scale - cam.scale) * k;
      cam.tx += (t.tx - cam.tx) * k;
      cam.ty += (t.ty - cam.ty) * k;
      if (Math.abs(t.scale - cam.scale) < 0.0008 && Math.abs(t.tx - cam.tx) < 0.4 && Math.abs(t.ty - cam.ty) < 0.4) {
        cam.scale = t.scale; cam.tx = t.tx; cam.ty = t.ty; this.camTarget = null;
      }
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    // subtle vignette background
    var g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, "#0f1a2e");
    g.addColorStop(1, "#0b1322");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.setTransform(cam.scale * this.dpr, 0, 0, cam.scale * this.dpr, cam.tx * this.dpr, cam.ty * this.dpr);

    this._drawGeography();
    this._drawRoutes(view);
    if (view.routePath && view.routePath.length > 1) this._drawRouteHalo(view.routePath);
    this._drawStations(view);
    this._drawLabels(view);
    this._drawEndpoints(view);

    ctx.restore();
  };

  Renderer.prototype._drawGeography = function () {
    var ctx = this.ctx, geo = this.net.geography;
    if (geo.river && geo.river.length > 1) {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(45, 108, 200, 0.22)";
      ctx.lineWidth = 46;
      ctx.beginPath();
      ctx.moveTo(geo.river[0].x, geo.river[0].y);
      for (var i = 1; i < geo.river.length; i++) ctx.lineTo(geo.river[i].x, geo.river[i].y);
      ctx.stroke();
    }
    (geo.parks || []).forEach(function (p) {
      ctx.fillStyle = "rgba(40, 120, 70, 0.16)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  Renderer.prototype._lineVisible = function (lineId, view) {
    return !(view.hiddenLines && view.hiddenLines[lineId]);
  };

  Renderer.prototype.SPACING = 4.2;   // world units between parallel rails

  // Map each undirected segment -> ordered list of line ids sharing it, so we
  // can fan shared trunks (downtown SF / Transbay tube carry 4 lines) and keep
  // single-line segments perfectly centered on the station dots.
  Renderer.prototype._buildSegMap = function () {
    this._segMap = {};
    this.net.lines.forEach(function (line) {
      var st = line.stations;
      for (var i = 0; i < st.length - 1; i++) {
        var key = st[i] < st[i + 1] ? st[i] + "|" + st[i + 1] : st[i + 1] + "|" + st[i];
        (this._segMap[key] = this._segMap[key] || []).push(line.id);
      }
    }, this);
  };

  // Perpendicular offset for one line on the segment between station ids a,b.
  Renderer.prototype._segOffset = function (lineId, aId, bId) {
    var key = aId < bId ? aId + "|" + bId : bId + "|" + aId;
    var arr = this._segMap[key] || [lineId];
    var idx = arr.indexOf(lineId);
    return {
      o: (idx - (arr.length - 1) / 2) * this.SPACING,
      canonicalAB: aId < bId          // both lines reference the same side
    };
  };

  Renderer.prototype._drawRoutes = function (view) {
    var ctx = this.ctx, self = this;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // dark casing pass for all visible lines, then colored pass on top
    [true, false].forEach(function (casing) {
      self.net.lines.forEach(function (line) {
        if (!self._lineVisible(line.id, view)) return;
        var g = self.sim.geos[line.id];
        var dim = view.focusLine && view.focusLine !== line.id;
        ctx.strokeStyle = casing ? "rgba(6,11,20,0.85)"
                                 : (dim ? self._fade(line.color, 0.16) : line.color);
        ctx.lineWidth = casing ? 6.0 : 3.4;
        ctx.beginPath();
        var pts = g.points;
        for (var i = 0; i < pts.length - 1; i++) {
          var a = pts[i], b = pts[i + 1];
          var off = self._segOffset(line.id, a.id, b.id);
          var ca = off.canonicalAB ? a : b, cb = off.canonicalAB ? b : a;
          var dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
          var nx = -dy / len * off.o, ny = dx / len * off.o;
          ctx.moveTo(a.x + nx, a.y + ny);
          ctx.lineTo(b.x + nx, b.y + ny);
        }
        ctx.stroke();
      });
    });
  };

  Renderer.prototype._pathLine = function (g) {
    var ctx = this.ctx, pts = g.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  };

  // Bright halo under a planned journey path — draws on from A→B, then flows.
  Renderer.prototype._drawRouteHalo = function (pathIds) {
    var ctx = this.ctx, net = this.net, i;
    var pts = [];
    for (i = 0; i < pathIds.length; i++) { var s = net.stationsById[pathIds[i]]; if (s) pts.push(s); }
    if (pts.length < 2) return;

    // cumulative length so we can reveal the stroke proportionally
    var total = 0, segLen = [0];
    for (i = 1; i < pts.length; i++) { total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); segLen.push(total); }

    var p = 1;
    if (this._routeAnim) {
      var el = (now() - this._routeAnim) / 760;
      p = el >= 1 ? 1 : easeInOutCubic(clamp01(el));
    }

    function tracePath() {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    }

    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";

    // reveal via a dash that uncovers from the start
    ctx.setLineDash([total, total]);
    ctx.lineDashOffset = total * (1 - p);

    // soft white halo
    ctx.strokeStyle = "rgba(255,255,255,0.82)";
    ctx.lineWidth = 13;
    ctx.shadowColor = "rgba(150,200,255,0.65)"; ctx.shadowBlur = 16;
    tracePath(); ctx.stroke();
    ctx.shadowBlur = 0;

    if (this.reduceMotion) {
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(120,225,170,0.9)"; ctx.lineWidth = 4;
      tracePath(); ctx.stroke();
      ctx.restore();
      return;
    }

    // flowing accent dashes on top (only along the revealed portion)
    ctx.setLineDash([9, 13]);
    ctx.lineDashOffset = -(now() / 36) % 22;
    if (p < 1) {
      // while revealing, also clip flow to the revealed length
      ctx.save();
      ctx.setLineDash([Math.max(0.001, total * p), total]);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = "rgba(120,225,170,0.95)"; ctx.lineWidth = 4;
      tracePath(); ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = "rgba(120,225,170,0.9)"; ctx.lineWidth = 4;
      tracePath(); ctx.stroke();
    }

    // glowing comet head riding the leading edge while it draws
    if (p < 1) {
      var d = total * p, k = 1;
      while (k < segLen.length && segLen[k] < d) k++;
      if (k < segLen.length) {
        var a = pts[k - 1], b = pts[k];
        var f = (d - segLen[k - 1]) / Math.max(1, segLen[k] - segLen[k - 1]);
        var hx = a.x + (b.x - a.x) * f, hy = a.y + (b.y - a.y) * f;
        ctx.setLineDash([]);
        ctx.shadowColor = "rgba(150,255,200,0.95)"; ctx.shadowBlur = 18;
        ctx.fillStyle = "#eafff3";
        ctx.beginPath(); ctx.arc(hx, hy, 4.6, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  };

  Renderer.prototype._drawStations = function (view) {
    var ctx = this.ctx, self = this;
    var routeSet = view.routeSet || {};
    this.net.stations.forEach(function (s) {
      // hide stations whose only lines are hidden
      var anyVisible = s.lines.some(function (l) { return self._lineVisible(l, view); });
      if (!anyVisible) return;

      var onRoute = routeSet[s.id];
      var selected = view.selected && view.selected.type === "station" && view.selected.id === s.id;
      var r = s.interchange ? 8 : 5.5;

      if (selected || onRoute) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = selected ? "rgba(79,140,255,0.35)" : "rgba(255,255,255,0.22)";
        ctx.fill();
      }

      if (s.interchange) {
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff"; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = "#0e1726"; ctx.stroke();
      } else {
        var color = self.net.linesById[s.lines[0]].color;
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#0e1726"; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke();
      }
    });
  };

  // World pose of a vehicle, shifted onto its line's per-segment offset rail.
  Renderer.prototype.vehicleWorldPose = function (v) {
    var pose = this.sim.vehiclePose(v);
    var g = this.sim.geos[v.lineId], sd = g.stationDist, pts = g.points;
    var i = 0;
    while (i < sd.length - 2 && sd[i + 1] < v.dist) i++;
    var a = pts[i], b = pts[i + 1];
    var off = this._segOffset(v.lineId, a.id, b.id);
    var ca = off.canonicalAB ? a : b, cb = off.canonicalAB ? b : a;
    var dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
    return {
      x: pose.x + (-dy / len) * off.o,
      y: pose.y + (dx / len) * off.o,
      angle: pose.angle
    };
  };

  // Draw one train marker (rounded rect + direction nose) at a world pose.
  Renderer.prototype._trainMarker = function (pose, color, selected) {
    var ctx = this.ctx, minPx = 6;
    var halfLen = Math.max(11, minPx / this.cam.scale);
    var halfWid = Math.max(7, (minPx * 0.66) / this.cam.scale);
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);
    if (selected) { ctx.shadowColor = "rgba(255,255,255,0.9)"; ctx.shadowBlur = 16; }
    this._roundRect(-halfLen, -halfWid, halfLen * 2, halfWid * 2, halfWid * 0.6);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(halfLen * 0.55, 0, halfWid * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._drawVehicles = function (view) {
    var self = this;
    this.sim.vehicles.forEach(function (v) {
      if (!self._lineVisible(v.lineId, view)) return;
      if (view.focusLine && view.focusLine !== v.lineId) return;
      var selected = view.selected && view.selected.type === "vehicle" && view.selected.id === v.id;
      self._trainMarker(self.vehicleWorldPose(v), v.color, selected);
    });
  };

  // World pose of a live train along its fromId->toId segment (offset rail).
  Renderer.prototype.liveTrainPose = function (mgr, t) {
    var a = this.net.stationsById[t.fromId], b = this.net.stationsById[t.toId];
    var f = mgr.frac(t);
    var off = this._segOffset(t.lineId, t.fromId, t.toId);
    var ca = off.canonicalAB ? a : b, cb = off.canonicalAB ? b : a;
    var dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
    return {
      x: a.x + (b.x - a.x) * f + (-dy / len) * off.o,
      y: a.y + (b.y - a.y) * f + (dx / len) * off.o,
      angle: Math.atan2(b.y - a.y, b.x - a.x)
    };
  };

  Renderer.prototype._drawLiveTrains = function (view) {
    var self = this, mgr = view.liveManager;
    mgr.trains.forEach(function (t) {
      if (!self._lineVisible(t.lineId, view)) return;
      if (view.focusLine && view.focusLine !== t.lineId) return;
      var selected = view.selected && view.selected.type === "train" && view.selected.id === t.key;
      self._trainMarker(self.liveTrainPose(mgr, t), t.color, selected);
    });
  };

  Renderer.prototype._drawLabels = function (view) {
    var ctx = this.ctx, self = this;
    var showAll = this.cam.scale > 1.45;
    var showInterchange = this.cam.scale > 0.66;
    ctx.font = "600 12px Segoe UI, system-ui, sans-serif";
    ctx.textBaseline = "middle";

    this.net.stations.forEach(function (s) {
      var anyVisible = s.lines.some(function (l) { return self._lineVisible(l, view); });
      if (!anyVisible) return;
      var selected = view.selected && view.selected.type === "station" && view.selected.id === s.id;
      var onRoute = view.routeSet && view.routeSet[s.id];
      if (!((s.interchange && showInterchange) || showAll || selected || onRoute)) return;

      var tw = ctx.measureText(s.name).width;
      var ox = s.x + 12, oy = s.y - 12;
      ctx.fillStyle = "rgba(8,12,20,0.78)";
      self._roundRect(ox - 5, oy - 9, tw + 10, 18, 5);
      ctx.fill();
      ctx.fillStyle = (selected || onRoute) ? "#ffffff" : "#d6deec";
      ctx.fillText(s.name, ox, oy);
    });
  };

  Renderer.prototype._drawEndpoints = function (view) {
    var ep = view.endpoints;
    if (!ep) return;
    if (ep.from) this._pin(this.net.stationsById[ep.from], "A", "#5ad17a", this._epAnim.from);
    if (ep.to) this._pin(this.net.stationsById[ep.to], "B", "#ff6b6b", this._epAnim.to);
  };

  Renderer.prototype._pin = function (s, letter, color, t0) {
    if (!s) return;
    var ctx = this.ctx, cx = s.x, cy = s.y - 16;

    // drop-in: scale with overshoot + a little fall from above
    var appear = 1, fall = 0;
    if (t0) {
      var e = clamp01((now() - t0) / 460);
      appear = easeOutBack(e);
      fall = (1 - easeOutCubic(e)) * 22;
    }

    // continuous breathing pulse rings under the pin (feels alive)
    if (!this.reduceMotion) {
      var ph = (now() / 1300) % 1;
      ctx.save();
      ctx.globalAlpha = (1 - ph) * 0.4 * appear;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 11 + ph * 18, 0, Math.PI * 2); ctx.stroke();
      var ph2 = (ph + 0.5) % 1;
      ctx.globalAlpha = (1 - ph2) * 0.28 * appear;
      ctx.beginPath(); ctx.arc(cx, cy, 11 + ph2 * 18, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(cx, cy - fall);
    ctx.scale(appear, appear);
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();   // little tail
    ctx.moveTo(-5, 6);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 15);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = "#0c1422";
    ctx.font = "700 12px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(letter, 0, 0);
    ctx.textAlign = "start";
    ctx.restore();
  };

  /* ---- picking (screen space) ---- */
  Renderer.prototype.pick = function (sx, sy, view) {
    var self = this;
    var best = null, bestD = 18;
    this.net.stations.forEach(function (s) {
      var anyVisible = s.lines.some(function (l) { return self._lineVisible(l, view); });
      if (!anyVisible) return;
      var sp = self.worldToScreen(s);
      var d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < bestD) { bestD = d; best = { type: "station", id: s.id }; }
    });
    return best;
  };

  /* ---- helpers ---- */
  Renderer.prototype._roundRect = function (x, y, w, h, r) {
    var ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  Renderer.prototype._fade = function (hex, a) {
    var c = hex.replace("#", "");
    var n = parseInt(c, 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  };

  return Renderer;
})();
