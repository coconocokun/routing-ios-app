import { randomUUID } from "expo-crypto";
import { openDatabaseAsync } from "expo-sqlite";
import { Platform } from "react-native";
import type { Event, GPS } from "./analysis.ts";
import type { HrSample } from "./protocol.ts";
import type { Route, RouteSet } from "./routes.ts";

export type Status = "preparing" | "recording" | "paused" | "sync_pending" | "complete" | "incomplete" | "abandoned";
export type Trial = {
  id: string; title: string; participant: string | null; route_json: string; routes_json: string;
  status: Status; mode: "paired" | "gps" | "demo"; created_at_ms: number; timezone: string;
  phone_started_at_ms: number | null; phone_stopped_at_ms: number | null; watch_session_id: string | null;
  watch_started_at_ms: number | null; watch_stopped_at_ms: number | null; reason: string | null;
};

let connection: ReturnType<typeof openDatabaseAsync> | undefined;
export function database() {
  connection ??= (async () => {
    const db = await openDatabaseAsync("walking-study.db");
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS trials (
        id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, participant TEXT, route_json TEXT NOT NULL,
        routes_json TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        timezone TEXT NOT NULL, phone_started_at_ms INTEGER, phone_stopped_at_ms INTEGER,
        watch_session_id TEXT, watch_started_at_ms INTEGER, watch_stopped_at_ms INTEGER, reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active ON trials ((1))
        WHERE status IN ('preparing','recording','paused');
      CREATE TABLE IF NOT EXISTS gps_samples (
        trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
        gps_seq INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL, ingested_at_ms INTEGER NOT NULL,
        lat REAL NOT NULL, lon REAL NOT NULL, horizontal_accuracy_m REAL, altitude_m REAL,
        vertical_accuracy_m REAL, speed_mps REAL, heading_deg REAL, PRIMARY KEY (trial_id,gps_seq),
        UNIQUE (trial_id,observed_at_ms,lat,lon)
      );
      CREATE TABLE IF NOT EXISTS hr_samples (
        trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
        sample_id TEXT NOT NULL, watch_session_id TEXT NOT NULL, watch_seq INTEGER NOT NULL,
        sample_start_at_ms INTEGER NOT NULL, sample_end_at_ms INTEGER NOT NULL, bpm REAL NOT NULL,
        source_id TEXT NOT NULL, quality_flags TEXT NOT NULL, ingested_at_ms INTEGER NOT NULL,
        PRIMARY KEY (trial_id,sample_id), UNIQUE (trial_id,watch_session_id,watch_seq)
      );
      CREATE TABLE IF NOT EXISTS events (
        trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
        event_id TEXT PRIMARY KEY NOT NULL, device TEXT NOT NULL, type TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_batches (
        trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
        watch_session_id TEXT NOT NULL, batch_id TEXT NOT NULL, checksum TEXT NOT NULL,
        seq_start INTEGER NOT NULL, seq_end INTEGER NOT NULL, received_at_ms INTEGER NOT NULL, acked_at_ms INTEGER,
        PRIMARY KEY (trial_id,watch_session_id,batch_id)
      );
      CREATE TABLE IF NOT EXISTS sync_manifests (
        trial_id TEXT PRIMARY KEY NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL, reconciled_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS deleted_trials (id TEXT PRIMARY KEY NOT NULL, watch_pending INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_runs (
        analysis_id TEXT PRIMARY KEY NOT NULL, trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
        computed_at_ms INTEGER NOT NULL, metadata_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    return db;
  })().catch((error) => { connection = undefined; throw error; });
  return connection;
}

type DB = Awaited<ReturnType<typeof database>>;
let writes: Promise<void> = Promise.resolve();
export function write(db: DB, operation: (tx: DB) => Promise<void>) {
  const next = writes.then(() => Platform.OS === "web"
    ? db.withTransactionAsync(() => operation(db))
    : db.withExclusiveTransactionAsync(operation));
  writes = next.catch(() => {});
  return next;
}
export const active = (db: DB) => db.getFirstAsync<Trial>(
  "SELECT * FROM trials WHERE status IN ('preparing','recording','paused')",
);
export const getTrial = (db: DB, id: string) => db.getFirstAsync<Trial>("SELECT * FROM trials WHERE id = ?", id);
export async function addEvent(db: DB, id: string, type: string, time: number,
  payload: unknown = {}, device = "phone", eventId = randomUUID()) {
  await db.runAsync("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)",
    id, eventId, device, type, time, JSON.stringify(payload));
}

export async function createTrial(route: Route, routes: RouteSet, title: string, participant: string, mode: Trial["mode"]) {
  const db = await database();
  const id = randomUUID();
  const time = Date.now();
  await write(db, async (tx) => {
    await tx.runAsync(`INSERT INTO trials
      (id,title,participant,route_json,routes_json,status,mode,created_at_ms,timezone)
      VALUES (?,?,?,?,?,'preparing',?,?,?)`, id, title.trim(), participant.trim() || null,
    JSON.stringify(route), JSON.stringify(routes), mode, time, Intl.DateTimeFormat().resolvedOptions().timeZone);
    await addEvent(tx, id, "prepare", time, { mode, authorized: mode === "demo" ? null : true });
  });
  return id;
}

export async function appendGps(db: DB, id: string, fixes: Omit<GPS, "gps_seq">[]) {
  let seq = (await db.getFirstAsync<{ value: number }>(
    "SELECT COALESCE(MAX(gps_seq),0) AS value FROM gps_samples WHERE trial_id = ?", id))?.value ?? 0;
  for (const fix of fixes) {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(fix.observed_at_ms)) continue;
    const result = await db.runAsync(`INSERT INTO gps_samples VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(trial_id,observed_at_ms,lat,lon) DO NOTHING`, id, seq + 1, fix.observed_at_ms, fix.ingested_at_ms,
    fix.lat, fix.lon, fix.horizontal_accuracy_m, fix.altitude_m, fix.vertical_accuracy_m, fix.speed_mps, fix.heading_deg);
    seq += result.changes;
  }
}

export type StoredHR = HrSample & { watch_session_id: string; ingested_at_ms: number };
type HRRow = Omit<StoredHR, "quality_flags"> & { quality_flags: string };
export async function heartRate(db: DB, id: string): Promise<StoredHR[]> {
  const rows = await db.getAllAsync<HRRow>("SELECT * FROM hr_samples WHERE trial_id = ? ORDER BY sample_start_at_ms, watch_seq", id);
  return rows.map((row) => ({ ...row, quality_flags: JSON.parse(row.quality_flags) }));
}

export async function readTrial(id: string) {
  const db = await database();
  const trial = await getTrial(db, id);
  if (!trial) return null;
  const [gps, hr, events] = await Promise.all([
    db.getAllAsync<GPS>("SELECT * FROM gps_samples WHERE trial_id = ? ORDER BY observed_at_ms,gps_seq", id),
    heartRate(db, id),
    db.getAllAsync<Event>("SELECT * FROM events WHERE trial_id = ? ORDER BY observed_at_ms,rowid", id),
  ]);
  return { trial, gps, hr, events, route: JSON.parse(trial.route_json) as Route, routes: JSON.parse(trial.routes_json) as RouteSet };
}

export async function deleteTrial(id: string) {
  const db = await database();
  await write(db, async (tx) => {
    const trial = await getTrial(tx, id);
    if (!trial || ["preparing", "recording", "paused"].includes(trial.status)) throw new Error("Finish this walk before deleting it.");
    await tx.runAsync("INSERT OR IGNORE INTO deleted_trials VALUES (?,?)", id, trial.mode === "paired" ? 1 : 0);
    for (const table of ["gps_samples", "hr_samples", "events", "sync_batches", "sync_manifests", "analysis_runs"]) {
      await tx.runAsync(`DELETE FROM ${table} WHERE trial_id = ?`, id);
    }
    await tx.runAsync("DELETE FROM trials WHERE id = ?", id);
  });
}
