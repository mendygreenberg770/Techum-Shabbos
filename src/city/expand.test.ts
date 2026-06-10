import { afterEach, describe, expect, it, vi } from "vitest";
import { detectCityAuto } from "./expand";
import { clearOverpassCache } from "./overpass";
import { clearArcgisCache } from "./arcgis";

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
      vi.fn(async (url: RequestInfo | URL) =>
        isArcgis(url)
          ? okJson({ features: [agsFeature(1, 0, dLng30)] })
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

  it("keeps working when ArcGIS is down (OSM only, not merged)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        isArcgis(url)
          ? new Response("nope", { status: 503 })
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
