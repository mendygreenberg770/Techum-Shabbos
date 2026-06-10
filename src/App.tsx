import { useEffect, useState } from "react";
import KeySetup from "./components/KeySetup";
import MapView from "./components/MapView";
import SearchBox from "./components/SearchBox";
import { TECHUM_AMOS, TECHUM_CORNER_M, TECHUM_M } from "./halacha/shiurim";
import { loadGoogleMaps, onAuthFailure } from "./maps/loader";
import type { SelectedPlace } from "./maps/geocode";

const STORAGE_KEY = "techum.gmapsApiKey";
const ENV_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || null;

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
            <h2>Techum</h2>
            <p className="address">{place.address}</p>
            <table>
              <tbody>
                <tr>
                  <td>Mode</td>
                  <td>Lone dwelling (point)</td>
                </tr>
                <tr>
                  <td>Each direction</td>
                  <td>
                    {TECHUM_AMOS.toLocaleString()} amos = {TECHUM_M} m
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
              ha'olam), so the corners extend beyond 2,000 amos. City detection
              (measuring from the edge of the squared city) comes in Phase 2 —
              until then this point-based square may understate the techum
              inside a built-up area, never overstate it.
            </p>
            <label className="toggle">
              <input
                type="checkbox"
                checked={showRadiusCircle}
                onChange={(e) => setShowRadiusCircle(e.target.checked)}
              />
              Show 2,000-amah radius (before squaring, for illustration)
            </label>
          </section>
        )}

        <footer>
          <p className="disclaimer">
            This tool is an aid for learning and planning only. Map data may be
            incomplete and several dinim depend on local conditions — consult a
            rav before relying on any boundary shown here.
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
        {mapsReady && <MapView place={place} showRadiusCircle={showRadiusCircle} />}
      </main>
    </div>
  );
}
