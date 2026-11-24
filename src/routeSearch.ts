import { studyRouteParameters, summarizeRoute, type Route, type RouteLabel, type Segment } from "./routes.ts";

class MinHeap<T extends { priority: number }> {
  private items: T[] = [];

  push(item: T) {
    const items = this.items;
    let index = items.length;
    items.push(item);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (items[parent].priority <= item.priority) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop(): T | undefined {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (!last || !items.length) return first;
    let index = 0;
    while (index * 2 + 1 < items.length) {
      let child = index * 2 + 1;
      if (child + 1 < items.length && items[child + 1].priority < items[child].priority) child++;
      if (last.priority <= items[child].priority) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return first;
  }
}

type Adjacency = Map<string, Segment[]>;
type Path = { node: string; meters: number; energy: number; edge?: Segment; previous?: Path };
type QueuedPath = Path & { priority: number };

function adjacency(segments: Segment[], key: "from" | "to"): Adjacency {
  const result: Adjacency = new Map();
  for (const edge of segments) {
    const list = result.get(edge[key]);
    if (list) list.push(edge);
    else result.set(edge[key], [edge]);
  }
  return result;
}

// Search from the destination on incoming edges. The edge cost still uses its original travel direction.
function pathsTo(incoming: Adjacency, destination: string, weight: "meters" | "energy") {
  const start = { node: destination, meters: 0, energy: 0, priority: 0 };
  const best = new Map<string, QueuedPath>([[destination, start]]);
  const queue = new MinHeap<QueuedPath>();
  queue.push(start);
  const tiebreak = weight === "meters" ? "energy" : "meters";
  for (let path = queue.pop(); path; path = queue.pop()) {
    if (best.get(path.node) !== path) continue;
    for (const edge of incoming.get(path.node) ?? []) {
      const next = { node: edge.from, meters: path.meters + edge.meters,
        energy: path.energy + edge.cost * edge.meters, edge, previous: path };
      const prior = best.get(next.node);
      if (prior && (prior[weight] < next[weight] ||
          (prior[weight] === next[weight] && prior[tiebreak] <= next[tiebreak]))) continue;
      const entry = { ...next, priority: next[weight] };
      best.set(next.node, entry);
      queue.push(entry);
    }
  }
  return best;
}

function unpack(path: Path) {
  const segments: Segment[] = [];
  for (let step: Path | undefined = path; step?.edge; step = step.previous) segments.push(step.edge);
  return segments;
}

function constrainedPath(segments: Segment[], from: string, to: string, limit: number) {
  const { minDownhillGrade, maxUphillGrade } = studyRouteParameters;
  const allowed = segments.filter(({ grade }) => grade >= minDownhillGrade && grade <= maxUphillGrade);
  const incoming = adjacency(allowed, "to");
  const distances = pathsTo(incoming, to, "meters");
  // Different addition orders of the same edge lengths can differ by floating-point roundoff.
  limit += 1e-6;
  if ((distances.get(from)?.meters ?? Infinity) > limit) return {};
  const energies = pathsTo(incoming, to, "energy");
  const minEnergy = energies.get(from)!;
  if (minEnergy.meters <= limit) return { segments: unpack(minEnergy) };

  const outgoing = adjacency(allowed, "from");
  const start = { node: from, meters: 0, energy: 0, priority: minEnergy.energy };
  const queue = new MinHeap<QueuedPath>();
  const frontier = new Map<string, QueuedPath[]>([[from, [start]]]);
  queue.push(start);
  let labels = 1;
  for (let path = queue.pop(); path; path = queue.pop()) {
    if (!frontier.get(path.node)?.includes(path)) continue;
    if (path.node === to) return { segments: unpack(path).reverse() };
    for (const edge of outgoing.get(path.node) ?? []) {
      const meters = path.meters + edge.meters;
      if (meters + (distances.get(edge.to)?.meters ?? Infinity) > limit) continue;
      const energy = path.energy + edge.cost * edge.meters;
      const existing = frontier.get(edge.to) ?? [];
      // A longer label can still win on energy, so keep both when neither dominates the other.
      if (existing.some((label) => label.meters <= meters && label.energy <= energy)) continue;
      if (++labels > 50_000) return { exhausted: true };
      const next = { node: edge.to, meters, energy, edge, previous: path,
        priority: energy + energies.get(edge.to)!.energy };
      frontier.set(edge.to, [...existing.filter((label) => label.meters < meters || label.energy < energy), next]);
      queue.push(next);
    }
  }
  return {};
}

export function findStudyRoutes(segments: Segment[], from: string, to: string) {
  const incoming = adjacency(segments, "to");
  const shortest = pathsTo(incoming, to, "meters").get(from);
  if (!shortest?.edge) throw new Error("No walking route connects these points with usable terrain data.");
  const energy = pathsTo(incoming, to, "energy").get(from)!;
  const constrained = constrainedPath(segments, from, to, shortest.meters * studyRouteParameters.maxDetour);
  const routes: Route[] = [];
  const add = (id: string, label: RouteLabel, path: Segment[]) => {
    const identical = routes.find((route) => route.segments.length === path.length &&
      route.segments.every((edge, index) => edge.from === path[index].from && edge.to === path[index].to));
    const route = identical ?? summarizeRoute(id, path);
    route.labels.push(label);
    if (!identical) routes.push(route);
  };
  add("shortest", "Shortest", unpack(shortest));
  add("minimum-energy", "Minimum energy", unpack(energy));
  if (constrained.segments) add("grade-constrained", "Grade constrained", constrained.segments);
  const warning = constrained.exhausted ? "The grade-constrained search reached its processing limit." :
    !constrained.segments ? "No route meets the grade and detour limits." : undefined;
  return { candidates: routes, choices: routes, warning };
}
