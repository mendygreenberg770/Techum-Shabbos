import { describe, expect, it } from "vitest";
import {
  buildShareHash,
  decodeSnapshot,
  encodeSnapshot,
  parseShareHash,
  type AppSnapshot,
} from "./share";

const full: AppSnapshot = {
  v: 1,
  place: {
    address: "770 Eastern Pkwy, Brooklyn, NY 11213, USA",
    location: { lat: 40.669, lng: -73.9428 },
  },
  mode: "city",
  limit: "metro",
  karpef: true,
  manualCity: { north: 40.68, south: 40.66, east: -73.93, west: -73.96 },
  eruv: {
    destination: { address: "Queens, NY, USA", location: { lat: 40.7282, lng: -73.7949 } },
    spot: { lat: 40.6801, lng: -73.92 },
    rotationOn: true,
    rotationOffset: -20,
  },
};

const minimal: AppSnapshot = {
  v: 1,
  place: { address: "Kfar Chabad, Israel", location: { lat: 31.9876, lng: 34.8516 } },
  mode: "point",
  limit: "town",
  karpef: false,
  manualCity: null,
  eruv: null,
};

describe("share snapshot encoding", () => {
  it("round-trips a full snapshot", () => {
    expect(decodeSnapshot(encodeSnapshot(full))).toEqual(full);
  });

  it("round-trips a minimal snapshot", () => {
    expect(decodeSnapshot(encodeSnapshot(minimal))).toEqual(minimal);
  });

  it("round-trips non-ASCII addresses", () => {
    const snap: AppSnapshot = {
      ...minimal,
      place: { address: "כפר חב״ד, ישראל", location: { lat: 31.9876, lng: 34.8516 } },
    };
    expect(decodeSnapshot(encodeSnapshot(snap))).toEqual(snap);
  });

  it("produces URL-safe output", () => {
    const enc = encodeSnapshot(full);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rounds coordinates to ~6 decimals", () => {
    const snap: AppSnapshot = {
      ...minimal,
      place: { address: "x", location: { lat: 31.123456789, lng: 34.987654321 } },
    };
    const back = decodeSnapshot(encodeSnapshot(snap))!;
    expect(back.place.location.lat).toBeCloseTo(31.123457, 6);
    expect(back.place.location.lng).toBeCloseTo(34.987654, 6);
  });

  it("rejects garbage and wrong versions", () => {
    expect(decodeSnapshot("not-base64!!!")).toBeNull();
    expect(decodeSnapshot(encodeSnapshot(full).slice(0, 10))).toBeNull();
    const v2 = { ...minimal, v: 2 };
    expect(
      decodeSnapshot(
        btoa(JSON.stringify(v2)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      )
    ).toBeNull();
  });

  it("rejects snapshots with invalid coordinates", () => {
    const bad = { ...minimal, place: { address: "x", location: { lat: 999, lng: 0 } } };
    const enc = btoa(JSON.stringify(bad))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeSnapshot(enc)).toBeNull();
  });

  it("clamps the rotation offset into the slider range", () => {
    const wild = {
      ...full,
      eruv: { ...full.eruv!, rotationOffset: 300 },
    };
    const enc = btoa(JSON.stringify(wild))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeSnapshot(enc)!.eruv!.rotationOffset).toBe(45);
  });
});

describe("share hash", () => {
  it("round-trips through the location hash format", () => {
    expect(parseShareHash(buildShareHash(full))).toEqual(full);
  });

  it("ignores unrelated hashes", () => {
    expect(parseShareHash("")).toBeNull();
    expect(parseShareHash("#section-2")).toBeNull();
    expect(parseShareHash("#s=")).toBeNull();
  });
});
