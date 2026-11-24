import { distance, project, validPoint, type Point, type Route } from "./routes.ts";
import type { HrSample } from "./protocol.ts";

export type GPS = {
  gps_seq: number;
  observed_at_ms: number;
  ingested_at_ms: number;
  lat: number;
  lon: number;
  horizontal_accuracy_m: number | null;
  altitude_m: number | null;
  vertical_accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
};
export type Event = { type: string; observed_at_ms: number; device: string; payload_json: string };
export const analysisVersion = "trace-1.0.0";
export const policy = { maxAccuracyM: 30, maxSpeedMps: 4, gpsGapMs: 20_000,
  matchMs: 10_000, heatMs: 7_500, gradeWindowM: 40, gradeMatchM: 15, clockMaxUncertaintyMs: 2_000,
  clockMaxAgeMs: 15 * 60_000 };

export function analyze(gps: GPS[], hr: HrSample[], events: Event[], route: Route, lagSeconds = 0) {
  const pauses: [number, number][] = [];
  for (const event of events.filter((e) => e.device === "phone")) {
    if (event.type === "pause") pauses.push([event.observed_at_ms, Infinity]);
    if (["resume", "stop"].includes(event.type) && pauses.at(-1)?.[1] === Infinity) {
      pauses[pauses.length - 1][1] = event.observed_at_ms;
    }
  }
  const clock = events.filter((e) => e.type === "clock").map((e) => ({
    time: e.observed_at_ms, ...JSON.parse(e.payload_json) as { offset_ms: number; uncertainty_ms: number },
  }));
  const flags: Record<number, string[]> = {};
  type Fix = GPS & { point: Point; meters: number; breakBefore: boolean; offRoute: boolean; grade: number | null };
  const trace: Fix[] = [];
  let meters = 0;
  let activeSeconds = 0;
  let offRoutePoints = 0;
  const offsets = [0];
  const horizontalOffsets = [0];
  for (const segment of route.segments) {
    offsets.push(offsets[offsets.length - 1] + segment.meters);
    horizontalOffsets.push(horizontalOffsets[horizontalOffsets.length - 1] + (segment.horizontalMeters ?? segment.meters));
  }
  const profileAt = (along: number) => {
    const index = route.segments.findIndex((_, i) => offsets[i + 1] >= along);
    const i = index < 0 ? route.segments.length - 1 : index;
    const segment = route.segments[i];
    const fraction = index < 0 ? 1 : (along - offsets[i]) / segment.meters;
    return { height: segment.elevationStart + (segment.elevationEnd - segment.elevationStart) * fraction,
      horizontal: horizontalOffsets[i] + (segment.horizontalMeters ?? segment.meters) * fraction };
  };
  for (const fix of [...gps].sort((a, b) => a.observed_at_ms - b.observed_at_ms || a.gps_seq - b.gps_seq)) {
    const point = { latitude: fix.lat, longitude: fix.lon };
    const currentFlags: string[] = [];
    flags[fix.gps_seq] = currentFlags;
    const last = trace.at(-1);
    const elapsedMs = last ? fix.observed_at_ms - last.observed_at_ms : 0;
    const delta = last && validPoint(point) ? distance(last.point, point) : 0;
    if (!validPoint(point) || !Number.isFinite(fix.observed_at_ms)) currentFlags.push("invalid_position_or_time");
    if (fix.horizontal_accuracy_m === null || fix.horizontal_accuracy_m < 0 ||
        fix.horizontal_accuracy_m > policy.maxAccuracyM) currentFlags.push("low_accuracy");
    if (last && elapsedMs <= 0) currentFlags.push("repeated_timestamp");
    if (pauses.some(([start, end]) => fix.observed_at_ms >= start && fix.observed_at_ms < end)) currentFlags.push("paused");
    if (last && elapsedMs > 0 && elapsedMs <= policy.gpsGapMs &&
        delta > policy.maxSpeedMps * elapsedMs / 1000 + Math.hypot(last.horizontal_accuracy_m ?? 0, fix.horizontal_accuracy_m ?? 0)) {
      currentFlags.push("position_jump");
    }
    if (currentFlags.length) continue;
    const breakBefore = !last || elapsedMs > policy.gpsGapMs ||
      pauses.some(([start, end]) => start < fix.observed_at_ms && end > last.observed_at_ms);
    if (last && !breakBefore) {
      activeSeconds += elapsedMs / 1000;
      const jitter = Math.max(2, Math.min(8, (last.horizontal_accuracy_m ?? 0) / 2));
      if (delta >= jitter) meters += delta;
    }
    const match = project(point, route);
    const offRoute = match.separation > 30;
    if (offRoute) offRoutePoints++;
    const low = Math.max(0, match.along - policy.gradeWindowM / 2);
    const high = Math.min(route.meters, match.along + policy.gradeWindowM / 2);
    let grade = null;
    if (match.separation <= policy.gradeMatchM && high - low >= policy.gradeWindowM / 2) {
      const start = profileAt(low);
      const end = profileAt(high);
      grade = (end.height - start.height) / (end.horizontal - start.horizontal);
    }
    trace.push({ ...fix, point, meters, breakBefore, offRoute, grade });
  }

  const interpolate = (time: number) => {
    let low = 0;
    let high = trace.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (trace[middle].observed_at_ms < time) low = middle + 1;
      else high = middle;
    }
    const end = trace[low];
    if (!end) return null;
    if (end.observed_at_ms === time) return { point: end.point, meters: end.meters, grade: end.grade, gap: 0, interpolated: false };
    const start = trace[low - 1];
    if (!start || end.breakBefore) return null;
    const gap = Math.max(time - start.observed_at_ms, end.observed_at_ms - time);
    if (gap > policy.matchMs) return null;
    const fraction = (time - start.observed_at_ms) / (end.observed_at_ms - start.observed_at_ms);
    const lerp = (a: number, b: number) => a + (b - a) * fraction;
    const lonStep = ((end.lon - start.lon + 540) % 360) - 180;
    return { point: { latitude: lerp(start.lat, end.lat), longitude: ((start.lon + lonStep * fraction + 540) % 360) - 180 },
      meters: lerp(start.meters, end.meters), grade: start.grade !== null && end.grade !== null ?
        lerp(start.grade, end.grade) : null, gap, interpolated: true };
  };

  const aligned = hr.map((sample) => {
    const midpoint = (sample.sample_start_at_ms + sample.sample_end_at_ms) / 2;
    const confidence = clock.reduce<(typeof clock)[number] | undefined>((best, probe) =>
      !best || Math.abs(probe.time - midpoint) < Math.abs(best.time - midpoint) ? probe : best, undefined);
    const clockGood = confidence && Math.abs(confidence.time - midpoint) <= policy.clockMaxAgeMs &&
      confidence.uncertainty_ms <= policy.clockMaxUncertaintyMs;
    const time = clockGood ? midpoint - confidence.offset_ms : midpoint;
    const match = clockGood && !sample.quality_flags.length ? interpolate(time) : null;
    const gradeMatch = lagSeconds && match ? interpolate(time - lagSeconds * 1000) : match;
    return { ...sample, time, meters: match?.meters ?? null, grade: gradeMatch?.grade ?? null,
      grade_meters: gradeMatch?.meters ?? null, is_observed: true, is_interpolated: match?.interpolated ?? false,
      match_gap_s: match ? match.gap / 1000 : null,
      clock_uncertainty_ms: confidence?.uncertainty_ms ?? null,
      match_flags: [...sample.quality_flags, ...(!clockGood ? ["uncertain_clock"] : []),
        ...(!match ? ["unmatched_gps"] : []), ...(gradeMatch?.grade == null ? ["missing_grade"] : [])] };
  }).sort((a, b) => a.time - b.time);
  const spatial = aligned.filter((row) => row.meters !== null);
  let index = 0;
  const traceSegments = trace.slice(1).flatMap((end, i) => {
    if (end.breakBefore) return [];
    const start = trace[i];
    const mid = (start.observed_at_ms + end.observed_at_ms) / 2;
    while (spatial[index + 1] && Math.abs(spatial[index + 1].time - mid) <= Math.abs(spatial[index].time - mid)) index++;
    const nearest = spatial[index];
    return [{ start: start.point, end: end.point,
      bpm: nearest && Math.max(Math.abs(nearest.time - start.observed_at_ms),
        Math.abs(nearest.time - end.observed_at_ms)) <= policy.heatMs ? nearest.bpm : null }];
  });
  const bpm = hr.filter((row) => !row.quality_flags.length).map((row) => row.bpm).sort((a, b) => a - b);
  const n = bpm.length;
  const summary = {
    meters, gpsCoveredSeconds: activeSeconds, averageSpeedMps: activeSeconds ? meters / activeSeconds : null,
    meanBpm: n ? bpm.reduce((a, b) => a + b, 0) / n : null,
    medianBpm: n ? (bpm[Math.floor((n - 1) / 2)] + bpm[Math.floor(n / 2)]) / 2 : null,
    maxBpm: n ? bpm[n - 1] : null, gpsCount: gps.length, acceptedGpsCount: trace.length, hrCount: hr.length,
    matchedFraction: hr.length ? spatial.length / hr.length : null,
    gradePairs: aligned.filter((row) => row.grade !== null).length,
    offRouteFraction: trace.length ? offRoutePoints / trace.length : null,
    gpsBreakCount: trace.slice(1).filter((fix) => fix.breakBefore).length,
    longestHrGapS: aligned.reduce((max, row, i) => i ? Math.max(max, (row.time - aligned[i - 1].time) / 1000) : max, 0),
  };
  return { trace, traceSegments, aligned, flags, summary, interpolate };
}

export function walkDuration(events: Event[], start: number, end: number) {
  const wall = Math.max(0, end - start);
  let paused = 0;
  let from: number | null = null;
  for (const event of events.filter((e) => e.device === "phone" && e.observed_at_ms >= start && e.observed_at_ms <= end)) {
    if (event.type === "pause" && from === null) from = event.observed_at_ms;
    if (event.type === "resume" && from !== null) {
      paused += event.observed_at_ms - from;
      from = null;
    }
  }
  if (from !== null) paused += end - from;
  return { active: Math.max(0, wall - paused), paused, wall };
}
