import { describe, expect, it } from "vitest";
import { computeMuvlaBumps, kalsaCities, mergeCities } from "./muvla";
import {
  expandBounds,
  metersPerDegree,
  pointBounds,
  type Bounds,
  type LatLng,
} from "./geometry";
import { FOUR_AMOS_M, KARPEF_M, TECHUM_M } from "./shiurim";

const C: LatLng = { lat: 40.7, lng: -73.95 };
const { perDegLat, perDegLng } = metersPerDegree(C.lat);

/** Bounds given in meters relative to C. */
function rectM(west: number, south: number, east: number, north: number): Bounds {
  return {
    north: C.lat + north / perDegLat,
    south: C.lat + south / perDegLat,
    east: C.lng + east / perDegLng,
    west: C.lng + west / perDegLng,
  };
}

const mLng = (lng: number) => (lng - C.lng) * perDegLng;
const mLat = (lat: number) => (lat - C.lat) * perDegLat;

describe("computeMuvlaBumps (ir muvla'as counts as 4 amos)", () => {
  // Home city: 100 m square centered on C; techum extends 960 m beyond.
  const home = rectM(-50, -50, 50, 50);
  const techum = expandBounds(home, TECHUM_M);

  it("extends the techum beyond a city swallowed to the east", () => {
    // City spans x 500..700, fully within the techum (edge at 1010).
    const city = rectM(500, -40, 700, 40);
    const bumps = computeMuvlaBumps(home, techum, [city]);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].side).toBe("east");
    // Consumed: 450 m of open land (from home edge at 50 to city at 500),
    // plus 4 amos for the whole city; remainder continues past 700.
    const expectedFar = 700 + (TECHUM_M - 450 - FOUR_AMOS_M);
    expect(mLng(bumps[0].bounds.east)).toBeCloseTo(expectedFar, 1);
    // The bump starts where the base techum ends and spans the city's width.
    expect(mLng(bumps[0].bounds.west)).toBeCloseTo(50 + TECHUM_M, 1);
    expect(mLat(bumps[0].bounds.north)).toBeCloseTo(40, 1);
    expect(mLat(bumps[0].bounds.south)).toBeCloseTo(-40, 1);
  });

  it("gives no bump when the city is not fully swallowed", () => {
    // City spans x 500..1100; techum east edge is at 1010 → straddles it.
    const city = rectM(500, -40, 1100, 40);
    expect(computeMuvlaBumps(home, techum, [city])).toHaveLength(0);
  });

  it("handles the other directions symmetrically", () => {
    const west = rectM(-700, -40, -500, 40);
    const north = rectM(-40, 500, 40, 700);
    const south = rectM(-40, -700, 40, -500);
    const bumps = computeMuvlaBumps(home, techum, [west, north, south]);
    expect(bumps.map((b) => b.side).sort()).toEqual(["north", "south", "west"]);
    const w = bumps.find((b) => b.side === "west")!;
    expect(mLng(w.bounds.west)).toBeCloseTo(-(700 + TECHUM_M - 450 - FOUR_AMOS_M), 1);
  });

  it("works for a point base (eiruv spot / lone dwelling)", () => {
    const base = pointBounds(C);
    const t = expandBounds(base, TECHUM_M);
    // Home city as seen from an eiruv 500 m to its east: spans -700..-500.
    const city = rectM(-700, -40, -500, 40);
    const bumps = computeMuvlaBumps(base, t, [city]);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].side).toBe("west");
  });

  it("ignores a city beside the home city (no axis separation)", () => {
    // Overlaps home's latitude band and its longitude band → no bump.
    const city = rectM(-40, -40, 40, 40);
    expect(computeMuvlaBumps(home, techum, [city])).toHaveLength(0);
  });
});

