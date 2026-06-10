# Techum Shabbos Calculator — Design Document

A web app that takes an address and draws the techum Shabbos on Google Maps,
and helps plan an eiruv techumin for traveling from one place to another.

**Halachic basis:** Shulchan Aruch HaRav (Alter Rebbe), Orach Chaim 396–408,
for everything those simanim cover. For hilchos eiruvei techumin not extant in
Shulchan Aruch HaRav (simanim 409–416), the app follows the **Ketzos
HaShulchan** (R' Avraham Chaim Naeh). All measurements use **Reb Chaim Naeh's
shiurim**.

> **Disclaimer (must appear in the app):** This tool is an aid for learning
> and planning only. Building data and maps may be incomplete or inaccurate,
> and several halachic questions depend on local conditions. A rav must be
> consulted before relying on any boundary or eiruv shown by this app.

---

## 1. Shiurim (Reb Chaim Naeh)

| Shiur | Amos | Meters |
|---|---|---|
| Amah | 1 | 0.48 m |
| Techum | 2,000 | 960 m |
| Karpef / joining distance | 70⅔ | 33.92 m |
| Two-city joining distance (2 karpefs) | 141⅓ | 67.84 m |
| Corner (diagonal) of techum square | 2,000·√2 ≈ 2,828 | ≈ 1,357.6 m |

All distances are **straight-line (aerial)** distances; the techum is not
measured along roads or walking routes.

## 2. The halachic model

### 2.1 Core algorithm — techum for an address

1. **Geocode** the address to a point (Google Geocoding API).
2. **Find the halachic city**: fetch building footprints around the point
   and cluster them — buildings join into one "city" when the gap between
   them is within 70⅔ amos (33.92 m); two such clusters join when they are
   within 141⅓ amos (67.84 m) of each other (the din of two karpefs between
   two cities). The cluster containing the user's point is the halachic city.
3. **Karpef buffer (configurable)**: optionally extend the city outline by
   70⅔ amos before squaring. Whether a *single* city is given a karpef is a
   machlokes (see SA 398:5 and SA HaRav 398) — exposed as a halachic setting
   with the psak to be confirmed (see §6).
4. **Square the city (ribua)**: take the north-aligned bounding rectangle of
   the city polygon — the city is squared to the four directions of the world
   (ribua ha'olam).
5. **Extend the techum**: expand the rectangle by 2,000 amos (960 m) on every
   side. The corners are included (the techum itself is squared), giving up to
   ~2,828 amos at the diagonals.
6. **Lone dwelling**: if the point is not inside any cluster, the techum is
   the north-aligned bounding box of the dwelling itself expanded by 960 m on
   each side (and for a person resting in the open: 4 amos plus 2,000, squared).

### 2.2 Eiruv techumin planner

Input: Shabbos-residence address (where the user will be at bein hashmashos)
and a destination address.

1. Compute the default techum. If the destination is inside it → "no eiruv
   needed."
2. Otherwise compute the **feasible placement region**: all points E such that
   (a) E lies within the user's current techum (the eiruv must be placed where
   he may reach it), and (b) the destination lies within the techum generated
   around E (2,000 amos squared around E).
   If this region is empty, the destination is out of range even with an
   eiruv — report that clearly.
3. The user drops a pin inside the feasible region. The app draws the **new
   techum** around the eiruv spot and overlays: area **gained** (toward the
   destination) and area **lost** (beyond 2,000 amos from the eiruv on the
   home side) — making the trade-off visible at a glance.
4. **City-as-4-amos rule (SA HaRav 408:1, which we have):** if the user's
   entire city fits inside the new techum, the whole city counts as 4 amos and
   the 2,000 are measured from beyond the city — the app must implement this,
   and likewise when the eiruv itself is placed inside a city the techum
   extends from that city's (squared) boundary, not just from the pin.
   (v1 may treat the eiruv as a bare point — a stringency — with city-aware
   logic in v2.)
5. **Validity checklist** (per Ketzos HaShulchan, since most of 409–416 is not
   extant in SA HaRav): placed before Shabbos; accessible at bein hashmashos;
   food fit for two meals; placed in a spot where it may halachically rest;
   the declaration and brachah text ("…b'zeh ha'eruv yehei mutar li leilech
   mimakom zeh…"). Also support **kinyan shevisa b'raglav** — physically being
   at the spot at bein hashmashos with intent — as the alternative to placing
   food.

## 3. Architecture

```
React + TypeScript (Vite)
 ├─ Map layer: Google Maps JavaScript API
 │   ├─ Places Autocomplete (address input)
 │   └─ Geocoding API
 ├─ Geometry engine (pure TypeScript + Turf.js)
 │   ├─ local metric projection around the site (true-north aligned)
 │   ├─ building clustering (buffer/union, gap ≤ 33.92 m / 67.84 m)
 │   ├─ ribua (north-aligned bounding box) + 960 m expansion
 │   └─ eiruv feasible-region & gained/lost overlays
 └─ Backend (light Node / serverless)
     ├─ Overpass (OpenStreetMap) proxy for building footprints
     ├─ cache of computed city polygons (queries are heavy)
     └─ keeps API keys restricted server-side where applicable
```

- **Building data:** OpenStreetMap via Overpass API (free, good urban
  coverage). Later: Google Open Buildings / Microsoft Building Footprints to
  fill gaps. The city polygon must be **user-reviewable** — show the detected
  cluster and let the user correct it (add/remove areas) before relying on it,
  since OSM data can be incomplete.
- **Which buildings count:** only dwellings (beis dirah) extend a city.
  OSM building tags (house/residential/apartments vs. shed/garage/silo) drive
  a first pass; ambiguous structures flagged for the user. Halachic
  classification rules listed in §6.
- **Geometry accuracy:** at the 1–3 km scale a local equirectangular/transverse
  Mercator projection keeps errors well under a meter; squares are aligned to
  **true north**, not grid/magnetic north.
- **Hosting:** static frontend (Vercel/Netlify/GitHub Pages) + serverless
  functions for the Overpass proxy/cache.

## 4. UI sketch

- **Main screen:** address search box → map showing: detected city outline
  (editable), the squared city, and the techum square. Toggle layers:
  with/without karpef (machmir and meikel lines in different colors).
- **Eiruv mode:** second address box for destination; feasible-placement
  region shaded; pin drop → new techum with gained (green) / lost (red)
  overlay; side panel with the validity checklist and brachah/declaration
  text.
- **Sources panel:** every displayed boundary cites its basis (SA HaRav
  396–408 / Ketzos HaShulchan, with siman/se'if), so the result is checkable
  with a rav.
- Mobile-friendly layout from day one (it's a web app people will open on
  their phones).

## 5. Roadmap

| Phase | Deliverable |
|---|---|
| 1 | App skeleton, address search, **point-based techum** (lone-dwelling square) on Google Maps |
| 2 | Building-footprint city detection, clustering, ribua, karpef setting, editable city polygon |
| 3 | Eiruv techumin planner: feasible region, new techum, gained/lost overlay, checklist + nusach |
| 4 | City-as-4-amos logic for the eiruv (408:1), saved locations, shareable links, PWA/mobile polish |

## 6. Rules adopted from "A Practical Application of Techum Shabbat"

From the chabad.org article (#4494176) by **Rabbi (Dayan) Levi Yitzchak
Raskin** of London, on walking between Borehamwood and Edgware — including
the reader comments and the author's replies:

### From the article body

1. **A town counts as 4 amos**: the techum concern applies only when
   walking outside a built-up area. *(Matches: the app measures from the
   city edge.)*
2. **2,000 amos = 960 m** (amah = 48 cm). A commenter (Zalman) notes the
   exact imperial conversion is **3,149.6 ft**, not the article's 3,158 ft.
   *(The app shows the exact figure.)*
3. **Iburah shel Ir**: the first 70⅔ amos around a town; a single house
   within that margin extends the town's borders — but a lone house
   *beyond* the margin grants nothing (the article explicitly dispels the
   myth that any house on the way restarts the 2,000). *(Matches the
   clustering rule.)*
4. **Two townships join** when their 70-amah-plus margins overlap (total
   ≈ 2 × 33.92 m). A motorway or rail track in the gap does **not** itself
   split a town — only the measured distance matters (the article's M1 /
   rail-track example). *(Matches; the app ignores roads and measures
   gaps.)*
5. **The tether (kalsa midaso)**: one who walks from town A into town B is
   stopped mid-town the moment his 2,000 amos run out — "as if held by a
   tether anchored at the border of town A." *(Implemented: such cities
   are outlined red with a warning.)*
6. **Squaring**: furthest houses in the four directions, rectangle drawn
   around them; enclosed open space counts as if full of dwellings. A
   town's squaring must align with **the four directions of the world** —
   otherwise two people would square the same town differently. *(Matches
   the north-aligned model.)*
7. **Corner-rotation kula (par. 13)**: the world-alignment constraint does
   **not** apply to one's *personal* eiruv techumin square — one may plot
   it to his preference, rotating it to a "diamond" position, gaining
   ~40% (2,000·√2 amos ≈ 1,357.6 m; the article approximates 1,344 m) in
   the chosen direction, both for placing the eiruv beyond the town line
   and for the reach of the new techum. *(Implemented as an opt-in
   toggle.)*
8. **The trade-off (par. 14)**: aiming the diamond one way sacrifices
   breadth elsewhere — the square can be re-aimed (e.g., to keep a walking
   road inside it) at the cost of reach toward the destination; one must
   plot a clear walking route. *(Implemented: a rotation slider re-aims
   the diamond and the coverage check follows it.)*
9. **Satellite vs. land measurement**: halachic measurement is a hands-on
   process that may well produce different results than satellite imagery.
   *(Added to the app's disclaimer.)*

### From the comments

10. **Rashi/Rama 408:1 — home town as 4 amos** (reply to Mendel G): one
    who places an eiruv outside his town keeps his entire town — where he
    physically spends the onset of Shabbos — as 4 amos, even though the
    eiruv defines his dwelling, and even when the town is not fully
    within the eiruv's 2,000. The Mechaber does not accept this leniency;
    **the Alter Rebbe's Shulchan Aruch opens with the Rama's view but the
    rest was never published, and his Siddur seems to follow the stricter
    view; common practice follows the Rama.** *(Implemented as a toggle,
    default ON per common practice, with the sources noted. Whether the
    measure also continues beyond the town is not credited — a
    stringency.)*
11. **Bow-shaped city — the limit of squaring** (reply to Julian Czarny,
    citing **Nesivos Shabbos 42:17**): one may not square an entire
    metropolis into one rectangle; where the squared area includes
    swathes of open land whose flanking built ends are more than
    **4,000 amos** apart (the Mishnah's bow-shaped city), the open area
    cannot be "filled in" by squaring — each area must be squared
    individually. *(Implemented as an automatic warning: the app scans
    the squared city for interior open stretches over 1,920 m and flags
    them for manual/rabbinic review.)*
12. **London Beth Din caution**: despite the geometry, the practical psak
    for Borehamwood–Edgware is that there is currently no permissible
    route. *(In the planner's checklist: the app cannot replace the local
    rav.)*

## 7. Supplementary dinim (sources beyond Shulchan Aruch HaRav)

The Alter Rebbe's Shulchan Aruch is extant through siman 408; the
following were added from the Mechaber/Rama and accepted poskim, per the
project's fallback policy:

**In the eiruv planner logic:**
- **Eiruv inside a town (SA HaRav 408 — extant)**: an eiruv resting
  within a town (or its 70⅔-amah ibur margin) makes the placer as one of
  its residents — the whole town is his 4 amos and the techum extends
  2,000 amos from its squared edge. Implemented: the planner detects a
  host town and extends the new techum from the whole town. Within one's
  *own* town the eiruv is a no-op — the planner warns.
- **Rashi/Rama 408:1** home-town leniency — toggle, default ON (common
  practice), as discussed in §6.

**In the eiruv checklist (Mechaber/Rama, 409–416; Ketzos HaShulchan):**
- Eiruv in a **cemetery** is invalid — benefit from it is forbidden
  (SA 409:1); the spot must be defined and accessible bein hashmashos.
- **Food shiur**: bread for two meals, commonly reckoned at the volume of
  six to eight beitzim (≈ 346–461 cm³ at Reb Chaim Naeh's beitzah of
  57.6 cm³).
- **Traveler's declaration** ("shevisasi b'makom ploni") — acquiring
  shevisa at a named spot within 2,000 amos reachable before nightfall
  (SA 409).
- **Conditional eiruvin** in two directions, stipulating which takes
  effect (SA 413).
- **Two-day Yom Tov**: the eiruv must exist at the onset of each day
  (SA 416).
- Eiruv only **for a mitzvah or similar need** (SA 415:1).

**Reference panel ("If one went beyond the techum") — all extant in
Shulchan Aruch HaRav:**
- Beyond the techum: 4 amos only (SA HaRav 405); went/taken out b'ones
  and returned — as if never left; taken into a walled town — the town is
  his 4 amos (405).
- Authorized leavers (rescue, midwife): 2,000 from where they are; "all
  who go out to rescue return to their place" (407).
- Human dignity allowance (406); belongings/animals follow the owner's
  techum (397); above 10 tefachim (boat) is a safek (404).

## 8. Open halachic questions (to confirm with a rav before they're encoded)

1. **Karpef for a single city** — machlokes in 398:5; what does SA HaRav 398
   rule, and should the default line include it? (App will support showing
   both lines.)
2. **Which structures join a city** — dinim of what counts as a beis dirah
   (shuls, stores, factories, ruins, three-walled structures, etc.).
3. **Bow-shaped (keshes) and irregular cities** — when the bounding-rectangle
   squaring applies as-is and when the city's gaps break it apart.
4. **Rivers, highways, cemeteries** inside or at the edge of the built-up
   area — do they interrupt the city?
5. **Hilly terrain** — the din of measuring with a 50-amah rope and havla'ah
   means aerial distance is not always equivalent in mountainous areas; v1
   uses aerial distance with a warning, terrain-aware measurement is a
   possible later feature (elevation data is available).
6. **Valid resting places for the eiruv** (tree, private property, etc.) —
   per Ketzos HaShulchan; encode as checklist guidance.
7. **Shiur of the two meals** for the eiruv food, per Reb Chaim Naeh's
   measures — exact quantities to display.
