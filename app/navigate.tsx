import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { analyze, walkDuration } from "../src/analysis";
import { addEvent, database, getTrial, readTrial, write } from "../src/db";
import MapView, { Marker, Polyline, type MapHandle } from "../src/map";
import { beginGps, endGps, gpsRunning, nearDestination, requestLocation } from "../src/recording";
import { project, routeColors } from "../src/routes";
import { Body, Button, Card, Label, MapAttribution, Metric, Notice, Screen, Title, confirmAction, displayStatus, duration, message, palette, styles } from "../src/ui";
import { checkClock, command, drainWatch, finishTrial, watchStatus } from "../src/watch";

type Walk = NonNullable<Awaited<ReturnType<typeof readTrial>>>;
export default function Navigate() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const map = useRef<MapHandle>(null);
  const clock = useRef(0);
  const [walk, setWalk] = useState<Walk | null>();
  const [now, setNow] = useState(Date.now());
  const [warning, setWarning] = useState("");
  const [recover, setRecover] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = useRef(false);
  const [follow, setFollow] = useState(true);
  const analysis = useMemo(() => walk ? analyze(walk.gps, walk.hr, walk.events, walk.route) : null, [walk]);
  const last = analysis?.trace.at(-1);
  const along = useRef(0);
  const watch = watchStatus();

  useFocusEffect(useCallback(() => {
    if (!id) return;
    let live = true;
    let running = false;
    const update = async () => {
      if (running || action.current || AppState.currentState !== "active") return;
      running = true;
      try {
        const issue = await drainWatch();
        if (issue && live) setWarning(issue);
        const db = await database();
        const row = await getTrial(db, id);
        if (!live) return;
        if (!row) { setWalk(null); return; }
        if (row.status === "preparing" && !row.phone_started_at_ms &&
            ((row.mode === "paired" && row.watch_started_at_ms && !row.watch_stopped_at_ms) || row.mode === "gps")) {
          await beginGps(id);
        }
        const current = await readTrial(id);
        if (!live) return;
        setWalk(current);
        setNow(Date.now());
        if (current && ["recording", "paused"].includes(current.trial.status)) setRecover(!await gpsRunning());
        if (row.mode === "paired" && row.watch_started_at_ms && !row.watch_stopped_at_ms && Date.now() - clock.current > 90_000) {
          clock.current = Date.now();
          if (watchStatus().reachable) void checkClock(id).catch(() => { clock.current = 0; });
          else clock.current = 0;
        }
      } catch (error) { if (live) setWarning(message(error)); }
      finally { running = false; }
    };
    void update();
    const timer = setInterval(update, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [id]));

  const close = async (abandoned: boolean) => {
    if (!walk || action.current) return;
    action.current = true; setBusy(true); setWarning("");
    try {
      await endGps().catch(async (error) => {
        await addEvent(await database(), id, "location_error", Date.now(), { message: message(error) });
      });
      await finishTrial(walk.trial, abandoned);
      router.replace({ pathname: "/trials/[id]", params: { id } });
    } catch (error) { setWarning(message(error)); }
    finally { setBusy(false); action.current = false; }
  };
  if (!walk) return <Screen><Title>Current walk</Title><Body>{walk === null ? "Trial unavailable." : "Loading trial…"}</Body>
    {warning ? <Notice>{warning}</Notice> : null}</Screen>;

  const { trial, route, events } = walk;
  const open = ["preparing", "recording", "paused"].includes(trial.status);
  const paused = trial.status === "paused";
  const match = last ? project(last.point, route) : null;
  if (match && match.separation < 30) along.current = Math.max(match.along, along.current);
  let routeDistance = 0;
  const next = route.segments.find((segment) => {
    routeDistance += segment.meters;
    return routeDistance > along.current + 12;
  })?.end ?? route.geometry[route.geometry.length - 1];
  const deviations = events.filter((e) => ["off_route", "back_on_route"].includes(e.type));
  const watchEvent = events.filter((e) => e.device === "watch" && ["started", "paused", "resumed", "stopped", "error"].includes(e.type)).at(-1);
  const changePause = async () => {
    if (action.current) return;
    action.current = true; setBusy(true);
    try {
      const db = await database();
      await write(db, async (tx) => {
        const at = Date.now();
        const changed = await tx.runAsync("UPDATE trials SET status = ? WHERE id = ? AND status = ?",
          paused ? "recording" : "paused", id, paused ? "paused" : "recording");
        if (changed.changes) await addEvent(tx, id, paused ? "resume" : "pause", at);
      });
      if (trial.mode === "paired") await command(paused ? "RESUME" : "PAUSE", id);
      setWalk(await readTrial(id));
    } catch (error) { setWarning(message(error)); }
    finally { action.current = false; setBusy(false); }
  };
  const retryStart = async () => {
    try {
      if (!await command("START", id, { title: trial.title })) setWarning("Open Walking Study on the paired Watch and try again.");
      else setWarning("");
    } catch (error) { setWarning(message(error)); }
  };
  const resumeGps = async () => {
    if (action.current) return;
    action.current = true; setBusy(true);
    try { await requestLocation(); await beginGps(id, true); setRecover(false); }
    catch (error) { setWarning(message(error)); }
    finally { setBusy(false); action.current = false; }
  };
  const startedAt = trial.phone_started_at_ms ?? now;
  const until = trial.phone_stopped_at_ms ?? now;
  const elapsed = walkDuration(events, startedAt, until);

  return <Screen>
    <Title>{trial.title}</Title>
    <Body>{route.labels.join(" · ")} · {displayStatus(trial.status)}</Body>
    {warning || trial.reason ? <Notice>{warning || trial.reason}</Notice> : null}
    <View style={styles.map}><MapView ref={map} style={{ flex: 1 }}
      initialRegion={{ ...route.geometry[0], latitudeDelta: 0.012, longitudeDelta: 0.012 }}
      region={follow && last ? { ...last.point, latitudeDelta: 0.004, longitudeDelta: 0.004 } : undefined}
      onMapReady={() => { if (!last) map.current?.fitToCoordinates(route.geometry, {
        edgePadding: { left: 25, right: 25, top: 30, bottom: 30 }, animated: false,
      }); }}>
      <Polyline coordinates={route.geometry} strokeColor={routeColors[route.labels[0]]} strokeWidth={4} lineDashPattern={[7, 5]} />
      {analysis?.traceSegments.slice(-500).map((s, i) => <Polyline key={i} coordinates={[s.start, s.end]} strokeColor={palette.green} strokeWidth={4} />)}
      <Marker coordinate={next} title="Next waypoint" />
      {last && <Marker coordinate={last.point} title="Last accepted location" pinColor={palette.green} />}
    </MapView></View>
    {!walk.routes.demo && <MapAttribution />}
    <Button title={follow ? "Stop following map" : "Follow position on map"} secondary onPress={() => setFollow(!follow)} />
    <Card>
      <View style={styles.row}><Metric label="active time" value={duration(elapsed.active)} />
        <Metric label="observed distance" value={`${Math.round(analysis?.summary.meters ?? 0)} m`} /></View>
      {open && trial.phone_started_at_ms && !last && <Body>Waiting for a usable location fix.</Body>}
      {last && !paused && <Body>Next waypoint near {next.latitude.toFixed(5)}, {next.longitude.toFixed(5)}</Body>}
      {trial.mode === "gps" && <Body>{Platform.OS === "web" && open ? "GPS-only test. Keep this tab open and visible." : "GPS-only test"}</Body>}
      {trial.mode === "paired" && <>
        <Label>Apple Watch</Label>
        <Body>{trial.watch_stopped_at_ms ? "Workout ended" : watchEvent?.type === "paused" ? "Paused on Watch" : trial.watch_started_at_ms ?
          (watch.reachable ? "Workout started" : "Workout started · link unavailable") : "Waiting for confirmation on Watch"}</Body>
        <Body>{walk.hr.length} Watch samples imported</Body>
      </>}
    </Card>
    {deviations.at(-1)?.type === "off_route" && <Notice>You appear to be off the selected route.</Notice>}
    {last && open && nearDestination(last.point, route) && <Notice>Destination nearby. Finish when you’re ready.</Notice>}
    {recover && <Card><Label>Location recording was interrupted</Label>
      <Button title="Resume location recording" onPress={resumeGps} disabled={busy} />
      <Button title="Close as interrupted" onPress={() => void close(true)} secondary disabled={busy} />
    </Card>}
    {trial.status === "preparing" && trial.mode === "paired" && <Button title="Resend start to Watch" secondary onPress={retryStart} />}
    {open ? <>
      {trial.phone_started_at_ms && !recover && <Button title={paused ? "Resume walk" : "Pause walk"} onPress={changePause} secondary disabled={busy} />}
      <Button title="Finish walk" onPress={() => void close(false)} disabled={busy || !trial.phone_started_at_ms} />
      <Button title="Abandon walk" secondary disabled={busy} onPress={() => confirmAction("Abandon this walk?",
        "Recorded samples will remain available in trial history.", "Keep walking", "Abandon walk", () => void close(true))} />
    </> : <Button title="Review trial" onPress={() => router.replace({ pathname: "/trials/[id]", params: { id } })} />}
  </Screen>;
}
