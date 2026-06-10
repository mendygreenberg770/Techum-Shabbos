import { describe, expect, it } from "vitest";
import {
  boundsContain,
  distanceMeters,
  expandBounds,
  techumFromPoint,
} from "./geometry";
import { TECHUM_M, AMAH_M, KARPEF_M } from "./shiurim";

// 770 Eastern Parkway, Brooklyn, NY
const CROWN_HEIGHTS = { lat: 40.669, lng: -73.9428 };

describe("shiurim (Reb Chaim Naeh)", () => {
  it("amah is 48 cm and the techum is 960 m", () => {
    expect(AMAH_M).toBeCloseTo(0.48, 10);
    expect(TECHUM_M).toBeCloseTo(960, 10);
  });

  it("karpef is 33.92 m", () => {
    expect(KARPEF_M).toBeCloseTo(33.92, 2);
  });
});

describe("techumFromPoint", () => {
  it("extends 960 m from the point in all four directions", () => {
    const b = techumFromPoint(CROWN_HEIGHTS);
    const c = CROWN_HEIGHTS;
    // Tolerance: bounds use WGS84 degree lengths, haversine assumes a
    // spherical earth; the models differ by a few meters at this scale.
    const edges = [
      distanceMeters(c, { lat: b.north, lng: c.lng }),
      distanceMeters(c, { lat: b.south, lng: c.lng }),
      distanceMeters(c, { lat: c.lat, lng: b.east }),
      distanceMeters(c, { lat: c.lat, lng: b.west }),
    ];
    for (const d of edges) {
      expect(Math.abs(d - TECHUM_M)).toBeLessThan(4);
    }
  });

  it("includes the corners (the techum is squared)", () => {
    const b = techumFromPoint(CROWN_HEIGHTS);
    const corner = { lat: b.north, lng: b.east };
    // Corner is ~2000*sqrt(2) amos away, well beyond 2000 amos.
    expect(distanceMeters(CROWN_HEIGHTS, corner)).toBeGreaterThan(TECHUM_M * 1.4);
    expect(boundsContain(b, corner)).toBe(true);
  });

  it("contains points just inside and excludes points just beyond the edge", () => {
    const b = techumFromPoint(CROWN_HEIGHTS);
    const justInside = expandBounds(b, -1);
    const justOutside = expandBounds(b, 1);
    expect(boundsContain(b, { lat: justInside.north, lng: CROWN_HEIGHTS.lng })).toBe(true);
    expect(boundsContain(b, { lat: justOutside.north, lng: CROWN_HEIGHTS.lng })).toBe(false);
  });
});

describe("expandBounds", () => {
  it("round-trips: expanding then shrinking restores the original", () => {
    const b = techumFromPoint(CROWN_HEIGHTS);
    const roundTrip = expandBounds(expandBounds(b, 500), -500);
    expect(roundTrip.north).toBeCloseTo(b.north, 6);
    expect(roundTrip.south).toBeCloseTo(b.south, 6);
    expect(roundTrip.east).toBeCloseTo(b.east, 6);
    expect(roundTrip.west).toBeCloseTo(b.west, 6);
  });
});
