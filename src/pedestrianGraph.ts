import { distance, studyRouteParameters, validPoint, walkingCost, type Point, type Segment } from "./routes.ts";

type Tags = Record<string, string | undefined>;
type OsmPoint = { lat: number; lon: number };
export type OsmElement = { type: string; id: number; tags?: Tags; nodes?: number[];
  geometry?: (OsmPoint | null)[] };
type Vertex = { id: string; point: Point };
type Link = { start: Vertex; end: Vertex; forward: boolean; backward: boolean };
type RatedVertex = Vertex & { height: number };
type RatedLink = Link & { start: RatedVertex; end: RatedVertex };
export type MapPath = { id: string; points: Point[] };

const metersPerDegree = Math.PI * 6_371_000 / 180;
const radians = Math.PI / 180;
const wrap = (degrees: number) => ((degrees + 540) % 360) - 180;

function interpolate(start: Point, end: Point, fraction: number): Point {
  return { latitude: start.latitude + (end.latitude - start.latitude) * fraction,
    longitude: wrap(start.longitude + wrap(end.longitude - start.longitude) * fraction) };
}

export function routeBounds(origin: Point, destination: Point) {
  if (!validPoint(origin) || !validPoint(destination)) {
    throw new Error("Choose valid start and destination points.");
  }
  const direct = distance(origin, destination);
  if (direct < 10) {
    throw new Error("Choose two different points at least 10 m apart.");
  }
  if (direct > 5_000 || Math.max(Math.abs(origin.latitude), Math.abs(destination.latitude)) > 80) {
    throw new Error("Choose points within 5 km of each other and between 80°S and 80°N.");
  }
  const padding = Math.min(1200, Math.max(300, direct * 0.4));
  const latPad = padding / metersPerDegree;
  const lonPad = latPad / Math.cos(Math.max(Math.abs(origin.latitude), Math.abs(destination.latitude)) * radians);
  const lonStep = wrap(destination.longitude - origin.longitude);
  const south = Math.min(origin.latitude, destination.latitude) - latPad;
  const north = Math.max(origin.latitude, destination.latitude) + latPad;
  const west = Math.min(0, lonStep) - lonPad;
  const east = Math.max(0, lonStep) + lonPad;
  return {
    query: [south, wrap(origin.longitude + west), north, wrap(origin.longitude + east)].map((value) => value.toFixed(7)).join(","),
    contains: ({ latitude, longitude }: Point) => {
      const delta = wrap(longitude - origin.longitude);
      return latitude >= south && latitude <= north && delta >= west && delta <= east;
    },
  };
}

const footpaths = ["footway", "path", "pedestrian"];
const localRoads = ["living_street", "residential", "unclassified", "service", "track"];
const mainRoads = ["primary", "secondary", "tertiary"];
const explicitFootways = ["cycleway", "bridleway"];
export const highwayFilter = [footpaths, localRoads, mainRoads, explicitFootways]
  .flat().join("|");
const allowed = (value?: string) => value !== undefined && /^(yes|designated|permissive|official)$/.test(value);
const active = (value?: string) => value !== undefined && value !== "no";

function directions(tags: Tags) {
  const highway = tags.highway ?? "";
  if (active(tags.bridge) || active(tags.tunnel) || active(tags.ford) || tags.area === "yes" ||
      tags.motorroad === "yes" || tags.sidewalk === "separate" || tags["foot:conditional"] || tags["access:conditional"] ||
      tags["oneway:foot:conditional"] || tags["foot:forward:conditional"] || tags["foot:backward:conditional"] ||
      /^(sand|mud|snow|ice)$/.test(tags.surface ?? "") || (tags.sac_scale && tags.sac_scale !== "hiking")) return;
  const assumed = footpaths.includes(highway) || localRoads.includes(highway) ||
    (mainRoads.includes(highway) && /^(yes|both|left|right)$/.test(tags.sidewalk ?? ""));
  if (!assumed && !mainRoads.includes(highway) && !explicitFootways.includes(highway)) return;
  const permits = (value?: string) => allowed(value ?? tags.foot ?? tags.access) ||
    (assumed && value === undefined && tags.foot === undefined && tags.access === undefined);
  const oneWay = tags["oneway:foot"] ?? (footpaths.includes(highway) ? tags.oneway : undefined);
  return { forward: permits(tags["foot:forward"]) && oneWay !== "-1" && oneWay !== "reverse",
    backward: permits(tags["foot:backward"]) && !/^(yes|1|true)$/.test(oneWay ?? "") };
}

function blockedNode(tags: Tags) {
  return active(tags.ford) || tags["foot:conditional"] || tags["access:conditional"] ||
    (tags.foot !== undefined ? !allowed(tags.foot) :
      (tags.access !== undefined && !allowed(tags.access)) || tags.locked === "yes" ||
      /^(fence|wall|hedge|retaining_wall|block|gate|lift_gate|swing_gate|chain)$/.test(tags.barrier ?? ""));
}

