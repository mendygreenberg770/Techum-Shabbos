# Techum Shabbos Calculator

A web app that takes an address and draws the techum Shabbos on Google Maps,
with an eiruv techumin planner coming in a later phase. Measurements follow
**Reb Chaim Naeh's shiurim** (amah = 48 cm, techum = 960 m); the halachic
basis is **Shulchan Aruch HaRav** (OC 396–408) and the **Ketzos HaShulchan**
for the parts of hilchos eiruvei techumin not extant in Shulchan Aruch HaRav.
See [DESIGN.md](DESIGN.md) for the full design and roadmap.

> **Disclaimer:** this tool is an aid for learning and planning only.
> Consult a rav before relying on any boundary or eiruv it shows.

## Current status (Phase 1)

- Address search (Places autocomplete, with a plain geocoder fallback)
- Point-based techum: a north-aligned square extending 2,000 amos (960 m)
  in every direction from the address (ribua ha'olam — corners included)
- Optional 2,000-amah radius circle overlay for illustration

Phase 2 adds detection of the halachic city from building footprints, so the
techum is measured from the edge of the squared city. Until then, inside a
built-up area the point-based square may understate the techum (a stringency),
never overstate it.

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
