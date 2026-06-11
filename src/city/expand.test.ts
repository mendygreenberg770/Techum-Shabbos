import { afterEach, describe, expect, it, vi } from "vitest";
import { detectCityAuto } from "./expand";
import { clearOverpassCache } from "./overpass";
import { clearArcgisCache } from "./arcgis";
import { metersPerDegree } from "../halacha/geometry";

// Synthetic spot; buildings are placed within the initial analysis
// rectangle and far from its edges so the expansion finishes in one round.
const C = { lat: 40.7, lng: -73.95 };
const LIMITS = { maxBuildings: 1_000_000, maxSpanM: 1_000_000 };

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** An OSM way element: a ~10 m building centered at an offset (deg). */
const osmWay = (id: number, dLat: number, dLng: number) => ({
  type: "way",
  id,
  bounds: {
    minlat: C.lat + dLat,
    minlon: C.lng + dLng,
    maxlat: C.lat + dLat + 0.0001,
    maxlon: C.lng + dLng + 0.0001,
  },
});

/** An ArcGIS GeoJSON feature at an offset (deg). */
const agsFeature = (id: number, dLat: number, dLng: number) => ({
  id,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [C.lng + dLng, C.lat + dLat],
        [C.lng + dLng + 0.0001, C.lat + dLat],
        [C.lng + dLng + 0.0001, C.lat + dLat + 0.0001],
        [C.lng + dLng, C.lat + dLat],
      ],
    ],
  },
});

const isArcgis = (url: RequestInfo | URL) => String(url).includes("arcgis.com");
/** The secondary non-dirah ids query (way[building~"^(shed|…)"]). */
const isXQuery = (init?: RequestInit) =>
  String(init?.body ?? "").includes("building~");

afterEach(() => {
  vi.unstubAllGlobals();
  clearOverpassCache();
  clearArcgisCache();
});

