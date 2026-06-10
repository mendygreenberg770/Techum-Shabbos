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

  it("handles MultiPolygon geometry", async () => {
    const feature = {
      id: 9,
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[-78.866, 42.944], [-78.8659, 42.944], [-78.8659, 42.9441], [-78.866, 42.944]]],
          [[[-78.8655, 42.9445], [-78.8654, 42.9445], [-78.8654, 42.9446], [-78.8655, 42.9445]]],
        ],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ features: [feature] })));
    const result = await fetchBuildingsArcgis([rect]);
    expect(result).toHaveLength(1);
    // Bbox spans both parts.
    expect(result[0].ring[0]).toEqual({ lat: 42.944, lng: -78.866 });
    expect(result[0].ring[2]).toEqual({ lat: 42.9446, lng: -78.8654 });
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
