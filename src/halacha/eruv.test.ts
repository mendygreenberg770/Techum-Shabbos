import { describe, expect, it } from "vitest";
import {
  bearingDeg,
  diamondContains,
  diamondRing,
  distanceToRectM,
  placeEruv,
  planEruv,
  rotatedFeasible,
  roundedRectRing,
} from "./eruv";
import { TECHUM_CORNER_M } from "./shiurim";
import {
  expandBounds,
  metersPerDegree,
  pointBounds,
  type Bounds,
  type LatLng,
} from "./geometry";
import { TECHUM_M } from "./shiurim";

const C: LatLng = { lat: 40.7, lng: -73.95 };
const { perDegLat, perDegLng } = metersPerDegree(C.lat);

function at(xM: number, yM: number): LatLng {
  return { lat: C.lat + yM / perDegLat, lng: C.lng + xM / perDegLng };
}

function rectM(west: number, south: number, east: number, north: number): Bounds {
  return {
    north: C.lat + north / perDegLat,
    south: C.lat + south / perDegLat,
    east: C.lng + east / perDegLng,
    west: C.lng + west / perDegLng,
  };
}

const mLng = (lng: number) => (lng - C.lng) * perDegLng;

// Home: a point dweller at C → techum is C ± 960 m.
const homeTechum = expandBounds(pointBounds(C), TECHUM_M);

describe("planEruv", () => {
  it("needs no eiruv when the destination is within the home techum", () => {
    const plan = planEruv(homeTechum, [], at(500, 0));
    expect(plan.destinationInHomeTechum).toBe(true);
  });

  it("offers a feasible region for a destination within 4,000 amos", () => {
    // Destination 1,500 m east: reachable since 1500 < 2 * 960.
    const plan = planEruv(homeTechum, [], at(1500, 0));
    expect(plan.destinationInHomeTechum).toBe(false);
    expect(plan.feasibleRegion).not.toBeNull();
    // E must satisfy: within home techum (x ≤ 960) and within 960 m of
    // the destination (x ≥ 540).
    expect(mLng(plan.feasibleRegion!.west)).toBeCloseTo(540, 0);
    expect(mLng(plan.feasibleRegion!.east)).toBeCloseTo(960, 0);
  });

  it("returns no feasible region beyond 4,000 amos", () => {
    const plan = planEruv(homeTechum, [], at(2000, 0));
    expect(plan.feasibleRegion).toBeNull();
  });
});

describe("placeEruv", () => {
  const destination = at(1500, 0);
  const feasible = planEruv(homeTechum, [], destination).feasibleRegion;

  it("covers the destination from a valid spot and reports gain/loss", () => {
    const placement = placeEruv(at(800, 0), destination, homeTechum, feasible, []);
    expect(placement.inFeasibleRegion).toBe(true);
    expect(placement.destinationCovered).toBe(true);
    // New techum spans x -160..1760.
    expect(mLng(placement.newTechum.east)).toBeCloseTo(1760, 0);
    expect(mLng(placement.newTechum.west)).toBeCloseTo(-160, 0);
    // Gained to the east, lost on the west (home side).
    expect(placement.gained.length).toBeGreaterThan(0);
    expect(placement.lost.length).toBeGreaterThan(0);
    expect(mLng(placement.lost[0].west)).toBeCloseTo(-960, 0);
  });

  it("flags a spot outside the feasible region", () => {
    const placement = placeEruv(at(100, 0), destination, homeTechum, feasible, []);
    expect(placement.inFeasibleRegion).toBe(false);
    expect(placement.destinationCovered).toBe(false);
  });

  it("credits a fully swallowed city as 4 amos in the new techum", () => {
    // Eiruv at x=800; a city spans x 1200..1400 (within 960 m of it).
    // Beyond the city the techum continues: consumed 400 m + 4 amos.
    const city = rectM(1200, -40, 1400, 40);
    const placement = placeEruv(at(800, 0), at(1900, 0), homeTechum, feasible, [city]);
    expect(placement.newBumps).toHaveLength(1);
    expect(placement.newBumps[0].side).toBe("east");
    // Destination at 1900 is beyond the plain square (1760) but inside the bump.
    expect(placement.destinationCovered).toBe(true);
  });
});

describe("eiruv resting inside a town (SA HaRav 408)", () => {
  it("credits the whole host town: techum extends from its squared edge", () => {
    // Host town spans x 700..1500; eiruv placed inside it at x=800.
    const hostTown = rectM(700, -50, 1500, 50);
    const dest = at(2300, 0); // beyond a bare point's reach (1760)
    const placement = placeEruv(at(800, 0), dest, homeTechum, null, [hostTown]);
    expect(placement.hostCity).toBe(hostTown);
    // New techum: town east edge 1500 + 960 = 2460 → destination covered.
    expect(mLng(placement.newTechum.east)).toBeCloseTo(1500 + TECHUM_M, 0);
    expect(placement.destinationCovered).toBe(true);
    // Reachable (within the home techum) → valid despite being outside
    // the bare-point feasible region.
    expect(placement.inFeasibleRegion).toBe(true);
  });

  it("also credits the town's 70 2/3-amah ibur margin", () => {
    const hostTown = rectM(700, -50, 1500, 50);
    // 20 m east of the town's edge — within the ibur margin (33.92 m).
    const placement = placeEruv(at(1520, 0), at(2300, 0), homeTechum, null, [hostTown]);
    expect(placement.hostCity).toBe(hostTown);
  });

  it("an eiruv inside one's own town is a no-op (regular techum)", () => {
    const ownTown = rectM(-50, -50, 50, 50);
    const myTechum = expandBounds(ownTown, TECHUM_M);
    const placement = placeEruv(at(0, 0), at(1500, 0), myTechum, null, [ownTown]);
    expect(placement.hostCity).toBe(ownTown);
    // The "new" techum equals the regular techum — nothing gained.
    expect(placement.gained).toHaveLength(0);
    expect(placement.destinationCovered).toBe(false);
  });
});

