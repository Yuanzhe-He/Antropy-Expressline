// store/normalize-inland: inland module normalizer (origins / destinations +
// precise points / rate entries / route cache + seed). Imports ./shared only.

const {
  DEFAULT_INLAND_ORIGIN_ID,
  INLAND_DESTINATION_CATALOG,
  INLAND_ORIGINS,
} = require("../inland-catalog");
const {
  EXTRA_VEHICLE_KEYS,
} = require("../inland-vehicles");
const {
  normalizePriceMode,
} = require("../options");
const {
  normalizeTaxRatePresets,
  parseNullableNumber,
  parseNumber,
  slugifyId,
} = require("./shared");

const INLAND_SEED_VERSION = 2;

function normalizeInlandPrecisePoint(point = {}, fallbackId) {
  return {
    id: slugifyId(point.id, fallbackId),
    name: String(point.name || "").trim() || fallbackId,
    lat: parseNullableNumber(point.lat),
    lng: parseNullableNumber(point.lng),
    // S1 (batch3): optional flat all-in price (MXN) for this exact point. null =
    // inherit the city/destination per-vehicle rate. Set = a single price that
    // overrides every vehicle tier (José: "区域内多客户各自一口价").
    flatPrice: parseNullableNumber(point.flatPrice),
    note: String(point.note || ""),
    source: ["gmaps-link", "manual", "seed-catalog"].includes(point.source)
      ? point.source
      : "manual",
    link: typeof point.link === "string" ? point.link : "",
  };
}

// S3 case photos: store ONLY http(s) URLs (never base64/binary). Accepts an
// array (stored) or a newline-separated string (admin textarea). Trims, drops
// non-http(s) (blocks javascript:/data:/file: -> XSS via stored URL), dedupes,
// caps at 12.

const MAX_IMAGE_URLS = 12;

function normalizeImageUrls(value) {
  let list = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string") {
    list = value.split(/[\r\n]+/);
  }
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const url = String(raw || "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_IMAGE_URLS) {
      break;
    }
  }
  return out;
}

function normalizeInlandDestination(dest = {}, fallbackId) {
  const id = slugifyId(dest.id, fallbackId);
  return {
    id,
    name: String(dest.name || id).trim(),
    // O6.5 (20260617): optional bilingual display names. `name` stays the
    // fallback/base. Fill one → shown regardless of language; fill both → follow
    // language. Back-compat: old destinations (no nameZh/nameEs) just use name.
    nameZh: String(dest.nameZh || "").trim(),
    nameEs: String(dest.nameEs || "").trim(),
    state: String(dest.state || "").trim(),
    imageUrls: normalizeImageUrls(dest.imageUrls),
    lat: parseNullableNumber(dest.lat),
    lng: parseNullableNumber(dest.lng),
    coordSource: ["seed-catalog", "seed-catalog-confirmed", "gmaps-link", "manual"].includes(
      dest.coordSource
    )
      ? dest.coordSource
      : "seed-catalog",
    needsReview: Boolean(dest.needsReview),
    precisePoints: (Array.isArray(dest.precisePoints) ? dest.precisePoints : []).map(
      (point, index) => normalizeInlandPrecisePoint(point, `${id}-pp-${index + 1}`)
    ),
    enabled: dest.enabled !== false,
    note: String(dest.note || ""),
  };
}

// R2 short-haul / drayage fee. { sencillo, full } in MXN; either side may be
// null; the whole field is null when there is no burreo for the entry.

function normalizeInlandBurreo(burreo) {
  if (!burreo || typeof burreo !== "object" || Array.isArray(burreo)) {
    return null;
  }
  const sencillo = parseNullableNumber(burreo.sencillo);
  const full = parseNullableNumber(burreo.full);
  if (sencillo === null && full === null) {
    return null;
  }
  return { sencillo, full };
}

// S2 vehicle types: the non-legacy tiers (sencillo/full stay top-level).
// Always returns an object with every EXTRA_VEHICLE_KEYS key (number or null)
// for a stable shape — back-compat: entries missing a tier (e.g. box_53) get null.

function normalizeVehiclePrices(prices) {
  const source = prices && typeof prices === "object" && !Array.isArray(prices) ? prices : {};
  const out = {};
  for (const key of EXTRA_VEHICLE_KEYS) {
    out[key] = parseNullableNumber(source[key]);
  }
  return out;
}

function normalizeInlandRateEntry(entry = {}, fallbackId) {
  return {
    id: slugifyId(entry.id, fallbackId),
    originId:
      slugifyId(entry.originId, DEFAULT_INLAND_ORIGIN_ID) ||
      DEFAULT_INLAND_ORIGIN_ID,
    destinationId: String(entry.destinationId || "").trim(),
    proveedor: String(entry.proveedor || "").trim(),
    dupIndex:
      Number.isInteger(entry.dupIndex) && entry.dupIndex > 0 ? entry.dupIndex : 1,
    sencillo: parseNullableNumber(entry.sencillo),
    full: parseNullableNumber(entry.full),
    burreo: normalizeInlandBurreo(entry.burreo),
    vehiclePrices: normalizeVehiclePrices(entry.vehiclePrices),
    currency: "MXN",
    cliente: String(entry.cliente || "").trim(),
    codigoCw: String(entry.codigoCw || "").trim(),
    commodity: String(entry.commodity || "").trim(),
    enabled: entry.enabled !== false,
    note: String(entry.note || ""),
    extras:
      entry.extras && typeof entry.extras === "object" && !Array.isArray(entry.extras)
        ? entry.extras
        : {},
  };
}

