(() => {
  "use strict";

  /* ==========================================================================
     Configuration
     ========================================================================== */

  const CONFIG = window.MANDIR_MARG_CONFIG || {};
  const SUPABASE_URL = String(CONFIG.supabaseUrl || "").replace(/\/+$/, "");
  const SUPABASE_ANON_KEY = String(CONFIG.supabaseAnonKey || "");
  const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  const DEFAULT_VIEW = {
    lat: 25.3176,
    lng: 82.9739,
    label: "Varanasi",
    radius: 25000
  };

  const VIEW_KEY = "mandirMarg.view.v1";
  const SUGGESTIONS_KEY = "mandirMarg.suggestions.v1";
  const CACHE_PREFIX = "mandirMarg.temples.v1.";
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  const MAX_CACHED_AREAS = 6;

  const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
  const PHOTON_URL = "https://photon.komoot.io/api/";
  const BASEMAP_KEY = "mandirMarg.basemap.v1";

  // Temples approved by a moderator are published here as a small static JSON
  // file (see tools/publish_temples.py). Keeping them out of the Overpass query
  // means an approval becomes visible without waiting for OpenStreetMap.
  const COMMUNITY_URL = "data/community-temples.json";
  const DUPLICATE_RADIUS = 80;
  const OSM_DUPLICATE_RADIUS = 60;

  // Photos are downscaled in the browser before they are stored. Canvas export
  // also strips EXIF, so the contributor's device details never go public.
  const PHOTO_MAX_EDGE = 1280;
  const PHOTO_QUALITY = 0.72;
  const PHOTO_MAX_DATA_URL = 900 * 1024;
  const LOCAL_PHOTO_BUDGET = 3500 * 1024;

  // Free Esri World Imagery (no API key, attribution required) plus its
  // transparent place-label overlay. Great for spotting a temple roof.
  const SATELLITE_SOURCES = {
    imagery: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        'Imagery &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, Maxar, Earthstar Geographics'
    },
    labels: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        'Labels &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>'
    }
  };
  const SATELLITE_LAYERS = ["satellite-imagery", "satellite-labels"];

  // Browser-safe mirrors only. The fast overpass.openstreetmap.fr mirror has no
  // CORS headers, so it is used exclusively by the server-side proxy in
  // functions/api/temples.js.
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];

  const OSM_RASTER_STYLE = {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }]
  };

  /* ==========================================================================
     DOM
     ========================================================================== */

  const $ = (selector) => document.querySelector(selector);

  const els = {
    searchForm: $("#search-form"),
    searchInput: $("#search-input"),
    nearMe: $("#near-me"),
    radius: $("#radius"),
    status: $("#status"),
    list: $("#temple-list"),
    empty: $("#empty-state"),
    mapHint: $("#map-hint"),
    mapNotice: $("#map-notice"),
    cancelPick: $("#cancel-pick"),
    basemapToggle: $(".basemap-toggle"),
    basemapButtons: document.querySelectorAll("[data-basemap]"),
    toast: $("#toast"),
    installBtn: $("#install-app"),

    dialog: $("#temple-dialog"),
    form: $("#temple-form"),
    dialogTitle: $("#temple-dialog-title"),
    dialogIntro: $("#dialog-intro"),
    kind: $("#field-kind"),
    osm: $("#field-osm"),
    name: $("#field-name"),
    deity: $("#field-deity"),
    city: $("#field-city"),
    address: $("#field-address"),
    notes: $("#field-notes"),
    lat: $("#field-lat"),
    lng: $("#field-lng"),
    coords: $("#coords-note"),
    photoInput: $("#field-photo"),
    choosePhoto: $("#choose-photo"),
    photoHint: $("#photo-hint"),
    photoPreview: $("#photo-preview"),
    photoPreviewImg: $("#photo-preview-img"),
    removePhoto: $("#remove-photo"),
    pickBtn: $("#pick-location"),
    contributionNote: $("#contribution-note"),
    saveBtn: $('#temple-form button[type="submit"]'),
    duplicateWarning: $("#duplicate-warning"),
    duplicateText: $("#duplicate-text"),
    confirmDuplicate: $("#confirm-duplicate"),
    dismissDuplicate: $("#dismiss-duplicate"),

    contributions: $("#my-contributions"),
    contributionCount: $("#contribution-count"),
    contributionList: $("#contribution-list"),
    contributionsHint: $("#contributions-hint")
  };

  /* ==========================================================================
     State
     ========================================================================== */

  const state = {
    map: null,
    mapReady: false,
    temples: [],
    center: { ...DEFAULT_VIEW },
    radius: DEFAULT_VIEW.radius,
    query: "",
    selectedId: null,
    loading: false,
    basemap: "streets"
  };

  let loadToken = 0;
  let popup = null;
  let userMarker = null;
  let placementMarker = null;
  let pickingLocation = false;
  let basemapLayers = [];
  let toastTimer = null;
  let hasGlyphs = false;

  let communityPromise = null;
  let photoDataUrl = "";
  let pendingDuplicateKey = "";
  let duplicateAcknowledgedFor = "";

  /* ==========================================================================
     Small helpers
     ========================================================================== */

  function setStatus(message, { loading = false, error = false } = {}) {
    els.status.textContent = message;
    els.status.classList.toggle("is-loading", loading);
    els.status.classList.toggle("is-error", error);
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("is-visible");
    }, 5200);
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function titleCase(value) {
    if (!value) return "";
    return String(value)
      .replace(/[_-]+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return "";
    if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function distanceMeters(lat1, lng1, lat2, lng2) {
    const earthRadius = 6371000;
    const toRad = (degrees) => (degrees * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.sqrt(a));
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function numberOrNull(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function sanitiseHttpUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  // Photos may be a small inline data URL (local / Supabase) or a file published
  // next to the community JSON. Anything else, especially remote tracking
  // pixels, is refused because the page's CSP could not load it anyway.
  function sanitisePhoto(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(text)) {
      return text.length <= 1200 * 1024 ? text : "";
    }
    try {
      const url = new URL(text, document.baseURI);
      if (url.origin !== window.location.origin) return "";
      if (!/\/data\/photos\/[A-Za-z0-9._-]+$/.test(url.pathname)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function normaliseName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function namesMatch(left, right) {
    const a = normaliseName(left);
    const b = normaliseName(right);
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  function firstTag(tags, ...keys) {
    for (const key of keys) {
      const value = tags[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  // OSM occasionally tags a Hindu temple with a denomination from another
  // religion. Only surface traditions we can show confidently.
  const HINDU_TRADITIONS = new Set([
    "shaivism",
    "vaishnavism",
    "shaktism",
    "smartism",
    "hinduism",
    "swaminarayan",
    "srivaishnavism",
    "varkari",
    "lingayat",
    "aryasamaj",
    "iskcon",
    "satsang",
    "kabirpanth",
    "nath",
    "siddhanta"
  ]);

  function hinduDenomination(tags) {
    const raw = firstTag(tags, "denomination");
    if (!raw) return "";
    const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
    return HINDU_TRADITIONS.has(key) ? titleCase(raw) : "";
  }

  function zoomForRadius(radius) {
    if (radius <= 5000) return 13;
    if (radius <= 10000) return 12.4;
    if (radius <= 25000) return 11;
    return 10;
  }

  /* ==========================================================================
     Persistent view + temple cache
     ========================================================================== */

  function readView() {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (!raw) return { ...DEFAULT_VIEW };
      const saved = JSON.parse(raw);
      const radii = [5000, 10000, 25000, 50000];
      if (
        saved &&
        typeof saved.lat === "number" &&
        typeof saved.lng === "number" &&
        typeof saved.radius === "number" &&
        radii.includes(saved.radius) &&
        saved.lat >= -90 &&
        saved.lat <= 90 &&
        saved.lng >= -180 &&
        saved.lng <= 180
      ) {
        return {
          lat: saved.lat,
          lng: saved.lng,
          label: typeof saved.label === "string" && saved.label.trim() ? saved.label : "this area",
          radius: saved.radius
        };
      }
    } catch {
      /* Ignore corrupt storage. */
    }
    return { ...DEFAULT_VIEW };
  }

  function saveView() {
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({
          lat: state.center.lat,
          lng: state.center.lng,
          label: state.center.label,
          radius: state.radius
        })
      );
    } catch {
      /* Storage can be unavailable in private mode. */
    }
  }

  function cacheKey(lat, lng, radius) {
    return `${CACHE_PREFIX}${lat.toFixed(2)}_${lng.toFixed(2)}_${radius}`;
  }

  function readTempleCache(lat, lng, radius, allowStale = false) {
    try {
      const raw = localStorage.getItem(cacheKey(lat, lng, radius));
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || !Array.isArray(entry.elements)) return null;
      if (!allowStale && Date.now() - Number(entry.savedAt || 0) > CACHE_TTL) return null;
      return entry.elements;
    } catch {
      return null;
    }
  }

  function pruneTempleCaches() {
    try {
      const entries = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(CACHE_PREFIX)) continue;
        let savedAt = 0;
        try {
          savedAt = Number(JSON.parse(localStorage.getItem(key)).savedAt || 0);
        } catch {
          savedAt = 0;
        }
        entries.push({ key, savedAt });
      }
      if (entries.length >= MAX_CACHED_AREAS) {
        entries
          .sort((a, b) => a.savedAt - b.savedAt)
          .slice(0, entries.length - MAX_CACHED_AREAS + 1)
          .forEach((entry) => localStorage.removeItem(entry.key));
      }
    } catch {
      /* Ignore quota or privacy errors. */
    }
  }

  function writeTempleCache(lat, lng, radius, elements) {
    try {
      pruneTempleCaches();
      localStorage.setItem(
        cacheKey(lat, lng, radius),
        JSON.stringify({ savedAt: Date.now(), elements })
      );
    } catch (error) {
      console.warn("Could not cache temple data", error);
    }
  }

  /* ==========================================================================
     Overpass (OpenStreetMap) data
     ========================================================================== */

  function buildOverpassQuery(lat, lng, radius) {
    const latText = Number(lat).toFixed(5);
    const lngText = Number(lng).toFixed(5);
    return `[out:json][timeout:20];
nwr["amenity"="place_of_worship"]["religion"="hindu"](around:${radius},${latText},${lngText});
out center 300;`;
  }

  async function fetchOverpass(query) {
    let lastError = null;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Accept: "application/json"
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
        const data = await response.json();
        if (!data || !Array.isArray(data.elements)) throw new Error("Unexpected Overpass response");
        return data.elements;
      } catch (error) {
        lastError = error;
        console.warn(`Overpass endpoint failed: ${endpoint}`, error);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new Error("All Overpass endpoints failed");
  }

  /**
   * Ask our own cached proxy first (Cloudflare Pages Function, or the local
   * preview server). It keeps public Overpass servers from being hammered and
   * works even when their browser-facing rate limits kick in. On hosts without
   * the function, this 404s quickly and we fall back to Overpass directly.
   */
  async function fetchViaProxy(lat, lng, radius) {
    const url = new URL("api/temples", document.baseURI);
    url.search = new URLSearchParams({
      lat: Number(lat).toFixed(5),
      lng: Number(lng).toFixed(5),
      radius: String(radius)
    }).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      // No proxy on this host (static hosting, file preview, etc.).
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        return null;
      }
      if (!response.ok) throw new Error(`Temple proxy HTTP ${response.status}`);

      const data = await response.json();
      if (!data || !Array.isArray(data.elements)) {
        throw new Error("Unexpected temple proxy response");
      }
      return data.elements;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchTempleElements(lat, lng, radius) {
    try {
      const elements = await fetchViaProxy(lat, lng, radius);
      if (elements) return elements;
    } catch (error) {
      console.warn("Temple proxy unavailable; contacting OpenStreetMap directly.", error);
    }
    return fetchOverpass(buildOverpassQuery(lat, lng, radius));
  }

  function elementToTemple(element) {
    const tags = element.tags || {};
    let lat = element.lat;
    let lng = element.lon;
    if ((lat == null || lng == null) && element.center) {
      lat = element.center.lat;
      lng = element.center.lon;
    }
    if (typeof lat !== "number" || typeof lng !== "number") return null;

    const englishName = firstTag(tags, "name:en");
    const localName = firstTag(tags, "name", "name:hi");
    const name = englishName || localName;
    if (!name) return null;

    const website = sanitiseHttpUrl(firstTag(tags, "website", "contact:website"));

    const addressParts = [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:suburb"],
      tags["addr:city"],
      tags["addr:town"],
      tags["addr:village"],
      tags["addr:district"],
      tags["addr:state"],
      tags["addr:postcode"]
    ]
      .filter((part) => typeof part === "string" && part.trim())
      .map((part) => part.trim());

    const deity = firstTag(tags, "deity", "deity:en");
    return {
      id: `${element.type}/${element.id}`,
      osmType: element.type,
      osmId: element.id,
      name,
      nativeName: localName && localName !== name ? localName : "",
      deity,
      denomination: hinduDenomination(tags),      city: firstTag(tags, "addr:city", "addr:town", "addr:village", "addr:district", "addr:state"),
      address: addressParts.join(", "),
      notes: firstTag(tags, "description:en", "description"),
      phone: firstTag(tags, "phone", "contact:phone"),
      website,
      wikipedia: firstTag(tags, "wikipedia"),
      lat,
      lng,
      distance: distanceMeters(state.center.lat, state.center.lng, lat, lng)
    };
  }

  /* ==========================================================================
     Community temples (approved contributions)
     ========================================================================== */

  function parseOsmRef(value) {
    const match = /^(node|way|relation)\/(\d+)$/.exec(String(value || ""));
    return match ? { osmType: match[1], osmId: match[2] } : { osmType: "", osmId: "" };
  }

  function communityToTemple(record) {
    if (!record || typeof record !== "object") return null;

    const name = String(record.name || "").trim();
    const lat = Number(record.lat);
    const lng = Number(record.lng);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    const osm = parseOsmRef(record.osmId);
    return {
      id: String(record.id || `community/${lat.toFixed(5)},${lng.toFixed(5)}`),
      osmType: osm.osmType,
      osmId: osm.osmId,
      name,
      nativeName: String(record.nativeName || ""),
      deity: String(record.deity || ""),
      denomination: "",
      city: String(record.city || ""),
      address: String(record.address || ""),
      notes: String(record.notes || ""),
      phone: String(record.phone || ""),
      website: sanitiseHttpUrl(record.website),
      wikipedia: "",
      photo: sanitisePhoto(record.photo),
      lat,
      lng,
      isCommunity: true,
      distance: distanceMeters(state.center.lat, state.center.lng, lat, lng)
    };
  }

  function loadCommunityTemples({ force = false } = {}) {
    if (force) communityPromise = null;
    if (communityPromise) return communityPromise;

    communityPromise = (async () => {
      try {
        const response = await fetch(COMMUNITY_URL, {
          headers: { Accept: "application/json" }
        });
        if (!response.ok) return [];
        const data = await response.json();
        const records = data && Array.isArray(data.temples) ? data.temples : [];
        return records.map(communityToTemple).filter(Boolean);
      } catch (error) {
        console.warn("Community temple file unavailable", error);
        return [];
      }
    })();

    return communityPromise;
  }

  /**
   * Community entries win over an OSM temple at the same spot: a moderator has
   * seen the photo and notes. The OSM identifiers are still kept so the popup
   * can link back to the original object. Distant entries are skipped so a
   * national file can grow without slowing every map view down.
   */
  function mergeCommunityTemples(osmTemples, communityTemples, lat, lng, radius) {
    const merged = osmTemples.slice();

    communityTemples.forEach((record) => {
      const distance = distanceMeters(lat, lng, record.lat, record.lng);
      if (distance > radius) return;

      const temple = { ...record, distance };
      const matchIndex = merged.findIndex((item) => {
        if (item.isCommunity) return false;
        // An approved edit that names an OSM object replaces that exact pin,
        // even if the edit also corrects the temple's name.
        if (temple.osmType && temple.osmId && item.osmType && item.osmId) {
          if (`${item.osmType}/${item.osmId}` === `${temple.osmType}/${temple.osmId}`) return true;
        }
        return (
          distanceMeters(item.lat, item.lng, temple.lat, temple.lng) <= OSM_DUPLICATE_RADIUS &&
          namesMatch(item.name, temple.name)
        );
      });

      if (matchIndex === -1) {
        merged.push(temple);
        return;
      }

      const osm = merged[matchIndex];
      merged[matchIndex] = {
        ...osm,
        ...temple,
        id: temple.id,
        osmType: osm.osmType,
        osmId: osm.osmId,
        nativeName: temple.nativeName || osm.nativeName,
        deity: temple.deity || osm.deity,
        denomination: temple.denomination || osm.denomination,
        city: temple.city || osm.city,
        address: temple.address || osm.address,
        notes: temple.notes || osm.notes,
        phone: temple.phone || osm.phone,
        website: temple.website || osm.website,
        wikipedia: osm.wikipedia,
        photo: temple.photo,
        isCommunity: true
      };
    });

    return merged.sort((a, b) => a.distance - b.distance);
  }

  /* ==========================================================================
     Loading temples
     ========================================================================== */

  async function loadTemples({ lat, lng, label, radius, useCache = true, moveMap = true }) {
    const token = (loadToken += 1);
    state.loading = true;
    state.center = { lat, lng, label };
    state.radius = radius;
    saveView();

    els.list.setAttribute("aria-busy", "true");
    setStatus(`Finding Hindu temples within ${Math.round(radius / 1000)} km of ${label}…`, {
      loading: true
    });

    try {
      let elements = useCache ? readTempleCache(lat, lng, radius) : null;
      const fromCache = Boolean(elements);

      if (!elements) {
        elements = await fetchTempleElements(lat, lng, radius);
        if (token !== loadToken) return;
        writeTempleCache(lat, lng, radius, elements);
      }

      if (token !== loadToken) return;

      const osmTemples = elements.map(elementToTemple).filter(Boolean);
      const community = await loadCommunityTemples();
      if (token !== loadToken) return;

      state.temples = mergeCommunityTemples(osmTemples, community, lat, lng, radius);

      state.loading = false;
      els.list.setAttribute("aria-busy", "false");

      if (moveMap && state.map) {
        state.map.flyTo({
          center: [lng, lat],
          zoom: zoomForRadius(radius),
          duration: prefersReducedMotion() ? 0 : 900
        });
      }

      applyFilters();
      updateSummary(fromCache ? "Showing saved results." : "");
    } catch (error) {
      if (token !== loadToken) return;
      console.error("Temple load failed", error);
      state.loading = false;
      els.list.setAttribute("aria-busy", "false");

      const stale = readTempleCache(lat, lng, radius, true);
      const community = await loadCommunityTemples();
      if (token !== loadToken) return;

      const osmTemples = stale ? stale.map(elementToTemple).filter(Boolean) : [];
      state.temples = mergeCommunityTemples(osmTemples, community, lat, lng, radius);
      applyFilters();

      if (state.temples.length) {
        setStatus(
          stale
            ? "Could not refresh right now. Showing saved temple results."
            : "OpenStreetMap is unavailable right now. Showing community temples.",
          { error: true }
        );
      } else {
        setStatus(
          "Could not reach the temple database. Check your connection and try again.",
          { error: true }
        );
      }
    }
  }

  /* ==========================================================================
     Filtering, list and summary
     ========================================================================== */

  function matchesQuery(temple, query) {
    const haystack = [
      temple.name,
      temple.nativeName,
      temple.deity,
      temple.city,
      temple.address,
      temple.denomination
    ]
      .join(" ")
      .toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => haystack.includes(term));
  }

  function getFilteredTemples() {
    const query = state.query.trim();
    if (!query) return state.temples;
    return state.temples.filter((temple) => matchesQuery(temple, query));
  }

  function createMetaSpan(text, className) {
    const span = document.createElement("span");
    if (className) span.className = className;
    span.textContent = text;
    return span;
  }

  function createTempleCard(temple) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "temple-card";
    button.dataset.id = temple.id;
    button.addEventListener("click", () => selectTemple(temple.id));

    const titleRow = document.createElement("span");
    titleRow.className = "temple-title-row";

    const name = document.createElement("span");
    name.className = "temple-name";
    name.textContent = temple.name;
    titleRow.append(name);

    if (temple.isCommunity) {
      const badge = document.createElement("span");
      badge.className = "badge-community";
      badge.textContent = "Community";
      badge.title = "Added by a devotee and checked by a moderator";
      titleRow.append(badge);
    }

    button.append(titleRow);

    if (temple.nativeName) {
      const native = createMetaSpan(temple.nativeName, "temple-native");
      native.lang = "hi";
      button.append(native);
    }

    const meta = document.createElement("span");
    meta.className = "temple-meta";
    meta.append(createMetaSpan(formatDistance(temple.distance), "temple-distance"));

    if (temple.city) meta.append(createMetaSpan(temple.city));

    const details = [
      temple.deity ? `Deity: ${temple.deity}` : "",
      titleCase(temple.denomination)
    ]
      .filter(Boolean)
      .join(" · ");
    if (details) meta.append(createMetaSpan(details));

    button.append(meta);
    item.append(button);
    return item;
  }

  function renderList() {
    const temples = getFilteredTemples();
    els.list.textContent = "";

    if (!temples.length) {
      const hasAny = state.temples.length > 0;
      const title = els.empty.querySelector("h3");
      const text = els.empty.querySelector("p");
      if (hasAny) {
        title.textContent = "No matching temples";
        text.textContent = "Try a different name, or clear the search to see all temples nearby.";
      } else {
        title.textContent = "No temples found here yet";
        text.textContent = "Try a larger radius, search for a city, or add a temple you know.";
      }
      els.empty.hidden = false;
      highlightList();
      return;
    }

    els.empty.hidden = true;
    const fragment = document.createDocumentFragment();
    temples.forEach((temple) => fragment.append(createTempleCard(temple)));
    els.list.append(fragment);
    highlightList();
  }

  function updateSummary(extra = "") {
    if (state.loading) return;

    const filtered = getFilteredTemples();
    const total = state.temples.length;
    const query = state.query.trim();
    const radiusKm = Math.round(state.radius / 1000);
    let message;

    if (query) {
      message = filtered.length
        ? `${filtered.length} of ${total} temples match “${query}”.`
        : `No temples match “${query}” in this area. Try a city name or “Temples near me”.`;
    } else if (total) {
      message = `${total} Hindu temple${total === 1 ? "" : "s"} within ${radiusKm} km of ${state.center.label}. Tap a pin or a name for details.`;
    } else {
      message = `No named Hindu temples found within ${radiusKm} km of ${state.center.label}. Try a larger radius or add one you know.`;
    }

    setStatus(extra ? `${message} ${extra}` : message);
  }

  function applyFilters() {
    renderList();
    updateMapSource();
    updateSummary();
  }

  function highlightList() {
    els.list.querySelectorAll(".temple-card").forEach((button) => {
      const active = button.dataset.id === state.selectedId;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  }

  /* ==========================================================================
     Map
     ========================================================================== */

  function emptyFeatureCollection() {
    return { type: "FeatureCollection", features: [] };
  }

  async function loadMapStyle() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(MAP_STYLE_URL, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Style HTTP ${response.status}`);
      const style = await response.json();
      if (!style || !style.version || !style.sources) throw new Error("Invalid map style");
      return style;
    } catch (error) {
      console.warn("OpenFreeMap unavailable; using OpenStreetMap raster tiles.", error);
      return OSM_RASTER_STYLE;
    } finally {
      clearTimeout(timer);
    }
  }

  function waitForMapLoad() {
    return new Promise((resolve, reject) => {
      if (state.map.loaded()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("Map timed out")), 15000);
      state.map.once("load", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function addTempleLayers() {
    const map = state.map;

    map.addSource("temples", {
      type: "geojson",
      data: emptyFeatureCollection(),
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 48
    });

    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "temples",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#b65f16",
        "circle-radius": ["step", ["get", "point_count"], 17, 10, 22, 50, 28],
        "circle-stroke-color": "#fbf6ec",
        "circle-stroke-width": 2,
        "circle-opacity": 0.94
      }
    });

    if (hasGlyphs) {
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "temples",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12
        },
        paint: {
          "text-color": "#fffaf0"
        }
      });
    }

    map.addLayer({
      id: "temple-points",
      type: "circle",
      source: "temples",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ["case", ["==", ["get", "community"], 1], "#b65f16", "#6b1d1d"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 4, 12, 6.5, 16, 9],
        "circle-stroke-color": "#f3d99b",
        "circle-stroke-width": 1.6
      }
    });

    if (hasGlyphs) {
      map.addLayer({
        id: "temple-labels",
        type: "symbol",
        source: "temples",
        minzoom: 11.5,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["coalesce", ["get", "name"], ""],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-max-width": 9,
          "text-optional": true
        },
        paint: {
          "text-color": "#3b2a1d",
          "text-halo-color": "#fbf6ec",
          "text-halo-width": 1.4
        }
      });
    }
  }

  /* --------------------------------------------------------------------------
     Basemap: streets (OpenFreeMap) or satellite (Esri World Imagery)
     -------------------------------------------------------------------------- */

  function readBasemap() {
    try {
      return localStorage.getItem(BASEMAP_KEY) === "satellite" ? "satellite" : "streets";
    } catch {
      return "streets";
    }
  }

  function saveBasemap(kind) {
    try {
      localStorage.setItem(BASEMAP_KEY, kind);
    } catch {
      /* Private mode; the choice just won't persist. */
    }
  }

  function addSatelliteBasemap() {
    const map = state.map;
    if (!map || map.getSource("satellite-imagery")) return;

    const style = map.getStyle();
    const layers = style.layers || [];
    const custom = new Set([
      ...SATELLITE_LAYERS,
      "clusters",
      "cluster-count",
      "temple-points",
      "temple-labels"
    ]);

    // Remember each stock layer's visibility so switching back is lossless.
    basemapLayers = layers
      .filter((layer) => !custom.has(layer.id))
      .map((layer) => ({
        id: layer.id,
        visibility: (layer.layout && layer.layout.visibility) || "visible"
      }));

    // Insert above the background but below roads/labels so pins stay on top.
    const backgroundIndex = layers.findIndex((layer) => layer.type === "background");
    const beforeId =
      backgroundIndex >= 0 ? (layers[backgroundIndex + 1] || {}).id : (layers[0] || {}).id;

    map.addSource("satellite-imagery", SATELLITE_SOURCES.imagery);
    map.addSource("satellite-labels", SATELLITE_SOURCES.labels);

    map.addLayer(
      {
        id: "satellite-imagery",
        type: "raster",
        source: "satellite-imagery",
        layout: { visibility: "none" }
      },
      beforeId
    );
    map.addLayer(
      {
        id: "satellite-labels",
        type: "raster",
        source: "satellite-labels",
        layout: { visibility: "none" }
      },
      beforeId
    );
  }

  function setBasemap(kind) {
    const next = kind === "satellite" ? "satellite" : "streets";
    state.basemap = next;
    saveBasemap(next);

    els.basemapButtons.forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.basemap === next ? "true" : "false");
    });

    if (!state.map || !state.mapReady) return;
    const satellite = next === "satellite";

    basemapLayers.forEach(({ id, visibility }) => {
      if (!state.map.getLayer(id)) return;
      state.map.setLayoutProperty(id, "visibility", satellite ? "none" : visibility);
    });

    SATELLITE_LAYERS.forEach((id) => {
      if (!state.map.getLayer(id)) return;
      state.map.setLayoutProperty(id, "visibility", satellite ? "visible" : "none");
    });

    // Dark pins need a brighter ring over photographic imagery.
    if (state.map.getLayer("temple-points")) {
      state.map.setPaintProperty(
        "temple-points",
        "circle-stroke-color",
        satellite ? "#ffffff" : "#f3d99b"
      );
      state.map.setPaintProperty("temple-points", "circle-stroke-width", satellite ? 2.4 : 1.6);
    }
    if (state.map.getLayer("clusters")) {
      state.map.setPaintProperty(
        "clusters",
        "circle-stroke-color",
        satellite ? "#ffffff" : "#fbf6ec"
      );
      state.map.setPaintProperty("clusters", "circle-stroke-width", satellite ? 3 : 2);
    }
  }

  function addMapEvents() {
    const map = state.map;

    map.on("click", "clusters", async (event) => {
      if (pickingLocation) return;
      const feature = event.features && event.features[0];
      if (!feature) return;
      try {
        const zoom = await map.getSource("temples").getClusterExpansionZoom(feature.properties.cluster_id);
        map.easeTo({
          center: feature.geometry.coordinates,
          zoom,
          duration: prefersReducedMotion() ? 0 : 500
        });
      } catch (error) {
        console.warn("Could not expand cluster", error);
      }
    });

    map.on("click", "temple-points", (event) => {
      if (pickingLocation) return;
      const feature = event.features && event.features[0];
      if (!feature) return;
      hideMapHint();
      selectTemple(feature.properties.id, { fly: false });
    });

    ["clusters", "temple-points"].forEach((layer) => {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = pickingLocation ? "crosshair" : "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = pickingLocation ? "crosshair" : "";
      });
    });

    map.on("dragstart", () => {
      if (!pickingLocation) hideMapHint();
    });

    map.on("click", (event) => {
      hideMapHint();
      if (pickingLocation) finishPicking(event.lngLat);
    });
  }

  function hideMapHint() {
    if (els.mapHint) els.mapHint.classList.add("is-hidden");
  }

  async function initMap(view) {
    if (!window.maplibregl) throw new Error("MapLibre failed to load");

    const style = await loadMapStyle();
    state.map = new window.maplibregl.Map({
      container: "map",
      style,
      center: [view.lng, view.lat],
      zoom: zoomForRadius(view.radius),
      minZoom: 3,
      maxZoom: 19,
      attributionControl: false
    });

    state.map.addControl(
      new window.maplibregl.NavigationControl({ showCompass: false }),
      "top-right"
    );
    state.map.addControl(new window.maplibregl.AttributionControl({ compact: true }), "bottom-right");

    await waitForMapLoad();

    hasGlyphs = Boolean(state.map.getStyle().glyphs);
    addTempleLayers();
    addMapEvents();
    addSatelliteBasemap();

    state.mapReady = true;
    setBasemap(readBasemap());
    updateMapSource();
  }

  function showMapFallback(error) {
    console.error("Map unavailable", error);
    hideMapHint();
    if (els.basemapToggle) els.basemapToggle.hidden = true;
    if (els.mapNotice) els.mapNotice.hidden = true;
    const container = document.getElementById("map");
    if (!container) return;
    container.textContent = "";
    const box = document.createElement("div");
    box.className = "map-fallback";
    const title = document.createElement("h2");
    title.textContent = "Map couldn't load";
    const text = document.createElement("p");
    text.textContent =
      "The temple list still works. Try a browser with WebGL enabled, or use the search and list on the left.";
    box.append(title, text);
    container.append(box);
  }

  function updateMapSource() {
    if (!state.map || !state.mapReady) return;
    const source = state.map.getSource("temples");
    if (!source) return;

    const features = getFilteredTemples().map((temple) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [temple.lng, temple.lat] },
      properties: {
        id: temple.id,
        name: temple.name,
        community: temple.isCommunity ? 1 : 0
      }
    }));

    source.setData({ type: "FeatureCollection", features });
  }

  function selectTemple(id, { fly = true } = {}) {
    const temple = state.temples.find((item) => item.id === id);
    if (!temple) return;

    state.selectedId = id;
    highlightList();
    updateShareUrl(temple);

    const activeCard = els.list.querySelector(`.temple-card[data-id="${CSS.escape(id)}"]`);
    if (activeCard) activeCard.scrollIntoView({ block: "nearest" });

    if (!state.map || !state.mapReady) return;

    if (fly) {
      state.map.flyTo({
        center: [temple.lng, temple.lat],
        zoom: Math.max(state.map.getZoom(), 13.4),
        duration: prefersReducedMotion() ? 0 : 850
      });
    }

    openPopup(temple);
  }

  function openPopup(temple) {
    if (!state.map || !state.mapReady) return;
    if (!popup) {
      popup = new window.maplibregl.Popup({
        offset: 14,
        closeButton: true,
        maxWidth: "300px"
      });
      popup.on("close", () => {
        state.selectedId = null;
        highlightList();
        updateShareUrl(null);
      });
    }
    popup.setLngLat([temple.lng, temple.lat]).setDOMContent(buildPopupContent(temple)).addTo(state.map);
  }

  function addChip(parent, text, extraClass) {
    const chip = document.createElement("span");
    chip.className = extraClass ? `chip ${extraClass}` : "chip";
    chip.textContent = text;
    parent.append(chip);
  }

  function buildPopupContent(temple) {
    const root = document.createElement("div");
    root.className = "temple-popup";

    if (temple.photo) {
      const figure = document.createElement("figure");
      figure.className = "popup-photo";
      const image = document.createElement("img");
      image.src = temple.photo;
      image.alt = `Photo of ${temple.name}`;
      image.loading = "lazy";
      image.decoding = "async";
      figure.append(image);
      root.append(figure);
    }

    const heading = document.createElement("h3");
    heading.textContent = temple.name;
    root.append(heading);

    if (temple.nativeName) {
      const native = document.createElement("p");
      native.className = "popup-native";
      native.lang = "hi";
      native.textContent = temple.nativeName;
      root.append(native);
    }

    const chips = document.createElement("div");
    chips.className = "popup-chips";
    if (Number.isFinite(temple.distance)) {
      addChip(chips, formatDistance(temple.distance), "is-distance");
    }
    if (temple.isCommunity) addChip(chips, "Community added", "is-community");
    if (temple.deity) addChip(chips, `Deity: ${temple.deity}`);
    else if (temple.denomination) addChip(chips, titleCase(temple.denomination));
    if (temple.city) addChip(chips, temple.city);
    if (chips.childElementCount) root.append(chips);

    if (temple.address) {
      const address = document.createElement("p");
      address.className = "popup-address";
      address.textContent = temple.address;
      root.append(address);
    }

    if (temple.notes) {
      const notes = document.createElement("p");
      notes.className = "popup-notes";
      notes.textContent =
        temple.notes.length > 320 ? `${temple.notes.slice(0, 317)}…` : temple.notes;
      root.append(notes);
    }

    const links = document.createElement("div");
    links.className = "popup-links";

    const directions = document.createElement("a");
    directions.href = `https://www.google.com/maps/dir/?api=1&destination=${temple.lat},${temple.lng}`;
    directions.target = "_blank";
    directions.rel = "noopener noreferrer";
    directions.textContent = "Directions ↗";
    links.append(directions);

    const osm = document.createElement("a");
    if (temple.osmType && temple.osmId) {
      osm.href = `https://www.openstreetmap.org/${temple.osmType}/${temple.osmId}`;
      osm.target = "_blank";
      osm.rel = "noopener noreferrer";
      osm.textContent = "OSM ↗";
      links.append(osm);
    }

    const share = document.createElement("button");
    share.type = "button";
    share.className = "link-button";
    share.textContent = "Share";
    share.addEventListener("click", () => shareTemple(temple));
    links.append(share);

    if (temple.website) {
      const website = document.createElement("a");
      website.href = temple.website;
      website.target = "_blank";
      website.rel = "noopener noreferrer";
      website.textContent = "Website ↗";
      links.append(website);
    }

    if (temple.phone) {
      const phone = document.createElement("a");
      phone.href = `tel:${temple.phone.replace(/[^\d+]/g, "")}`;
      phone.textContent = "Call";
      links.append(phone);
    }

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "link-button";
    edit.textContent = "Suggest an edit";
    edit.addEventListener("click", () => openTempleDialog({ mode: "edit", temple }));
    links.append(edit);

    root.append(links);
    return root;
  }

  function templeShareUrl(temple) {
    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    url.searchParams.set("temple", temple.id);
    return url.href;
  }

  function updateShareUrl(temple) {
    try {
      const url = new URL(window.location.href);
      if (temple) url.searchParams.set("temple", temple.id);
      else url.searchParams.delete("temple");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`
      );
    } catch {
      /* History can be restricted on file:// pages. */
    }
  }

  function readSharedTempleId() {
    try {
      return new URL(window.location.href).searchParams.get("temple") || "";
    } catch {
      return "";
    }
  }

  async function shareTemple(temple) {
    const url = templeShareUrl(temple);
    const title = `${temple.name} · Mandir Marg`;
    const text = `Find ${temple.name} on Mandir Marg`;

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }

    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(url);
      showToast("Temple link copied. Share it on WhatsApp.");
    } catch {
      window.prompt("Copy this temple link:", url);
    }
  }

  // A shared ?temple= link can point at a community temple that is outside the
  // visitor's saved view. Load the area around it, then open its card.
  async function openSharedTemple() {
    const id = readSharedTempleId();
    if (!id) return;

    if (state.temples.some((temple) => temple.id === id)) {
      selectTemple(id);
      return;
    }

    const community = await loadCommunityTemples();
    const record = community.find((temple) => temple.id === id);
    if (!record) return;

    if (!state.map || !state.mapReady) {
      const distance = distanceMeters(state.center.lat, state.center.lng, record.lat, record.lng);
      state.temples = [...state.temples, { ...record, distance }].sort(
        (a, b) => a.distance - b.distance
      );
      applyFilters();
      return;
    }

    await loadTemples({
      lat: record.lat,
      lng: record.lng,
      label: record.city || record.name,
      radius: Number(els.radius.value) || DEFAULT_VIEW.radius,
      useCache: true
    });

    if (state.temples.some((temple) => temple.id === id)) selectTemple(id);
  }

  function showUserMarker(lat, lng) {
    if (!state.map || !window.maplibregl) return;
    if (!userMarker) {
      const element = document.createElement("div");
      element.className = "user-dot";
      element.setAttribute("aria-hidden", "true");
      userMarker = new window.maplibregl.Marker({ element, anchor: "center" })
        .setLngLat([lng, lat])
        .addTo(state.map);
    } else {
      userMarker.setLngLat([lng, lat]);
    }
  }

  /* ==========================================================================
     Search + geolocation
     ========================================================================== */

  async function geocodePlace(query) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
        `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=1&lang=en`,
        { headers: { Accept: "application/json" }, signal: controller.signal }
      );
      if (!response.ok) throw new Error(`Photon HTTP ${response.status}`);
      const data = await response.json();
      const feature = data && Array.isArray(data.features) ? data.features[0] : null;
      if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
        return null;
      }
      const [lng, lat] = feature.geometry.coordinates;
      if (typeof lat !== "number" || typeof lng !== "number") return null;

      const properties = feature.properties || {};
      const parts = [
        properties.name,
        properties.city || properties.town || properties.village || properties.county,
        properties.state,
        properties.country
      ].filter(Boolean);
      const label = [...new Set(parts)].slice(0, 2).join(", ") || query;
      return { lat, lng, label };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleSearch(event) {
    event.preventDefault();
    const raw = els.searchInput.value.trim();
    state.query = raw;

    if (!raw) {
      applyFilters();
      return;
    }

    const localMatches = getFilteredTemples();
    if (localMatches.length) {
      applyFilters();
      showToast(`${localMatches.length} temple${localMatches.length === 1 ? "" : "s"} match “${raw}”.`);
      return;
    }

    els.list.setAttribute("aria-busy", "true");
    setStatus(`Looking for “${raw}”…`, { loading: true });

    try {
      const place = await geocodePlace(raw);
      els.list.setAttribute("aria-busy", "false");

      if (!place) {
        setStatus(
          `No temples match “${raw}” in this area. Try a nearby city or use “Temples near me”.`,
          { error: true }
        );
        return;
      }

      els.searchInput.value = "";
      state.query = "";
      await loadTemples({
        lat: place.lat,
        lng: place.lng,
        label: place.label,
        radius: Number(els.radius.value)
      });
      showToast(`Moved to ${place.label}`);
    } catch (error) {
      console.error("Place search failed", error);
      els.list.setAttribute("aria-busy", "false");
      setStatus("Could not search places right now. Check your connection, or use “Temples near me”.", {
        error: true
      });
    }
  }

  function geoErrorMessage(error) {
    if (!error) return "Could not get your location. Try searching for your city instead.";
    switch (error.code) {
      case 1:
        return "Location permission was blocked. Allow location access in your browser, or search for your city instead.";
      case 2:
        return "Your location is unavailable right now. Check your device settings or search for your city.";
      case 3:
        return "Getting your location took too long. Please try again.";
      default:
        return "Could not get your location. Search for your city instead.";
    }
  }

  function handleNearMe() {
    if (!navigator.geolocation) {
      setStatus("This browser does not support location. Search for your city instead.", {
        error: true
      });
      return;
    }

    const originalLabel = els.nearMe.textContent;
    els.nearMe.disabled = true;
    els.nearMe.textContent = "Locating…";
    setStatus("Getting your location…", { loading: true });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        els.nearMe.disabled = false;
        els.nearMe.textContent = originalLabel;
        const { latitude, longitude } = position.coords;
        showUserMarker(latitude, longitude);
        loadTemples({
          lat: latitude,
          lng: longitude,
          label: "your location",
          radius: Number(els.radius.value)
        });
      },
      (error) => {
        els.nearMe.disabled = false;
        els.nearMe.textContent = originalLabel;
        setStatus(geoErrorMessage(error), { error: true });
        showToast("Location unavailable — try searching for your city.");
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  }

  /* ==========================================================================
     Temple dialog + contributions
     ========================================================================== */

  const PHOTO_HINT_DEFAULT =
    "A photo taken at the temple can place the pin for you. Its GPS is read on your device, and location metadata is removed from the published image.";

  function setPhotoPreview(dataUrl) {
    photoDataUrl = dataUrl || "";
    if (els.photoPreview) els.photoPreview.hidden = !photoDataUrl;
    if (els.photoPreviewImg) {
      if (photoDataUrl) els.photoPreviewImg.src = photoDataUrl;
      else els.photoPreviewImg.removeAttribute("src");
    }
    if (els.choosePhoto) {
      els.choosePhoto.textContent = photoDataUrl
        ? "📷 Replace photo"
        : "📷 Add a geotagged photo";
    }
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      if (typeof window.URL.createObjectURL !== "function") {
        reject(new Error("Object URLs are unavailable"));
        return;
      }
      const objectUrl = window.URL.createObjectURL(file);
      const image = new window.Image();
      image.onload = () => {
        window.URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        window.URL.revokeObjectURL(objectUrl);
        reject(new Error("Unreadable image"));
      };
      image.src = objectUrl;
    });
  }

  // Draw through a canvas so the stored photo is small and carries no EXIF
  // (camera model, timestamps, or the original GPS trace).
  async function preparePhoto(file) {
    if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type)) return "";

    const image = await loadImageElement(file);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return "";

    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let dataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
    if (dataUrl.length > PHOTO_MAX_DATA_URL) {
      dataUrl = canvas.toDataURL("image/jpeg", 0.5);
    }
    return dataUrl.length <= PHOTO_MAX_DATA_URL ? dataUrl : "";
  }

  async function handlePhotoSelected() {
    const file =
      els.photoInput && els.photoInput.files ? els.photoInput.files[0] : null;
    if (!file) return;

    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      els.photoHint.textContent = "Please choose a JPEG, PNG or WebP image.";
      els.photoInput.value = "";
      return;
    }

    els.photoHint.textContent = "Reading the photo on your device…";

    let gps = null;
    if (window.MandirMargExif) {
      try {
        gps = await window.MandirMargExif.readGpsFromFile(file);
      } catch {
        gps = null;
      }
    }

    let dataUrl = "";
    try {
      dataUrl = await preparePhoto(file);
    } catch (error) {
      console.warn("Could not prepare photo", error);
    }

    if (!dataUrl) {
      setPhotoPreview("");
      els.photoHint.textContent =
        "This image could not be prepared. Try a JPEG photo, or add the temple without one.";
      els.photoInput.value = "";
      return;
    }

    setPhotoPreview(dataUrl);

    if (!gps) {
      els.photoHint.textContent =
        "Photo added. It has no GPS — use “Pick the exact spot” to place the pin by hand.";
      return;
    }

    const currentLat = Number.parseFloat(els.lat.value);
    const currentLng = Number.parseFloat(els.lng.value);
    const manual = els.lat.dataset.picked === "true";
    const away =
      Number.isFinite(currentLat) && Number.isFinite(currentLng)
        ? distanceMeters(currentLat, currentLng, gps.lat, gps.lng)
        : 0;

    if (!manual || away > 500) {
      els.lat.value = gps.lat.toFixed(6);
      els.lng.value = gps.lng.toFixed(6);
      els.lat.dataset.picked = "photo";
      updateCoordsNote();
      showPlacementMarker(gps);
      els.photoHint.textContent = `Photo added. Its GPS placed the pin at ${gps.lat.toFixed(
        5
      )}, ${gps.lng.toFixed(5)} — please check it on the map.`;
    } else if (away > 150) {
      els.photoHint.textContent = `Photo added. It was taken ${formatDistance(
        away
      )} from your chosen pin, so your pin was kept.`;
    } else {
      els.photoHint.textContent = "Photo added. Its GPS matches your chosen pin.";
    }
  }

  function clearPhoto() {
    photoDataUrl = "";
    if (els.photoInput) els.photoInput.value = "";
    setPhotoPreview("");
    if (els.photoHint) els.photoHint.textContent = PHOTO_HINT_DEFAULT;
  }

  function updateCoordsNote() {
    const lat = Number.parseFloat(els.lat.value);
    const lng = Number.parseFloat(els.lng.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      els.coords.textContent = "";
      return;
    }

    const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const source = els.lat.dataset.picked;
    const picked = source === "true";
    const fromPhoto = source === "photo";

    if (fromPhoto) {
      els.coords.textContent = `Location read from the photo's GPS: ${coords}. Check it on the map before saving.`;
    } else if (els.kind.value === "edit") {
      els.coords.textContent = picked
        ? `New location picked on the map: ${coords}`
        : `Current location: ${coords}. Use “Pick the exact spot” to correct it.`;
    } else {
      els.coords.textContent = picked
        ? `Location picked on the map: ${coords}`
        : `Location: map centre (${coords}). Use “Pick the exact spot” for an accurate pin.`;
    }
  }

  function showPlacementMarker(lngLat) {
    if (!state.map || !window.maplibregl) return;

    if (!placementMarker) {
      const element = document.createElement("div");
      element.className = "placement-pin";
      element.setAttribute("aria-hidden", "true");
      placementMarker = new window.maplibregl.Marker({ element, anchor: "center" })
        .setLngLat([lngLat.lng, lngLat.lat])
        .addTo(state.map);
    } else {
      placementMarker.setLngLat([lngLat.lng, lngLat.lat]);
    }
  }

  function clearPlacementMarker() {
    if (!placementMarker) return;
    placementMarker.remove();
    placementMarker = null;
  }

  function startPicking() {
    if (!state.map || !state.mapReady) {
      showToast("The map is still loading. Please try again in a moment.");
      return;
    }

    pickingLocation = true;
    els.dialog.close();
    setBasemap("satellite");
    els.mapNotice.hidden = false;
    els.mapHint.classList.add("is-hidden");
    state.map.getCanvas().style.cursor = "crosshair";

    // Jump to the starting point at rooftop scale so the temple is recognisable.
    const lat = Number.parseFloat(els.lat.value);
    const lng = Number.parseFloat(els.lng.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      state.map.easeTo({
        center: [lng, lat],
        zoom: Math.max(state.map.getZoom(), 15),
        duration: prefersReducedMotion() ? 0 : 600
      });
    }
  }

  function finishPicking(lngLat) {
    pickingLocation = false;
    els.mapNotice.hidden = true;
    if (state.map) state.map.getCanvas().style.cursor = "";

    els.lat.value = lngLat.lat.toFixed(6);
    els.lng.value = lngLat.lng.toFixed(6);
    els.lat.dataset.picked = "true";
    updateCoordsNote();
    showPlacementMarker(lngLat);

    els.dialog.showModal();
    showToast("Location set. Add the temple's name and save.");
  }

  function cancelPicking() {
    pickingLocation = false;
    els.mapNotice.hidden = true;
    if (state.map) state.map.getCanvas().style.cursor = "";
    els.dialog.showModal();
  }

  /**
   * Which existing record the suggestion targets. An edit of a community
   * temple stores its `community/<uuid>` id so the publisher replaces that
   * entry; an edit of an OSM temple stores `node|way|relation/<id>`.
   */
  function osmReferenceFor(temple) {
    if (!temple) return "";
    if (temple.isCommunity) return temple.id;
    return temple.osmType && temple.osmId ? `${temple.osmType}/${temple.osmId}` : "";
  }

  function openTempleDialog({ mode = "add", temple = null } = {}) {
    els.form.reset();

    clearPhoto();
    duplicateAcknowledgedFor = "";
    pendingDuplicateKey = "";
    if (els.duplicateWarning) els.duplicateWarning.hidden = true;

    // If the visitor reopens the form while placing a pin, leave pick mode.
    pickingLocation = false;
    if (els.mapNotice) els.mapNotice.hidden = true;
    if (state.map) state.map.getCanvas().style.cursor = "";
    clearPlacementMarker();

    els.kind.value = mode;
    els.osm.value = osmReferenceFor(temple);
    els.name.value = temple ? temple.name : "";
    els.deity.value = temple ? temple.deity : "";
    els.city.value = temple ? temple.city : "";
    els.address.value = temple ? temple.address : "";
    // Pre-fill known notes so an edit improves them instead of wiping them.
    els.notes.value = temple && temple.notes ? temple.notes : "";

    const mapCenter = state.map
      ? state.map.getCenter()
      : { lat: state.center.lat, lng: state.center.lng };
    const lat = temple ? temple.lat : mapCenter.lat;
    const lng = temple ? temple.lng : mapCenter.lng;

    els.lat.value = lat.toFixed(6);
    els.lng.value = lng.toFixed(6);
    els.lat.dataset.picked = "false";

    els.dialogTitle.textContent = mode === "edit" ? "Suggest an edit" : "Add a temple";
    els.dialogIntro.textContent =
      mode === "edit"
        ? `Help us correct or complete the information for ${temple.name}.`
        : "Share what you know so other devotees can find this temple.";

    updateCoordsNote();

    els.contributionNote.textContent = HAS_SUPABASE
      ? "Your suggestion goes to a moderation queue and is reviewed before appearing publicly."
      : "This demo saves suggestions on this device. Connect a free Supabase project (see README) to collect contributions from everyone.";

    els.dialog.showModal();
    setTimeout(() => els.name.focus(), 0);
  }

  function readSuggestions() {
    try {
      const raw = localStorage.getItem(SUGGESTIONS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeSuggestions(suggestions) {
    const prepared = suggestions.slice(0, 50).map((item) => ({ ...item }));

    // localStorage is small (about 5 MB). Keep the newest photos, drop the
    // oldest ones first rather than failing to save the text at all.
    let photoBudget = LOCAL_PHOTO_BUDGET;
    prepared.forEach((item) => {
      if (!item.photo) return;
      if (item.photo.length <= photoBudget) photoBudget -= item.photo.length;
      else item.photo = "";
    });

    try {
      localStorage.setItem(SUGGESTIONS_KEY, JSON.stringify(prepared));
    } catch (error) {
      console.warn("Could not save suggestion locally", error);
      try {
        localStorage.setItem(
          SUGGESTIONS_KEY,
          JSON.stringify(prepared.map(({ photo, ...rest }) => rest))
        );
      } catch {
        /* Storage is full or unavailable; nothing else to do. */
      }
    }
  }

  function addSuggestion(suggestion) {
    const suggestions = readSuggestions();
    suggestions.unshift(suggestion);
    writeSuggestions(suggestions);
  }

  function removeSuggestion(id) {
    writeSuggestions(readSuggestions().filter((item) => item.id !== id));
    renderContributions();
  }

  function renderContributions() {
    const suggestions = readSuggestions();
    els.contributions.hidden = suggestions.length === 0;
    els.contributionCount.textContent = suggestions.length;
    els.contributionList.textContent = "";

    suggestions.forEach((item) => {
      const listItem = document.createElement("li");
      listItem.className = "contribution-item";

      const details = document.createElement("div");

      if (item.photo) {
        const thumb = document.createElement("img");
        thumb.className = "contribution-photo";
        thumb.src = item.photo;
        thumb.alt = "";
        thumb.loading = "lazy";
        details.append(thumb);
      }

      const title = document.createElement("span");
      title.className = "contribution-title";
      title.textContent = item.name;

      const meta = document.createElement("span");
      meta.className = "contribution-meta";
      const kind = item.kind === "edit" ? "Edit suggestion" : "New temple";
      const status = item.sent ? "Sent for review" : "Saved on this device";
      meta.textContent = `${kind} · ${status}${item.city ? ` · ${item.city}` : ""}`;

      details.append(title, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "contribution-delete";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove suggestion for ${item.name}`);
      remove.addEventListener("click", () => {
        removeSuggestion(item.id);
        showToast("Suggestion removed from this device.");
      });

      listItem.append(details, remove);
      els.contributionList.append(listItem);
    });

    els.contributionsHint.textContent = HAS_SUPABASE
      ? "Suggestions sent to the community queue are reviewed by moderators."
      : "Saved on this device. Connect a free Supabase project (see README) so everyone can contribute.";
  }

  async function sendToSupabase(suggestion) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/temple_suggestions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          kind: suggestion.kind,
          temple_name: suggestion.name,
          deity: suggestion.deity || null,
          city: suggestion.city || null,
          address: suggestion.address || null,
          notes: suggestion.notes || null,
          osm_id: suggestion.osmId || null,
          photo: suggestion.photo || null,
          lat: suggestion.lat,
          lng: suggestion.lng
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function suggestionKey(suggestion) {
    return `${suggestion.lat.toFixed(5)}|${suggestion.lng.toFixed(5)}|${normaliseName(suggestion.name)}`;
  }

  function findNearbyDuplicate(lat, lng, ignoreId = "") {
    let nearest = null;
    state.temples.forEach((temple) => {
      if (ignoreId && temple.id === ignoreId) return;
      const distance = distanceMeters(lat, lng, temple.lat, temple.lng);
      if (distance > DUPLICATE_RADIUS) return;
      if (!nearest || distance < nearest.distance) nearest = { temple, distance };
    });
    return nearest;
  }

  function showDuplicateWarning(nearby) {
    const source = nearby.temple.isCommunity ? "community entry" : "OpenStreetMap entry";
    els.duplicateText.textContent = `“${nearby.temple.name}” is already mapped ${formatDistance(
      nearby.distance
    )} from this spot (${source}). Is this the same temple? Close this and suggest an edit instead, or save it anyway if it is a separate shrine.`;
    els.duplicateWarning.hidden = false;
    els.duplicateWarning.focus();
    els.duplicateWarning.scrollIntoView({ block: "nearest" });
  }

  function hideDuplicateWarning() {
    pendingDuplicateKey = "";
    if (els.duplicateWarning) els.duplicateWarning.hidden = true;
  }

  function confirmDuplicate() {
    if (!pendingDuplicateKey) return;
    duplicateAcknowledgedFor = pendingDuplicateKey;
    hideDuplicateWarning();
    if (typeof els.form.requestSubmit === "function") els.form.requestSubmit();
    else handleTempleSubmit(new window.Event("submit", { bubbles: true, cancelable: true }));
  }

  async function handleTempleSubmit(event) {
    event.preventDefault();

    const suggestion = {
      id: makeId(),
      kind: els.kind.value === "edit" ? "edit" : "add",
      name: els.name.value.trim(),
      deity: els.deity.value.trim(),
      city: els.city.value.trim(),
      address: els.address.value.trim(),
      notes: els.notes.value.trim(),
      osmId: els.osm.value,
      photo: photoDataUrl || "",
      lat: numberOrNull(els.lat.value),
      lng: numberOrNull(els.lng.value),
      createdAt: new Date().toISOString(),
      sent: false
    };

    if (!suggestion.name) return;

    if (!Number.isFinite(suggestion.lat) || !Number.isFinite(suggestion.lng)) {
      showToast("Place the temple on the map first: use “Pick the exact spot”.");
      els.pickBtn.focus();
      return;
    }

    // Warn once when another temple is already mapped at this spot. The
    // moderator still sees every contribution; this just prevents accidental
    // duplicates and points people at the edit flow.
    if (suggestion.kind === "add") {
      const key = suggestionKey(suggestion);
      if (duplicateAcknowledgedFor !== key) {
        const nearby = findNearbyDuplicate(suggestion.lat, suggestion.lng);
        if (nearby) {
          pendingDuplicateKey = key;
          showDuplicateWarning(nearby);
          return;
        }
      }
    }

    els.saveBtn.disabled = true;
    let message = "Dhanyavaad! Saved on this device.";

    if (HAS_SUPABASE) {
      try {
        await sendToSupabase(suggestion);
        suggestion.sent = true;
        message = suggestion.photo
          ? "Dhanyavaad! Your temple and photo are awaiting review."
          : "Dhanyavaad! Your suggestion is awaiting review.";
      } catch (error) {
        console.error("Supabase submission failed", error);
        message = "The community server is unreachable — saved on this device instead.";
      }
    }

    addSuggestion(suggestion);
    renderContributions();
    duplicateAcknowledgedFor = "";
    hideDuplicateWarning();
    clearPhoto();
    els.dialog.close();
    els.saveBtn.disabled = false;
    showToast(message);
  }

  /* ==========================================================================
     Accessible validation sync (:user-invalid -> aria-invalid)
     ========================================================================== */

  function setupAriaValidation() {
    const announcer = document.createElement("div");
    announcer.setAttribute("aria-live", "polite");
    announcer.className = "visually-hidden";
    document.body.append(announcer);

    let announceTimer;
    let announcedField;

    const linkError = (element, shown) => {
      const errorId = element.dataset.error;
      if (!errorId) return;
      const ids = (element.getAttribute("aria-describedby") || "")
        .split(/\s+/)
        .filter((id) => id && id !== errorId);
      if (shown) ids.push(errorId);
      if (ids.length) element.setAttribute("aria-describedby", ids.join(" "));
      else element.removeAttribute("aria-describedby");
    };

    const announceError = (element) => {
      const error = document.getElementById(element.dataset.error);
      if (!error) return;
      const label = element.labels && element.labels[0] ? `${element.labels[0].textContent.trim()}: ` : "";
      clearTimeout(announceTimer);
      announcer.textContent = "";
      announcedField = element;
      announceTimer = setTimeout(() => {
        announcer.textContent = `${label}${error.textContent.trim()}`;
      }, 500);
    };

    const flagged = new WeakSet();
    const announced = new WeakSet();

    const syncAria = (element, announce = false) => {
      if (!element.matches || !element.matches("input, select, textarea")) return;
      const invalid = element.matches(":user-invalid");
      if (invalid) {
        if (announce && !announced.has(element)) {
          announceError(element);
          announced.add(element);
        }
        element.setAttribute("aria-invalid", "true");
        linkError(element, true);
        flagged.add(element);
      } else if (flagged.has(element) || element.getAttribute("aria-invalid") !== "true") {
        element.setAttribute("aria-invalid", "false");
        linkError(element, false);
        flagged.delete(element);
        announced.delete(element);
        if (announcedField === element) {
          clearTimeout(announceTimer);
          announcer.textContent = "";
        }
      }
    };

    document.querySelectorAll("input, select, textarea").forEach((element) => syncAria(element));

    document.addEventListener("blur", (event) => syncAria(event.target, true), true);
    document.addEventListener(
      "input",
      (event) => {
        if (event.target.hasAttribute && event.target.hasAttribute("aria-invalid")) {
          syncAria(event.target);
        }
      },
      true
    );
    document.addEventListener("change", (event) => syncAria(event.target, true), true);
    document.addEventListener(
      "invalid",
      (event) => {
        announced.add(event.target);
        syncAria(event.target);
      },
      true
    );
    document.addEventListener(
      "reset",
      (event) => {
        setTimeout(() => {
          [...event.target.elements].forEach((element) => syncAria(element));
        });
      },
      true
    );
  }

  /* ==========================================================================
     Dialogs, install prompt, service worker
     ========================================================================== */

  function setupDialogs() {
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => {
        const dialog = button.closest("dialog");
        if (dialog) dialog.close();
      });
    });

    // Light-dismiss fallback for browsers without `closedby`.
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
        let pressedOutside = false;
        const outside = (event) => {
          const rect = dialog.getBoundingClientRect();
          return (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          );
        };
        dialog.addEventListener("pointerdown", (event) => {
          pressedOutside = outside(event);
        });
        dialog.addEventListener("pointerup", (event) => {
          if (pressedOutside && outside(event)) dialog.close();
        });
      });
    }
  }

  function setupInstall() {
    const button = els.installBtn;
    if (!button) return;

    let deferredPrompt = null;
    const supportsWebInstall = typeof Navigator.prototype.install === "function";

    if (supportsWebInstall) button.hidden = false;

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredPrompt = event;
      if (!supportsWebInstall) button.hidden = false;
    });

    window.addEventListener("appinstalled", () => {
      button.hidden = true;
      showToast("Mandir Marg is installed. Har Har Mahadev!");
    });

    button.addEventListener("click", async () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      button.setAttribute("aria-disabled", "true");

      try {
        if (supportsWebInstall) {
          await navigator.install();
          button.hidden = true;
          showToast("Mandir Marg installed.");
        } else if (deferredPrompt) {
          const promptEvent = deferredPrompt;
          deferredPrompt = null;
          await promptEvent.prompt();
          const { outcome } = await promptEvent.userChoice;
          showToast(outcome === "accepted" ? "Mandir Marg installed." : "Installation canceled.");
          button.hidden = true;
        }
      } catch (error) {
        if (error && error.name === "AbortError") {
          showToast("Installation was canceled.");
        } else {
          console.error("Install failed", error);
          showToast("Installation could not start.");
        }
      } finally {
        button.removeAttribute("aria-disabled");
      }
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const isLocal =
      location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (location.protocol !== "https:" && !isLocal) return;

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.warn("Service worker registration failed", error);
      });
    });
  }

  /* ==========================================================================
     Init
     ========================================================================== */

  function bindEvents() {
    els.searchForm.addEventListener("submit", handleSearch);

    els.searchInput.addEventListener("input", () => {
      state.query = els.searchInput.value;
      applyFilters();
    });

    els.radius.addEventListener("change", () => {
      loadTemples({
        lat: state.center.lat,
        lng: state.center.lng,
        label: state.center.label,
        radius: Number(els.radius.value),
        moveMap: false
      });
    });

    els.nearMe.addEventListener("click", handleNearMe);

    els.basemapButtons.forEach((button) => {
      button.addEventListener("click", () => setBasemap(button.dataset.basemap));
    });

    els.pickBtn.addEventListener("click", startPicking);
    els.cancelPick.addEventListener("click", cancelPicking);

    els.choosePhoto.addEventListener("click", () => els.photoInput.click());
    els.photoInput.addEventListener("change", handlePhotoSelected);
    els.removePhoto.addEventListener("click", clearPhoto);
    els.confirmDuplicate.addEventListener("click", confirmDuplicate);
    els.dismissDuplicate.addEventListener("click", hideDuplicateWarning);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && pickingLocation) {
        event.preventDefault();
        cancelPicking();
      }
    });

    els.dialog.addEventListener("close", clearPlacementMarker);

    document.querySelectorAll("[data-open-add]").forEach((button) => {
      button.addEventListener("click", () => openTempleDialog({ mode: "add" }));
    });

    els.form.addEventListener("submit", handleTempleSubmit);
  }

  function init() {
    setupAriaValidation();
    setupDialogs();
    setupInstall();
    registerServiceWorker();
    renderContributions();
    bindEvents();

    const view = readView();
    els.radius.value = String(view.radius);

    const mapReady = initMap(view).catch((error) => {
      showMapFallback(error);
    });

    loadTemples({
      lat: view.lat,
      lng: view.lng,
      label: view.label,
      radius: view.radius,
      useCache: true,
      moveMap: false
    })
      .then(() => mapReady)
      .then(openSharedTemple)
      .catch((error) => console.warn("Could not open the shared temple", error));
  }

  init();
})();
