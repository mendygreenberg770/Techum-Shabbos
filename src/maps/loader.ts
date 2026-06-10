let loadPromise: Promise<void> | null = null;

/**
 * Load the Google Maps JavaScript API. Subsequent libraries are loaded
 * on demand via google.maps.importLibrary().
 */
export function loadGoogleMaps(apiKey: string): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const callbackName = "__techumGmapsReady";
    (window as unknown as Record<string, unknown>)[callbackName] = () => resolve();
    const params = new URLSearchParams({
      key: apiKey,
      v: "weekly",
      loading: "async",
      callback: callbackName,
    });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Google Maps script"));
    document.head.appendChild(script);
  });
  return loadPromise;
}

/**
 * Register a handler for Google Maps authentication failures
 * (invalid/restricted API key). Google calls window.gm_authFailure.
 */
export function onAuthFailure(handler: () => void): void {
  (window as unknown as Record<string, unknown>).gm_authFailure = handler;
}