describe("chained ir muvla'as (each city deducts only 4 amos in sequence)", () => {
  const home = rectM(-50, -50, 50, 50);
  const techum = expandBounds(home, TECHUM_M);
  // A: x 300..500; B behind it: x 700..900 (both within techum edge 1010).
  const a = rectM(300, -40, 500, 40);
  const b = rectM(700, -30, 900, 30);

  it("credits crossing the first city when measuring to the second", () => {
    const bumps = computeMuvlaBumps(home, techum, [a, b]);
    expect(bumps).toHaveLength(2);
    const bumpA = bumps.find((x) => x.city === a)!;
    const bumpB = bumps.find((x) => x.city === b)!;
    // A: 250 m open ground consumed.
    expect(mLng(bumpA.bounds.east)).toBeCloseTo(500 + (TECHUM_M - 250 - FOUR_AMOS_M), 1);
    // B through A: 250 open + 4 amos + 200 open consumed — NOT the full
    // 650 m of raw distance.
    const consumedB = 250 + FOUR_AMOS_M + 200;
    expect(mLng(bumpB.bounds.east)).toBeCloseTo(
      900 + (TECHUM_M - consumedB - FOUR_AMOS_M),
      1
    );
  });

  it("extends through a city swallowed only within an extension", () => {
    // C: x 1100..1200 — beyond the plain techum (1010) but inside B's
    // extension; swallowed there, it counts 4 amos and extends further.
    const c = rectM(1100, -20, 1200, 20);
    const bumps = computeMuvlaBumps(home, techum, [a, b, c]);
    expect(bumps).toHaveLength(3);
    const bumpC = bumps.find((x) => x.city === c)!;
    const consumedC = 250 + FOUR_AMOS_M + 200 + FOUR_AMOS_M + 200;
    expect(mLng(bumpC.bounds.east)).toBeCloseTo(
      1200 + (TECHUM_M - consumedC - FOUR_AMOS_M),
      1
    );
  });

  it("does not chain into a city outside the corridor in front of it", () => {
    // Beyond the plain techum and laterally outside A's span → no credit.
    const offside = rectM(700, 60, 1100, 120);
    const bumps = computeMuvlaBumps(home, techum, [a, offside]);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].city).toBe(a);
  });
});

describe("muvla with a karpef-buffered base", () => {
  const home = rectM(-50, -50, 50, 50);

  it("keeps the extension when the buffered base overlaps the city's squared bounds", () => {
    const base = expandBounds(home, KARPEF_M); // edges at ±83.92
    const t = expandBounds(base, TECHUM_M);
    // The city's squared bounds start inside the karpef strip (x=80) —
    // still east of the actual home city (edge at 50).
    const city = rectM(80, -40, 300, 40);
    const bumps = computeMuvlaBumps(base, t, [city], TECHUM_M, home);
    expect(bumps).toHaveLength(1);
    // Consumed open ground clamps at zero.
    expect(mLng(bumps[0].bounds.east)).toBeCloseTo(300 + TECHUM_M - FOUR_AMOS_M, 1);
  });
});

describe("several muvla towns at once (field report regression)", () => {
  const home = rectM(-50, -50, 50, 50);
  const techum = expandBounds(home, TECHUM_M); // edge at 1010

  it("extends for every swallowed town, however deep inside the techum", () => {
    // Big town near the edge, small town near the edge beside it, and a
    // small town much deeper inside — ALL fully swallowed must extend:
    // each extension reaches (its own depth − 4 amos) past the base line.
    const big = rectM(400, -300, 900, 200); // 500 m deep
    const smallNearEdge = rectM(850, 0, 930, 60); // 80 m deep
    const smallDeep = rectM(150, -45, 210, 15); // 60 m deep, close to home
    const bumps = computeMuvlaBumps(home, techum, [big, smallNearEdge, smallDeep]);
    expect(bumps.map((b) => b.city)).toEqual(
      expect.arrayContaining([big, smallNearEdge, smallDeep])
    );
    for (const b of bumps) {
      const depth = mLng(b.city.east) - mLng(b.city.west);
      expect(mLng(b.bounds.east)).toBeCloseTo(TECHUM_M + 50 + depth - FOUR_AMOS_M, 1);
    }
  });

  it("a small town whose corridor sits inside a deeper town's corridor is subsumed", () => {
    // The small town's extension is real but lies entirely within the
    // big town's extension — no visible change to the boundary (the
    // UI annotates this instead of hiding it).
    const big = rectM(400, -300, 900, 200);
    const smallInside = rectM(150, -100, 210, -40); // corridor ⊂ big's
    const bumps = computeMuvlaBumps(home, techum, [big, smallInside]);
    const bigBump = bumps.find((b) => b.city === big)!;
    const smallBump = bumps.find((b) => b.city === smallInside)!;
    expect(smallBump).toBeDefined();
    expect(mLng(smallBump.bounds.east)).toBeLessThan(mLng(bigBump.bounds.east));
    expect(smallBump.bounds.north).toBeLessThanOrEqual(bigBump.bounds.north);
    expect(smallBump.bounds.south).toBeGreaterThanOrEqual(bigBump.bounds.south);
  });
});

