import { describe, expect, it } from "vitest";
import { detectCity } from "./cluster";
import { metersPerDegree, type LatLng } from "../halacha/geometry";

// Synthetic town on a flat-enough patch of the globe.
const C: LatLng = { lat: 40.7, lng: -73.95 };
const { perDegLat, perDegLng } = metersPerDegree(C.lat);

/** A square building of size `s` meters centered `cx`/`cy` meters from C. */
function rect(cx: number, cy: number, s = 10): LatLng[] {
  const corners = [
    [cx - s / 2, cy - s / 2],
    [cx + s / 2, cy - s / 2],
    [cx + s / 2, cy + s / 2],
    [cx - s / 2, cy + s / 2],
  ];
  return corners.map(([x, y]) => ({
    lat: C.lat + y / perDegLat,
    lng: C.lng + x / perDegLng,
  }));
}

describe("detectCity: single-karpef joining (70 2/3 amos = 33.92 m)", () => {
  it("joins buildings with a 30 m gap", () => {
    // rect(0,0) spans x -5..5, rect(40,0) spans 35..45 → gap 30 m.
    const det = detectCity(C, [rect(0, 0), rect(40, 0)], 2000)!;
    expect(det.clusterSize).toBe(2);
  });

  it("does not join buildings with a 40 m gap", () => {
    // rect(50,0) spans 45..55 → gap 40 m > 33.92 m.
    const det = detectCity(C, [rect(0, 0), rect(50, 0)], 2000)!;
    expect(det.clusterSize).toBe(1);
  });

  it("joins a whole chain of buildings 30 m apart", () => {
    const det = detectCity(
      C,
      [rect(0, 0), rect(40, 0), rect(80, 0), rect(120, 0), rect(160, 0)],
      2000
    )!;
    expect(det.clusterSize).toBe(5);
  });
});

describe("detectCity: two-cities joining (141 1/3 amos = 67.84 m)", () => {
  it("joins two multi-building clusters with a 55 m gap", () => {
    // Cluster A spans -5..25; cluster B spans 80..110 → gap 55 m.
    const det = detectCity(
      C,
      [rect(0, 0), rect(20, 0), rect(85, 0), rect(105, 0)],
      2000
    )!;
    expect(det.clusterSize).toBe(4);
  });

  it("does not join two clusters with a 70 m gap", () => {
    // Cluster B spans 95..125 → gap 70 m > 67.84 m.
    const det = detectCity(
      C,
      [rect(0, 0), rect(20, 0), rect(100, 0), rect(120, 0)],
      2000
    )!;
    expect(det.clusterSize).toBe(2);
  });

  it("does not pull in a lone building at city-joining distance", () => {
    // A single house 55 m away is not a 'city'; it only joins within
    // the single karpef (33.92 m).
    const det = detectCity(C, [rect(0, 0), rect(20, 0), rect(85, 0)], 2000)!;
    expect(det.clusterSize).toBe(2);
  });
});

describe("detectCity: locating the user and the city bounds", () => {
  it("reports distance 0 when the point is inside a building", () => {
    const det = detectCity(C, [rect(0, 0)], 2000)!;
    expect(det.nearestBuildingM).toBe(0);
  });

  it("reports the aerial distance to the nearest building", () => {
    // Building spans x 195..205; nearest edge is 195 m from the point.
    const det = detectCity(C, [rect(200, 0)], 2000)!;
    expect(det.nearestBuildingM).toBeCloseTo(195, 0);
  });

  it("returns the north-aligned bbox of the cluster as the squared city", () => {
    // Diagonal gap from corner (5,5) to corner (35,15) is ~31.6 m ≤ 33.92.
    const det = detectCity(C, [rect(0, 0), rect(40, 20)], 2000)!;
    expect(det.clusterSize).toBe(2);
    // Cluster spans x -5..45, y -5..25 around C.
    expect((det.bounds.east - C.lng) * perDegLng).toBeCloseTo(45, 1);
    expect((det.bounds.west - C.lng) * perDegLng).toBeCloseTo(-5, 1);
    expect((det.bounds.north - C.lat) * perDegLat).toBeCloseTo(25, 1);
    expect((det.bounds.south - C.lat) * perDegLat).toBeCloseTo(-5, 1);
  });

  it("returns null when there are no buildings", () => {
    expect(detectCity(C, [], 2000)).toBeNull();
  });
});

describe("detectCity: truncation at the edge of the analyzed area", () => {
  it("flags sides where the cluster reaches the fetch radius", () => {
    const det = detectCity(C, [rect(0, 0), rect(40, 0), rect(80, 0)], 150)!;
    // Cluster reaches x = 85 ≥ 150 - (67.84 + 5).
    expect(det.truncatedSides).toContain("east");
    expect(det.truncatedSides).not.toContain("west");
  });

  it("flags nothing when the city is well inside the analyzed area", () => {
    const det = detectCity(C, [rect(0, 0), rect(40, 0)], 2000)!;
    expect(det.truncatedSides).toEqual([]);
  });
});
