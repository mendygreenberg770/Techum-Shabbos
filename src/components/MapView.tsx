import { useEffect, useRef } from "react";
import type { Bounds, LatLng } from "../halacha/geometry";
import { TECHUM_M } from "../halacha/shiurim";
import type { SelectedPlace } from "../maps/geocode";

interface Props {
  place: SelectedPlace | null;
  /** The techum to display (blue) and its muvla extensions. */
  techumBounds: Bounds | null;
  techumBumps: Bounds[];
  /** Cities swallowed within the techum — muvla, count as 4 amos (light blue fill). */
  swallowedCities: Bounds[];
  /** Cities the techum line ends inside of — kalsa midaso (red outline). */
  partialCities: Bounds[];
  /** Open stretches too wide to be "squared in" (bow-city warning, magenta). */
  bowGapRects: Bounds[];
  /** The other karpef opinion's techum, for comparison (thin gray). */
  altTechumBounds: Bounds | null;
  /** The squared city (green); editable when cityEditable is set. */
  cityBounds: Bounds | null;
  /** Accurate (concave) city shape: chained buildings dilated by half
   * the joining distance — one or more rings (orange). */
  cityOutline: LatLng[][] | null;
  /** Nearby built-up areas that did NOT join the city (brown rings). */
  neighborOutline: LatLng[][] | null;
  cityEditable: boolean;
  onCityBoundsChange: (b: Bounds) => void;
  showRadiusCircle: boolean;
  /** Eiruv planner overlays. */
  destination: SelectedPlace | null;
  feasibleRegion: Bounds | null;
  /** Corner-rotation kula: placement region ring + destination circle. */
  feasibleRing: LatLng[] | null;
  feasibleCircle: { center: LatLng; radiusM: number } | null;
  /** Host-town placement areas: resting the eiruv inside one extends
   * the new techum from the whole town's edge (yellow rectangles). */
  hostPlaceableRects: Bounds[];
  eruvSpot: LatLng | null;
  eruvPlacingActive: boolean;
  onEruvSpotChange: (p: LatLng) => void;
  newTechumBounds: Bounds | null;
  /** Corner-rotation kula: the new techum as a rotated diamond. */
  newTechumRing: LatLng[] | null;
  newTechumBumps: Bounds[];
  gained: Bounds[];
  lost: Bounds[];
  /** Measuring ruler: when active, map clicks set the two endpoints;
   * endpoints are draggable for fine adjustment. */
  measureActive: boolean;
  measurePoints: LatLng[];
  onMeasurePoint: (p: LatLng) => void;
  onMeasureMove: (index: number, p: LatLng) => void;
  /** Viewport: refit to fitBounds when fitKey changes. */
  fitBounds: Bounds | null;
  fitKey: string;
}

// 770 Eastern Parkway as the initial view.
const DEFAULT_CENTER = { lat: 40.669, lng: -73.9428 };

const TECHUM_STYLE: google.maps.RectangleOptions = {
  strokeColor: "#1a5fb4",
  strokeOpacity: 0.9,
  strokeWeight: 2.5,
  fillColor: "#1a5fb4",
  fillOpacity: 0.08,
  clickable: false,
};

const SWALLOWED_STYLE: google.maps.RectangleOptions = {
  strokeColor: "#1a5fb4",
  strokeOpacity: 0.9,
  strokeWeight: 1.5,
  fillColor: "#99c1f1",
  fillOpacity: 0.3,
  clickable: false,
};

const BOW_GAP_STYLE: google.maps.RectangleOptions = {
  strokeColor: "#d4267e",
  strokeOpacity: 0.7,
  strokeWeight: 1,
  fillColor: "#d4267e",
  fillOpacity: 0.18,
  clickable: false,
};

const PARTIAL_CITY_STYLE: google.maps.RectangleOptions = {
  strokeColor: "#c01c28",
  strokeOpacity: 0.85,
  strokeWeight: 1.5,
  fillOpacity: 0,
  clickable: false,
};

const FEASIBLE_POLY_STYLE: google.maps.PolygonOptions = {
  strokeColor: "#b48800",
  strokeOpacity: 0.9,
  strokeWeight: 1.5,
  fillColor: "#f5c211",
  fillOpacity: 0.1,
  clickable: false,
};

