export const version = "1.0";
export const batchLimit = 50;
export type HrSample = {
  sample_id: string;
  watch_seq: number;
  sample_start_at_ms: number;
  sample_end_at_ms: number;
  bpm: number;
  source_id: string;
  quality_flags: string[];
};
export type Envelope = {
  protocol_version: string;
  message_id: string;
  type: string;
  trial_id: string;
  sender_device: "phone" | "watch";
  sent_at_ms: number;
  payload: Record<string, unknown>;
};
export type Batch = {
  watch_session_id: string;
  batch_id: string;
  seq_start: number;
  seq_end: number;
  sha256: string;
  samples: HrSample[];
};
export type Manifest = {
  watch_session_id: string;
  final_sample_count: number;
  final_checksum: string;
  finalized_at_ms: number;
  watch_started_at_ms: number;
  watch_stopped_at_ms: number;
  interrupted: boolean;
};

export const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export const epoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const sequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9._-]{1,200}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function readEnvelope(json: string): Envelope {
  const value: unknown = JSON.parse(json);
  if (!record(value) || value.protocol_version !== version) {
    throw new Error("Unsupported Watch protocol. Update both apps to matching versions.");
  }
  if (!uuid(value.message_id) || !uuid(value.trial_id) || !token(value.type) ||
      value.sender_device !== "watch" || !epoch(value.sent_at_ms) || !record(value.payload)) {
    throw new Error("Invalid Watch message.");
  }
  return value as Envelope;
}

function validSample(value: unknown): value is HrSample {
  return record(value) && uuid(value.sample_id) && sequence(value.watch_seq) &&
    epoch(value.sample_start_at_ms) && epoch(value.sample_end_at_ms) &&
    value.sample_end_at_ms >= value.sample_start_at_ms && typeof value.bpm === "number" &&
    Number.isFinite(value.bpm) && value.bpm > 0 && token(value.source_id) &&
    Array.isArray(value.quality_flags) && value.quality_flags.length <= 12 && value.quality_flags.every(token);
}

export function canonicalSamples(samples: HrSample[]): string {
  return [...samples].sort((a, b) => a.watch_seq - b.watch_seq).map((sample) => {
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, sample.bpm, false);
    const hex = [bits.getUint32(0, false), bits.getUint32(4, false)]
      .map((part) => part.toString(16).padStart(8, "0")).join("");
    return [sample.watch_seq, sample.sample_id, sample.sample_start_at_ms, sample.sample_end_at_ms,
      hex, sample.source_id,
      sample.quality_flags.join(",")].join("\t");
  }).join("\n");
}

export function readBatch(payload: Record<string, unknown>): Batch {
  const { samples, seq_start, seq_end } = payload;
  if (!uuid(payload.watch_session_id) || !token(payload.batch_id) || !hash(payload.sha256) ||
      !sequence(seq_start) || !sequence(seq_end) || !Array.isArray(samples) || samples.length < 1 ||
      samples.length > batchLimit || samples.length !== seq_end - seq_start + 1 ||
      !samples.every((sample, i) => validSample(sample) && sample.watch_seq === seq_start + i) ||
      new Set(samples.map((sample) => sample.sample_id)).size !== samples.length) {
    throw new Error("Invalid Watch sample batch.");
  }
  return payload as Batch;
}

export function readManifest(payload: Record<string, unknown>): Manifest {
  if (!uuid(payload.watch_session_id) || !(payload.final_sample_count === 0 || sequence(payload.final_sample_count)) ||
      !hash(payload.final_checksum) || !epoch(payload.finalized_at_ms) || !epoch(payload.watch_started_at_ms) ||
      !epoch(payload.watch_stopped_at_ms) || payload.watch_stopped_at_ms < payload.watch_started_at_ms ||
      payload.finalized_at_ms < payload.watch_stopped_at_ms || typeof payload.interrupted !== "boolean") {
    throw new Error("Invalid Watch final manifest.");
  }
  return payload as Manifest;
}

export function manifestMatches(samples: HrSample[], manifest: Manifest, checksum: string) {
  return samples.length === manifest.final_sample_count && checksum === manifest.final_checksum &&
    [...samples].sort((a, b) => a.watch_seq - b.watch_seq).every((sample, index) => sample.watch_seq === index + 1);
}
