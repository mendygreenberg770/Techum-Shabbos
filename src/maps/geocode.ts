import type { LatLng } from "../halacha/geometry";

export interface SelectedPlace {
  location: LatLng;
  address: string;
}

export async function geocodeAddress(address: string): Promise<SelectedPlace> {
  const { Geocoder } = (await google.maps.importLibrary(
    "geocoding"
  )) as google.maps.GeocodingLibrary;
  const geocoder = new Geocoder();
  const { results } = await geocoder.geocode({ address });
  if (!results.length) throw new Error("Address not found");
  const top = results[0];
  const loc = top.geometry.location;
  return {
    location: { lat: loc.lat(), lng: loc.lng() },
    address: top.formatted_address,
  };
}
