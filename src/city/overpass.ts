import type { Bounds, LatLng } from "../halacha/geometry";

/** Optional same-origin (or custom) proxy, for networks whose filters
 * block the public Overpass endpoints — see api/overpass.js and the
 * README. Tried first when configured. */
const PROXY = (import.meta.env.VITE_OVERPASS_PROXY as string | undefined)?.trim();

/** Public Overpass instances with worldwide data and CORS enabled.
 * Tried in rotation: a request that fails (HTTP error, rate limit, or a
 * "remark" runtime error in an otherwise-200 response) moves to the next
 * endpoint, and the first one that works is preferred afterwards. */
const ENDPOINTS = [
  ...(PROXY ? [PROXY] : []),
  "https://overpass-api.de/api/interpreter",
  // High-capacity community instance with generous rate limits.
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  // Same-origin serverless proxy (api/overpass.js) — deployed
  // automatically on Vercel; if the app loads, this route can't be
  // blocked by a network filter. Fails fast and harmlessly elsewhere.
  "/api/overpass",
];
let preferred = 0;

const RETRY_PASSES = 2;
const RETRY_DELAY_MS = 1500;
/** Client-side cap per request; the query's own timeout is shorter. */
const FETCH_TIMEOUT_MS = 90_000;
/**
 * Minimum spacing between query starts: the public servers rate-limit
 * per IP, and a metro expansion fires a query per round back-to-back —
 * pacing them costs little (each round also computes) and avoids
 * tripping the limiter mid-analysis. Disabled under tests.
 */
const MIN_QUERY_SPACING_MS = import.meta.env.MODE === "test" ? 0 : 1500;
/** An endpoint that rate-limited us is skipped for this long; others
 * keep serving in the meantime. */
const ENDPOINT_COOLDOWN_MS = 45_000;

interface OverpassElement {
  type: string;
  id: number;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: { lat: number; lon: number }[];
}

export interface FetchedBuilding {
  id: number | string;
  /** Building outline as its bounding rectangle (4 corners). */
  ring: LatLng[];
  /** Clearly NOT a beis dirah (shed/garage/barn/silo…): such a
   * structure does not join a city (SA 398:6) — it is excluded from the
   * chain but still registered so the other dataset can't re-add it. */
  nonDirah?: boolean;
}

/**
 * OSM building values that are clearly not batei dirah — structures
 * without (and not made for) human dwelling, which do not extend a city
 * (the principle of SA OC 398:6: a bridge/storehouse/monument joins
 * only WITH a dwelling). Deliberately conservative: anything arguably
 * dwelling-like (hut, cabin, guardhouse — the Gemara's burganin) stays
 * counted, and ambiguous categories (offices, shuls, factories) remain
 * counted as the genuinely open shaala.
 */
const NON_DIRAH_VALUES = [
  "shed",
  "garage",
  "garages",
  "carport",
  "greenhouse",
  "barn",
  "stable",
  "sty",
  "cowshed",
  "farm_auxiliary",
  "silo",
  "water_tower",
  "storage_tank",
  "slurry_tank",
  "tank",
  "roof",
  "ruins",
  "collapsed",
  "transformer_tower",
  "service",
  "kiosk",
  "toilets",
  "hangar",
  "bunker",
  "digester",
  "construction",
  "container",
  "garbage_shed",
];
const NON_DIRAH_REGEX = `^(${NON_DIRAH_VALUES.join("|")})$`;

/** Rings larger than this are decimated before distance math (exact
 * segment distances are O(n·m) per pair). Dropping vertices can only
 * cut corners inward — measured gaps grow slightly, a stringency. */
