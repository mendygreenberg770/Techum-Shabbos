import { KARPEF_M, TWO_CITIES_JOIN_M } from "../halacha/shiurim";
import { metersPerDegree, type Bounds, type LatLng } from "../halacha/geometry";

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

export function detectCity(
  center: LatLng,
  buildingPolys: LatLng[][],
  fetchRadiusM: number
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
    return { verts, minX, minY, maxX, maxY };
  });

  // Spatial grid: each building is registered in every cell its bbox
  // (expanded by half the largest joining distance) overlaps, so any
  // pair within the joining distance shares at least one cell.
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
  const seen = new Set<number>();
  const N = buildings.length;
  for (const list of cells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let c = a + 1; c < list.length; c++) {
        const i = Math.min(list[a], list[c]);
        const j = Math.max(list[a], list[c]);
        const key = i * N + j;
        if (seen.has(key)) continue;
        seen.add(key);
        if (bboxGap(buildings[i], buildings[j]) > TWO_CITIES_JOIN_M) continue;
        const d = buildingDist(buildings[i], buildings[j]);
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
      if (ri !== rj && uf.size[ri] >= MIN_CITY_SIZE && uf.size[rj] >= MIN_CITY_SIZE) {
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
  const clusterVerts: Vertex[] = [];
  let clusterSize = 0;
  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  const truncated = new Set<Side>();
  const edgeMargin = TWO_CITIES_JOIN_M + 5;
  for (let i = 0; i < N; i++) {
    if (uf.find(i) !== root) continue;
    clusterSize++;
    for (const v of buildings[i].verts) {
      clusterVerts.push(v);
      north = Math.max(north, v.lat);
      south = Math.min(south, v.lat);
      east = Math.max(east, v.lng);
      west = Math.min(west, v.lng);
      if (Math.hypot(v.x, v.y) >= fetchRadiusM - edgeMargin) {
        if (Math.abs(v.x) > Math.abs(v.y)) {
          truncated.add(v.x > 0 ? "east" : "west");
        } else {
          truncated.add(v.y > 0 ? "north" : "south");
        }
      }
    }
  }

  return {
    bounds: { north, south, east, west },
    hull: convexHull(clusterVerts).map((v) => ({ lat: v.lat, lng: v.lng })),
    clusterSize,
    totalBuildings: N,
    nearestBuildingM: nearestDist,
    truncatedSides: [...truncated],
  };
}
