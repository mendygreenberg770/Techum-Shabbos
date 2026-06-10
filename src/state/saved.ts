import { validateSnapshot, type AppSnapshot } from "./share";

const KEY = "techum.savedLocations";

export interface SavedLocation {
  id: string;
  name: string;
  savedAt: number;
  snapshot: AppSnapshot;
}

function readAll(): SavedLocation[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SavedLocation[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const snapshot = validateSnapshot(o.snapshot);
      if (typeof o.id !== "string" || typeof o.name !== "string" || !snapshot) continue;
      out.push({
        id: o.id,
        name: o.name,
        savedAt: typeof o.savedAt === "number" ? o.savedAt : 0,
        snapshot,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(list: SavedLocation[]): SavedLocation[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage may be full or unavailable (private mode) — the in-memory
    // list is still returned so the UI stays consistent for the session.
  }
  return list;
}

export function listSaved(): SavedLocation[] {
  return readAll();
}

/** Save (or update, matching by home address) a location with its settings. */
export function saveLocation(name: string, snapshot: AppSnapshot): SavedLocation[] {
  const list = readAll().filter(
    (s) => s.snapshot.place.address !== snapshot.place.address
  );
  list.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || snapshot.place.address,
    savedAt: Date.now(),
    snapshot,
  });
  return writeAll(list);
}

export function removeLocation(id: string): SavedLocation[] {
  return writeAll(readAll().filter((s) => s.id !== id));
}
