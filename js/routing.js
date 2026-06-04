/*
 * routing.js — journey planner.
 *
 * Builds a graph of station-to-station rides (one edge per adjacent pair per
 * line, both directions, wrapping on loops) and runs Dijkstra over
 * (station, arriving-line) states so that *changing lines* costs a transfer
 * penalty. The result is collapsed into human itinerary steps:
 *   RIDE  (board, alight, line, number of stops)
 *   TRANSFER between two rides.
 */
window.VMAP = window.VMAP || {};

VMAP.Router = (function () {
  var geom = VMAP.geom;
  var TRANSFER_TIME = 150;   // sim-seconds: walk + typical wait when changing line

  function Router(net) {
    this.net = net;
    this.adj = {};            // stationId -> [edge]
    var self = this;

    net.lines.forEach(function (line) {
      var ids = line.stations.slice();
      if (line.loop) ids.push(ids[0]);
      for (var i = 0; i < ids.length - 1; i++) {
        var a = ids[i], b = ids[i + 1];
        var sa = net.stationsById[a], sb = net.stationsById[b];
        var t = geom.dist(sa, sb) / line.speed + line.dwell;
        self._edge(a, b, line.id, t);
        self._edge(b, a, line.id, t);   // lines run both ways
      }
    });
  }

  Router.prototype._edge = function (from, to, lineId, time) {
    (this.adj[from] = this.adj[from] || []).push({ to: to, lineId: lineId, time: time });
  };

  // Returns null (no route) or { steps:[...], totalTime, transfers, path:[stationIds] }.
  Router.prototype.plan = function (originId, destId) {
    if (!originId || !destId || originId === destId) return null;
    var adj = this.adj;
    var dist = {};            // stateKey -> cost
    var prev = {};            // stateKey -> { stateKey, edge }
    var visited = {};
    var pq = [];              // simple array priority queue

    function key(st, line) { return st + "|" + (line || "_"); }
    function push(k, c) { pq.push({ k: k, c: c }); }
    function pop() {
      var bi = 0;
      for (var i = 1; i < pq.length; i++) if (pq[i].c < pq[bi].c) bi = i;
      return pq.splice(bi, 1)[0];
    }

    var startKey = key(originId, null);
    dist[startKey] = 0;
    push(startKey, 0);

    var goalKey = null;
    while (pq.length) {
      var cur = pop();
      if (visited[cur.k]) continue;
      visited[cur.k] = true;
      var parts = cur.k.split("|");
      var station = parts[0], arrLine = parts[1] === "_" ? null : parts[1];

      if (station === destId) { goalKey = cur.k; break; }

      var edges = adj[station] || [];
      for (var e = 0; e < edges.length; e++) {
        var edge = edges[e];
        var transfer = (arrLine && arrLine !== edge.lineId) ? TRANSFER_TIME : 0;
        var nk = key(edge.to, edge.lineId);
        var nc = cur.c + edge.time + transfer;
        if (dist[nk] === undefined || nc < dist[nk]) {
          dist[nk] = nc;
          prev[nk] = { from: cur.k, edge: edge, transfer: transfer > 0 };
          push(nk, nc);
        }
      }
    }
    if (!goalKey) return null;

    // walk back collecting edges
    var chain = [];
    var k = goalKey;
    while (prev[k]) {
      chain.unshift(prev[k]);
      k = prev[k].from;
    }
    return this._buildItinerary(originId, chain, dist[goalKey]);
  };

  // Collapse the edge chain into ride + transfer steps.
  Router.prototype._buildItinerary = function (originId, chain, totalTime) {
    var net = this.net;
    var steps = [];
    var path = [originId];
    var transfers = 0;
    var cur = null;   // current ride accumulator

    function flush() {
      if (cur) { steps.push(cur); cur = null; }
    }

    for (var i = 0; i < chain.length; i++) {
      var edge = chain[i].edge;
      path.push(edge.to);
      if (!cur || cur.lineId !== edge.lineId) {
        flush();
        if (i > 0) { steps.push({ type: "transfer" }); transfers++; }
        cur = {
          type: "ride",
          lineId: edge.lineId,
          line: net.linesById[edge.lineId],
          board: chain[i].fromStation || path[path.length - 2],
          alight: edge.to,
          stops: 1,
          time: edge.time
        };
      } else {
        cur.alight = edge.to;
        cur.stops += 1;
        cur.time += edge.time;
      }
    }
    flush();

    // fill transfer-step station + line context from neighbours
    for (var s = 0; s < steps.length; s++) {
      if (steps[s].type === "transfer") {
        steps[s].station = steps[s - 1].alight;
        steps[s].fromLine = steps[s - 1].line;
        steps[s].toLine = steps[s + 1].line;
      }
    }

    return {
      steps: steps,
      path: path,
      totalTime: totalTime,
      transfers: transfers
    };
  };

  Router.TRANSFER_TIME = TRANSFER_TIME;
  return Router;
})();