describe("kalsaCities (kalsa midaso — the line ends mid-town)", () => {
  const home = rectM(-50, -50, 50, 50);
  const techum = expandBounds(home, TECHUM_M); // edge at x=1010

  it("flags a city straddling the base techum line", () => {
    const straddler = rectM(900, -40, 1200, 40);
    const bumps = computeMuvlaBumps(home, techum, [straddler]);
    expect(bumps).toHaveLength(0);
    expect(kalsaCities(techum, bumps, [straddler])).toEqual([straddler]);
  });

  it("does not flag a straddling city that is chain-credited as muvla", () => {
    // A in front (swallowed, x 300..500); D straddles the base line
    // (x 900..1100) but is fully within A's corridor and extended reach
    // — credited 4 amos, so it is reachable in full, NOT kalsa.
    const a = rectM(300, -40, 500, 40);
    const d = rectM(900, -30, 1100, 30);
    const bumps = computeMuvlaBumps(home, techum, [a, d]);
    expect(bumps.some((b) => b.city === d)).toBe(true);
    expect(kalsaCities(techum, bumps, [a, d])).toEqual([]);
  });

  it("flags a city the muvla extension line ends inside", () => {
    // A swallowed (x 300..500): its extension reaches
    // far = 500 + (960 − 250 − 1.92) ≈ 1208. E spans 1100..1400 within
    // A's corridor — the extension line ends inside it → kalsa there.
    const a = rectM(300, -40, 500, 40);
    const e = rectM(1100, -30, 1400, 30);
    const bumps = computeMuvlaBumps(home, techum, [a, e]);
    expect(bumps.some((b) => b.city === e)).toBe(false);
    expect(kalsaCities(techum, bumps, [a, e])).toEqual([e]);
  });

  it("does not flag a city fully inside the techum or fully outside reach", () => {
    const inside = rectM(300, -40, 500, 40);
    const farAway = rectM(3000, -40, 3200, 40);
    const bumps = computeMuvlaBumps(home, techum, [inside, farAway]);
    expect(kalsaCities(techum, bumps, [inside, farAway])).toEqual([]);
  });
});

describe("mergeCities (home-side + eiruv-side detections)", () => {
  const home = rectM(-50, -50, 50, 50);

  it("keeps distinct cities from both lists", () => {
    const far = rectM(2000, -50, 2200, 50);
    expect(mergeCities([home], [far])).toEqual([home, far]);
  });

  it("drops an extra rect that substantially duplicates a primary one", () => {
    // The same city re-detected around the eiruv with slightly different bounds.
    const redetected = rectM(-45, -55, 55, 45);
    expect(mergeCities([home], [redetected])).toEqual([home]);
  });

  it("keeps an extra rect that only grazes a primary one", () => {
    // Adjacent city whose squared bounds barely overlap the home's corner.
    const neighbor = rectM(40, 40, 300, 300);
    expect(mergeCities([home], [neighbor])).toEqual([home, neighbor]);
  });

  it("preserves the primary rect's identity for the duplicate", () => {
    const redetected = { ...home };
    const merged = mergeCities([home], [redetected]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(home);
  });
});
