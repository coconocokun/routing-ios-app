import { addEvent, appendGps, createTrial, database, write } from "./db.ts";
import type { Route, RouteSet } from "./routes.ts";

export async function saveDemo(route: Route, routes: RouteSet, title: string) {
  const db = await database();
  const id = await createTrial(route, routes, title, "", "demo");
  const start = Date.now() - Math.round(route.minutes * 60_000);
  let along = 0;
  const trace = route.segments.flatMap((segment, segmentIndex) => {
    const base = along;
    along += segment.meters;
    const steps = Math.ceil(segment.meters / 6);
    return Array.from({ length: steps + (segmentIndex === 0 ? 1 : 0) }, (_, i) => {
      const part = (i + (segmentIndex === 0 ? 0 : 1)) / steps;
      const meters = base + part * segment.meters;
      return { observed_at_ms: start + Math.round(meters / 1.25 * 1000), ingested_at_ms: Date.now(),
        lat: segment.start.latitude + part * (segment.end.latitude - segment.start.latitude),
        lon: segment.start.longitude + part * (segment.end.longitude - segment.start.longitude),
        horizontal_accuracy_m: 3, altitude_m: null, vertical_accuracy_m: null, speed_mps: 1.25, heading_deg: null };
    });
  });
  const stop = trace[trace.length - 1].observed_at_ms;
  await write(db, async (tx) => {
    await appendGps(tx, id, trace.filter((_, i) => i < 68 || i > 75));
    await addEvent(tx, id, "start", start);
    await addEvent(tx, id, "clock", start, { offset_ms: 0, uncertainty_ms: 0, synthetic: true });
    await addEvent(tx, id, "stop", stop);
    let seq = 0;
    for (const [i, fix] of trace.entries()) {
      if (i % 2 || (i >= 25 && i <= 31)) continue;
      await tx.runAsync("INSERT INTO hr_samples VALUES (?,?,?,?,?,?,?,?,?,?)", id, `synthetic-${i}`, "synthetic", ++seq,
        fix.observed_at_ms - 250, fix.observed_at_ms + 250, Math.round(87 + i * 0.16 + 7 * Math.sin(i / 8)),
        "synthetic", "[]", Date.now());
    }
    await tx.runAsync("UPDATE trials SET status = 'complete', phone_started_at_ms = ?, phone_stopped_at_ms = ? WHERE id = ?", start, stop, id);
  });
  return id;
}