describe("Rashi/Rama 408:1 — home town as 4 amos", () => {
  // A wide home town spanning x -3000..50; eiruv placed 850 m beyond
  // its east edge (a valid distance), so the town is NOT fully within
  // the eiruv's techum (which spans x -60..1860).
  const homeTown = rectM(-3000, -50, 50, 50);
  const eruv = at(900, 0);
  const dest = at(-2500, 0); // deep inside the home town

  it("keeps the home town accessible under the Rama", () => {
    const placement = placeEruv(eruv, dest, homeTechum, null, [], undefined, {
      ramaHomeCity: homeTown,
    });
    expect(placement.ramaCity).not.toBeNull();
    expect(placement.destinationCovered).toBe(true);
  });

  it("loses the far side of the town under the stricter view", () => {
    const placement = placeEruv(eruv, dest, homeTechum, null, []);
    expect(placement.ramaCity).toBeNull();
    expect(placement.destinationCovered).toBe(false);
  });

  it("defers to the regular muvla din when the town is fully swallowed", () => {
    const smallTown = rectM(-50, -50, 50, 50);
    const placement = placeEruv(at(500, 0), at(0, 0), homeTechum, null, [smallTown], undefined, {
      ramaHomeCity: smallTown,
    });
    expect(placement.ramaCity).toBeNull(); // contained → ordinary muvla
    expect(placement.destinationCovered).toBe(true);
  });
});

describe("corner-rotation kula (chabad.org #4494176)", () => {
  // Home city: 100 m square around C.
  const homeBase = rectM(-50, -50, 50, 50);

  it("measures distance to the squared city boundary", () => {
    expect(distanceToRectM(at(0, 0), homeBase)).toBe(0);
    expect(distanceToRectM(at(1050, 0), homeBase)).toBeCloseTo(1000, 0);
    expect(distanceToRectM(at(1050, 1050), homeBase)).toBeCloseTo(1000 * Math.SQRT2, 0);
  });

  it("allows placing the eiruv up to 2,000·√2 amos beyond the city line", () => {
    // The article: rotating the square to a diamond allows an eiruv up
    // to ~1,344 m (their 40% approximation of 960·√2 ≈ 1,357.6 m)
    // beyond the city line.
    const dest = at(2500, 0);
    expect(rotatedFeasible(at(1344 + 50, 0), homeBase, dest)).toBe(true);
    expect(rotatedFeasible(at(1400 + 50, 0), homeBase, dest)).toBe(false);
    // Within reach of the city but too far from the destination:
    expect(rotatedFeasible(at(900, 0), homeBase, at(2500, 0))).toBe(false);
  });

  it("builds a diamond with a corner aimed at the destination", () => {
    const eruv = at(0, 0);
    const dest = at(2000, 0); // due east
    const ring = diamondRing(eruv, TECHUM_CORNER_M, bearingDeg(eruv, dest));
    expect(ring).toHaveLength(4);
    // First corner points due east at the corner distance.
    expect((ring[0].lng - eruv.lng) * perDegLng).toBeCloseTo(TECHUM_CORNER_M, 0);
    expect((ring[0].lat - eruv.lat) * perDegLat).toBeCloseTo(0, 0);
  });

  it("checks containment in a rotated diamond, with offset trade-off", () => {
    const eruv = at(0, 0);
    const dest = at(1300, 0); // due east, within corner reach
    const aimed = bearingDeg(eruv, dest);
    expect(diamondContains(eruv, TECHUM_CORNER_M, aimed, dest)).toBe(true);
    // Re-aiming the corner 45° away (edge toward the destination)
    // shrinks reach there to 960 m — the destination falls out.
    expect(diamondContains(eruv, TECHUM_CORNER_M, aimed + 45, dest)).toBe(false);
    // ... while a point 900 m north-east-ish comes into range instead.
    expect(diamondContains(eruv, TECHUM_CORNER_M, aimed + 45, at(900, 900))).toBe(true);
  });

  it("builds a rounded-rect placement region around the city", () => {
    const ring = roundedRectRing(homeBase, TECHUM_CORNER_M, 8);
    expect(ring.length).toBe(4 * 9);
    // Due east of the city's east edge, the ring reaches edge + corner distance.
    const maxLng = Math.max(...ring.map((p) => (p.lng - C.lng) * perDegLng));
    expect(maxLng).toBeCloseTo(50 + TECHUM_CORNER_M, 0);
  });
});
