import { describe, expect, it } from "vitest";
import { detectCity } from "./cluster";
import {
  expandBounds,
  metersPerDegree,
  pointBounds,
  type Bounds,
  type LatLng,
} from "../halacha/geometry";

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

/** Analyzed area: a square of `halfM` meters half-width around C. */
function area(halfM: number): Bounds {
  return expandBounds(pointBounds(C), halfM);
}

describe("detectCity: single-karpef joining (70 2/3 amos = 33.92 m)", () => {
  it("joins buildings with a 30 m gap", () => {
    // rect(0,0) spans x -5..5, rect(40,0) spans 35..45 → gap 30 m.
    const det = detectCity(C, [rect(0, 0), rect(40, 0)], area(2000))!;
    expect(det.clusterSize).toBe(2);
  });

  it("does not join buildings with a 40 m gap", () => {
    // rect(50,0) spans 45..55 → gap 40 m > 33.92 m.
    const det = detectCity(C, [rect(0, 0), rect(50, 0)], area(2000))!;
    expect(det.clusterSize).toBe(1);
  });

  it("joins a whole chain of buildings 30 m apart", () => {
    const det = detectCity(
      C,
      [rect(0, 0), rect(40, 0), rect(80, 0), rect(120, 0), rect(160, 0)],
      area(2000)
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
      area(2000)
    )!;
    expect(det.clusterSize).toBe(4);
  });

  it("does not join two clusters with a 70 m gap", () => {
    // Cluster B spans 95..125 → gap 70 m > 67.84 m.
    const det = detectCity(
      C,
      [rect(0, 0), rect(20, 0), rect(100, 0), rect(120, 0)],
      area(2000)
    )!;
    expect(det.clusterSize).toBe(2);
  });

  it("does not pull in a lone building at city-joining distance", () => {
    // A single house 55 m away is not a 'city'; it only joins within
    // the single karpef (33.92 m).
    const det = detectCity(C, [rect(0, 0), rect(20, 0), rect(85, 0)], area(2000))!;
    expect(det.clusterSize).toBe(2);
  });

  it("with minCitySize 1 (settled-area mode), lone polygons join at city distance", () => {
    // Each settled-area outline already represents many dwellings, so
    // two of them 55 m apart (spans -5..5 and 60..70) join across the
    // two-karpef distance.
    const det = detectCity(C, [rect(0, 0), rect(65, 0)], area(2000), 1)!;
    expect(det.clusterSize).toBe(2);
  });

  it("with minCitySize 1, a lone polygon counts among other cities", () => {
    const det = detectCity(C, [rect(0, 0), rect(500, 0)], area(2000), 1)!;
    expect(det.otherCities).toHaveLength(1);
  });
});

describe("detectCity: locating the user and the city bounds", () => {
  it("reports distance 0 when the point is inside a building", () => {
    const det = detectCity(C, [rect(0, 0)], area(2000))!;
    expect(det.nearestBuildingM).toBe(0);
  });

  it("reports the aerial distance to the nearest building", () => {
    // Building spans x 195..205; nearest edge is 195 m from the point.
    const det = detectCity(C, [rect(200, 0)], area(2000))!;
    expect(det.nearestBuildingM).toBeCloseTo(195, 0);
  });

  it("returns the north-aligned bbox of the cluster as the squared city", () => {
    // Diagonal gap from corner (5,5) to corner (35,15) is ~31.6 m ≤ 33.92.
    const det = detectCity(C, [rect(0, 0), rect(40, 20)], area(2000))!;
    expect(det.clusterSize).toBe(2);
    // Cluster spans x -5..45, y -5..25 around C.
    expect((det.bounds.east - C.lng) * perDegLng).toBeCloseTo(45, 1);
    expect((det.bounds.west - C.lng) * perDegLng).toBeCloseTo(-5, 1);
    expect((det.bounds.north - C.lat) * perDegLat).toBeCloseTo(25, 1);
    expect((det.bounds.south - C.lat) * perDegLat).toBeCloseTo(-5, 1);
  });

  it("returns null when there are no buildings", () => {
    expect(detectCity(C, [], area(2000))).toBeNull();
  });
});

