import { FOUR_AMOS_M, TECHUM_M } from "./shiurim";
import { metersPerDegree, rectIntersect, type Bounds } from "./geometry";

/**
 * Ir muvla'as bitoch hatechum (SA HaRav 408:1): a city that lies
 * entirely within the techum counts as only four amos of the 2,000-amah
 * measure. So beyond a swallowed city, the techum extends further: the
 * measure consumed is the open distance up to the city plus 4 amos for
 * the whole city, and the remainder continues past its far edge.
 *
 * Chains are accounted sequentially: when a second city sits behind a
 * swallowed one (within its corridor), the measure to it crosses the
 * first for only 4 amos — and a city swallowed entirely within such an
 * extension is itself muvla'as, extending further, each deducting its
 * own 4 amos.
 *
 * Working simplifications (flagged in the UI / DESIGN.md):
 *  - The extension's lateral extent is the swallowed city's own squared
 *    width (no further squaring of the bump).
 *  - A chained city must lie laterally within the corridor of the city
 *    in front of it (its full span inside the bump's span); otherwise
 *    only open-ground measure applies (a stringency).
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

/**
 * Merge city lists coming from two separate detections (e.g., around
 * the home address and around the eiruv spot). An `extra` rect that
 * substantially duplicates a `primary` one — their overlap covers at
 * least half of the smaller rect — is dropped, so the same city found
 * by both analyses is counted once (and keeps its `primary` identity).
 */
export function mergeCities(primary: Bounds[], extra: Bounds[]): Bounds[] {
  const area = (b: Bounds) =>
    Math.max(0, b.north - b.south) * Math.max(0, b.east - b.west);
  const out = [...primary];
  for (const e of extra) {
    const dup = primary.some((p) => {
      const overlap = rectIntersect(p, e);
      return overlap !== null && area(overlap) >= 0.5 * Math.min(area(p), area(e));
    });
    if (!dup) out.push(e);
  }
  return out;
}

/** Half-meter tolerance for all geometric comparisons. */
const EPS_M = 0.5;

/** A city rect in directional view: `lo`..`hi` along the outward axis,
 * `pLo`..`pHi` across it (meters in a local frame). */
interface DirRect {
  lo: number;
  hi: number;
  pLo: number;
  pHi: number;
  src: Bounds;
}

/** A swallowed city already credited in this direction: crossing it
 * consumes only 4 amos, so cities behind it (within its corridor)
 * measure from `through`. */
interface ChainNode {
  cityHi: number;
  pLo: number;
  pHi: number;
  far: number;
  through: number;
}

