import { useEffect, useRef, useState } from "react";
import { geocodeAddress, type SelectedPlace } from "../maps/geocode";

interface Props {
  onSelect: (place: SelectedPlace) => void;
}

/**
 * Address search. Prefers the Places autocomplete widget
 * (PlaceAutocompleteElement); if the Places API isn't enabled on the
 * key, falls back to a plain input backed by the Geocoder.
 */
export default function SearchBox({ onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    let cancelled = false;
    let element: HTMLElement | null = null;
    (async () => {
      try {
        const places = (await google.maps.importLibrary("places")) as unknown as {
          PlaceAutocompleteElement?: new () => HTMLElement;
        };
        if (!places.PlaceAutocompleteElement) throw new Error("no autocomplete");
        if (cancelled || !containerRef.current) return;
        element = new places.PlaceAutocompleteElement();
        element.style.width = "100%";
        containerRef.current.appendChild(element);

        const fetchAndSelect = async (place: {
          fetchFields: (opts: { fields: string[] }) => Promise<unknown>;
          location?: { lat(): number; lng(): number } | null;
          formattedAddress?: string | null;
          displayName?: string | null;
        }) => {
          await place.fetchFields({
            fields: ["location", "formattedAddress", "displayName"],
          });
          if (!place.location) return;
          onSelectRef.current({
            location: { lat: place.location.lat(), lng: place.location.lng() },
            address: place.formattedAddress ?? place.displayName ?? "",
          });
        };

        // GA event (2025+): gmp-select with a placePrediction.
        element.addEventListener("gmp-select", (ev: Event) => {
          const prediction = (ev as unknown as { placePrediction?: { toPlace(): never } })
            .placePrediction;
          if (prediction) void fetchAndSelect(prediction.toPlace());
        });
        // Earlier event name: gmp-placeselect with a place.
        element.addEventListener("gmp-placeselect", (ev: Event) => {
          const place = (ev as unknown as { place?: never }).place;
          if (place) void fetchAndSelect(place);
        });
      } catch {
        if (!cancelled) setFallback(true);
      }
    })();
    return () => {
      cancelled = true;
      element?.remove();
    };
  }, []);

  const runGeocode = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onSelect(await geocodeAddress(query.trim()));
    } catch {
      setError("Address not found — try adding city/state.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="search-box">
      {!fallback && <div ref={containerRef} />}
      {fallback && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runGeocode();
          }}
        >
          <div className="search-row">
            <input
              type="text"
              value={query}
              placeholder="Enter an address…"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" disabled={busy}>
              {busy ? "…" : "Search"}
            </button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
