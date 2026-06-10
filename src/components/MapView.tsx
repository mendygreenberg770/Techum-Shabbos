import { useEffect, useRef } from "react";
import { techumFromPoint } from "../halacha/geometry";
import { TECHUM_M } from "../halacha/shiurim";
import type { SelectedPlace } from "../maps/geocode";

interface Props {
  place: SelectedPlace | null;
  showRadiusCircle: boolean;
}

// 770 Eastern Parkway as the initial view.
const DEFAULT_CENTER = { lat: 40.669, lng: -73.9428 };

export default function MapView({ place, showRadiusCircle }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const rectRef = useRef<google.maps.Rectangle | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { Map } = (await google.maps.importLibrary(
        "maps"
      )) as google.maps.MapsLibrary;
      if (cancelled || !divRef.current || mapRef.current) return;
      mapRef.current = new Map(divRef.current, {
        center: DEFAULT_CENTER,
        zoom: 13,
        streetViewControl: false,
        fullscreenControl: true,
        mapTypeControl: true,
        clickableIcons: false,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !place) return;

    const bounds = techumFromPoint(place.location);

    if (!markerRef.current) {
      markerRef.current = new google.maps.Marker({ map });
    }
    markerRef.current.setPosition(place.location);
    markerRef.current.setTitle(place.address);

    if (!rectRef.current) {
      rectRef.current = new google.maps.Rectangle({
        map,
        strokeColor: "#1a5fb4",
        strokeOpacity: 0.9,
        strokeWeight: 2.5,
        fillColor: "#1a5fb4",
        fillOpacity: 0.08,
      });
    }
    rectRef.current.setBounds(bounds);

    if (!circleRef.current) {
      circleRef.current = new google.maps.Circle({
        strokeColor: "#9141ac",
        strokeOpacity: 0.6,
        strokeWeight: 1.5,
        fillOpacity: 0,
      });
    }
    circleRef.current.setCenter(place.location);
    circleRef.current.setRadius(TECHUM_M);
    circleRef.current.setMap(showRadiusCircle ? map : null);

    map.fitBounds(
      new google.maps.LatLngBounds(
        { lat: bounds.south, lng: bounds.west },
        { lat: bounds.north, lng: bounds.east }
      ),
      24
    );
  }, [place, showRadiusCircle]);

  return <div ref={divRef} className="map" />;
}
