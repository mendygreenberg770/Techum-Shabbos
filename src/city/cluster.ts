import { KARPEF_M, TECHUM_M, TWO_CITIES_JOIN_M } from "../halacha/shiurim";
import {
  expandBounds,
  metersPerDegree,
  rectIntersect,
  type Bounds,
  type LatLng,
} from "../halacha/geometry";

/**
 * Detection of the halachic city around a point.
 *
 * Halachic model (SA HaRav 398 / see DESIGN.md):
 *  - A structure joins the city when the gap between it and the city is
 *    within 70 2/3 amos (KARPEF_M = 33.92 m); joining chains onward.
 *  - Two cities join when within two karpefs of each other
 *    (TWO_CITIES_JOIN_M = 67.84 m). A lone structure is not a "city"
 *    for this second rule, so it only joins at the single-karpef
 *    distance. The minimum size for "city" status here (2 buildings)
 *    is a working assumption to confirm with a rav.
 *  - The city is then squared as a north-aligned bounding rectangle
 *    (ribua ha'olam).
 *
 * Open halachic items (flagged in the UI): which structures count as a
 * beis dirah, rivers/highways interrupting a city, bow-shaped cities.
 * All structures are currently counted.
 */
const MIN_CITY_SIZE = 2;

export type Side = "north" | "south" | "east" | "west";

export interface CityDetection {
  /** North-aligned bounding box of the detected cluster: the squared city. */
  bounds: Bounds;
  /** Convex hull of the cluster, for display. */
  hull: LatLng[];
  /** Number of buildings in the user's cluster. */
  clusterSize: number;
  /** Number of buildings analyzed in the fetched area. */
  totalBuildings: number;
  /** Aerial distance (m) from the query point to the nearest building. */
  nearestBuildingM: number;
  /**
   * Sides where the cluster reaches the edge of the analyzed area —
   * the built-up area likely continues beyond, so the true city (and
   * techum) extends further in those directions.
   */
  truncatedSides: Side[];
  /**
   * Squared bounds of other detected cities (clusters of at least
   * MIN_CITY_SIZE buildings not joined to the user's city) near enough
   * to matter for the ir muvla'as din — i.e. within reach of the techum.
   */
  otherCities: Bounds[];
  /**
   * Sides where one of those neighboring cities reaches the edge of the
   * analyzed area: its true extent continues beyond what was fetched, so
   * its squared bounds (and any muvla extension) would be clipped
   * mid-town. The analysis keeps expanding until these are empty too.
   */
  neighborTruncatedSides: Side[];
  /**
   * Bow-shaped city flag (Mishnah Eruvin 55a; Nesivos Shabbos 42:17):
   * open area inside the squared city may be "filled in"
   * only when the built ends flanking it are within 4,000 amos
   * (1,920 m). When an interior open stretch along a cardinal line
   * exceeds that, this holds its size in meters (a heuristic — review
   * with a rav); null when the squared city has no such stretch.
   */
  bowGapM: number | null;
  /** The over-limit open stretches themselves, as lat/lng rectangles
   * for highlighting on the map (largest first, capped). */
  bowGapRects: Bounds[];
  /**
   * When the bow rule disqualifies the full square: a conservative
   * alternative square covering only the area around the user where
   * every open stretch is within 4,000 amos of built ends — i.e., may
   * legitimately be "squared in" (Nesivos Shabbos 42:17). Offered as a
   * one-click stringent boundary; null when the full square is fine.
   */
  sectionBounds: Bounds | null;
  /** Member building footprints of the user's cluster (references to
   * the input rings) — the accurate city shape is drawn from these. */
  clusterRings: LatLng[][];
  /** Footprints of every cluster within techum reach that did NOT join
   * the user's city (including lone structures): the "not combining"
   * areas, drawn distinctly so exclusions are visible and reviewable. */
  neighborRings: LatLng[][];
}

interface Vertex {
  x: number;
  y: number;
  lat: number;
  lng: number;
}

