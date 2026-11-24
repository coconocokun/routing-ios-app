export type Point = { latitude: number; longitude: number };
export type RouteLabel = "Shortest" | "Minimum energy" | "Grade constrained" | "Lowest J/kg/m" | "Balanced";
export type Edge = {
  from: string;
  to: string;
  start: Point;
  end: Point;
  elevationStart: number;
  elevationEnd: number;
  walkable: boolean;
  elevationQuality: "verified" | "missing";
};
export type Candidate = { id: string; edges: Edge[] };
export type Segment = Edge & { meters: number; horizontalMeters?: number; grade: number; cost: number };
export type Route = {
  id: string;
  labels: RouteLabel[];
  segments: Segment[];
  geometry: Point[];
  meters: number;
  gain: number;
  loss: number;
  total: number;
  mean: number;
  maxGrade: number;
  minutes: number;
  warnings: string[];
};
export type RouteSet = {
  origin: Point;
  destination: Point;
  graphVersion: string;
  demVersion: string;
  algorithm: string;
  parameters: typeof walkingParameters & { maxDetour: number; minDistinctFraction?: number;
    minDownhillGrade?: number; maxUphillGrade?: number; elevationIntervalMeters?: number };
  candidates: Route[];
  choices: Route[];
  warning?: string;
  demo: boolean;
};

const walkingParameters = { maxAbsoluteGrade: 0.25, metersPerSecond: 1.25, maxSnapMeters: 60 };
export const routeParameters = { ...walkingParameters, maxDetour: 1.35, minDistinctFraction: 0.1 };
export const studyRouteParameters = {
  ...walkingParameters, maxDetour: 1.3, minDownhillGrade: -0.08, maxUphillGrade: 0.08,
  elevationIntervalMeters: 30,
};
export const routeColors: Record<RouteLabel, string> = { Shortest: "#2556be", "Minimum energy": "#007762",
  "Grade constrained": "#a45817", "Lowest J/kg/m": "#007762", Balanced: "#a45817" };

export function validPoint(point: unknown): point is Point {
  if (!point || typeof point !== "object") return false;
  const p = point as Point;
  return Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
}

