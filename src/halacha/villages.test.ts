import { describe, expect, it } from "vitest";
import { applyThreeVillages, rectGapM } from "./villages";
import { metersPerDegree, type Bounds, type LatLng } from "./geometry";

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

describe("three villages in a triangle (SA 398:8)", () => {
  // User city: 200 m wide at the origin.
  const user = rectM(0, 0, 200, 200);

  it("joins the user (outer), an off-line middle, and another outer", () => {
    // Other outer 500 m east of the user's edge; middle village 400 m
    // wide sitting off to the north, within 2,000 amos of both. Gap
    // between outers (500 m) ≤ middle width (400) + 135.68 → joins.
    const other = rectM(700, 0, 900, 200);
    const middle = rectM(250, 600, 650, 800);
    const r = applyThreeVillages(user, [middle, other]);
    expect(r.absorbed).toHaveLength(2);
    expect(r.remaining).toHaveLength(0);
    // Combined city squared over all three.
    expect(mLng(r.bounds.east)).toBeCloseTo(900, 1);
    expect(mLng(r.bounds.west)).toBeCloseTo(0, 1);
  });

  it("does not join when the middle could not fill the gap", () => {
    // Gap between outers 700 m; middle only 400 m wide → 700 > 535.68.
    const other = rectM(900, 0, 1100, 200);
    const middle = rectM(250, 600, 650, 800);
    const r = applyThreeVillages(user, [middle, other]);
    expect(r.absorbed).toHaveLength(0);
    expect(r.remaining).toHaveLength(2);
  });

  it("does not join when the middle is beyond 2,000 amos of an outer", () => {
    const other = rectM(700, 0, 900, 200);
    const farMiddle = rectM(2000, 600, 2400, 800); // 1,800 m from the user
    expect(rectGapM(farMiddle, user).dM).toBeGreaterThan(960);
    expect(applyThreeVillages(user, [farMiddle, other]).absorbed).toHaveLength(0);
  });

  it("joins when the user is the middle village", () => {
    // Two outers flanking the user, each within 2,000 amos; their gap
    // (320 m) ≤ the user's width (200) + 135.68.
    const west2 = rectM(-260, 0, -60, 200);
    const east2 = rectM(260, 0, 460, 200);
    const r = applyThreeVillages(user, [west2, east2]);
    expect(r.absorbed).toHaveLength(2);
    expect(mLng(r.bounds.west)).toBeCloseTo(-260, 1);
    expect(mLng(r.bounds.east)).toBeCloseTo(460, 1);
  });

  it("does not join when no role assignment can fill the gap", () => {
    // All three 200 m wide: every 'viewed between' assignment leaves a
    // gap larger than middle-width + 282⅔ amos → nothing joins.
    const a = rectM(600, 0, 800, 200); // gap to user 400 m
    const b = rectM(-600, 0, -400, 200); // gap to user 400 m; a↔b 1,000 m
    const r = applyThreeVillages(user, [a, b]);
    expect(r.absorbed).toHaveLength(0);
    expect(r.remaining).toHaveLength(2);
  });

  it("chains: a join can enable a further join", () => {
    const other = rectM(700, 0, 900, 200);
    const middle = rectM(250, 600, 650, 800);
    // After joining (bounds reach x=900), a second triple to the east.
    const middle2 = rectM(950, 600, 1350, 800);
    const other2 = rectM(1400, 0, 1600, 200);
    const r = applyThreeVillages(user, [middle, other, middle2, other2]);
    expect(r.absorbed).toHaveLength(4);
    expect(mLng(r.bounds.east)).toBeCloseTo(1600, 1);
  });
});
