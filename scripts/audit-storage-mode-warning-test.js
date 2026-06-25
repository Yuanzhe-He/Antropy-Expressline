// Verifies db.storageModeStartupWarning — the loud startup warning fires ONLY when
// DB mode + populated relational tables + STORAGE_MODE != relational (the state in which
// the app silently reads the possibly-frozen app_state blob instead of the tables).
// Pure function, no DB connection.
const assert = require("node:assert/strict");
const { storageModeStartupWarning } = require("../src/lib/db");

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

// the dangerous combos → warn
assert.match(
  storageModeStartupWarning({ usingDb: true, storageMode: "blob", tablesPopulated: true }) || "",
  /POPULATED but STORAGE_MODE=blob/,
  "DB + populated + blob must warn"
);
ok("DB mode + populated tables + STORAGE_MODE=blob → loud warning");

assert.match(
  storageModeStartupWarning({ usingDb: true, storageMode: "dual", tablesPopulated: true }) || "",
  /STORAGE_MODE=dual/,
  "dual also warns (not relational)"
);
ok("DB mode + populated tables + STORAGE_MODE=dual → warning");

assert.equal(
  storageModeStartupWarning({ usingDb: true, storageMode: undefined, tablesPopulated: true }),
  storageModeStartupWarning({ usingDb: true, storageMode: "blob", tablesPopulated: true }),
  "unset STORAGE_MODE defaults to blob"
);
ok("STORAGE_MODE unset (defaults to blob) + populated → warning");

// consistent / safe states → no warning
assert.equal(
  storageModeStartupWarning({ usingDb: true, storageMode: "relational", tablesPopulated: true }),
  null,
  "relational is the correct mode → no warning"
);
ok("STORAGE_MODE=relational + populated → no warning");

assert.equal(
  storageModeStartupWarning({ usingDb: true, storageMode: "blob", tablesPopulated: false }),
  null,
  "empty tables = genuinely fresh store → no warning"
);
ok("empty tables + blob → no warning (fresh store, nothing to lose)");

assert.equal(
  storageModeStartupWarning({ usingDb: false, storageMode: "blob", tablesPopulated: true }),
  null,
  "JSON/non-DB mode → no warning"
);
ok("non-DB (JSON) mode → no warning");

console.log(`\n[audit-storage-mode-warning] ${passed} assertions PASS ✅`);
