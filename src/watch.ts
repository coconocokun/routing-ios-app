import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { addEvent, database, getTrial, heartRate, write, type Trial } from "./db.ts";
import { canonicalSamples, epoch, manifestMatches, readBatch, readEnvelope, readManifest, uuid, version } from "./protocol.ts";

export type WatchStatus = { supported: boolean; activated: boolean; paired: boolean; installed: boolean; reachable: boolean };
type Native = {
  status: () => WatchStatus;
  inbox: () => Promise<{ key: string; json: string }[]>;
  remove: (key: string) => Promise<void>;
  send: (json: string, durable: boolean) => Promise<boolean>;
  probe: (json: string) => Promise<number>;
};
const bridge = Platform.OS === "ios" ? requireOptionalNativeModule<Native>("WalkConnectivity") : null;
const offline = { supported: false, activated: false, paired: false, installed: false, reachable: false };
export const watchStatus = () => bridge?.status() ?? offline;
export function watchAvailable() {
  const { activated, paired, installed } = watchStatus();
  return activated && paired && installed;
}

function phoneMessage(type: string, id: string, payload: Record<string, unknown>) {
  return JSON.stringify({ protocol_version: version, message_id: randomUUID(), type, trial_id: id,
    sender_device: "phone", sent_at_ms: Date.now(), payload });
}
export async function command(type: string, id: string, payload: Record<string, unknown> = {}) {
  if (!bridge) return false;
  return bridge.send(phoneMessage(type, id, payload), true);
}

export async function checkClock(id: string) {
  if (!bridge || !watchStatus().reachable) return;
  const start = Date.now();
  const monotonic = performance.now();
  const remote = await bridge.probe(phoneMessage("PING", id, {}));
  const duration = performance.now() - monotonic;
  const end = Date.now();
  if (!epoch(remote) || Math.abs(end - start - duration) > 250 || duration > 4000) return;
  await addEvent(await database(), id, "clock", Math.round((start + end) / 2),
    { offset_ms: Math.round(remote - (start + end) / 2), uncertainty_ms: Math.ceil(duration / 2) });
}

class IntegrityError extends Error {}
const sha = (plain: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, plain);
type DB = Awaited<ReturnType<typeof database>>;

async function reconcile(db: DB, id: string) {
  const row = await db.getFirstAsync<{ payload_json: string }>("SELECT payload_json FROM sync_manifests WHERE trial_id = ?", id);
  const trial = await getTrial(db, id);
  if (!row || !trial) return;
  const manifest = readManifest(JSON.parse(row.payload_json));
  const samples = await heartRate(db, id);
  if (samples.length < manifest.final_sample_count) return;
  if (!manifestMatches(samples, manifest, await sha(canonicalSamples(samples)))) {
    throw new IntegrityError("The Watch manifest conflicts with imported samples.");
  }
  await db.runAsync("UPDATE sync_manifests SET reconciled_at_ms = COALESCE(reconciled_at_ms,?) WHERE trial_id = ?", Date.now(), id);
  if (trial.status !== "sync_pending" || !trial.phone_stopped_at_ms) return;
  const gps = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM gps_samples WHERE trial_id = ? AND horizontal_accuracy_m BETWEEN 0 AND 30", id);
  const clock = await db.getFirstAsync<{ payload_json: string }>(
    "SELECT payload_json FROM events WHERE trial_id = ? AND type = 'clock' ORDER BY observed_at_ms DESC LIMIT 1", id);
  const probe = clock ? JSON.parse(clock.payload_json) as { offset_ms: number } : null;
  const endedEarly = trial.phone_started_at_ms === null ||
    manifest.watch_stopped_at_ms - (probe?.offset_ms ?? 0) < trial.phone_stopped_at_ms - 15_000;
  const interruption = await db.getFirstAsync("SELECT 1 FROM events WHERE trial_id = ? AND type IN ('location_error','recovered') LIMIT 1", id);
  const reason = trial.reason || (manifest.interrupted ? "The Watch ended before normal workout finalization." :
    endedEarly ? "The Watch workout ended before the phone walk finished." :
        interruption ? "iPhone location recording was interrupted." :
          !samples.length ? "The Watch recorded no heart-rate samples." : !gps?.n ? "No usable iPhone location data." : null);
  await db.runAsync("UPDATE trials SET status = ?, reason = ? WHERE id = ? AND status = 'sync_pending'",
    reason ? "incomplete" : "complete", reason, id);
}

