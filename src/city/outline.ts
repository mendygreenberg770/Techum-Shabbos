import { metersPerDegree, type LatLng } from "../halacha/geometry";

/**
 * Accurate (concave) outline of a set of building footprints: each
 * footprint's bounding rectangle is dilated by `bufferM` and rasterized
 * onto a grid; the boundary of the union is then traced into closed
 * rings. With `bufferM` = half the joining distance, two buildings that
 * halachically join (gap within 70 2/3 amos) become one connected blob,
 * so the outline shows the true chained shape of the city — concave
 * where the city is concave, and excluding everything beyond the
 * joining distance.
 *
 * Holes (enclosed courtyards/parks) are dropped: enclosed open space
 * inside the city is part of it for techum purposes.
 */

/** Hard cap on grid dimensions; cell size grows for larger areas. */
const MAX_CELLS = 1400;
const MIN_CELL_M = 5;

export function unionOutline(rings: LatLng[][], bufferM: number): LatLng[][] {
  if (rings.length === 0) return [];

  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      north = Math.max(north, p.lat);
      south = Math.min(south, p.lat);
      east = Math.max(east, p.lng);
      west = Math.min(west, p.lng);
    }
  }
  const refLat = (north + south) / 2;
  const refLng = (east + west) / 2;
  const { perDegLat, perDegLng } = metersPerDegree(refLat);
  const spanX = (east - west) * perDegLng + 2 * bufferM;
  const spanY = (north - south) * perDegLat + 2 * bufferM;
  const cell = Math.max(MIN_CELL_M, Math.max(spanX, spanY) / MAX_CELLS);

  // Grid origin: one empty border cell around everything so boundary
  // tracing never runs off the edge.
  const originX = (west - refLng) * perDegLng - bufferM - cell;
  const originY = (south - refLat) * perDegLat - bufferM - cell;
  const W = Math.ceil(spanX / cell) + 2;
  const H = Math.ceil(spanY / cell) + 2;
  const grid = new Uint8Array(W * H);

  for (const ring of rings) {
    let n = -Infinity, s = Infinity, e = -Infinity, w = Infinity;
    for (const p of ring) {
      n = Math.max(n, p.lat);
      s = Math.min(s, p.lat);
      e = Math.max(e, p.lng);
      w = Math.min(w, p.lng);
    }
    const x0 = Math.max(0, Math.floor(((w - refLng) * perDegLng - bufferM - originX) / cell));
    const x1 = Math.min(W - 1, Math.floor(((e - refLng) * perDegLng + bufferM - originX) / cell));
    const y0 = Math.max(0, Math.floor(((s - refLat) * perDegLat - bufferM - originY) / cell));
    const y1 = Math.min(H - 1, Math.floor(((n - refLat) * perDegLat + bufferM - originY) / cell));
    for (let y = y0; y <= y1; y++) {
      grid.fill(1, y * W + x0, y * W + x1 + 1);
    }
  }

  // Directed boundary edges along cell sides, interior kept on the
  // left: outer rings come out counterclockwise, holes clockwise.
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === 1;
  const edges = new Map<number, number[]>(); // startPoint -> endPoints
  const key = (x: number, y: number) => y * (W + 1) + x;
  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    let list = edges.get(k);
    if (!list) {
      list = [];
      edges.set(k, list);
    }
    list.push(key(x1, y1));
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) addEdge(x, y, x + 1, y); // bottom, walk east
      if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // right, walk north
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1); // top, walk west
      if (!filled(x - 1, y)) addEdge(x, y + 1, x, y); // left, walk south
    }
  }

  // Chain edges into closed loops.
  const loops: number[][] = [];
  for (const [start] of edges) {
    let list = edges.get(start);
    while (list && list.length > 0) {
      const loop: number[] = [start];
      let current = list.pop()!;
      while (current !== start) {
        loop.push(current);
        const nexts = edges.get(current);
        if (!nexts || nexts.length === 0) break; // defensive: open chain
        current = nexts.pop()!;
      }
      if (current === start) loops.push(loop);
      list = edges.get(start);
    }
  }

  const out: LatLng[][] = [];
  for (const loop of loops) {
    // Merge collinear runs (rectilinear: same direction as previous).
    const pts: { x: number; y: number }[] = loop.map((k) => ({
      x: k % (W + 1),
      y: Math.floor(k / (W + 1)),
    }));
    const simplified: { x: number; y: number }[] = [];
    const m = pts.length;
    for (let i = 0; i < m; i++) {
      const prev = pts[(i - 1 + m) % m];
      const cur = pts[i];
      const next = pts[(i + 1) % m];
      const d1x = Math.sign(cur.x - prev.x);
      const d1y = Math.sign(cur.y - prev.y);
      const d2x = Math.sign(next.x - cur.x);
      const d2y = Math.sign(next.y - cur.y);
      if (d1x !== d2x || d1y !== d2y) simplified.push(cur);
    }
    if (simplified.length < 4) continue;
    // Shoelace: holes are clockwise (negative area) — drop them.
    let area2 = 0;
    for (let i = 0; i < simplified.length; i++) {
      const a = simplified[i];
      const b = simplified[(i + 1) % simplified.length];
      area2 += a.x * b.y - b.x * a.y;
    }
    if (area2 <= 0) continue;
    out.push(
      simplified.map((p) => ({
        lat: refLat + (originY + p.y * cell) / perDegLat,
        lng: refLng + (originX + p.x * cell) / perDegLng,
      }))
    );
  }
  // Largest first, so capped rendering keeps the main mass.
  return out.sort((a, b) => b.length - a.length);
}
