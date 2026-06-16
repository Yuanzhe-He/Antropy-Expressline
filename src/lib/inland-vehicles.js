// Inland vehicle (truck) types — shared catalog + price accessor.
//
// 6 tiers requested by José (2026-06-15). single/double trailer reuse the
// existing rateEntry.sencillo / .full fields (CSV-sourced, back-compat); the
// other 4 tiers live in rateEntry.vehiclePrices and start null (no rate yet —
// José to provide). UI shows "Pendiente / 待报价" for tiers without a price.

const VEHICLE_TYPES = Object.freeze([
  { key: "light_1_5t", legacyField: null },
  { key: "light_3_5t", legacyField: null },
  { key: "short_8t", legacyField: null },
  { key: "sencillo", legacyField: "sencillo" },
  { key: "full", legacyField: "full" },
  { key: "lowboy", legacyField: null },
]);

const VEHICLE_TYPE_KEYS = Object.freeze(VEHICLE_TYPES.map((v) => v.key));

// The 4 tiers stored under rateEntry.vehiclePrices (sencillo/full stay top-level).
const EXTRA_VEHICLE_KEYS = Object.freeze(
  VEHICLE_TYPES.filter((v) => !v.legacyField).map((v) => v.key)
);

const DEFAULT_VEHICLE_TYPE = "sencillo";

function isVehicleType(type) {
  return VEHICLE_TYPE_KEYS.includes(type);
}

function normalizeVehicleType(type) {
  return isVehicleType(type) ? type : DEFAULT_VEHICLE_TYPE;
}

// Unified price accessor: sencillo/full read the legacy top-level fields;
// the other tiers read rateEntry.vehiclePrices. Returns a number or null.
function getVehiclePrice(entry, type) {
  if (!entry) {
    return null;
  }
  if (type === "sencillo") {
    return entry.sencillo === undefined ? null : entry.sencillo;
  }
  if (type === "full") {
    return entry.full === undefined ? null : entry.full;
  }
  const prices = entry.vehiclePrices || {};
  const value = prices[type];
  return value === undefined ? null : value;
}

module.exports = {
  VEHICLE_TYPES,
  VEHICLE_TYPE_KEYS,
  EXTRA_VEHICLE_KEYS,
  DEFAULT_VEHICLE_TYPE,
  isVehicleType,
  normalizeVehicleType,
  getVehiclePrice,
};
