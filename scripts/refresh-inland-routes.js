// Refresh inland route geometry cache from OSRM.
//
// Usage:
//   node scripts/refresh-inland-routes.js [--only=<destId>] [--missing-only] [--stale-only]
//   node scripts/refresh-inland-routes.js --target=production --confirm-production
//
// Serial requests with >=1.2s spacing and per-call retries (see inland-routes.js).
// Writes through the store layer (JSON by default, Postgres only with confirm).

const {
  decodePolyline,
  computeViaCities,
  fetchOsrmRoute,
} = require("../src/lib/inland-routes");

const REQUEST_GAP_MS = 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      flags[key] = value === undefined ? true : value;
    }
  }
  return flags;
}

function buildTargets(inland, onlyArg) {
  const onlySet = onlyArg
    ? new Set(String(onlyArg).split(",").map((id) => id.trim()).filter(Boolean))
    : null;
  const targets = [];
  for (const dest of inland.destinations || []) {
    if (!dest.enabled || dest.lat == null || dest.lng == null) {
      continue;
    }
    if (onlySet && !onlySet.has(dest.id)) {
      continue;
    }
    targets.push({
      destinationId: dest.id,
      targetType: "destination",
      targetId: null,
      name: dest.name,
      lat: dest.lat,
      lng: dest.lng,
    });
    for (const point of dest.precisePoints || []) {
      if (point.lat == null || point.lng == null) {
        continue;
      }
      targets.push({
        destinationId: dest.id,
        targetType: "precisePoint",
        targetId: point.id,
        name: `${dest.name} · ${point.name}`,
        lat: point.lat,
        lng: point.lng,
      });
    }
  }
  return targets;
}

function findCache(routeCache, target) {
  return routeCache.find(
    (rc) =>
      rc.destinationId === target.destinationId &&
      rc.targetType === target.targetType &&
      (rc.targetId || null) === (target.targetId || null)
  );
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const target = flags.target === "production" ? "production" : "local";
  if (target === "production") {
    if (!flags["confirm-production"]) {
      console.error("Refusing to write to production without --confirm-production.");
      process.exit(1);
    }
  } else {
    process.env.STORAGE_DRIVER = "json";
  }

  const { getShippingData, saveShippingData } = require("../src/lib/store");
  const data = await getShippingData();
  const inland = data.modules.inland;
  const origin = (inland.origins && inland.origins[0]) || {
    id: "manzanillo",
    lat: 19.0522,
    lng: -104.3158,
  };
  inland.routeCache = inland.routeCache || [];

  let targets = buildTargets(inland, flags.only);
  if (flags["missing-only"]) {
    targets = targets.filter((t) => !findCache(inland.routeCache, t));
  } else if (flags["stale-only"]) {
    targets = targets.filter((t) => {
      const cache = findCache(inland.routeCache, t);
      return !cache || cache.stale;
    });
  }

  console.log(`Refreshing ${targets.length} inland route(s)...`);
  const failures = [];
  let done = 0;

  for (const t of targets) {
    try {
      const route = await fetchOsrmRoute(origin, { lat: t.lat, lng: t.lng });
      const viaCities = computeViaCities(decodePolyline(route.encodedPolyline));
      const entry = {
        id: `rc-${t.destinationId}-${t.targetType}${t.targetId ? `-${t.targetId}` : ""}`,
        originId: origin.id,
        destinationId: t.destinationId,
        targetType: t.targetType,
        targetId: t.targetId,
        encodedPolyline: route.encodedPolyline,
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        viaCities,
        engine: route.engine,
        fetchedAt: new Date().toISOString(),
        stale: false,
        hasFerry: route.hasFerry,
      };
      const existing = findCache(inland.routeCache, t);
      if (existing) {
        Object.assign(existing, entry, { id: existing.id });
      } else {
        inland.routeCache.push(entry);
      }
      done += 1;
      console.log(
        `  ✓ ${t.name} — ${route.distanceKm} km, ~${Math.round(route.durationMin / 60)} h, via ${viaCities.join(" → ") || "(none)"}${route.hasFerry ? " [ferry]" : ""}`
      );
    } catch (error) {
      failures.push({ name: t.name, error: error.message });
      console.log(`  ✗ ${t.name} — ${error.message}`);
    }
    await sleep(REQUEST_GAP_MS);
  }

  await saveShippingData(data);

  console.log(`\nDone: ${done} refreshed, ${failures.length} failed (target=${target}).`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
  }
  console.log("inland-routes-ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
