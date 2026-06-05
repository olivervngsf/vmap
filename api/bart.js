/*
 * /api/bart — serverless proxy to the real BART API (api.bart.gov).
 *
 * Why a proxy: BART's API has no CORS headers (so the browser can't call it
 * directly) and uses a key we don't want to ship in client code. Vercel's
 * servers can reach BART, inject the key from an env var (falling back to
 * BART's public demo key), and return JSON with permissive CORS.
 *
 * Query:
 *   ?type=etd&orig=ABBR        real-time departures (ABBR or ALL)
 *   ?type=sched&orig=X&dest=Y  trip planner: multiple departures + fares + legs
 *   ?type=fare&orig=X&dest=Y   fare between two stations
 *   ?type=bsa                  service advisories
 *   ?type=routes               line list + colors
 */
const ENDPOINTS = {
  etd:       { path: "etd.aspx",   base: { cmd: "etd" },       q: { orig: "orig" } },
  stns:      { path: "stns.aspx",  base: { cmd: "stns" },      q: {} },
  routes:    { path: "route.aspx", base: { cmd: "routes" },    q: {} },
  routeinfo: { path: "route.aspx", base: { cmd: "routeinfo" }, q: { route: "route" } },
  sched:     { path: "sched.aspx", base: { cmd: "depart", date: "now", b: "0", a: "4", l: "1" }, q: { orig: "orig", dest: "dest", date: "date", time: "time" } },
  fare:      { path: "sched.aspx", base: { cmd: "fare", date: "now" }, q: { orig: "orig", dest: "dest" } },
  bsa:       { path: "bsa.aspx",   base: { cmd: "bsa" },       q: {} },
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const q = req.query || {};
  const ep = ENDPOINTS[q.type || "etd"];
  if (!ep) { res.status(400).json({ error: "unknown type" }); return; }

  const key = process.env.BART_API_KEY || "MW9S-E7SL-26DU-VV8V"; // public demo key
  const params = new URLSearchParams(Object.assign({}, ep.base, { key, json: "y" }));
  for (const [param, qname] of Object.entries(ep.q)) {
    if (q[qname]) params.set(param, q[qname]);
  }
  if ((q.type || "etd") === "etd" && !params.get("orig")) params.set("orig", "ALL");

  const url = `https://api.bart.gov/api/${ep.path}?${params.toString()}`;
  try {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { res.status(502).json({ error: "bad upstream response" }); return; }
    // edge-cache real-time briefly to stay well under any rate limits
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "upstream fetch failed: " + (e && e.message) });
  }
};
