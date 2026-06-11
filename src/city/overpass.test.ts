import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOverpassCache,
  fetchBuildingsInRect,
  fetchBuildingsInRects,
  fetchSettledAreasInRect,
} from "./overpass";

const rect = { north: 40.67, south: 40.66, east: -73.94, west: -73.95 };

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const building = {
  type: "way",
  id: 7,
  bounds: { minlat: 40.661, minlon: -73.949, maxlat: 40.662, maxlon: -73.948 },
};

/** The secondary non-dirah ids query (way[building~"^(shed|…)"]). */
const isXQuery = (init?: RequestInit) =>
  String(init?.body ?? "").includes("building~");
/** The large-structure true-outline query ((if: length() > …)). */
const isGQuery = (init?: RequestInit) =>
  decodeURIComponent(String(init?.body ?? "")).includes("if: length()");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearOverpassCache();
});

describe("fetchBuildingsInRect", () => {
  it("parses building bounding boxes into rings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        isXQuery(init) ? okJson({ elements: [] }) : okJson({ elements: [building] })
      )
    );
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(7);
    expect(result[0].nonDirah).toBeUndefined();
    expect(result[0].ring).toHaveLength(4);
    expect(result[0].ring[0]).toEqual({ lat: 40.661, lng: -73.949 });
    expect(result[0].ring[2]).toEqual({ lat: 40.662, lng: -73.948 });
  });

  it("marks structures listed by the non-dirah query (sheds, garages…)", async () => {
    const shed = {
      type: "way",
      id: 8,
      bounds: { minlat: 40.663, minlon: -73.947, maxlat: 40.6635, maxlon: -73.9465 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        isXQuery(init)
          ? okJson({ elements: [{ type: "way", id: 8 }] })
          : okJson({ elements: [building, shed] })
      )
    );
    const result = await fetchBuildingsInRect(rect);
    expect(result.find((b) => b.id === 7)!.nonDirah).toBeUndefined();
    expect(result.find((b) => b.id === 8)!.nonDirah).toBe(true);
  });

  it("keeps the buildings when the non-dirah query fails (benign loss)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        isXQuery(init)
          ? new Response("boom", { status: 504 })
          : okJson({ elements: [building] })
      )
    );
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
    expect(result[0].nonDirah).toBeUndefined();
  });

  it("treats a 200 response with a runtime-error remark as a failure and fails over", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (isXQuery(init)) return okJson({ elements: [] });
      return String(url).includes("overpass-api.de")
        ? okJson({
            elements: [],
            remark: "runtime error: Query timed out in “query” at line 1.",
          })
        : okJson({ elements: [building] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
  });

  it("fails over on HTTP errors (rate limit)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (isXQuery(init) || isGQuery(init)) return okJson({ elements: [] });
        return ++calls === 1
          ? new Response("rate limited", { status: 429 })
          : okJson({ elements: [building] });
      })
    );
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("fails over on malformed responses", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (isXQuery(init) || isGQuery(init)) return okJson({ elements: [] });
        return ++calls === 1 ? okJson({ nonsense: true }) : okJson({ elements: [] });
      })
    );
    await expect(fetchBuildingsInRect(rect)).resolves.toEqual([]);
  });

  it("throws after every endpoint fails on both passes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("boom", { status: 504 }));
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(fetchBuildingsInRect(rect)).rejects.toThrow("HTTP 504");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    // 2 passes over 5 endpoints, for the building, non-dirah, and
    // large-geometry queries (all run concurrently).
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it("serves repeated identical queries from the cache (retry resumes)", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      isXQuery(init) ? okJson({ elements: [] }) : okJson({ elements: [building] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchBuildingsInRect(rect);
    const second = await fetchBuildingsInRect(rect);
    expect(second).toEqual(first);
    // Building + non-dirah + large-geometry queries; repeats cached.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fetches several rectangles as a single union query", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (!isXQuery(init)) body = decodeURIComponent(String(init?.body));
        return okJson({ elements: [building] });
      })
    );
    const other = { north: 40.7, south: 40.69, east: -73.9, west: -73.91 };
    await fetchBuildingsInRects([rect, other]);
    expect(body.match(/way\[building\]/g)).toHaveLength(2);
    expect(body).toContain("(way[building]");
  });

  it("uses the true outline for large structures instead of the bbox", async () => {
    // The large-geometry query returns the same way (id 7) with its
    // actual L-shaped outline — the building's ring must be the
    // outline, not the 4-corner bounding box.
    const geomWay = {
      type: "way",
      id: 7,
      geometry: [
        { lat: 40.661, lon: -73.949 },
        { lat: 40.661, lon: -73.948 },
        { lat: 40.6615, lon: -73.948 },
        { lat: 40.6615, lon: -73.9485 },
        { lat: 40.662, lon: -73.9485 },
        { lat: 40.662, lon: -73.949 },
        { lat: 40.661, lon: -73.949 },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (isGQuery(init)) return okJson({ elements: [geomWay] });
        if (isXQuery(init)) return okJson({ elements: [] });
        return okJson({ elements: [building] });
      })
    );
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
    expect(result[0].ring).toHaveLength(6); // L-shape, closing node dropped
  });

  it("parses settled-area polygons, dropping the closing node", async () => {
    const way = {
      type: "way",
      id: 11,
      geometry: [
        { lat: 40.66, lon: -73.95 },
        { lat: 40.66, lon: -73.94 },
        { lat: 40.67, lon: -73.94 },
        { lat: 40.66, lon: -73.95 },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ elements: [way] })));
    const result = await fetchSettledAreasInRect(rect);
    expect(result).toHaveLength(1);
    expect(result[0].ring).toHaveLength(3);
    expect(result[0].ring[0]).toEqual({ lat: 40.66, lng: -73.95 });
  });

  it("queries landuse for settled areas and building for buildings", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(decodeURIComponent(String(init?.body)));
        return okJson({ elements: [] });
      })
    );
    await fetchBuildingsInRect(rect);
    await fetchSettledAreasInRect(rect);
    expect(bodies[0]).toContain("way[building](");
    expect(bodies[1]).toContain("building~"); // the non-dirah ids query
    expect(bodies[1]).toContain("shed");
    expect(bodies[2]).toContain("if: length()"); // large-structure outlines
    expect(bodies[3]).toContain("landuse");
    expect(bodies[3]).toContain("residential");
  });

  it("stops immediately when aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      // Simulate fetch honoring the (now aborted) signal.
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return okJson({ elements: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchBuildingsInRect(rect, controller.signal)).rejects.toThrow();
    // Each of the three concurrent queries starts at most once before
    // the abort propagates.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