describe("detectCityAuto: union of OSM and ArcGIS buildings", () => {
  it("joins a chain only completable with both datasets merged", () => {
    // OSM knows houses at 0 m and 60 m; ArcGIS knows the 30 m house that
    // chains them (gaps ~20 m ≤ 33.92 m only via the middle house).
    const dLng30 = 0.00036; // ≈30 m east at this latitude
    const dLng60 = 0.00072;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        isArcgis(url)
          ? okJson({ features: [agsFeature(1, 0, dLng30)] })
          : isXQuery(init)
            ? okJson({ elements: [] })
            : okJson({ elements: [osmWay(1, 0, 0), osmWay(2, 0, dLng60)] })
      )
    );
    return detectCityAuto(C, LIMITS).then((r) => {
      expect(r.source).toBe("buildings");
      expect(r.merged).toBe(true);
      expect(r.detection!.clusterSize).toBe(3);
    });
  });

  it("labels the result arcgis when OSM has nothing there", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        isArcgis(url)
          ? okJson({ features: [agsFeature(1, 0, 0), agsFeature(2, 0, 0.0003)] })
          : okJson({ elements: [] })
      )
    );
    return detectCityAuto(C, LIMITS).then((r) => {
      expect(r.source).toBe("arcgis");
      expect(r.merged).toBeUndefined();
      expect(r.detection!.clusterSize).toBe(2);
    });
  });

  it("counts a building present in both datasets once", () => {
    // The same two houses in OSM and ArcGIS (plus one ArcGIS-only):
    // duplicates must not inflate counts (they burn the analysis limit).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        isArcgis(url)
          ? okJson({
              features: [
                agsFeature(1, 0, 0),
                agsFeature(2, 0, 0.0003),
                agsFeature(3, 0, 0.0006),
              ],
            })
          : isXQuery(init)
            ? okJson({ elements: [] })
            : okJson({ elements: [osmWay(1, 0, 0), osmWay(2, 0, 0.0003)] })
      )
    );
    return detectCityAuto(C, LIMITS).then((r) => {
      expect(r.merged).toBe(true);
      expect(r.detection!.totalBuildings).toBe(3);
      expect(r.detection!.clusterSize).toBe(3);
    });
  });

  it("expands further until a clipped neighboring town is fully captured", () => {
    // Home pair at the center; a neighbor pair ~1,100 m east — inside
    // the muvla reach but within the truncation margin of the initial
    // ±1,200 m fetch area. The analysis must expand once more so the
    // neighbor isn't squared mid-town.
    const { perDegLng } = metersPerDegree(C.lat);
    const d1 = 1100 / perDegLng;
    const d2 = 1130 / perDegLng;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      isArcgis(url)
        ? okJson({ features: [] })
        : isXQuery(init)
          ? okJson({ elements: [] })
          : okJson({
              elements: [
                osmWay(1, 0, 0),
                osmWay(2, 0, 0.0003),
                osmWay(3, 0, d1),
                osmWay(4, 0, d2),
              ],
            })
    );
    vi.stubGlobal("fetch", fetchMock);
    return detectCityAuto(C, LIMITS).then((r) => {
      expect(r.capped).toBe(false);
      expect(r.detection!.otherCities).toHaveLength(1);
      expect(r.detection!.neighborTruncatedSides).toEqual([]);
      // Initial round (OSM + ArcGIS) plus at least one strip round.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("heals a transiently failing OSM round from the backlog (no data loss)", async () => {
    // Home pair at the center plus a chain reaching the east edge of
    // the initial ±1,200 m area, forcing an expansion round. The strip
    // query fails its first full failover cascade (a rate-limit blip),
    // then succeeds — the backlog retry must recover the strip's
    // building and report no dataset loss.
    // The neighbor must be BOTH within muvla reach of the home cluster
    // (so it is tracked) and within the truncation margin of the
    // ±1,200 m fetch edge (so an expansion round fires).
    const { perDegLng } = metersPerDegree(C.lat);
    const dEdge1 = 1110 / perDegLng;
    const dEdge2 = 1137 / perDegLng;
    const dStrip = 1170 / perDegLng;
    const attempts = new Map<string, number>();
    let firstBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (isArcgis(url)) return okJson({ features: [] });
        const raw = decodeURIComponent(String(init?.body ?? ""));
        if (isXQuery(init) || raw.includes("if: length()")) {
          return okJson({ elements: [] });
        }
        const body = String(init?.body ?? "");
        firstBody ??= body;
        const n = (attempts.get(body) ?? 0) + 1;
        attempts.set(body, n);
        if (body !== firstBody && n <= 10) {
          // One full cascade (2 passes x 5 endpoints) of failures.
          return new Response("rate limited", { status: 429 });
        }
        return body === firstBody
          ? okJson({
              elements: [
                osmWay(1, 0, 0),
                osmWay(2, 0, 0.0003),
                osmWay(3, 0, 0.0006),
                osmWay(4, 0, 0.0009),
                osmWay(5, 0, dEdge1),
                osmWay(6, 0, dEdge2),
              ],
            })
          : okJson({ elements: [osmWay(7, 0, dStrip)] });
      })
    );
    const r = await detectCityAuto(C, LIMITS);
    // The strip's building was recovered on a later round: all seven
    // buildings are present (home chain of four + neighbor of three).
    expect(r.detection!.totalBuildings).toBe(7);
    expect(r.detection!.clusterSize).toBe(4);
    expect(r.detection!.otherCities).toHaveLength(1);
    expect(r.lostDatasets).toBeUndefined();
    expect(r.fetchError).toBeUndefined();
  });

  it("excludes non-dwelling structures from the chain (SA 398:6) without resurrection", () => {
    // Houses at 0 m and 25 m chain; a SHED at 50 m would chain a fourth
    // house at 75 m — but a shed does not join a city, so the fourth
    // house stays a separate structure. ArcGIS also reports the shed
    // (unclassified) — its copy must not resurrect the excluded one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        isArcgis(url)
          ? okJson({ features: [agsFeature(9, 0, 0.0006)] })
          : isXQuery(init)
            ? okJson({ elements: [{ type: "way", id: 3 }] })
            : okJson({
                elements: [
                  osmWay(1, 0, 0),
                  osmWay(2, 0, 0.0003),
                  osmWay(3, 0, 0.0006), // the shed
                  osmWay(4, 0, 0.0009),
                ],
              })
      )
    );
    return detectCityAuto(C, LIMITS).then((r) => {
      expect(r.excludedCount).toBe(1);
      expect(r.detection!.totalBuildings).toBe(3); // shed not counted
      expect(r.detection!.clusterSize).toBe(2); // chain broken at the shed
    });
  });

  it("keeps working when ArcGIS is down (OSM only, not merged)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        isArcgis(url)
          ? new Response("nope", { status: 503 })
          : isXQuery(init)
            ? okJson({ elements: [] })
            : okJson({ elements: [osmWay(1, 0, 0), osmWay(2, 0, 0.0003)] })
      )
    );
    return detectCityAuto(C, LIMITS).then((r) => {
      expect(r.source).toBe("buildings");
      expect(r.merged).toBeUndefined();
      expect(r.detection!.clusterSize).toBe(2);
    });
  });
});
