// Inland route geometry: OSRM fetch + caching helpers + via-city snapping.
// Pure helpers (decodePolyline, computeViaCities) are unit-tested; the network
// fetch is exercised by the refresh script, not the smoke test.

const { INLAND_CITIES } = require("./inland-cities");

const VIA_CITY_THRESHOLD_KM = 12;
const VIA_CITY_MAX = 6;
const ENDPOINT_SKIP_KM = 18; // drop cities that sit on top of origin/destination
const OSRM_DEFAULT_BASE_URLS = [
  "https://router.project-osrm.org",
  "https://routing.openstreetmap.de/routed-car",
];
const EARTH_RADIUS_KM = 6371;
// A driving route whose road distance hugely exceeds the straight-line distance
// implies the road router took a long land detour around water (i.e. the real
// freight route uses a ferry). La Paz (BCS) road-routes ~4.3x crow-flies down
// the Baja peninsula; every mainland route is ~1.2-1.4x. This catches the ferry
// case that OSRM's car profile does not model as a ferry step.
const FERRY_DETOUR_RATIO = 2.5;

// Decode a Google/OSRM encoded polyline (precision 5) -> [[lat, lng], ...].
function decodePolyline(encoded, precision = 5) {
  if (!encoded) {
    return [];
  }
  const factor = Math.pow(10, precision);
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / factor, lng / factor]);
  }
  return points;
}

// Equirectangular approximation with latitude (cosine) correction, in km.
function equirectKm(aLat, aLng, bLat, bLng) {
  const meanLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const x = (bLng - aLng) * (Math.PI / 180) * Math.cos(meanLatRad);
  const y = (bLat - aLat) * (Math.PI / 180);
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_KM;
}

// Shortest distance (km) from a point to a polyline segment [a, b].
function pointToSegmentKm(pLat, pLng, aLat, aLng, bLat, bLng) {
  const meanLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const cos = Math.cos(meanLatRad);
  const ax = aLng * cos;
  const ay = aLat;
  const bx = bLng * cos;
  const by = bLat;
  const px = pLng * cos;
  const py = pLat;
  const dx = bx - ax;
  const dy = by - ay;
  const segLenSq = dx * dx + dy * dy;
  let t = segLenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / segLenSq;
  t = Math.max(0, Math.min(1, t));
  const projLat = ay + t * dy;
  const projLng = (ax + t * dx) / cos;
  return equirectKm(pLat, pLng, projLat, projLng);
}

// Snap route geometry to named cities: a city is "on route" if its minimum
// distance to the polyline is below the threshold. Returns up to VIA_CITY_MAX
// city names in along-route order, excluding ones at the start/end.
function computeViaCities(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }
  const cities = options.cities || INLAND_CITIES;
  const threshold = options.thresholdKm || VIA_CITY_THRESHOLD_KM;
  const max = options.max || VIA_CITY_MAX;
  const start = points[0];
  const end = points[points.length - 1];

  const hits = [];
  for (const city of cities) {
    let best = Infinity;
    let bestIndex = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const d = pointToSegmentKm(
        city.lat,
        city.lng,
        points[i][0],
        points[i][1],
        points[i + 1][0],
        points[i + 1][1]
      );
      if (d < best) {
        best = d;
        bestIndex = i;
      }
    }
    if (best > threshold) {
      continue;
    }
    // Skip cities sitting on the origin or destination.
    if (
      equirectKm(city.lat, city.lng, start[0], start[1]) < ENDPOINT_SKIP_KM ||
      equirectKm(city.lat, city.lng, end[0], end[1]) < ENDPOINT_SKIP_KM
    ) {
      continue;
    }
    hits.push({ name: city.name, index: bestIndex, distance: best });
  }

  hits.sort((a, b) => a.index - b.index || a.distance - b.distance);
  const seen = new Set();
  const ordered = [];
  for (const hit of hits) {
    if (seen.has(hit.name)) {
      continue;
    }
    seen.add(hit.name);
    ordered.push(hit.name);
  }
  return ordered.slice(0, max);
}

async function fetchWithTimeout(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "expressline-inland-routes/1.0 (logistics workbench)",
        Accept: "application/json",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a driving route from origin to destination via OSRM, trying each base
// URL in turn with retries. Returns a normalized route or throws.
async function fetchOsrmRoute(origin, destination, options = {}) {
  const baseUrls = options.baseUrls || [
    process.env.OSRM_BASE_URL,
    ...OSRM_DEFAULT_BASE_URLS,
  ].filter(Boolean);
  const retries = options.retries ?? 2;
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const query = "overview=full&geometries=polyline&steps=true&alternatives=false";

  let lastError = null;
  for (const base of baseUrls) {
    const url = `${base.replace(/\/$/, "")}/route/v1/driving/${coords}?${query}`;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, options);
        if (!response.ok) {
          throw new Error(`OSRM HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.code !== "Ok" || !data.routes || !data.routes.length) {
          throw new Error(`OSRM code ${data.code || "unknown"}`);
        }
        const route = data.routes[0];
        const distanceKm = Math.round((route.distance || 0) / 1000);
        const ferryStep = (route.legs || []).some((leg) =>
          (leg.steps || []).some((step) => step.mode === "ferry")
        );
        const straightLineKm = equirectKm(
          origin.lat,
          origin.lng,
          destination.lat,
          destination.lng
        );
        const detourRatio = straightLineKm > 0 ? distanceKm / straightLineKm : 0;
        const hasFerry = ferryStep || detourRatio > FERRY_DETOUR_RATIO;
        return {
          encodedPolyline: route.geometry,
          distanceKm,
          durationMin: Math.round((route.duration || 0) / 60),
          hasFerry,
          engine: "osrm",
          base,
        };
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    }
  }
  throw lastError || new Error("OSRM route failed");
}

module.exports = {
  decodePolyline,
  equirectKm,
  pointToSegmentKm,
  computeViaCities,
  fetchOsrmRoute,
  VIA_CITY_THRESHOLD_KM,
  VIA_CITY_MAX,
  OSRM_DEFAULT_BASE_URLS,
};
