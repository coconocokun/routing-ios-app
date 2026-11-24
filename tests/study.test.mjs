import { deepEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { analyze, walkDuration } from "../src/analysis.ts";
import { searchPlaces } from "../src/places.ts";
import { canonicalSamples, manifestMatches, readBatch, readEnvelope, readManifest } from "../src/protocol.ts";
import { demoRoutes, distance, scoreRoutes, walkingCost } from "../src/routes.ts";
import { requestMapPaths, requestRoutes } from "../src/routing.ts";

const epoch = 1795417200000;
const session = "1e1c47b3-5e8f-47d2-9ac1-4dfe261431f7";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const hr = (watch_seq, seconds, bpm = 96.5) => ({
  sample_id: `aa678dc6-ef58-4de2-9954-${String(watch_seq).padStart(12, "0")}`,
  sample_start_at_ms: epoch + seconds * 1000 - 250, sample_end_at_ms: epoch + seconds * 1000 + 250,
  watch_seq, bpm, source_id: "com.example.watch", quality_flags: [],
});
const clock = { type: "clock", device: "phone", observed_at_ms: epoch,
  payload_json: JSON.stringify({ offset_ms: 2000, uncertainty_ms: 60 }) };

const route = demoRoutes().choices[0];
const start = route.geometry[0];
const end = route.geometry[1];
function fix(seconds, fraction, gps_seq) {
  return { gps_seq, observed_at_ms: epoch + seconds * 1000, ingested_at_ms: epoch + seconds * 1000 + 100,
    lat: start.latitude + (end.latitude - start.latitude) * fraction,
    lon: start.longitude + (end.longitude - start.longitude) * fraction, horizontal_accuracy_m: 3,
    altitude_m: null, vertical_accuracy_m: null, speed_mps: null, heading_deg: null };
}
const batch = (samples) => ({ watch_session_id: session, batch_id: "one", seq_start: samples[0].watch_seq,
  seq_end: samples.at(-1).watch_seq, samples, sha256: sha(canonicalSamples(samples)) });

test("Minetti model uses signed slope", () => {
  equal(walkingCost(0), 2.5);
  ok(Math.abs(walkingCost(0.05) - 3.59987078125) < 1e-9);
  ok(Math.abs(walkingCost(-0.05) - 1.65889546875) < 1e-9);
});

test("demo has three deterministic choices with a mean versus total trade-off", () => {
  const routes = demoRoutes();
  deepEqual(routes.choices.map((r) => r.labels), [["Shortest"], ["Lowest J/kg/m"], ["Balanced"]]);
  ok(routes.choices[1].mean < routes.choices[2].mean);
  ok(routes.choices[1].total > routes.choices[2].total);
  ok(routes.choices.every((r) => r.meters <= routes.choices[0].meters * 1.35));
  const candidates = routes.candidates.map((r) => ({ id: r.id, edges: r.segments })).reverse();
  const reversed = scoreRoutes(routes.origin, routes.destination, { ...routes, candidates }, true);
  deepEqual(reversed.choices.map((r) => r.id), routes.choices.map((r) => r.id));
});

test("unwalkable, missing-elevation and repeated-node paths are excluded", () => {
  const routes = demoRoutes();
  const edges = routes.candidates[0].segments;
  const candidates = [
    { id: "unsafe", edges: edges.map((e, i) => i ? e : { ...e, walkable: false }) },
    { id: "missing", edges: edges.map((e, i) => i ? e : { ...e, elevationQuality: "missing" }) },
    { id: "loop", edges: [...edges.slice(0, 1), { ...edges[0], from: edges[0].to, to: edges[0].from,
      start: edges[0].end, end: edges[0].start, elevationStart: edges[0].elevationEnd, elevationEnd: edges[0].elevationStart },
    ...edges] },
  ];
  throws(() => scoreRoutes(routes.origin, routes.destination, { ...routes, candidates }), /No candidate/);
});

const planStart = { latitude: 0, longitude: 0 };
const planEnd = { latitude: 0, longitude: 0.001 };
const directTrip = { legs: [{ shape: "???g^?g^" }] };
const alternateTrip = { legs: [{ shape: "??sNg^rNg^" }] };

test("place search keeps valid results and sends a rounded bias center", async (t) => {
  const { signal } = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const { searchParams } = new URL(url);
    equal(options.signal, signal);
    equal(searchParams.get("q"), "공원 & trail");
    equal(searchParams.get("lat"), "37.8");
    equal(searchParams.get("lon"), "-122.5");
    return Response.json({ features: [
      { geometry: { type: "Point", coordinates: [-122.482, 37.772] },
        properties: { name: "Example Park", street: "Test Street", housenumber: "12", city: "Example City" } },
      { geometry: { type: "Point", coordinates: [-122.48, 91] }, properties: { name: "Invalid point" } },
      { geometry: { type: "Point", coordinates: [-122.47, 37.77] }, properties: { city: "Example City" } },
    ] });
  });
  deepEqual(await searchPlaces("공원 & trail", { latitude: 37.772, longitude: -122.482 }, signal), [
    { point: { latitude: 37.772, longitude: -122.482 }, name: "Example Park", detail: "12 Test Street, Example City" },
    { point: { latitude: 37.77, longitude: -122.47 }, name: "Example City", detail: "" },
  ]);
});

