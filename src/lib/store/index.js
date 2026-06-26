// store (public entry): persistence (JSON / Postgres via ../db) + in-process read
// cache + targeted writes, wrapping the normalizers in ./normalize-shipping-data.
// Public API identical to the pre-split store.js — callers are unchanged.

const fs = require("node:fs/promises");
const path = require("node:path");
const { loadLocalEnv } = require("../env");
const usageGuard = require("../usage-guard");
const {
  getAppState,
  getShippingTablesAssembled,
  patchAppStateField,
  saveAppState,
  saveCarrierEntity,
  saveCustomsYardEntity,
  saveExchangeRatesTable,
  saveInlandRateEntryEntity,
  saveModuleTables,
  saveShippingTables,
  shouldUseDatabase,
} = require("../db");
const { canonicalJson } = require("../db/relational-repo");
const {
  normalizeExchangeRates,
  // re-exported as part of the public API (defined in ./shared):
  formatDemurrageRuleLabel,
  parseDemurrageRange,
  RATE_GROUP_NAMES,
} = require("./shared");
const {
  normalizeShippingData,
} = require("./normalize-shipping-data");

loadLocalEnv();

// --- shipping-data read cache (DB mode only) -------------------------------
// getShippingData() is the single read entry point behind 59 routes (every page
// load + every admin op + every FX-refresh hit go through it via
// server.loadShippingData). The shipping-data blob is ~1.6-2.2MB, so without a
// cache an external client hammering ANY route turns each hit into a full blob
// pull — the prod egress storm (218k reads × ~1.6MB ≈ 350GB) that blew through
// Supabase's free tier ~70x. We cache the normalized blob in-process and serve
// deep clones from it, so reads collapse to cache hits with zero DB egress.
//
// Consistency: every write path (saveShippingData / saveExchangeRates / seed)
// refreshes the cache so the operator immediately sees their own change on this
// instance (write-through). The deployment is single-instance, so write-through
// makes the cache authoritative with no staleness in normal operation; the TTL
// is a safety net that (a) bounds cross-instance staleness if the app is ever
// scaled out and (b) lets the live server pick up rare out-of-band writes
// (scripts/patch-prod-data.js, db:seed) without a restart.
//
// TTL also sets the egress floor: under a relentless caller the cache misses
// exactly once per window, so egress ≈ (1 read / TTL) × blob (~1.6MB). The
// default 1h keeps that ~24 pulls/day (~38MB/day ≈ ~1.1GB/month — well under
// Supabase's 5GB free egress tier) even if the external /exchange-rates/refresh
// poller is never stopped (pre-fix was ~54,000 reads/day). FX itself only needs
// to be fetched ~once/day (the scheduler), which is a SEPARATE concern from this
// cache TTL. TTL is read at call time (env SHIPPING_CACHE_TTL_MS, ms; set 0 to
// disable) so it can be tuned without a code change. JSON mode (local/tests)
// reads a small file with no concurrency and needs no cache.
//
// DEPLOYMENT DISCIPLINE (because the TTL is now long): scripts/patch-prod-data.js
// and db:seed write the DB from a SEPARATE process, so the live server keeps
// serving its in-process cache for up to one TTL after such an out-of-band write.
// After running a prod data patch, redeploy (restart clears the cache) or wait
// one TTL before spot-checking prod — otherwise you'll see the stale cached blob.
let shippingDataCache = null; // canonical normalized blob; never handed out directly
let shippingDataCacheStoredAt = 0; // epoch ms of the read/write that set it

// NB: store/index.js lives one level deeper than the old src/lib/store.js, so the
// bundled data dir is three levels up (src/lib/store -> repo root) + /data.
const bundledDataDir = path.join(__dirname, "../../../data");

const dataDir = path.resolve(process.env.DATA_DIR || bundledDataDir);

const shippingLinesFile = path.join(dataDir, "shipping-lines.json");

const usersFile = path.join(dataDir, "users.json");

const seedShippingLinesFile = path.join(bundledDataDir, "shipping-lines.json");

const seedUsersFile = path.join(bundledDataDir, "users.json");

const shippingDataStateKey = "shipping-data";

