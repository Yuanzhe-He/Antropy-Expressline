// Diagnostic + guard for the forced FX-refresh route
// (POST /admin/:moduleKey/exchange-rates/refresh).
//
// Background: pg_stat_statements + the egress probe showed an external client
// POSTing this route ~every 2s. The FX throttle (15min) + the read cache already
// make each hit harmless to the DB/egress (write 0/min, reads ~cache hits), but
// the HTTP requests keep coming and we don't know the SOURCE — our own frontend
// does NOT poll it (verified: no setInterval/fetch loop in public/ or views/;
// the only caller is a manual button form). Railway's access log would show the
// source but the CLI is unauthenticated (browser login is a user-only action),
// so we capture the source fingerprint IN-APP and expose it at /healthz, which we
// can read directly without Railway access.
//
// Privacy: we record only request metadata — client IP (X-Forwarded-For chain +
// socket IP), User-Agent, Referer, timestamp. NEVER cookies, session ids, auth
// headers, or any secret.
//
// Also provides a cheap min-interval gate so the route can short-circuit the
// (already cheap) refresh work when hammered — defense-in-depth that caps the
// route's work regardless of the FX throttle ("rate-limit the expensive op at its
// trigger"). Pure in-memory, no DB writes. Daily reset for the counters.

const MAX_RECENT = 30; // ring buffer size for recent raw hits
const MAX_UA_LEN = 200; // truncate UA/Referer so /healthz stays small

function routeMinIntervalMs() {
  const parsed = Number(process.env.REFRESH_ROUTE_MIN_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

let nowOverride = null;
function now() {
  return nowOverride === null ? Date.now() : nowOverride;
}
function todayKey() {
  return new Date(now()).toISOString().slice(0, 10);
}

const state = {
  date: todayKey(),
  totalHitsToday: 0,
  lastHitAt: null, // ISO of the last route hit (any)
  lastRefreshDoneAt: 0, // epoch ms of the last NON-skipped refresh (for the gate)
  skippedToday: 0, // hits short-circuited by the min-interval gate
  recent: [], // ring buffer of the last MAX_RECENT raw hits
  sources: new Map(), // fingerprint -> { ip, ua, referer, count, firstSeen, lastSeen }
};

function rollDay() {
  const today = todayKey();
  if (today !== state.date) {
    state.date = today;
    state.totalHitsToday = 0;
    state.skippedToday = 0;
    state.recent = [];
    state.sources = new Map();
    // lastHitAt / lastRefreshDoneAt intentionally persist across the boundary.
  }
}

function clip(value) {
  const s = String(value == null ? "" : value);
  return s.length > MAX_UA_LEN ? `${s.slice(0, MAX_UA_LEN)}…` : s;
}

// Build the best-effort client IP view from an Express req without needing the
// app-wide "trust proxy" setting. Railway sits behind a proxy, so the real client
// is the first hop of X-Forwarded-For; we keep the whole chain + the socket IP.
function describeRequest(req) {
  const xff = req.headers["x-forwarded-for"];
  return {
    ip: clip(Array.isArray(xff) ? xff.join(",") : xff || req.ip || req.socket?.remoteAddress || ""),
    ua: clip(req.headers["user-agent"] || ""),
    referer: clip(req.headers.referer || req.headers.referrer || ""),
  };
}

// Record one hit on the refresh route. `meta` = { ip, ua, referer } (no secrets).
function record(meta) {
  rollDay();
  const at = new Date(now()).toISOString();
  state.totalHitsToday += 1;
  state.lastHitAt = at;

  const entry = { at, ip: meta.ip || "", ua: meta.ua || "", referer: meta.referer || "" };
  state.recent.push(entry);
  if (state.recent.length > MAX_RECENT) {
    state.recent.shift();
  }

  const key = `${entry.ip}|${entry.ua}|${entry.referer}`;
  const existing = state.sources.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = at;
  } else {
    state.sources.set(key, {
      ip: entry.ip,
      ua: entry.ua,
      referer: entry.referer,
      count: 1,
      firstSeen: at,
      lastSeen: at,
    });
  }
}

// True when the last NON-skipped refresh was within the min-interval — the route
// should short-circuit (skip loadShippingData) but still record + redirect.
function shouldThrottleRoute() {
  return now() - state.lastRefreshDoneAt < routeMinIntervalMs();
}

function markRefreshDone() {
  state.lastRefreshDoneAt = now();
}

function noteSkipped() {
  rollDay();
  state.skippedToday += 1;
}

// Snapshot for /healthz. Sources sorted by count desc so the loudest is first.
function getStatus() {
  rollDay();
  const sources = [...state.sources.values()].sort((a, b) => b.count - a.count);
  return {
    date: state.date,
    routeMinIntervalMs: routeMinIntervalMs(),
    totalHitsToday: state.totalHitsToday,
    skippedToday: state.skippedToday,
    lastHitAt: state.lastHitAt,
    distinctSourceCount: sources.length,
    sources,
    recent: state.recent,
  };
}

function __setNowForTest(ms) {
  nowOverride = ms;
}
function __resetForTest() {
  nowOverride = null;
  state.date = todayKey();
  state.totalHitsToday = 0;
  state.skippedToday = 0;
  state.lastHitAt = null;
  state.lastRefreshDoneAt = 0;
  state.recent = [];
  state.sources = new Map();
}

module.exports = {
  describeRequest,
  record,
  shouldThrottleRoute,
  markRefreshDone,
  noteSkipped,
  getStatus,
  __setNowForTest,
  __resetForTest,
};
