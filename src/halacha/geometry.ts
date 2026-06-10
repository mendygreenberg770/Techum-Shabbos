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

/** Whether a point lies within a north-aligned rectangle. */
export function boundsContain(bounds: Bounds, p: LatLng): boolean {
  return (
    p.lat <= bounds.north &&
    p.lat >= bounds.south &&
    p.lng <= bounds.east &&
    p.lng >= bounds.west
  );
}