async function ingest(json: string) {
  let envelope;
  try {
    envelope = readEnvelope(json);
  } catch (error) {
    throw new IntegrityError(String(error));
  }
  const { type, trial_id: id, message_id: messageId, payload, sent_at_ms: sent } = envelope;
  const db = await database();
  let ack: { type: string; payload: Record<string, unknown> } | undefined;
  await write(db, async (tx) => {
    const trial = await getTrial(tx, id);
    if (!trial || trial.mode !== "paired") {
      if (type === "DELETED") await tx.runAsync("UPDATE deleted_trials SET watch_pending = 0 WHERE id = ?", id);
      else if (await tx.getFirstAsync("SELECT id FROM deleted_trials WHERE id = ? AND watch_pending = 1", id)) {
        ack = { type: "DELETE", payload: {} };
      }
      return;
    }
    const session = payload.watch_session_id;
    if (["STARTED", "PAUSED", "RESUMED", "STOPPED", "HR_BATCH", "FINAL_MANIFEST"].includes(type)) {
      if (!uuid(session) || (trial.watch_session_id && trial.watch_session_id !== session)) {
        throw new IntegrityError("Watch session mismatch.");
      }
      await tx.runAsync("UPDATE trials SET watch_session_id = COALESCE(watch_session_id,?) WHERE id = ?", session, id);
    }
    if (type === "HR_BATCH") {
      let batch;
      try { batch = readBatch(payload); } catch (error) { throw new IntegrityError(String(error)); }
      if (await sha(canonicalSamples(batch.samples)) !== batch.sha256) throw new IntegrityError("Watch batch checksum mismatch.");
      const prior = await tx.getFirstAsync<{ checksum: string; seq_start: number; seq_end: number }>(
        "SELECT checksum,seq_start,seq_end FROM sync_batches WHERE trial_id = ? AND watch_session_id = ? AND batch_id = ?",
        id, batch.watch_session_id, batch.batch_id);
      if (prior && (prior.checksum !== batch.sha256 || prior.seq_start !== batch.seq_start || prior.seq_end !== batch.seq_end)) {
        throw new IntegrityError("Watch reused a batch ID with different content.");
      }
      if (!prior) {
        for (const sample of batch.samples) {
          const existing = await tx.getAllAsync<typeof sample & { quality_flags: string }>(
            "SELECT * FROM hr_samples WHERE trial_id = ? AND (sample_id = ? OR watch_seq = ?)", id, sample.sample_id, sample.watch_seq);
          if (existing.length) {
            if (existing.length !== 1 || canonicalSamples([{ ...existing[0], quality_flags: JSON.parse(existing[0].quality_flags) }]) !== canonicalSamples([sample])) {
              throw new IntegrityError("Watch reused a sample ID or sequence with different content.");
            }
            continue;
          }
          await tx.runAsync("INSERT INTO hr_samples VALUES (?,?,?,?,?,?,?,?,?,?)",
            id, sample.sample_id, batch.watch_session_id, sample.watch_seq, sample.sample_start_at_ms,
            sample.sample_end_at_ms, sample.bpm, sample.source_id, JSON.stringify(sample.quality_flags), Date.now());
        }
        await tx.runAsync("INSERT INTO sync_batches VALUES (?,?,?,?,?,?,?,NULL)", id, batch.watch_session_id,
          batch.batch_id, batch.sha256, batch.seq_start, batch.seq_end, Date.now());
      }
      ack = { type: "BATCH_ACK", payload: { watch_session_id: session, batch_id: batch.batch_id, sha256: batch.sha256 } };
    } else if (type === "FINAL_MANIFEST") {
      let manifest;
      try { manifest = readManifest(payload); } catch (error) { throw new IntegrityError(String(error)); }
      const prior = await tx.getFirstAsync<{ payload_json: string }>("SELECT payload_json FROM sync_manifests WHERE trial_id = ?", id);
      if (prior) {
        const first = readManifest(JSON.parse(prior.payload_json));
        if (Object.keys(first).some((key) => first[key as keyof typeof first] !== manifest[key as keyof typeof manifest])) {
          throw new IntegrityError("Watch sent conflicting final manifests.");
        }
      }
      await tx.runAsync("INSERT OR IGNORE INTO sync_manifests VALUES (?,?,NULL)", id, JSON.stringify(manifest));
      await tx.runAsync("UPDATE trials SET watch_started_at_ms = ?, watch_stopped_at_ms = ? WHERE id = ?",
        manifest.watch_started_at_ms, manifest.watch_stopped_at_ms, id);
    } else if (["WATCH_READY", "STARTED", "PAUSED", "RESUMED", "STOPPED", "ERROR", "STATUS", "CANCELLED"].includes(type)) {
      if (type === "STARTED" || type === "STOPPED") {
        const key = type === "STARTED" ? "watch_started_at_ms" : "watch_stopped_at_ms";
        const at = payload[key];
        if (!epoch(at)) throw new IntegrityError("Watch transition lacks a valid timestamp.");
        await tx.runAsync(`UPDATE trials SET ${key} = COALESCE(${key},?) WHERE id = ?`, at, id);
      }
      await addEvent(tx, id, type.toLowerCase(), sent, payload, "watch", messageId);
      if (type === "STARTED" && trial.status === "preparing") {
        await tx.runAsync("UPDATE trials SET reason = NULL WHERE id = ? AND reason LIKE 'Watch setup:%'", id);
      }
      if (type === "ERROR" && typeof payload.message === "string") {
        await tx.runAsync("UPDATE trials SET reason = COALESCE(reason,?) WHERE id = ?",
          (trial.status === "preparing" ? "Watch setup: " : "") + payload.message.slice(0, 240), id);
      }
      if (type === "CANCELLED") {
        await tx.runAsync(`UPDATE trials SET status = 'incomplete',
          reason = COALESCE(reason,'The Watch did not start a workout.') WHERE id = ? AND status = 'sync_pending'`, id);
      }
    } else {
      throw new IntegrityError("Unsupported Watch message type. Check both apps' versions.");
    }
    await reconcile(tx, id);
    if (type === "FINAL_MANIFEST") {
      const verified = await tx.getFirstAsync<{ reconciled_at_ms: number | null }>(
        "SELECT reconciled_at_ms FROM sync_manifests WHERE trial_id = ?", id);
      if (verified?.reconciled_at_ms) ack = { type: "MANIFEST_ACK", payload: { watch_session_id: session } };
    }
  });
  if (ack) {
    if (!await command(ack.type, id, ack.payload)) return false;
    if (ack.type === "BATCH_ACK") await db.runAsync(`UPDATE sync_batches SET acked_at_ms = ?
      WHERE trial_id = ? AND watch_session_id = ? AND batch_id = ?`, Date.now(), id,
    String(ack.payload.watch_session_id), String(ack.payload.batch_id));
  }
  // A manifest that arrived first stays available to acknowledge on the next drain.
  return type !== "FINAL_MANIFEST" || !!ack || !await getTrial(db, id);
}

