// Application-layer usage guard for app_state DB I/O.
//
// Why: the FX write storm + the RMW read storm both ran for days before anyone
// noticed — the only signal was the month-end Supabase bill. A managed store's
// free tier has no real-time, fine-grained usage alert, so we add our own: a
// pure in-memory counter of how many times today we actually hit the DB, that
// screams in the Railway logs and auto-degrades the runaway behavior (NOT the
// whole service) the moment volume goes abnormal — "stop + leave evidence at the
// scene" instead of "find out at the month-end bill". (Framework: expensive-op
// -throttle.md mode 3.)
//
// Design rules:
//   - Pure memory, per-process. It MUST NOT write to the DB to count (that would
//     re-create the very storm it guards against). Process restart resets it;
//     that's fine — the read cache TTL + the FX throttle are the real floors,
//     this is the alarm on top.
//   - Reads counted here are DB-PENETRATION reads only: the read cache lives in
//     store.js, so a cache hit never reaches db.getAppState() and is never
//     counted. Normal volume under a 1h cache TTL is ~24 read-misses/day, so the
//     default 200/day threshold has wide headroom and will not false-alarm.
//   - Degrade the runaway behavior, not the service: an AUTO write (FX refresh)
//     over threshold is dropped (FX keeps serving from cache); a USER write
//     (admin editing rates / creating a carrier) is always allowed through, just
//     counted + logged. A read storm extends the read cache TTL floor to clamp
//     egress.
//   - Alerts are deduped (loud once, then at most once per interval) so the
//     alarm itself cannot become a log storm.
//
// All thresholds/intervals are read from env at call time so they can be tuned
// without a redeploy. Time is injectable (__setNowForTest) for deterministic
// tests; nothing else needs mocking.

function envInt(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readThreshold() {
  return envInt("APP_STATE_READ_WARN_THRESHOLD", 200);
}
function writeThreshold() {
  return envInt("APP_STATE_WRITE_WARN_THRESHOLD", 500);
}
function severeReadMultiplier() {
  return envInt("APP_STATE_READ_SEVERE_MULTIPLIER", 5);
}
function alertIntervalMs() {
  return envInt("APP_STATE_GUARD_ALERT_INTERVAL_MS", 5 * 60 * 1000);
}
function degradeReadTtlFloorMs() {
  return envInt("APP_STATE_GUARD_DEGRADE_TTL_MS", 60 * 60 * 1000);
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
  reads: 0, // DB-penetration reads of app_state today
  writes: 0, // app_state writes today (saveAppState + patchAppStateField)
  readAlerts: 0,
  writeAlerts: 0,
  lastReadAlertAt: 0,
  lastWriteAlertAt: 0,
  triggeredToday: false, // any alert fired today (health check / admin signal)
  autoWritesDegraded: 0, // FX/auto writes dropped by the guard today
};

// Reset counters at the day boundary so the threshold is a per-day budget.
function rollDay() {
  const today = todayKey();
  if (today !== state.date) {
    state.date = today;
    state.reads = 0;
    state.writes = 0;
    state.readAlerts = 0;
    state.writeAlerts = 0;
    state.lastReadAlertAt = 0;
    state.lastWriteAlertAt = 0;
    state.triggeredToday = false;
    state.autoWritesDegraded = 0;
  }
}

// Loud, deduped alert. First crossing fires immediately; after that at most once
// per alertIntervalMs, so the alarm cannot itself flood the logs.
function maybeAlert(kind) {
  const isRead = kind === "read";
  const count = isRead ? state.reads : state.writes;
  const threshold = isRead ? readThreshold() : writeThreshold();
  if (count < threshold) {
    return;
  }
  const lastAt = isRead ? state.lastReadAlertAt : state.lastWriteAlertAt;
  const t = now();
  if (lastAt !== 0 && t - lastAt < alertIntervalMs()) {
    return; // within dedup window
  }
  if (isRead) {
    state.lastReadAlertAt = t;
    state.readAlerts += 1;
  } else {
    state.lastWriteAlertAt = t;
    state.writeAlerts += 1;
  }
  state.triggeredToday = true;
  const degrade = isRead
    ? state.reads >= threshold * severeReadMultiplier()
      ? "extend read-cache TTL floor"
      : "monitoring (not yet severe)"
    : "drop AUTO writes (FX), pass USER writes";
  console.error(
    `[USAGE-GUARD-ALERT] app_state DB ${kind}s today=${count} exceeded threshold=${threshold} ` +
      `(window=${state.date}) — degrading: ${degrade}`
  );
}

// Count a DB-penetration read (call from db.getAppState). Cache hits never reach
// here, so this is exactly the egress-driving read volume.
function recordRead() {
  rollDay();
  state.reads += 1;
  maybeAlert("read");
}

// Count an app_state write (call from db.saveAppState + db.patchAppStateField).
function recordWrite() {
  rollDay();
  state.writes += 1;
  maybeAlert("write");
}

// Degrade decision for AUTO (machine-driven) writes — the FX refresh. Over the
// write threshold the auto-writer should stop writing and keep serving cache.
// USER writes never consult this; they always proceed.
function shouldDegradeAutoWrite() {
  rollDay();
  return state.writes >= writeThreshold();
}

// Note an auto write that the caller decided to drop (for status/visibility).
function noteAutoWriteDegraded() {
  rollDay();
  state.autoWritesDegraded += 1;
}

// Read-storm degrade: when DB reads go severely abnormal (cache being defeated),
// callers extend the read cache TTL to this floor to clamp egress.
function shouldExtendReadCache() {
  rollDay();
  return state.reads >= readThreshold() * severeReadMultiplier();
}
function getReadCacheTtlFloorMs() {
  return degradeReadTtlFloorMs();
}

// Snapshot for /healthz, admin, and startup logging. No secrets.
function getStatus() {
  rollDay();
  return {
    date: state.date,
    reads: state.reads,
    writes: state.writes,
    readThreshold: readThreshold(),
    writeThreshold: writeThreshold(),
    readAlerts: state.readAlerts,
    writeAlerts: state.writeAlerts,
    autoWritesDegraded: state.autoWritesDegraded,
    triggeredToday: state.triggeredToday,
    degradeAutoWriteActive: shouldDegradeAutoWrite(),
    extendReadCacheActive: shouldExtendReadCache(),
  };
}

// One-line config summary for the startup log (so Railway shows the guardrails).
function describeConfig() {
  return (
    `usage-guard: read-warn=${readThreshold()}/day write-warn=${writeThreshold()}/day ` +
    `severe=${severeReadMultiplier()}x alert-interval=${Math.round(alertIntervalMs() / 1000)}s ` +
    `degrade-ttl-floor=${Math.round(getReadCacheTtlFloorMs() / 1000)}s`
  );
}

// --- test hooks (not used in production paths) ------------------------------
function __setNowForTest(ms) {
  nowOverride = ms;
}
function __resetForTest() {
  nowOverride = null;
  state.date = todayKey();
  state.reads = 0;
  state.writes = 0;
  state.readAlerts = 0;
  state.writeAlerts = 0;
  state.lastReadAlertAt = 0;
  state.lastWriteAlertAt = 0;
  state.triggeredToday = false;
  state.autoWritesDegraded = 0;
}

module.exports = {
  recordRead,
  recordWrite,
  shouldDegradeAutoWrite,
  noteAutoWriteDegraded,
  shouldExtendReadCache,
  getReadCacheTtlFloorMs,
  getStatus,
  describeConfig,
  __setNowForTest,
  __resetForTest,
};
