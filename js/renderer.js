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
    this.resize();
  }

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
    this.cam.tx += dx; this.cam.ty += dy;
  };
  Renderer.prototype.zoomAt = function (sx, sy, factor) {
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
    this._drawVehicles(view);
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

  Renderer.prototype._drawRoutes = function (view) {
    var ctx = this.ctx, self = this;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    this.net.lines.forEach(function (line) {
      if (!self._lineVisible(line.id, view)) return;
      var g = self.sim.geos[line.id];
      var dim = view.focusLine && view.focusLine !== line.id;

      // casing
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 11;
      self._pathLine(g);
      ctx.stroke();

      // colored route
      ctx.strokeStyle = dim ? self._fade(line.color, 0.22) : line.color;
      ctx.lineWidth = 6.5;
      self._pathLine(g);
      ctx.stroke();
    });
  };

  Renderer.prototype._pathLine = function (g) {
    var ctx = this.ctx, pts = g.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  };

  // Bright halo under a planned journey path.
  Renderer.prototype._drawRouteHalo = function (pathIds) {
    var ctx = this.ctx, net = this.net;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 13;
    ctx.shadowColor = "rgba(255,255,255,0.6)";
    ctx.shadowBlur = 14;
    ctx.beginPath();
    var s0 = net.stationsById[pathIds[0]];
    ctx.moveTo(s0.x, s0.y);
    for (var i = 1; i < pathIds.length; i++) {
      var s = net.stationsById[pathIds[i]];
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
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

  Renderer.prototype._drawVehicles = function (view) {
    var ctx = this.ctx, self = this;
    var minPx = 7;   // keep visible when zoomed out
    this.sim.vehicles.forEach(function (v) {
      if (!self._lineVisible(v.lineId, view)) return;
      if (view.focusLine && view.focusLine !== v.lineId) return;
      var pose = self.sim.vehiclePose(v);
      var selected = view.selected && view.selected.type === "vehicle" && view.selected.id === v.id;

      var halfLen = Math.max(11, minPx / self.cam.scale);
      var halfWid = Math.max(7, (minPx * 0.66) / self.cam.scale);

      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.rotate(pose.angle);

      if (selected) {
        ctx.shadowColor = "rgba(255,255,255,0.9)";
        ctx.shadowBlur = 16;
      }
      self._roundRect(-halfLen, -halfWid, halfLen * 2, halfWid * 2, halfWid * 0.6);
      ctx.fillStyle = v.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.stroke();

      // nose marker for direction
      ctx.beginPath();
      ctx.arc(halfLen * 0.55, 0, halfWid * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
      ctx.restore();
    });
  };

  Renderer.prototype._drawLabels = function (view) {
    var ctx = this.ctx, self = this;
    var showAll = this.cam.scale > 1.15;
    ctx.font = "600 12px Segoe UI, system-ui, sans-serif";
    ctx.textBaseline = "middle";

    this.net.stations.forEach(function (s) {
      var anyVisible = s.lines.some(function (l) { return self._lineVisible(l, view); });
      if (!anyVisible) return;
      var selected = view.selected && view.selected.type === "station" && view.selected.id === s.id;
      var onRoute = view.routeSet && view.routeSet[s.id];
      if (!(s.interchange || showAll || selected || onRoute)) return;

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
    if (ep.from) this._pin(this.net.stationsById[ep.from], "A", "#5ad17a");
    if (ep.to) this._pin(this.net.stationsById[ep.to], "B", "#ff6b6b");
  };

  Renderer.prototype._pin = function (s, letter, color) {
    if (!s) return;
    var ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(s.x, s.y - 16, 11, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();   // little tail
    ctx.moveTo(s.x - 5, s.y - 10);
    ctx.lineTo(s.x + 5, s.y - 10);
    ctx.lineTo(s.x, s.y - 1);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = "#0c1422";
    ctx.font = "700 12px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(letter, s.x, s.y - 16);
    ctx.textAlign = "start";
    ctx.restore();
  };

  /* ---- picking (screen space) ---- */
  Renderer.prototype.pick = function (sx, sy, view) {
    var self = this;
    // vehicles first (smaller, on top)
    var best = null, bestD = 16;
    this.sim.vehicles.forEach(function (v) {
      if (!self._lineVisible(v.lineId, view)) return;
      if (view.focusLine && view.focusLine !== v.lineId) return;
      var sp = self.worldToScreen(self.sim.vehiclePose(v));
      var d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < bestD) { bestD = d; best = { type: "vehicle", id: v.id }; }
    });
    if (best) return best;

    bestD = 18;
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
