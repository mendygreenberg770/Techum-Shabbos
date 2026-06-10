import { useEffect, useMemo, useRef, useState } from "react";
import KeySetup from "./components/KeySetup";
import MapView from "./components/MapView";
import SearchBox from "./components/SearchBox";
import SavedLocations from "./components/SavedLocations";
import EruvChecklist from "./components/EruvChecklist";
import BeyondTechumNotes from "./components/BeyondTechumNotes";
import ExplainPanel from "./components/ExplainPanel";
import type { CityDetection } from "./city/cluster";
import { detectCityAuto, type CitySource, type ExpandProgress } from "./city/expand";
import {
  bearingDeg,
  diamondContains,
  diamondRing,
  distanceToRectM,
  hostTownCandidates,
  placeEruv,
  planEruv,
  rotatedFeasible,
  roundedRectRing,
} from "./halacha/eruv";
import { computeMuvlaBumps, kalsaCities, mergeCities } from "./halacha/muvla";
import {
  distanceMeters,
  expandBounds,
  metersPerDegree,
  pointBounds,
  rectUnion,
  techumFromPoint,
  type Bounds,
  type LatLng,
} from "./halacha/geometry";
import {
  AMAH_M,
  KARPEF_M,
  TECHUM_AMOS,
  TECHUM_CORNER_M,
  TECHUM_M,
} from "./halacha/shiurim";
import { loadGoogleMaps, onAuthFailure } from "./maps/loader";
import type { SelectedPlace } from "./maps/geocode";
import {
  buildShareHash,
  parseShareHash,
  type AppSnapshot,
  type LimitKey,
  type Mode,
} from "./state/share";

const STORAGE_KEY = "techum.gmapsApiKey";
// No key is committed to the repo. Supply it at build time
// (VITE_GOOGLE_MAPS_API_KEY — e.g. a Vercel environment variable) or
// paste one into the setup screen (stored in this browser only). A Maps
// JavaScript key is necessarily visible in the served bundle; its real
// protection is the HTTP-referrer and API restrictions in the Google
// Cloud console, plus quota caps.
const ENV_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || null;

/** Beyond this distance from the nearest building, treat the address
 * as a lone dwelling rather than part of the detected cluster. */
const LONE_DWELLING_CUTOFF_M = 100;

const LIMITS: Record<LimitKey, { maxBuildings: number; maxSpanM: number }> = {
  town: { maxBuildings: 60_000, maxSpanM: 12_000 },
  city: { maxBuildings: 250_000, maxSpanM: 30_000 },
  metro: { maxBuildings: 600_000, maxSpanM: 60_000 },
};

interface CityState {
  status: "idle" | "loading" | "done" | "error";
  detection?: CityDetection;
  capped?: boolean;
  error?: string;
  /** Building data stopped loading partway — result may be incomplete. */
  fetchError?: string;
  /** What the outline was built from (settled-area outlines are a
   * coarser fallback where OSM has no buildings mapped). */
  source?: CitySource;
  /** Both OSM and the US footprints contributed buildings (union). */
  merged?: boolean;
}

interface EruvCityState {
  status: "idle" | "loading" | "done" | "error";
  detection?: CityDetection;
  error?: string;
  source?: CitySource;
}

/** A cluster must have at least this many buildings to count as a town
 * (matches MIN_CITY_SIZE in the cluster engine — a working assumption). */
const MIN_TOWN_BUILDINGS = 2;

const fmtAmos = (m: number) => Math.round(m / AMAH_M).toLocaleString();

/** When this deployment was built, in US Eastern time (EDT/EST). */
function formatBuildTime(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(__BUILD_TIME__));
}

