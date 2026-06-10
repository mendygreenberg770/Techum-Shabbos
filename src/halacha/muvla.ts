import { FOUR_AMOS_M, TECHUM_M } from "./shiurim";
import { metersPerDegree, type Bounds } from "./geometry";

/**
 * Ir muvla'as bitoch hatechum (SA HaRav 408:1): a city that lies
 * entirely within the techum counts as only four amos of the 2,000-amah
 * measure. So beyond a swallowed city, the techum extends further: the
 * measure consumed is the open distance up to the city plus 4 amos for
 * the whole city, and the remainder continues past its far edge.
 *
 * Working simplifications (flagged in the UI / DESIGN.md):
 *  - The extension's lateral extent is the swallowed city's own squared
 *    width (no further squaring of the bump).
 *  - Chains (a second city swallowed only within a bump) are not
 *    extended further.
 *  - Distances are measured along the cardinal axis, consistent with
 *    the square (ribua) model of the techum.
 */

export type BumpSide = "north" | "south" | "east" | "west";

export interface MuvlaBump {
  side: BumpSide;
  /** The extra techum area beyond the base techum rectangle. */
  bounds: Bounds;
  /** The swallowed city that generated it. */
  city: Bounds;
}

/** Whether `inner` lies entirely within `outer` (half-meter tolerance). */
export function rectContainedIn(inner: Bounds, outer: Bounds): boolean {
  const midLat = (outer.north + outer.south) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(midLat);
  const epsLat = 0.5 / perDegLat;
  const epsLng = 0.5 / perDegLng;
  return (
    inner.north <= outer.north + epsLat &&
    inner.south >= outer.south - epsLat &&
    inner.east <= outer.east + epsLng &&
    inner.west >= outer.west - epsLng
  );
}

export function computeMuvlaBumps(
  homeBase: Bounds,
  techum: Bounds,
  cities: Bounds[],
  techumMeters: number = TECHUM_M
): MuvlaBump[] {
  const midLat = (homeBase.north + homeBase.south) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(midLat);
  // Half-meter tolerance for containment checks.
  const epsLat = 0.5 / perDegLat;
  const epsLng = 0.5 / perDegLng;

  const bumps: MuvlaBump[] = [];
  for (const city of cities) {
    if (!rectContainedIn(city, techum)) continue;

    if (city.west >= homeBase.east) {
      const consumed = (city.west - homeBase.east) * perDegLng;
      const remaining = techumMeters - consumed - FOUR_AMOS_M;
      const far = city.east + remaining / perDegLng;
      if (remaining > 0 && far > techum.east + epsLng) {
        bumps.push({
          side: "east",
          city,
          bounds: { north: city.north, south: city.south, west: techum.east, east: far },
        });
      }
    }
    if (city.east <= homeBase.west) {
      const consumed = (homeBase.west - city.east) * perDegLng;
      const remaining = techumMeters - consumed - FOUR_AMOS_M;
      const far = city.west - remaining / perDegLng;
      if (remaining > 0 && far < techum.west - epsLng) {
        bumps.push({
          side: "west",
          city,
          bounds: { north: city.north, south: city.south, west: far, east: techum.west },
        });
      }
    }
    if (city.south >= homeBase.north) {
      const consumed = (city.south - homeBase.north) * perDegLat;
      const remaining = techumMeters - consumed - FOUR_AMOS_M;
      const far = city.north + remaining / perDegLat;
      if (remaining > 0 && far > techum.north + epsLat) {
        bumps.push({
          side: "north",
          city,
          bounds: { north: far, south: techum.north, east: city.east, west: city.west },
        });
      }
    }
    if (city.north <= homeBase.south) {
      const consumed = (homeBase.south - city.north) * perDegLat;
      const remaining = techumMeters - consumed - FOUR_AMOS_M;
      const far = city.south - remaining / perDegLat;
      if (remaining > 0 && far < techum.south - epsLat) {
        bumps.push({
          side: "south",
          city,
          bounds: { north: techum.south, south: far, east: city.east, west: city.west },
        });
      }
    }
  }
  return bumps;
}
