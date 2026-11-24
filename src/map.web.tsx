import "leaflet/dist/leaflet.css";
import * as L from "leaflet";
import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from "react";
import type MapView from "react-native-maps";
import type { MapPressEvent, MapViewProps, MapMarkerProps, MapPolylineProps, Region } from "react-native-maps";
import type { Point } from "./routes";

type MapHandle = Pick<MapView, "animateToRegion" | "fitToCoordinates">;
type Props = Pick<MapViewProps, "children" | "initialRegion" | "region" | "onMapReady" | "onPress" | "style" |
  "onRegionChangeComplete" | "zoomControlEnabled" | "legalLabelInsets">;
const MapContext = createContext<L.Map | null>(null);
const toLatLng = ({ latitude, longitude }: Point): L.LatLngTuple => [latitude, longitude];

function bounds({ latitude, longitude, latitudeDelta, longitudeDelta }: Region): L.LatLngBoundsExpression {
  return [[latitude - latitudeDelta / 2, longitude - longitudeDelta / 2],
    [latitude + latitudeDelta / 2, longitude + longitudeDelta / 2]];
}

export default forwardRef<MapHandle, Props>(function BrowserMap({ children, initialRegion, region, onMapReady, onPress,
  onRegionChangeComplete, zoomControlEnabled, legalLabelInsets }, ref) {
  const element = useRef<HTMLDivElement>(null);
  const initial = useRef(initialRegion);
  const zoomControl = useRef(zoomControlEnabled);
  const [map, setMap] = useState<L.Map | null>(null);
  const ready = useRef(onMapReady);
  ready.current = onMapReady;

  useEffect(() => {
    if (!element.current) return;
    const view = L.map(element.current, { maxZoom: 19, zoomAnimation: false, zoomControl: zoomControl.current });
    if (initial.current) view.fitBounds(bounds(initial.current), { animate: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(view);
    const resize = new ResizeObserver(() => view.invalidateSize({ pan: false }));
    resize.observe(element.current);
    setMap(view);
    return () => { resize.disconnect(); view.stop(); view.remove(); };
  }, []);

  const attributionInset = legalLabelInsets?.bottom;
  useEffect(() => {
    const attribution = map?.attributionControl.getContainer();
    if (attribution) attribution.style.marginBottom = attributionInset === undefined ? "" : `${attributionInset}px`;
  }, [map, attributionInset]);

  useImperativeHandle(ref, () => ({
    animateToRegion: (next, duration) => map?.fitBounds(bounds(next), { animate: duration !== 0 }),
    fitToCoordinates: (points, options) => {
      if (!map || !points?.length) return;
      const padding = options?.edgePadding;
      map.fitBounds(points.map(toLatLng), {
        animate: options?.animated,
        paddingTopLeft: [padding?.left ?? 0, padding?.top ?? 0],
        paddingBottomRight: [padding?.right ?? 0, padding?.bottom ?? 0],
        maxZoom: 18,
      });
    },
  }), [map]);
  useEffect(() => { if (map) ready.current?.(); }, [map]);

  const latitude = region?.latitude;
  const longitude = region?.longitude;
  const latitudeDelta = region?.latitudeDelta;
  const longitudeDelta = region?.longitudeDelta;
  useEffect(() => {
    if (map && latitude !== undefined && longitude !== undefined && latitudeDelta !== undefined && longitudeDelta !== undefined) {
      map.fitBounds(bounds({ latitude, longitude, latitudeDelta, longitudeDelta }), { animate: false });
    }
  }, [map, latitude, longitude, latitudeDelta, longitudeDelta]);

  useEffect(() => {
    if (!map || !onPress) return;
    const tap = ({ latlng, containerPoint }: L.LeafletMouseEvent) => onPress({
      nativeEvent: { coordinate: { latitude: latlng.lat, longitude: latlng.wrap().lng },
        position: { x: containerPoint.x, y: containerPoint.y } },
    } as MapPressEvent);
    map.on("click", tap);
    return () => { map.off("click", tap); };
  }, [map, onPress]);

  useEffect(() => {
    if (!map || !onRegionChangeComplete) return;
    const moved = () => {
      const center = map.getCenter();
      const extent = map.getBounds();
      onRegionChangeComplete({ latitude: center.lat, longitude: center.wrap().lng,
        latitudeDelta: extent.getNorth() - extent.getSouth(), longitudeDelta: extent.getEast() - extent.getWest() }, {});
    };
    map.on("moveend", moved);
    return () => { map.off("moveend", moved); };
  }, [map, onRegionChangeComplete]);

  return <MapContext.Provider value={map}>
    <div ref={element} aria-label="Walking map" style={{ width: "100%", height: "100%", background: "#e3eadf", isolation: "isolate" }} />
    {children}
  </MapContext.Provider>;
});

export function Marker({ coordinate, pinColor, title }: Pick<MapMarkerProps, "coordinate" | "pinColor" | "title">) {
  const map = useContext(MapContext);
  const { latitude, longitude } = coordinate;
  useEffect(() => {
    if (!map) return;
    const marker = L.circleMarker([latitude, longitude], {
      pane: "markerPane", radius: 6, color: "white", weight: 2, fillColor: pinColor ?? "#b65035", fillOpacity: 1,
    }).addTo(map);
    if (title) {
      const label = document.createElement("span");
      label.textContent = title;
      marker.bindTooltip(label);
    }
    return () => { marker.remove(); };
  }, [map, latitude, longitude, pinColor, title]);
  return null;
}

export function Polyline({ coordinates, strokeColor, strokeWidth, lineDashPattern, tappable, onPress }:
  Pick<MapPolylineProps, "coordinates" | "strokeColor" | "strokeWidth" | "lineDashPattern" | "tappable" | "onPress">) {
  const map = useContext(MapContext);
  const press = useRef(onPress);
  press.current = onPress;
  const dashArray = lineDashPattern?.join(" ");
  useEffect(() => {
    if (!map) return;
    const line = L.polyline(coordinates.map(toLatLng), {
      color: strokeColor, weight: strokeWidth, dashArray, interactive: Boolean(tappable), bubblingMouseEvents: false,
    }).addTo(map);
    if (tappable) line.on("click", () => press.current?.({ nativeEvent: { action: "polyline-press" } } as Parameters<NonNullable<typeof onPress>>[0]));
    return () => { line.remove(); };
  }, [map, coordinates, strokeColor, strokeWidth, dashArray, tappable]);
  return null;
}
