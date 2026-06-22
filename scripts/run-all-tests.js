// Runs every scripts/*-test.js sequentially in its own child process (so module
// state / env never leaks between suites), prints a pass/fail summary, and exits
// non-zero if ANY suite fails. Wired as `npm run test:all`.
//
// Sequential on purpose: a few suites back up/restore data/shipping-lines.json,
// so parallel runs could clobber each other.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptsDir = __dirname;
const self = path.basename(__filename);

const suites = fs
  .readdirSync(scriptsDir)
  .filter((f) => f.endsWith("-test.js") && f !== self)
  .sort();

if (!suites.length) {
  console.error("run-all-tests: no *-test.js suites found");
  process.exit(1);
}

console.log(`run-all-tests: ${suites.length} suites\n`);

// Safety: force JSON storage for every suite so a suite that exercises the real
// store can NEVER connect to the production DATABASE_URL that src/lib/env loads
// from .env (shouldUseDatabase() is true whenever DATABASE_URL is set and
// STORAGE_DRIVER is unset). Suites that test DB-mode behavior (audit-rmw-cache,
// audit-usage-guard) mock src/lib/db's shouldUseDatabase() in-process, so they
// are unaffected by this env. Without this, a future suite that calls a real
// store DB function would silently hit prod — a latent footgun, not a current
// bug (today no suite both uses the real store AND calls a DB function).
const childEnv = { ...process.env, STORAGE_DRIVER: "json" };

const results = [];
const startedAll = Date.now();

for (const suite of suites) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(scriptsDir, suite)], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: childEnv,
  });
  const ms = Date.now() - started;
  const ok = res.status === 0;
  results.push({ suite, ok, ms });
  if (ok) {
    console.log(`  ✓ ${suite.padEnd(34)} ${ms}ms`);
  } else {
    console.log(`  ✗ ${suite.padEnd(34)} ${ms}ms  (exit ${res.status})`);
    // Surface the failing suite's output so the failure is diagnosable.
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    if (out) {
      console.log(
        out
          .split("\n")
          .slice(-25)
          .map((l) => `      | ${l}`)
          .join("\n")
      );
    }
  }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(
  `\nrun-all-tests: ${passed}/${results.length} suites passed` +
    `${failed ? `, ${failed} FAILED` : ""} (${Date.now() - startedAll}ms)`
);
if (failed) {
  console.log("FAILED: " + results.filter((r) => !r.ok).map((r) => r.suite).join(", "));
  process.exit(1);
}
console.log("run-all-tests-ok");
