import type { Bounds, LatLng } from "../halacha/geometry";
import type { SelectedPlace } from "../maps/geocode";

export type Mode = "city" | "point";
export type LimitKey = "town" | "city" | "metro";

export interface EruvSnapshot {
  destination: SelectedPlace;
  spot: LatLng | null;
  rotationOn: boolean;
  rotationOffset: number;
}

/** Everything needed to reproduce the current view — what a shareable
 * link carries and what a saved location stores. */
export interface AppSnapshot {
  v: 1;
  place: SelectedPlace;
  mode: Mode;
  limit: LimitKey;
  karpef: boolean;
  /** Three-villages din (SA 398:8) — a kula, default off. Optional so
   * links from older versions stay valid. */
  villages?: boolean;
  manualCity: Bounds | null;
  eruv: EruvSnapshot | null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const roundPoint = (p: LatLng): LatLng => ({ lat: round6(p.lat), lng: round6(p.lng) });
const roundBounds = (b: Bounds): Bounds => ({
  north: round6(b.north),
  south: round6(b.south),
  east: round6(b.east),
  west: round6(b.west),
});

/** Normalize coordinates to 6 decimals (~0.1 m) to keep links short. */
export function normalizeSnapshot(snap: AppSnapshot): AppSnapshot {
  return {
    v: 1,
    place: { address: snap.place.address, location: roundPoint(snap.place.location) },
    mode: snap.mode,
    limit: snap.limit,
    karpef: snap.karpef,
    villages: snap.villages || undefined,
    manualCity: snap.manualCity ? roundBounds(snap.manualCity) : null,
    eruv: snap.eruv
      ? {
          destination: {
            address: snap.eruv.destination.address,
            location: roundPoint(snap.eruv.destination.location),
          },
          spot: snap.eruv.spot ? roundPoint(snap.eruv.spot) : null,
          rotationOn: snap.eruv.rotationOn,
          rotationOffset: snap.eruv.rotationOffset,
        }
      : null,
  };
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeSnapshot(snap: AppSnapshot): string {
  return toBase64Url(JSON.stringify(normalizeSnapshot(snap)));
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function isLatLng(p: unknown): p is LatLng {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return isNum(o.lat) && isNum(o.lng) && Math.abs(o.lat) <= 90 && Math.abs(o.lng) <= 180;
}

function isBounds(b: unknown): b is Bounds {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    isNum(o.north) && isNum(o.south) && isNum(o.east) && isNum(o.west) &&
    (o.north as number) >= (o.south as number)
  );
}

function isPlace(p: unknown): p is SelectedPlace {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.address === "string" && isLatLng(o.location);
}

/** Validate an arbitrary parsed value as an AppSnapshot. */
export function validateSnapshot(raw: unknown): AppSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (!isPlace(o.place)) return null;
  if (o.mode !== "city" && o.mode !== "point") return null;
  if (o.limit !== "town" && o.limit !== "city" && o.limit !== "metro") return null;
  if (typeof o.karpef !== "boolean") return null;
  const manualCity = o.manualCity == null ? null : isBounds(o.manualCity) ? o.manualCity : null;
  let eruv: EruvSnapshot | null = null;
  if (o.eruv != null) {
    const e = o.eruv as Record<string, unknown>;
    if (!isPlace(e.destination)) return null;
    eruv = {
      destination: e.destination,
      spot: isLatLng(e.spot) ? e.spot : null,
      rotationOn: e.rotationOn === true,
      rotationOffset: isNum(e.rotationOffset)
        ? Math.max(-45, Math.min(45, e.rotationOffset))
        : 0,
    };
  }
  return {
    v: 1,
    place: o.place,
    mode: o.mode,
    limit: o.limit,
    karpef: o.karpef,
    villages: o.villages === true || undefined,
    manualCity,
    eruv,
  };
}

export function decodeSnapshot(encoded: string): AppSnapshot | null {
  try {
    return validateSnapshot(JSON.parse(fromBase64Url(encoded)));
  } catch {
    return null;
  }
}

const HASH_PREFIX = "#s=";

export function buildShareHash(snap: AppSnapshot): string {
  return HASH_PREFIX + encodeSnapshot(snap);
}

/** Parse a location.hash (e.g. "#s=…"); null when absent or invalid. */
export function parseShareHash(hash: string): AppSnapshot | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  return decodeSnapshot(hash.slice(HASH_PREFIX.length));
}