function normalizeInlandRouteCacheEntry(rc = {}, fallbackId) {
  return {
    id: slugifyId(rc.id, fallbackId),
    originId:
      slugifyId(rc.originId, DEFAULT_INLAND_ORIGIN_ID) || DEFAULT_INLAND_ORIGIN_ID,
    destinationId: String(rc.destinationId || "").trim(),
    targetType: rc.targetType === "precisePoint" ? "precisePoint" : "destination",
    targetId: rc.targetId ? String(rc.targetId).trim() : null,
    encodedPolyline: typeof rc.encodedPolyline === "string" ? rc.encodedPolyline : "",
    distanceKm: parseNullableNumber(rc.distanceKm),
    durationMin: parseNullableNumber(rc.durationMin),
    viaCities: Array.isArray(rc.viaCities)
      ? rc.viaCities.map((city) => String(city)).filter(Boolean)
      : [],
    engine: String(rc.engine || "osrm"),
    fetchedAt: rc.fetchedAt || null,
    stale: Boolean(rc.stale),
    hasFerry: Boolean(rc.hasFerry),
    // S4 manual override: operator-entered values win per-field in effectiveRoute.
    manualOverride: normalizeRouteOverride(rc.manualOverride),
  };
}

// { distanceKm, durationMin, viaCities } | null. Each field may be null (then the
// fetched value is used). Whole field null when nothing was overridden.

function normalizeRouteOverride(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const distanceKm = parseNullableNumber(value.distanceKm);
  const durationMin = parseNullableNumber(value.durationMin);
  const viaCities = Array.isArray(value.viaCities)
    ? value.viaCities.map((c) => String(c).trim()).filter(Boolean)
    : [];
  if (distanceKm === null && durationMin === null && !viaCities.length) {
    return null;
  }
  return { distanceKm, durationMin, viaCities };
}

function buildInlandDestinationSeed() {
  return INLAND_DESTINATION_CATALOG.map((dest) => ({
    id: dest.id,
    name: dest.name,
    state: dest.state,
    lat: dest.lat,
    lng: dest.lng,
    coordSource: dest.coordSource || "seed-catalog",
    needsReview: Boolean(dest.needsReview),
    precisePoints: [],
    imageUrls: [],
    enabled: true,
    note: "",
  }));
}

function normalizeInlandModuleData(moduleData = {}) {
  const seedVersion = parseNumber(moduleData.settings?.inlandSeedVersion, 0);
  const seedNeeded =
    seedVersion < INLAND_SEED_VERSION ||
    !Array.isArray(moduleData.destinations) ||
    !moduleData.destinations.length;

  const origins = (
    Array.isArray(moduleData.origins) && moduleData.origins.length
      ? moduleData.origins
      : INLAND_ORIGINS
  ).map((origin, index) => ({
    id: slugifyId(origin.id, `origin-${index + 1}`),
    name: String(origin.name || origin.id || `Origin ${index + 1}`).trim(),
    lat: parseNullableNumber(origin.lat),
    lng: parseNullableNumber(origin.lng),
  }));

  const destinations = (
    seedNeeded ? buildInlandDestinationSeed() : moduleData.destinations
  ).map((dest, index) => normalizeInlandDestination(dest, `dest-${index + 1}`));
  const destinationIds = new Set(destinations.map((dest) => dest.id));

  const rateEntries = (
    Array.isArray(moduleData.rateEntries) ? moduleData.rateEntries : []
  )
    .map((entry, index) => normalizeInlandRateEntry(entry, `re-${index + 1}`))
    .filter((entry) => destinationIds.has(entry.destinationId));

  const routeCache = (
    Array.isArray(moduleData.routeCache) ? moduleData.routeCache : []
  )
    .map((rc, index) => normalizeInlandRouteCacheEntry(rc, `rc-${index + 1}`))
    .filter((rc) => destinationIds.has(rc.destinationId));

  return {
    settings: {
      defaultQuoteCurrency: "MXN",
      defaultPriceMode: normalizePriceMode(moduleData.settings?.defaultPriceMode),
      inlandSeedVersion: INLAND_SEED_VERSION,
    },
    taxRatePresets: normalizeTaxRatePresets(moduleData.taxRatePresets),
    origins,
    destinations,
    rateEntries,
    routeCache,
  };
}

module.exports = {
  INLAND_SEED_VERSION,
  normalizeInlandPrecisePoint,
  MAX_IMAGE_URLS,
  normalizeImageUrls,
  normalizeInlandDestination,
  normalizeInlandBurreo,
  normalizeVehiclePrices,
  normalizeInlandRateEntry,
  normalizeInlandRouteCacheEntry,
  normalizeRouteOverride,
  buildInlandDestinationSeed,
  normalizeInlandModuleData,
};
