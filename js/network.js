/*
 * network.js — assembles the runtime network from BART data.
 *
 * Projects real lat/lon (equirectangular with latitude correction) into a
 * normalized "world" box so the rest of the app (geometry, simulation, router,
 * renderer) is geography-agnostic. North is up. Exposes VMAP.network with the
 * same shape the renderer/simulation/router expect, plus per-line motion
 * params for the ambient (schematic) train animation.
 */
window.VMAP = window.VMAP || {};

(function () {
  var B = window.VMAP_BART;

  // ---- project lat/lon -> world ----
  var abbrs = Object.keys(B.stations);
  var lats = abbrs.map(function (a) { return B.stations[a][1]; });
  var lons = abbrs.map(function (a) { return B.stations[a][2]; });
  var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
  var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
  var meanLat = (minLat + maxLat) / 2;
  var kx = Math.cos(meanLat * Math.PI / 180);

  // target world box (aspect follows the real bay area footprint)
  var TARGET_W = 1500;
  var spanX = (maxLon - minLon) * kx;
  var spanY = (maxLat - minLat);
  var scale = TARGET_W / spanX;

  function project(lat, lon) {
    return {
      x: (lon - minLon) * kx * scale,
      y: (maxLat - lat) * scale   // flip so north is up
    };
  }

  // ---- stations ----
  var stations = [];
  var stationsById = {};
  abbrs.forEach(function (abbr) {
    var d = B.stations[abbr];
    var p = project(d[1], d[2]);
    var s = { id: abbr, name: d[0], lat: d[1], lon: d[2], x: p.x, y: p.y, lines: [] };
    stations.push(s);
    stationsById[abbr] = s;
  });

  // ---- lines ----
  var lines = [];
  var linesById = {};
  B.lines.forEach(function (ld, idx) {
    var color = B.colors[ld.colorKey];
    var line = {
      id: ld.id,
      name: ld.name,
      color: color,
      colorKey: ld.colorKey,
      mode: "BART",
      stations: ld.stations.slice(),
      order: idx,
      loop: false,
      // ambient animation params (world-units/sec etc.) — schematic only
      speed: 95,
      vehicleCount: Math.max(2, Math.round(ld.stations.length / 4)),
      dwell: 0.5,
      terminalDwell: 2.2
    };
    lines.push(line);
    linesById[ld.id] = line;
    ld.stations.forEach(function (sid) {
      var s = stationsById[sid];
      if (s && s.lines.indexOf(ld.id) === -1) s.lines.push(ld.id);
    });
  });

  stations.forEach(function (s) { s.interchange = s.lines.length > 1; });

  /*
   * Station codes (the "POV" layer): letter = line color initial
   * (Blue=B, Orange=O, Green=G, Red=R, Yellow=Y, Beige OAK shuttle=K),
   * number = the stop's 1-based position from the start to the end of that
   * line's station list (zero-padded to 2 digits, e.g. B01..B18). A station on
   * several lines gets one code per line.
   */
  var LETTER = { yellow: "Y", orange: "O", green: "G", red: "R", blue: "B", beige: "K" };
  stations.forEach(function (s) { s.codes = []; });
  lines.forEach(function (line) {
    var letter = LETTER[line.colorKey] || line.colorKey.charAt(0).toUpperCase();
    line.letter = letter;
    line.stations.forEach(function (sid, i) {
      var s = stationsById[sid];
      if (!s) return;
      var n = i + 1;
      s.codes.push({
        lineId: line.id, letter: letter, num: n,
        code: letter + (n < 10 ? "0" : "") + n,
        color: line.color
      });
    });
  });
  var codeByLineStation = {};   // lineId -> stationAbbr -> code string
  lines.forEach(function (line) { codeByLineStation[line.id] = {}; });
  stations.forEach(function (s) {
    s.codes.forEach(function (c) { codeByLineStation[c.lineId][s.id] = c.code; });
  });

  VMAP.network = {
    system: "BART",
    stations: stations,
    stationsById: stationsById,
    lines: lines,
    linesById: linesById,
    codeByLineStation: codeByLineStation,
    geography: { river: [], parks: [] },   // map is purely the transit network
    project: project,
    worldSize: { w: TARGET_W, h: spanY * scale }
  };
})();
