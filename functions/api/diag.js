/**
 * TEMPORARY diagnostic endpoint. Returns which Overpass mirrors respond from
 * the Cloudflare runtime. Protected by a throwaway key and removed once the
 * working mirrors are known. It never accepts a caller-supplied URL.
 */

const KEY = "mm-diag-7f3a9c";

const CANDIDATES = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.osm.rambler.ru/cgi/interpreter"
];

const QUERY = `[out:json][timeout:10];
nwr["amenity"="place_of_worship"]["religion"="hindu"](around:2000,25.31,82.97);
out center 3;`;

async function probe(mirror) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(mirror, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
        "User-Agent": "MandirMarg-Diag/1.0"
      },
      body: `data=${encodeURIComponent(QUERY)}`,
      signal: controller.signal
    });
    const text = await response.text();
    let elements = null;
    try {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.elements)) elements = data.elements.length;
    } catch {
      /* not JSON */
    }
    return {
      mirror,
      ok: response.ok && elements !== null,
      status: response.status,
      ms: Date.now() - started,
      elements,
      preview: elements === null ? text.slice(0, 120).replace(/\s+/g, " ") : ""
    };
  } catch (error) {
    return {
      mirror,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: error && error.name === "AbortError" ? "timeout" : String(error && error.message)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  if (url.searchParams.get("key") !== KEY) {
    return new Response("Not found", { status: 404 });
  }

  const results = await Promise.all(CANDIDATES.map(probe));
  return new Response(
    JSON.stringify(
      {
        colo: context.request.cf ? context.request.cf.colo : null,
        results
      },
      null,
      2
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
