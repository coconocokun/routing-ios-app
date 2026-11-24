import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createTrial } from "../src/db";
import { saveDemo } from "../src/demo";
import MapView, { Marker, Polyline, type MapHandle, type MapPressEvent } from "../src/map";
import { searchPlaces, type Place } from "../src/places";
import { beginGps, currentLocation, requestLocation } from "../src/recording";
import { demoRoutes, routeColors, type Point, type RouteSet } from "../src/routes";
import { requestRoutes } from "../src/routing";
import { Body, Button, Label, MapAttribution, Metric, Notice, message, palette, styles } from "../src/ui";
import { command, watchAvailable } from "../src/watch";

const initialRegion = { latitude: 37.772, longitude: -122.482, latitudeDelta: 0.023, longitudeDelta: 0.023 };
const fieldNames = { start: "Start point", destination: "Destination" } as const;
const fields = ["start", "destination"] as const;
const destinationColor = "#ad4635";
type Field = typeof fields[number];
type Endpoints = Partial<Record<Field, Place>>;
type RouteResponse = { start: Place; destination: Place } & (Awaited<ReturnType<typeof requestRoutes>> | { error: string });

export default function Plan() {
  const insets = useSafeAreaInsets();
  const map = useRef<MapHandle>(null);
  const startInput = useRef<ComponentRef<typeof TextInput>>(null);
  const destinationInput = useRef<ComponentRef<typeof TextInput>>(null);
  const mapCenter = useRef<Point>(initialRegion);
  const rememberCenter = useCallback((point: Point) => { mapCenter.current = point; }, []);
  const [mapReady, setMapReady] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [headerHeight, setHeaderHeight] = useState(0);
  const [sheetHeight, setSheetHeight] = useState(0);
  const [endpoints, setEndpoints] = useState<Endpoints>({});
  const [editing, setEditing] = useState<Field | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ field: Field; query: string; places?: Place[]; error?: string }>();
  const [response, setResponse] = useState<RouteResponse>();
  const [attempt, setAttempt] = useState(0);
  const [demo, setDemo] = useState<RouteSet>();
  const [selectedId, setSelectedId] = useState("");
  const [details, setDetails] = useState(false);
  const [title, setTitle] = useState("");
  const [participant, setParticipant] = useState("");
  const [useWatch, setUseWatch] = useState(false);
  const [canPair, setCanPair] = useState(watchAvailable);
  const [permitted, setPermitted] = useState(false);
  const [activity, setActivity] = useState<"location" | "start">();
  const [problem, setProblem] = useState("");

  const { start, destination } = endpoints;
  const result = response && response.start === start && response.destination === destination ? response : undefined;
  const routes = demo ?? (result && "routes" in result ? result.routes : undefined);
  const route = routes?.choices.find((choice) => choice.id === selectedId) ?? routes?.choices[0];
  const routeError = result && "error" in result ? result.error : "";
  const findingRoutes = Boolean(start && destination && !routes && !routeError);
  const mapPaths = !demo && result && "mapPaths" in result ? result.mapPaths : undefined;
  const target = editing ?? (!start ? "start" : !destination ? "destination" : null);
  const term = query.trim();
  const matches = search?.query === term && search.field === editing ? search : undefined;
  const topInset = insets.top + 8;
  const bottomInset = insets.bottom + 12;
  const attributionBottom = viewport.width > 1050 ? insets.bottom : bottomInset + (editing ? 0 : sheetHeight);
  const legalInsets = { top: 0, left: 0, right: 0, bottom: attributionBottom };

  useEffect(() => {
    if (!editing || term.length < 2) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const debounce = setTimeout(() => {
      timeout = setTimeout(() => {
        controller.abort();
        setSearch({ field: editing, query: term, error: "Place search timed out. Try again or tap the map." });
      }, 10_000);
      void searchPlaces(term, mapCenter.current, controller.signal).then((places) => {
        if (!controller.signal.aborted) setSearch({ field: editing, query: term, places });
      }).catch(() => {
        if (!controller.signal.aborted) setSearch({ field: editing, query: term, error: "Place search is unavailable. Try again or tap the map." });
      }).finally(() => clearTimeout(timeout));
    }, 350);
    return () => { clearTimeout(debounce); clearTimeout(timeout); controller.abort(); };
  }, [editing, term]);

  useEffect(() => {
    if (!start || !destination || demo) return;
    const controller = new AbortController();
    void requestRoutes(start.point, destination.point, controller.signal).then((plan) => {
      if (!controller.signal.aborted) setResponse({ start, destination, ...plan });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResponse({ start, destination, error: message(error) });
    });
    return () => controller.abort();
  }, [start, destination, demo, attempt]);

  useEffect(() => {
    if (!routes || routes.demo || Platform.OS === "web") return;
    const refresh = () => setCanPair(watchAvailable());
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [routes]);

  useEffect(() => {
    if (!routes || !mapReady || !viewport.height || !headerHeight || !sheetHeight || editing) return;
    const top = topInset + headerHeight + 22;
    const bottom = Math.min(bottomInset + sheetHeight + 22, viewport.height - top - 48);
    // Defer until the sheet has reported its layout, so the route fits in the exposed map.
    const frame = requestAnimationFrame(() => {
      map.current?.fitToCoordinates(routes.choices.flatMap((choice) => choice.geometry),
        { edgePadding: { top, bottom: Math.max(0, bottom), left: 30, right: 30 }, animated: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [routes, mapReady, viewport, topInset, bottomInset, headerHeight, sheetHeight, editing]);

  const closeSearch = () => {
    Keyboard.dismiss();
    setEditing(null);
    setQuery("");
    setSearch(undefined);
  };

  const changeEndpoint = (field: Field, place?: Place) => {
    setEndpoints((previous) => ({ ...(demo ? {} : previous), [field]: place }));
    setDemo(undefined);
    setResponse(undefined);
    setSelectedId("");
    setDetails(false);
    setProblem("");
  };

  const pickPlace = (field: Field, place: Place, recenter: boolean) => {
    changeEndpoint(field, place);
    closeSearch();
    if (recenter) {
      mapCenter.current = place.point;
      map.current?.animateToRegion({ ...place.point, latitudeDelta: 0.008, longitudeDelta: 0.008 });
    }
  };

  const tap = ({ nativeEvent }: MapPressEvent) => {
    if (activity || !target) return;
    const point = nativeEvent.coordinate;
    pickPlace(target, { point, name: `Pin · ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` }, false);
  };

  const useCurrentLocation = async () => {
    if (activity) return;
    closeSearch();
    setProblem("");
    setActivity("location");
    try {
      const { coords: { latitude, longitude } } = await currentLocation();
      pickPlace("start", { point: { latitude, longitude }, name: "Current location" }, true);
    } catch (error) { setProblem(message(error)); }
    finally { setActivity(undefined); }
  };

  const showDemo = () => {
    const result = demoRoutes();
    setEndpoints({ start: { point: result.origin, name: "Demo start" },
      destination: { point: result.destination, name: "Demo destination" } });
    setProblem("");
    setSelectedId("");
    setDemo(result);
  };

  const prepare = async () => {
    if (activity || !route || !routes) return;
    setProblem("");
    setActivity("start");
    const name = title.trim() || `${routes.demo ? "Demo" : "Trial"} ${new Date().toLocaleDateString("en-CA")} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    try {
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
    } catch (error) { setProblem(message(error)); }
    finally { setActivity(undefined); }
  };

  return <View style={plan.screen} onLayout={({ nativeEvent: { layout: { width, height } } }) => setViewport({ width, height })}>
    <View style={StyleSheet.absoluteFill}>
      <MapView ref={map} style={StyleSheet.absoluteFill} initialRegion={initialRegion} onPress={tap}
        onMapReady={() => setMapReady(true)} onRegionChangeComplete={rememberCenter}
        legalLabelInsets={legalInsets} appleLogoInsets={legalInsets} zoomControlEnabled={false}>
        {mapPaths?.map(({ id, points }) => <Polyline key={`osm-${id}`} coordinates={points}
          strokeColor="#626b69" strokeWidth={2} lineDashPattern={[4, 4]} />)}
        {routes?.choices.filter((choice) => choice !== route).map((choice) => <Polyline key={choice.id}
          coordinates={choice.geometry} strokeColor="#778b9d" strokeWidth={4} tappable={!editing && !activity}
          onPress={() => setSelectedId(choice.id)} />)}
        {route && <Polyline key={`outline-${route.id}`} coordinates={route.geometry} strokeColor="#fff" strokeWidth={10} zIndex={1} />}
        {route && <Polyline key={`selected-${route.id}`} coordinates={route.geometry}
          strokeColor={routeColors[route.labels[0]]} strokeWidth={6} zIndex={2} />}
        {start && <Marker coordinate={start.point} title="Start point" pinColor={palette.green} />}
        {destination && <Marker coordinate={destination.point} title="Destination" pinColor={destinationColor} />}
      </MapView>
    </View>

    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View style={[plan.overlay, { paddingTop: topInset, paddingBottom: bottomInset }]} pointerEvents="box-none">
        <View style={plan.top} pointerEvents="box-none">
          <View style={plan.header} pointerEvents="box-none" onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
            <Pressable accessibilityRole="button" accessibilityLabel={editing ? "Close search" : "Back to Walking Study"}
              disabled={Boolean(activity)} onPress={() => {
                if (editing) closeSearch();
                else if (router.canGoBack()) router.back();
                else router.replace("/");
              }} style={({ pressed }) => [plan.surface, plan.back, pressed && plan.pressed]}>
              <Text style={plan.backGlyph}>{editing ? "×" : "‹"}</Text>
            </Pressable>
            <View style={[plan.surface, plan.fields]}>
              {fields.map((field) => {
                const place = endpoints[field];
                const focused = editing === field;
                const value = focused ? query : place?.name ?? "";
                const input = field === "start" ? startInput : destinationInput;
                return <View key={field} style={[plan.field, field === "destination" && plan.fieldDivider, target === field && plan.activeField]}>
                  <View style={[plan.dot, field === "destination" && plan.destinationDot]} />
                  <View style={plan.fieldText}>
                    <Text style={plan.fieldLabel}>{fieldNames[field]}</Text>
                    <TextInput ref={input} accessibilityLabel={fieldNames[field]} placeholder="Search for a place"
                      placeholderTextColor={palette.quiet} style={plan.searchInput} value={value} maxLength={160}
                      editable={!activity} autoCorrect={false} returnKeyType="search" submitBehavior="blurAndSubmit"
                      onFocus={() => { setEditing(field); setQuery(""); setSearch(undefined); setProblem(""); }}
                      onChangeText={setQuery} />
                  </View>
                  {(value || place) && <Pressable accessibilityRole="button" accessibilityLabel={`Clear ${fieldNames[field].toLowerCase()}`}
                    disabled={Boolean(activity)} style={plan.clear} onPress={() => {
                      changeEndpoint(field);
                      setQuery("");
                      setSearch(undefined);
                      input.current?.focus();
                    }}><Text style={plan.clearGlyph}>×</Text></Pressable>}
                </View>;
              })}
            </View>
          </View>

          {editing && <ScrollView style={[plan.surface, plan.searchResults]} contentContainerStyle={plan.searchContent}
            keyboardShouldPersistTaps="handled" accessibilityLabel={`${fieldNames[editing]} search results`}>
            {editing === "start" && <Pressable accessibilityRole="button" onPress={() => void useCurrentLocation()}
              style={({ pressed }) => [plan.result, pressed && plan.pressed]}>
              <Text style={plan.action}>Use current location</Text>
            </Pressable>}
            <Text style={plan.hint}>Or tap the map to set the {editing === "start" ? "start point" : "destination"}.</Text>
            {term.length >= 2 && (matches?.error ? <Notice>{matches.error}</Notice> : matches?.places ?
              matches.places.length ? matches.places.map((place, index) => <Pressable key={`${place.name}-${index}`}
                accessibilityRole="button" onPress={() => pickPlace(editing, place, true)}
                style={({ pressed }) => [plan.result, pressed && plan.pressed]}>
                <Text style={plan.resultName}>{place.name}</Text>
                {place.detail ? <Text style={plan.hint}>{place.detail}</Text> : null}
              </Pressable>) : <Text style={plan.hint} accessibilityLiveRegion="polite">No places found. Try a city or street name.</Text> :
              <View style={plan.progress}><ActivityIndicator color={palette.green} /><Text style={plan.hint}>Searching places…</Text></View>)}
            {matches?.places?.length ? <MapAttribution /> : null}
          </ScrollView>}
        </View>

        {!editing && <View style={[plan.surface, plan.sheet]} onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}>
          {routes && route ? <>
            <ScrollView style={[plan.routeContent, details && plan.expandedRoutes]} contentContainerStyle={plan.detailContent}
              keyboardShouldPersistTaps="handled">
              <View style={plan.sheetHeading}>
                <Label>Walking routes</Label>
                <Pressable accessibilityRole="button" aria-expanded={details} disabled={Boolean(activity)}
                  onPress={() => setDetails(!details)} style={plan.link}><Text style={plan.action}>{details ? "Hide details" : "Details & options"}</Text></Pressable>
              </View>
              <View style={plan.routeList} accessibilityRole="radiogroup" accessibilityLabel="Walking routes">
                {routes.choices.map((choice) => {
                  const selected = route === choice;
                  const color = routeColors[choice.labels[0]];
                  return <Pressable key={choice.id} accessibilityRole="radio" aria-checked={selected}
                    disabled={Boolean(activity)} onPress={() => setSelectedId(choice.id)}
                    style={({ pressed }) => [plan.routeChoice, selected && { borderColor: color, backgroundColor: "#edf2ef" }, pressed && plan.pressed]}>
                    <View style={[plan.routeMark, { backgroundColor: selected ? color : "#778b9d" }]} />
                    <Text style={plan.routeName}>{choice.labels.join(" · ")}</Text>
                    <Text style={plan.routeStats}>{Math.ceil(choice.minutes)} min · {(choice.meters / 1000).toFixed(2)} km</Text>
                    <Text style={plan.routeStats}>{Math.round(choice.total)} J/kg</Text>
                  </Pressable>;
                })}
              </View>
              {routes.warning && <Text style={plan.hint}>{routes.warning}</Text>}
              {routes.demo ? <Text style={plan.hint}>Synthetic routes · Live recording is disabled</Text> : <>
                <View style={plan.switchRow}>
                  <Text style={plan.switchLabel} nativeID="authorize-walk">Authorize this walk and its data collection</Text>
                  <Switch accessibilityLabel="Authorize this walk and its data collection" accessibilityLabelledBy="authorize-walk"
                    disabled={Boolean(activity)} value={permitted} onValueChange={setPermitted} trackColor={{ true: palette.green }} />
                </View>
                {(canPair || useWatch) && <View style={plan.switchRow}>
                  <Text style={plan.switchLabel}>Record heart rate with Apple Watch</Text>
                  <Switch accessibilityLabel="Record heart rate with Apple Watch" disabled={Boolean(activity)}
                    value={useWatch} onValueChange={setUseWatch} trackColor={{ true: palette.green }} />
                </View>}
              </>}
              {route.warnings.map((warning) => <Text style={plan.hint} key={warning}>{warning}</Text>)}
              {details && <>
                <View style={styles.row}>
                  <Metric label="gain / loss" value={`${route.gain.toFixed(0)} / ${route.loss.toFixed(0)} m`} />
                  <Metric label="mean J/kg/m" value={route.mean.toFixed(2)} />
                  <Metric label="total J/kg" value={route.total.toFixed(0)} />
                  <Metric label="max absolute grade" value={`${(100 * route.maxGrade).toFixed(1)}%`} />
                </View>
                {!routes.demo && <>
                  <TextInput accessibilityLabel="Participant code" style={styles.input} value={participant} editable={!activity}
                    placeholder="Participant code (optional)" placeholderTextColor={palette.quiet} onChangeText={setParticipant}
                    autoCapitalize="characters" maxLength={24} />
                  <Body>{useWatch ? "Start navigation to start the paired Watch workout." : Platform.OS === "web" ?
                    "GPS-only test. Keep this tab open and visible while recording." : "GPS-only engineering test."}</Body>
                  {routes.parameters.maxUphillGrade !== undefined && routes.parameters.minDownhillGrade !== undefined &&
                    <Body>Grade-constrained routes stay between {100 * routes.parameters.minDownhillGrade}% and {100 * routes.parameters.maxUphillGrade}%
                      {` and are at most ${Math.round(100 * (routes.parameters.maxDetour - 1))}% longer than the shortest route.`}</Body>}
                  {mapPaths?.length ? <Body>Dashed lines show OSM paths near the endpoints.</Body> : null}
                </>}
              </>}
              {!routes.demo && <MapAttribution />}
            </ScrollView>
            {problem ? <Notice>{problem}</Notice> : null}
            <TextInput accessibilityLabel="Trial label" style={[styles.input, plan.trialInput]} value={title} onChangeText={setTitle}
              placeholder="Trial label (optional)" placeholderTextColor={palette.quiet} maxLength={80} editable={!activity} />
            <Button title={activity === "start" ? "Preparing…" : routes.demo ? "Save and review demo" : "Start navigation"}
              disabled={Boolean(activity) || (!routes.demo && !permitted)} onPress={() => void prepare()} />
          </> : <>
            {findingRoutes || activity === "location" ? <View style={plan.progress} accessibilityLiveRegion="polite">
              <ActivityIndicator color={palette.green} /><Label>{findingRoutes ? "Finding walking routes…" : "Getting current location…"}</Label>
            </View> : routeError ? <>
              <Notice>{routeError}</Notice>
              <Button title="Retry walking routes" secondary onPress={() => { setResponse(undefined); setAttempt(attempt + 1); }} />
            </> : <>
              <Label>{start ? "Set your destination" : "Set your start point"}</Label>
              <Text style={plan.hint}>Tap the map or search for a place.</Text>
            </>}
            {problem ? <Notice>{problem}</Notice> : null}
            <View style={plan.actions}>
              {!start && <Pressable accessibilityRole="button" disabled={Boolean(activity)} style={plan.link}
                onPress={() => void useCurrentLocation()}><Text style={plan.action}>Use current location</Text></Pressable>}
              <Pressable accessibilityRole="button" disabled={Boolean(activity)} style={plan.link} onPress={showDemo}>
                <Text style={plan.action}>Explore demo routes</Text>
              </Pressable>
            </View>
            {!findingRoutes && !routeError && <Text style={plan.hint}>Route planning requests nearby paths from Overpass and regional elevation tiles.</Text>}
          </>}
        </View>}
      </View>
    </KeyboardAvoidingView>
  </View>;
}

const plan = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e3eadf" },
  overlay: { flex: 1, alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
  top: { width: "100%", maxWidth: 580, maxHeight: "100%", gap: 8 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  surface: { backgroundColor: palette.card, borderColor: palette.line, borderWidth: 1, borderRadius: 18,
    boxShadow: "0 4px 16px #142c2829" },
  back: { width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  backGlyph: { fontSize: 31, lineHeight: 35, color: palette.ink, marginTop: -3 },
  fields: { flex: 1, overflow: "hidden" },
  field: { flexDirection: "row", alignItems: "center", minHeight: 54, paddingLeft: 12, gap: 10 },
  fieldDivider: { borderTopWidth: 1, borderColor: palette.line },
  activeField: { backgroundColor: "#edf5ed" },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 3, borderColor: palette.green },
  destinationDot: { borderColor: destinationColor, backgroundColor: destinationColor },
  fieldText: { flex: 1, minWidth: 0, paddingVertical: 5, paddingRight: 4 },
  fieldLabel: { fontSize: 11, fontWeight: "700", color: palette.green },
  searchInput: { fontSize: 16, color: palette.ink, minHeight: 28, padding: 0 },
  clear: { width: 44, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  clearGlyph: { fontSize: 22, color: palette.quiet },
  searchResults: { marginLeft: 54, flexGrow: 0, flexShrink: 1, maxHeight: 264 },
  searchContent: { paddingHorizontal: 12, paddingVertical: 6, gap: 8 },
  result: { minHeight: 44, justifyContent: "center", paddingVertical: 6, gap: 3, borderBottomWidth: 1, borderColor: palette.line },
  resultName: { fontSize: 15, color: palette.ink, fontWeight: "600" },
  hint: { color: palette.quiet, fontSize: 13, lineHeight: 17 },
  progress: { flexDirection: "row", alignItems: "center", gap: 8 },
  sheet: { width: "100%", maxWidth: 580, flexShrink: 1, padding: 12, gap: 8 },
  sheetHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  routeList: { flexDirection: "row", gap: 6 },
  routeChoice: { flex: 1, padding: 8, borderRadius: 10, borderWidth: 1, borderColor: palette.line, gap: 4 },
  routeMark: { width: 18, height: 3, borderRadius: 2 },
  routeName: { color: palette.ink, fontSize: 13, fontWeight: "700" },
  routeStats: { color: palette.quiet, fontSize: 12 },
  routeContent: { maxHeight: 208, flexGrow: 0, flexShrink: 1 },
  expandedRoutes: { maxHeight: 260 },
  detailContent: { gap: 8 },
  trialInput: { fontSize: 16 },
  switchRow: { flexDirection: "row", gap: 8, alignItems: "center", minHeight: 40 },
  switchLabel: { flex: 1, color: palette.ink, fontSize: 14, lineHeight: 19 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  link: { minHeight: 36, justifyContent: "center" },
  action: { color: palette.green, fontSize: 14, fontWeight: "700" },
  pressed: { opacity: 0.65 },
});
