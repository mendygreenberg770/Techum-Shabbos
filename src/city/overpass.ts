import type { Bounds, LatLng } from "../halacha/geometry";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface OverpassElement {
  type: string;
  id: number;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

export interface FetchedBuilding {
  id: number;
  /** Building outline as its bounding rectangle (4 corners). */
  ring: LatLng[];
}

/**
 * Fetch buildings inside a lat/lng rectangle from OpenStreetMap via the
 * Overpass API. To keep city-scale downloads feasible, only each
 * building's bounding box is fetched (`out ids bb`), not its full
 * outline — roughly 10x smaller. The bbox shares the footprint's
 * extremes, so the squared-city bounds are unaffected; gaps between
 * diagonal buildings can be slightly understated (joining a bit more
 * than the strict footprint would — noted in DESIGN.md).
 *
 * Known limitation: multipolygon relation buildings are skipped; these
 * are rare for dwellings.
 */
export async function fetchBuildingsInRect(rect: Bounds): Promise<FetchedBuilding[]> {
  const bbox = `${rect.south},${rect.west},${rect.north},${rect.east}`;
  const query = `[out:json][timeout:120];way[building](${bbox});out ids bb qt;`;

  let lastError: Error = new Error("No Overpass endpoint available");
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        throw new Error(`Overpass returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as { elements?: OverpassElement[] };
      return (data.elements ?? [])
        .filter((el) => el.type === "way" && el.bounds)
        .map((el) => {
          const b = el.bounds!;
          return {
            id: el.id,
            ring: [
              { lat: b.minlat, lng: b.minlon },
              { lat: b.minlat, lng: b.maxlon },
              { lat: b.maxlat, lng: b.maxlon },
              { lat: b.maxlat, lng: b.minlon },
            ],
          };
        });
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError;
}
