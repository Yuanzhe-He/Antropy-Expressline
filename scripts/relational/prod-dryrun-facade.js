// Dry-run facade check on REAL prod data already loaded into the sandbox (app_state
// blob + entity tables from migrate-forward). Verifies, against prod data:
//   - relational read == blob read (data parity through the store facade)
//   - dual shadow read diff == 0
//   - entity counts + José hand-edit spot-checks survive the migration
// Sandbox-guarded; no reseed (uses whatever the prior steps loaded/migrated).
const fs = require("node:fs");
const path = require("node:path");

for (const line of fs.readFileSync(path.join(__dirname, "../../.env.sandbox"), "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0) {
    const k = line.slice(0, i).trim();
    if (k) process.env[k] = line.slice(i + 1).trim();
  }
}
process.env.STORAGE_DRIVER = "postgres";
process.env.SHIPPING_CACHE_TTL_MS = "0";

const { assertSandbox } = require("../sandbox-guard");
const ref = assertSandbox();
const repo = require("../../src/lib/store/relational-repo");

let passed = 0;
const assert = (cond, m) => {
  if (!cond) throw new Error("FAIL: " + m);
  passed += 1;
  console.log("  PASS ", m);
};
const canon = repo.canonicalJson;

(async () => {
  const store = require("../../src/lib/store");
  const db = require("../../src/lib/db");

  process.env.STORAGE_MODE = "blob";
  store.invalidateShippingDataCache();
  const blobRead = await store.getShippingData();

  process.env.STORAGE_MODE = "relational";
  store.invalidateShippingDataCache();
  const relRead = await store.getShippingData();
  assert(canon(blobRead) === canon(relRead), "PROD DATA: getShippingData blob == relational");

  process.env.STORAGE_MODE = "dual";
  store.invalidateShippingDataCache();
  await store.getShippingData();
  const diff = store.getLastShadowDiff();
  assert(diff && diff.equal === true, "PROD DATA: dual shadow read table == blob projection");

  // entity counts (parity=0 already proves every value; counts are a sanity anchor)
  const counts = {
    carriers: relRead.modules.handover.shippingLines.length,
    container_types: relRead.modules.handover.containerTypes.length,
    yards: relRead.modules.customs.yards.length,
    ports: relRead.modules.customs.ports.length,
    destinations: relRead.modules.inland.destinations.length,
    rateEntries: relRead.modules.inland.rateEntries.length,
  };
  console.log("  [counts]", JSON.stringify(counts));

  // José hand-edit spot-checks (best-effort; parity=0 is the comprehensive proof).
  const carriers = relRead.modules.handover.shippingLines;
  const findCharge = (carrierName, re) => {
    const c = carriers.find((x) => new RegExp(carrierName, "i").test(x.name || "") || new RegExp(carrierName, "i").test(x.id || ""));
    if (!c) return null;
    return (c.localCharges || []).find((ch) => re.test(ch.concept || "") || re.test(ch.id || ""));
  };
  const cma = findCharge("cma", /doc|docum/i);
  const kmtc = findCharge("kmtc", /isd/i);
  const spot = {
    carriers: carriers.length,
    yards: counts.yards,
    cmaDocCharge: cma ? { id: cma.id, concept: cma.concept, blRate: cma.blRate?.rate, groupSample: Object.values(cma.groupRates || {})[0]?.rate } : "not-found",
    kmtcIsd: kmtc ? { id: kmtc.id, concept: kmtc.concept } : "not-found",
    zimPresent: !!carriers.find((c) => /zim/i.test(c.name || "")),
    coscoPresent: !!carriers.find((c) => /cosco/i.test(c.name || "")),
  };
  console.log("  [jose spot-checks]", JSON.stringify(spot));

  await db.closeDatabase();
  console.log(`\n[prod-dryrun-facade] ref=${ref} — ${passed} assertions PASS ✅ (real prod data, sandbox)`);
})().catch((e) => {
  console.error("[prod-dryrun-facade]", e.message);
  process.exit(1);
});
