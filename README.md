# Mandir Marg · मंदिर मार्ग

**A free, always-online, community-maintained map of Hindu temples.**

Mandir Marg ("the way to the temple") helps devotees find Hindu temples near them, learn a little
about each one, and add temples that are missing. It is a plain static website: no build step, no
framework, no server of your own to maintain. Everything runs on free tiers.

- **Live map** of Hindu temples from OpenStreetMap, clustered and searchable
- **Street or satellite view** — switch to Esri imagery to spot a temple roof, then tap the map to place its pin exactly
- **Find temples near me** using the browser's location, or search any city or town
- **Photo contributions** — a geotagged photo places the pin automatically, and EXIF is stripped before publishing
- **Approval becomes publication** — moderator-approved temples appear on the map from a small community file
- **Duplicate warning** — if a temple is already mapped within 80 m, the form asks before saving a second pin
- **Share a temple** — a link opens the map on that temple, ready to send on WhatsApp
- **Suggest a temple or an edit** from a phone-friendly form
- **Installable PWA** — add it to your home screen; the app shell works offline
- **Donations stay official** — v1 only shows a temple's own website/phone; it never handles money

![Mandir Marg map showing clustered Hindu temples around Varanasi](docs/screenshot.png)

Switch to **Satellite** to recognise a temple roof, then tap the map to drop its pin precisely.

![Satellite view of Varanasi with temple pins and place labels](docs/satellite.png)

---

## 1. Run it on your computer (2 minutes)

You need Python 3 (already on most computers). In this folder, either:

**Windows** — double-click `start.bat`.

**macOS / Linux**

```bash
cd mandir-marg
python3 tools/dev_server.py
```

Your browser opens <http://127.0.0.1:5173/>. Keep the terminal window open while you browse; press
`Ctrl+C` to stop.

The local server also emulates the production temple proxy at `/api/temples`, so you see exactly
what visitors will see.

> A plain double-click on `index.html` will not work well: browsers block map tiles and data
> requests from `file://` pages. Always use the local server.

---

## 2. Put it online for free (Cloudflare Workers)

Cloudflare Workers gives you a free `https://your-project.your-name.workers.dev` address, free
HTTPS, and free static hosting plus a small amount of server code — which this project uses for its
cached temple proxy. No credit card is needed.

The repository already contains [`wrangler.jsonc`](wrangler.jsonc), so Cloudflare needs no build
settings: it runs `npx wrangler deploy`, serves everything in `public/` as static assets, and runs
`src/worker.js` only for `/api/*`.

1. Create a free GitHub account and a new **empty** repository, for example `mandir-marg`.
2. Push this `mandir-marg` folder to it:

   ```bash
   cd mandir-marg
   git init
   git add .
   git commit -m "Mandir Marg v1"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/mandir-marg.git
   git push -u origin main
   ```

3. Go to <https://dash.cloudflare.com/> → **Workers & Pages** → **Create** →
   **Connect to Git** (under *Import a repository*) and pick the repository.
4. Keep the detected settings — **Build command:** empty, **Deploy command:**
   `npx wrangler deploy`. The project name comes from `wrangler.jsonc`.
5. Click **Deploy**. In a minute your site is live at
   `https://mandir-marg.your-name.workers.dev`.

Every later `git push` to `main` redeploys automatically.

> If you created the project as **Pages** by mistake, delete it and reconnect through the Workers
> flow above. This repository is structured for Workers static assets, not Pages Functions.

### Custom domain (optional)

Workers → your project → **Settings → Domains & Routes** → **Add custom domain**. You can keep the
free `*.workers.dev` address forever, or attach a domain you already own (about ₹500–1,200/year).
Nothing else needs to change.

### What the free tier includes

- Unlimited static requests and unlimited bandwidth for this kind of site
- 100,000 Worker requests per day (the proxy usually serves from cache, so this is plenty)
- Automatic HTTPS, HTTP/3 and a global CDN
- Preview deployments and rollbacks on every Git push

### Other free hosts

GitHub Pages, Netlify and Vercel can host the static files for free, but they will not run
`src/worker.js`, so the `/api/temples` proxy is not available. The browser then calls Overpass
directly and relies on its local 6-hour cache. That works, but public Overpass servers are
rate-limited. For a reliable public site, Cloudflare Workers is recommended.

To host only the static part elsewhere, upload the contents of `public/` (not the repository root).

---

## 3. Collect contributions from everyone (optional, free)

Out of the box, suggestions are saved in the visitor's browser (`localStorage`) so you can try the
flow. To collect them centrally:

1. Create a free project at <https://supabase.com/>.
2. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), run it.
   This creates `temple_suggestions` with insert-only Row Level Security.
3. Open **Project Settings → API** and copy:
   - **Project URL**
   - **anon public** key
4. Put both into [`public/js/config.js`](public/js/config.js):

   ```js
   window.MANDIR_MARG_CONFIG = {
     supabaseUrl: "https://abcdefgh.supabase.co",
     supabaseAnonKey: "eyJhbGciOi..."
   };
   ```

5. Commit and push. New suggestions now arrive in **Table Editor → temple_suggestions** with
   `status = pending`.

