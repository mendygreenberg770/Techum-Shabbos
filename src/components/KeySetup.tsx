import { useState } from "react";

interface Props {
  authFailed: boolean;
  onSave: (key: string) => void;
}

export default function KeySetup({ authFailed, onSave }: Props) {
  const [key, setKey] = useState("");
  return (
    <div className="key-setup">
      <div className="key-card">
        <h1>Techum Shabbos Calculator</h1>
        {authFailed && (
          <p className="error">
            Google rejected the saved API key. Please check the key and its
            restrictions, then enter it again.
          </p>
        )}
        <p>
          To show maps, the app needs a Google Maps API key. The key is stored
          only in this browser (or set <code>VITE_GOOGLE_MAPS_API_KEY</code> at
          build time).
        </p>
        <ol>
          <li>
            Create a project at{" "}
            <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">
              console.cloud.google.com
            </a>{" "}
            and enable billing (the free tier covers light personal use).
          </li>
          <li>
            Enable: <b>Maps JavaScript API</b>, <b>Geocoding API</b>, and{" "}
            <b>Places API (New)</b>.
          </li>
          <li>Create an API key under "APIs &amp; Services → Credentials".</li>
        </ol>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) onSave(key.trim());
          }}
        >
          <div className="search-row">
            <input
              type="text"
              value={key}
              placeholder="Paste your Google Maps API key"
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="submit" disabled={!key.trim()}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
