// Resolve a Google Maps link (long or short) or bare coordinates into lat/lng
// (+ optional place name). Pure parsing is unit-tested; short-link following is
// SSRF-guarded (domain whitelist, no cookies, capped redirects + timeout).

const MX_BBOX = { latMin: 14, latMax: 33, lngMin: -118, lngMax: -86 };
const MAX_REDIRECTS = 5;
const REDIRECT_TIMEOUT_MS = 5000;

function inMexicoBbox(lat, lng) {
  return (
    lat >= MX_BBOX.latMin &&
    lat <= MX_BBOX.latMax &&
    lng >= MX_BBOX.lngMin &&
    lng <= MX_BBOX.lngMax
  );
}

function safeHost(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch (_error) {
    return null;
  }
}

function isGoogleMapsUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    const okHost =
      host === "google.com" ||
      host.endsWith(".google.com") ||
      host === "google.com.mx" ||
      host.endsWith(".google.com.mx");
    return okHost && parsed.pathname.includes("/maps");
  } catch (_error) {
    return false;
  }
}

function isAllowedRedirectHost(host) {
  if (!host) return false;
  return (
    host === "goo.gl" ||
    host.endsWith(".goo.gl") ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "google.com.mx" ||
    host.endsWith(".google.com.mx")
  );
}

// Extract coordinates from a URL or free text, in priority order.
function extractCoords(text) {
  const source = String(text || "");
  let match = source.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (match) return { lat: Number(match[1]), lng: Number(match[2]), via: "pin" };

  match = source.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (match) return { lat: Number(match[1]), lng: Number(match[2]), via: "viewport" };

  match = source.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (match) return { lat: Number(match[1]), lng: Number(match[2]), via: "query" };

  // /dir/.../{lat},{lng} — take the last lat,lng pair in the path
  const dirMatches = [...source.matchAll(/(-?\d{1,2}\.\d{3,}),(-?\d{2,3}\.\d{3,})/g)];
  if (/\/dir\//.test(source) && dirMatches.length) {
    const last = dirMatches[dirMatches.length - 1];
    return { lat: Number(last[1]), lng: Number(last[2]), via: "dir" };
  }

  // bare "lat, lng" (accepts any valid decimal pair; bbox check happens later)
  match = source.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (match) return { lat: Number(match[1]), lng: Number(match[2]), via: "bare" };

  return null;
}

function extractPlaceName(text) {
  const match = String(text || "").match(/\/place\/([^/@]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, " ")).trim() || null;
  } catch (_error) {
    return null;
  }
}

async function followShortLink(url, fetchImpl) {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REDIRECT_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "expressline-inland/1.0" },
      });
    } catch (_error) {
      clearTimeout(timer);
      return { error: "fetch-failed" };
    }
    clearTimeout(timer);

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current).toString();
      if (!isAllowedRedirectHost(safeHost(next))) {
        return { error: "untrusted-redirect" };
      }
      current = next;
      continue;
    }
    if (!isGoogleMapsUrl(current)) {
      return { error: "not-google-maps" };
    }
    return { url: current };
  }
  return { error: "too-many-redirects" };
}

// input: a string (link or bare coords). options.fetch overrides global fetch.
async function resolveLink(input, options = {}) {
  const fetchImpl = options.fetch || (typeof fetch === "function" ? fetch : null);
  const raw = String(input || "").trim();
  if (!raw) {
    return { error: "empty" };
  }

  let workingText = raw;
  let normalizedLink = raw;

  const isShort = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl)\//i.test(raw);
  const isHttp = /^https?:\/\//i.test(raw);

  if (isShort) {
    if (!fetchImpl) {
      return { error: "no-fetch" };
    }
    const followed = await followShortLink(raw, fetchImpl);
    if (followed.error) {
      return { error: followed.error };
    }
    workingText = followed.url;
    normalizedLink = followed.url;
  } else if (isHttp && !isGoogleMapsUrl(raw)) {
    return { error: "non-google-domain" };
  }

  const coords = extractCoords(workingText);
  const name = extractPlaceName(workingText);
  if (!coords) {
    return { error: "no-coords", name: name || null };
  }
  return {
    lat: coords.lat,
    lng: coords.lng,
    name: name || null,
    normalizedLink,
    via: coords.via,
    warning: inMexicoBbox(coords.lat, coords.lng) ? null : "outside-mexico-bbox",
  };
}

module.exports = {
  inMexicoBbox,
  extractCoords,
  extractPlaceName,
  isGoogleMapsUrl,
  resolveLink,
};
