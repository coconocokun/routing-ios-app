import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform, Switch, TextInput, View } from "react-native";
import { createTrial } from "../src/db";
import { saveDemo } from "../src/demo";
import MapView, { Marker, Polyline, type MapHandle, type MapPressEvent } from "../src/map";
import { beginGps, currentLocation, requestLocation } from "../src/recording";
import { demoRoutes, routeColors, type Point, type RouteSet } from "../src/routes";
import { requestMapPaths, requestRoutes } from "../src/routing";
import { Body, Button, Card, Label, MapAttribution, Metric, Notice, Screen, Title, message, palette, styles } from "../src/ui";
import { command, watchAvailable } from "../src/watch";

const initial = { latitude: 37.772, longitude: -122.482 };

export default function Plan() {
  const map = useRef<MapHandle>(null);
  const [origin, setOrigin] = useState<Point>();
  const [destination, setDestination] = useState<Point>();
  const [routes, setRoutes] = useState<RouteSet>();
  const [mapPaths, setMapPaths] = useState<Awaited<ReturnType<typeof requestMapPaths>> | null>();
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [participant, setParticipant] = useState("");
  const [useWatch, setUseWatch] = useState(false);
  const [canPair, setCanPair] = useState(watchAvailable);
  const [permitted, setPermitted] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const route = routes?.choices.find((candidate) => candidate.id === id);

  useEffect(() => {
    if (!routes || routes.demo) return;
    let active = true;
    void requestMapPaths(routes.origin, routes.destination).catch(() => null).then((paths) => {
      if (active) setMapPaths(paths);
    });
    return () => { active = false; };
  }, [routes]);

  useEffect(() => {
    if (!routes || routes.demo || Platform.OS === "web") return;
    const refresh = () => setCanPair(watchAvailable());
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [routes]);

  const run = async (work: () => Promise<void>) => {
    if (working) return;
    setProblem(""); setWorking(true);
    try { await work(); } catch (error) { setProblem(message(error)); }
    finally { setWorking(false); }
  };
  const show = (result: RouteSet) => {
    setRoutes(result); setId(result.choices[0].id); setOrigin(result.origin); setDestination(result.destination);
    map.current?.fitToCoordinates(result.choices.flatMap((choice) => choice.geometry),
      { edgePadding: { top: 45, bottom: 45, left: 35, right: 35 }, animated: true });
  };
  const tap = ({ nativeEvent }: MapPressEvent) => {
    if (working || routes) return;
    if (!origin) setOrigin(nativeEvent.coordinate);
    else setDestination(nativeEvent.coordinate);
  };
  const currentPosition = () => run(async () => {
    const fix = await currentLocation();
    setOrigin(fix.coords); setRoutes(undefined); setMapPaths(undefined);
    map.current?.animateToRegion({ ...fix.coords, latitudeDelta: 0.015, longitudeDelta: 0.015 });
  });
  const prepare = () => run(async () => {
    if (!route || !routes) return;
    const name = title.trim() || `${routes.demo ? "Demo" : "Trial"} ${new Date().toLocaleDateString("en-CA")} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (routes.demo) {
      const trialId = await saveDemo(route, routes, name);
      router.replace({ pathname: "/trials/[id]", params: { id: trialId } });
      return;
    }
    if (!permitted) throw new Error("Confirm that this walk and its data collection are authorized.");
    if (useWatch && !watchAvailable()) throw new Error("The Watch app is unavailable. Reconnect it or turn off Watch recording.");
    await requestLocation();
    const trialId = await createTrial(route, routes, name, participant, useWatch ? "paired" : "gps");
    try {
      if (useWatch) {
        await command("PREPARE", trialId, { route_id: route.id });
        await command("START", trialId, { title: name });
      } else await beginGps(trialId);
    } finally { router.replace({ pathname: "/navigate", params: { id: trialId } }); }
  });

  return <Screen>
    <Title>{routes ? "Choose a route" : "Choose your endpoints"}</Title>
    <Body>{routes ? "Compare distance, elevation and predicted walking cost." : "Tap the map for a start and destination, or use your current position as the start."}</Body>
    <View style={styles.map}>
      <MapView ref={map} style={{ flex: 1 }} onPress={tap}
        initialRegion={{ ...initial, latitudeDelta: 0.023, longitudeDelta: 0.023 }}>
        {mapPaths?.map(({ id, points }) => <Polyline key={`osm-${id}`} coordinates={points}
          strokeColor="#626b69" strokeWidth={2} lineDashPattern={[4, 4]} />)}
        {origin && <Marker coordinate={origin} title="Start" pinColor={palette.green} />}
        {destination && <Marker coordinate={destination} title="Destination" />}
        {routes?.choices.map((choice) => <Polyline key={choice.id} coordinates={choice.geometry}
          strokeColor={routeColors[choice.labels[0]]} strokeWidth={choice.id === id ? 6 : 3} tappable onPress={() => setId(choice.id)} />)}
      </MapView>
    </View>
    {routes && !routes.demo && <MapAttribution />}
    {mapPaths?.length ? <Body>Dashed gray lines show OSM paths and steps near the endpoints.</Body> : null}
    {mapPaths === null && <Body>Nearby OSM map details are temporarily unavailable.</Body>}
    {problem ? <Notice>{problem}</Notice> : null}
    {!routes ? <>
      <Button title="Use current position" onPress={currentPosition} secondary disabled={working} />
      <Button title={working ? "Working…" : "Find walking routes"} disabled={!origin || !destination || working} onPress={() => run(async () => {
        if (origin && destination) show(await requestRoutes(origin, destination));
      })} />
      <Body>Finding routes sends your selected start and destination to Valhalla and Overpass. Valhalla also receives points along the proposed routes to look up elevation.</Body>
      <Button title="Explore synthetic routes" secondary disabled={working} onPress={() => show(demoRoutes())} />
    </> : <>
      {routes.demo && <Notice>Simulation only. These paths and readings are synthetic. Live recording is disabled.</Notice>}
      {!routes.demo && <Body>Labels compare the available Valhalla routes that pass the study’s checks.</Body>}
      {routes.choices.map((choice) => <Card key={choice.id}>
        <View style={{ flexDirection: "row", gap: 9, alignItems: "center" }}>
          <View style={{ backgroundColor: routeColors[choice.labels[0]], height: 10, width: 10, borderRadius: 5 }} />
          <Label>{choice.labels.join(" · ")}</Label>
        </View>
        <View style={styles.row}>
          <Metric label="distance" value={`${(choice.meters / 1000).toFixed(2)} km`} />
          <Metric label="estimated time" value={`${Math.ceil(choice.minutes)} min`} />
          <Metric label="gain / loss" value={`${choice.gain.toFixed(0)} / ${choice.loss.toFixed(0)} m`} />
          <Metric label="mean J/kg/m" value={choice.mean.toFixed(2)} />
          <Metric label="total J/kg" value={choice.total.toFixed(0)} />
          <Metric label="max absolute grade" value={`${(100 * choice.maxGrade).toFixed(1)}%`} />
        </View>
        {choice.warnings.map((warning) => <Body key={warning}>{warning}</Body>)}
        <Button title={choice.id === id ? "Selected" : "Select route"} secondary={choice.id !== id}
          disabled={working} onPress={() => setId(choice.id)} />
      </Card>)}
      <Card>
        <Label>Trial name</Label>
        <TextInput accessibilityLabel="Trial name" style={styles.input} value={title} onChangeText={setTitle}
          placeholder="Use a neutral title" maxLength={80} />
        {!routes.demo && <>
          <Label>Participant code (optional)</Label>
          <TextInput accessibilityLabel="Participant code" style={styles.input} value={participant}
            onChangeText={setParticipant} autoCapitalize="characters" placeholder="For example, P03" maxLength={24} />
          <View style={styles.row}><View style={{ flex: 1 }}><Body>This walk and its data collection are authorized.</Body></View>
            <Switch accessibilityLabel="This walk and its data collection are authorized" value={permitted} onValueChange={setPermitted} /></View>
          {(canPair || useWatch) && <View style={styles.row}>
            <View style={{ flex: 1 }}><Body>Record heart rate with Apple Watch</Body></View>
            <Switch accessibilityLabel="Record heart rate with Apple Watch" value={useWatch} onValueChange={setUseWatch} />
          </View>}
          {!useWatch && <Body>{Platform.OS === "web" ? "GPS-only test. Keep this tab open and visible while recording." : "GPS-only engineering test."}</Body>}
        </>}
        <Button title={working ? "Preparing…" : routes.demo ? "Save and review demo" : useWatch ? "Send start to Watch" : "Start GPS test"}
          disabled={working || (!routes.demo && !permitted)} onPress={prepare} />
      </Card>
    </>}
    {(origin || destination) && <Button title="Clear endpoints" disabled={working} secondary onPress={() => {
      setOrigin(undefined); setDestination(undefined); setRoutes(undefined); setMapPaths(undefined); setId(""); setProblem(""); setUseWatch(false);
    }} />}
  </Screen>;
}