test("Valhalla pedestrian alternatives retain bends and are compared with sampled elevation", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, { body, headers, method }) => {
    equal(method, "POST");
    equal(headers["X-Client-Id"], "org.walkingstudy.phone");
    const request = JSON.parse(body);
    if (url.endsWith("/route")) {
      equal(request.costing, "pedestrian");
      equal(request.costing_options.pedestrian.shortest, true);
      equal(request.alternates, 2);
      deepEqual(request.locations, [{ lat: 0, lon: 0, search_cutoff: 60 }, { lat: 0, lon: 0.001, search_cutoff: 60 }]);
      return Response.json({ trip: directTrip, alternates: [{ trip: alternateTrip }, { trip: directTrip }] });
    }
    match(url, /\/height$/);
    equal(request.shape.length, 10);
    ok(request.shape[7].lat > 0);
    return Response.json({ height: [0, 2, 4, 6, 8, 0, 0, 0, 0, 0] });
  });
  const routes = await requestRoutes(planStart, planEnd);
  equal(fetch.mock.callCount(), 2);
  equal(routes.candidates.length, 2);
  equal(routes.choices[0].id, "valhalla-1");
  equal(routes.choices[0].gain, 8);
  equal(routes.choices[1].labels.includes("Lowest J/kg/m"), true);
  ok(routes.choices[1].geometry.some(({ latitude }) => latitude === 0.00025));
});

test("Valhalla drops routes with missing elevations and rejects a plan with no complete profile", async (t) => {
  let hasCompleteProfile = true;
  t.mock.method(globalThis, "fetch", async (url) => url.endsWith("/route")
    ? Response.json({ trip: directTrip, alternates: [{ trip: alternateTrip }] })
    : Response.json({ height: [0, null, 0, 0, 0, 0, hasCompleteProfile ? 0 : null, 0, 0, 0] }));
  const routes = await requestRoutes(planStart, planEnd);
  deepEqual(routes.candidates.map(({ id }) => id), ["valhalla-2"]);
  hasCompleteProfile = false;
  await rejects(requestRoutes(planStart, planEnd), /no complete elevation profile/);
});

test("Overpass requests path geometry near both endpoints and filters invalid ways", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, { body, headers, method }) => {
    equal(method, "POST");
    match(headers["User-Agent"], /^WalkingStudy\//);
    const query = new URLSearchParams(body).get("data");
    match(query, /way\[highway.*around:200,0\.000000,0\.000000/);
    match(query, /around:200,0\.000000,0\.001000/);
    return Response.json({ elements: [
      { type: "way", id: 1, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }] },
      { type: "way", id: 2, geometry: [{ lat: 0, lon: 0 }, { lat: 91, lon: 0 }] },
      { type: "node", id: 3, lat: 0, lon: 0 },
    ] });
  });
  deepEqual(await requestMapPaths(planStart, planEnd), [{ id: 1, points: [planStart, planEnd] }]);
});

