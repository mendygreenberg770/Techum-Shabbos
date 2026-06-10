import { describe, expect, it } from "vitest";
import { detectCity } from "./city/cluster";
import { computeMuvlaBumps, kalsaCities } from "./halacha/muvla";
import { hostTownCandidates, placeEruv, planEruv } from "./halacha/eruv";
import {
  expandBounds,
  metersPerDegree,
  pointBounds,
  type Bounds,
  type LatLng,
} from "./halacha/geometry";
import { FOUR_AMOS_M, TECHUM_M } from "./halacha/shiurim";

/**
 * End-to-end scenarios through the real pipeline (clustering → ribua →
 * techum → sequential muvla → kalsa → eiruv placement), modeled on the
 * address types exercised in the field: a dense city grid, a sparse
 * rural road, and an eiruv resting in a host town.
 */

const C: LatLng = { lat: 40.7, lng: -73.95 };
const { perDegLat, perDegLng } = metersPerDegree(C.lat);

/** A square building of size `s` meters centered at (cx, cy) meters from C. */
function house(cx: number, cy: number, s = 10): LatLng[] {
  return [
    [cx - s / 2, cy - s / 2],
    [cx + s / 2, cy - s / 2],
    [cx + s / 2, cy + s / 2],
    [cx - s / 2, cy + s / 2],
  ].map(([x, y]) => ({ lat: C.lat + y / perDegLat, lng: C.lng + x / perDegLng }));
}

function area(halfM: number): Bounds {
  return expandBounds(pointBounds(C), halfM);
}

const mLng = (lng: number) => (lng - C.lng) * perDegLng;

describe("scenario: dense city grid (urban address)", () => {
  // 41×41 houses at 30 m pitch: a contiguous ~1.2 km city around C.
  const buildings: LatLng[][] = [];
  for (let x = -600; x <= 600; x += 30) {
    for (let y = -600; y <= 600; y += 30) {
      buildings.push(house(x, y));
    }
  }

  it("joins the whole grid into one city and measures from its edge", () => {
    const det = detectCity(C, buildings, area(4000))!;
    expect(det.clusterSize).toBe(buildings.length);
    expect(det.otherCities).toHaveLength(0);
    expect(det.bowGapM).toBeNull();
    // Squared city spans ±605; techum edge at 605 + 960.
    const techum = expandBounds(det.bounds, TECHUM_M);
    expect(mLng(techum.east)).toBeCloseTo(605 + TECHUM_M, 0);
    expect(computeMuvlaBumps(det.bounds, techum, det.otherCities)).toEqual([]);
  });
});

describe("scenario: sparse rural road (clumps that do not join the city)", () => {
  // Home: two houses joined (gap 20 m). Clumps B and C further east on
  // the same road — each a 2-house town, too far to JOIN (gaps ≫ 33.92)
  // but close enough to be SWALLOWED by the techum.
  const buildings = [
    house(0, 0),
    house(30, 0), // home cluster: spans -5..35
    house(400, 0),
    house(430, 0), // town B: spans 395..435
    house(800, 0),
    house(830, 0), // town C: spans 795..835
  ];

  it("keeps the clumps separate but credits them sequentially as muvla", () => {
    const det = detectCity(C, buildings, area(4000))!;
    expect(det.clusterSize).toBe(2);
    expect(det.otherCities).toHaveLength(2);

    const techum = expandBounds(det.bounds, TECHUM_M); // east edge 35+960=995
    const bumps = computeMuvlaBumps(det.bounds, techum, det.otherCities);
    expect(bumps).toHaveLength(2);

    // B: open ground 395−35=360 consumed; far = 435+(960−360−4 amos).
    const farB = 435 + (TECHUM_M - 360 - FOUR_AMOS_M);
    const bumpB = bumps.find((b) => mLng(b.city.west) < 600)!;
    expect(mLng(bumpB.bounds.east)).toBeCloseTo(farB, 0);

    // C measures THROUGH B: 360 open + 4 amos + 360 open — not the raw
    // 760 m. Sequential accounting reaches further than naive.
    const consumedC = 360 + FOUR_AMOS_M + (795 - 435);
    const farC = 835 + (TECHUM_M - consumedC - FOUR_AMOS_M);
    const bumpC = bumps.find((b) => mLng(b.city.west) > 600)!;
    expect(mLng(bumpC.bounds.east)).toBeCloseTo(farC, 0);
    const naiveFarC = 835 + (TECHUM_M - (795 - 35) - FOUR_AMOS_M);
    expect(farC).toBeGreaterThan(naiveFarC);

    // Nothing is painted kalsa: both towns are credited in full.
    expect(kalsaCities(techum, bumps, det.otherCities)).toEqual([]);
  });
});

describe("scenario: eiruv techumin into a host town", () => {
  // Home city ±100 m around C; destination 2.2 km east (beyond the
  // techum). A host town straddles the techum edge (x 900..1300): its
  // near part is reachable, and its far edge carries the new techum.
  const home = expandBounds(pointBounds(C), 100);
  const techum = expandBounds(home, TECHUM_M); // edge at 1060
  const hostTown: Bounds = {
    north: C.lat + 100 / perDegLat,
    south: C.lat - 100 / perDegLat,
    east: C.lng + 1300 / perDegLng,
    west: C.lng + 900 / perDegLng,
  };
  const destination: LatLng = { lat: C.lat, lng: C.lng + 2200 / perDegLng };

  it("needs an eiruv, and the host town carries the new techum to the destination", () => {
    const plan = planEruv(techum, [], destination);
    expect(plan.destinationInHomeTechum).toBe(false);
    // A bare-point eiruv cannot reach: the destination is ~1,140 m past
    // the techum edge. Only the host-town din makes this trip possible —
    // the planner must offer the town instead of declaring it out of reach.
    expect(plan.feasibleRegion).toBeNull();
    const candidates = hostTownCandidates(techum, [hostTown], destination);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].town).toBe(hostTown);
    // The placeable area is the part of the town reachable within the techum.
    expect(mLng(candidates[0].placeable.east)).toBeCloseTo(100 + TECHUM_M, 0);

    // Eiruv at 1,000 m east — inside the host town and inside the home
    // techum (reachable before Shabbos by foot from home).
    const spot: LatLng = { lat: C.lat, lng: C.lng + 1000 / perDegLng };
    const placement = placeEruv(
      spot,
      destination,
      techum,
      plan.feasibleRegion,
      [home, hostTown],
      undefined,
      { ramaHomeCity: home }
    );
    expect(placement.hostCity).toBe(hostTown);
    // New techum extends from the whole town's squared edge (1,300 m),
    // not from the bare point: reaches 1300+960 = 2260 ≥ 2200.
    expect(mLng(placement.newTechum.east)).toBeCloseTo(1300 + TECHUM_M, 0);
    expect(placement.destinationCovered).toBe(true);
    expect(placement.inFeasibleRegion).toBe(true);
    // Rama 408:1 — the home town stays accessible as 4 amos even though
    // it is not fully inside the eiruv's techum.
    expect(placement.ramaCity).toBe(home);
  });

  it("warns when the eiruv rests in one's own town (no effect)", () => {
    const spotInHome: LatLng = { lat: C.lat, lng: C.lng + 50 / perDegLng };
    const plan = planEruv(techum, [], destination);
    const placement = placeEruv(
      spotInHome,
      destination,
      techum,
      plan.feasibleRegion,
      [home, hostTown],
      undefined,
      { ramaHomeCity: home }
    );
    expect(placement.hostCity).toBe(home);
  });
});