const radians = Math.PI / 180;
const radius = 6_371_000;
const lonDelta = (degrees: number) => ((degrees + 540) % 360) - 180;
export function distance(a: Point, b: Point) {
  const h = Math.sin((b.latitude - a.latitude) * radians / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) *
    Math.sin(lonDelta(b.longitude - a.longitude) * radians / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function walkingCost(grade: number) {
  return 280.5 * grade ** 5 - 58.7 * grade ** 4 - 76.8 * grade ** 3 +
    51.9 * grade ** 2 + 19.6 * grade + 2.5;
}

export function summarizeRoute(id: string, segments: Segment[]): Route {
  const meters = segments.reduce((sum, segment) => sum + segment.meters, 0);
  const total = segments.reduce((sum, segment) => sum + segment.cost * segment.meters, 0);
  const gain = segments.reduce((sum, segment) => sum + Math.max(0, segment.elevationEnd - segment.elevationStart), 0);
  const loss = segments.reduce((sum, segment) => sum + Math.max(0, segment.elevationStart - segment.elevationEnd), 0);
  const maxGrade = segments.reduce((max, segment) => Math.max(max, Math.abs(segment.grade)), 0);
  return { id, labels: [], segments, geometry: [segments[0].start, ...segments.map((segment) => segment.end)],
    meters, total, mean: total / meters, gain, loss, maxGrade, minutes: meters / walkingParameters.metersPerSecond / 60,
    warnings: maxGrade >= 0.12 ? ["Includes grade of at least 12%."] : [] };
}

export function project(point: Point, route: Route) {
  const xScale = radius * radians * Math.cos(point.latitude * radians);
  const yScale = radius * radians;
  let best = { separation: Infinity, along: 0, fraction: 0, segmentIndex: 0 };
  let traveled = 0;
  route.segments.forEach(({ start, end, meters }, segmentIndex) => {
    const ax = lonDelta(start.longitude - point.longitude) * xScale;
    const ay = (start.latitude - point.latitude) * yScale;
    const dx = lonDelta(end.longitude - start.longitude) * xScale;
    const dy = (end.latitude - start.latitude) * yScale;
    const fraction = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
    const separation = Math.hypot(ax + fraction * dx, ay + fraction * dy);
    if (separation < best.separation) best = { separation, along: traveled + fraction * meters, fraction, segmentIndex };
    traveled += meters;
  });
  return best;
}

export function scoreRoutes(
  origin: Point, destination: Point,
  input: { graphVersion: string; demVersion: string; candidates: Candidate[] }, demo = false,
): RouteSet {
  if (!validPoint(origin) || !validPoint(destination) || distance(origin, destination) < 10) {
    throw new Error("Choose two different points at least 10 m apart.");
  }
  if (!input || typeof input.graphVersion !== "string" || !input.graphVersion.trim() ||
      typeof input.demVersion !== "string" || !input.demVersion.trim() ||
      !Array.isArray(input.candidates) || input.candidates.length > 50) {
    throw new Error("The route service returned invalid dataset metadata or candidates.");
  }
  const { maxAbsoluteGrade, maxDetour, maxSnapMeters, minDistinctFraction } = routeParameters;
  const candidates: Route[] = [];
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id) ||
        !Array.isArray(candidate.edges) || !candidate.edges.length || candidate.edges.length > 5000) continue;
    const nodes = new Set<string>();
    const segments: Segment[] = [];
    for (const edge of candidate.edges) {
      if (!edge || edge.walkable !== true || edge.elevationQuality !== "verified" ||
          !validPoint(edge.start) || !validPoint(edge.end) || !edge.from || !edge.to ||
          typeof edge.from !== "string" || typeof edge.to !== "string" || edge.from === edge.to ||
          !Number.isFinite(edge.elevationStart) || !Number.isFinite(edge.elevationEnd)) break;
      const previous = segments.at(-1);
      if (nodes.has(edge.to) || (previous && (previous.to !== edge.from ||
          distance(previous.end, edge.start) > 0.5 ||
          Math.abs(previous.elevationEnd - edge.elevationStart) > 0.5))) break;
      const meters = distance(edge.start, edge.end);
      const grade = (edge.elevationEnd - edge.elevationStart) / meters;
      if (meters < 0.5 || !Number.isFinite(grade) || Math.abs(grade) > maxAbsoluteGrade) break;
      nodes.add(edge.from);
      nodes.add(edge.to);
      segments.push({ ...edge, meters, grade, cost: walkingCost(grade) });
    }
    if (segments.length !== candidate.edges.length ||
        distance(segments[0].start, origin) > maxSnapMeters ||
        distance(segments[segments.length - 1].end, destination) > maxSnapMeters) continue;
    ids.add(candidate.id);
    candidates.push(summarizeRoute(candidate.id, segments));
  }
  candidates.sort((a, b) => a.meters - b.meters || (a.id < b.id ? -1 : 1));
  const shortest = candidates[0];
  if (!shortest) throw new Error("No candidate met the walking access and elevation checks.");
  const feasible = candidates.filter((route) => route.meters <= shortest.meters * maxDetour);
  const minTotal = Math.min(...feasible.map((route) => route.total));
  const maxTotal = Math.max(...feasible.map((route) => route.total));
  const maxDistance = Math.max(...feasible.map((route) => route.meters));
  const balanced = (route: Route) =>
    0.5 * (route.meters - shortest.meters) / (maxDistance - shortest.meters || 1) +
    0.5 * (route.total - minTotal) / (maxTotal - minTotal || 1);
  const winner = (score: (route: Route) => number) =>
    feasible.reduce((best, route) => score(route) < score(best) ? route : best);
  const choices: Route[] = [];
  for (const [label, route] of [
    ["Shortest", shortest], ["Lowest J/kg/m", winner((route) => route.mean)], ["Balanced", winner(balanced)],
  ] as [RouteLabel, Route][]) {
    route.labels.push(label);
    const overlap = choices.find((choice) => {
      const edges = new Set(choice.segments.map(({ from, to }) => JSON.stringify([from, to].sort())));
      const shared = route.segments.reduce((sum, edge) =>
        sum + (edges.has(JSON.stringify([edge.from, edge.to].sort())) ? edge.meters : 0), 0);
      return route.id === choice.id || shared / Math.max(route.meters, choice.meters) > 1 - minDistinctFraction;
    });
    if (!overlap) choices.push({ ...route, labels: [label], warnings: [...route.warnings] });
    else if (overlap.id === route.id) overlap.labels.push(label);
    else overlap.warnings.push(`${label} substantially overlaps this path and is hidden from the map.`);
  }
  return { origin, destination, graphVersion: input.graphVersion, demVersion: input.demVersion,
    algorithm: "minetti-candidates-1.0.0", parameters: routeParameters, candidates, choices, demo };
}

export function demoRoutes() {
  const origin = { latitude: 37.7696, longitude: -122.4881 };
  const destination = { latitude: 37.7696, longitude: -122.4791 };
  const path = (id: string, offset: number, elevations: number[]): Candidate => {
    const points = [origin, ...[0.23, 0.48, 0.73].map((fraction) => ({
      latitude: origin.latitude + offset,
      longitude: origin.longitude + fraction * (destination.longitude - origin.longitude),
    })), destination];
    const keys = ["origin", ...[1, 2, 3].map((index) => `${id}-${index}`), "destination"];
    return { id, edges: points.slice(1).map((end, i) => ({
      from: keys[i], to: keys[i + 1], start: points[i], end, elevationStart: elevations[i],
      elevationEnd: elevations[i + 1], walkable: true, elevationQuality: "verified",
    })) };
  };
  return scoreRoutes(origin, destination, {
    graphVersion: "synthetic-grid-1", demVersion: "synthetic-elevation-1",
    candidates: [
      path("direct", 0.0002, [30, 55, 75, 51, 35]),
      path("middle", -0.0012, [30, 40, 44, 42, 35]),
      path("low-grade", 0.00205, [30, 31, 32, 33, 35]),
    ],
  }, true);
}
