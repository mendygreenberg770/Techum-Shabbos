import { useEffect, useRef } from "react";
import type { Bounds, LatLng } from "../halacha/geometry";
import { TECHUM_M } from "../halacha/shiurim";
import type { SelectedPlace } from "../maps/geocode";

interface Props {
  place: SelectedPlace | null;
  /** The techum to display (blue). */
  techumBounds: Bounds | null;
  /** The other karpef opinion's techum, for comparison (thin gray). */
  altTechumBounds: Bounds | null;
  /** The squared city (green); editable when cityEditable is set. */
  cityBounds: Bounds | null;
  /** Convex hull of the detected building cluster (orange). */
  hull: LatLng[] | null;
  cityEditable: boolean;
  onCityBoundsChange: (b: Bounds) => void;
  showRadiusCircle: boolean;
  /** Refit the viewport when this changes. */
  fitKey: string;
}

// 770 Eastern Parkway as the initial view.
const DEFAULT_CENTER = { lat: 40.669, lng: -73.9428 };

function toGBounds(b: Bounds): google.maps.LatLngBoundsLiteral {
  return { north: b.north, south: b.south, east: b.east, west: b.west };
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  const eps = 1e-9;
  return (
    Math.abs(a.north - b.north) < eps &&
    Math.abs(a.south - b.south) < eps &&
    Math.abs(a.east - b.east) < eps &&
    Math.abs(a.west - b.west) < eps
  );
}

export default function MapView(props: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const techumRef = useRef<google.maps.Rectangle | null>(null);
  const altRef = useRef<google.maps.Rectangle | null>(null);
  const cityRef = useRef<google.maps.Rectangle | null>(null);
  const hullRef = useRef<google.maps.Polygon | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);
  const lastFitKey = useRef("");
  const appliedCityBounds = useRef<Bounds | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

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

  const { place, techumBounds, altTechumBounds, cityBounds, hull, cityEditable, showRadiusCircle, fitKey } = props;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !place || !techumBounds) return;

    // Marker
    if (!markerRef.current) {
      markerRef.current = new google.maps.Marker({ map });
    }
    markerRef.current.setPosition(place.location);
    markerRef.current.setTitle(place.address);

    // Techum (blue)
    if (!techumRef.current) {
      techumRef.current = new google.maps.Rectangle({
        map,
        strokeColor: "#1a5fb4",
        strokeOpacity: 0.9,
        strokeWeight: 2.5,
        fillColor: "#1a5fb4",
        fillOpacity: 0.08,
        clickable: false,
      });
    }
    techumRef.current.setBounds(toGBounds(techumBounds));

    // Alternate karpef-opinion techum (thin gray, no fill)
    if (!altRef.current) {
      altRef.current = new google.maps.Rectangle({
        strokeColor: "#5e5c64",
        strokeOpacity: 0.7,
        strokeWeight: 1,
        fillOpacity: 0,
        clickable: false,
      });
    }
    if (altTechumBounds) {
      altRef.current.setBounds(toGBounds(altTechumBounds));
      altRef.current.setMap(map);
    } else {
      altRef.current.setMap(null);
    }

    // Squared city (green, editable on request)
    if (!cityRef.current) {
      cityRef.current = new google.maps.Rectangle({
        strokeColor: "#26a269",
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: "#26a269",
        fillOpacity: 0.05,
      });
      cityRef.current.addListener("bounds_changed", () => {
        const gb = cityRef.current!.getBounds();
        if (!gb) return;
        const ne = gb.getNorthEast();
        const sw = gb.getSouthWest();
        const next: Bounds = {
          north: ne.lat(),
          south: sw.lat(),
          east: ne.lng(),
          west: sw.lng(),
        };
        // Ignore the event when we set the bounds ourselves.
        if (appliedCityBounds.current && sameBounds(next, appliedCityBounds.current)) {
          return;
        }
        appliedCityBounds.current = next;
        propsRef.current.onCityBoundsChange(next);
      });
    }
    if (cityBounds) {
      if (!appliedCityBounds.current || !sameBounds(cityBounds, appliedCityBounds.current)) {
        appliedCityBounds.current = cityBounds;
        cityRef.current.setBounds(toGBounds(cityBounds));
      }
      cityRef.current.setEditable(cityEditable);
      cityRef.current.setDraggable(cityEditable);
      cityRef.current.setOptions({ clickable: cityEditable });
      cityRef.current.setMap(map);
    } else {
      cityRef.current.setMap(null);
      appliedCityBounds.current = null;
    }

    // Detected cluster hull (orange)
    if (!hullRef.current) {
      hullRef.current = new google.maps.Polygon({
        strokeColor: "#e66100",
        strokeOpacity: 0.8,
        strokeWeight: 1.5,
        fillColor: "#e66100",
        fillOpacity: 0.04,
        clickable: false,
      });
    }
    if (hull && hull.length >= 3) {
      hullRef.current.setPath(hull);
      hullRef.current.setMap(map);
    } else {
      hullRef.current.setMap(null);
    }

    // Illustrative pre-squaring radius circle (point mode)
    if (!circleRef.current) {
      circleRef.current = new google.maps.Circle({
        strokeColor: "#9141ac",
        strokeOpacity: 0.6,
        strokeWeight: 1.5,
        fillOpacity: 0,
        clickable: false,
      });
    }
    circleRef.current.setCenter(place.location);
    circleRef.current.setRadius(TECHUM_M);
    circleRef.current.setMap(showRadiusCircle ? map : null);

    // Fit the viewport on meaningful changes only (not on manual edits).
    if (fitKey !== lastFitKey.current) {
      lastFitKey.current = fitKey;
      map.fitBounds(
        new google.maps.LatLngBounds(
          { lat: techumBounds.south, lng: techumBounds.west },
          { lat: techumBounds.north, lng: techumBounds.east }
        ),
        24
      );
    }
  }, [place, techumBounds, altTechumBounds, cityBounds, hull, cityEditable, showRadiusCircle, fitKey]);

  return <div ref={divRef} className="map" />;
}