describe("detectCity: other cities (for the ir muvla'as din)", () => {
  it("reports a separate multi-building cluster with its squared bounds", () => {
    const det = detectCity(
      C,
      [rect(0, 0), rect(20, 0), rect(500, 0), rect(520, 0)],
      area(2000)
    )!;
    expect(det.clusterSize).toBe(2);
    expect(det.otherCities).toHaveLength(1);
    const other = det.otherCities[0];
    expect((other.west - C.lng) * perDegLng).toBeCloseTo(495, 1);
    expect((other.east - C.lng) * perDegLng).toBeCloseTo(525, 1);
  });

  it("does not report lone structures as cities", () => {
    const det = detectCity(C, [rect(0, 0), rect(20, 0), rect(500, 0)], area(2000))!;
    expect(det.otherCities).toHaveLength(0);
  });
});

describe("detectCity: bow-shaped city (Nesivos Shabbos 42:17)", () => {
  it("flags a C-shaped city whose interior gap exceeds 4,000 amos", () => {
    // Two east-west arms 2,400 m apart, connected by a column on the west.
    const buildings: LatLng[][] = [];
    for (let x = 0; x <= 2400; x += 40) {
      buildings.push(rect(x, 0));
      buildings.push(rect(x, 2400));
    }
    for (let y = 40; y < 2400; y += 40) {
      buildings.push(rect(0, y));
    }
    const det = detectCity(C, buildings, area(4000))!;
    expect(det.clusterSize).toBe(buildings.length); // all joined (30 m gaps)
    expect(det.bowGapM).not.toBeNull();
    expect(det.bowGapM!).toBeGreaterThan(1920);
    // The gap locations are reported, inside the cluster's open middle
    // (grid-quantized: bands may stick out up to one 200 m cell).
    expect(det.bowGapRects.length).toBeGreaterThan(0);
    const slackLat = 200 / perDegLat;
    const slackLng = 200 / perDegLng;
    for (const r of det.bowGapRects) {
      expect(r.north).toBeLessThanOrEqual(det.bounds.north + slackLat);
      expect(r.south).toBeGreaterThanOrEqual(det.bounds.south - slackLat);
      expect(r.east).toBeLessThanOrEqual(det.bounds.east + slackLng);
      expect(r.west).toBeGreaterThanOrEqual(det.bounds.west - slackLng);
    }
    // The biggest reported stretch matches the open interior (~2,200 m
    // between the arms' building edges, grid-quantized).
    const r0 = det.bowGapRects[0];
    const spanM = Math.max(
      (r0.north - r0.south) * perDegLat,
      (r0.east - r0.west) * perDegLng
    );
    expect(spanM).toBeGreaterThan(1920);
  });

  it("does not flag a compact town", () => {
    const det = detectCity(C, [rect(0, 0), rect(40, 0), rect(80, 0)], area(2000))!;
    expect(det.bowGapM).toBeNull();
    expect(det.bowGapRects).toEqual([]);
  });
});

describe("detectCity: truncation at the edge of the analyzed area", () => {
  it("flags sides where the cluster reaches the analyzed area's edge", () => {
    const det = detectCity(C, [rect(0, 0), rect(40, 0), rect(80, 0)], area(150))!;
    // Cluster reaches x = 85 ≥ 150 - (67.84 + 5).
    expect(det.truncatedSides).toContain("east");
    expect(det.truncatedSides).not.toContain("west");
  });

  it("flags nothing when the city is well inside the analyzed area", () => {
    const det = detectCity(C, [rect(0, 0), rect(40, 0)], area(2000))!;
    expect(det.truncatedSides).toEqual([]);
  });
});