const usersStateKey = "users";

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readSeededJson(filePath, seedFilePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (path.resolve(filePath) !== path.resolve(seedFilePath)) {
    try {
      const seedContent = await fs.readFile(seedFilePath, "utf8");
      const seedPayload = JSON.parse(seedContent);
      await writeJson(filePath, seedPayload);
      return seedPayload;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return fallback;
}

function getShippingCacheTtlMs() {
  const parsed = Number(process.env.SHIPPING_CACHE_TTL_MS);
  const configured =
    Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 60 * 1000;
  // Safety net: if DB-penetration reads go severely abnormal (the cache is being
  // defeated somehow), the usage guard tells us to clamp egress by forcing a
  // longer floor regardless of the configured value.
  if (usageGuard.shouldExtendReadCache()) {
    return Math.max(configured, usageGuard.getReadCacheTtlFloorMs());
  }
  return configured;
}

function shippingCacheIsFresh() {
  return (
    shippingDataCache !== null &&
    Date.now() - shippingDataCacheStoredAt < getShippingCacheTtlMs()
  );
}

function setShippingDataCache(normalized) {
  shippingDataCache = normalized;
  shippingDataCacheStoredAt = Date.now();
}

function invalidateShippingDataCache() {
  shippingDataCache = null;
  shippingDataCacheStoredAt = 0;
}

// Update one section of the canonical cache in place without resetting the
// overall TTL clock (only this section just changed). No-ops if the cache was
// cleared (next read will pull fresh). The value is cloned so the cache never
// shares structure with a caller's object.

function updateShippingCacheSection(path, value) {
  if (shippingDataCache === null) {
    return;
  }
  let node = shippingDataCache;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (node[path[i]] === null || typeof node[path[i]] !== "object") {
      node[path[i]] = {};
    }
    node = node[path[i]];
  }
  node[path[path.length - 1]] = structuredClone(value);
}

function getAtPath(obj, path) {
  return path.reduce(
    (node, segment) => (node === null || node === undefined ? undefined : node[segment]),
    obj
  );
}

// The diffable sections of a normalized blob. exchangeRates is intentionally
// excluded from the saveShippingData diff (it is owned by saveExchangeRates);
// see the pin in saveShippingData.

function listShippingSections(normalized) {
  const sections = [["generatedFrom"]];
  const moduleKeys = normalized.modules ? Object.keys(normalized.modules) : [];
  for (const key of moduleKeys) {
    sections.push(["modules", key]);
  }
  return sections;
}

// Section paths whose JSON differs between prev and next (union of both shapes).

function diffShippingSections(prev, next) {
  const paths = new Map();
  for (const path of [...listShippingSections(prev), ...listShippingSections(next)]) {
    paths.set(path.join(" "), path);
  }
  const changed = [];
  for (const path of paths.values()) {
    if (
      JSON.stringify(getAtPath(prev, path)) !== JSON.stringify(getAtPath(next, path))
    ) {
      changed.push(path);
    }
  }
  return changed;
}

// STORAGE_MODE selects the DB-mode storage backend (no effect in JSON mode):
//   blob (default)  — read/write the app_state blob (today's behavior)
//   relational      — read/write the per-entity tables (assemble/decompose)
//   dual            — write blob+tables, read blob, shadow-read tables and diff
// Read at call time so a cutover can flip it via env without a code change.
function getStorageMode() {
  const mode = String(process.env.STORAGE_MODE || "blob").toLowerCase();
  return mode === "relational" || mode === "dual" ? mode : "blob";
}

// dual-mode shadow read: compare the table projection against the authoritative
// blob projection (canonical, key-order-insensitive). Logs on drift; never
// throws and never affects the returned value. Records the last diff for tests.
let lastShadowDiff = null;
async function shadowReadDiff(blobNormalized) {
  try {
    const assembled = await getShippingTablesAssembled();
    const tableNormalized = assembled ? normalizeShippingData(assembled) : null;
    const equal =
      tableNormalized !== null &&
      canonicalJson(blobNormalized) === canonicalJson(tableNormalized);
    lastShadowDiff = { at: Date.now(), equal, hadTables: tableNormalized !== null };
    if (!equal) {
      console.warn(
        `[storage:dual] shadow read DRIFT — table projection != blob projection` +
          `${tableNormalized === null ? " (tables empty)" : ""}`
      );
    }
  } catch (error) {
    lastShadowDiff = { at: Date.now(), equal: false, error: error.message };
    console.warn(`[storage:dual] shadow read failed: ${error.message}`);
  }
}

function getLastShadowDiff() {
  return lastShadowDiff;
}

async function getShippingData() {
  if (shouldUseDatabase()) {
    const mode = getStorageMode();
    if (shippingCacheIsFresh()) {
      return structuredClone(shippingDataCache);
    }

    if (mode === "relational") {
      const assembled = await getShippingTablesAssembled();
      if (assembled) {
        const normalizedData = normalizeShippingData(assembled);
        setShippingDataCache(normalizedData);
        return structuredClone(normalizedData);
      }
      // Tables are empty. Only seed a fresh store when the app_state blob is ALSO
      // empty. A NON-empty blob with empty tables = data loss / incomplete migration,
      // NOT a fresh store — refuse to seed, which would silently overwrite the
      // recoverable blob state with demo data.
      const existingBlobForSeed = await getAppState(shippingDataStateKey);
      if (existingBlobForSeed) {
        throw new Error(
          "[store] relational tables are EMPTY but app_state.shipping-data is NON-EMPTY — " +
            "refusing to seed demo data over a non-empty source (possible data loss / incomplete " +
            "migration). Run the forward migration before serving relational reads."
        );
      }
      // genuinely fresh store (tables AND blob both empty) — seed from the bundled file
      const seedData = await readSeededJson(
        shippingLinesFile,
        seedShippingLinesFile,
        { modules: {} }
      );
      const normalizedData = normalizeShippingData(seedData);
      await saveShippingTables(normalizedData);
      setShippingDataCache(normalizedData);
      return structuredClone(normalizedData);
    }

    // blob | dual — the blob is the authoritative read source
    const storedData = await getAppState(shippingDataStateKey);
    if (storedData) {
      const normalizedData = normalizeShippingData(storedData);
      if (mode === "dual") {
        await shadowReadDiff(normalizedData);
      }
      setShippingDataCache(normalizedData);
      return structuredClone(normalizedData);
    }

    // app_state.shipping-data is MISSING. Symmetric to the relational seed guard above:
    // before seeding demo data, refuse if the relational tables are NON-empty. A missing
    // blob with populated tables means the blob was RETIRED/migrated (cutover Step 8), NOT
    // a fresh store — seeding here would silently write demo data over a live store and
    // resurrect the very key that was retired (the post-retirement re-seed footgun). Only a
    // genuinely fresh store (blob AND tables both empty) is seeded.
    const assembledForSeedGuard = await getShippingTablesAssembled();
    if (assembledForSeedGuard) {
      throw new Error(
        "[store] app_state.shipping-data is MISSING but the relational tables are NON-EMPTY — " +
          "refusing to seed demo data over a retired/migrated store (this happens when STORAGE_MODE " +
          "is blob/dual after the blob was retired). Rebuild the blob with " +
          "`scripts/relational/prod-reverse-to-blob.js --apply` before serving blob/dual reads, or set " +
          "STORAGE_MODE=relational."
      );
    }

    const seedData = await readSeededJson(
      shippingLinesFile,
      seedShippingLinesFile,
      { modules: {} }
    );
    const normalizedData = normalizeShippingData(seedData);
    await saveAppState(shippingDataStateKey, normalizedData);
    if (mode === "dual") {
      await saveShippingTables(normalizedData);
    }
    setShippingDataCache(normalizedData);
    return structuredClone(normalizedData);
  }

  const rawData = await readSeededJson(
    shippingLinesFile,
    seedShippingLinesFile,
    { modules: {} }
  );
  return normalizeShippingData(rawData);
}

// Main write path. In DB mode this used to overwrite the whole ~2MB blob on
// every admin save (the same shape as the pre-throttle FX write storm). Now:
//   1. exchangeRates is pinned to the freshest known value so an admin save that
//      loaded a stale FX snapshot can never roll back a concurrent FX update —
//      the symmetric counterpart to the FX-only jsonb_set in saveExchangeRates;
//   2. no-op writes are skipped entirely (the FX lastCheckedAt-spin bug class);
//   3. when exactly one section (a single module or generatedFrom) changed vs
//      the cached state, only that path is written via jsonb_set — a far smaller
//      write that also cannot clobber concurrent edits to other modules.
// Cross-section changes (e.g. a delete-cascade touching handover + customs) and
// the cold-cache path fall back to a full overwrite. The cache is always
// refreshed so the next read on this instance reflects the write immediately.

async function saveShippingData(data) {
  const normalized = normalizeShippingData(data);

  if (!shouldUseDatabase()) {
    invalidateShippingDataCache();
    return writeJson(shippingLinesFile, normalized);
  }

  const mode = getStorageMode();

  // (1) FX pin (all DB modes): never let a module save own exchangeRates.
  if (shippingDataCache && shippingDataCache.exchangeRates) {
    normalized.exchangeRates = structuredClone(shippingDataCache.exchangeRates);
  }

  // (2) no-op skip (all DB modes): nothing changed — persist nothing.
  if (shippingCacheIsFresh()) {
    const changed = diffShippingSections(shippingDataCache, normalized);
    if (changed.length === 0) {
      return undefined;
    }
    // (3) blob mode: single changed section → targeted jsonb_set (no full blob).
    if (mode === "blob" && changed.length === 1) {
      const path = changed[0];
      const rows = await patchAppStateField(
        shippingDataStateKey,
        path,
        getAtPath(normalized, path)
      );
      if (rows > 0) {
        updateShippingCacheSection(path, getAtPath(normalized, path));
        return undefined;
      }
      // rows === 0: no row yet — fall through to a full write.
    }
  }

  if (mode === "relational") {
    await saveShippingTables(normalized);
    setShippingDataCache(normalized);
    return undefined;
  }

  if (mode === "dual") {
    // blob stays authoritative; tables are written in lockstep for shadow parity.
    await saveAppState(shippingDataStateKey, normalized);
    await saveShippingTables(normalized);
    setShippingDataCache(normalized);
    return undefined;
  }

  // blob (default)
  await saveAppState(shippingDataStateKey, normalized);
  setShippingDataCache(normalized);
  return undefined;
}

// Persist ONLY the exchangeRates field. The FX refresh runs very frequently
// (per-request + a daily scheduler); writing the whole shipping-data blob made
// every FX save a full-payload overwrite that clobbered concurrent edits to the
// carrier/customs/inland data (a data-integrity bug — admin saves could be lost,
// and external data patches could not land). In DB mode we now jsonb_set only
// {exchangeRates}, so FX writes never touch module data, and we refresh just
// that slice of the read cache. JSON mode (local/tests) has no concurrency, so
// the full write is fine.
//
// This is an AUTO (machine-driven) write. If the usage guard sees the daily
// write count go abnormal, we DROP the FX write and keep serving the cached
// rate — degrade the runaway behavior, not the service. The throttle already
// caps FX to ~96/day, so this only fires if something else is also writing a
// lot; user-driven writes (saveShippingData) are never degraded.

async function saveExchangeRates(data) {
  const exchangeRates = normalizeExchangeRates(data.exchangeRates);
  if (shouldUseDatabase()) {
    const mode = getStorageMode();
    if (usageGuard.shouldDegradeAutoWrite()) {
      usageGuard.noteAutoWriteDegraded();
      // Keep the in-memory cache current so reads still see fresh rates even
      // though we are not touching the DB.
      updateShippingCacheSection(["exchangeRates"], exchangeRates);
      return undefined;
    }
    if (mode === "relational") {
      // Targeted single-row write of the exchange_rates table.
      await saveExchangeRatesTable(exchangeRates);
      updateShippingCacheSection(["exchangeRates"], exchangeRates);
      return undefined;
    }
    const rows = await patchAppStateField(shippingDataStateKey, "exchangeRates", exchangeRates);
    if (rows === 0) {
      // No row yet (fresh store) — fall back to a full seed write (mode-aware).
      return saveShippingData({ ...data, exchangeRates });
    }
    if (mode === "dual") {
      await saveExchangeRatesTable(exchangeRates);
    }
    updateShippingCacheSection(["exchangeRates"], exchangeRates);
    return undefined;
  }
  return writeJson(shippingLinesFile, normalizeShippingData({ ...data, exchangeRates }));
}

async function getUsers() {
  if (shouldUseDatabase()) {
    const storedUsers = await getAppState(usersStateKey);
    if (storedUsers) {
      return storedUsers;
    }

    const seedUsers = await readSeededJson(usersFile, seedUsersFile, {
      users: [],
    });
    await saveAppState(usersStateKey, seedUsers);
    return seedUsers;
  }

  return readSeededJson(usersFile, seedUsersFile, { users: [] });
}

async function saveUsers(data) {
  if (shouldUseDatabase()) {
    return saveAppState(usersStateKey, data);
  }

  return writeJson(usersFile, data);
}

// --- per-entity writes (2b) -------------------------------------------------
// In relational mode these issue a TARGETED write of just this entity's row(s),
// so a save to entity A cannot clobber a concurrent save to entity B. In
// blob/json/dual mode they fall back to a load-modify-save of the whole document
// (identical to today's admin behavior), so a route can adopt them in any mode.
async function saveEntityViaWhole(moduleKey, collection, entity) {
  const data = await getShippingData();
  const list = data.modules?.[moduleKey]?.[collection];
  if (!Array.isArray(list)) {
    return saveShippingData(data);
  }
  const idx = list.findIndex((e) => e && e.id === entity.id);
  if (idx >= 0) {
    list[idx] = entity;
  } else {
    list.push(entity);
  }
  return saveShippingData(data);
}

// Module-scoped save: persist ONLY the named module's data. In relational mode
// this writes just that module's tables (no cross-module clobber); in
// blob/json/dual it is the existing whole-document save. Routes that rebuild a
// module section (the common admin pattern) call this instead of saveShippingData.
async function saveModule(moduleKey, shippingData) {
  if (shouldUseDatabase() && getStorageMode() === "relational") {
    const normalized = normalizeShippingData(shippingData);
    // FX pin: a module save must never roll back a concurrent FX update.
    if (shippingDataCache && shippingDataCache.exchangeRates) {
      normalized.exchangeRates = structuredClone(shippingDataCache.exchangeRates);
    }
    await saveModuleTables(moduleKey, normalized);
    invalidateShippingDataCache();
    return undefined;
  }
  return saveShippingData(shippingData);
}

async function saveCarrier(carrier) {
  if (shouldUseDatabase() && getStorageMode() === "relational") {
    await saveCarrierEntity(carrier);
    invalidateShippingDataCache();
    return undefined;
  }
  return saveEntityViaWhole("handover", "shippingLines", carrier);
}

async function saveCustomsYard(yard) {
  if (shouldUseDatabase() && getStorageMode() === "relational") {
    await saveCustomsYardEntity(yard);
    invalidateShippingDataCache();
    return undefined;
  }
  return saveEntityViaWhole("customs", "yards", yard);
}

async function saveInlandRateEntry(entry) {
  if (shouldUseDatabase() && getStorageMode() === "relational") {
    await saveInlandRateEntryEntity(entry);
    invalidateShippingDataCache();
    return undefined;
  }
  return saveEntityViaWhole("inland", "rateEntries", entry);
}

// O6.5: resolve a destination/precise-point's display name for a language.
// Fill one of nameZh/nameEs → shown regardless of language; fill both → follow
// language; fill neither → fall back to the base `name`.

function localizedInlandName(entity, lang) {
  if (!entity) {
    return "";
  }
  const zh = String(entity.nameZh || "").trim();
  const es = String(entity.nameEs || "").trim();
  if (zh && es) {
    return lang === "es" ? es : zh;
  }
  return zh || es || entity.name || "";
}

module.exports = {
  formatDemurrageRuleLabel,
  getLastShadowDiff,
  getShippingData,
  getStorageMode,
  getUsers,
  invalidateShippingDataCache,
  localizedInlandName,
  normalizeShippingData,
  parseDemurrageRange,
  saveCarrier,
  saveCustomsYard,
  saveInlandRateEntry,
  saveModule,
  saveShippingData,
  saveExchangeRates,
  saveUsers,
  RATE_GROUP_NAMES,
};