test("canonical checksum is stable under out-of-order delivery and changes when BPM changes", () => {
  const a = hr(1, 4);
  const b = hr(2, 7);
  equal(canonicalSamples([a]), `1\t${a.sample_id}\t1795417203750\t1795417204250\t4058200000000000\tcom.example.watch\t`);
  const checksum = sha(canonicalSamples([a, b]));
  equal(sha(canonicalSamples([b, a])), checksum);
  const manifest = readManifest({ watch_session_id: session, final_sample_count: 2, final_checksum: checksum,
    finalized_at_ms: epoch + 60_000, watch_started_at_ms: epoch, watch_stopped_at_ms: epoch + 59_000, interrupted: false });
  ok(manifestMatches([b, a], manifest, checksum));
  equal(manifestMatches([a], manifest, sha(canonicalSamples([a]))), false);
  equal(manifestMatches([a, { ...b, watch_seq: 1 }], manifest, checksum), false);
  equal(manifestMatches([a, b], manifest, sha(canonicalSamples([a, { ...b, bpm: 97 }]))), false);
});

test("protocol rejects invalid time order, duplicate sample IDs and version mismatches", () => {
  const a = hr(1, 4);
  const b = hr(2, 7);
  deepEqual(readBatch(batch([a, b])).samples, [a, b]);
  throws(() => readBatch(batch([a, { ...b, sample_id: a.sample_id }])), /Invalid Watch sample batch/);
  throws(() => readBatch(batch([{ ...a, sample_end_at_ms: epoch }])), /Invalid Watch sample batch/);
  throws(() => readEnvelope(JSON.stringify({ protocol_version: "2.0" })), /Unsupported Watch protocol/);
});

test("clock-aligned HR follows observed distance and gaps stay unpaired", () => {
  const gps = [fix(0, 0, 1), fix(5, 0.03, 2), fix(10, 0.06, 3), fix(40, 0.23, 4), fix(45, 0.26, 5),
    fix(50, 0.29, 6), fix(55, 0.32, 7)];
  const result = analyze(gps, [hr(1, 8), hr(2, 27), hr(3, 55)], [clock], route);
  ok(Math.abs(result.aligned[0].meters - distance(start, end) * 0.036) < 0.1);
  equal(result.aligned[0].is_interpolated, true);
  equal(result.aligned[0].sample_start_at_ms, hr(1, 8).sample_start_at_ms);
  equal(result.aligned[1].meters, null);
  equal(result.interpolate(epoch + 25_000), null);
  equal(result.summary.gpsBreakCount, 1);
  equal(result.traceSegments[2].bpm, null);
  equal(analyze(gps, [hr(1, 8)], [], route).aligned[0].meters, null);
});

test("pauses and low-accuracy fixes stay flagged; deviations have missing grade", () => {
  const events = [
    { type: "pause", device: "phone", observed_at_ms: epoch + 4000, payload_json: "{}" },
    { type: "resume", device: "phone", observed_at_ms: epoch + 9000, payload_json: "{}" },
    clock,
  ];
  const off = { ...fix(100, 0.2, 4), lat: start.latitude + 0.004 };
  const result = analyze([fix(0, 0, 1), fix(5, 0.02, 2), { ...fix(6, 0.03, 3), horizontal_accuracy_m: 75 }, off],
    [hr(1, 102)], events, route);
  deepEqual(result.flags[2], ["paused"]);
  deepEqual(result.flags[3], ["low_accuracy", "paused"]);
  equal(result.aligned[0].grade, null);
  ok(result.aligned[0].match_flags.includes("missing_grade"));
  deepEqual(walkDuration(events, epoch, epoch + 10_000), { active: 5000, paused: 5000, wall: 10000 });
});
