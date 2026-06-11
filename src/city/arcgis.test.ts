import { afterEach, describe, expect, it, vi } from "vitest";
import { clearArcgisCache, fetchBuildingsArcgis } from "./arcgis";

const rect = { north: 42.95, south: 42.94, east: -78.86, west: -78.87 };

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const polygonFeature = (id: number, lng: number, lat: number, s = 0.0001) => ({
  id,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [lng, lat],
        [lng + s, lat],
        [lng + s, lat + s],
        [lng, lat + s],
        [lng, lat],
      ],
    ],
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearArcgisCache();
});

describe("fetchBuildingsArcgis", () => {
  it("parses polygon features into bbox rings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ type: "FeatureCollection", features: [polygonFeature(5, -78.866, 42.944)] }))
    );
    const result = await fetchBuildingsArcgis([rect]);
    expect(result).toHaveLength(1);
    expect(result[0].ring).toHaveLength(4);
    expect(result[0].ring[0]).toEqual({ lat: 42.944, lng: -78.866 });
    expect(result[0].ring[2].lat).toBeCloseTo(42.9441, 6);
  });

  it("handles small MultiPolygon geometry as a combined bbox", async () => {
    const feature = {
      id: 9,
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[-78.866, 42.944], [-78.8659, 42.944], [-78.8659, 42.9441], [-78.866, 42.944]]],
          [[[-78.86585, 42.94415], [-78.86575, 42.94415], [-78.86575, 42.94425], [-78.86585, 42.94415]]],
        ],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ features: [feature] })));
    const result = await fetchBuildingsArcgis([rect]);
    expect(result).toHaveLength(1);
    // Small structure (≤35 m): bbox spans both parts.
    expect(result[0].ring).toHaveLength(4);
    expect(result[0].ring[0]).toEqual({ lat: 42.944, lng: -78.866 });
    expect(result[0].ring[2]).toEqual({ lat: 42.94425, lng: -78.86575 });
  });

  it("keeps the true outline for large structures (diagonal towers)", async () => {
    // A thin diagonal tower ~100 m long: the bbox would cover a square
    // far larger than the building — the actual outline must be kept.
    const tower = {
      id: 12,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-78.866, 42.944],
            [-78.8659, 42.944],
            [-78.8649, 42.9449],
            [-78.865, 42.9449],
            [-78.866, 42.944],
          ],
        ],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ features: [tower] })));
    const result = await fetchBuildingsArcgis([rect]);
    expect(result).toHaveLength(1);
    expect(result[0].ring).toHaveLength(4); // the real diagonal quad…
    // …not an axis-aligned box: some vertex is NOT on the bbox corner grid.
    const lats = result[0].ring.map((p) => p.lat);
    const lngs = result[0].ring.map((p) => p.lng);
    const axisAligned = result[0].ring.every(
      (p) =>
        (p.lat === Math.min(...lats) || p.lat === Math.max(...lats)) &&
        (p.lng === Math.min(...lngs) || p.lng === Math.max(...lngs))
    );
    expect(axisAligned).toBe(false);
  });

  it("paginates while the transfer limit is exceeded", async () => {
    const offsets: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        offsets.push(new URL(String(url)).searchParams.get("resultOffset")!);
        call++;
        return call === 1
          ? okJson({
              features: [polygonFeature(1, -78.866, 42.944)],
              properties: { exceededTransferLimit: true },
            })
          : okJson({ features: [polygonFeature(2, -78.865, 42.945)] });
      })
    );
    const result = await fetchBuildingsArcgis([rect]);
    expect(result).toHaveLength(2);
    expect(offsets).toEqual(["0", "2000"]);
  });

  it("fails over to the second layer on HTTP and Esri-style errors", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) return okJson({ error: { message: "Invalid query" } });
        return okJson({ features: [polygonFeature(3, -78.866, 42.944)] });
      })
    );
    const result = await fetchBuildingsArcgis([rect]);
    expect(result).toHaveLength(1);
    expect(call).toBe(2);
  });

  it("marks Agriculture / Utility and Misc structures as non-dirah", async () => {
    const classed = (id: number, occ: string | undefined, dLng: number) => ({
      ...polygonFeature(id, -78.866 + dLng, 42.944),
      properties: occ ? { OCC_CLS: occ } : undefined,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okJson({
          features: [
            classed(1, "Residential", 0),
            classed(2, "Agriculture", 0.001),
            classed(3, "Utility and Misc", 0.002),
            classed(4, "Commercial", 0.003),
            classed(5, undefined, 0.004),
          ],
        })
      )
    );
    const result = await fetchBuildingsArcgis([rect]);
    const byEnd = (id: number) => result.find((b) => String(b.id).endsWith(`:${id}`))!;
    expect(byEnd(1).nonDirah).toBeUndefined();
    expect(byEnd(2).nonDirah).toBe(true);
    expect(byEnd(3).nonDirah).toBe(true);
    expect(byEnd(4).nonDirah).toBeUndefined(); // ambiguous — stays counted
    expect(byEnd(5).nonDirah).toBeUndefined();
  });

  it("returns empty outside US coverage rather than failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ features: [] })));
    await expect(fetchBuildingsArcgis([rect])).resolves.toEqual([]);
  });

  it("queries with a 4326 envelope of the requested rectangle", async () => {
    let captured = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        captured = String(url);
        return okJson({ features: [] });
      })
    );
    await fetchBuildingsArcgis([rect]);
    const params = new URL(captured).searchParams;
    expect(params.get("geometry")).toBe("-78.87,42.94,-78.86,42.95");
    expect(params.get("inSR")).toBe("4326");
    expect(params.get("f")).toBe("geojson");
  });
});
