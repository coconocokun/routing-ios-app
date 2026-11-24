import Slider from "@react-native-community/slider";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import { analysisVersion, analyze, policy, walkDuration } from "../../src/analysis";
import { Scatter, heatColor, legend } from "../../src/charts";
import { database, deleteTrial, readTrial } from "../../src/db";
import { exportWalk } from "../../src/export";
import { routeColors, type Point } from "../../src/routes";
import { Body, Button, Card, Label, MapAttribution, Metric, Notice, Screen, Title, displayStatus, duration, message, palette, styles } from "../../src/ui";
import { command } from "../../src/watch";

const tabs = ["Overview", "Replay", "HR map", "HR vs distance", "HR vs slope", "Data quality"] as const;
type Tab = typeof tabs[number];
type Walk = NonNullable<Awaited<ReturnType<typeof readTrial>>>;
const number = (value: number | null | undefined, digits = 0) => value == null ? "—" : value.toFixed(digits);

export default function ReviewTrial() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [walk, setWalk] = useState<Walk | null>();
  const [tab, setTab] = useState<Tab>("Overview");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [lag, setLag] = useState(0);
  const refresh = useCallback(async () => {
    try { setWalk(await readTrial(id)); } catch (error) { setProblem(message(error)); }
  }, [id]);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  const waiting = walk?.trial.status === "sync_pending";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, 3700);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  const analysis = useMemo(() => walk ? analyze(walk.gps, walk.hr, walk.events, walk.route, lag) : null, [walk, lag]);
  if (!walk || !analysis) return <Screen><Title>Review trial</Title><Body>{walk === null ? "Trial unavailable." : "Loading trial…"}</Body>
    {problem ? <Notice>{problem}</Notice> : null}</Screen>;
  const { trial, route, routes } = walk;
  const { summary, aligned, trace } = analysis;
  const elapsed = trial.phone_started_at_ms !== null && trial.phone_stopped_at_ms !== null ?
    walkDuration(walk.events, trial.phone_started_at_ms, trial.phone_stopped_at_ms) : null;
  const open = ["preparing", "recording", "paused"].includes(trial.status);
  const distinct = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setProblem("");
    try { await work(); } catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  };
  const rename = () => Alert.prompt("Rename trial", "Use a neutral title.", (input) => {
    const title = input.trim().slice(0, 80);
    if (!title) return;
    void run(async () => {
      await (await database()).runAsync("UPDATE trials SET title = ? WHERE id = ?", title, id);
      await refresh();
    });
  }, "plain-text", trial.title);
  const remove = () => Alert.alert("Delete this trial?", "The app will remove its local records and request deletion from the Watch. Shared copies and Apple Health workouts are managed separately.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete trial", style: "destructive", onPress: () => void run(async () => {
      await deleteTrial(id);
      if (trial.mode === "paired") await command("DELETE", id).catch(() => false);
      router.replace("/trials");
    }) },
  ]);
  const share = () => Alert.alert("Share trial export",
    "The full ZIP includes exact locations, UTC times and raw readings. The reduced ZIP still contains heart-rate readings and route metrics.", [
      { text: "Cancel", style: "cancel" },
      { text: "Without exact locations", onPress: () => void run(() => exportWalk(walk, false, lag)) },
      { text: "Full ZIP", onPress: () => void run(() => exportWalk(walk, true, lag)) },
    ]);

  return <Screen>
    <Title>{trial.title}</Title>
    <Body>{route.labels.join(" · ")} · {displayStatus(trial.status)}</Body>
    {trial.mode === "demo" && <Notice>Synthetic demo. All measurements are simulated.</Notice>}
    {trial.reason || problem ? <Notice>{problem || trial.reason}</Notice> : null}
    {waiting && <Card>
      <Body>The Watch import is waiting for a matching final manifest and sample series. You can review available data.</Body>
      <Button title="Retry Watch sync" disabled={busy} secondary onPress={() => run(async () => {
        await command("STOP", id);
        if (!await command("SYNC_REQUEST", id)) throw new Error("Open the companion app on the paired Watch and try again.");
      })} />
    </Card>}
    {open && <Button title="Open current walk" onPress={() => router.replace({ pathname: "/navigate", params: { id } })} />}
    <View style={styles.row}>
      {tabs.map((name) => <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: tab === name }}
        onPress={() => setTab(name)} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
          backgroundColor: tab === name ? palette.green : palette.mint }}>
        <Text style={{ color: tab === name ? "white" : palette.green, fontWeight: "700" }}>{name}</Text>
      </Pressable>)}
    </View>
    {tab === "Overview" && <>
      <Card><Label>Observed walk</Label>
        <View style={styles.row}>
          <Metric label="distance" value={`${number(summary.meters / 1000, 2)} km`} />
          <Metric label="elapsed time" value={elapsed ? duration(elapsed.wall) : "—"} />
          <Metric label="active time" value={elapsed ? duration(elapsed.active) : "—"} />
          <Metric label="speed with GPS coverage" value={summary.averageSpeedMps === null ? "—" : `${number(summary.averageSpeedMps, 2)} m/s`} />
          <Metric label="mean HR" value={number(summary.meanBpm)} />
          <Metric label="median HR" value={number(summary.medianBpm)} />
          <Metric label="max HR" value={number(summary.maxBpm)} />
        </View>
      </Card>
      <Card><Label>Planned route</Label>
        <Body>{(route.meters / 1000).toFixed(2)} km · {route.gain.toFixed(0)} m ascent · {route.loss.toFixed(0)} m descent</Body>
        <Body>Predicted {route.total.toFixed(0)} J/kg total · {route.mean.toFixed(2)} J/kg/m</Body>
        <Body>{new Date(trial.created_at_ms).toLocaleString(undefined, { timeZone: trial.timezone })} · {trial.timezone}</Body>
        {trial.participant && <Body>Participant {trial.participant}</Body>}
      </Card>
      {!open && <>
        <Button title="Export ZIP" onPress={share} disabled={busy} />
        <Button title="Rename trial" onPress={rename} secondary disabled={busy} />
        <Button title="Delete trial" onPress={remove} secondary disabled={busy} />
      </>}
    </>}
    {(tab === "Replay" || tab === "HR map") && <TraceView key={tab} walk={walk} data={analysis} heat={tab === "HR map"} />}
    {tab === "HR vs distance" && <Card>
      <Label>Heart rate by distance walked</Label>
      <Scatter xTitle="Observed distance (m)" yTitle="Heart rate (bpm)" points={aligned.flatMap((sample) =>
        sample.meters === null ? [] : [{ x: sample.meters, y: sample.bpm,
          label: `${sample.meters.toFixed(0)} m · ${sample.bpm.toFixed(0)} bpm` }])} />
      <Body>Matched GPS coverage {distinct(summary.matchedFraction)} · mean {number(summary.meanBpm)} · median {number(summary.medianBpm)} · max {number(summary.maxBpm)} bpm</Body>
    </Card>}
    {tab === "HR vs slope" && <>
      <Card><Label>Heart rate and signed grade</Label>
        <Scatter xTitle="Observed distance (m)" yTitle="Heart rate (bpm)" points={aligned.flatMap((row) =>
          row.meters === null ? [] : [{ x: row.meters, y: row.bpm }])} />
        <Scatter xTitle="Observed distance (m)" yTitle="Signed grade (%)" color="#9a561a" points={trace.flatMap((fix) =>
          fix.grade === null ? [] : [{ x: fix.meters, y: fix.grade * 100 }])} />
        <Body>Grade is estimated from {routes.demVersion} over a {policy.gradeWindowM} m window where the trace matches the planned corridor.</Body>
      </Card>
      <Card><Label>Grade and delayed heart rate</Label>
        <View style={styles.row}>{[0, 15, 30, 60].map((value) => <Button key={value} title={`${value}s lag`} secondary={value !== lag} onPress={() => setLag(value)} />)}</View>
        <Scatter key={lag} xTitle="Signed grade (%)" yTitle="Heart rate (bpm)" points={aligned.flatMap((row) =>
          row.grade === null ? [] : [{ x: row.grade * 100, y: row.bpm }])} />
        <Body>{summary.gradePairs} valid pairs · {lag} s lag</Body>
      </Card>
    </>}
    {tab === "Data quality" && <Card>
      <Label>Coverage and provenance</Label>
      <Body>{summary.acceptedGpsCount} of {summary.gpsCount} GPS fixes used · {summary.hrCount} Watch readings imported</Body>
      <Body>{distinct(summary.matchedFraction)} HR matched · {summary.gradePairs} grade pairs · {distinct(summary.offRouteFraction)} of accepted fixes off route</Body>
      <Body>{summary.gpsBreakCount} trace breaks · longest HR gap {number(summary.longestHrGapS, 1)} s</Body>
      {elapsed && <Body>Paused time {duration(elapsed.paused)}</Body>}
      <Body>Algorithm {routes.algorithm} · graph {routes.graphVersion} · elevation {routes.demVersion}</Body>
      <Body>Analysis {analysisVersion} · HR alignment requires nearby GPS and a Watch clock probe with at most {policy.clockMaxUncertaintyMs / 1000} s uncertainty.</Body>
      {walk.events.filter((event) => ["pause", "resume", "off_route", "location_error", "recovered", "error"].includes(event.type)).map((event, i) =>
        <Body key={i}>{new Date(event.observed_at_ms).toLocaleTimeString()} · {event.device} · {event.type.replaceAll("_", " ")}</Body>)}
    </Card>}
  </Screen>;
}

