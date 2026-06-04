/*
 * geometry.js — turns a line's ordered station list into a measurable polyline.
 *
 * For each line we precompute:
 *   points[]        world coords of every station (plus closing point if loop)
 *   stationDist[]   cumulative distance at each station along the route
 *   total           total route length
 * and expose pointAt(geo, dist) to locate a vehicle anywhere along it.
 */
window.VMAP = window.VMAP || {};

VMAP.geom = (function () {
  function dist(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Build the measurable geometry for one line.
  function buildLine(line, stationsById) {
    var pts = line.stations.map(function (id) {
      var s = stationsById[id];
      return { x: s.x, y: s.y, id: id };
    });
    if (line.loop) pts.push({ x: pts[0].x, y: pts[0].y, id: pts[0].id });

    var stationDist = [0];
    for (var i = 1; i < pts.length; i++) {
      stationDist.push(stationDist[i - 1] + dist(pts[i - 1], pts[i]));
    }
    return {
      lineId: line.id,
      loop: !!line.loop,
      points: pts,
      stationDist: stationDist,        // index aligns with pts
      total: stationDist[stationDist.length - 1]
    };
  }

  // Locate a world point + heading at distance `d` along the geometry.
  function pointAt(geo, d) {
    var total = geo.total;
    if (geo.loop) {
      d = ((d % total) + total) % total;
    } else {
      d = Math.max(0, Math.min(total, d));
    }
    var sd = geo.stationDist, pts = geo.points;
    // find segment [i, i+1] containing d
    var i = 0;
    while (i < sd.length - 2 && sd[i + 1] < d) i++;
    var segLen = sd[i + 1] - sd[i] || 1;
    var t = (d - sd[i]) / segLen;
    var a = pts[i], b = pts[i + 1];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x)
    };
  }

  return { dist: dist, buildLine: buildLine, pointAt: pointAt };
})();
