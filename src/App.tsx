import { useEffect, useMemo, useState } from "react";
import KeySetup from "./components/KeySetup";
import MapView from "./components/MapView";
import SearchBox from "./components/SearchBox";
import EruvChecklist from "./components/EruvChecklist";
import type { CityDetection } from "./city/cluster";
import { detectCityExpanding, type ExpandProgress } from "./city/expand";
import { placeEruv, planEruv } from "./halacha/eruv";
import { computeMuvlaBumps } from "./halacha/muvla";
import {
  distanceMeters,
  expandBounds,
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

const STORAGE_KEY = "techum.gmapsApiKey";
const ENV_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || null;

/** Beyond this distance from the nearest building, treat the address
 * as a lone dwelling rather than part of the detected cluster. */
const LONE_DWELLING_CUTOFF_M = 100;

type Mode = "city" | "point";
type LimitKey = "town" | "city" | "metro";

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
}

const fmtAmos = (m: number) => Math.round(m / AMAH_M).toLocaleString();

export default function App() {
  // Changing the key always goes through a page reload (the Maps script
  // can only be loaded once per page), so this never needs a setter.
  const [apiKey] = useState<string | null>(
    () => ENV_KEY ?? localStorage.getItem(STORAGE_KEY)
  );
  const [authFailed, setAuthFailed] = useState(false);
  const [mapsReady, setMapsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [place, setPlace] = useState<SelectedPlace | null>(null);
  const [mode, setMode] = useState<Mode>("city");
  const [limitKey, setLimitKey] = useState<LimitKey>("city");
  const [karpefOn, setKarpefOn] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [manualCityBounds, setManualCityBounds] = useState<Bounds | null>(null);
  const [cityState, setCityState] = useState<CityState>({ status: "idle" });
  const [progress, setProgress] = useState<ExpandProgress | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showRadiusCircle, setShowRadiusCircle] = useState(false);

  const [eruvOn, setEruvOn] = useState(false);
  const [destination, setDestination] = useState<SelectedPlace | null>(null);
  const [eruvSpot, setEruvSpot] = useState<LatLng | null>(null);

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

  // City analysis: fetch building footprints, expanding the analyzed
  // area until the whole contiguous city is captured or a limit is hit.
  useEffect(() => {
    setManualCityBounds(null);
    setAdjusting(false);
    setProgress(null);
    if (!place || mode !== "city") {
      setCityState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setCityState({ status: "loading" });
    detectCityExpanding(
      place.location,
      LIMITS[limitKey],
      (p) => {
        if (!cancelled) setProgress(p);
      },
      () => cancelled
    )
      .then((result) => {
        if (cancelled) return;
        setCityState({
          status: "done",
          detection: result.detection ?? undefined,
          capped: result.capped,
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
    };
  }, [place, mode, limitKey, retryNonce]);

  // A new home/destination invalidates the chosen eiruv spot.
  useEffect(() => {
    setEruvSpot(null);
  }, [place, destination, mode]);

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

    const plan =
      eruvOn && destination ? planEruv(techum, bumps, destination.location) : null;
    const allCities =
      usingCity && cityBounds ? [cityBounds, ...otherCities] : otherCities;
    const placement =
      plan && !plan.destinationInHomeTechum && destination && eruvSpot
        ? placeEruv(eruvSpot, destination.location, techum, plan.feasibleRegion, allCities)
        : null;

    let fit = techum;
    for (const b of bumps) fit = rectUnion(fit, b.bounds);
    if (plan && destination && !plan.destinationInHomeTechum) {
      fit = rectUnion(fit, techumFromPoint(destination.location));
    }
    if (placement) {
      fit = rectUnion(fit, placement.newTechum);
      for (const b of placement.newBumps) fit = rectUnion(fit, b.bounds);
    }

    return { techum, altTechum, bumps, plan, placement, fit };
  }, [place, usingCity, cityBounds, karpefOn, detection, eruvOn, destination, eruvSpot]);

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
  const placingEruv = !!(plan && !plan.destinationInHomeTechum && plan.feasibleRegion);
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
                    Building data failed to load ({cityState.error}).{" "}
                    <button
                      className="link-button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {noCityFound && cityState.status === "done" && (
                  <p className="muted">
                    No buildings found near this address — showing the
                    point-based techum of a lone dwelling instead.
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

                {usingCity && (
                  <>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={karpefOn}
                        onChange={(e) => setKarpefOn(e.target.checked)}
                      />
                      Add karpef (70⅔ amos ≈ {KARPEF_M.toFixed(1)} m) around the
                      city before measuring — machlokes (SA 398:5), confirm with
                      your rav. The other opinion's line is shown in gray.
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
                    {TECHUM_AMOS.toLocaleString()} amos = {TECHUM_M} m
                    {usingCity && karpefOn ? ` (+ ${KARPEF_M.toFixed(1)} m karpef)` : ""}
                  </td>
                </tr>
                <tr>
                  <td>To the corner</td>
                  <td>≈ {Math.round(TECHUM_CORNER_M)} m (2,000·√2 amos)</td>
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

                    {plan && !plan.destinationInHomeTechum && !plan.feasibleRegion && (
                      <p className="error">
                        ✗ Out of reach: an eiruv techumin moves the techum at
                        most 2,000 amos further (up to 4,000 amos = 1,920 m
                        total in one direction). No placement can cover this
                        destination.
                      </p>
                    )}

                    {placingEruv && (
                      <>
                        <p className="muted">
                          Click on the map inside the <b>yellow region</b> (or
                          drag the green eiruv marker) to choose where the
                          eiruv will rest. The yellow region is within your
                          current techum <i>and</i> close enough for the new
                          techum to cover the destination.
                        </p>
                        {placement && (
                          <>
                            {!placement.inFeasibleRegion && (
                              <p className="warning">
                                ⚠ This spot is outside the feasible region —
                                either beyond your current techum (you may not
                                reach it) or too far from the destination.
                              </p>
                            )}
                            {placement.inFeasibleRegion &&
                              (placement.destinationCovered ? (
                                <p className="success">
                                  ✓ With the eiruv here, the destination is
                                  within the new techum (purple). The red area
                                  on the home side is <b>lost</b>; the green
                                  area is gained.
                                </p>
                              ) : (
                                <p className="warning">
                                  ⚠ The destination is not covered from this
                                  spot — move the eiruv closer to it.
                                </p>
                              ))}
                            {placement.newBumps.length > 0 && (
                              <p className="muted">
                                A city fully swallowed within the new techum
                                (e.g., your own city) counts as only 4 amos —
                                the purple techum extends beyond it
                                (SA HaRav 408:1).
                              </p>
                            )}
                            <p className="muted">
                              Eiruv spot: {eruvSpot!.lat.toFixed(5)},{" "}
                              {eruvSpot!.lng.toFixed(5)}. The eiruv is treated
                              as a bare point; the bonus of an eiruv resting
                              inside another city is not yet credited (a
                              stringency).
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
                <li><span className="swatch" style={{ background: "#f5c211" }} /> Eiruv feasible region</li>
                <li><span className="swatch" style={{ background: "#9141ac" }} /> New techum (with eiruv)</li>
                <li><span className="swatch" style={{ background: "#2ec27e" }} /> Area gained</li>
                <li><span className="swatch" style={{ background: "#e01b24" }} /> Area lost</li>
              </ul>
            </details>
          </section>
        )}

        <footer>
          <p className="disclaimer">
            This tool is an aid for learning and planning only. Building data
            (OpenStreetMap) may be incomplete, and several dinim — which
            structures join the city, rivers and highways, karpef, hilly
            terrain, the eiruv's resting place — depend on local conditions.
            Consult a rav before relying on any boundary or eiruv shown here.
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
            destination={eruvOn ? destination : null}
            feasibleRegion={placingEruv ? plan!.feasibleRegion : null}
            eruvSpot={placingEruv ? eruvSpot : null}
            eruvPlacingActive={placingEruv}
            onEruvSpotChange={setEruvSpot}
            newTechumBounds={placement?.newTechum ?? null}
            newTechumBumps={placement?.newBumps.map((b) => b.bounds) ?? []}
            gained={placement?.gained ?? []}
            lost={placement?.lost ?? []}
            fitBounds={view?.fit ?? null}
            fitKey={`${place?.address ?? ""}|${mode}|${usingCity ? "city" : "point"}|${limitKey}|${eruvOn}|${destination?.address ?? ""}|${placement ? "placed" : ""}`}
          />
        )}
      </main>
    </div>
  );
}