type Analysis = ReturnType<typeof analyze>;
function TraceView({ walk, data, heat }: { walk: Walk; data: Analysis; heat: boolean }) {
  const map = useRef<MapView>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(false);
  const [inspection, setInspection] = useState("");
  const start = walk.trial.phone_started_at_ms ?? data.trace[0]?.observed_at_ms ?? 0;
  const stop = walk.trial.phone_stopped_at_ms ?? data.trace.at(-1)?.observed_at_ms ?? start;
  const total = Math.max(0, stop - start);
  const [elapsed, setElapsed] = useState(0);
  const time = start + elapsed;
  const cursor = data.interpolate(time);
  useEffect(() => {
    if (!playing) return;
    const tick = setInterval(() => setElapsed((value) => Math.min(total, value + 250 * rate)), 250);
    return () => clearInterval(tick);
  }, [playing, rate, total]);
  useEffect(() => { if (playing && elapsed >= total) setPlaying(false); }, [elapsed, total, playing]);
  const nearest = data.aligned.reduce<(typeof data.aligned)[number] | null>((best, sample) =>
    sample.meters !== null && (!best || Math.abs(sample.time - time) < Math.abs(best.time - time)) ? sample : best, null);
  const accuracy = data.trace.reduce<(typeof data.trace)[number] | null>((best, row) =>
    !best || Math.abs(row.observed_at_ms - time) < Math.abs(best.observed_at_ms - time) ? row : best, null);
  const tracePaths = useMemo(() => {
    type Path = { points: Point[]; color: string; min: number | null; max: number | null; last: Point };
    const paths: Path[] = [];
    for (const segment of data.traceSegments) {
      const color = heat ? heatColor(segment.bpm) : palette.green;
      const prior = paths.at(-1);
      if (prior && prior.color === color && prior.last === segment.start) {
        prior.points.push(segment.end); prior.last = segment.end;
        if (segment.bpm !== null) { prior.min = Math.min(prior.min ?? Infinity, segment.bpm); prior.max = Math.max(prior.max ?? 0, segment.bpm); }
      } else paths.push({ points: [segment.start, segment.end], color, min: segment.bpm, max: segment.bpm, last: segment.end });
    }
    return paths;
  }, [data.traceSegments, heat]);
  return <Card>
    <Label>{heat ? "Observed heart rate (bpm)" : "Trace replay"}</Label>
    {data.trace.length ? <View style={styles.map}><MapView ref={map} style={{ flex: 1 }}
      initialRegion={{ ...walk.route.geometry[0], latitudeDelta: 0.012, longitudeDelta: 0.012 }}
      region={follow && cursor && !heat ? { ...cursor.point, latitudeDelta: 0.004, longitudeDelta: 0.004 } : undefined}
      onMapReady={() => map.current?.fitToCoordinates([...walk.route.geometry, ...data.trace.map((fix) => fix.point)],
        { animated: false, edgePadding: { left: 25, right: 25, top: 30, bottom: 30 } })}>
      <Polyline coordinates={walk.route.geometry} strokeColor={routeColors[walk.route.labels[0]]} strokeWidth={3} lineDashPattern={[6, 5]} />
      {tracePaths.map((path, i) => <Polyline key={i} coordinates={path.points} strokeWidth={5} strokeColor={path.color}
        tappable={heat} onPress={() => setInspection(path.min === null || path.max === null ? "No reliable HR for this segment." :
          path.min === path.max ? `${number(path.min)} bpm` : `${number(path.min)}–${number(path.max)} bpm on this segment`)} />)}
      {!heat && cursor && <Marker coordinate={cursor.point} pinColor={palette.green} title="Replay position" />}
    </MapView></View> : <Body>No usable GPS fixes for this trial.</Body>}
    {data.trace.length > 0 && !walk.routes.demo && <MapAttribution />}
    {heat ? <>
      <View style={styles.row}>{legend.map(([value, label]) => <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={{ width: 11, height: 11, backgroundColor: heatColor(value), borderRadius: 3 }} /><Body>{label}</Body>
      </View>)}</View>
      <Body>Same scale across trials. Colors use nearby observed readings within {policy.heatMs / 1000} s of both segment ends.</Body>
      {inspection && <Body>{inspection}</Body>}
    </> : <>
      <Slider accessibilityLabel="Replay time" value={elapsed} minimumValue={0} maximumValue={Math.max(1, total)}
        onValueChange={setElapsed} disabled={!data.trace.length} minimumTrackTintColor={palette.green} />
      <Body>{duration(elapsed)} / {duration(total)} · {new Date(time).toLocaleTimeString(undefined, { timeZone: walk.trial.timezone })}</Body>
      <Body>{cursor ? `${number(cursor.meters)} m walked · GPS accuracy ${number(accuracy?.horizontal_accuracy_m)} m` :
        "Position unavailable during this interval."}</Body>
      {cursor && nearest && Math.abs(nearest.time - time) <= policy.heatMs && <Body>{number(nearest.bpm)} bpm · observed</Body>}
      <View style={styles.row}>
        <Button title={playing ? "Pause" : "Play"} disabled={!total || !data.trace.length} onPress={() => {
          if (!playing && elapsed >= total) setElapsed(0);
          setPlaying(!playing);
        }} />
        {[1, 2, 5].map((speed) => <Button key={speed} title={`${speed}×`} secondary={rate !== speed} onPress={() => setRate(speed)} />)}
      </View>
      <Button title={follow ? "Keep map fixed" : "Follow replay position"} secondary onPress={() => setFollow(!follow)} />
      <Body>Dashed line shows the plan. Gaps in the solid trace indicate missing or paused intervals.</Body>
    </>}
  </Card>;
}