const HOST_PLACEABLE_STYLE: google.maps.RectangleOptions = {
  strokeColor: "#b48800",
  strokeOpacity: 0.9,
  strokeWeight: 1.5,
  fillColor: "#f5c211",
  fillOpacity: 0.18,
  clickable: false,
};

const NEW_TECHUM_STYLE: google.maps.RectangleOptions = {
  strokeColor: "#9141ac",
  strokeOpacity: 0.9,
  strokeWeight: 2.5,
  fillColor: "#9141ac",
  fillOpacity: 0.07,
  clickable: false,
};

const GAINED_STYLE: google.maps.RectangleOptions = {
  strokeOpacity: 0,
  strokeWeight: 0,
  fillColor: "#2ec27e",
  fillOpacity: 0.16,
  clickable: false,
};

const LOST_STYLE: google.maps.RectangleOptions = {
  strokeOpacity: 0,
  strokeWeight: 0,
  fillColor: "#e01b24",
  fillOpacity: 0.14,
  clickable: false,
};

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

/** Keep a pool of rectangles in sync with a list of bounds. */
function syncRects(
  pool: google.maps.Rectangle[],
  map: google.maps.Map,
  list: Bounds[],
  style: google.maps.RectangleOptions
): void {
  while (pool.length < list.length) {
    pool.push(new google.maps.Rectangle(style));
  }
  pool.forEach((rect, i) => {
    if (i < list.length) {
      rect.setBounds(toGBounds(list[i]));
      rect.setMap(map);
    } else {
      rect.setMap(null);
    }
  });
}

