import { deepEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { encode } from "fast-png";
import { analyze, walkDuration } from "../src/analysis.ts";
import { searchPlaces } from "../src/places.ts";
import { canonicalSamples, manifestMatches, readBatch, readEnvelope, readManifest } from "../src/protocol.ts";
import { demoRoutes, distance, scoreRoutes, walkingCost } from "../src/routes.ts";
import { findStudyRoutes } from "../src/routeSearch.ts";
import { requestRoutes } from "../src/routing.ts";

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

test("Expo autolinks the iOS Watch bridge and launch subscriber", () => {
  const autolinking = createRequire(import.meta.url).resolve("expo/bin/autolinking");
  const { modules } = JSON.parse(execFileSync(process.execPath, [autolinking, "resolve", "--platform", "ios", "--json"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8",
  }));
  const bridge = modules.find((module) => module.packageName === "walk-connectivity");
  ok(bridge?.pods.some((pod) => pod.podName === "WalkConnectivity"));
  ok(bridge.modules.some((module) => module.class === "WalkConnectivityModule"));
  ok(bridge.appDelegateSubscribers.includes("WalkConnectivitySubscriber"));
});

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

const planStart = { latitude: 0.002, longitude: 0.002 };
const planEnd = { latitude: 0.002, longitude: 0.004 };
const osmWay = (id, nodes, points, tags) => ({ type: "way", id, nodes,
  tags: { highway: "footway", ...tags }, geometry: points.map(({ latitude, longitude }) => ({ lat: latitude, lon: longitude })) });

function terrainTile(heightAt) {
  const data = new Uint8Array(256 * 256 * 3);
  for (let row = 0; row < 256; row++) {
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (4095 + (row + 0.5) / 256) / 8192))) * 180 / Math.PI;
    for (let col = 0; col < 256; col++) {
      const longitude = (4096 + (col + 0.5) / 256) / 8192 * 360 - 180;
      const packed = Math.round((32768 + heightAt(latitude, longitude)) * 256);
      const index = (row * 256 + col) * 3;
      data[index] = packed >> 16;
      data[index + 1] = packed >> 8;
      data[index + 2] = packed;
    }
  }
  return encode({ data, width: 256, height: 256, channels: 3 });
}

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

test("the planner builds an OSM graph and finds a lower-energy route around a hill", async (t) => {
  const via = [{ latitude: 0.00245, longitude: 0.0026 }, { latitude: 0.00245, longitude: 0.0034 }];
  const hill = terrainTile((lat, lon) => 17 * Math.max(0, 1 - Math.abs(lon - 0.003) / 0.00087 - Math.abs(lat - 0.002) / 0.00034));
  const fetch = t.mock.method(globalThis, "fetch", async (url, { body, headers, method }) => {
    if (method === "POST") {
      match(headers["User-Agent"], /^WalkingStudy\//);
      const query = new URLSearchParams(body).get("data");
      match(query, /\[bbox:[^\]]+\].*way\[highway.*out geom\(/);
      match(query, /node\[barrier\]/);
      return Response.json({ osm3s: { timestamp_osm_base: "2026-01-01T00:00:00Z" }, elements: [
        osmWay(1, [10, 20], [planStart, planEnd]),
        osmWay(2, [10, 11, 12, 20], [planStart, ...via, planEnd]),
      ] });
    }
    match(url, /\/13\/4096\/4095\.png$/);
    return new Response(hill);
  });
  const { routes, mapPaths } = await requestRoutes(planStart, planEnd);
  equal(fetch.mock.callCount(), 2);
  equal(mapPaths.length, 2);
  match(routes.graphVersion, /2026-01-01T00:00:00Z/);
  const [shortest, energy] = routes.choices;
  deepEqual(shortest.labels, ["Shortest"]);
  deepEqual(energy.labels, ["Minimum energy", "Grade constrained"]);
  ok(shortest.maxGrade > 0.08);
  ok(energy.total < shortest.total);
  ok(energy.meters > shortest.meters);
  ok(energy.geometry.some(({ latitude }) => latitude === via[0].latitude));
  for (const segment of shortest.segments) {
    ok(segment.horizontalMeters <= 30.01);
    equal(segment.meters, Math.hypot(segment.horizontalMeters, segment.elevationEnd - segment.elevationStart));
  }
  equal(shortest.total, shortest.segments.reduce((sum, edge) => sum + edge.meters * walkingCost(edge.grade), 0));
});

test("web routing tries both Overpass backups after a timeout and a server error", async (t) => {
  const previousPlatform = process.env.EXPO_OS;
  process.env.EXPO_OS = "web";
  t.after(() => {
    if (previousPlatform === undefined) delete process.env.EXPO_OS;
    else process.env.EXPO_OS = previousPlatform;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flat = terrainTile(() => 0);
  const providers = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    const endpoint = new URL(url);
    if (!endpoint.pathname.endsWith("/interpreter")) return new Response(flat);
    providers.push(endpoint.host);
    equal(options.method ?? "GET", "GET");
    equal(options.body, undefined);
    deepEqual(options.headers, { Accept: "application/json" });
    match(endpoint.searchParams.get("data"), /\[bbox:[^\]]+\].*way\[highway.*out geom\(/);
    if (providers.length === 1) {
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    equal(options.signal.aborted, false);
    if (providers.length === 2) return new Response(null, { status: 503 });
    equal(endpoint.pathname, "/osm/tools/overpass/api/interpreter");
    return Response.json({ elements: [osmWay(1, [10, 20], [planStart, planEnd])] });
  });

  const plan = requestRoutes(planStart, planEnd);
  deepEqual(providers, ["overpass-api.de"]);
  t.mock.timers.tick(15_000);
  const { routes } = await plan;
  deepEqual(providers, ["overpass-api.de", "overpass.private.coffee", "maps.mail.ru"]);
  match(routes.graphVersion, /maps\.mail\.ru/);
  equal(routes.choices.length, 1);
  equal(fetch.mock.calls[2].arguments[1].signal.aborted, false);
});

test("a configured Overpass URL is tried before the public providers", async (t) => {
  const savedUrl = process.env.EXPO_PUBLIC_OVERPASS_URL;
  const configuredUrl = "https://overpass.example.test/test-key/api/interpreter";
  process.env.EXPO_PUBLIC_OVERPASS_URL = configuredUrl;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.EXPO_PUBLIC_OVERPASS_URL;
    else process.env.EXPO_PUBLIC_OVERPASS_URL = savedUrl;
  });
  const { requestRoutes: requestConfiguredRoutes } = await import("../src/routing.ts?configured-provider-test");
  const flat = terrainTile(() => 0);
  const attempts = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const endpoint = new URL(url);
    if (!endpoint.pathname.endsWith("/interpreter")) return new Response(flat);
    attempts.push(endpoint.origin + endpoint.pathname);
    if (endpoint.hostname === "overpass.example.test") return new Response(null, { status: 503 });
    return Response.json({ elements: [osmWay(1, [10, 20], [planStart, planEnd])] });
  });
  const { routes } = await requestConfiguredRoutes(planStart, planEnd);
  deepEqual(attempts, [configuredUrl, "https://overpass-api.de/api/interpreter"]);
  match(routes.graphVersion, /overpass-api\.de/);
});

