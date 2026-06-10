import { detectCity, type CityDetection, type Side } from "./cluster";
import { fetchBuildingsArcgis } from "./arcgis";
import {
  fetchBuildingsInRects,
  fetchSettledAreasInRects,
  type FetchedBuilding,
} from "./overpass";
import {
  expandBounds,
  metersPerDegree,
  pointBounds,
  type Bounds,
  type LatLng,
} from "../halacha/geometry";

/**
 * Grow the analyzed area until the user's city no longer touches its
 * edge — so the entire contiguous city is captured — or a limit is hit.
 */

export interface ExpandLimits {
  maxBuildings: number;
  maxSpanM: number;
}

export interface ExpandProgress {
  buildings: number;
  iteration: number;
  expandingSides: Side[];
}

export interface ExpandResult {
  detection: CityDetection | null;
  fetchedRect: Bounds;
  /** True when a limit stopped the expansion before the city closed. */
  capped: boolean;
  /** Set when building data stopped loading mid-expansion: the result
   * is based on what was fetched so far and may be incomplete. */
  fetchError?: string;
  /** Both OSM and the US footprints contributed buildings (union). */
  merged?: boolean;
  /** Label override when the nominal source ended up unused — e.g. OSM
   * returned nothing and ArcGIS supplied every building. */
  effectiveSource?: CitySource;
  /** Datasets that contributed buildings and then failed mid-run — the
   * detected city may have invisible coverage holes; Retry resumes. */
  lostDatasets?: string[];
}

const INITIAL_HALF_M = 1200;
const STEP_M = 1600;
const MAX_ITERATIONS = 60;

/** What the city outline is built from: OSM building footprints, US
 * building footprints via ArcGIS (FEMA USA Structures / Microsoft), or
 * OSM settled-area (landuse) outlines as the coarsest fallback. */
export type CitySource = "buildings" | "arcgis" | "areas";

const FETCHERS: Record<
  CitySource,
  (rects: Bounds[], signal?: AbortSignal) => Promise<FetchedBuilding[]>
> = {
  buildings: fetchBuildingsInRects,
  arcgis: fetchBuildingsArcgis,
  areas: fetchSettledAreasInRects,
};