interface PBuilding {
  verts: Vertex[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Axis-aligned rectangle: bbox gap is the exact outline gap. */
  isRect: boolean;
}

// ---------------------------------------------------------------------------
// Plane geometry helpers (local meters around the query point)
// ---------------------------------------------------------------------------

function pointSegDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function segSegDist(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDist(ax, ay, cx, cy, dx, dy),
    pointSegDist(bx, by, cx, cy, dx, dy),
    pointSegDist(cx, cy, ax, ay, bx, by),
    pointSegDist(dx, dy, ax, ay, bx, by)
  );
}

function pointInPolygon(px: number, py: number, verts: Vertex[]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const vi = verts[i];
    const vj = verts[j];
    if (
      vi.y > py !== vj.y > py &&
      px < ((vj.x - vi.x) * (py - vi.y)) / (vj.y - vi.y) + vi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointBuildingDist(px: number, py: number, b: PBuilding): number {
  if (pointInPolygon(px, py, b.verts)) return 0;
  let min = Infinity;
  const n = b.verts.length;
  for (let i = 0; i < n; i++) {
    const a = b.verts[i];
    const c = b.verts[(i + 1) % n];
    min = Math.min(min, pointSegDist(px, py, a.x, a.y, c.x, c.y));
  }
  return min;
}

/** Gap between bounding boxes — a lower bound on the true gap. */
function bboxGap(a: PBuilding, b: PBuilding): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

/** Exact minimum gap between two building outlines (0 if they touch). */
function buildingDist(a: PBuilding, b: PBuilding): number {
  let min = Infinity;
  const na = a.verts.length;
  const nb = b.verts.length;
  for (let i = 0; i < na; i++) {
    const a1 = a.verts[i];
    const a2 = a.verts[(i + 1) % na];
    for (let j = 0; j < nb; j++) {
      const b1 = b.verts[j];
      const b2 = b.verts[(j + 1) % nb];
      min = Math.min(min, segSegDist(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y));
      if (min === 0) return 0;
    }
  }
  return min;
}

function convexHull(points: Vertex[]): Vertex[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Vertex, a: Vertex, b: Vertex) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vertex[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vertex[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class UnionFind {
  parent: number[];
  size: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = new Array(n).fill(1);
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) {
      this.parent[ra] = rb;
      this.size[rb] += this.size[ra];
    } else {
      this.parent[rb] = ra;
      this.size[ra] += this.size[rb];
    }
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * @param fetchedRect the area that was actually analyzed; cluster
 *   vertices near its edges mark the detection as truncated there.
 */
export function detectCity(
  center: LatLng,
  buildingPolys: LatLng[][],
  fetchedRect: Bounds,
  /** Buildings needed for "city" status (the two-karpef joining rule and
   * the muvla list). Pass 1 for settled-area polygons, each of which
   * already represents many dwellings. */
  minCitySize: number = MIN_CITY_SIZE
): CityDetection | null {
  if (buildingPolys.length === 0) return null;

  const { perDegLat, perDegLng } = metersPerDegree(center.lat);
  const buildings: PBuilding[] = buildingPolys.map((poly) => {
    const verts = poly.map((p) => ({
      x: (p.lng - center.lng) * perDegLng,
      y: (p.lat - center.lat) * perDegLat,
      lat: p.lat,
      lng: p.lng,
    }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of verts) {
      minX = Math.min(minX, v.x);
      minY = Math.min(minY, v.y);
      maxX = Math.max(maxX, v.x);
      maxY = Math.max(maxY, v.y);
    }
    const eps = 1e-6;
    const isRect =
      verts.length === 4 &&
      verts.every(
        (v) =>
          (Math.abs(v.x - minX) < eps || Math.abs(v.x - maxX) < eps) &&
          (Math.abs(v.y - minY) < eps || Math.abs(v.y - maxY) < eps)
      );
    return { verts, minX, minY, maxX, maxY, isRect };
  });

  // Spatial grid: each building is registered in every cell its bbox
  // (expanded by half the largest joining distance) overlaps, so any
  // pair within the joining distance shares at least one cell. Pairs
  // may be visited more than once (cheap), which avoids keeping a
  // metro-scale dedup set in memory.
  const CELL = 100;
  const HALF = TWO_CITIES_JOIN_M / 2 + 1;
  const cells = new Map<string, number[]>();
  buildings.forEach((b, i) => {
    const x0 = Math.floor((b.minX - HALF) / CELL);
    const x1 = Math.floor((b.maxX + HALF) / CELL);
    const y0 = Math.floor((b.minY - HALF) / CELL);
    const y1 = Math.floor((b.maxY + HALF) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx}:${cy}`;
        let list = cells.get(key);
        if (!list) {
          list = [];
          cells.set(key, list);
        }
        list.push(i);
      }
    }
  });

  const uf = new UnionFind(buildings.length);
  const cityEdges: [number, number][] = [];
  const N = buildings.length;
  for (const list of cells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let c = a + 1; c < list.length; c++) {
        const i = list[a];
        const j = list[c];
        const bi = buildings[i];
        const bj = buildings[j];
        const gap = bboxGap(bi, bj);
        if (gap > TWO_CITIES_JOIN_M) continue;
        if (gap <= KARPEF_M && uf.find(i) === uf.find(j)) continue;
        // For axis-aligned rectangles (bbox-sourced data) the bbox gap
        // is the exact outline gap; otherwise compute it precisely.
        const d = bi.isRect && bj.isRect ? gap : buildingDist(bi, bj);
        if (d <= KARPEF_M) {
          uf.union(i, j);
        } else if (d <= TWO_CITIES_JOIN_M) {
          cityEdges.push([i, j]);
        }
      }
    }
  }

  // Second pass: clusters that are themselves "cities" join across the
  // two-karpef distance; repeat until stable since merging can promote
  // a cluster to city size.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [i, j] of cityEdges) {
      const ri = uf.find(i);
      const rj = uf.find(j);
      if (ri !== rj && uf.size[ri] >= minCitySize && uf.size[rj] >= minCitySize) {
        uf.union(i, j);
        changed = true;
      }
    }
  }

  // The user's building: the one containing (or nearest to) the point.
  let nearestIdx = 0;
  let nearestDist = Infinity;
  for (let i = 0; i < N; i++) {
    const d = pointBuildingDist(0, 0, buildings[i]);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
      if (d === 0) break;
    }
  }
  const root = uf.find(nearestIdx);

  // Per-cluster squared bounds (for the user's city and the muvla din).
  const clusterBounds = new Map<
    number,
    { north: number; south: number; east: number; west: number; count: number }
  >();
  for (let i = 0; i < N; i++) {
    const r = uf.find(i);
    let cb = clusterBounds.get(r);
    if (!cb) {
      cb = { north: -Infinity, south: Infinity, east: -Infinity, west: Infinity, count: 0 };
      clusterBounds.set(r, cb);
    }
    cb.count++;
    for (const v of buildings[i].verts) {
      cb.north = Math.max(cb.north, v.lat);
      cb.south = Math.min(cb.south, v.lat);
      cb.east = Math.max(cb.east, v.lng);
      cb.west = Math.min(cb.west, v.lng);
    }
  }
  const userCB = clusterBounds.get(root)!;
  const bounds: Bounds = {
    north: userCB.north,
    south: userCB.south,
    east: userCB.east,
    west: userCB.west,
  };

  // Other cities within reach of the techum (with karpef and slack),
  // for the ir muvla'as computation.
  const reach = expandBounds(bounds, TECHUM_M + KARPEF_M + 100);
  const otherCities: Bounds[] = [];
  const otherRoots = new Set<number>();
  const displayRoots = new Set<number>();
  for (const [r, cb] of clusterBounds) {
    if (r === root) continue;
    const b: Bounds = { north: cb.north, south: cb.south, east: cb.east, west: cb.west };
    if (!rectIntersect(reach, b)) continue;
    displayRoots.add(r);
    if (cb.count >= minCitySize) {
      otherCities.push(b);
      otherRoots.add(r);
    }
  }

  // The user's cluster: hull and truncation against the analyzed area.
  // Relevant neighbor clusters are checked for truncation too — a town
  // clipped by the fetch edge would otherwise be squared mid-town.
  const clusterVerts: Vertex[] = [];
  const clusterRings: LatLng[][] = [];
  const neighborRings: LatLng[][] = [];
  const truncated = new Set<Side>();
  const neighborTruncated = new Set<Side>();
  const marginLat = (TWO_CITIES_JOIN_M + 5) / perDegLat;
  const marginLng = (TWO_CITIES_JOIN_M + 5) / perDegLng;
  for (let i = 0; i < N; i++) {
    const r = uf.find(i);
    if (r === root) {
      clusterRings.push(buildingPolys[i]);
    } else if (displayRoots.has(r)) {
      neighborRings.push(buildingPolys[i]);
    }
    const target =
      r === root ? truncated : otherRoots.has(r) ? neighborTruncated : null;
    if (!target) continue;
    for (const v of buildings[i].verts) {
      if (r === root) clusterVerts.push(v);
      if (v.lat >= fetchedRect.north - marginLat) target.add("north");
      if (v.lat <= fetchedRect.south + marginLat) target.add("south");
      if (v.lng >= fetchedRect.east - marginLng) target.add("east");
      if (v.lng <= fetchedRect.west + marginLng) target.add("west");
    }
  }

  const userB = buildings[nearestIdx];
  const bow = bowGaps(
    clusterVerts,
    center,
    perDegLat,
    perDegLng,
    (userB.minX + userB.maxX) / 2,
    (userB.minY + userB.maxY) / 2
  );
  // The section square never exceeds the actual cluster extent (cells
  // are 200 m quanta).
  const sectionBounds = bow?.sectionBounds
    ? rectIntersect(bow.sectionBounds, bounds)
    : null;

  return {
    bounds,
    hull: convexHull(clusterVerts).map((v) => ({ lat: v.lat, lng: v.lng })),
    clusterSize: userCB.count,
    totalBuildings: N,
    nearestBuildingM: nearestDist,
    truncatedSides: [...truncated],
    neighborTruncatedSides: [...neighborTruncated],
    otherCities,
    bowGapM: bow?.maxGapM ?? null,
    bowGapRects: bow?.rects ?? [],
    sectionBounds,
    clusterRings,
    neighborRings,
  };
}

interface BowGapInfo {
  maxGapM: number;
  rects: Bounds[];
  /** A conservative squared boundary limited to the legitimately
   * "fillable" area around the user (see CityDetection.sectionBounds). */
  sectionBounds: Bounds | null;
}

/** Most rectangles to highlight — enough to outline the open region
 * without flooding the map on metro-scale clusters. */
const MAX_BOW_RECTS = 80;

/**
 * Interior open stretches along cardinal lines of the cluster's
 * occupancy grid that exceed 4,000 amos — the bow-city limit on
 * squaring (Mishnah Eruvin 55a; Nesivos Shabbos 42:17). Returns the
 * largest gap and the gaps' locations as lat/lng rectangles; null when
 * the squared city has no such stretch.
 */
function bowGaps(
  clusterVerts: Vertex[],
  center: LatLng,
  perDegLat: number,
  perDegLng: number,
  userX: number,
  userY: number
): BowGapInfo | null {
  const CELL = 200;
  const LIMIT = 2 * TECHUM_M; // 4,000 amos = 1,920 m
  const occupied = new Map<number, Set<number>>(); // row (cy) -> set of cx
  const occupiedT = new Map<number, Set<number>>(); // col (cx) -> set of cy
  for (const v of clusterVerts) {
    const cx = Math.floor(v.x / CELL);
    const cy = Math.floor(v.y / CELL);
    if (!occupied.has(cy)) occupied.set(cy, new Set());
    occupied.get(cy)!.add(cx);
    if (!occupiedT.has(cx)) occupiedT.set(cx, new Set());
    occupiedT.get(cx)!.add(cy);
  }
  const toBounds = (x0: number, y0: number, x1: number, y1: number): Bounds => ({
    south: center.lat + y0 / perDegLat,
    north: center.lat + y1 / perDegLat,
    west: center.lng + x0 / perDegLng,
    east: center.lng + x1 / perDegLng,
  });
  const gaps: { gapM: number; rect: Bounds }[] = [];
  let maxGapM = 0;
  const scan = (lines: Map<number, Set<number>>, isRow: boolean) => {
    for (const [line, cellsInLine] of lines) {
      const sorted = [...cellsInLine].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const gapM = (sorted[i] - sorted[i - 1] - 1) * CELL;
        if (gapM > maxGapM) maxGapM = gapM;
        if (gapM <= LIMIT) continue;
        const a0 = (sorted[i - 1] + 1) * CELL; // gap start along the line
        const a1 = sorted[i] * CELL; // gap end along the line
        const b0 = line * CELL; // the line's own cell band
        const b1 = (line + 1) * CELL;
        gaps.push({
          gapM,
          rect: isRow ? toBounds(a0, b0, a1, b1) : toBounds(b0, a0, b1, a1),
        });
      }
    }
  };
  scan(occupied, true);
  scan(occupiedT, false);
  if (maxGapM <= LIMIT) return null;
  gaps.sort((a, b) => b.gapM - a.gapM);

  // The conservative adjusted square: "fill" open cells only where the
  // built ends flanking them are within 4,000 amos (rows, then columns,
  // then rows again), and grow the largest axis-aligned rectangle of
  // legitimately filled cells around the user. Everything in it may be
  // squared in; using it instead of the full bounding box is a
  // stringency offered when the full square fails the bow rule.
  const MAX_FILL_STEPS = Math.floor(LIMIT / CELL) + 1; // cell-index diff ≤ 10
  const filled = new Map<number, Set<number>>();
  for (const [cy, set] of occupied) filled.set(cy, new Set(set));
  const fillLines = (transpose: boolean) => {
    // Collect per-line sorted cells (rows when !transpose, else columns).
    const lines = new Map<number, number[]>();
    for (const [cy, set] of filled) {
      for (const cx of set) {
        const line = transpose ? cx : cy;
        const along = transpose ? cy : cx;
        if (!lines.has(line)) lines.set(line, []);
        lines.get(line)!.push(along);
      }
    }
    for (const [line, cells] of lines) {
      const sorted = [...new Set(cells)].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - sorted[i - 1] > MAX_FILL_STEPS) continue;
        for (let a = sorted[i - 1] + 1; a < sorted[i]; a++) {
          const cy = transpose ? a : line;
          const cx = transpose ? line : a;
          if (!filled.has(cy)) filled.set(cy, new Set());
          filled.get(cy)!.add(cx);
        }
      }
    }
  };
  fillLines(false);
  fillLines(true);
  fillLines(false);

  const isFilled = (cy: number, cx: number) => filled.get(cy)?.has(cx) ?? false;
  const ucx = Math.floor(userX / CELL);
  const ucy = Math.floor(userY / CELL);
  let sectionBounds: Bounds | null = null;
  if (isFilled(ucy, ucx)) {
    let x0 = ucx, x1 = ucx, y0 = ucy, y1 = ucy;
    let grew = true;
    while (grew) {
      grew = false;
      const colOk = (cx: number) => {
        for (let cy = y0; cy <= y1; cy++) if (!isFilled(cy, cx)) return false;
        return true;
      };
      const rowOk = (cy: number) => {
        for (let cx = x0; cx <= x1; cx++) if (!isFilled(cy, cx)) return false;
        return true;
      };
      if (colOk(x1 + 1)) { x1++; grew = true; }
      if (colOk(x0 - 1)) { x0--; grew = true; }
      if (rowOk(y1 + 1)) { y1++; grew = true; }
      if (rowOk(y0 - 1)) { y0--; grew = true; }
    }
    sectionBounds = toBounds(x0 * CELL, y0 * CELL, (x1 + 1) * CELL, (y1 + 1) * CELL);
  }

  return {
    maxGapM,
    rects: gaps.slice(0, MAX_BOW_RECTS).map((g) => g.rect),
    sectionBounds,
  };
}
