import type { LatLng } from "../halacha/geometry";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface OverpassElement {
  type: string;
  geometry?: { lat: number; lon: number }[];
}

/**
 * Fetch building footprints within a radius of a point from
 * OpenStreetMap via the Overpass API. Returns one polygon (ring of
 * vertices) per building.
 *
 * Known limitation: multipolygon relation buildings are skipped (only
 * simple closed ways are fetched); these are rare for dwellings.
 */
export async function fetchBuildings(
  center: LatLng,
  radiusM: number
): Promise<LatLng[][]> {
  const query =
    `[out:json][timeout:90];` +
    `way[building](around:${Math.round(radiusM)},${center.lat},${center.lng});` +
    `out geom qt;`;

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
        .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 3)
        .map((el) => {
          const ring = el.geometry!.map((g) => ({ lat: g.lat, lng: g.lon }));
          // Closed ways repeat the first vertex at the end; drop it.
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (ring.length > 3 && first.lat === last.lat && first.lng === last.lng) {
            ring.pop();
          }
          return ring;
        })
        .filter((ring) => ring.length >= 3);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError;
}
