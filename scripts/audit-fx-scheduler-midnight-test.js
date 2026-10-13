// FX scheduler midnight regression (2026-10-12). Production logged
// "Exchange rates refreshed" every second instead of once a day: on Node <= 20,
// Intl with `hour12: false` formats midnight as "24", so getNextRefreshAt()
// returned a time in the PAST and the scheduler re-fired after its 1s floor.
// Pure date math only: no network, no store writes.

const assert = require("node:assert/strict");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";

const { getNextRefreshAt } = require("../src/lib/exchange-rate-scheduler");

const opts = { timeZone: "America/Mexico_City", hour: 0, minute: 0 }; // UTC-6, no DST
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS ", m); };

const cases = [
  ["afternoon -> tonight's midnight", "2026-10-12T22:11:00Z", "2026-10-13T06:00:00.000Z"],
  ["30s before midnight -> that midnight", "2026-10-13T05:59:30Z", "2026-10-13T06:00:00.000Z"],
  ["just after the midnight run -> next midnight", "2026-10-13T06:00:00.500Z", "2026-10-14T06:00:00.000Z"],
  ["00:30 -> next midnight", "2026-10-13T06:30:00Z", "2026-10-14T06:00:00.000Z"],
  ["month end -> first of next month", "2026-10-31T20:00:00Z", "2026-11-01T06:00:00.000Z"],
];

for (const [label, now, expected] of cases) {
  const next = getNextRefreshAt(new Date(now), opts);
  assert.equal(next.toISOString(), expected, label);
  assert.ok(next.getTime() > new Date(now).getTime(), `${label}: next run must be in the future`);
  ok(`${label} (${now} -> ${expected})`);
}

// Every minute of a whole day must schedule a run 0-24h ahead, never in the past.
const dayStart = Date.parse("2026-10-12T06:00:00Z");
for (let minute = 0; minute < 24 * 60; minute += 1) {
  const now = new Date(dayStart + minute * 60 * 1000 + 1);
  const delay = getNextRefreshAt(now, opts).getTime() - now.getTime();
  assert.ok(delay > 0 && delay <= 24 * 3600 * 1000, `delay out of range at ${now.toISOString()}: ${delay}`);
}
ok("every minute of a day schedules the next run 0-24h ahead");

console.log(`\naudit-fx-scheduler-midnight-test: ${passed}/${passed} passed (node ${process.version})`);
console.log("audit-fx-scheduler-midnight-test-ok");
