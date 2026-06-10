# Techum Shabbos Calculator

A web app that takes an address and draws the techum Shabbos on Google Maps,
with an eiruv techumin planner coming in a later phase. Measurements follow
**Reb Chaim Naeh's shiurim** (amah = 48 cm, techum = 960 m); the halachic
basis is **Shulchan Aruch HaRav** (OC 396–408) and the **Ketzos HaShulchan**
for the parts of hilchos eiruvei techumin not extant in Shulchan Aruch HaRav.
See [DESIGN.md](DESIGN.md) for the full design and roadmap.

> **Disclaimer:** this tool is an aid for learning and planning only.
> Consult a rav before relying on any boundary or eiruv it shows.

## Current status (Phase 4)

- Address search (Places autocomplete, with a plain geocoder fallback)
- **City detection with auto-expansion**: buildings are fetched from
  OpenStreetMap (Overpass API) and clustered by the halachic joining
  distances — a gap of up to 70⅔ amos (33.92 m) joins buildings into one
  city, and two cities join within 141⅓ amos (67.84 m). The analyzed area
  **grows automatically** until the entire contiguous city is captured, or
  a selectable limit (Town / Large city / Metropolis) is hit — in which
  case the app warns explicitly on which sides the city continues.
- The city is squared as a north-aligned rectangle (ribua ha'olam) and the
  techum extends 2,000 amos (960 m) from its edge, corners included.
- **Ir muvla'as (SA HaRav 408:1)**: a neighboring city fully swallowed
  within the techum counts as only 4 amos — the techum is extended beyond
  it automatically.
- **Karpef toggle** (machlokes SA 398:5) with the other opinion's line in
  gray; **manual adjustment** of the city rectangle; point mode (lone
  dwelling) as a stringent fallback.
- **Eiruv techumin planner**: enter a destination; if it's beyond the
  techum the app shades the feasible placement region (within your current
  techum *and* close enough to cover the destination). Click or drag the
  eiruv marker to place it: the new techum is drawn with gained (green)
  and lost (red) areas, the muvla din credits your own city as 4 amos
  within the new techum, and a checklist with the brachah and declaration
  (per Ketzos HaShulchan) is provided. Kinyan shevisa b'raglav is noted as
  the no-food alternative.

- **Shareable links**: the URL hash always encodes the current view —
  address, settings, destination, and eiruv spot — so the address bar (or
  the "Copy shareable link" button) reproduces exactly what's on screen.
- **Saved locations**: save the current location with all its settings to
  the browser (localStorage) and reload it with one click.
- **PWA / mobile**: installable (web manifest + icons), with a service
  worker that caches the app shell for offline starts (map tiles and
  building data still need the network).

The in-app legend lists all map colors.

Known limitations / open halachic items (see DESIGN.md §6): all structures
are counted as joining the city; buildings are clustered by their bounding
boxes; the eiruv is treated as a bare point (no credit for resting inside
another city); muvla chains are single-level; feasibility ignores muvla
bumps (all stringencies except the bbox clustering, which can join
slightly more than strict footprints would).

## Setup

```bash
npm install
npm run dev
```

Open the printed URL. A default **Google Maps API key** is bundled (restrict
it to your domains in the Google Cloud console!); you can override it in the
app (stored in your browser's localStorage) or at build time:

```bash
VITE_GOOGLE_MAPS_API_KEY=your-key npm run dev
```

### Getting a Google Maps API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com/),
   create a project, and enable billing (the free tier covers light
   personal use).
2. Under "APIs & Services → Library", enable **Maps JavaScript API**,
   **Geocoding API**, and **Places API (New)**.
3. Under "APIs & Services → Credentials", create an API key. Restrict it to
   your site's domain (HTTP referrers) once deployed.

If the Places API isn't enabled, the app automatically falls back to a plain
address box using the Geocoder.

## Tests

```bash
npm test
```

Covers the geometry engine (shiurim, techum square, distances).