export function decimateRing(ring: LatLng[], max = 32): LatLng[] {
  if (ring.length <= max) return ring;
  // The four extreme vertices are always kept: they define the squared
  // bounds (ribua) and the outermost walls — dropping one would move
  // the techum line inward off the actual building.
  let iN = 0, iS = 0, iE = 0, iW = 0;
  ring.forEach((p, i) => {
    if (p.lat > ring[iN].lat) iN = i;
    if (p.lat < ring[iS].lat) iS = i;
    if (p.lng > ring[iE].lng) iE = i;
    if (p.lng < ring[iW].lng) iW = i;
  });
  const idxs = new Set<number>([iN, iS, iE, iW]);
  const samples = max - idxs.size;
  const step = ring.length / samples;
  for (let k = 0; k < samples; k++) idxs.add(Math.floor(k * step));
  return [...idxs].sort((a, b) => a - b).map((i) => ring[i]);
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
export function requestSignal(signal?: AbortSignal): AbortSignal | undefined {
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
): Promise<OverpassElement[]> {
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
  return data.elements;
}

/** Successful responses, keyed by query. The expansion re-issues
 * identical queries when a partially failed analysis is retried — the
 * cache turns Retry into a resume instead of a full re-download. */
const queryCache = new Map<string, OverpassElement[]>();
const QUERY_CACHE_MAX = 120;

/** After every endpoint fails, skip Overpass entirely for a while:
 * on networks that block it, each analysis would otherwise slow-crawl
 * through the whole failover cascade before reaching the ArcGIS
 * fallback. */
let blockedUntil = 0;
const COOLDOWN_MS = 60_000;
/** Per-endpoint rate-limit cooldowns and the global query pacer. */
const endpointBlockedUntil = new Map<string, number>();
let nextQueryAt = 0;

const isRateLimit = (e: unknown): boolean =>
  /429|rate.?limit|too many|load too high/i.test(e instanceof Error ? e.message : String(e));

/** Test hook: module-level cache survives between tests otherwise. */
export function clearOverpassCache(): void {
  queryCache.clear();
  blockedUntil = 0;
  endpointBlockedUntil.clear();
  nextQueryAt = 0;
}

/** Run a query against the endpoint pool with failover and retry. */
async function runQuery(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  const cached = queryCache.get(query);
  if (cached) return cached;
  if (Date.now() < blockedUntil) {
    throw new Error(
      "Overpass endpoints unavailable (cooling down after repeated failures)"
    );
  }
  const pace = nextQueryAt - Date.now();
  if (pace > 0) await delay(pace, signal);
  nextQueryAt = Date.now() + MIN_QUERY_SPACING_MS;
  let lastError: Error = new Error("No Overpass endpoint available");
  for (let pass = 0; pass < RETRY_PASSES; pass++) {
    if (pass > 0) await delay(RETRY_DELAY_MS * pass, signal);
    for (let k = 0; k < ENDPOINTS.length; k++) {
      const idx = (preferred + k) % ENDPOINTS.length;
      const endpoint = ENDPOINTS[idx];
      // On the last pass, a rate-limit cooldown is no reason to skip —
      // a paced retry against a cooling endpoint beats giving up.
      if (pass < RETRY_PASSES - 1 && Date.now() < (endpointBlockedUntil.get(endpoint) ?? 0)) {
        continue;
      }
      try {
        const result = await fetchFromEndpoint(endpoint, query, signal);
        preferred = idx;
        blockedUntil = 0;
        endpointBlockedUntil.delete(endpoint);
        queryCache.set(query, result);
        if (queryCache.size > QUERY_CACHE_MAX) {
          queryCache.delete(queryCache.keys().next().value!);
        }
        return result;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (isRateLimit(e)) {
          endpointBlockedUntil.set(endpoint, Date.now() + ENDPOINT_COOLDOWN_MS);
        }
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  // The global breaker is for networks that block Overpass outright
  // (fail-fast to the ArcGIS fallback). Rate limiting is transient and
  // already handled by per-endpoint cooldowns — keep later in-run
  // retries (the expansion's backlog healing) possible.
  if (!isRateLimit(lastError)) {
    blockedUntil = Date.now() + COOLDOWN_MS;
  }
  throw lastError;
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
const bboxOf = (r: Bounds) => `${r.south},${r.west},${r.north},${r.east}`;

/** Several rectangles are fetched as ONE union query — the expansion
 * adds up to four strips per round, and one request instead of four
 * keeps the rate limits of the public servers at bay. */
export async function fetchBuildingsInRects(
  rects: Bounds[],
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  if (rects.length === 0) return [];
  // TRUE outlines for every building (out geom): at the 70⅔-amah
  // threshold a few meters decide a join, and even a small rotated
  // house's bounding box understates gaps by that much. Costs ~2.5×
  // the payload of bounding boxes — accuracy over bytes.
  const union = rects.map((r) => `way[building](${bboxOf(r)});`).join("");
  const query = `[out:json][timeout:90];(${union});out geom qt;`;
  // The non-dirah structures are identified by a second, much smaller
  // ids-only query (fetching every building's tags would multiply the
  // payload further). Its failure is benign: the structures are then
  // merely counted as before (a kula left in place, not a data hole).
  const xUnion = rects
    .map((r) => `way[building~"${NON_DIRAH_REGEX}"](${bboxOf(r)});`)
    .join("");
  const xQuery = `[out:json][timeout:60];(${xUnion});out ids qt;`;
  const [incRes, excRes] = await Promise.allSettled([
    runQuery(query, signal),
    runQuery(xQuery, signal),
  ]);
  if (incRes.status === "rejected") throw incRes.reason;
  const nonDirahIds = new Set<number>(
    excRes.status === "fulfilled" ? excRes.value.map((el) => el.id) : []
  );
  const out: FetchedBuilding[] = [];
  for (const el of incRes.value) {
    if (el.type !== "way" || (el.geometry?.length ?? 0) < 3) continue;
    const pts = el.geometry!.map((g) => ({ lat: g.lat, lng: g.lon }));
    const last = pts[pts.length - 1];
    if (last.lat === pts[0].lat && last.lng === pts[0].lng) pts.pop();
    if (pts.length < 3) continue;
    out.push({
      id: el.id,
      nonDirah: nonDirahIds.has(el.id) || undefined,
      ring: decimateRing(pts),
    });
  }
  return out;
}

export function fetchBuildingsInRect(
  rect: Bounds,
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  return fetchBuildingsInRects([rect], signal);
}

/**
 * Fallback for regions where OSM has no individual building footprints
 * (common in parts of the US): fetch settled-area outlines
 * (landuse=residential/commercial/retail) instead. These are coarse,
 * hand-drawn outlines of built-up blocks — usable as an *estimate* of
 * the city extent, flagged as such in the UI for manual review.
 *
 * Full polygon geometry is fetched (`out geom`): area polygons are few
 * but large, and their bounding boxes would badly overstate the city
 * (a kula) — the exact outlines keep the clustering honest.
 */
export async function fetchSettledAreasInRects(
  rects: Bounds[],
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  if (rects.length === 0) return [];
  const union = rects
    .map((r) => `way[landuse~"^(residential|commercial|retail)$"](${bboxOf(r)});`)
    .join("");
  const query = `[out:json][timeout:60];(${union});out geom qt;`;
  const elements = await runQuery(query, signal);
  return elements
    .filter((el) => el.type === "way" && (el.geometry?.length ?? 0) >= 3)
    .map((el) => {
      const pts = el.geometry!.map((g) => ({ lat: g.lat, lng: g.lon }));
      // Closed ways repeat the first node at the end — drop the duplicate.
      const last = pts[pts.length - 1];
      if (last.lat === pts[0].lat && last.lng === pts[0].lng) pts.pop();
      return { id: el.id, ring: pts };
    });
}

export function fetchSettledAreasInRect(
  rect: Bounds,
  signal?: AbortSignal
): Promise<FetchedBuilding[]> {
  return fetchSettledAreasInRects([rect], signal);
}
