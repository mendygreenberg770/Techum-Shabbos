import type { Bounds, LatLng } from "../halacha/geometry";
import { requestSignal, type FetchedBuilding } from "./overpass";

/**
 * US building footprints from ArcGIS-hosted open datasets, as a fallback
 * where OpenStreetMap data is unavailable — either unmapped (much of
 * suburban America) or unreachable (network filters that block the
 * Overpass servers commonly allow arcgis.com, a mainstream Esri domain
 * used by government sites).
 *
 *  - FEMA/ORNL "USA Structures": every structure > 450 sq ft in the US
 *    and territories.
 *  - Microsoft Building Footprints: 125M ML-extracted US buildings.
 *
 * Both are polygon FeatureServers queried by envelope, paginated. US
 * coverage only — elsewhere the query legitimately returns nothing and
 * the caller moves on to the next source.
 */
const LAYERS = [
  "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0",
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0",
];
let preferred = 0;

const PAGE_SIZE = 2000;
/** Per-rectangle safety cap (PAGE_SIZE × MAX_PAGES buildings). */
const MAX_PAGES = 50;

interface GeoJsonFeature {
  id?: number | string;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/** Collect every [lng, lat] position in a (Multi)Polygon coordinates array. */
function collectPositions(coords: unknown, out: LatLng[]): void {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    out.push({ lat: coords[1] as number, lng: coords[0] as number });
    return;
  }
  for (const c of coords) collectPositions(c, out);
}

/** North-aligned bounding rectangle of a feature, as a 4-corner ring —
 * the same shape the Overpass `out bb` source produces. */
function bboxRing(feature: GeoJsonFeature): LatLng[] | null {
  const pts: LatLng[] = [];
  collectPositions(feature.geometry?.coordinates, pts);
  if (pts.length < 3) return null;
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLat = Math.max(maxLat, p.lat);
    maxLng = Math.max(maxLng, p.lng);
  }
  return [
    { lat: minLat, lng: minLng },
    { lat: minLat, lng: maxLng },
    { lat: maxLat, lng: maxLng },
    { lat: maxLat, lng: minLng },
  ];
}

async function fetchFromLayer(
  layerUrl: string,
  layerIdx: number,
  rect: Bounds,
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  const out: FetchedBuilding[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry: `${rect.west},${rect.south},${rect.east},${rect.north}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: "true",
      geometryPrecision: "6",
      outFields: "",
      f: "geojson",
      resultOffset: String(page * PAGE_SIZE),
      resultRecordCount: String(PAGE_SIZE),
    });
    const res = await fetch(`${layerUrl}/query?${params}`, {
      signal: requestSignal(signal),
    });
    if (!res.ok) throw new Error(`ArcGIS returned HTTP ${res.status}`);
    const data = (await res.json()) as {
      features?: GeoJsonFeature[];
      properties?: { exceededTransferLimit?: boolean };
      exceededTransferLimit?: boolean;
      error?: { message?: string };
    };
    if (data.error) {
      throw new Error(`ArcGIS: ${data.error.message ?? "query error"}`);
    }
    if (!Array.isArray(data.features)) {
      throw new Error("ArcGIS: malformed response");
    }
    for (const f of data.features) {
      const ring = bboxRing(f);
      if (!ring) continue;
      // Stable id so re-fetched strips dedupe; fall back to the bbox
      // itself when the layer doesn't number its features.
      const id =
        f.id != null
          ? `a${layerIdx}:${f.id}`
          : `a${layerIdx}:${ring[0].lat},${ring[0].lng},${ring[2].lat},${ring[2].lng}`;
      out.push({ id, ring });
    }
    const exceeded =
      data.properties?.exceededTransferLimit ?? data.exceededTransferLimit ?? false;
    if (!exceeded && data.features.length < PAGE_SIZE) break;
  }
  return out;
}

/** Successful per-rectangle results, so a retried analysis resumes
 * instead of re-downloading (mirrors the Overpass query cache). */
const rectCache = new Map<string, FetchedBuilding[]>();
const RECT_CACHE_MAX = 120;

/** Test hook: module-level cache survives between tests otherwise. */
export function clearArcgisCache(): void {
  rectCache.clear();
}

async function fetchOneRect(
  rect: Bounds,
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  let lastError: Error = new Error("No ArcGIS layer available");
  for (let k = 0; k < LAYERS.length; k++) {
    const idx = (preferred + k) % LAYERS.length;
    try {
      const result = await fetchFromLayer(LAYERS[idx], idx, rect, signal);
      preferred = idx;
      return result;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError;
}

export async function fetchBuildingsArcgis(
  rects: Bounds[],
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  const out: FetchedBuilding[] = [];
  for (const rect of rects) {
    const key = `${rect.west},${rect.south},${rect.east},${rect.north}`;
    let result = rectCache.get(key);
    if (!result) {
      result = await fetchOneRect(rect, signal);
      rectCache.set(key, result);
      if (rectCache.size > RECT_CACHE_MAX) {
        rectCache.delete(rectCache.keys().next().value!);
      }
    }
    out.push(...result);
  }
  return out;
}