export async function detectCityExpanding(
  center: LatLng,
  limits: ExpandLimits,
  onProgress?: (p: ExpandProgress) => void,
  isCancelled?: () => boolean,
  signal?: AbortSignal,
  source: CitySource = "buildings"
): Promise<ExpandResult> {
  const { perDegLat, perDegLng } = metersPerDegree(center.lat);
  let rect = expandBounds(pointBounds(center), INITIAL_HALF_M);
  const byId = new Map<number | string, LatLng[]>();
  const minCitySize = source === "areas" ? 1 : undefined;

  // The "buildings" source is a UNION of OSM and the ArcGIS US
  // footprints: OSM coverage is patchy in parts of the US, and one
  // missing house can break a 70⅔-amos chain and cut off everything
  // beyond it. Duplicate footprints across datasets overlap and join
  // the same cluster — harmless to the geometry (counts are inflated).
  const simpleFetcher = source === "buildings" ? null : FETCHERS[source];
  let useOsm = true;
  let useAgs = true;
  let osmCount = 0;
  let agsCount = 0;
  /** Raw (pre-dedupe) ArcGIS features seen — zero in the initial area
   * means we are outside the US layers' coverage. */
  let agsRaw = 0;
  /** Datasets that contributed and then failed mid-run: quietly absent
   * data punches invisible holes in the city (chains break
   * mid-street), so the loss is surfaced to the UI. */
  const lostDatasets = new Set<string>();

  // Cross-dataset duplicate filter: the same building reported by both
  // OSM and ArcGIS must count once. Duplicates were inflating building
  // counts and burning the analysis limits at twice the real rate,
  // truncating large cities early. A bbox overlapping an accepted bbox
  // by ≥60% of the smaller area is the same building (distinct adjacent
  // buildings never overlap that much); indexed by ~30 m grid cells.
  const CELL_DEG = 0.0003;
  const dupGrid = new Map<string, Bounds[]>();
  const ringBox = (ring: LatLng[]): Bounds => {
    let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity;
    for (const p of ring) {
      n = Math.max(n, p.lat);
      s = Math.min(s, p.lat);
      e = Math.max(e, p.lng);
      w = Math.min(w, p.lng);
    }
    return { north: n, south: s, east: e, west: w };
  };
  const cellsOf = (b: Bounds): string[] => {
    const keys: string[] = [];
    for (let cy = Math.floor(b.south / CELL_DEG); cy <= Math.floor(b.north / CELL_DEG); cy++) {
      for (let cx = Math.floor(b.west / CELL_DEG); cx <= Math.floor(b.east / CELL_DEG); cx++) {
        keys.push(`${cy}:${cx}`);
      }
    }
    return keys;
  };
  const boxArea = (b: Bounds) =>
    Math.max(0, b.north - b.south) * Math.max(0, b.east - b.west);
  const duplicates = (b: Bounds): boolean => {
    for (const key of cellsOf(b)) {
      for (const o of dupGrid.get(key) ?? []) {
        const oN = Math.min(b.north, o.north);
        const oS = Math.max(b.south, o.south);
        const oE = Math.min(b.east, o.east);
        const oW = Math.max(b.west, o.west);
        if (oN <= oS || oE <= oW) continue;
        const overlap = (oN - oS) * (oE - oW);
        if (overlap >= 0.6 * Math.min(boxArea(b), boxArea(o))) return true;
      }
    }
    return false;
  };
  const register = (b: Bounds) => {
    for (const key of cellsOf(b)) {
      let list = dupGrid.get(key);
      if (!list) {
        list = [];
        dupGrid.set(key, list);
      }
      list.push(b);
    }
  };

  /** @returns how many buildings were newly accepted. */
  const ingest = (list: FetchedBuilding[], dedupe: boolean): number => {
    let accepted = 0;
    for (const b of list) {
      if (byId.has(b.id)) continue;
      const box = ringBox(b.ring);
      if (dedupe && duplicates(box)) continue;
      byId.set(b.id, b.ring);
      register(box);
      accepted++;
    }
    return accepted;
  };

  const fetchInto = async (rects: Bounds[]) => {
    if (simpleFetcher) {
      ingest(await simpleFetcher(rects, signal), false);
      return;
    }
    const tasks: ["osm" | "ags", Promise<FetchedBuilding[]>][] = [];
    if (useOsm) tasks.push(["osm", fetchBuildingsInRects(rects, signal)]);
    if (useAgs) tasks.push(["ags", fetchBuildingsArcgis(rects, signal)]);
    const settled = await Promise.allSettled(tasks.map((t) => t[1]));
    let anyOk = false;
    let firstError: unknown = null;
    // OSM is ingested first (authoritative footprints); ArcGIS entries
    // duplicating an accepted building are dropped.
    settled.forEach((r, i) => {
      const kind = tasks[i][0];
      if (r.status === "fulfilled") {
        anyOk = true;
        const accepted = ingest(r.value, kind === "ags");
        if (kind === "osm") {
          osmCount += accepted;
        } else {
          agsRaw += r.value.length;
          agsCount += accepted;
        }
      } else {
        // A dataset that failed stays off for the rest of the run — no
        // re-crawling a dead endpoint cascade every expansion round —
        // but the loss is reported (see lostDatasets).
        firstError ??= r.reason;
        if (kind === "osm") {
          useOsm = false;
          if (osmCount > 0) lostDatasets.add("OpenStreetMap");
        } else {
          useAgs = false;
          if (agsRaw > 0) lostDatasets.add("US footprints");
        }
      }
    });
    if (!anyOk) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
  };

  const finish = (
    partial: Pick<ExpandResult, "detection" | "fetchedRect" | "capped" | "fetchError">
  ): ExpandResult => ({
    ...partial,
    merged: source === "buildings" && osmCount > 0 && agsCount > 0 ? true : undefined,
    effectiveSource:
      source === "buildings" && osmCount === 0 && agsCount > 0 ? "arcgis" : undefined,
    lostDatasets: lostDatasets.size > 0 ? [...lostDatasets] : undefined,
  });

  // The very first fetch failing means no data at all — let it throw,
  // detectCityAuto moves on to the next source cleanly.
  await fetchInto([rect]);
  // Outside the US the ArcGIS layers are legitimately empty — skip
  // them for the rest of the run instead of querying for nothing.
  // (Raw count, not accepted: where OSM is locally complete every ags
  // building deduplicates away, but the outskirts may still need them.)
  if (source === "buildings" && agsRaw === 0) useAgs = false;
  let detection: CityDetection | null = null;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    detection = detectCity(center, [...byId.values()], rect, minCitySize);
    // Expand while the user's city OR a muvla-relevant neighboring town
    // is cut off by the fetch edge — a clipped neighbor would be squared
    // mid-town and its extension drawn wrong.
    const sides = detection
      ? [...new Set([...detection.truncatedSides, ...detection.neighborTruncatedSides])]
      : [];
    if (!detection || sides.length === 0 || isCancelled?.()) {
      return finish({
        detection,
        fetchedRect: rect,
        capped: isCancelled?.() ?? false,
      });
    }

    const spanNS = (rect.north - rect.south) * perDegLat;
    const spanEW = (rect.east - rect.west) * perDegLng;
    if (byId.size >= limits.maxBuildings || Math.max(spanNS, spanEW) >= limits.maxSpanM) {
      return finish({ detection, fetchedRect: rect, capped: true });
    }

    onProgress?.({ buildings: byId.size, iteration, expandingSides: sides });

    const old = rect;
    const stepLat = STEP_M / perDegLat;
    const stepLng = STEP_M / perDegLng;
    rect = {
      north: old.north + (sides.includes("north") ? stepLat : 0),
      south: old.south - (sides.includes("south") ? stepLat : 0),
      east: old.east + (sides.includes("east") ? stepLng : 0),
      west: old.west - (sides.includes("west") ? stepLng : 0),
    };
    // Fetch only the new strips (full-width horizontals + side verticals).
    const strips: Bounds[] = [];
    if (rect.north > old.north) {
      strips.push({ north: rect.north, south: old.north, east: rect.east, west: rect.west });
    }
    if (rect.south < old.south) {
      strips.push({ north: old.south, south: rect.south, east: rect.east, west: rect.west });
    }
    if (rect.east > old.east) {
      strips.push({ north: old.north, south: old.south, east: rect.east, west: old.east });
    }
    if (rect.west < old.west) {
      strips.push({ north: old.north, south: old.south, east: old.west, west: rect.west });
    }
    try {
      // One union request per round instead of one per strip — fewer
      // requests means fewer rate-limit failures on the public servers.
      if (strips.length > 0 && !isCancelled?.()) {
        await fetchInto(strips);
      }
    } catch (e) {
      if (isCancelled?.() || signal?.aborted) {
        return finish({ detection, fetchedRect: old, capped: true });
      }
      // Mid-expansion failure of every remaining dataset: keep the city
      // detected so far (with its truncation warnings) rather than
      // discarding everything. The query caches make Retry resume here.
      return finish({
        detection,
        fetchedRect: old,
        capped: true,
        fetchError: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return finish({ detection, fetchedRect: rect, capped: true });
}

export interface AutoDetectResult extends ExpandResult {
  source: CitySource;
}

/**
 * Detect the city, trying sources in order of preference:
 *  1. Building footprints — the UNION of OSM (worldwide,
 *     community-curated) and the ArcGIS US footprints (FEMA /
 *     Microsoft, complete ML-extracted US coverage), so a house missing
 *     from either dataset is covered by the other;
 *  2. OSM settled-area outlines as a coarse estimate (flagged in the UI).
 * A source that errors or finds nothing falls through to the next; only
 * when every source errors does the whole detection fail.
 */
export async function detectCityAuto(
  center: LatLng,
  limits: ExpandLimits,
  onProgress?: (p: ExpandProgress) => void,
  isCancelled?: () => boolean,
  signal?: AbortSignal
): Promise<AutoDetectResult> {
  const sources: CitySource[] = ["buildings", "areas"];
  let lastError: unknown = null;
  let lastEmpty: AutoDetectResult | null = null;
  for (const source of sources) {
    if (isCancelled?.() || signal?.aborted) break;
    try {
      const r = await detectCityExpanding(center, limits, onProgress, isCancelled, signal, source);
      if (r.detection) return { ...r, source: r.effectiveSource ?? source };
      lastEmpty = { ...r, source: r.effectiveSource ?? source };
    } catch (e) {
      if (isCancelled?.() || signal?.aborted) throw e;
      lastError = e;
    }
  }
  if (lastEmpty) return lastEmpty;
  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : "City detection cancelled");
}
