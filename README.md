# BART Live Map

An interactive, **real-time map of the San Francisco Bay Area's BART system**.
It draws the real network (all 50 stations, the six color lines, real
coordinates), animates trains along the lines, shows **live departures** from
the official BART API when you click a station, and includes a **trip planner**
that tells you which trains to take and where to transfer.

> Built on the real **BART API** (`api.bart.gov`). The map and the train
> animation are schematic; the **departures board** and the planner's
> next-train estimate are live real-time data.

## Architecture

Static front-end (vanilla JS + Canvas, zero build step) plus one Vercel
serverless function that proxies the BART API.

```
index.html
css/styles.css
js/
  bart-data.js    Baked real BART data: 50 stations (lat/lon) + the 6 color-line configs.
  network.js      Projects lat/lon -> world space; assembles the network graph.
  geometry.js     Polyline math (distance <-> position along a line).
  simulation.js   Ambient (schematic) train animation along the lines.
  routing.js      Trip planner: Dijkstra over (station, line) with a transfer penalty.
  live.js         Client for the real-time API (via the proxy).
  renderer.js     Canvas drawing: parallel-offset lines, stations, trains, camera.
  app.js          UI wiring: legend, planner, live departures board, input loop.
api/
  bart.js         Serverless proxy -> api.bart.gov (adds CORS, injects the key).
```

### Why a proxy?

BART's API has no CORS headers (the browser can't call it directly) and uses an
API key. `api/bart.js` runs on Vercel's servers, injects the key from the
`BART_API_KEY` env var (falling back to BART's public demo key), and returns
JSON with permissive CORS. The client calls `/api/bart?type=etd&orig=POWL`.

## Features

- **Real BART network** — real stations and the six color lines (Yellow,
  Red, Orange, Green, Blue, and the Beige OAK Airport connector), drawn as
  parallel rails so shared trunks (the Transbay tube, downtown SF) stay legible.
- **Live departures** — click any station for its real-time board: destination,
  minutes, direction/platform, car count, bikes, and delays. Auto-refreshes.
- **Trip planner** — pick a start and destination (from the panel or by clicking
  stations) for a step-by-step itinerary: which line to board, the direction,
  how many stops, where to transfer, estimated time, and a live "next train"
  for the first leg.
- **Animated trains** + pan / zoom / line focus, keyboard shortcuts
  (`space`, `+`/`−`, arrows, `R`).

## Run locally

```bash
# Static map, planner and animation work from disk, but live departures need
# the serverless proxy, so use the Vercel dev server:
npx vercel dev          # then open the printed localhost URL
# (Just opening index.html also works — the live board shows a "deploy to
#  enable" note instead of real-time data.)
```

## Deploy

Deploys as a static site + serverless function on Vercel (no config needed).
Optionally set `BART_API_KEY` in the project's environment variables to use your
own BART key instead of the public demo key.

## Data & attribution

Real-time data © BART, via the public BART API. This is an independent demo and
is not affiliated with or endorsed by BART. Station coordinates and line orders
reflect BART's published network; the on-screen geometry is schematic.
