import { demVersion, loadElevation } from "./elevation.ts";
import { connectEndpoints, highwayFilter, pedestrianGraph, routeBounds, type OsmElement } from "./pedestrianGraph.ts";
import { findStudyRoutes } from "./routeSearch.ts";
import { distance, studyRouteParameters, type Point, type RouteSet } from "./routes.ts";

const publicOverpassUrls = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const configuredOverpass = process.env.EXPO_PUBLIC_OVERPASS_URL?.trim();
const overpassUrls = configuredOverpass ? [...new Set([configuredOverpass, ...publicOverpassUrls])] : publicOverpassUrls;
const overpassRetryAt = new Map<string, number>();

type OverpassResult = { elements?: OsmElement[]; remark?: string; osm3s?: { timestamp_osm_base?: string } };

async function withRequestTimeout<T>(signal: AbortSignal | undefined, timeoutMs: number, timeoutMessage: string,
  request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) throw signal.reason ?? new Error("Route planning canceled.");
  signal?.addEventListener("abort", stop);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  try {
    const result = await request(controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Route planning canceled.");
    return result;
  } catch (error) {
    stop();
    if (timedOut && !signal?.aborted) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

async function fetchNetwork(endpoint: URL, query: string, signal: AbortSignal) {
  const host = endpoint.host;
  if (Date.now() < (overpassRetryAt.get(host) ?? 0)) throw new Error(`Overpass at ${host} is busy.`);
  let response: Response;
  let data: OverpassResult;
  try {
    if (process.env.EXPO_OS === "web") {
      endpoint.searchParams.set("data", query);
      response = await fetch(endpoint.href, { signal, headers: { "Accept": "application/json" } });
    } else {
      response = await fetch(endpoint.href, { method: "POST", signal,
        body: `data=${encodeURIComponent(query)}`, headers: { "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json", "User-Agent": "WalkingStudy/0.1 (org.walkingstudy.phone)" } });
    }
    if (response.status === 429 || response.status === 406) {
      overpassRetryAt.set(host, Date.now() + 30_000);
    }
    if (!response.ok) throw new Error(`Overpass at ${host} returned HTTP ${response.status}.`);
    data = await response.json();
  } catch (error) {
    if (error instanceof TypeError && !signal.aborted) throw new Error(`Could not reach Overpass at ${host}.`);
    if (error instanceof SyntaxError) throw new Error(`Overpass at ${host} returned an invalid response.`);
    throw error;
  }
  if (!Array.isArray(data?.elements) || data.remark) throw new Error(`Overpass at ${host} returned incomplete map data.`);
  const timestamp = data.osm3s?.timestamp_osm_base;
  const snapshot = timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : "snapshot unspecified";
  const graphVersion = `OpenStreetMap via ${host} (${snapshot})`;
  return { elements: data.elements, graphVersion };
}

async function requestNetwork(bbox: string, signal?: AbortSignal) {
  const query = `[out:json][timeout:12][bbox:${bbox}];way[highway~"^(${highwayFilter})$"];out geom(${bbox});` +
    `(node[barrier];node[ford];node[foot];node[access];node["foot:conditional"];node["access:conditional"];);out body;`;
  const failures: string[] = [];
  for (const url of overpassUrls) {
    try {
      const endpoint = new URL(url);
      return await withRequestTimeout(signal, 15_000, `Overpass at ${endpoint.host} timed out.`,
        (attemptSignal) => fetchNetwork(endpoint, query, attemptSignal));
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(error instanceof Error ? error.message : "Overpass request failed.");
    }
  }
  throw new Error(`Could not load walking map data. ${failures.join(" ")} Try again.`);
}

export async function requestRoutes(origin: Point, destination: Point, signal?: AbortSignal) {
  const bounds = routeBounds(origin, destination);
  const { elements, graphVersion } = await requestNetwork(bounds.query, signal);
  const graph = pedestrianGraph(elements, bounds);
  if (!graph.sampled.length) throw new Error("No walkable OpenStreetMap paths were found near these points.");
  const elevation = await withRequestTimeout(signal, 15_000, "Elevation tiles timed out. Try again.",
    (attemptSignal) => loadElevation(graph.samples.values(), attemptSignal));
  const { segments, from, to } = connectEndpoints(graph, elevation, origin, destination);
  const routes: RouteSet = { origin, destination, graphVersion, demVersion, algorithm: "osm-minetti-1.0.0",
    parameters: studyRouteParameters, demo: false, ...findStudyRoutes(segments, from, to) };
  const mapPaths = graph.mapPaths.filter(({ points }) => points.some((point) =>
    distance(origin, point) <= 200 || distance(destination, point) <= 200));
  return { routes, mapPaths };
}
