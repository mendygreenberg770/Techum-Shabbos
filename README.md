# Techum Shabbos Calculator

A web app that takes an address and draws the techum Shabbos on Google Maps,
with an eiruv techumin planner coming in a later phase. Measurements follow
**Reb Chaim Naeh's shiurim** (amah = 48 cm, techum = 960 m); the halachic
basis is **Shulchan Aruch HaRav** (OC 396–408) and the **Ketzos HaShulchan**
for the parts of hilchos eiruvei techumin not extant in Shulchan Aruch HaRav.
See [DESIGN.md](DESIGN.md) for the full design and roadmap.

> **Disclaimer:** this tool is an aid for learning and planning only.
> Consult a rav before relying on any boundary or eiruv it shows.

## Current status (Phase 2)

- Address search (Places autocomplete, with a plain geocoder fallback)
- **City detection**: building footprints are fetched from OpenStreetMap
  (Overpass API) around the address and clustered by the halachic joining
  distances — a gap of up to 70⅔ amos (33.92 m) joins buildings into one
  city, and two cities join within 141⅓ amos (67.84 m). The cluster
  containing the address becomes the halachic city.
- The city is squared as a north-aligned rectangle (ribua ha'olam) and the
  techum extends 2,000 amos (960 m) from its edge, corners included.
- **Karpef toggle**: optionally add 70⅔ amos around the city before
  measuring (the machlokes in SA 398:5) — the other opinion's line is shown
  in gray for comparison.
- **Manual adjustment**: the green city rectangle can be dragged/resized if
  the detection is off, with a reset back to the detected boundary.
- **Truncation warnings**: if the built-up area reaches the edge of the
  analysis radius, the app says so explicitly (the true techum extends
  further on those sides) rather than showing a misleading line.
- Point mode (lone dwelling) remains available as a stringent fallback and
  is used automatically when no buildings are found near the address.

Map legend: orange = detected building cluster (convex hull), green =
squared city, blue = techum, gray = the other karpef opinion's techum.

Phase 3 adds the eiruv techumin planner. Known limitations: all structures
are counted (which structures halachically join the city is an open item),
multipolygon buildings are skipped, and OpenStreetMap coverage varies.

## Setup

```bash
npm install
npm run dev
```

Open the printed URL. The app will ask for a **Google Maps API key** (stored
in your browser's localStorage), or you can bake one in at build time:

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
