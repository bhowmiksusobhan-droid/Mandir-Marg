/**
 * Mandir Marg Worker — static site + GET /api/temples?lat=..&lng=..&radius=..
 *
 * Why the proxy exists:
 * Public Overpass servers are rate-limited and sometimes busy, and not every
 * mirror allows browser (CORS) requests. This Worker fetches on the server,
 * caches each area at Cloudflare's edge for 30 minutes, and serves a small JSON
 * payload. Every visitor in the same area then shares one upstream request.
 *
 * The browser falls back to calling Overpass directly when this endpoint is not
 * available (for example the local Python preview or GitHub Pages).
 *
 * Everything that is not /api/* is served from the static assets in public/ by
 * the ASSETS binding. `_headers` is applied to those assets by Cloudflare, not
 * to responses produced here, so this file sets its own headers.
 */

const MIRRORS = [
  // Server-side requests do not need CORS, so the fast French mirror comes first.
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

const ALLOWED_RADII = new Set([5000, 10000, 25000, 50000]);

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers
    }
  });
}

function buildQuery(lat, lng, radius) {
  return `[out:json][timeout:20];
nwr["amenity"="place_of_worship"]["religion"="hindu"](around:${radius},${lat.toFixed(5)},${lng.toFixed(5)});
out center 300;`;
}

async function fetchFromMirrors(query) {
  let lastError = null;

  for (const mirror of MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch(mirror, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json"
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`${mirror} HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.elements)) throw new Error("Unexpected Overpass response");
      return data.elements;
    } catch (error) {
      lastError = error;
      console.warn(`Overpass mirror failed: ${mirror}`, error.message);
    } finally {
      clearTimeout(timer);
    }
  }

  console.error("All Overpass mirrors failed", lastError ? lastError.message : "unknown error");
  return null;
}

async function handleTemples(request, ctx) {
  const url = new URL(request.url);

  const lat = Number.parseFloat(url.searchParams.get("lat"));
  const lng = Number.parseFloat(url.searchParams.get("lng"));
  const radius = Number.parseInt(url.searchParams.get("radius"), 10);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180 ||
    !ALLOWED_RADII.has(radius)
  ) {
    return json(
      {
        error:
          "Provide a valid lat (-90..90), lng (-180..180) and radius (5000, 10000, 25000 or 50000)."
      },
      400,
      { "Cache-Control": "no-store" }
    );
  }

  // Round the area so nearby users share the same cached response.
  const normalizedLat = lat.toFixed(2);
  const normalizedLng = lng.toFixed(2);
  const cacheKey = new URL(url.origin + "/api/temples");
  cacheKey.search = `?lat=${normalizedLat}&lng=${normalizedLng}&radius=${radius}`;

  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey.toString());
    if (cached) return cached;
  }

  const elements = await fetchFromMirrors(buildQuery(lat, lng, radius));
  if (!elements) {
    return json(
      { error: "The temple database is temporarily unavailable. Please try again shortly." },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  const response = json({ elements, fetchedAt: new Date().toISOString() }, 200, {
    // Browsers may keep it briefly; the app also caches for 6 hours locally.
    "Cache-Control": "public, max-age=600, s-maxage=1800, stale-while-revalidate=86400"
  });

  if (cache && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(cache.put(cacheKey.toString(), response.clone()));
  }

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/temples" || url.pathname === "/api/temples/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Use GET for this endpoint." }, 405, {
          Allow: "GET, HEAD",
          "Cache-Control": "no-store"
        });
      }
      return handleTemples(request, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};