export default function MapView(props: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const destMarkerRef = useRef<google.maps.Marker | null>(null);
  const eruvMarkerRef = useRef<google.maps.Marker | null>(null);
  const techumRef = useRef<google.maps.Rectangle | null>(null);
  const altRef = useRef<google.maps.Rectangle | null>(null);
  const cityRef = useRef<google.maps.Rectangle | null>(null);
  const feasibleRef = useRef<google.maps.Rectangle | null>(null);
  const newTechumRef = useRef<google.maps.Rectangle | null>(null);
  const cityOutlineRef = useRef<google.maps.Polygon | null>(null);
  const neighborOutlineRef = useRef<google.maps.Polygon | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);
  const bumpPool = useRef<google.maps.Rectangle[]>([]);
  const swallowedPool = useRef<google.maps.Rectangle[]>([]);
  const partialPool = useRef<google.maps.Rectangle[]>([]);
  const bowGapPool = useRef<google.maps.Rectangle[]>([]);
  const hostPlaceablePool = useRef<google.maps.Rectangle[]>([]);
  const feasibleRingRef = useRef<google.maps.Polygon | null>(null);
  const feasibleCircleRef = useRef<google.maps.Circle | null>(null);
  const diamondRef = useRef<google.maps.Polygon | null>(null);
  const newBumpPool = useRef<google.maps.Rectangle[]>([]);
  const gainedPool = useRef<google.maps.Rectangle[]>([]);
  const lostPool = useRef<google.maps.Rectangle[]>([]);
  const measureLineRef = useRef<google.maps.Polyline | null>(null);
  const measureDotPool = useRef<google.maps.Marker[]>([]);
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
      const map = new Map(divRef.current, {
        center: DEFAULT_CENTER,
        zoom: 13,
        streetViewControl: false,
        fullscreenControl: true,
        mapTypeControl: true,
        clickableIcons: false,
      });
      map.addListener("click", (e: google.maps.MapMouseEvent) => {
        const p = propsRef.current;
        if (!e.latLng) return;
        // The ruler takes precedence while active.
        if (p.measureActive) {
          p.onMeasurePoint({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        } else if (p.eruvPlacingActive) {
          p.onEruvSpotChange({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        }
      });
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    place,
    techumBounds,
    techumBumps,
    swallowedCities,
    partialCities,
    bowGapRects,
    altTechumBounds,
    cityBounds,
    cityOutline,
    neighborOutline,
    cityEditable,
    showRadiusCircle,
    destination,
    feasibleRegion,
    feasibleRing,
    feasibleCircle,
    hostPlaceableRects,
    eruvSpot,
    newTechumBounds,
    newTechumRing,
    newTechumBumps,
    gained,
    lost,
    measurePoints,
    fitBounds,
    fitKey,
  } = props;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !place || !techumBounds) return;

    // Home marker
    if (!markerRef.current) {
      markerRef.current = new google.maps.Marker({ map });
    }
    markerRef.current.setPosition(place.location);
    markerRef.current.setTitle(place.address);

    // Techum (blue) + muvla extensions
    if (!techumRef.current) {
      techumRef.current = new google.maps.Rectangle({ map, ...TECHUM_STYLE });
    }
    techumRef.current.setBounds(toGBounds(techumBounds));
    syncRects(bumpPool.current, map, techumBumps, TECHUM_STYLE);
    syncRects(swallowedPool.current, map, swallowedCities, SWALLOWED_STYLE);
    syncRects(partialPool.current, map, partialCities, PARTIAL_CITY_STYLE);
    syncRects(bowGapPool.current, map, bowGapRects, BOW_GAP_STYLE);

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

    // Accurate city shape (orange) and non-joining neighbors (brown).
    if (!cityOutlineRef.current) {
      cityOutlineRef.current = new google.maps.Polygon({
        strokeColor: "#e66100",
        strokeOpacity: 0.85,
        strokeWeight: 2,
        fillColor: "#e66100",
        fillOpacity: 0.05,
        clickable: false,
      });
    }
    if (cityOutline && cityOutline.length > 0) {
      cityOutlineRef.current.setPaths(cityOutline);
      cityOutlineRef.current.setMap(map);
    } else {
      cityOutlineRef.current.setMap(null);
    }

    if (!neighborOutlineRef.current) {
      neighborOutlineRef.current = new google.maps.Polygon({
        strokeColor: "#986a44",
        strokeOpacity: 0.85,
        strokeWeight: 1.5,
        fillColor: "#986a44",
        fillOpacity: 0.07,
        clickable: false,
      });
    }
    if (neighborOutline && neighborOutline.length > 0) {
      neighborOutlineRef.current.setPaths(neighborOutline);
      neighborOutlineRef.current.setMap(map);
    } else {
      neighborOutlineRef.current.setMap(null);
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

    // --- Eiruv planner overlays ---

    if (!destMarkerRef.current) {
      destMarkerRef.current = new google.maps.Marker({
        icon: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
      });
    }
    if (destination) {
      destMarkerRef.current.setPosition(destination.location);
      destMarkerRef.current.setTitle(`Destination: ${destination.address}`);
      destMarkerRef.current.setMap(map);
    } else {
      destMarkerRef.current.setMap(null);
    }

    if (!feasibleRef.current) {
      feasibleRef.current = new google.maps.Rectangle({
        strokeColor: "#b48800",
        strokeOpacity: 0.9,
        strokeWeight: 1.5,
        fillColor: "#f5c211",
        fillOpacity: 0.18,
        clickable: false,
      });
    }
    if (feasibleRegion) {
      feasibleRef.current.setBounds(toGBounds(feasibleRegion));
      feasibleRef.current.setMap(map);
    } else {
      feasibleRef.current.setMap(null);
    }

    syncRects(hostPlaceablePool.current, map, hostPlaceableRects, HOST_PLACEABLE_STYLE);

    if (!eruvMarkerRef.current) {
      eruvMarkerRef.current = new google.maps.Marker({
        icon: "https://maps.google.com/mapfiles/ms/icons/green-dot.png",
        draggable: true,
        title: "Eiruv spot (drag to move)",
      });
      eruvMarkerRef.current.addListener("dragend", () => {
        const pos = eruvMarkerRef.current!.getPosition();
        if (pos) {
          propsRef.current.onEruvSpotChange({ lat: pos.lat(), lng: pos.lng() });
        }
      });
    }
    if (eruvSpot) {
      eruvMarkerRef.current.setPosition(eruvSpot);
      eruvMarkerRef.current.setMap(map);
    } else {
      eruvMarkerRef.current.setMap(null);
    }

    // Corner-rotation kula overlays: placement ring, destination
    // circle, and the diamond new techum.
    if (!feasibleRingRef.current) {
      feasibleRingRef.current = new google.maps.Polygon(FEASIBLE_POLY_STYLE);
    }
    if (feasibleRing && feasibleRing.length >= 3) {
      feasibleRingRef.current.setPath(feasibleRing);
      feasibleRingRef.current.setMap(map);
    } else {
      feasibleRingRef.current.setMap(null);
    }

    if (!feasibleCircleRef.current) {
      feasibleCircleRef.current = new google.maps.Circle(FEASIBLE_POLY_STYLE);
    }
    if (feasibleCircle) {
      feasibleCircleRef.current.setCenter(feasibleCircle.center);
      feasibleCircleRef.current.setRadius(feasibleCircle.radiusM);
      feasibleCircleRef.current.setMap(map);
    } else {
      feasibleCircleRef.current.setMap(null);
    }

    if (!diamondRef.current) {
      diamondRef.current = new google.maps.Polygon({
        strokeColor: "#9141ac",
        strokeOpacity: 0.9,
        strokeWeight: 2.5,
        fillColor: "#9141ac",
        fillOpacity: 0.07,
        clickable: false,
      });
    }
    if (newTechumRing && newTechumRing.length >= 3) {
      diamondRef.current.setPath(newTechumRing);
      diamondRef.current.setMap(map);
    } else {
      diamondRef.current.setMap(null);
    }

    if (!newTechumRef.current) {
      newTechumRef.current = new google.maps.Rectangle(NEW_TECHUM_STYLE);
    }
    if (newTechumBounds) {
      newTechumRef.current.setBounds(toGBounds(newTechumBounds));
      newTechumRef.current.setMap(map);
    } else {
      newTechumRef.current.setMap(null);
    }
    syncRects(newBumpPool.current, map, newTechumBounds ? newTechumBumps : [], NEW_TECHUM_STYLE);
    syncRects(gainedPool.current, map, gained, GAINED_STYLE);
    syncRects(lostPool.current, map, lost, LOST_STYLE);

    // Fit the viewport on meaningful changes only (not on drags/edits).
    if (fitKey !== lastFitKey.current && fitBounds) {
      lastFitKey.current = fitKey;
      map.fitBounds(
        new google.maps.LatLngBounds(
          { lat: fitBounds.south, lng: fitBounds.west },
          { lat: fitBounds.north, lng: fitBounds.east }
        ),
        24
      );
    }
  });

  // Measuring ruler: its own effect, gated only on the map existing —
  // it must work while the city is still analyzing (no techum drawn
  // yet), which is exactly when gaps get checked.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!measureLineRef.current) {
      measureLineRef.current = new google.maps.Polyline({
        strokeColor: "#1c1c1c",
        strokeOpacity: 0.9,
        strokeWeight: 2,
        clickable: false,
      });
    }
    if (measurePoints.length === 2) {
      measureLineRef.current.setPath(measurePoints);
      measureLineRef.current.setMap(map);
    } else {
      measureLineRef.current.setMap(null);
    }
    while (measureDotPool.current.length < measurePoints.length) {
      const idx = measureDotPool.current.length;
      const dot = new google.maps.Marker({
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: idx === 0 ? "#1c1c1c" : "#1a5fb4",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
          labelOrigin: new google.maps.Point(0, 0),
        },
        label: {
          text: String(idx + 1),
          color: "#ffffff",
          fontSize: "10px",
          fontWeight: "bold",
        },
        draggable: true,
        title: `Measure point ${idx + 1} (drag to adjust)`,
        zIndex: 1000,
      });
      dot.addListener("dragend", () => {
        const pos = dot.getPosition();
        if (pos) {
          propsRef.current.onMeasureMove(idx, { lat: pos.lat(), lng: pos.lng() });
        }
      });
      measureDotPool.current.push(dot);
    }
    measureDotPool.current.forEach((m, i) => {
      if (i < measurePoints.length) {
        m.setPosition(measurePoints[i]);
        m.setMap(map);
      } else {
        m.setMap(null);
      }
    });
  });

  return <div ref={divRef} className="map" />;
}
