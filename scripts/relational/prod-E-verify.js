// PHASE 5 verify — read prod via the APP store facade in RELATIONAL mode and assert José's
// hand-edits survive. Read-only. NOTE: this local verify connects with the postgres admin
// cred from .env to exercise the SAME relational read path the deployed app uses; the
// deployed app itself now runs as the least-privilege `expressline_app` role (2026-06-26),
// not postgres. The read path/result is identical — only the connecting role differs.
const { loadLocalEnv } = require("../../src/lib/env");
loadLocalEnv();
process.env.STORAGE_DRIVER = "postgres";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.STORAGE_MODE = "relational";
const { assertProd } = require("./prod-guard");
const ref = assertProd(process.env.DATABASE_URL);

(async () => {
  const store = require("../../src/lib/store");
  const db = require("../../src/lib/db");
  store.invalidateShippingDataCache();
  const d = await store.getShippingData(); // relational read path
  const carriers = d.modules.handover.shippingLines || [];
  const yards = d.modules.customs.yards || [];
  const charge = (name, re) => {
    const c = carriers.find((x) => new RegExp(name, "i").test(x.name || "") || new RegExp(name, "i").test(x.id || ""));
    return c && (c.localCharges || []).find((ch) => re.test(ch.concept || "") || re.test(ch.id || ""));
  };
  const cma = charge("cma", /doc|docum/i);
  const kmtc = charge("kmtc", /isd/i);
  const spot = {
    carriers: carriers.length,
    yards: yards.length,
    cmaDocFee: cma ? cma.blRate?.rate : "not-found",
    kmtcIsd: kmtc ? Object.values(kmtc.groupRates || {})[0]?.rate : "not-found",
    zim: !!carriers.find((c) => /zim/i.test(c.name || "")),
    cosco: !!carriers.find((c) => /cosco/i.test(c.name || "")),
    selfBuiltYards: yards.filter((y) => /新场站/.test(y.name || "")).map((y) => y.name),
    emptyShells: carriers.filter((c) => !(c.localCharges && c.localCharges.length)).length,
  };
  console.log("[phase5-verify] relational-read José spot-checks:", JSON.stringify(spot));
  await db.closeDatabase();
  const ok = spot.carriers === 21 && spot.yards === 28 && spot.cmaDocFee === 50 && spot.kmtcIsd === 15 &&
    spot.zim && spot.cosco && spot.selfBuiltYards.length === 2 && spot.emptyShells === 7;
  console.log(`[phase5-verify] HARD GATE — relational read returns correct José data: ${ok ? "PASS ✅" : "FAIL ❌"}`);
  if (!ok) process.exit(2);
})().catch((e) => { console.error("[phase5-verify] ERROR:", e.message); process.exit(1); });
