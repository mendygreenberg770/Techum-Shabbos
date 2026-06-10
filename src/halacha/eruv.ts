import {
  boundsContain,
  distanceMeters,
  expandBounds,
  metersPerDegree,
  pointBounds,
  rectDifference,
  rectIntersect,
  techumFromPoint,
  type Bounds,
  type LatLng,
} from "./geometry";
import { TECHUM_CORNER_M } from "./shiurim";
import { computeMuvlaBumps, rectContainedIn, type MuvlaBump } from "./muvla";

/**
 * Eiruv techumin planner (SA HaRav 408 where extant; Ketzos HaShulchan
 * for the rest of hilchos eiruvei techumin).
 *
 * Placing an eiruv moves one's shevisa to the eiruv spot: the new
 * techum is 2,000 amos squared around it, gaining distance toward the
 * destination and losing it on the home side.
 *
 * Working simplifications (noted in the UI):
 *  - The eiruv is treated as a bare point; if it rests inside another
 *    city, the halachic bonus of that city's full extent is not yet
 *    credited (a stringency).
 *  - Feasibility uses the base techum rectangle, without muvla bumps
 *    (a stringency).
 */

export interface EruvPlan {
  /** Destination already within the home techum — no eiruv needed. */
  destinationInHomeTechum: boolean;
  /**
   * Where the eiruv may be placed: within the home techum AND close
   * enough that its techum covers the destination. Null when the
   * destination is out of range even with an eiruv.
   */
  feasibleRegion: Bounds | null;
}

export interface EruvPlacement {
  newTechum: Bounds;
  /** Muvla extensions of the new techum (e.g., the home city counting as 4 amos). */
  newBumps: MuvlaBump[];
  /**
   * The home town kept accessible by the Rashi/Rama leniency (408:1)
   * even though it is not fully within the eiruv's techum: since one
   * physically spends the onset of Shabbos in his town, the whole town
   * counts as 4 amos for him. The Mechaber — and seemingly the Alter
   * Rebbe's Siddur — are stricter; the Alter Rebbe's Shulchan Aruch
   * opens with the Rama's view but the rest was never published.
   * Common practice follows the Rama (Dayan L.Y. Raskin, in the
   * article's comments). Whether the measure also continues beyond the
   * town is NOT credited here (a stringency).
   */
  ramaCity: Bounds | null;
  /** Area gained relative to the home techum (rect parts). */
  gained: Bounds[];
  /** Area lost relative to the home techum (rect parts). */
  lost: Bounds[];
  /** Whether the chosen spot is inside the feasible region. */
  inFeasibleRegion: boolean;
  /** Whether the destination is covered by the new techum (incl. bumps). */
  destinationCovered: boolean;
}

export function planEruv(
  homeTechum: Bounds,
  homeBumps: MuvlaBump[],
  destination: LatLng
): EruvPlan {
  const destinationInHomeTechum =
    boundsContain(homeTechum, destination) ||
    homeBumps.some((b) => boundsContain(b.bounds, destination));
  // The techum of a point is a north-aligned square, so "destination
  // within the square around E" is equivalent to "E within the square
  // around the destination".
  const feasibleRegion = rectIntersect(homeTechum, techumFromPoint(destination));
  return { destinationInHomeTechum, feasibleRegion };
}

// ---------------------------------------------------------------------------
// Corner-rotation kula
//
// Per "A Practical Application of Techum Shabbat" (chabad.org #4494176):
// for one's personal eiruv techumin, the squaring of the techum may be
// plotted to one's preference — rotating the square to a diamond-like
// position aims its corner at the desired direction, extending the
// reach there to 2,000·√2 amos (~1,357.6 m; the article approximates
// 40% ≈ 1,344 m). Applied both to placing the eiruv beyond the city
// line and to the new techum around the eiruv. A kula — confirm with a
// rav before relying on it.
// ---------------------------------------------------------------------------

/** Aerial distance (m) from a point to the nearest point of a rectangle. */
export function distanceToRectM(p: LatLng, rect: Bounds): number {
  const { perDegLat, perDegLng } = metersPerDegree(p.lat);
  const dx =
    p.lng < rect.west
      ? (rect.west - p.lng) * perDegLng
      : p.lng > rect.east
        ? (p.lng - rect.east) * perDegLng
        : 0;
  const dy =
    p.lat < rect.south
      ? (rect.south - p.lat) * perDegLat
      : p.lat > rect.north
        ? (p.lat - rect.north) * perDegLat
        : 0;
  return Math.hypot(dx, dy);
}

/**
 * With the rotation kula, a spot is a valid eiruv placement when it is
 * within corner reach (2,000·√2 amos) of the home city's squared
 * boundary AND within corner reach of the destination.
 */