export function computeMuvlaBumps(
  homeBase: Bounds,
  techum: Bounds,
  cities: Bounds[],
  techumMeters: number = TECHUM_M,
  /**
   * The unbuffered home city, for direction classification. When
   * homeBase includes a karpef margin, the buffered squared bounds may
   * slightly overlap a neighboring city's squared bounds along the
   * axis; classifying against the core (and clamping the consumed
   * measure at zero) keeps such a city's extension instead of silently
   * dropping it. Defaults to homeBase.
   */
  homeCore: Bounds = homeBase
): MuvlaBump[] {
  const refLat = (homeBase.north + homeBase.south) / 2;
  const refLng = (homeBase.east + homeBase.west) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(refLat);
  const xm = (lng: number) => (lng - refLng) * perDegLng;
  const ym = (lat: number) => (lat - refLat) * perDegLat;

  // One routine handles all four directions through coordinate views:
  // the axis points outward (positive), perp is the lateral coordinate.
  const views: {
    side: BumpSide;
    rect: (b: Bounds) => DirRect;
    baseEdge: number;
    coreEdge: number;
    techumEdge: number;
    perpLo: number;
    perpHi: number;
    toBounds: (start: number, far: number, pLo: number, pHi: number) => Bounds;
  }[] = [
    {
      side: "east",
      rect: (b) => ({ lo: xm(b.west), hi: xm(b.east), pLo: ym(b.south), pHi: ym(b.north), src: b }),
      baseEdge: xm(homeBase.east),
      coreEdge: xm(homeCore.east),
      techumEdge: xm(techum.east),
      perpLo: ym(techum.south),
      perpHi: ym(techum.north),
      toBounds: (start, far, pLo, pHi) => ({
        west: refLng + start / perDegLng,
        east: refLng + far / perDegLng,
        south: refLat + pLo / perDegLat,
        north: refLat + pHi / perDegLat,
      }),
    },
    {
      side: "west",
      rect: (b) => ({ lo: -xm(b.east), hi: -xm(b.west), pLo: ym(b.south), pHi: ym(b.north), src: b }),
      baseEdge: -xm(homeBase.west),
      coreEdge: -xm(homeCore.west),
      techumEdge: -xm(techum.west),
      perpLo: ym(techum.south),
      perpHi: ym(techum.north),
      toBounds: (start, far, pLo, pHi) => ({
        west: refLng - far / perDegLng,
        east: refLng - start / perDegLng,
        south: refLat + pLo / perDegLat,
        north: refLat + pHi / perDegLat,
      }),
    },
    {
      side: "north",
      rect: (b) => ({ lo: ym(b.south), hi: ym(b.north), pLo: xm(b.west), pHi: xm(b.east), src: b }),
      baseEdge: ym(homeBase.north),
      coreEdge: ym(homeCore.north),
      techumEdge: ym(techum.north),
      perpLo: xm(techum.west),
      perpHi: xm(techum.east),
      toBounds: (start, far, pLo, pHi) => ({
        south: refLat + start / perDegLat,
        north: refLat + far / perDegLat,
        west: refLng + pLo / perDegLng,
        east: refLng + pHi / perDegLng,
      }),
    },
    {
      side: "south",
      rect: (b) => ({ lo: -ym(b.north), hi: -ym(b.south), pLo: xm(b.west), pHi: xm(b.east), src: b }),
      baseEdge: -ym(homeBase.south),
      coreEdge: -ym(homeCore.south),
      techumEdge: -ym(techum.south),
      perpLo: xm(techum.west),
      perpHi: xm(techum.east),
      toBounds: (start, far, pLo, pHi) => ({
        south: refLat - far / perDegLat,
        north: refLat - start / perDegLat,
        west: refLng + pLo / perDegLng,
        east: refLng + pHi / perDegLng,
      }),
    },
  ];

  const bumps: MuvlaBump[] = [];
  for (const v of views) {
    const nodes: ChainNode[] = [];
    const cands = cities
      .map(v.rect)
      .filter(
        (c) =>
          c.lo >= v.coreEdge - EPS_M &&
          c.pLo >= v.perpLo - EPS_M &&
          c.pHi <= v.perpHi + EPS_M
      )
      .sort((a, b) => a.lo - b.lo);

    for (const c of cands) {
      // Cheapest measure that reaches c with c fully swallowed:
      // directly across open ground (when c fits inside the base
      // techum), or through an already-swallowed city in front of it
      // (4 amos for the crossing), whichever consumes less.
      let consumed = Infinity;
      if (c.hi <= v.techumEdge + EPS_M) {
        consumed = Math.max(0, c.lo - v.baseEdge);
      }
      for (const n of nodes) {
        if (
          c.pLo >= n.pLo - EPS_M &&
          c.pHi <= n.pHi + EPS_M &&
          c.lo >= n.cityHi - EPS_M &&
          c.hi <= n.far + EPS_M
        ) {
          consumed = Math.min(consumed, n.through + Math.max(0, c.lo - n.cityHi));
        }
      }
      if (!isFinite(consumed)) continue; // not fully swallowed (kalsa midaso)

      const remaining = techumMeters - consumed - FOUR_AMOS_M;
      if (remaining <= 0) continue;
      const far = c.hi + remaining;
      // Recorded even when the extension stays inside the base techum:
      // crossing this city still costs only 4 amos for the next one.
      nodes.push({ cityHi: c.hi, pLo: c.pLo, pHi: c.pHi, far, through: consumed + FOUR_AMOS_M });
      if (far > v.techumEdge + EPS_M) {
        bumps.push({
          side: v.side,
          city: c.src,
          bounds: v.toBounds(v.techumEdge, far, c.pLo, c.pHi),
        });
      }
    }
  }
  return bumps;
}
