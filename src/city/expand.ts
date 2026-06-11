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
  /** Structures excluded as clearly not batei dirah — sheds, garages,
   * barns, silos, water towers (SA 398:6) — and so not counted in the
   * city chain. */
  excludedCount?: number;
}

const INITIAL_HALF_M = 1200;
const STEP_M = 1600;
const MAX_ITERATIONS = 60;
/** Pause after a fully-failed round before retrying via the backlog —
 * lets a rate-limited server breathe. Skipped under tests. */
const FAIL_PAUSE_MS = import.meta.env.MODE === "test" ? 0 : 2500;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

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
  // Per-dataset recovery state: a failed round no longer turns the
  // dataset off — its rectangles go into a backlog that is re-attempted
  // together with the next round's strips (the failure was usually a
  // transient rate limit). Only several consecutive failed rounds give
  // up on the dataset; remaining backlog at the end means real holes,
  // which is reported.
  interface DatasetState {
    use: boolean;
    streak: number;
    backlog: Map<string, Bounds>;
  }
  const MAX_FAIL_STREAK = 3;
  const MAX_BACKLOG_RECTS = 12;
  const rectKey = (r: Bounds) => `${r.west},${r.south},${r.east},${r.north}`;
  const osmState: DatasetState = { use: true, streak: 0, backlog: new Map() };
  const agsState: DatasetState = { use: true, streak: 0, backlog: new Map() };
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

  /** Structures excluded as clearly not batei dirah (SA 398:6): they
   * never join the chain, but their footprints are registered so the
   * other dataset's copy of the same shed can't re-add it. */
  const excludedIds = new Set<number | string>();

  /** @returns how many buildings were newly accepted. */
  const ingest = (list: FetchedBuilding[], dedupe: boolean): number => {
    let accepted = 0;
    for (const b of list) {
      if (byId.has(b.id) || excludedIds.has(b.id)) continue;
      const box = ringBox(b.ring);
      if (b.nonDirah) {
        excludedIds.add(b.id);
        register(box);
        continue;
      }
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
    // Each dataset attempts the new strips PLUS its own backlog of
    // previously failed rectangles, so a transient failure heals on a
    // later round instead of leaving an invisible hole.
    const withBacklog = (st: DatasetState): Bounds[] => {
      const merged = new Map(st.backlog);
      for (const r of rects) merged.set(rectKey(r), r);
      return [...merged.values()];
    };
    const tasks: ["osm" | "ags", Bounds[], Promise<FetchedBuilding[]>][] = [];
    if (osmState.use) {
      const r = withBacklog(osmState);
      if (r.length > 0) tasks.push(["osm", r, fetchBuildingsInRects(r, signal)]);
    }
    if (agsState.use) {
      const r = withBacklog(agsState);
      if (r.length > 0) tasks.push(["ags", r, fetchBuildingsArcgis(r, signal)]);
    }
    if (tasks.length === 0) return;
    const settled = await Promise.allSettled(tasks.map((t) => t[2]));
    let anyOk = false;
    let firstError: unknown = null;
    // OSM is ingested first (authoritative footprints); ArcGIS entries
    // duplicating an accepted building are dropped.
    settled.forEach((r, i) => {
      const [kind, attempted] = [tasks[i][0], tasks[i][1]];
      const st = kind === "osm" ? osmState : agsState;
      if (r.status === "fulfilled") {
        anyOk = true;
        st.streak = 0;
        st.backlog.clear();
        const accepted = ingest(r.value, kind === "ags");
        if (kind === "osm") {
          osmCount += accepted;
        } else {
          agsRaw += r.value.length;
          agsCount += accepted;
        }
      } else {
        firstError ??= r.reason;
        st.streak++;
        for (const r2 of attempted) {
          if (st.backlog.size >= MAX_BACKLOG_RECTS) break;
          st.backlog.set(rectKey(r2), r2);
        }
        if (st.streak >= MAX_FAIL_STREAK) {
          // Several consecutive failed rounds: stop hammering a dead
          // endpoint cascade, and report the loss.
          st.use = false;
          if (kind === "osm" && osmCount > 0) lostDatasets.add("OpenStreetMap");
          if (kind === "ags" && agsRaw > 0) lostDatasets.add("US footprints");
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
    excludedCount: excludedIds.size > 0 ? excludedIds.size : undefined,
  });

  // The very first fetch failing means no data at all — let it throw,
  // detectCityAuto moves on to the next source cleanly.
  await fetchInto([rect]);
  // Outside the US the ArcGIS layers are legitimately empty — skip
  // them for the rest of the run instead of querying for nothing.
  // (Raw count, not accepted: where OSM is locally complete every ags
  // building deduplicates away, but the outskirts may still need them.)
  if (source === "buildings" && agsRaw === 0) agsState.use = false;
  let detection: CityDetection | null = null;
  let finalFlushDone = false;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    detection = detectCity(center, [...byId.values()], rect, minCitySize);
    // Expand while the user's city OR a muvla-relevant neighboring town
    // is cut off by the fetch edge — a clipped neighbor would be squared
    // mid-town and its extension drawn wrong.
    const sides = detection
      ? [...new Set([...detection.truncatedSides, ...detection.neighborTruncatedSides])]
      : [];
    if (!detection || sides.length === 0 || isCancelled?.()) {
      // Last chance for strips that failed earlier: without this, the
      // run could end with holes that were never re-attempted (the
      // backlog only rides along with NEW strips).
      const pending = osmState.backlog.size > 0 || agsState.backlog.size > 0;
      if (detection && pending && !isCancelled?.() && !finalFlushDone) {
        finalFlushDone = true;
        try {
          await fetchInto([]);
          continue; // re-detect with whatever was recovered
        } catch {
          // fall through — losses are reported below
        }
      }
      if (osmState.backlog.size > 0 && osmCount > 0) lostDatasets.add("OpenStreetMap");
      if (agsState.backlog.size > 0 && agsRaw > 0) lostDatasets.add("US footprints");
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
      const allDatasetsDown = simpleFetcher
        ? true
        : !osmState.use && !agsState.use;
      if (allDatasetsDown) {
        // Every dataset has truly given up: keep the city detected so
        // far (with its truncation warnings) rather than discarding
        // everything. The query caches make Retry resume here.
        return finish({
          detection,
          fetchedRect: old,
          capped: true,
          fetchError: e instanceof Error ? e.message : String(e),
        });
      }
      // A failed round is usually a transient rate limit: shrink back
      // to the data we have, breathe, and let the next round retry the
      // failed strips from the backlog.
      rect = old;
      await delay(FAIL_PAUSE_MS, signal).catch(() => undefined);
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
