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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearOverpassCache();
});

describe("fetchBuildingsInRect", () => {
  it("parses building bounding boxes into rings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ elements: [building] })));
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(7);
    expect(result[0].ring).toHaveLength(4);
    expect(result[0].ring[0]).toEqual({ lat: 40.661, lng: -73.949 });
    expect(result[0].ring[2]).toEqual({ lat: 40.662, lng: -73.948 });
  });

  it("treats a 200 response with a runtime-error remark as a failure and fails over", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("overpass-api.de")
        ? okJson({
            elements: [],
            remark: "runtime error: Query timed out in “query” at line 1.",
          })
        : okJson({ elements: [building] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
  });

  it("fails over on HTTP errors (rate limit)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1 ? new Response("rate limited", { status: 429 }) : okJson({ elements: [building] })
      )
    );
    const result = await fetchBuildingsInRect(rect);
    expect(result).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("fails over on malformed responses", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++calls === 1 ? okJson({ nonsense: true }) : okJson({ elements: [] })))
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
    // 2 passes over 4 endpoints (3 public + the same-origin proxy)
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("serves repeated identical queries from the cache (retry resumes)", async () => {
    const fetchMock = vi.fn(async () => okJson({ elements: [building] }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchBuildingsInRect(rect);
    const second = await fetchBuildingsInRect(rect);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches several rectangles as a single union query", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        body = decodeURIComponent(String(init?.body));
        return okJson({ elements: [building] });
      })
    );
    const other = { north: 40.7, south: 40.69, east: -73.9, west: -73.91 };
    await fetchBuildingsInRects([rect, other]);
    expect(body.match(/way\[building\]/g)).toHaveLength(2);
    expect(body).toContain("(way[building]");
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
        bodies.push(String(init?.body));
        return okJson({ elements: [] });
      })
    );
    await fetchBuildingsInRect(rect);
    await fetchSettledAreasInRect(rect);
    expect(decodeURIComponent(bodies[0])).toContain("way[building]");
    expect(decodeURIComponent(bodies[1])).toContain("landuse");
    expect(decodeURIComponent(bodies[1])).toContain("residential");
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
