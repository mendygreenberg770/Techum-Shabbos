import { metersPerDegree, rectUnion, type Bounds } from "./geometry";
import { TECHUM_M, TWO_CITIES_JOIN_M } from "./shiurim";

/**
 * Three villages in a triangle (Eruvin 57b; SA OC 398:8): when a middle
 * village sits off the line between two outer ones, we "view" it as if
 * placed between them — if it would then leave no more than 141⅓ amos
 * to EACH outer one (i.e., the gap between the outers is at most the
 * middle's width plus 282⅔ amos), all three combine into one city.
 * Conditions: the middle must be within 2,000 amos of each outer one.
 *
 * This is a kula — OFF by default, behind a confirm-with-your-rav
 * toggle. Working simplifications: distances are between squared bounds
 * (closest edges); the middle's width is taken along the cardinal axis
 * of the outer pair's separation; only triples involving the user's own
 * city are joined (a triple entirely among neighbors is not merged).
 */

const GAP_ALLOWANCE_M = 2 * TWO_CITIES_JOIN_M; // 282⅔ amos ≈ 135.68 m

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

/** The middle village "viewed as between" X and Y fits when the gap
 * between X and Y is at most its width (along the separation axis)
 * plus 141⅓ amos per side. */
function fitsBetween(x: Bounds, y: Bounds, middle: Bounds): boolean {
  const { dM, dxM, dyM } = rectGapM(x, y);
  const midLat = (middle.north + middle.south) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(midLat);
  const widthM =
    dxM >= dyM
      ? (middle.east - middle.west) * perDegLng
      : (middle.north - middle.south) * perDegLat;
  return dM <= widthM + GAP_ALLOWANCE_M;
}

export function applyThreeVillages(
  userCity: Bounds,
  towns: Bounds[]
): ThreeVillagesResult {
  let bounds = userCity;
  const absorbed: Bounds[] = [];
  let pool = [...towns];
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
          rectGapM(m, bounds).dM <= TECHUM_M &&
          rectGapM(m, other).dM <= TECHUM_M &&
          fitsBetween(bounds, other, m);
        // Case 2: the user's city is the middle between m and other.
        const userMiddle =
          rectGapM(bounds, m).dM <= TECHUM_M &&
          rectGapM(bounds, other).dM <= TECHUM_M &&
          fitsBetween(m, other, bounds);
        if (userOuter || userMiddle) {
          bounds = rectUnion(rectUnion(bounds, m), other);
          absorbed.push(m, other);
          pool = pool.filter((t) => t !== m && t !== other);
          changed = true;
          break outer;
        }
      }
    }
  }
  return { bounds, absorbed, remaining: pool };
}