export function rotatedFeasible(
  eruvSpot: LatLng,
  homeBase: Bounds,
  destination: LatLng
): boolean {
  return (
    distanceToRectM(eruvSpot, homeBase) <= TECHUM_CORNER_M &&
    distanceMeters(eruvSpot, destination) <= TECHUM_CORNER_M
  );
}

/** Initial bearing (degrees clockwise from north) from one point to another. */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const { perDegLat, perDegLng } = metersPerDegree(from.lat);
  const dx = (to.lng - from.lng) * perDegLng;
  const dy = (to.lat - from.lat) * perDegLat;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * The region within `radiusM` of a rectangle: the rectangle expanded
 * with quarter-circle (rounded) corners, as a polygon ring. Used to
 * draw where the eiruv may be placed under the rotation kula.
 */
export function roundedRectRing(rect: Bounds, radiusM: number, segments = 12): LatLng[] {
  const midLat = (rect.north + rect.south) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(midLat);
  const rLat = radiusM / perDegLat;
  const rLng = radiusM / perDegLng;
  const corners: [number, number, number][] = [
    // [cornerLat, cornerLng, startAngleDeg] — angle 0 points north, clockwise.
    [rect.north, rect.east, 0],
    [rect.south, rect.east, 90],
    [rect.south, rect.west, 180],
    [rect.north, rect.west, 270],
  ];
  const ring: LatLng[] = [];
  for (const [lat, lng, start] of corners) {
    for (let s = 0; s <= segments; s++) {
      const a = ((start + (90 * s) / segments) * Math.PI) / 180;
      ring.push({ lat: lat + rLat * Math.cos(a), lng: lng + rLng * Math.sin(a) });
    }
  }
  return ring;
}

/**
 * A square of corner-distance `radiusM` around a center, rotated so
 * that one corner points along `towardBearingDeg` (the destination).
 */
export function diamondRing(
  center: LatLng,
  radiusM: number,
  towardBearingDeg: number
): LatLng[] {
  const { perDegLat, perDegLng } = metersPerDegree(center.lat);
  const ring: LatLng[] = [];
  for (let k = 0; k < 4; k++) {
    const a = ((towardBearingDeg + 90 * k) * Math.PI) / 180;
    ring.push({
      lat: center.lat + (radiusM * Math.cos(a)) / perDegLat,
      lng: center.lng + (radiusM * Math.sin(a)) / perDegLng,
    });
  }
  return ring;
}

/**
 * Whether a point lies within a rotated square ("diamond") of
 * corner-distance `radiusM` whose corners sit at `cornerBearingDeg`
 * (+ multiples of 90°) from the center.
 */
export function diamondContains(
  center: LatLng,
  radiusM: number,
  cornerBearingDeg: number,
  p: LatLng
): boolean {
  const { perDegLat, perDegLng } = metersPerDegree(center.lat);
  const dx = (p.lng - center.lng) * perDegLng;
  const dy = (p.lat - center.lat) * perDegLat;
  const a = (cornerBearingDeg * Math.PI) / 180;
  const u = dx * Math.sin(a) + dy * Math.cos(a);
  const v = dx * Math.cos(a) - dy * Math.sin(a);
  return Math.abs(u) + Math.abs(v) <= radiusM + 0.5;
}

export function placeEruv(
  eruvSpot: LatLng,
  destination: LatLng,
  homeTechum: Bounds,
  feasibleRegion: Bounds | null,
  /** All known cities (incl. the home city) for the muvla din. */
  cities: Bounds[],
  techumMeters?: number,
  opts?: {
    /**
     * The home town, to apply the Rashi/Rama 408:1 leniency: it stays
     * accessible (as 4 amos) even when not fully within the eiruv's
     * techum. Pass null/omit to follow the stricter view.
     */
    ramaHomeCity?: Bounds | null;
  }
): EruvPlacement {
  const newTechum = techumMeters
    ? expandBounds(pointBounds(eruvSpot), techumMeters)
    : techumFromPoint(eruvSpot);
  const newBumps = computeMuvlaBumps(pointBounds(eruvSpot), newTechum, cities, techumMeters);

  // Rashi/Rama 408:1: relevant only when the home town is not already
  // fully swallowed (in which case the regular muvla din covers it).
  const home = opts?.ramaHomeCity ?? null;
  const ramaCity = home && !rectContainedIn(home, newTechum) ? home : null;

  return {
    newTechum,
    newBumps,
    ramaCity,
    gained: rectDifference(newTechum, homeTechum),
    lost: rectDifference(homeTechum, newTechum),
    inFeasibleRegion: feasibleRegion !== null && boundsContain(feasibleRegion, eruvSpot),
    destinationCovered:
      boundsContain(newTechum, destination) ||
      newBumps.some((b) => boundsContain(b.bounds, destination)) ||
      (ramaCity !== null && boundsContain(ramaCity, destination)),
  };
}
