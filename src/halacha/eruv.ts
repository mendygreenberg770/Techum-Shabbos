import {
  boundsContain,
  expandBounds,
  pointBounds,
  rectDifference,
  rectIntersect,
  techumFromPoint,
  type Bounds,
  type LatLng,
} from "./geometry";
import { computeMuvlaBumps, type MuvlaBump } from "./muvla";

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

export function placeEruv(
  eruvSpot: LatLng,
  destination: LatLng,
  homeTechum: Bounds,
  feasibleRegion: Bounds | null,
  /** All known cities (incl. the home city) for the muvla din. */
  cities: Bounds[],
  techumMeters?: number
): EruvPlacement {
  const newTechum = techumMeters
    ? expandBounds(pointBounds(eruvSpot), techumMeters)
    : techumFromPoint(eruvSpot);
  const newBumps = computeMuvlaBumps(pointBounds(eruvSpot), newTechum, cities, techumMeters);
  return {
    newTechum,
    newBumps,
    gained: rectDifference(newTechum, homeTechum),
    lost: rectDifference(homeTechum, newTechum),
    inFeasibleRegion: feasibleRegion !== null && boundsContain(feasibleRegion, eruvSpot),
    destinationCovered:
      boundsContain(newTechum, destination) ||
      newBumps.some((b) => boundsContain(b.bounds, destination)),
  };
}
