/*
 * network.js — the virtual transit network for "Veridia".
 *
 * Everything downstream (geometry, simulation, routing, rendering) is derived
 * from this single declarative description. Edit here to reshape the city.
 *
 * Coordinates live in an abstract "world" space (roughly 1600 x 1100). The
 * renderer maps world -> screen with pan/zoom, so absolute values only matter
 * relative to each other.
 */
window.VMAP = window.VMAP || {};

VMAP.network = {
  city: "Veridia",

  // Decorative geography so the map reads like a real place, not a graph.
  geography: {
    river: [
      { x: 60, y: 1000 }, { x: 360, y: 870 }, { x: 640, y: 840 },
      { x: 900, y: 760 }, { x: 1150, y: 690 }, { x: 1400, y: 560 },
      { x: 1560, y: 360 }
    ],
    parks: [
      { x: 980, y: 250, r: 95 },
      { x: 430, y: 720, r: 80 },
      { x: 1320, y: 800, r: 70 }
    ]
  },

  // id, display name, world position. `interchange` is auto-derived later, but
  // we keep names here as the single source of truth.
  stations: [
    { id: "westgate",  name: "Westgate",     x: 120,  y: 560 },
    { id: "harbor",    name: "Harbor Point", x: 300,  y: 555 },
    { id: "maple",     name: "Maple Ave",    x: 480,  y: 552 },
    { id: "union",     name: "Union Square", x: 800,  y: 550 },
    { id: "techpark",  name: "Tech Park",    x: 1000, y: 548 },
    { id: "riverside", name: "Riverside",    x: 1200, y: 545 },
    { id: "eastfield", name: "Eastfield",    x: 1480, y: 540 },

    { id: "northpoint", name: "Northpoint",  x: 790,  y: 120 },
    { id: "highland",   name: "Highland",    x: 792,  y: 300 },
    { id: "market",     name: "Market St",   x: 805,  y: 760 },
    { id: "southgate",  name: "Southgate",   x: 810,  y: 980 },

    { id: "airport",   name: "Airport",      x: 1450, y: 150 },
    { id: "crestview", name: "Crestview",    x: 1200, y: 320 },
    { id: "garden",    name: "Garden City",  x: 760,  y: 730 },
    { id: "lakeside",  name: "Lakeside",     x: 520,  y: 900 }
  ],

  // Ordered list of station ids per line. `loop: true` closes the path.
  // headway/dwell are in *simulation seconds*; speed is world-units / sim-second.
  lines: [
    {
      id: "red", name: "Red Line", mode: "subway", color: "#e3342f",
      speed: 72, vehicleCount: 4, dwell: 1.4, terminalDwell: 3,
      stations: ["westgate", "harbor", "maple", "union", "techpark", "riverside", "eastfield"]
    },
    {
      id: "blue", name: "Blue Line", mode: "subway", color: "#2d6cff",
      speed: 70, vehicleCount: 3, dwell: 1.4, terminalDwell: 3,
      stations: ["northpoint", "highland", "union", "market", "southgate"]
    },
    {
      id: "green", name: "Green Line", mode: "tram", color: "#1fae5a",
      speed: 56, vehicleCount: 3, dwell: 1.2, terminalDwell: 2.6,
      stations: ["airport", "crestview", "techpark", "garden", "lakeside"]
    },
    {
      id: "yellow", name: "Circle Line", mode: "bus", color: "#f2a900",
      speed: 48, vehicleCount: 4, dwell: 1.1, terminalDwell: 1.1, loop: true,
      stations: ["harbor", "highland", "riverside", "market"]
    }
  ]
};

/* ---- derive helpful indexes used everywhere else ---- */
(function index(net) {
  net.stationsById = {};
  net.stations.forEach(function (s) {
    s.lines = [];          // line ids that call here
    net.stationsById[s.id] = s;
  });
  net.linesById = {};
  net.lines.forEach(function (line) {
    net.linesById[line.id] = line;
    line.stations.forEach(function (sid) {
      var s = net.stationsById[sid];
      if (s && s.lines.indexOf(line.id) === -1) s.lines.push(line.id);
    });
  });
  // A station served by 2+ lines is an interchange.
  net.stations.forEach(function (s) { s.interchange = s.lines.length > 1; });
})(VMAP.network);
