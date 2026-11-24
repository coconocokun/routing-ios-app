import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { strToU8, zipSync } from "fflate";
import { analysisVersion, analyze, policy, walkDuration } from "./analysis.ts";
import { database, type readTrial } from "./db.ts";
import { version } from "./protocol.ts";

type Walk = NonNullable<Awaited<ReturnType<typeof readTrial>>>;
type Row = Record<string, unknown>;
const csv = (columns: string[], rows: Row[]) => [columns.join(","), ...rows.map((row) => columns.map((key) => {
  const value = row[key];
  if (value === null || value === undefined) return "";
  const plain = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${plain.replace(/"/g, '""')}"`;
}).join(","))].join("\r\n") + "\r\n";
const json = (value: unknown) => JSON.stringify(value, null, 2);

export async function exportWalk(walk: Walk, shareCoordinates: boolean, lagSeconds: number) {
  if (!await Sharing.isAvailableAsync()) throw new Error("The iOS share sheet is unavailable.");
  const { trial, gps, hr, events, route, routes } = walk;
  const trialMetadata = { trial_id: trial.id, status: trial.status, mode: trial.mode,
    protocol_version: version, route_labels: route.labels, participant_code: trial.participant,
    ...(shareCoordinates ? { title: trial.title, created_at_ms: trial.created_at_ms, timezone: trial.timezone,
      phone_started_at_ms: trial.phone_started_at_ms, phone_stopped_at_ms: trial.phone_stopped_at_ms,
      watch_started_at_ms: trial.watch_started_at_ms, watch_stopped_at_ms: trial.watch_stopped_at_ms,
      watch_session_id: trial.watch_session_id, reason: trial.reason } : {}) };
  const derived = analyze(gps, hr, events, route, lagSeconds);
  const elapsed = trial.phone_started_at_ms !== null && trial.phone_stopped_at_ms !== null ?
    walkDuration(events, trial.phone_started_at_ms, trial.phone_stopped_at_ms) : null;
  const metrics = { ...derived.summary, wall_duration_s: elapsed ? elapsed.wall / 1000 : null,
    active_duration_s: elapsed ? elapsed.active / 1000 : null, paused_duration_s: elapsed ? elapsed.paused / 1000 : null };
  const summary = { analysis_version: analysisVersion, policy, lag_seconds: lagSeconds, metrics,
    route_prediction: { meters: route.meters, ascent_m: route.gain, descent_m: route.loss, total_j_kg: route.total,
      mean_j_kg_m: route.mean, algorithm: routes.algorithm, graph_version: routes.graphVersion, dem_version: routes.demVersion } };
  const originTime = trial.phone_started_at_ms ?? gps[0]?.observed_at_ms ?? hr[0]?.sample_start_at_ms ?? trial.created_at_ms;
  const timeColumn = shareCoordinates ? "aligned_at_ms" : "seconds_from_start";
  const derivedRows = derived.aligned.map((row) => ({
    [timeColumn]: shareCoordinates ? row.time : (row.time - originTime) / 1000,
    ...(shareCoordinates ? { sample_id: row.sample_id } : {}),
    bpm: row.bpm, distance_m: row.meters, distance_at_grade_m: row.grade_meters,
    grade_percent: row.grade === null ? null : row.grade * 100, is_observed: row.is_observed,
    is_interpolated: row.is_interpolated, match_gap_s: row.match_gap_s,
    clock_uncertainty_ms: row.clock_uncertainty_ms, quality_flags: row.match_flags,
  }));
  const columns = [timeColumn, ...(shareCoordinates ? ["sample_id"] : []), "bpm", "distance_m",
    "is_observed", "is_interpolated", "match_gap_s", "clock_uncertainty_ms", "quality_flags"];
  const files: Record<string, string> = {
    "trial.json": json(trialMetadata),
    "analysis_summary.json": json(summary),
    "hr_vs_distance.csv": csv(columns, derivedRows),
    "hr_vs_grade.csv": csv([...columns, "distance_at_grade_m", "grade_percent"], derivedRows),
    "README.md": [
      "# Walking Study export",
      shareCoordinates ? "This archive contains exact locations, timestamps and source IDs." :
        "This archive omits exact locations, absolute times, titles, event logs and HealthKit sample IDs. Distance, slope and participant code may still identify a walk.",
      trial.mode === "demo" ? "All readings and routes in this archive are synthetic." : "BPM values come from original Watch samples.",
      "Empty CSV fields and JSON null represent missing or excluded values. Raw traces are preserved in the full export.",
      "UTC timestamps use milliseconds. Positions use decimal degrees, distance uses meters, and signed grade uses percent in analysis CSVs.",
      "BPM is observed. Interpolation refers to location/distance, when both surrounding good fixes are within 10 seconds and clock uncertainty passes policy.",
      "Grade uses the selected route DEM profile only where the observed trace matches within 15 m, with a centered 40 m window where available.",
      "Predicted walking cost uses Minetti’s signed slope equation. Reported costs are mass normalized.",
      ...(!routes.demo && shareCoordinates ? ["Planned route data © OpenStreetMap contributors. [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/)"] : []),
    ].join("\n\n") + "\n",
  };
  if (shareCoordinates) {
    Object.assign(files, {
      "planned_route.geojson": json({ type: "Feature", geometry: { type: "LineString",
        coordinates: route.geometry.map((point) => [point.longitude, point.latitude]) },
      properties: { ...route, ...summary.route_prediction, parameters: routes.parameters, candidates: routes.candidates } }),
      "gps_samples.csv": csv(["gps_seq", "observed_at_ms", "ingested_at_ms", "lat", "lon", "horizontal_accuracy_m",
        "altitude_m", "vertical_accuracy_m", "speed_mps", "heading_deg", "quality_flags"],
      gps.map((fix) => ({ ...fix, quality_flags: derived.flags[fix.gps_seq] ?? [] }))),
      "hr_samples.csv": csv(["sample_id", "watch_session_id", "watch_seq", "sample_start_at_ms", "sample_end_at_ms",
        "bpm", "source_id", "ingested_at_ms", "quality_flags"], hr),
      "events.csv": csv(["event_id", "device", "type", "observed_at_ms", "payload_json"], events),
    });
  }
  const hashes = await Promise.all(Object.entries(files).map(async ([name, content]) =>
    [name, await digestStringAsync(CryptoDigestAlgorithm.SHA256, content)]));
  files["manifest.json"] = json({ protocol_version: version, schema_version: 1, app_version: "0.1.0",
    timezone: shareCoordinates ? trial.timezone : null, mode: trial.mode, exact_locations: shareCoordinates,
    sha256: Object.fromEntries(hashes) });
  const folder = new Directory(Paths.cache, `walking-export-${randomUUID()}`);
  folder.create();
  try {
    const bundle = `trial_${trial.id}`;
    const file = new File(folder, bundle + ".zip");
    file.write(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) =>
      [`${bundle}/${name}`, strToU8(content)]))));
    await Sharing.shareAsync(file.uri, { mimeType: "application/zip", UTI: "public.zip", dialogTitle: "Share trial export" });
    await (await database()).runAsync("INSERT INTO analysis_runs VALUES (?,?,?,?)",
      randomUUID(), trial.id, Date.now(), json(summary));
  } finally {
    folder.delete();
  }
}
