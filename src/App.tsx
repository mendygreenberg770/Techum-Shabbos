import { useEffect, useMemo, useState } from "react";
import KeySetup from "./components/KeySetup";
import MapView from "./components/MapView";
import SearchBox from "./components/SearchBox";
import { detectCity, type CityDetection } from "./city/cluster";
import { fetchBuildings } from "./city/overpass";
import {
  expandBounds,
  techumFromPoint,
  type Bounds,
} from "./halacha/geometry";
import {
  KARPEF_AMOS,
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

interface CityState {
  status: "idle" | "loading" | "done" | "error";
  detection?: CityDetection;
  error?: string;
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

  const [place, setPlace] = useState<SelectedPlace | null>(null);
  const [mode, setMode] = useState<Mode>("city");
  const [radiusM, setRadiusM] = useState(2000);
  const [karpefOn, setKarpefOn] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [manualCityBounds, setManualCityBounds] = useState<Bounds | null>(null);
  const [cityState, setCityState] = useState<CityState>({ status: "idle" });
  const [retryNonce, setRetryNonce] = useState(0);
  const [showRadiusCircle, setShowRadiusCircle] = useState(false);

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

  // City analysis: fetch building footprints and find the user's cluster.
  useEffect(() => {
    setManualCityBounds(null);
    setAdjusting(false);
    if (!place || mode !== "city") {
      setCityState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setCityState({ status: "loading" });
    (async () => {
      try {
        const polys = await fetchBuildings(place.location, radiusM);
        if (cancelled) return;
        const detection = detectCity(place.location, polys, radiusM) ?? undefined;
        setCityState({ status: "done", detection });
      } catch (e) {
        if (!cancelled) {
          setCityState({
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [place, mode, radiusM, retryNonce]);

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
    if (usingCity && cityBounds) {
      const withKarpef = expandBounds(cityBounds, KARPEF_M);
      const techumNoKarpef = expandBounds(cityBounds, TECHUM_M);
      const techumWithKarpef = expandBounds(withKarpef, TECHUM_M);
      return {
        techumBounds: karpefOn ? techumWithKarpef : techumNoKarpef,
        altTechumBounds: karpefOn ? techumNoKarpef : techumWithKarpef,
        cityBounds,
        hull: manualCityBounds ? undefined : detection?.hull,
      };
    }
    return {
      techumBounds: techumFromPoint(place.location),
      altTechumBounds: undefined,
      cityBounds: null,
      hull: undefined,
    };
  }, [place, usingCity, cityBounds, karpefOn, manualCityBounds, detection]);

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
                  <span className="field-label">Analysis radius</span>
                  <select
                    value={radiusM}
                    onChange={(e) => setRadiusM(Number(e.target.value))}
                  >
                    <option value={1000}>1 km</option>
                    <option value={2000}>2 km</option>
                    <option value={3000}>3 km</option>
                    <option value={4000}>4 km</option>
                  </select>
                </div>

                {cityState.status === "loading" && (
                  <p className="muted">
                    Fetching buildings from OpenStreetMap and detecting the
                    city… this can take a while in dense areas.
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
                {noCityFound && (
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
                    ≤ 141⅓ amos between cities). All structures are counted —
                    refining which structures halachically join is an open
                    item (see notes).
                  </p>
                )}
                {truncated.length > 0 && (
                  <p className="warning">
                    ⚠ The built-up area reaches the edge of the analysis
                    radius on the <b>{truncated.join(", ")}</b> side
                    {truncated.length > 1 ? "s" : ""}. The city likely
                    continues beyond, so the true techum extends{" "}
                    <b>further</b> in {truncated.length > 1 ? "those directions" : "that direction"}{" "}
                    than shown. Try a larger analysis radius.
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
                      Add karpef ({KARPEF_AMOS.toFixed(2).replace(/0+$/, "")} amos
                      ≈ {KARPEF_M.toFixed(1)} m) around the city before
                      measuring — machlokes (SA 398:5), confirm with your rav.
                      The other opinion's line is shown in gray.
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
          </section>
        )}

        <footer>
          <p className="disclaimer">
            This tool is an aid for learning and planning only. Building data
            (OpenStreetMap) may be incomplete, and several dinim — which
            structures join the city, rivers and highways, karpef, hilly
            terrain — depend on local conditions. Consult a rav before relying
            on any boundary shown here.
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
            techumBounds={view?.techumBounds ?? null}
            altTechumBounds={view?.altTechumBounds ?? null}
            cityBounds={view?.cityBounds ?? null}
            hull={view?.hull ?? null}
            cityEditable={adjusting}
            onCityBoundsChange={(b) => setManualCityBounds(b)}
            showRadiusCircle={mode === "point" && showRadiusCircle}
            fitKey={`${place?.address ?? ""}|${mode}|${usingCity ? "city" : "point"}|${radiusM}`}
          />
        )}
      </main>
    </div>
  );
}
