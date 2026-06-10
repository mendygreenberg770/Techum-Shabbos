import { useEffect, useMemo, useRef, useState } from "react";
import KeySetup from "./components/KeySetup";
import MapView from "./components/MapView";
import SearchBox from "./components/SearchBox";
import SavedLocations from "./components/SavedLocations";
import EruvChecklist from "./components/EruvChecklist";
import BeyondTechumNotes from "./components/BeyondTechumNotes";
import ExplainPanel from "./components/ExplainPanel";
import type { CityDetection } from "./city/cluster";
import { detectCityExpanding, type ExpandProgress } from "./city/expand";
import {
  bearingDeg,
  diamondContains,
  diamondRing,
  distanceToRectM,
  placeEruv,
  planEruv,
  rotatedFeasible,
  roundedRectRing,
} from "./halacha/eruv";
import { computeMuvlaBumps, rectContainedIn } from "./halacha/muvla";
import {
  distanceMeters,
  expandBounds,
  pointBounds,
  rectIntersect,
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
const ENV_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || null;
// Maps JavaScript API keys are designed to be embedded client-side;
// restrict this key to your domains in the Google Cloud console.
const DEFAULT_KEY = "AIzaSyDtOQylrdusufl4zsRVoLr9SngVGXoUzEs";

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
}

const fmtAmos = (m: number) => Math.round(m / AMAH_M).toLocaleString();

export default function App() {
  // Changing the key always goes through a page reload (the Maps script
  // can only be loaded once per page), so this never needs a setter.
  const [apiKey] = useState<string | null>(
    () => ENV_KEY ?? localStorage.getItem(STORAGE_KEY) ?? DEFAULT_KEY
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
    detectCityExpanding(
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

  const view = useMemo(() => {
    if (!place) return null;
    const otherCities = detection?.otherCities ?? [];
    const base =
      usingCity && cityBounds
        ? karpefOn
          ? expandBounds(cityBounds, KARPEF_M)
          : cityBounds
        : pointBounds(place.location);
    const techum = expandBounds(base, TECHUM_M);
    const bumps = usingCity ? computeMuvlaBumps(base, techum, otherCities) : [];
    const altTechum =
      usingCity && cityBounds
        ? expandBounds(
            karpefOn ? cityBounds : expandBounds(cityBounds, KARPEF_M),
            TECHUM_M
          )
        : null;

    // Kalsa midaso: neighboring cities the techum line ends inside of
    // (overlapping but not fully swallowed) — one may walk only up to
    // the line there; no 4-amos credit.
    const partialCities = usingCity
      ? otherCities.filter(
          (c) => rectIntersect(c, techum) !== null && !rectContainedIn(c, techum)
        )
      : [];

    const plan =
      eruvOn && destination ? planEruv(techum, bumps, destination.location) : null;
    const allCities =
      usingCity && cityBounds ? [cityBounds, ...otherCities] : otherCities;
    const placement =
      plan && !plan.destinationInHomeTechum && destination && eruvSpot
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

    return { techum, altTechum, bumps, partialCities, plan, placement, rotated, fit };
  }, [place, usingCity, cityBounds, karpefOn, detection, eruvOn, destination, eruvSpot, rotationOn, rotationOffset]);

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
  const eruvReachable = !!(plan?.feasibleRegion || (rotated && rotated.reachable));
  const placingEruv = !!(plan && !plan.destinationInHomeTechum && eruvReachable);
  const spotOk = rotated ? rotated.inFeasible : placement?.inFeasibleRegion ?? false;
  const destOk = rotated
    ? rotated.destCovered && rotated.inFeasible
    : placement?.destinationCovered ?? false;
  const destDistanceM =
    place && destination
      ? distanceMeters(place.location, destination.location)
      : null;

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

                {cityState.status === "loading" && (
                  <p className="muted">
                    {progress
                      ? `Analyzing… ${progress.buildings.toLocaleString()} buildings so far; the city continues ${progress.expandingSides.join(", ")} — expanding the analyzed area (round ${progress.iteration}).`
                      : "Fetching buildings from OpenStreetMap…"}
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
                    </button>
                  </p>
                )}
                {cityState.status === "done" && cityState.fetchError && (
                  <p className="warning">
                    ⚠ Building data stopped loading partway (
                    {cityState.fetchError}) — the city boundary is based on
                    what was fetched and may be incomplete.{" "}
                    <button
                      className="link-button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {noCityFound && cityState.status === "done" && (
                  <p className="warning">
                    ⚠ No buildings were found near this address in
                    OpenStreetMap — showing the point-based techum of a
                    lone dwelling instead.{" "}
                    <button
                      className="link-button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {detection && (
                  <p className="muted">
                    City cluster: {detection.clusterSize.toLocaleString()} of{" "}
                    {detection.totalBuildings.toLocaleString()} buildings
                    analyzed join the city (gap ≤ 70⅔ amos between buildings,
                    ≤ 141⅓ amos between cities).
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
                  <p className="muted">
                    {view.bumps.length} neighboring{" "}
                    {view.bumps.length === 1 ? "city is" : "cities are"} fully
                    swallowed within the techum and count as only 4 amos — the
                    techum extends beyond {view.bumps.length === 1 ? "it" : "them"}{" "}
                    (blue extensions; SA HaRav 408:1).
                  </p>
                )}
                {usingCity && detection?.bowGapM != null && (
                  <p className="warning">
                    ⚠ Bow-shaped city: the squared boundary spans open
                    stretches of ≈{Math.round(detection.bowGapM).toLocaleString()}{" "}
                    m between built areas. Open land may be "filled in" by
                    squaring only when the built ends flanking it are within
                    4,000 amos = 1,920 m (Nesivos Shabbos 42:17) — parts of
                    this square may not be walkable. Review with a rav and
                    consider adjusting the boundary manually.
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
                    {usingCity
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
                          ) : (
                            <>
                              Click on the map inside the <b>yellow region</b>{" "}
                              (or drag the green eiruv marker) to choose where
                              the eiruv will rest. The yellow region is within
                              your current techum <i>and</i> close enough for
                              the new techum to cover the destination.
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
                        {eruvSpot && (
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
                              {eruvSpot.lng.toFixed(5)}. The eiruv is treated
                              as a bare point; the bonus of an eiruv resting
                              inside another city is not yet credited (a
                              stringency).
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
        </footer>
      </aside>
      <main className="map-wrap">
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
            destination={eruvOn ? destination : null}
            feasibleRegion={placingEruv && !rotated ? plan!.feasibleRegion : null}
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