export default function App() {
  // Changing the key always goes through a page reload (the Maps script
  // can only be loaded once per page), so this never needs a setter.
  const [apiKey] = useState<string | null>(
    () => ENV_KEY ?? localStorage.getItem(STORAGE_KEY)
  );
  const [authFailed, setAuthFailed] = useState(false);
  const [mapsReady, setMapsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // A shared link carries the whole view in the URL hash — restore it.
  const [initial] = useState<AppSnapshot | null>(() =>
    parseShareHash(window.location.hash)
  );

  const [place, setPlace] = useState<SelectedPlace | null>(initial?.place ?? null);
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "city");
  const [limitKey, setLimitKey] = useState<LimitKey>(initial?.limit ?? "city");
  const [karpefOn, setKarpefOn] = useState(initial?.karpef ?? false);
  const [adjusting, setAdjusting] = useState(false);
  const [manualCityBounds, setManualCityBounds] = useState<Bounds | null>(null);
  const [cityState, setCityState] = useState<CityState>({ status: "idle" });
  const [progress, setProgress] = useState<ExpandProgress | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showRadiusCircle, setShowRadiusCircle] = useState(false);

  const [eruvOn, setEruvOn] = useState(!!initial?.eruv);
  const [destination, setDestination] = useState<SelectedPlace | null>(
    initial?.eruv?.destination ?? null
  );
  const [eruvSpot, setEruvSpot] = useState<LatLng | null>(null);
  const [rotationOn, setRotationOn] = useState(initial?.eruv?.rotationOn ?? false);
  const [rotationOffset, setRotationOffset] = useState(0);
  const [eruvCityState, setEruvCityState] = useState<EruvCityState>({ status: "idle" });
  const [eruvRetryNonce, setEruvRetryNonce] = useState(0);

  // Restoring a snapshot (shared link or saved location) must survive the
  // reset effects below, which clear the manual boundary and eiruv spot
  // whenever the place/destination changes: the values to restore are
  // parked here and consumed by those effects instead of resetting.
  const pendingManualRef = useRef<Bounds | null>(initial?.manualCity ?? null);
  const pendingEruvRef = useRef<{ spot: LatLng | null; rotationOffset: number } | null>(
    initial?.eruv ? { spot: initial.eruv.spot, rotationOffset: initial.eruv.rotationOffset } : null
  );
  const [restoreNonce, setRestoreNonce] = useState(0);

  const applySnapshot = (snap: AppSnapshot) => {
    pendingManualRef.current = snap.manualCity;
    pendingEruvRef.current = snap.eruv
      ? { spot: snap.eruv.spot, rotationOffset: snap.eruv.rotationOffset }
      : null;
    setPlace(snap.place);
    setMode(snap.mode);
    setLimitKey(snap.limit);
    setKarpefOn(snap.karpef);
    setEruvOn(!!snap.eruv);
    setDestination(snap.eruv?.destination ?? null);
    setRotationOn(snap.eruv?.rotationOn ?? false);
    // Forces the reset effects below to consume the pending values even
    // when the snapshot matches the current place/destination.
    setRestoreNonce((n) => n + 1);
  };

  useEffect(() => {
    if (!apiKey) return;
    onAuthFailure(() => {
      localStorage.removeItem(STORAGE_KEY);
      setAuthFailed(true);
    });
    loadGoogleMaps(apiKey)
      .then(() => setMapsReady(true))
      .catch(() => setLoadError("Could not load Google Maps — check your connection."));
  }, [apiKey]);

  // A new place/mode/limit invalidates the manual city boundary (or, when
  // restoring a snapshot, applies the restored one). Guarded by a dep key:
  // StrictMode re-runs the effect with identical deps, which must not
  // consume the pending value twice.
  const manualResetKey = useRef<string>();
  useEffect(() => {
    const key = JSON.stringify([place?.location, mode, limitKey, retryNonce, restoreNonce]);
    if (manualResetKey.current === key) return;
    manualResetKey.current = key;
    setManualCityBounds(pendingManualRef.current);
    pendingManualRef.current = null;
    setAdjusting(false);
  }, [place, mode, limitKey, retryNonce, restoreNonce]);

  // City analysis: fetch building footprints, expanding the analyzed
  // area until the whole contiguous city is captured or a limit is hit.
  useEffect(() => {
    setProgress(null);
    if (!place || mode !== "city") {
      setCityState({ status: "idle" });
      return;
    }
    let cancelled = false;
    // Aborting stale requests matters beyond cleanliness: abandoned
    // Overpass queries keep occupying the server's per-IP slots and
    // get subsequent requests rate-limited.
    const controller = new AbortController();
    setCityState({ status: "loading" });
    detectCityAuto(
      place.location,
      LIMITS[limitKey],
      (p) => {
        if (!cancelled) setProgress(p);
      },
      () => cancelled,
      controller.signal
    )
      .then((result) => {
        if (cancelled) return;
        setCityState({
          status: "done",
          detection: result.detection ?? undefined,
          capped: result.capped,
          fetchError: result.fetchError,
          source: result.source,
          merged: result.merged,
        });
        setProgress(null);
      })
      .catch((e) => {
        if (!cancelled) {
          setCityState({
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
          setProgress(null);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [place, mode, limitKey, retryNonce]);

  // A new home/destination invalidates the chosen eiruv spot (or, when
  // restoring a snapshot, applies the restored one). Same StrictMode
  // guard as the manual-boundary reset above.
  const eruvResetKey = useRef<string>();
  useEffect(() => {
    const key = JSON.stringify([place?.location, destination?.location, mode, restoreNonce]);
    if (eruvResetKey.current === key) return;
    eruvResetKey.current = key;
    setEruvSpot(pendingEruvRef.current?.spot ?? null);
    setRotationOffset(pendingEruvRef.current?.rotationOffset ?? 0);
    pendingEruvRef.current = null;
  }, [place, destination, mode, restoreNonce]);

  // The town situation around the eiruv spot: an eiruv resting inside a
  // town (or its ibur margin) extends the techum from that whole town's
  // squared edge (SA HaRav 408), and towns swallowed by the new techum
  // count as 4 amos — so the city around the spot must be detected too.
  // Debounced: the marker is draggable.
  useEffect(() => {
    if (!eruvOn || !eruvSpot) {
      setEruvCityState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setEruvCityState({ status: "loading" });
    const timer = window.setTimeout(() => {
      detectCityAuto(
        eruvSpot,
        LIMITS[limitKey],
        undefined,
        () => cancelled,
        controller.signal
      )
        .then((result) => {
          if (!cancelled) {
            setEruvCityState({
              status: "done",
              detection: result.detection ?? undefined,
              source: result.source,
            });
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setEruvCityState({
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            });
          }
        });
    }, 400);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [eruvOn, eruvSpot, limitKey, eruvRetryNonce]);

  // Keep the URL hash in sync with the view, so the address bar is
  // always a shareable link to exactly what is on screen.
  const snapshot = useMemo<AppSnapshot | null>(() => {
    if (!place) return null;
    return {
      v: 1,
      place,
      mode,
      limit: limitKey,
      karpef: karpefOn,
      manualCity: manualCityBounds,
      eruv:
        eruvOn && destination
          ? { destination, spot: eruvSpot, rotationOn, rotationOffset }
          : null,
    };
  }, [place, mode, limitKey, karpefOn, manualCityBounds, eruvOn, destination, eruvSpot, rotationOn, rotationOffset]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = snapshot ? buildShareHash(snapshot) : "";
    window.history.replaceState(null, "", url);
  }, [snapshot]);

  const detection =
    cityState.status === "done" &&
    cityState.detection &&
    cityState.detection.nearestBuildingM <= LONE_DWELLING_CUTOFF_M
      ? cityState.detection
      : null;
  const noCityFound = cityState.status === "done" && !detection;

  const cityBounds = manualCityBounds ?? detection?.bounds ?? null;
  const usingCity = mode === "city" && cityBounds !== null;
  // While the city is being analyzed, no techum is drawn at all — a
  // point-based line shown in the meantime would understate the real
  // techum and invite reliance on the wrong boundary.
  const cityLoading =
    mode === "city" &&
    place !== null &&
    cityState.status !== "done" &&
    cityState.status !== "error";
  // The eiruv-spot analysis must settle (or fail → bare-point fallback,
  // a stringency) before the new techum is drawn.
  const eruvCityResolved =
    eruvCityState.status === "done" || eruvCityState.status === "error";
  const eruvCityChecking = eruvCityState.status === "loading";

  const view = useMemo(() => {
    if (!place || cityLoading) return null;
    const otherCities = detection?.otherCities ?? [];
    const base =
      usingCity && cityBounds
        ? karpefOn
          ? expandBounds(cityBounds, KARPEF_M)
          : cityBounds
        : pointBounds(place.location);
    const techum = expandBounds(base, TECHUM_M);
    const bumps =
      usingCity && cityBounds
        ? computeMuvlaBumps(base, techum, otherCities, undefined, cityBounds)
        : [];
    const altTechum =
      usingCity && cityBounds
        ? expandBounds(
            karpefOn ? cityBounds : expandBounds(cityBounds, KARPEF_M),
            TECHUM_M
          )
        : null;

    // Kalsa midaso: neighboring cities the techum line (base square or
    // a muvla extension) ends inside of — one may walk only up to the
    // line there; no 4-amos credit. A chain-credited city is excluded:
    // it is reachable in full, so it must not also be painted red.
    const partialCities = usingCity ? kalsaCities(techum, bumps, otherCities) : [];

    const plan =
      eruvOn && destination ? planEruv(techum, bumps, destination.location) : null;
    // Towns detected around the eiruv spot (host town + neighbors for
    // the muvla din), merged with the home-side list; the home city
    // stays first so the "eiruv inside your own town" check keeps its
    // identity.
    const eruvDetection =
      eruvCityState.status === "done" ? eruvCityState.detection : undefined;
    const eruvCities = eruvDetection
      ? [
          ...(eruvDetection.clusterSize >= MIN_TOWN_BUILDINGS
            ? [eruvDetection.bounds]
            : []),
          ...eruvDetection.otherCities,
        ]
      : [];
    const allCities = mergeCities(
      usingCity && cityBounds ? [cityBounds, ...otherCities] : otherCities,
      eruvCities
    );
    // Towns that can carry the eiruv when no bare-point placement could:
    // resting inside such a town extends the new techum from the whole
    // town's squared edge (SA HaRav 408). The placer's own town cannot
    // help (an eiruv there is a no-op).
    const hostCandidates =
      plan && !plan.destinationInHomeTechum && destination
        ? hostTownCandidates(
            techum,
            allCities.filter((c) => c !== cityBounds),
            destination.location
          )
        : [];
    const placement =
      plan && !plan.destinationInHomeTechum && destination && eruvSpot && eruvCityResolved
        ? placeEruv(
            eruvSpot,
            destination.location,
            techum,
            plan.feasibleRegion,
            allCities,
            undefined,
            // Rashi/Rama 408:1 (the common practice): the home town
            // stays accessible as 4 amos. See ExplainPanel for the
            // other opinions.
            { ramaHomeCity: usingCity ? cityBounds : null }
          )
        : null;

    // Corner-rotation kula: a personal eiruv square may be plotted to
    // one's preference, so a corner can be aimed at the destination —
    // reach extends to 2,000·√2 amos for both placing the eiruv beyond
    // the city line and the new techum around it.
    const cornerBearing = eruvSpot && destination
      ? bearingDeg(eruvSpot, destination.location) + rotationOffset
      : 0;
    const rotated =
      rotationOn && plan && !plan.destinationInHomeTechum && destination
        ? {
            placeRing: roundedRectRing(base, TECHUM_CORNER_M),
            destCircle: { center: destination.location, radiusM: TECHUM_CORNER_M },
            diamond:
              eruvSpot && diamondRing(eruvSpot, TECHUM_CORNER_M, cornerBearing),
            inFeasible: eruvSpot
              ? rotatedFeasible(eruvSpot, base, destination.location)
              : false,
            destCovered: eruvSpot
              ? diamondContains(
                  eruvSpot,
                  TECHUM_CORNER_M,
                  cornerBearing,
                  destination.location
                )
              : false,
            reachable:
              distanceToRectM(destination.location, base) <= 2 * TECHUM_CORNER_M,
          }
        : null;

    let fit = techum;
    for (const b of bumps) fit = rectUnion(fit, b.bounds);
    if (plan && destination && !plan.destinationInHomeTechum) {
      fit = rectUnion(fit, techumFromPoint(destination.location));
      if (rotated) {
        fit = rectUnion(fit, expandBounds(pointBounds(destination.location), TECHUM_CORNER_M));
        fit = rectUnion(fit, expandBounds(base, TECHUM_CORNER_M));
      }
    }
    if (placement) {
      fit = rectUnion(fit, placement.newTechum);
      for (const b of placement.newBumps) fit = rectUnion(fit, b.bounds);
    }

    return { techum, altTechum, bumps, partialCities, plan, placement, hostCandidates, rotated, fit };
  }, [place, cityLoading, usingCity, cityBounds, karpefOn, detection, eruvOn, destination, eruvSpot, eruvCityState, eruvCityResolved, rotationOn, rotationOffset]);

  if (!apiKey || authFailed) {
    return (
      <KeySetup
        authFailed={authFailed}
        onSave={(key) => {
          localStorage.setItem(STORAGE_KEY, key);
          setAuthFailed(false);
          // The Maps script can only be loaded once per page; reload to retry.
          window.location.reload();
        }}
      />
    );
  }

  const truncated = detection?.truncatedSides ?? [];
  const plan = view?.plan ?? null;
  const placement = view?.placement ?? null;
  const rotated = view?.rotated ?? null;
  const partialCities = view?.partialCities ?? [];
  const hostCandidates = view?.hostCandidates ?? [];
  const eruvReachable = !!(
    plan?.feasibleRegion ||
    (rotated && rotated.reachable) ||
    hostCandidates.length > 0
  );
  const placingEruv = !!(plan && !plan.destinationInHomeTechum && eruvReachable);
  const spotOk = rotated ? rotated.inFeasible : placement?.inFeasibleRegion ?? false;
  const destOk = rotated
    ? rotated.destCovered && rotated.inFeasible
    : placement?.destinationCovered ?? false;
  const destDistanceM =
    place && destination
      ? distanceMeters(place.location, destination.location)
      : null;

  // Per-extension numbers for the ir muvla'as explanation: how deep the
  // swallowed city is and how far the techum continues past the base line.
  const bumpDetails = (() => {
    if (!view || !place || view.bumps.length === 0) return [];
    const { perDegLat, perDegLng } = metersPerDegree(place.location.lat);
    return view.bumps.map((b) => {
      const extM =
        b.side === "east"
          ? (b.bounds.east - view.techum.east) * perDegLng
          : b.side === "west"
            ? (view.techum.west - b.bounds.west) * perDegLng
            : b.side === "north"
              ? (b.bounds.north - view.techum.north) * perDegLat
              : (view.techum.south - b.bounds.south) * perDegLat;
      const cityDepthM =
        b.side === "east" || b.side === "west"
          ? (b.city.east - b.city.west) * perDegLng
          : (b.city.north - b.city.south) * perDegLat;
      return { side: b.side, extM, cityDepthM };
    });
  })();

  return (
    <div className="layout">
      <aside className="sidebar">
        <header>
          <h1>Techum Shabbos</h1>
          <p className="subtitle">
            Shiurei Reb Chaim Naeh · Shulchan Aruch HaRav / Ketzos HaShulchan
          </p>
        </header>

        {loadError && <p className="error">{loadError}</p>}
        {mapsReady && <SearchBox onSelect={setPlace} />}
        {!mapsReady && !loadError && <p className="muted">Loading Google Maps…</p>}
        <SavedLocations snapshot={snapshot} onLoad={applySnapshot} />

        {place && (
          <section className="info">
            <p className="address">{place.address}</p>

            <div className="field">
              <span className="field-label">Measure from</span>
              <label className="radio">
                <input
                  type="radio"
                  checked={mode === "city"}
                  onChange={() => setMode("city")}
                />
                City edge (auto-detected from building data)
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={mode === "point"}
                  onChange={() => setMode("point")}
                />
                This point only (lone dwelling)
              </label>
            </div>

            {mode === "city" && (
              <>
                <div className="field">
                  <span className="field-label">Analysis limit</span>
                  <select
                    value={limitKey}
                    onChange={(e) => setLimitKey(e.target.value as LimitKey)}
                  >
                    <option value="town">Town (fast)</option>
                    <option value="city">Large city</option>
                    <option value="metro">Metropolis (slow)</option>
                  </select>
                </div>

                {cityLoading && (
                  <p className="loading">
                    <span className="spinner" />
                    <span>
                      <b>Calculating the city limits…</b>{" "}
                      {progress
                        ? `${progress.buildings.toLocaleString()} buildings so far; the city continues ${progress.expandingSides.join(", ")} — expanding the analyzed area (round ${progress.iteration}).`
                        : "Fetching buildings from OpenStreetMap (this can take a minute for a large city)."}{" "}
                      The techum will be drawn once the city boundary is
                      resolved.
                    </span>
                  </p>
                )}
                {cityState.status === "error" && (
                  <p className="error">
                    ✗ Building data failed to load ({cityState.error}), so
                    the city boundary could <b>not</b> be calculated — the
                    techum shown is only the point-based one (a stringency;
                    the real techum from the city edge extends further).{" "}
                    <button
                      className="link-button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                    >
                      Retry
                    </button>{" "}
                    {!manualCityBounds && (
                      <button
                        className="link-button"
                        onClick={() => {
                          setManualCityBounds(
                            expandBounds(pointBounds(place.location), 300)
                          );
                          setAdjusting(true);
                        }}
                      >
                        Draw the boundary manually
                      </button>
                    )}
                  </p>
                )}
                {cityState.status === "done" && cityState.fetchError && (
                  <p className="warning">
                    ⚠ Building data stopped loading partway (
                    {cityState.fetchError}) — the city boundary is based on
                    what was fetched and may be incomplete, so the techum may
                    be understated. Retry <b>resumes</b> from the data
                    already loaded.{" "}
                    <button
                      className="link-button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {cityState.status === "done" &&
                  !cityState.fetchError &&
                  cityState.merged && (
                    <p className="muted">
                      Building data is the <b>union</b> of OpenStreetMap and
                      the USA Structures dataset (FEMA/Microsoft, via
                      ArcGIS) — a house missing from either dataset is
                      covered by the other. (Buildings present in both are
                      counted twice in the totals; the geometry is
                      unaffected.)
                    </p>
                  )}
                {noCityFound && cityState.status === "done" && !manualCityBounds && (
                  <div className="warning">
                    ⚠ No buildings were found near this address in any
                    available dataset (OpenStreetMap buildings, the USA
                    building footprints via ArcGIS, or OSM settled-area
                    outlines), so the city could not be detected — showing
                    the stringent point-based techum instead. You can draw
                    the city boundary yourself on the map (use the
                    satellite view to trace the built-up edge), or retry
                    the data fetch.
                    <div className="saved-actions" style={{ marginTop: 8 }}>
                      <button
                        className="mini-button"
                        onClick={() => {
                          setManualCityBounds(
                            expandBounds(pointBounds(place.location), 300)
                          );
                          setAdjusting(true);
                        }}
                      >
                        ✏ Draw the city boundary manually
                      </button>
                      <button
                        className="mini-button"
                        onClick={() => setRetryNonce((n) => n + 1)}
                      >
                        ↻ Retry
                      </button>
                    </div>
                  </div>
                )}
                {detection && cityState.source === "arcgis" && (
                  <p className="muted">
                    OpenStreetMap building data was unavailable for this
                    address — building footprints were loaded from the{" "}
                    <b>USA Structures dataset</b> (FEMA/Microsoft, via
                    ArcGIS) instead. Same clustering rules apply; US
                    coverage only.
                  </p>
                )}
                {detection && cityState.source === "areas" && (
                  <p className="warning">
                    ⚠ No individual buildings are mapped in OpenStreetMap
                    around this address. The city boundary was{" "}
                    <b>estimated from OSM residential/commercial area
                    outlines</b> — a coarser basis than building footprints.
                    Check it against the satellite imagery (adjust the
                    rectangle manually if it's off) and confirm with a rav.
                  </p>
                )}
                {detection && (
                  <p className="muted">
                    {cityState.source === "areas" ? (
                      <>
                        City estimate: {detection.clusterSize.toLocaleString()}{" "}
                        of {detection.totalBuildings.toLocaleString()} mapped
                        settled-area outlines join the city (gap ≤ 70⅔ amos,
                        cities join within 141⅓ amos).
                      </>
                    ) : (
                      <>
                        City cluster: {detection.clusterSize.toLocaleString()}{" "}
                        of {detection.totalBuildings.toLocaleString()}{" "}
                        buildings analyzed join the city (gap ≤ 70⅔ amos
                        between buildings, ≤ 141⅓ amos between cities).
                      </>
                    )}
                    {truncated.length === 0 &&
                      " The entire contiguous city was captured."}
                  </p>
                )}
                {detection && truncated.length > 0 && (
                  <p className="warning">
                    ⚠ The contiguous built-up area exceeds the analysis limit
                    — it continues on the <b>{truncated.join(", ")}</b> side
                    {truncated.length > 1 ? "s" : ""}, so the true techum
                    extends <b>further</b> there than shown. Raise the
                    analysis limit (slower) or adjust the boundary manually.
                  </p>
                )}
                {usingCity && view && view.bumps.length > 0 && (
                  <div className="success">
                    ✓ <b>Ir muvla'as</b> (SA HaRav 408:1):{" "}
                    {view.bumps.length === 1
                      ? "a neighboring city lies"
                      : `${view.bumps.length} neighboring cities lie`}{" "}
                    <i>entirely</i> within the techum (filled light blue on
                    the map). A swallowed city consumes only <b>4 amos</b> of
                    the 2,000-amah measure: the open land up to it counts in
                    full, the whole city costs just 4 amos, and the rest of
                    the measure continues past its far edge — the blue
                    extension{view.bumps.length === 1 ? "" : "s"} beyond the
                    base square show the techum actually gained:
                    <ul>
                      {bumpDetails.map((d, i) => (
                        <li key={i}>
                          To the <b>{d.side}</b>: the swallowed city
                          (≈{Math.round(d.cityDepthM).toLocaleString()} m
                          across) costs 4 amos (≈1.9 m) instead of its real
                          depth, so the techum continues ≈
                          <b>{Math.round(d.extM).toLocaleString()} m</b>{" "}
                          beyond the base 2,000-amah line.
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {usingCity &&
                  view &&
                  view.bumps.length === 0 &&
                  (detection?.otherCities.length ?? 0) > 0 && (
                    <p className="muted">
                      Ir muvla'as check (SA HaRav 408:1):{" "}
                      {detection!.otherCities.length} neighboring built-up
                      area{detection!.otherCities.length === 1 ? "" : "s"}{" "}
                      examined — none lies <i>entirely</i> within the techum,
                      so no city counts as 4 amos and the techum is not
                      extended. (A city only <i>partly</i> inside — outlined
                      red — gives no extension; within it you stop at the
                      line.)
                    </p>
                  )}
                {usingCity && detection?.bowGapM != null && (
                  <p className="warning">
                    ⚠ <b>Bow-shaped city</b> (Mishnah Eruvin 55a; Nesivos
                    Shabbos 42:17): squaring may "fill in" open land between
                    built areas only when the built ends flanking it are
                    within 4,000 amos = 1,920 m of each other. This squared
                    boundary spans open stretches up to ≈
                    {Math.round(detection.bowGapM).toLocaleString()} m wide —{" "}
                    <b>highlighted magenta on the map</b> — which squaring
                    cannot bridge. The built section on the far side of such
                    a stretch may not really be part of your techum; each
                    section may need to be squared on its own. Review with a
                    rav, and consider adjusting the boundary manually to
                    cover only the connected section where you are.
                  </p>
                )}
                {usingCity && partialCities.length > 0 && (
                  <p className="warning">
                    ⚠ The techum line ends <b>inside</b>{" "}
                    {partialCities.length === 1
                      ? "a neighboring built-up area"
                      : `${partialCities.length} neighboring built-up areas`}{" "}
                    (outlined red). You may walk only up to the line there —
                    a city counts as 4 amos only when it lies <i>entirely</i>{" "}
                    within the techum (SA HaRav 408:1).
                  </p>
                )}

                {usingCity && (
                  <>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={karpefOn}
                        onChange={(e) => setKarpefOn(e.target.checked)}
                      />
                      Add karpef (70⅔ amos ≈ {KARPEF_M.toFixed(1)} m) around
                      the city before measuring (the other view's line stays
                      visible in gray — see "How this was calculated").
                    </label>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={adjusting}
                        onChange={(e) => setAdjusting(e.target.checked)}
                      />
                      Adjust the city rectangle by hand (drag its edges on the
                      map if the detection is off)
                    </label>
                    {manualCityBounds && (
                      <button
                        className="link-button"
                        onClick={() => setManualCityBounds(null)}
                      >
                        Reset to detected boundary
                      </button>
                    )}
                  </>
                )}
              </>
            )}

            <table>
              <tbody>
                <tr>
                  <td>Basis</td>
                  <td>
                    {cityLoading
                      ? "Calculating city limits…"
                      : usingCity
                        ? manualCityBounds
                          ? "Squared city (manually adjusted)"
                          : "Squared city (detected)"
                        : "Lone dwelling (point)"}
                  </td>
                </tr>
                <tr>
                  <td>Each direction</td>
                  <td>
                    {TECHUM_AMOS.toLocaleString()} amos = {TECHUM_M} m /{" "}
                    {(TECHUM_M / 0.3048).toFixed(0)} ft
                    {usingCity && karpefOn ? ` (+ ${KARPEF_M.toFixed(1)} m karpef)` : ""}
                  </td>
                </tr>
                <tr>
                  <td>To the corner</td>
                  <td>
                    ≈ {Math.round(TECHUM_CORNER_M)} m /{" "}
                    {(TECHUM_CORNER_M / 0.3048).toFixed(0)} ft (2,000·√2 amos)
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted">
              The techum is squared to the four directions of the world (ribua
              ha'olam), so the corners extend beyond 2,000 amos.
              {mode === "point" &&
                " Point mode may understate the techum inside a built-up area, never overstate it."}
            </p>
            {mode === "point" && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showRadiusCircle}
                  onChange={(e) => setShowRadiusCircle(e.target.checked)}
                />
                Show 2,000-amah radius (before squaring, for illustration)
              </label>
            )}

            <ExplainPanel
              usingCity={usingCity}
              karpefOn={karpefOn}
              clusterSize={detection?.clusterSize}
              totalBuildings={detection?.totalBuildings}
              bumpsCount={view?.bumps.length ?? 0}
              partialsCount={partialCities.length}
              eruvOn={eruvOn}
            />

            <hr className="divider" />

            <label className="toggle toggle-strong">
              <input
                type="checkbox"
                checked={eruvOn}
                onChange={(e) => setEruvOn(e.target.checked)}
              />
              Plan an eiruv techumin (travel beyond the techum)
            </label>

            {eruvOn && (
              <div className="eruv-section">
                <div className="field">
                  <span className="field-label">Destination</span>
                  <SearchBox onSelect={setDestination} />
                </div>

                {destination && destDistanceM !== null && (
                  <>
                    <p className="muted">
                      {destination.address} — aerial distance{" "}
                      {Math.round(destDistanceM).toLocaleString()} m (
                      {fmtAmos(destDistanceM)} amos).
                    </p>

                    {plan?.destinationInHomeTechum && (
                      <p className="success">
                        ✓ The destination is already within the techum — no
                        eiruv is needed.
                      </p>
                    )}

                    {plan && !plan.destinationInHomeTechum && (
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={rotationOn}
                          onChange={(e) => setRotationOn(e.target.checked)}
                        />
                        Corner kula: aim your personal square's corner
                        ("diamond") at the destination — extends reach to
                        ≈ {Math.round(TECHUM_CORNER_M)} m in that direction
                        (see "How this was calculated"; confirm with your
                        rav).
                      </label>
                    )}

                    {plan && !plan.destinationInHomeTechum && !eruvReachable && (
                      <p className="error">
                        ✗ Out of reach: an eiruv techumin moves the techum at
                        most 2,000 amos further (
                        {rotationOn
                          ? `up to ${Math.round(2 * TECHUM_CORNER_M).toLocaleString()} m total with the corner kula`
                          : "up to 4,000 amos = 1,920 m total in one direction"}
                        ). No placement can cover this destination.
                        {!rotationOn &&
                          " You can try the corner kula above to extend the reach."}
                      </p>
                    )}

                    {placingEruv && (
                      <>
                        <p className="muted">
                          {rotationOn ? (
                            <>
                              Click on the map (or drag the green eiruv
                              marker) where the <b>yellow shapes overlap</b>:
                              within corner reach of the city line <i>and</i>{" "}
                              of the destination. The new techum is drawn as a
                              diamond aimed at the destination.
                            </>
                          ) : plan!.feasibleRegion ? (
                            <>
                              Click on the map inside the <b>yellow region</b>{" "}
                              (or drag the green eiruv marker) to choose where
                              the eiruv will rest. The yellow region is within
                              your current techum <i>and</i> close enough for
                              the new techum to cover the destination.
                              {hostCandidates.length > 0 &&
                                " Towns outlined yellow also work: an eiruv resting inside a town extends the new techum from the whole town's edge (SA HaRav 408)."}
                            </>
                          ) : (
                            <>
                              The destination is too far for an eiruv at a
                              bare point — but{" "}
                              {hostCandidates.length === 1
                                ? "a town"
                                : `${hostCandidates.length} towns`}{" "}
                              within your techum can carry it: an eiruv
                              resting inside a town (or its 70⅔-amah margin)
                              extends the new techum from the <i>whole
                              town's</i> squared edge (SA HaRav 408). Click
                              inside a <b>yellow town area</b> to place the
                              eiruv there.
                            </>
                          )}
                        </p>
                        {rotationOn && eruvSpot && (
                          <label className="field">
                            <span className="field-label">
                              Diamond rotation: {rotationOffset}° — re-aiming
                              the corner trades reach toward the destination
                              for sideways coverage (e.g., to keep your
                              walking route inside the square)
                            </span>
                            <input
                              type="range"
                              min={-45}
                              max={45}
                              value={rotationOffset}
                              onChange={(e) => setRotationOffset(Number(e.target.value))}
                            />
                          </label>
                        )}
                        {eruvSpot && !rotationOn && eruvCityChecking && (
                          <p className="loading">
                            <span className="spinner" />
                            <span>
                              Checking for a town around the eiruv spot
                              (SA HaRav 408)… The new techum will be drawn
                              when this resolves.
                            </span>
                          </p>
                        )}
                        {eruvSpot && !rotationOn && eruvCityState.status === "error" && (
                          <p className="warning">
                            ⚠ Building data around the eiruv spot failed to
                            load ({eruvCityState.error}) — the eiruv is
                            treated as a bare point (a stringency: a host
                            town would extend the new techum from its
                            edge).{" "}
                            <button
                              className="link-button"
                              onClick={() => setEruvRetryNonce((n) => n + 1)}
                            >
                              Retry
                            </button>
                          </p>
                        )}
                        {eruvSpot &&
                          !rotationOn &&
                          eruvCityState.status === "done" &&
                          eruvCityState.source === "areas" &&
                          eruvCityState.detection && (
                            <p className="warning">
                              ⚠ Towns around the eiruv spot were estimated
                              from OSM settled-area outlines (no individual
                              buildings are mapped there) — verify against
                              the satellite imagery before relying on the
                              host-town extension.
                            </p>
                          )}
                        {eruvSpot && (rotationOn || eruvCityResolved) && (
                          <>
                            {!spotOk && (
                              <p className="warning">
                                ⚠ This spot is outside the feasible region —
                                either beyond your current techum (you may not
                                reach it) or too far from the destination.
                              </p>
                            )}
                            {spotOk &&
                              (destOk ? (
                                <p className="success">
                                  ✓ With the eiruv here, the destination is
                                  within the new techum (purple).
                                  {!rotationOn &&
                                    " The red area on the home side is lost; the green area is gained."}
                                </p>
                              ) : (
                                <p className="warning">
                                  ⚠ The destination is not covered from this
                                  spot — move the eiruv closer to it.
                                </p>
                              ))}
                            {!rotationOn && placement && placement.newBumps.length > 0 && (
                              <p className="muted">
                                A city fully swallowed within the new techum
                                (e.g., your own city) counts as only 4 amos —
                                the purple techum extends beyond it
                                (SA HaRav 408:1).
                              </p>
                            )}
                            {!rotationOn && placement && !placement.hostCity && (
                              <p className="muted">
                                No town within 70⅔ amos of the eiruv spot —
                                the new techum is measured from the point
                                itself.
                              </p>
                            )}
                            {!rotationOn &&
                              placement?.hostCity &&
                              (placement.hostCity === cityBounds ? (
                                <p className="warning">
                                  ⚠ The eiruv rests inside your own town (or
                                  its 70⅔-amah margin) — there it has{" "}
                                  <b>no effect</b>; you simply keep your
                                  regular techum. Move it outside the green
                                  rectangle.
                                </p>
                              ) : (
                                <p className="muted">
                                  The eiruv rests inside a town: you are
                                  reckoned as one of its residents — the
                                  whole town is your 4 amos and the new
                                  techum extends 2,000 amos from its squared
                                  edge (SA HaRav 408).
                                </p>
                              ))}
                            {!rotationOn && placement?.ramaCity && (
                              <p className="muted">
                                Your home town remains fully accessible
                                (purple outline) even though it is not
                                entirely within the eiruv's techum — see
                                "How this was calculated" for the basis.
                              </p>
                            )}
                            <p className="muted">
                              Eiruv spot: {eruvSpot.lat.toFixed(5)},{" "}
                              {eruvSpot.lng.toFixed(5)}. The area around the
                              spot is analyzed automatically: an eiruv
                              resting inside a town extends the new techum
                              from that town's squared edge, and towns fully
                              swallowed by the new techum count as 4 amos
                              (SA HaRav 408).
                              {rotationOn &&
                                " With the corner kula, gained/lost shading and 4-amos extensions are not drawn — the diamond itself is the new techum."}
                            </p>
                          </>
                        )}
                        <EruvChecklist />
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            <details className="legend">
              <summary>Map legend</summary>
              <ul>
                <li><span className="swatch" style={{ background: "#e66100" }} /> Detected city cluster (hull)</li>
                <li><span className="swatch" style={{ background: "#26a269" }} /> Squared city</li>
                <li><span className="swatch" style={{ background: "#1a5fb4" }} /> Techum (incl. muvla extensions)</li>
                <li><span className="swatch" style={{ background: "#99c1f1" }} /> City swallowed in the techum (muvla — counts as 4 amos)</li>
                <li><span className="swatch" style={{ background: "#d4267e" }} /> Open stretch too wide to "square in" (bow-city warning)</li>
                <li><span className="swatch" style={{ background: "#5e5c64" }} /> Other karpef opinion</li>
                <li><span className="swatch" style={{ background: "#c01c28" }} /> City the techum ends inside (kalsa midaso)</li>
                <li><span className="swatch" style={{ background: "#f5c211" }} /> Eiruv feasible region</li>
                <li><span className="swatch" style={{ background: "#9141ac" }} /> New techum (with eiruv)</li>
                <li><span className="swatch" style={{ background: "#2ec27e" }} /> Area gained</li>
                <li><span className="swatch" style={{ background: "#e01b24" }} /> Area lost</li>
              </ul>
            </details>

            <BeyondTechumNotes />
          </section>
        )}

        <footer>
          <p className="disclaimer">
            This tool is an aid for learning and planning only. Building data
            (OpenStreetMap) may be incomplete, and several dinim — which
            structures join the city, karpef, hilly terrain, the eiruv's
            resting place — depend on local conditions. Measurements here
            rely on map/satellite data; halachic land measurement is a much
            more hands-on process and may well produce different results.
            Consult a rav before relying on any boundary or eiruv shown
            here.
          </p>
          <button
            className="link-button"
            onClick={() => {
              localStorage.removeItem(STORAGE_KEY);
              window.location.reload();
            }}
          >
            Change API key
          </button>
          <p className="build-time">Last updated: {formatBuildTime()}</p>
        </footer>
      </aside>
      <main className="map-wrap">
        {place && cityLoading && (
          <div className="map-loading">
            <span className="spinner" />
            Calculating the city limits…
            {progress ? ` ${progress.buildings.toLocaleString()} buildings` : ""}
          </div>
        )}
        {place && !cityLoading && eruvCityChecking && !rotationOn && (
          <div className="map-loading">
            <span className="spinner" />
            Checking for a town around the eiruv spot…
          </div>
        )}
        {mapsReady && (
          <MapView
            place={place}
            techumBounds={view?.techum ?? null}
            altTechumBounds={view?.altTechum ?? null}
            techumBumps={view?.bumps.map((b) => b.bounds) ?? []}
            swallowedCities={view?.bumps.map((b) => b.city) ?? []}
            cityBounds={usingCity ? cityBounds : null}
            hull={usingCity && !manualCityBounds ? detection?.hull ?? null : null}
            cityEditable={adjusting}
            onCityBoundsChange={(b) => setManualCityBounds(b)}
            showRadiusCircle={mode === "point" && showRadiusCircle}
            partialCities={partialCities}
            bowGapRects={
              usingCity && !manualCityBounds ? detection?.bowGapRects ?? [] : []
            }
            destination={eruvOn ? destination : null}
            feasibleRegion={placingEruv && !rotated ? plan!.feasibleRegion : null}
            hostPlaceableRects={
              placingEruv && !rotated ? hostCandidates.map((h) => h.placeable) : []
            }
            feasibleRing={placingEruv && rotated ? rotated.placeRing : null}
            feasibleCircle={placingEruv && rotated ? rotated.destCircle : null}
            eruvSpot={placingEruv ? eruvSpot : null}
            eruvPlacingActive={placingEruv}
            onEruvSpotChange={setEruvSpot}
            newTechumBounds={!rotated ? placement?.newTechum ?? null : null}
            newTechumRing={placingEruv && rotated ? rotated.diamond || null : null}
            newTechumBumps={
              !rotated
                ? [
                    ...(placement?.newBumps.map((b) => b.bounds) ?? []),
                    ...(placement?.ramaCity ? [placement.ramaCity] : []),
                    ...(placement?.hostCity && placement.hostCity !== cityBounds
                      ? [placement.hostCity]
                      : []),
                  ]
                : []
            }
            gained={!rotated ? placement?.gained ?? [] : []}
            lost={!rotated ? placement?.lost ?? [] : []}
            fitBounds={view?.fit ?? null}
            fitKey={`${place?.address ?? ""}|${mode}|${usingCity ? "city" : "point"}|${limitKey}|${eruvOn}|${destination?.address ?? ""}|${placement ? "placed" : ""}|${rotationOn}`}
          />
        )}
      </main>
    </div>
  );
}
