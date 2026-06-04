/*
 * simulation.js — the moving part of the network.
 *
 * Vehicles travel along their line's geometry at constant speed, pausing
 * (dwell) at each station, reversing at terminals, and wrapping on loops.
 * The whole thing advances in "simulation seconds": app.js feeds it scaled
 * real time so the user can speed it up.
 */
window.VMAP = window.VMAP || {};

VMAP.Simulation = (function () {
  var geom = VMAP.geom;
  var EPS = 0.001;

  function Simulation(net) {
    this.net = net;
    this.time = 8 * 3600;            // network clock starts at 08:00:00
    this.geos = {};                  // lineId -> geometry
    this.vehicles = [];
    var self = this;

    net.lines.forEach(function (line) {
      var g = geom.buildLine(line, net.stationsById);
      self.geos[line.id] = g;
      self._spawn(line, g);
    });
  }

  // Evenly distribute a line's fleet along its route.
  Simulation.prototype._spawn = function (line, g) {
    var n = line.vehicleCount;
    for (var i = 0; i < n; i++) {
      var d = (g.total / n) * i;
      this.vehicles.push({
        id: line.id + "-" + i,
        lineId: line.id,
        color: line.color,
        speed: line.speed,
        dist: d,
        dir: line.loop ? 1 : (i % 2 === 0 ? 1 : -1),
        dwell: 0,
        atStation: null
      });
    }
  };

  // Advance one vehicle by `dt` sim-seconds, honoring dwell + stops.
  Simulation.prototype._stepVehicle = function (v, dt) {
    var g = this.geos[v.lineId];
    var sd = g.stationDist;

    if (v.dwell > 0) {
      v.dwell -= dt;
      if (v.dwell > 0) return;
      dt = -v.dwell;        // leftover time after dwell ends
      v.dwell = 0;
      v.atStation = null;
    }

    var move = v.speed * dt;
    var guard = 0;
    while (move > EPS && guard++ < 64) {
      // next stop distance in travel direction
      var target, isTerminal = false, stationIdx = -1;
      if (v.dir > 0) {
        var j = 0;
        while (j < sd.length - 1 && sd[j] <= v.dist + EPS) j++;
        target = sd[j];
        stationIdx = j;
        isTerminal = (j === sd.length - 1);
      } else {
        var k = sd.length - 1;
        while (k > 0 && sd[k] >= v.dist - EPS) k--;
        target = sd[k];
        stationIdx = k;
        isTerminal = (k === 0);
      }
      var gap = Math.abs(target - v.dist);
      if (move < gap) {
        v.dist += v.dir * move;
        move = 0;
        break;
      }
      // arrived at a stop
      v.dist = target;
      move -= gap;

      if (g.loop && isTerminal) {
        // virtual closing point == start: wrap, no dwell here
        v.dist = 0;
        continue;
      }
      var line = this.net.linesById[v.lineId];
      v.atStation = g.points[stationIdx].id;
      if (isTerminal) {
        v.dir = -v.dir;
        v.dwell = line.terminalDwell;
      } else {
        v.dwell = line.dwell;
      }
      break;   // dwell consumes the rest of this frame
    }
  };

  Simulation.prototype.update = function (dt) {
    if (dt <= 0) return;
    this.time += dt;
    for (var i = 0; i < this.vehicles.length; i++) {
      this._stepVehicle(this.vehicles[i], dt);
    }
  };

  // World position + heading for a vehicle (for rendering).
  Simulation.prototype.vehiclePose = function (v) {
    return geom.pointAt(this.geos[v.lineId], v.dist);
  };

  // The station a vehicle is heading toward right now (its "next stop").
  Simulation.prototype.nextStop = function (v) {
    var g = this.geos[v.lineId], sd = g.stationDist;
    if (v.dir > 0) {
      for (var j = 0; j < sd.length; j++) if (sd[j] > v.dist + EPS) return g.points[j].id;
      return g.points[g.points.length - 1].id;
    } else {
      for (var k = sd.length - 1; k >= 0; k--) if (sd[k] < v.dist - EPS) return g.points[k].id;
      return g.points[0].id;
    }
  };

  // Terminal name in a vehicle's current direction (its headsign destination).
  Simulation.prototype.headsign = function (v) {
    var g = this.geos[v.lineId];
    if (g.loop) return this.net.linesById[v.lineId].name + " ↻";
    var endId = v.dir > 0 ? g.points[g.points.length - 1].id : g.points[0].id;
    return this.net.stationsById[endId].name;
  };

  /*
   * Live arrivals for a station: for every line serving it, find vehicles
   * currently approaching and estimate ETA (sim-seconds), including a rough
   * dwell allowance for intermediate stops.
   */
  Simulation.prototype.arrivalsFor = function (stationId) {
    var out = [];
    var net = this.net;
    for (var vi = 0; vi < this.vehicles.length; vi++) {
      var v = this.vehicles[vi];
      var line = net.linesById[v.lineId];
      var g = this.geos[v.lineId];
      // station index on this line (may not be present)
      var idx = -1;
      for (var p = 0; p < g.points.length; p++) {
        if (g.points[p].id === stationId) { idx = p; break; }
      }
      if (idx === -1) continue;
      var targetDist = g.stationDist[idx];

      var eta = null, stopsBetween = 0;
      if (g.loop) {
        var d = ((targetDist - v.dist) % g.total + g.total) % g.total;
        eta = d / v.speed;
        stopsBetween = this._countStopsLoop(g, v.dist, targetDist);
      } else if (v.dir > 0 && targetDist > v.dist - EPS) {
        eta = (targetDist - v.dist) / v.speed;
        stopsBetween = this._countStops(g, v.dist, targetDist, 1);
      } else if (v.dir < 0 && targetDist < v.dist + EPS) {
        eta = (v.dist - targetDist) / v.speed;
        stopsBetween = this._countStops(g, v.dist, targetDist, -1);
      }
      if (eta === null) continue;
      if (v.atStation === stationId && v.dwell > 0) eta = 0;
      eta += stopsBetween * line.dwell;

      out.push({
        lineId: line.id,
        lineName: line.name,
        color: line.color,
        destination: this.headsign(v),
        eta: eta,
        vehicleId: v.id
      });
    }
    out.sort(function (a, b) { return a.eta - b.eta; });
    return out;
  };

  Simulation.prototype._countStops = function (g, from, to, dir) {
    var c = 0, sd = g.stationDist;
    for (var i = 0; i < sd.length; i++) {
      if (dir > 0 && sd[i] > from + EPS && sd[i] < to - EPS) c++;
      if (dir < 0 && sd[i] < from - EPS && sd[i] > to + EPS) c++;
    }
    return c;
  };
  Simulation.prototype._countStopsLoop = function (g, from, to) {
    var c = 0, sd = g.stationDist, total = g.total;
    var span = ((to - from) % total + total) % total;
    for (var i = 0; i < sd.length - 1; i++) {
      var rel = ((sd[i] - from) % total + total) % total;
      if (rel > EPS && rel < span - EPS) c++;
    }
    return c;
  };

  /*
   * Soonest a train will leave `boardId` already heading toward `alightId`
   * on a given line. Returns eta in sim-seconds, or an approximate headway
   * if none is currently inbound. Used by the trip planner.
   */
  Simulation.prototype.nextDeparture = function (lineId, boardId, alightId) {
    var net = this.net, g = this.geos[lineId], line = net.linesById[lineId];
    var boardIdx = -1, alightIdx = -1;
    for (var p = 0; p < g.points.length; p++) {
      if (g.points[p].id === boardId && boardIdx === -1) boardIdx = p;
      if (g.points[p].id === alightId) alightIdx = p;
    }
    if (boardIdx === -1) return null;
    var boardDist = g.stationDist[boardIdx];
    var neededDir = g.loop ? 1 : (alightIdx > boardIdx ? 1 : -1);

    var best = null;
    for (var vi = 0; vi < this.vehicles.length; vi++) {
      var v = this.vehicles[vi];
      if (v.lineId !== lineId) continue;
      var eta = null;
      if (g.loop) {
        eta = ((boardDist - v.dist) % g.total + g.total) % g.total / v.speed;
      } else if (v.dir === neededDir) {
        if (neededDir > 0 && boardDist > v.dist - EPS) eta = (boardDist - v.dist) / v.speed;
        if (neededDir < 0 && boardDist < v.dist + EPS) eta = (v.dist - boardDist) / v.speed;
      }
      if (eta === null) continue;
      if (v.atStation === boardId && v.dwell > 0) eta = 0;
      if (best === null || eta < best) best = eta;
    }
    if (best !== null) return best;

    // none inbound right now → approximate headway for the line
    var span = g.loop ? g.total : g.total * 2;
    return span / line.speed / line.vehicleCount;
  };

  Simulation.prototype.clock = function () {
    var t = Math.floor(this.time) % 86400;
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  };

  return Simulation;
})();
