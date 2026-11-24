import { distance, routeParameters, scoreRoutes, validPoint, type Candidate, type Point } from "./routes.ts";

const valhallaUrl = (process.env.EXPO_PUBLIC_VALHALLA_URL?.trim() || "https://valhalla1.openstreetmap.de").replace(/\/+$/, "");
const overpassUrl = process.env.EXPO_PUBLIC_OVERPASS_URL?.trim() || "https://overpass-api.de/api/interpreter";
const elevationInterval = 30;
const maxEdges = 5000;
let overpassRetryAt = 0;
const toLocation = ({ latitude, longitude }: Point) => ({ lat: latitude, lon: longitude });
const pointKey = ({ latitude, longitude }: Point) => `${latitude.toFixed(6)},${longitude.toFixed(6)}`;

function validateEndpoints(origin: Point, destination: Point) {
  if (!validPoint(origin) || !validPoint(destination) || distance(origin, destination) < 10) {
    throw new Error("Choose two different points at least 10 m apart.");
  }
}

async function postJson<T>(url: string, service: string, body: string, headers: Record<string, string>, timeout: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!response.ok) {
      if (response.status === 429) {
        if (service === "Overpass") overpassRetryAt = Date.now() + 30_000;
        throw new Error(`${service} is busy. Try again in a moment.`);
      }
      throw new Error(`${service} returned HTTP ${response.status}.`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${service} timed out. Try again.`);
    if (error instanceof TypeError) throw new Error(`Could not reach ${service}. Check your connection and try again.`);
    if (error instanceof SyntaxError) throw new Error(`${service} returned an invalid response.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function valhalla<T>(action: "route" | "height", body: object) {
  return postJson<T>(`${valhallaUrl}/${action}`, `Valhalla ${action === "route" ? "routing" : "elevation"}`,
    JSON.stringify(body), { "Content-Type": "application/json", "X-Client-Id": "org.walkingstudy.phone" }, 15_000);
}

function decodeShape(shape: string): Point[] {
  let position = 0;
  const delta = () => {
    let value = 0;
    for (let shift = 0; shift <= 25 && position < shape.length; shift += 5) {
      const byte = shape.charCodeAt(position++) - 63;
      if (byte < 0 || byte > 63) break;
      value |= (byte & 31) << shift;
      if (byte < 32) return value & 1 ? ~(value >> 1) : value >> 1;
    }
    throw new Error("Invalid Valhalla polyline.");
  };
  let lat = 0;
  let lon = 0;
  const points: Point[] = [];
  while (position < shape.length) {
    lat += delta();
    lon += delta();
    const point = { latitude: lat / 1e6, longitude: lon / 1e6 };
    if (!validPoint(point)) throw new Error("Invalid Valhalla polyline coordinate.");
    const last = points.at(-1);
    if (!last || distance(last, point) >= 0.5) points.push(point);
  }
  return points;
}

function interpolate(start: Point, end: Point, fraction: number): Point {
  const lonDelta = ((end.longitude - start.longitude + 540) % 360) - 180;
  return { latitude: start.latitude + fraction * (end.latitude - start.latitude),
    longitude: ((start.longitude + fraction * lonDelta + 540) % 360) - 180 };
}

type Trip = { legs?: { shape?: unknown; summary?: { has_ferry?: boolean } }[]; summary?: { has_ferry?: boolean } };
type RouteResponse = { trip?: Trip; alternates?: { trip?: Trip }[] };

export async function requestRoutes(origin: Point, destination: Point) {
  validateEndpoints(origin, destination);
  const result = await valhalla<RouteResponse>("route", {
    locations: [origin, destination].map((point) => ({ ...toLocation(point), search_cutoff: routeParameters.maxSnapMeters })),
    costing: "pedestrian", costing_options: { pedestrian: { shortest: true } },
    alternates: 2, directions_type: "none",
  });
  const trips = [result?.trip, ...(Array.isArray(result?.alternates) ? result.alternates.slice(0, 2).map((entry) => entry?.trip) : [])];
  const seen = new Set<string>();
  const paths = trips.flatMap((trip, index) => {
    if (!Array.isArray(trip?.legs) || trip.legs.length !== 1 || trip.summary?.has_ferry || trip.legs[0]?.summary?.has_ferry) return [];
    const shape = trip.legs[0]?.shape;
    if (typeof shape !== "string" || seen.has(shape)) return [];
    let points: Point[];
    try { points = decodeShape(shape); } catch { return []; }
    if (points.length < 2 || distance(origin, points[0]) > routeParameters.maxSnapMeters ||
        distance(destination, points[points.length - 1]) > routeParameters.maxSnapMeters) return [];
    seen.add(shape);
    const vertices = [{ point: points[0], meters: 0 }];
    // Keep the shape vertices and split long straight sections for grade evaluation.
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1];
      const end = points[i];
      const length = distance(start, end);
      const pieces = Math.ceil(length / elevationInterval);
      const offset = vertices[vertices.length - 1].meters;
      if (vertices.length + pieces > maxEdges + 1) return [];
      for (let part = 1; part <= pieces; part++) {
        const fraction = part / pieces;
        vertices.push({ point: part === pieces ? end : interpolate(start, end, fraction), meters: offset + fraction * length });
      }
    }
    const length = vertices[vertices.length - 1].meters;
    const intervals = Math.max(1, Math.round(length / elevationInterval));
    const spacing = length / intervals;
    let next = 1;
    // Sample evenly along the traveled distance so close shape vertices do not amplify DEM noise.
    const samples = Array.from({ length: intervals + 1 }, (_, i) => {
      if (i === intervals) return vertices[vertices.length - 1].point;
      const meters = i * spacing;
      while (vertices[next].meters < meters) next++;
      const start = vertices[next - 1];
      const end = vertices[next];
      return interpolate(start.point, end.point, (meters - start.meters) / (end.meters - start.meters));
    });
    return [{ id: `valhalla-${index + 1}`, vertices, samples, spacing }];
  });
  if (!paths.length) throw new Error("Valhalla returned no usable walking routes near both endpoints.");

  const shape = paths.flatMap(({ samples }) => samples.map(toLocation));
  const resultHeight = await valhalla<{ height?: unknown[] }>("height", { shape, height_precision: 2 });
  if (!Array.isArray(resultHeight?.height) || resultHeight.height.length !== shape.length) {
    throw new Error("Valhalla returned an incomplete elevation profile.");
  }
  const heights = resultHeight.height;
  const candidates: Candidate[] = [];
  let offset = 0;
  for (const { id, vertices, samples, spacing } of paths) {
    const profile = heights.slice(offset, offset + samples.length);
    offset += samples.length;
    if (!profile.every((height): height is number => typeof height === "number" && Number.isFinite(height))) continue;
    const elevationAt = (meters: number) => {
      const sample = Math.min(profile.length - 1, meters / spacing);
      const lower = Math.floor(sample);
      const upper = Math.ceil(sample);
      return profile[lower] + (profile[upper] - profile[lower]) * (sample - lower);
    };
    candidates.push({ id, edges: vertices.slice(1).map(({ point: end, meters }, index) => {
      const start = vertices[index];
      return { from: pointKey(start.point), to: pointKey(end), start: start.point, end,
        elevationStart: elevationAt(start.meters), elevationEnd: elevationAt(meters), walkable: true,
        elevationQuality: "verified" };
    }) });
  }
  if (!candidates.length) throw new Error("Valhalla has no complete elevation profile for these routes.");
  return scoreRoutes(origin, destination, { graphVersion: "Valhalla OSM graph (unversioned)",
    demVersion: `Valhalla DEM (unversioned, sampled at ~${elevationInterval} m)`, candidates });
}

