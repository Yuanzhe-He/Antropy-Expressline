// PART 2 — verify the LIVE relational WRITE path on prod via the app's real store facade
// (as postgres, STORAGE_MODE=relational — identical code to the deployed app). Makes a
// benign, reversible edit to ONE low-risk empty-shell carrier's customsNote, confirms it
// landed in the TABLES (relational read-back), then restores the exact original (try/finally).
// Also confirms the exchange_rates TABLE is fresh (FX is being written in relational mode).
// Writes ONLY entity tables (never the app_state shipping-data blob).
const { loadLocalEnv } = require("../../src/lib/env");
loadLocalEnv();
process.env.STORAGE_DRIVER = "postgres";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.STORAGE_MODE = "relational";
const { assertProd } = require("./prod-guard");
const ref = assertProd(process.env.DATABASE_URL);
const TARGET = "hmm"; // empty-shell carrier (no charges) — lowest-risk benign target
const MARKER = "WRITE-ROUNDTRIP-PROBE-2026-06-24";

(async () => {
  const store = require("../../src/lib/store");
  const db = require("../../src/lib/db");
  console.log(`[write-rt] ref=${ref} (PROD) STORAGE_MODE=relational via store facade (postgres)`);

  store.invalidateShippingDataCache();
  const data = await store.getShippingData();
  const carriers = data.modules.handover.shippingLines || [];
  const target = carriers.find((c) => c.id === TARGET) || carriers.find((c) => !(c.localCharges || []).length) || carriers[carriers.length - 1];
  if (!target) throw new Error("[write-rt] no target carrier found");
  const origNote = target.customsNote;
  console.log(`[write-rt] target carrier=${target.id} (${target.name}); original customsNote=${JSON.stringify(origNote)}`);

  let landed = false, restored = false;
  try {
    // mutate via the real write path
    target.customsNote = MARKER;
    await store.saveCarrier(target);
    store.invalidateShippingDataCache();
    const after = (await store.getShippingData()).modules.handover.shippingLines.find((c) => c.id === target.id);
    landed = after && after.customsNote === MARKER;
    console.log(`[write-rt] after saveCarrier(marker) → relational read-back customsNote=${JSON.stringify(after?.customsNote)} → landed in tables: ${landed ? "YES ✅" : "NO ❌"}`);
  } finally {
    // ALWAYS restore the exact original
    const fresh = (await store.getShippingData()).modules.handover.shippingLines.find((c) => c.id === target.id);
    if (fresh) {
      fresh.customsNote = origNote;
      await store.saveCarrier(fresh);
      store.invalidateShippingDataCache();
      const back = (await store.getShippingData()).modules.handover.shippingLines.find((c) => c.id === target.id);
      restored = JSON.stringify(back?.customsNote) === JSON.stringify(origNote);
      console.log(`[write-rt] restored original customsNote → ${restored ? "RESTORED ✅" : "RESTORE FAILED ❌ now=" + JSON.stringify(back?.customsNote)}`);
    }
  }

  // FX table freshness: relational read FX (from table) vs frozen blob FX
  process.env.STORAGE_MODE = "blob";
  store.invalidateShippingDataCache();
  const blobFx = (await store.getShippingData()).exchangeRates || {};
  process.env.STORAGE_MODE = "relational";
  store.invalidateShippingDataCache();
  const relFx = (await store.getShippingData()).exchangeRates || {};
  const tableFresh = String(relFx.lastCheckedAt || "") >= String(blobFx.lastCheckedAt || "");
  console.log(`[write-rt] FX lastCheckedAt — table(relational)=${relFx.lastCheckedAt} vs frozen blob=${blobFx.lastCheckedAt}`);
  console.log(`[write-rt] exchange_rates TABLE is fresh (>= frozen blob; FX written in relational mode): ${tableFresh ? "YES ✅" : "NO ❌"}`);

  await db.closeDatabase();
  const gatePass = landed && restored && tableFresh;
  console.log(`\n[write-rt] HARD GATE — live write round-trip landed+restored + FX table fresh: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  if (!gatePass) process.exit(2);
})().catch((e) => { console.error("[write-rt] ERROR:", e.message); process.exit(1); });
