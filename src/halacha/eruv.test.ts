import { describe, expect, it } from "vitest";
import { placeEruv, planEruv } from "./eruv";
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
