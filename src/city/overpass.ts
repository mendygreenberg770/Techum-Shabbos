import type { Bounds, LatLng } from "../halacha/geometry";

/** Public Overpass instances with worldwide data and CORS enabled.
 * Tried in rotation: a request that fails (HTTP error, rate limit, or a
 * "remark" runtime error in an otherwise-200 response) moves to the next
 * endpoint, and the first one that works is preferred afterwards. */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
let preferred = 0;

const RETRY_PASSES = 2;
const RETRY_DELAY_MS = 1500;
/** Client-side cap per request; the query's own timeout is shorter. */
const FETCH_TIMEOUT_MS = 90_000;

interface OverpassElement {
  type: string;
  id: number;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

export interface FetchedBuilding {
  id: number;
  /** Building outline as its bounding rectangle (4 corners). */
  ring: LatLng[];
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/** Combine the caller's signal with a timeout, degrading gracefully on
 * browsers without AbortSignal.timeout/any (older Safari). */
function requestSignal(signal?: AbortSignal): AbortSignal | undefined {
  const timeout =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined;
  if (signal && timeout && typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeout]);
  }
  return signal ?? timeout;
}

async function fetchFromEndpoint(
  endpoint: string,
  query: string,
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    signal: requestSignal(signal),
  });
  if (!res.ok) {
    throw new Error(`Overpass returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    elements?: OverpassElement[];
    remark?: string;
  };
  // Overloaded servers return HTTP 200 with a "remark" runtime error and
  // empty/partial results. Treating that as "no buildings here" silently
  // collapses the techum to a bare point — fail instead, so the next
  // endpoint is tried and real failures reach the UI.
  if (data.remark && /error/i.test(data.remark)) {
    throw new Error(`Overpass: ${data.remark}`);
  }
  if (!Array.isArray(data.elements)) {
    throw new Error("Overpass: malformed response");
  }
  return data.elements
    .filter((el) => el.type === "way" && el.bounds)
    .map((el) => {
      const b = el.bounds!;
      return {
        id: el.id,
        ring: [
          { lat: b.minlat, lng: b.minlon },
          { lat: b.minlat, lng: b.maxlon },
          { lat: b.maxlat, lng: b.maxlon },
          { lat: b.maxlat, lng: b.minlon },
        ],
      };
    });
}

/**
 * Fetch buildings inside a lat/lng rectangle from OpenStreetMap via the
 * Overpass API. To keep city-scale downloads feasible, only each
 * building's bounding box is fetched (`out ids bb`), not its full
 * outline — roughly 10x smaller. The bbox shares the footprint's
 * extremes, so the squared-city bounds are unaffected; gaps between
 * diagonal buildings can be slightly understated (joining a bit more
 * than the strict footprint would — noted in DESIGN.md).
 *
 * Known limitation: multipolygon relation buildings are skipped; these
 * are rare for dwellings.
 */
export async function fetchBuildingsInRect(
  rect: Bounds,
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  const bbox = `${rect.south},${rect.west},${rect.north},${rect.east}`;
  const query = `[out:json][timeout:60];way[building](${bbox});out ids bb qt;`;

  let lastError: Error = new Error("No Overpass endpoint available");
  for (let pass = 0; pass < RETRY_PASSES; pass++) {
    if (pass > 0) await delay(RETRY_DELAY_MS * pass, signal);
    for (let k = 0; k < ENDPOINTS.length; k++) {
      const idx = (preferred + k) % ENDPOINTS.length;
      try {
        const result = await fetchFromEndpoint(ENDPOINTS[idx], query, signal);
        preferred = idx;
        return result;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  throw lastError;
}
