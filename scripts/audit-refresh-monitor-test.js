// refresh-monitor regression. The monitor captures the SOURCE of hits on the
// forced FX-refresh route (the external ~2s poller) so it can be identified at
// /healthz and stopped at origin, and provides a min-interval gate so a hammered
// route short-circuits its (already cheap) refresh work. It must capture only
// non-secret metadata (IP/UA/Referer — never cookies/auth), aggregate distinct
// sources, cap memory, gate by interval, and reset daily.

const assert = require("node:assert/strict");

process.env.REFRESH_ROUTE_MIN_INTERVAL_MS = "5000";
const mon = require("../src/lib/refresh-monitor");

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

function fakeReq(headers, extra = {}) {
  return { headers, ip: extra.ip, socket: { remoteAddress: extra.remoteAddress } };
}

function main() {
  // describeRequest: pulls IP (X-Forwarded-For chain) / UA / Referer, and NOTHING
  // else — no cookies, no authorization, no session.
  mon.__resetForTest();
  const meta = mon.describeRequest(
    fakeReq({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "user-agent": "PollerBot/1.0",
      referer: "https://example.test/admin/handover/settings",
      cookie: "session=SUPER_SECRET_VALUE",
      authorization: "Bearer TOPSECRET",
    })
  );
  assert.equal(meta.ip, "203.0.113.7, 10.0.0.1", "captures the X-Forwarded-For chain");
  assert.equal(meta.ua, "PollerBot/1.0", "captures User-Agent");
  assert.equal(meta.referer, "https://example.test/admin/handover/settings", "captures Referer");
  const serialized = JSON.stringify(meta);
  assert.ok(!/SUPER_SECRET_VALUE/.test(serialized), "does NOT capture cookie value");
  assert.ok(!/TOPSECRET/.test(serialized), "does NOT capture authorization");
  assert.ok(!("cookie" in meta) && !("authorization" in meta), "no secret fields on meta");
  ok("describeRequest: captures IP/UA/Referer only — never cookies/auth");

  // record: aggregates distinct sources with counts; falls back to socket IP.
  mon.__resetForTest();
  mon.__setNowForTest(1_000_000);
  for (let i = 0; i < 18; i += 1) mon.record({ ip: "203.0.113.7", ua: "PollerBot/1.0", referer: "" });
  mon.record({ ip: "198.51.100.2", ua: "Mozilla/5.0", referer: "https://app/settings" });
  let s = mon.getStatus();
  assert.equal(s.totalHitsToday, 19, "counts every hit");
  assert.equal(s.distinctSourceCount, 2, "aggregates distinct sources");
  assert.equal(s.sources[0].ip, "203.0.113.7", "loudest source sorted first");
  assert.equal(s.sources[0].count, 18, "loudest source count correct");
  ok("record: aggregates distinct sources, sorted by count, totals correct");

  // ring buffer caps recent raw hits (memory bound).
  mon.__resetForTest();
  mon.__setNowForTest(2_000_000);
  for (let i = 0; i < 50; i += 1) mon.record({ ip: `10.0.0.${i}`, ua: "x", referer: "" });
  s = mon.getStatus();
  assert.ok(s.recent.length <= 30, "recent ring buffer capped at 30");
  assert.equal(s.totalHitsToday, 50, "total still counts all hits beyond the ring");
  ok("record: recent ring buffer is memory-bounded, totals still accurate");

  // min-interval gate: throttle within window after a refresh, open after it.
  mon.__resetForTest();
  mon.__setNowForTest(3_000_000);
  assert.equal(mon.shouldThrottleRoute(), false, "first hit not throttled (no prior refresh)");
  mon.markRefreshDone();
  mon.__setNowForTest(3_000_000 + 2000); // 2s later, within 5s window
  assert.equal(mon.shouldThrottleRoute(), true, "hammered within min-interval -> throttle");
  mon.noteSkipped();
  mon.__setNowForTest(3_000_000 + 6000); // 6s later, past the window
  assert.equal(mon.shouldThrottleRoute(), false, "past min-interval -> allowed again");
  assert.equal(mon.getStatus().skippedToday, 1, "skipped hits are counted");
  ok("route gate: throttles within min-interval, opens after, counts skips");

  // daily reset of per-day counters + source map.
  mon.__resetForTest();
  mon.__setNowForTest(Date.parse("2026-06-21T10:00:00Z"));
  for (let i = 0; i < 5; i += 1) mon.record({ ip: "203.0.113.7", ua: "PollerBot/1.0", referer: "" });
  assert.equal(mon.getStatus().totalHitsToday, 5, "day-1 hits counted");
  mon.__setNowForTest(Date.parse("2026-06-22T00:01:00Z"));
  mon.record({ ip: "203.0.113.7", ua: "PollerBot/1.0", referer: "" });
  s = mon.getStatus();
  assert.equal(s.totalHitsToday, 1, "counters reset on the new day");
  assert.equal(s.distinctSourceCount, 1, "source map reset on the new day");
  ok("daily reset: per-day counters + source map reset at the day boundary");

  console.log(`\naudit-refresh-monitor-test: ${passed}/${passed} passed`);
  console.log("audit-refresh-monitor-test-ok");
}

main();
