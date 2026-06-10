import { useEffect, useRef, useState } from "react";
import { listSaved, removeLocation, saveLocation, type SavedLocation } from "../state/saved";
import type { AppSnapshot } from "../state/share";

interface Props {
  /** Snapshot of the current view, or null when nothing is selected. */
  snapshot: AppSnapshot | null;
  onLoad: (snap: AppSnapshot) => void;
}

/**
 * Saved locations (localStorage) and the shareable-link button.
 * Saving stores the whole snapshot — address plus settings, destination
 * and eiruv spot — so loading restores the exact view.
 */
export default function SavedLocations({ snapshot, onLoad }: Props) {
  const [saved, setSaved] = useState<SavedLocation[]>(() => listSaved());
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const save = () => {
    if (!snapshot) return;
    const name = window.prompt("Name for this location:", snapshot.place.address);
    if (name === null) return;
    setSaved(saveLocation(name, snapshot));
  };

  const copyLink = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link:", url);
    }
  };

  if (!snapshot && saved.length === 0) return null;

  return (
    <div className="saved">
      {snapshot && (
        <div className="saved-actions">
          <button type="button" className="mini-button" onClick={save}>
            ★ Save location
          </button>
          <button type="button" className="mini-button" onClick={() => void copyLink()}>
            {copied ? "✓ Link copied" : "🔗 Copy shareable link"}
          </button>
        </div>
      )}
      {saved.length > 0 && (
        <details className="saved-list-wrap" open={!snapshot}>
          <summary>Saved locations ({saved.length})</summary>
          <ul className="saved-list">
            {saved.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="link-button saved-name"
                  title={s.snapshot.place.address}
                  onClick={() => onLoad(structuredClone(s.snapshot))}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  className="mini-button saved-delete"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => setSaved(removeLocation(s.id))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
