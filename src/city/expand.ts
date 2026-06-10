import { detectCity, type CityDetection, type Side } from "./cluster";
import { fetchBuildingsInRect, fetchSettledAreasInRect } from "./overpass";
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
}

const INITIAL_HALF_M = 1200;
const STEP_M = 1600;
const MAX_ITERATIONS = 60;

/** What the city outline is built from: individual building footprints,
 * or settled-area (landuse) outlines as a coarser fallback where OSM has
 * no buildings mapped. */
export type CitySource = "buildings" | "areas";

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
  const byId = new Map<number, LatLng[]>();
  const fetcher = source === "areas" ? fetchSettledAreasInRect : fetchBuildingsInRect;
  const minCitySize = source === "areas" ? 1 : undefined;

  const fetchInto = async (r: Bounds) => {
    for (const b of await fetcher(r, signal)) {
      byId.set(b.id, b.ring);
    }
  };

  // The very first fetch failing means no data at all — let it throw.
  await fetchInto(rect);
  let detection: CityDetection | null = null;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    detection = detectCity(center, [...byId.values()], rect, minCitySize);
    const sides = detection?.truncatedSides ?? [];
    if (!detection || sides.length === 0 || isCancelled?.()) {
      return { detection, fetchedRect: rect, capped: isCancelled?.() ?? false };
    }

    const spanNS = (rect.north - rect.south) * perDegLat;
    const spanEW = (rect.east - rect.west) * perDegLng;
    if (byId.size >= limits.maxBuildings || Math.max(spanNS, spanEW) >= limits.maxSpanM) {
      return { detection, fetchedRect: rect, capped: true };
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
      for (const s of strips) {
        if (isCancelled?.()) break;
        await fetchInto(s);
      }
    } catch (e) {
      if (isCancelled?.() || signal?.aborted) {
        return { detection, fetchedRect: old, capped: true };
      }
      // Mid-expansion failure: keep the city detected so far (with its
      // truncation warnings) rather than discarding everything.
      return {
        detection,
        fetchedRect: old,
        capped: true,
        fetchError: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { detection, fetchedRect: rect, capped: true };
}

export interface AutoDetectResult extends ExpandResult {
  source: CitySource;
}

/**
 * Detect the city from building footprints; where OSM has none mapped
 * around the point (common in parts of the US), fall back to settled-area
 * outlines (landuse polygons) as a coarser estimate. The caller flags
 * area-based results for manual review.
 */
export async function detectCityAuto(
  center: LatLng,
  limits: ExpandLimits,
  onProgress?: (p: ExpandProgress) => void,
  isCancelled?: () => boolean,
  signal?: AbortSignal
): Promise<AutoDetectResult> {
  const buildings = await detectCityExpanding(center, limits, onProgress, isCancelled, signal);
  if (buildings.detection || isCancelled?.() || signal?.aborted) {
    return { ...buildings, source: "buildings" };
  }
  const areas = await detectCityExpanding(center, limits, onProgress, isCancelled, signal, "areas");
  return { ...areas, source: "areas" };
}