test("canceling a route request aborts the active fetch without starting a backup request", async (t) => {
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, "fetch", async (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const plan = requestRoutes(planStart, planEnd, controller.signal);
  controller.abort();
  await rejects(plan, { name: "AbortError" });
  equal(fetch.mock.callCount(), 1);
});

test("endpoint snapping splits a pedestrian one-way and cannot reverse through blocked shortcuts", async (t) => {
  const slope = terrainTile((_, longitude) => (longitude - 0.002) * 6000);
  const elements = [
    osmWay(1, [1, 2], [planStart, planEnd], { "oneway:foot": "yes" }),
    osmWay(2, [1, 2], [planStart, planEnd], { bridge: "yes" }),
    osmWay(3, [1, 2], [planStart, planEnd], { highway: "steps" }),
    osmWay(4, [1, 5, 2], [planStart, { latitude: 0.0023, longitude: 0.003 }, planEnd]),
    osmWay(5, [1, 2], [planStart, planEnd], { access: "private" }),
    { type: "node", id: 5, tags: { barrier: "gate" } },
  ];
  t.mock.method(globalThis, "fetch", async (_url, { method }) => method === "POST" ?
    Response.json({ elements }) : new Response(slope));
  const interior = { ...planStart, longitude: 0.00261 };
  const { routes } = await requestRoutes(interior, planEnd);
  deepEqual(routes.choices[0].labels, ["Shortest", "Minimum energy", "Grade constrained"]);
  ok(distance(routes.choices[0].geometry[0], interior) < 0.01);
  await rejects(requestRoutes(planEnd, interior), /No walking route connects/);
  elements[0].tags["oneway:foot"] = "no";
  const reversed = (await requestRoutes(planEnd, interior)).routes.choices[0];
  ok(reversed.segments.every(({ grade }) => grade < 0));
  ok(reversed.total < routes.choices[0].total);
});

test("missing elevation tiles never become zero-grade edges", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, { method }) => method === "POST" ?
    Response.json({ elements: [osmWay(1, [10, 20], [planStart, planEnd])] }) : new Response(null, { status: 404 }));
  await rejects(requestRoutes(planStart, planEnd), /No walking path with usable terrain data/);
});

test("constrained search keeps competing energy and distance labels at a junction", () => {
  const edge = (from, to, meters, grade) => ({ from, to, meters, grade, cost: walkingCost(grade),
    start: planStart, end: planEnd, elevationStart: 0, elevationEnd: meters * grade });
  const graph = [edge("start", "junction", 45, 0.08), edge("junction", "end", 45, 0.08),
    edge("start", "north", 35, -0.04), edge("north", "junction", 35, -0.04),
    edge("junction", "south", 35, -0.08), edge("south", "end", 35, -0.08)];
  const { choices } = findStudyRoutes(graph, "start", "end");
  deepEqual(choices.map((route) => route.meters), [90, 140, 115]);
  deepEqual(choices[2].segments.map(({ to }) => to), ["junction", "south", "end"]);
  ok(choices[2].total < choices[0].total);
  ok(choices[2].total > choices[1].total);
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
