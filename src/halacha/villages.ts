import { metersPerDegree, rectUnion, ringGapM, type Bounds, type LatLng } from "./geometry";
import { TECHUM_M, TWO_CITIES_JOIN_M } from "./shiurim";

/**
 * Three villages in a triangle (Eruvin 57b; SA OC 398:8): when a middle
 * village sits off the line between two outer ones, we "view" it as if
 * placed between them — if it would then leave no more than 141⅓ amos
 * to EACH outer one (i.e., the gap between the outers is at most the
 * middle's width plus 282⅔ amos), all three combine into one city.
 * Conditions: the middle must be within 2,000 amos of each outer one.
 *
 * Distances are measured WALL-TO-WALL between the towns' actual
 * building outlines (falling back to squared bounds only when outlines
 * are unavailable). The middle's width is its true extent along the
 * cardinal axis of the outer pair's separation (the projection of the
 * cluster onto that axis equals its bounds extent there).
 *
 * This din is normative halacha; it is gated behind a toggle because
 * the result is a kula and borderline gaps deserve verification.
 * Only triples involving the user's own city are joined.
 */

const GAP_ALLOWANCE_M = 2 * TWO_CITIES_JOIN_M; // 282⅔ amos ≈ 135.68 m

export interface TownShape {
  bounds: Bounds;
  /** Member building outlines; omit to fall back to bounds distances. */
  rings?: LatLng[][];
}

export interface ThreeVillagesResult {
  /** The user's city after joining (bounding box of all joined towns). */
  bounds: Bounds;
  /** Towns absorbed into the city by this din. */
  absorbed: Bounds[];
  /** Towns left as separate neighbors. */
  remaining: Bounds[];
}

/** Aerial distance (m) between the closest edges of two rectangles. */
export function rectGapM(a: Bounds, b: Bounds): { dM: number; dxM: number; dyM: number } {
  const midLat = (a.north + a.south + b.north + b.south) / 4;
  const { perDegLat, perDegLng } = metersPerDegree(midLat);
  const dxM = Math.max(0, b.west - a.east, a.west - b.east) * perDegLng;
  const dyM = Math.max(0, b.south - a.north, a.south - b.north) * perDegLat;
  return { dM: Math.hypot(dxM, dyM), dxM, dyM };
}

interface PreparedTown {
  bounds: Bounds;
  rings: LatLng[][];
  /** Per-ring bounding box, for pruning the exact distance work. */
  boxes: Bounds[];
}

function ringBox(ring: LatLng[]): Bounds {
  let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity;
  for (const p of ring) {
    n = Math.max(n, p.lat);
    s = Math.min(s, p.lat);
    e = Math.max(e, p.lng);
    w = Math.min(w, p.lng);
  }
  return { north: n, south: s, east: e, west: w };
}

function prepare(t: TownShape): PreparedTown {
  const rings = t.rings ?? [];
  return { bounds: t.bounds, rings, boxes: rings.map(ringBox) };
}

/**
 * Wall-to-wall distance (m) between two towns, up to `cutoffM`: values
 * beyond the cutoff are reported coarsely (any value > cutoff). The
 * bounds gap is a lower bound on the wall gap (bounds enclose the
 * walls), so pruning by it is exact.
 */
function townGapM(a: PreparedTown, b: PreparedTown, cutoffM: number): number {
  const coarse = rectGapM(a.bounds, b.bounds).dM;
  if (coarse > cutoffM) return coarse;
  if (a.rings.length === 0 || b.rings.length === 0) return coarse;
  let best = Infinity;
  for (let i = 0; i < a.rings.length; i++) {
    for (let j = 0; j < b.rings.length; j++) {
      const lower = rectGapM(a.boxes[i], b.boxes[j]).dM;
      if (lower >= best || lower > cutoffM) continue;
      best = Math.min(best, ringGapM(a.rings[i], b.rings[j]));
      if (best === 0) return 0;
    }
  }
  return best;
}

/** The middle village "viewed as between" X and Y fits when the
 * wall-to-wall gap between X and Y is at most its width (along the
 * separation axis) plus 141⅓ amos per side. */
function fitsBetween(x: PreparedTown, y: PreparedTown, middle: PreparedTown): boolean {
  const { dxM, dyM } = rectGapM(x.bounds, y.bounds);
  const midLat = (middle.bounds.north + middle.bounds.south) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(midLat);
  const widthM =
    dxM >= dyM
      ? (middle.bounds.east - middle.bounds.west) * perDegLng
      : (middle.bounds.north - middle.bounds.south) * perDegLat;
  const cutoff = widthM + GAP_ALLOWANCE_M;
  return townGapM(x, y, cutoff) <= cutoff;
}

export function applyThreeVillages(
  userCity: TownShape,
  towns: TownShape[]
): ThreeVillagesResult {
  let merged = prepare(userCity);
  const absorbed: Bounds[] = [];
  let pool = towns.map((t) => ({ prepared: prepare(t), src: t.bounds }));
  const absorb = (t: { prepared: PreparedTown; src: Bounds }) => {
    merged = {
      bounds: rectUnion(merged.bounds, t.prepared.bounds),
      rings: [...merged.rings, ...t.prepared.rings],
      boxes: [...merged.boxes, ...t.prepared.boxes],
    };
    absorbed.push(t.src);
  };
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < pool.length; i++) {
      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const m = pool[i];
        const other = pool[j];
        // Case 1: the user's city is an outer one; m is the middle.
        const userOuter =
          townGapM(m.prepared, merged, TECHUM_M) <= TECHUM_M &&
          townGapM(m.prepared, other.prepared, TECHUM_M) <= TECHUM_M &&
          fitsBetween(merged, other.prepared, m.prepared);
        // Case 2: the user's city is the middle between m and other.
        const userMiddle =
          townGapM(merged, m.prepared, TECHUM_M) <= TECHUM_M &&
          townGapM(merged, other.prepared, TECHUM_M) <= TECHUM_M &&
          fitsBetween(m.prepared, other.prepared, merged);
        if (userOuter || userMiddle) {
          absorb(m);
          absorb(other);
          pool = pool.filter((t) => t !== m && t !== other);
          changed = true;
          break outer;
        }
      }
    }
  }
  return {
    bounds: merged.bounds,
    absorbed,
    remaining: pool.map((t) => t.src),
  };
}