export function pedestrianGraph(elements: OsmElement[], bounds: ReturnType<typeof routeBounds>) {
  const blocked = new Set(elements.filter((node) => node?.type === "node" && blockedNode(node.tags ?? {}))
    .map((node) => node.id));
  const vertices = new Map<string, Vertex>();
  const links = new Map<string, Link>();
  const mapPaths: MapPath[] = [];
  const ways = elements.filter((way) => way?.type === "way" && Number.isSafeInteger(way.id)).sort((a, b) => a.id - b.id);
  for (const way of ways) {
    const permission = directions(way.tags ?? {});
    if (!permission || (!permission.forward && !permission.backward) || !Array.isArray(way.nodes) ||
        !Array.isArray(way.geometry) || way.nodes.length !== way.geometry.length) continue;
    let previous: Vertex | undefined;
    let overlay: Point[] = [];
    for (let index = 0; index < way.nodes.length; index++) {
      const geometry = way.geometry[index];
      const node = way.nodes[index];
      const point = geometry && { latitude: geometry.lat, longitude: geometry.lon };
      if (!Number.isSafeInteger(node) || blocked.has(node) || !validPoint(point) || !bounds.contains(point)) {
        previous = undefined;
        overlay = [];
        continue;
      }
      const id = `osm-${node}`;
      const vertex = vertices.get(id) ?? { id, point };
      vertices.set(id, vertex);
      if (footpaths.includes(way.tags?.highway ?? "")) {
        if (overlay.length === 1) mapPaths.push({ id: `${way.id}-${index}`, points: overlay });
        overlay.push(vertex.point);
      }
      if (previous && previous.id !== id) {
        const order = previous.id < id;
        const [a, b] = order ? [previous, vertex] : [vertex, previous];
        const key = `${a.id}:${b.id}`;
        const old = links.get(key);
        if (old) {
          old.forward ||= order ? permission.forward : permission.backward;
          old.backward ||= order ? permission.backward : permission.forward;
        } else links.set(key, { start: a, end: b, forward: order ? permission.forward : permission.backward,
          backward: order ? permission.backward : permission.forward });
      }
      previous = vertex;
    }
  }

  const sampled: Link[] = [];
  const samples = new Map<string, Point>();
  for (const [id, link] of links) {
    const length = distance(link.start.point, link.end.point);
    if (length < 0.05) continue;
    const parts = Math.ceil(length / studyRouteParameters.elevationIntervalMeters);
    let start = link.start;
    for (let part = 1; part <= parts; part++) {
      const end = part === parts ? link.end : { id: `${id}-${part}`, point: interpolate(link.start.point, link.end.point, part / parts) };
      samples.set(start.id, start.point);
      samples.set(end.id, end.point);
      sampled.push({ ...link, start, end });
      if (sampled.length > 50_000) throw new Error("The walking network is too large. Choose closer points.");
      start = end;
    }
  }
  return { sampled, samples, mapPaths };
}

function nearest(point: Point, links: RatedLink[], id: string) {
  const xScale = Math.cos(point.latitude * radians);
  let best: { link: RatedLink; vertex: RatedVertex; fraction: number; separation: number } | undefined;
  for (const link of links) {
    const { start, end } = link;
    const x = wrap(point.longitude - start.point.longitude) * xScale;
    const y = point.latitude - start.point.latitude;
    const dx = wrap(end.point.longitude - start.point.longitude) * xScale;
    const dy = end.point.latitude - start.point.latitude;
    const length = Math.hypot(dx, dy) * metersPerDegree;
    let fraction = Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy)));
    if (fraction * length < 0.05) fraction = 0;
    if ((1 - fraction) * length < 0.05) fraction = 1;
    const vertex = fraction === 0 ? start : fraction === 1 ? end : { id,
      point: interpolate(start.point, end.point, fraction), height: start.height + fraction * (end.height - start.height) };
    const separation = distance(point, vertex.point);
    if (!best || separation < best.separation) best = { link, vertex, fraction, separation };
  }
  if (!best || best.separation > studyRouteParameters.maxSnapMeters) {
    throw new Error(`No walking path with usable terrain data within ${studyRouteParameters.maxSnapMeters} m of the ${id}.`);
  }
  return best;
}

export function connectEndpoints({ sampled, samples }: ReturnType<typeof pedestrianGraph>,
  elevation: (point: Point) => number, origin: Point, destination: Point) {
  const heights = new Map([...samples].map(([id, point]) => [id, elevation(point)]));
  const rated = sampled.flatMap((link): RatedLink[] => {
    const start = { ...link.start, height: heights.get(link.start.id)! };
    const end = { ...link.end, height: heights.get(link.end.id)! };
    const grade = (end.height - start.height) / distance(start.point, end.point);
    return Number.isFinite(grade) && Math.abs(grade) <= studyRouteParameters.maxAbsoluteGrade ? [{ ...link, start, end }] : [];
  });
  const start = nearest(origin, rated, "start point");
  const end = nearest(destination, rated, "destination");
  if (start.vertex.id === end.vertex.id || (start.link === end.link && distance(start.vertex.point, end.vertex.point) < 0.05)) {
    throw new Error("Choose points that connect to different locations on the walking network.");
  }
  const cuts = [start, end].filter(({ fraction }) => fraction > 0 && fraction < 1).sort((a, b) => a.fraction - b.fraction);
  const segments: Segment[] = [];
  const add = (a: RatedVertex, b: RatedVertex) => {
    const horizontalMeters = distance(a.point, b.point);
    const rise = b.height - a.height;
    const grade = rise / horizontalMeters;
    segments.push({ from: a.id, to: b.id, start: a.point, end: b.point, walkable: true, elevationQuality: "verified",
      elevationStart: a.height, elevationEnd: b.height, horizontalMeters, meters: Math.hypot(horizontalMeters, rise),
      grade, cost: walkingCost(grade) });
  };
  for (const link of rated) {
    const points = [link.start, ...cuts.filter((cut) => cut.link === link).map((cut) => cut.vertex), link.end];
    for (let i = 1; i < points.length; i++) {
      if (link.forward) add(points[i - 1], points[i]);
      if (link.backward) add(points[i], points[i - 1]);
    }
  }
  return { segments, from: start.vertex.id, to: end.vertex.id };
}
