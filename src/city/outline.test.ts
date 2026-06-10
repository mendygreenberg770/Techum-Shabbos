import { describe, expect, it } from "vitest";
import { unionOutline } from "./outline";
import { metersPerDegree, type LatLng } from "../halacha/geometry";
import { KARPEF_M } from "../halacha/shiurim";

const C: LatLng = { lat: 40.7, lng: -73.95 };
const { perDegLat, perDegLng } = metersPerDegree(C.lat);

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

const mX = (p: LatLng) => (p.lng - C.lng) * perDegLng;
const mY = (p: LatLng) => (p.lat - C.lat) * perDegLat;

describe("unionOutline", () => {
  it("returns one ring around a single building, dilated by the buffer", () => {
    const rings = unionOutline([rect(0, 0)], KARPEF_M / 2);
    expect(rings).toHaveLength(1);
    const xs = rings[0].map(mX);
    const ys = rings[0].map(mY);
    // Building spans ±5, buffer ~16.96 → outline spans roughly ±22
    // (grid-quantized by the 5 m minimum cell).
    expect(Math.max(...xs)).toBeGreaterThan(15);
    expect(Math.max(...xs)).toBeLessThan(32);
    expect(Math.min(...ys)).toBeLessThan(-15);
  });

  it("joins two buildings within the joining distance into one blob", () => {
    // Gap 30 m ≤ 33.92: their half-karpef dilations overlap.
    const rings = unionOutline([rect(0, 0), rect(40, 0)], KARPEF_M / 2);
    expect(rings).toHaveLength(1);
  });

  it("keeps two far buildings as separate blobs", () => {
    // Gap 90 m: dilated rects stay ~56 m apart.
    const rings = unionOutline([rect(0, 0), rect(100, 0)], KARPEF_M / 2);
    expect(rings).toHaveLength(2);
  });

  it("produces a concave outline (an L is not boxed to its bbox)", () => {
    // L-shape: an arm along x and an arm along y, missing the far corner.
    const buildings: LatLng[][] = [];
    for (let x = 0; x <= 300; x += 30) buildings.push(rect(x, 0));
    for (let y = 30; y <= 300; y += 30) buildings.push(rect(0, y));
    const rings = unionOutline(buildings, KARPEF_M / 2);
    expect(rings).toHaveLength(1);
    // The far corner (280, 280) is well outside the L's outline even
    // though it is inside the bounding box.
    const xs = rings[0].map(mX);
    const ys = rings[0].map(mY);
    expect(Math.max(...xs)).toBeGreaterThan(280);
    expect(Math.max(...ys)).toBeGreaterThan(280);
    // No outline vertex anywhere near the open corner region.
    const nearCorner = rings[0].some((p) => mX(p) > 150 && mY(p) > 150);
    expect(nearCorner).toBe(false);
  });

  it("drops holes (enclosed courtyards count as city)", () => {
    // A ring of buildings around an empty middle.
    const buildings: LatLng[][] = [];
    for (let x = 0; x <= 300; x += 30) {
      buildings.push(rect(x, 0));
      buildings.push(rect(x, 300));
    }
    for (let y = 30; y < 300; y += 30) {
      buildings.push(rect(0, y));
      buildings.push(rect(300, y));
    }
    const rings = unionOutline(buildings, KARPEF_M / 2);
    expect(rings).toHaveLength(1); // outer ring only, hole dropped
  });

  it("returns nothing for no buildings", () => {
    expect(unionOutline([], KARPEF_M / 2)).toEqual([]);
  });
});