let draining: Promise<string | null> | undefined;
export function drainWatch() {
  if (!bridge) return Promise.resolve(null);
  const native = bridge;
  draining ??= (async () => {
    let warning: string | null = null;
    for (const { key, json } of await native.inbox()) {
      try {
        if (await ingest(json)) await native.remove(key);
      } catch (error) {
        if (!(error instanceof IntegrityError)) throw error;
        warning = error.message;
        let id;
        try { id = JSON.parse(json).trial_id; } catch { /* Invalid envelope. */ }
        if (uuid(id)) {
          const db = await database();
          await db.runAsync(`UPDATE trials SET reason = ?, status = CASE WHEN status = 'complete' THEN 'incomplete' ELSE status END
            WHERE id = ?`, warning, id);
        }
        await native.remove(key);
      }
    }
    return warning;
  })().finally(() => { draining = undefined; });
  return draining;
}

export async function finishTrial(trial: Trial, abandoned = false) {
  const db = await database();
  const now = Date.now();
  await write(db, async (tx) => {
    let reason = abandoned ? "Ended by the participant before completion." : trial.reason;
    if (!abandoned && trial.mode === "gps" && !reason) {
      const interruption = await tx.getFirstAsync("SELECT 1 FROM events WHERE trial_id = ? AND type IN ('location_error','recovered') LIMIT 1", trial.id);
      const gps = await tx.getFirstAsync("SELECT 1 FROM gps_samples WHERE trial_id = ? AND horizontal_accuracy_m BETWEEN 0 AND 30 LIMIT 1", trial.id);
      reason = interruption ? "Location recording was interrupted." : gps ? null : "No usable location data.";
    }
    const next = abandoned ? "abandoned" : trial.mode === "paired" ? "sync_pending" : reason ? "incomplete" : "complete";
    const changed = await tx.runAsync(`UPDATE trials SET phone_stopped_at_ms = ?, status = ?, reason = COALESCE(reason,?)
      WHERE id = ? AND status IN ('preparing','recording','paused')`, now, next, reason, trial.id);
    if (!changed.changes) return;
    await addEvent(tx, trial.id, "stop", now);
    if (trial.mode !== "paired") return;
    try {
      await reconcile(tx, trial.id);
    } catch (error) {
      if (!(error instanceof IntegrityError)) throw error;
      await tx.runAsync("UPDATE trials SET status = 'incomplete', reason = ? WHERE id = ?", error.message, trial.id);
    }
  });
  if (trial.mode === "paired") await command("STOP", trial.id, { interrupted: abandoned });
}