The anon key is designed to be public. The policy allows **inserts only**, so nobody can read,
change, approve or delete other people's suggestions with it. Review suggestions in the Supabase
dashboard, then add good ones to the map (see the roadmap for a planned admin screen).

Suggested review rule: approve only information you can verify from an official temple source, and
remove personal phone numbers submitted without consent.

### From approval to the map

Approving a row in the dashboard is not enough on its own: the public map reads a small static file
so it does not need a database connection for every visitor. Publish the approved rows with:

```bash
# Windows PowerShell
$env:SUPABASE_URL = "https://abcdefgh.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "service-role-key"

python tools/publish_temples.py

git add public/data/community-temples.json public/data/photos
git commit -m "Publish approved temples"
git push
```

On macOS or Linux use `export` instead of `$env:`. The tool:

1. Reads every row with `status = approved` (paging past Supabase's 1,000-row limit).
2. Writes photos that arrived as data URLs into `public/data/photos/` and points the JSON at them.
3. Removes entries that are no longer approved, so rejecting a row also removes it from the map.
4. Keeps hand-curated records whose IDs do not start with `community/`.
5. Skips near-identical approvals within 75 m with a matching name, and prints what it skipped.

Preview without changing anything with `python tools/publish_temples.py --dry-run`. To work offline,
export the rows to JSON and use `--input rows.json`. The service role key must stay secret; the anon
key also works because approved rows are readable by policy, but it is safer to run the tool locally.

**Photo privacy.** The browser downscales a chosen photo to at most 1,280 px and re-encodes it as
JPEG through a canvas. That strips EXIF (GPS, camera model, timestamps) from the file that is stored
or uploaded. GPS is used only on the visitor's device, to move the pin. A manual satellite pin is
never silently replaced: if the photo was taken more than 500 m away, the picked pin is kept.

---

## 4. Where the temple data comes from

Temple locations come from **OpenStreetMap**, queried through the [Overpass API](https://overpass-api.de/).

Request flow:

```
browser ──▶ /api/temples (Cloudflare Worker, cached 30 min at the edge)
              └─▶ Overpass mirror 1 … 4 (server-side failover)
browser ──▶ Overpass directly (only when the proxy is not deployed)

browser ──▶ data/community-temples.json (approved contributions, static file)
```

The browser also caches each searched area for **6 hours** in `localStorage`, so revisiting a city
is instant and does not touch the network. The proxy rounds coordinates to two decimals, which
means everyone in the same district shares one upstream request.

Community temples are merged with the OpenStreetMap results in the browser. Only entries inside the
current radius are added, so the community file can grow across India without slowing a local view.
When a community entry sits within **60 m** of an OSM temple with a matching name, the community
record wins: it may have a photo and verified notes. The OSM identifiers are kept, so the popup can
still link back to the original object. The service worker deliberately does not cache `/data/`, so
a newly published approval appears on the next visit.

Only elements named in OSM are listed. Each card shows the local name, distance, deity or tradition
when tagged, and links to directions, the OSM object and the temple's own website.

**Please be a good citizen of the Overpass service.** The proxy exists to reduce load, caches
responses, and sends an identifying User-Agent. Do not remove the cache or raise the query limits
without a reason. If Mandir Marg grows large, the next step is a scheduled import into Supabase
rather than more live queries.

### Attribution and licences

- Temple data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available
  under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). The
  attribution is shown in the app and must stay visible.
- Basemap tiles and style by [OpenFreeMap](https://openfreemap.org/), using OpenStreetMap data.
  The raster fallback uses `tile.openstreetmap.org`.
- Satellite imagery and its labels by [Esri](https://www.esri.com/) (World Imagery: Esri, Maxar,
  Earthstar Geographics; World Boundaries and Places). The in-map attribution must stay visible.
- Place search by [Photon](https://photon.komoot.io/) (Komoot), based on OpenStreetMap.
- Map rendering by [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause).
- The app's own code and artwork: use them freely for dharmic, non-commercial work.

If you later add temple descriptions from Wikipedia, credit them and follow CC BY-SA.

---

## 5. Donations and money

Version 1 deliberately **does not accept, hold or route money**. A temple's official UPI ID, bank
details or website may be typed into the notes field or linked from the temple's own website, but
Mandir Marg never collects funds and cannot verify an account. Visitors should always confirm
donation details on the temple's official site or at the temple counter.

This keeps the project simple, avoids payment compliance, and protects devotees from fake
"donation" links. If a payments feature is ever added, it needs a registered entity, KYC, refund
handling and a verified-temple process — treat that as a separate, deliberate project.

**Keeping the site free.** Hosting, map tiles and geocoding are all on free tiers, so the only
possible cost is a custom domain. Reasonable future support, always disclosed:

- voluntary contributions to the maintainers (not to temples)
- services for temple trusts: verified listings, event pages, QR signage
- clearly labelled sponsorships from dharmic publishers or travel services
- affiliate links for pilgrimage travel, only where relevant

Never sell contributor data or visitor location data. There is no advertising or tracking in v1.

---

## 6. Project layout

```
mandir-marg/
├─ public/                    Everything the browser can download
│  ├─ index.html              Page structure, search, map, list, contribution dialog
│  ├─ css/styles.css          All styling (cream/maroon/gold, responsive, reduced motion)
│  ├─ js/config.js            Supabase URL + anon key (empty by default)
│  ├─ js/app.js               Map, temple merge, search, geolocation, form, photos, PWA
│  ├─ js/exif.js              Tiny EXIF GPS reader (no dependency, no upload)
│  ├─ data/community-temples.json  Approved community temples (published by the tool)
│  ├─ data/photos/            Photos published from approved contributions
│  ├─ manifest.webmanifest    Installable app metadata
│  ├─ sw.js                   Service worker: app shell offline, 6-hour data cache
│  ├─ icons/                  SVG + PNG app icons and social preview image
│  ├─ robots.txt              Crawler rules
│  └─ _headers                Security headers, applied to static assets by Cloudflare
├─ src/worker.js              Worker: /api/temples proxy, everything else to ASSETS
├─ wrangler.jsonc             Worker config: assets directory, binding, /api/* routing
├─ supabase/schema.sql        `temple_suggestions` table with insert-only RLS
├─ docs/                      README screenshots (not deployed)
├─ tools/dev_server.py        Local server + proxy emulator (no dependencies)
├─ tools/publish_temples.py   Approved Supabase rows → community JSON + photos
├─ tools/make-icons.py        Regenerates the PNG icons with Pillow
└─ start.bat                  One-click local preview on Windows
```

### How the pieces fit

1. `app.js` reads the saved view (or defaults to Varanasi), shows the map, and asks
   `/api/temples` for temples.
2. `worker.js` validates `lat`, `lng` and `radius`, checks Cloudflare's edge cache, otherwise
   tries four Overpass mirrors in order and caches the result for 30 minutes. Any other URL is
   handed to the `ASSETS` binding and served as a static file.
3. `app.js` turns OSM elements and approved community records into temple records, merges the two
   sources, sorts by distance, draws clustered pins and fills the list. Community pins and cards
   are marked. Search filters locally first; if nothing matches, Photon geocodes the place and the
   map moves there.
4. "Pick the exact spot" closes the form, switches to satellite imagery, zooms to rooftop scale and
   takes the tapped coordinate, then reopens the form with the pin placed.
5. Choosing a photo reads its EXIF GPS in the browser, downscales it through a canvas (which
   removes EXIF) and, when there is no manual pin, uses the photo's location for the temple.
6. Before saving, the app looks for another temple within 80 m. It explains the match and asks the
   contributor to confirm or to switch to "Suggest an edit" instead.
7. Suggestions go to Supabase when configured, and always stay in `localStorage` as a local copy.
   Approved rows are published to `public/data/community-temples.json`, which is what visitors read.
8. Selecting a temple writes `?temple=<id>` into the address bar. That link reopens the same temple,
   even when it is a community entry outside the visitor's saved area.

### Changing the amount of data

- Radius options: `#radius` in `public/index.html` and `ALLOWED_RADII` in `src/worker.js`.
- Result cap: `out center 300;` in `public/js/app.js` and `src/worker.js` (keep both in sync).
- Default view: `DEFAULT_VIEW` in `public/js/app.js`.

---

## 7. Testing and maintenance

There is no build step, so there is nothing to compile. Before publishing a change:

1. Run `python tools/dev_server.py`.
2. Search a city, click a pin, add a temple, and reload to confirm the local suggestion persists.
3. Switch to **Satellite**, then Add a temple → **Pick the exact spot on the map** and tap a roof.
4. Add a geotagged photo and check that the pin moves to the photo's location; then try a photo with
   GPS more than 500 m from a manually picked pin and confirm the manual pin is kept.
5. Try adding a temple within 80 m of an existing pin and confirm the duplicate warning appears.
6. Click a pin, use **Share**, and open the copied `?temple=` link in a new tab.
7. Preview the publish step: `python tools/publish_temples.py --input rows.json --dry-run`.
8. Check the browser console for errors.
9. Use `python tools/make-icons.py` after editing `public/icons/icon.svg` (needs `pip install pillow`).

Cache busting: bump `VERSION` in `public/sw.js` whenever you change the app shell, so installed
copies update. The service worker never caches `/api/` or `/data/` responses, which keeps temple data
and newly approved community entries fresh.

---

## 8. Roadmap

**Next**

- Moderation screen for `temple_suggestions` (approve without leaving the site)
- Temple detail pages with timings, festivals, history and more photos (with permission)
- Hindi interface and temple names in Devanagari throughout
- A photo gallery per temple, with attribution to the contributor

**Later**

- Android app with MapLibre Native, reusing the same community JSON and `/api/temples`
- Offline packs for major pilgrimage cities
- Verified temple accounts for official timings and donation details
- Accessibility and performance audits on low-end phones and slow networks

---

## 9. Credits

Built with seva for devotees everywhere. May it help people find their way to the temple.

If you spot a wrong temple, the best fix is often to correct it in OpenStreetMap itself — then
every map, not just this one, becomes more accurate.
