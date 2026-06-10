import { TECHUM_M } from "./shiurim";

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * A north-aligned rectangle on the map (ribua ha'olam: the techum is
 * squared to the four directions of the world, so everything we draw
 * is aligned to true north).
 */
export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * Meters per degree of latitude/longitude at a given latitude (WGS84
 * series expansion, accurate to well under a meter at techum scale).
 */
export function metersPerDegree(latDeg: number): {
  perDegLat: number;
  perDegLng: number;
} {
  const lat = (latDeg * Math.PI) / 180;
  const perDegLat =
    111132.92 -
    559.82 * Math.cos(2 * lat) +
    1.175 * Math.cos(4 * lat) -
    0.0023 * Math.cos(6 * lat);
  const perDegLng =
    111412.84 * Math.cos(lat) -
    93.5 * Math.cos(3 * lat) +
    0.118 * Math.cos(5 * lat);
  return { perDegLat, perDegLng };
}

/**
 * Expand a north-aligned rectangle by the given number of meters on
 * every side. This is the core techum operation: the squared city (or
 * dwelling) extended 2,000 amos in each direction, corners included.
 */
export function expandBounds(bounds: Bounds, meters: number): Bounds {
  const midLat = (bounds.north + bounds.south) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(midLat);
  return {
    north: bounds.north + meters / perDegLat,
    south: bounds.south - meters / perDegLat,
    east: bounds.east + meters / perDegLng,
    west: bounds.west - meters / perDegLng,
  };
}

/**
 * Techum for a lone dwelling treated as a point: a north-aligned
 * square extending 2,000 amos (960 m) in each direction.
 *
 * Phase 2 replaces the point with the squared boundary of the halachic
 * city when the address is inside a built-up area; until then this is
 * the stringent fallback (it never overstates the techum).
 */
export function techumFromPoint(center: LatLng, techumMeters: number = TECHUM_M): Bounds {
  const point: Bounds = {
    north: center.lat,
    south: center.lat,
    east: center.lng,
    west: center.lng,
  };
  return expandBounds(point, techumMeters);
}

/** Straight-line (aerial) distance in meters between two points (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Zero-size bounds at a point (a lone person/eiruv spot before squaring). */
export function pointBounds(p: LatLng): Bounds {
  return { north: p.lat, south: p.lat, east: p.lng, west: p.lng };
}

/** Intersection of two north-aligned rectangles, or null when disjoint. */
export function rectIntersect(a: Bounds, b: Bounds): Bounds | null {
  const r: Bounds = {
    north: Math.min(a.north, b.north),
    south: Math.max(a.south, b.south),
    east: Math.min(a.east, b.east),
    west: Math.max(a.west, b.west),
  };
  return r.north > r.south && r.east > r.west ? r : null;
}

/** Smallest north-aligned rectangle containing both rectangles. */
export function rectUnion(a: Bounds, b: Bounds): Bounds {
  return {
    north: Math.max(a.north, b.north),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    west: Math.min(a.west, b.west),
  };
}

/** a minus b, as up to four disjoint rectangles. */
export function rectDifference(a: Bounds, b: Bounds): Bounds[] {
  const inter = rectIntersect(a, b);
  if (!inter) return [a];
  const out: Bounds[] = [];
  if (inter.north < a.north) {
    out.push({ north: a.north, south: inter.north, east: a.east, west: a.west });
  }
  if (inter.south > a.south) {
    out.push({ north: inter.south, south: a.south, east: a.east, west: a.west });
  }
  if (inter.west > a.west) {
    out.push({ north: inter.north, south: inter.south, east: inter.west, west: a.west });
  }
  if (inter.east < a.east) {
    out.push({ north: inter.north, south: inter.south, east: a.east, west: inter.east });
  }
  return out;
}

/** Whether a point lies within a north-aligned rectangle. */
export function boundsContain(bounds: Bounds, p: LatLng): boolean {
  return (
    p.lat <= bounds.north &&
    p.lat >= bounds.south &&
    p.lng <= bounds.east &&
    p.lng >= bounds.west
  );
}
