# Design debt

Known shortcuts / things to revisit. Tracked here so they're visible instead of
forgotten. Roughly ordered by user impact.

## Trip detail

- **Intermediate stop times are interpolated, not real.** BART's schedule API
  (`sched.aspx`) returns times only for each leg's *endpoints* (board + exit).
  The times shown for in-between stops are linearly interpolated across the
  leg's window, so they're approximate (real spacing between stops isn't even).
  Fix: use BART GTFS `stop_times` for exact per-stop times.
- **Platform comes from real-time ETD, best-effort.** We match each boarding
  station's live `etd` to the leg by the train's head station to get the
  platform. If there's no live data (offline / proxy down) or no matching
  upcoming train (e.g. planning far ahead), the platform shows "platform…" and
  never resolves. Transfer-leg platforms depend on live data at that station.
  Fix: fall back to a static platform map per (station, direction).
- **"toward [terminus]" uses the schedule's `trainHeadStation`.** Usually the
  right headsign, but BART occasionally short-turns; the live headsign can
  differ from the scheduled one.

## Map / camera

- **Reset (fit) ignores the panel inset.** `renderer.fit()` centers the whole
  network in the *full* window, so on desktop part of it sits behind the
  floating panel after a Reset. The selection framing (`flyToStation` / `flyTo
  Route`) is panel-aware; `fit()` isn't, for simplicity.
- **Mobile sheet auto-peeks on route.** When both endpoints are chosen we drop
  the sheet to peek so the route is visible. If the user had deliberately
  expanded it to read, that gets collapsed.

## Data

- **Station codes are our own numbering, not BART's.** Letter = line colour
  initial (Blue=B … Yellow=Y, Beige OAK shuttle=K); number = 1-based position
  from the start to the end of *our* `line.stations` order. These are not BART's
  official station IDs and the start end may differ from BART's canonical
  direction.

## Build / tooling

- **Tailwind is vendored, not built on deploy.** The Tailwind Play CDN is
  blocked in the build sandbox, so `css/tailwind.css` is a committed, compiled
  artifact. After adding/removing Tailwind utility classes you must re-run
  `npm run build:css` and commit the result, or the new classes won't have CSS.
