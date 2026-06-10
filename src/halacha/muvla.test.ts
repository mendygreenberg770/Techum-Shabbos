import { describe, expect, it } from "vitest";
import { computeMuvlaBumps } from "./muvla";
import {
  expandBounds,
  metersPerDegree,
  pointBounds,
  type Bounds,
  type LatLng,
} from "./geometry";
import { FOUR_AMOS_M, TECHUM_M } from "./shiurim";

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