type OverpassWay = { type?: string; id: number; geometry?: { lat: number; lon: number }[] };

export async function requestMapPaths(origin: Point, destination: Point) {
  validateEndpoints(origin, destination);
  if (Date.now() < overpassRetryAt) throw new Error("Overpass is busy. Try again in a moment.");
  overpassRetryAt = Date.now() + 1_000;
  const filters = [origin, destination].map((point) =>
    `way[highway~"^(footway|path|pedestrian|steps)$"](around:200,${pointKey(point)});`).join("");
  const query = `[out:json][timeout:8];(${filters});out geom;`;
  const data = await postJson<{ elements?: OverpassWay[]; remark?: string }>(overpassUrl, "Overpass",
    `data=${encodeURIComponent(query)}`, { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
      "User-Agent": "WalkingStudy/0.1 (org.walkingstudy.phone)" }, 25_000);
  if (!Array.isArray(data?.elements) || data.remark) throw new Error("Overpass returned incomplete map data.");
  return data.elements.flatMap((way) => {
    if (way?.type !== "way" || !Number.isSafeInteger(way.id) || !Array.isArray(way.geometry)) return [];
    const points = way.geometry.map((point) => ({ latitude: point?.lat, longitude: point?.lon }));
    return points.length >= 2 && points.every(validPoint) ? [{ id: way.id, points }] : [];
  });
}
