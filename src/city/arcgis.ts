import { metersPerDegree, type Bounds, type LatLng } from "../halacha/geometry";
import { decimateRing, requestSignal, type FetchedBuilding } from "./overpass";

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
  {
    url: "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0",
    // FEMA's occupancy class: Agriculture (barns/silos) and Utility and
    // Misc (water towers, pump houses…) are clearly not batei dirah and
    // do not join a city (SA 398:6). Other classes stay counted.
    outFields: "OCC_CLS",
  },
  {
    url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0",
    outFields: "",
  },
];
const NON_DIRAH_OCC = new Set(["Agriculture", "Utility and Misc"]);
let preferred = 0;

const PAGE_SIZE = 2000;
/** Per-rectangle safety cap (PAGE_SIZE × MAX_PAGES buildings). */
const MAX_PAGES = 50;

interface GeoJsonFeature {
  id?: number | string;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: { OCC_CLS?: string } | null;
}

/** Multi-part features keep a combined bounding box only while small;
 * above this span the largest part's true outline is used instead (a
 * big bbox can falsely bridge gaps). Single-ring features always keep
 * their true outline — even for a small house, a few meters decide a
 * 70⅔-amah join. */
const MULTIPART_BBOX_SPAN_M = 35;

/** Collect every ring (array of positions) in a (Multi)Polygon. */
function collectRings(coords: unknown, out: LatLng[][]): void {
  if (!Array.isArray(coords) || coords.length === 0) return;
  const first = coords[0];
  if (
    Array.isArray(first) &&
    first.length >= 2 &&
    typeof first[0] === "number" &&
    typeof first[1] === "number"
  ) {
    // coords is a ring of positions.
    out.push(
      (coords as [number, number][]).map(([lng, lat]) => ({ lat, lng }))
    );
    return;
  }
  for (const c of coords) collectRings(c, out);
}

/** Drop a duplicated closing point and decimate; null when degenerate. */
function cleanRing(ring: LatLng[]): LatLng[] | null {
  const pts = [...ring];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && last.lat === pts[0].lat && last.lng === pts[0].lng) {
    pts.pop();
  }
  return pts.length >= 3 ? decimateRing(pts) : null;
}

/** The structure's ring: its TRUE outline (gaps are measured
 * wall-to-wall — even for a small house a few meters decide a join).
 * Multi-part features: a small combined bounding box, or the largest
 * part's outline when the bbox would be big enough to bridge gaps. */
function featureRing(feature: GeoJsonFeature): LatLng[] | null {
  const rings: LatLng[][] = [];
  collectRings(feature.geometry?.coordinates, rings);
  if (rings.length === 0) return null;
  if (rings.length === 1) return cleanRing(rings[0]);

  // Multi-part feature.
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      minLat = Math.min(minLat, p.lat);
      minLng = Math.min(minLng, p.lng);
      maxLat = Math.max(maxLat, p.lat);
      maxLng = Math.max(maxLng, p.lng);
    }
  }
  const { perDegLat, perDegLng } = metersPerDegree((minLat + maxLat) / 2);
  const spanM = Math.max(
    (maxLat - minLat) * perDegLat,
    (maxLng - minLng) * perDegLng
  );
  if (spanM > MULTIPART_BBOX_SPAN_M) {
    let best: LatLng[] | null = null;
    let bestArea = -1;
    for (const ring of rings) {
      let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity;
      for (const p of ring) {
        n = Math.max(n, p.lat);
        s = Math.min(s, p.lat);
        e = Math.max(e, p.lng);
        w = Math.min(w, p.lng);
      }
      const area = (n - s) * (e - w);
      if (area > bestArea) {
        bestArea = area;
        best = ring;
      }
    }
    return best ? cleanRing(best) : null;
  }
  return [
    { lat: minLat, lng: minLng },
    { lat: minLat, lng: maxLng },
    { lat: maxLat, lng: maxLng },
    { lat: maxLat, lng: minLng },
  ];
}

async function fetchFromLayer(
  layer: { url: string; outFields: string },
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
      outFields: layer.outFields,
      f: "geojson",
      resultOffset: String(page * PAGE_SIZE),
      resultRecordCount: String(PAGE_SIZE),
    });
    const res = await fetch(`${layer.url}/query?${params}`, {
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
      const ring = featureRing(f);
      if (!ring) continue;
      // Stable id so re-fetched strips dedupe; fall back to the bbox
      // itself when the layer doesn't number its features.
      const id =
        f.id != null
          ? `a${layerIdx}:${f.id}`
          : `a${layerIdx}:${ring[0].lat},${ring[0].lng},${ring[2].lat},${ring[2].lng}`;
      const occ = f.properties?.OCC_CLS;
      out.push({
        id,
        ring,
        nonDirah: (occ && NON_DIRAH_OCC.has(occ)) || undefined,
      });
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
