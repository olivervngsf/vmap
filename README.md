# Veridia Transit — Virtual Transportation Map (POC)

An interactive **proof-of-concept transit map** for the web. It simulates a
fictional city's metro/tram/bus network — with trains that move in real time —
and a phone-style **trip planner** that gives you step-by-step directions
(which line to board, where to transfer, how many stops). No Google Maps, no
GPS, no API keys, no build step: it's a self-contained virtual map.

## Run it

Just open `index.html` in any modern browser.

```bash
# or serve it (optional)
python3 -m http.server 8000   # then visit http://localhost:8000
```

## What you can do

- **Watch the network live** — 14 vehicles across 4 lines stop-and-go along
  their routes, reverse at terminals, and loop on the Circle Line. Use the
  bottom bar to play/pause and change simulation speed (1×–20×).
- **Click a station** → live arrivals board (next trains + countdowns), the
  lines it serves, and buttons to set it as your trip start/destination.
- **Click a train** → its line, destination (headsign), next stop, status, and
  occupancy.
- **Plan a trip** — pick a *From* and *To* station (from the panel or by
  clicking stations on the map) and hit **Get directions**. You get:
  - total journey time, number of rides and transfers,
  - a turn-by-turn itinerary (board line → ride N stops → transfer → …),
  - a **live "departs in" countdown** for the first train,
  - the route highlighted on the map with A/B pins.
- **Navigate** — drag to pan, scroll to zoom, toggle/focus lines in the legend.
  Keyboard: `space` play/pause, `+`/`−` zoom, arrows pan, `R` reset view.

## How it's built (zero dependencies)

Plain HTML + CSS + vanilla JS rendering to a single `<canvas>`.

| File | Responsibility |
|------|----------------|
| `js/network.js`    | Declarative description of the city: stations, lines, geography. Single source of truth. |
| `js/geometry.js`   | Turns each line into a measurable polyline (distance ↔ world position). |
| `js/simulation.js` | The moving network: vehicles, dwell at stops, live arrivals & departures, the clock. |
| `js/routing.js`    | Journey planner — Dijkstra over `(station, line)` states with a transfer penalty, collapsed into ride/transfer steps. |
| `js/renderer.js`   | All Canvas drawing + the pan/zoom camera and hit-testing. |
| `js/app.js`        | Wires it together: UI panels, input, the animation loop. |

To reshape the city — add lines, stations, or change speeds — edit
`js/network.js`; everything else derives from it.

## Notes

Times are in *network seconds* and shown as live countdowns so you can watch the
system tick. It's a demonstration model, not a scheduled timetable.
