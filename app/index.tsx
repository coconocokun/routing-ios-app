import { router, useFocusEffect } from "expo-router";
import * as Location from "expo-location";
import { useCallback, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { active, database, type Trial } from "../src/db";
import { Body, Button, Card, Label, Notice, Screen, Title, displayStatus, message, palette } from "../src/ui";
import { watchStatus } from "../src/watch";

export default function Home() {
  const web = Platform.OS === "web";
  const [trial, setTrial] = useState<Trial | null>(null);
  const [watch, setWatch] = useState(watchStatus);
  const [location, setLocation] = useState("Checking access");
  const [problem, setProblem] = useState("");
  useFocusEffect(useCallback(() => {
    let mounted = true;
    const load = async () => {
      try {
        setWatch(watchStatus());
        const [current, foreground, background] = await Promise.all([
          database().then(active),
          web ? Location.getForegroundPermissionsAsync().catch(() => null) : Location.getForegroundPermissionsAsync(),
          web ? null : Location.getBackgroundPermissionsAsync(),
        ]);
        if (!mounted) return;
        setTrial(current);
        setLocation(background?.granted ? "Always allowed" : foreground?.granted ? (web ? "While this tab is open" : "While using the app") :
          web ? "Browser permission required for live walks" : "Permission required");
      } catch (error) { if (mounted) setProblem(message(error)); }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => { mounted = false; clearInterval(timer); };
  }, [web]));
  const watchText = !watch.supported ? "Unavailable on this build or device" : !watch.activated ? "Connecting…" :
    !watch.paired ? "No paired Watch" : !watch.installed ? "Install Walking Study on your Watch" :
      watch.reachable ? "App reachable" : "Paired · open the Watch app";
  return <Screen>
    <View style={home.hero}>
      <Title>Walking Study</Title>
      <Text style={home.lead}>Compare walking routes by distance and predicted effort. Review your recorded walks.</Text>
    </View>
    {problem ? <Notice>{problem}</Notice> : null}
    {trial ? <Card>
      <Label>{trial.title}</Label><Body>{displayStatus(trial.status)}</Body>
      <Button title="Open current walk" onPress={() => router.push({ pathname: "/navigate", params: { id: trial.id } })} />
    </Card> : <Button title="Plan a new walk" onPress={() => router.push("/plan")} />}
    <Button title="Previous trials" onPress={() => router.push("/trials")} secondary />
    <Card>
      <Label>Device readiness</Label>
      <Body>Location · {location}</Body>
      {!web && <Body>Apple Watch (optional) · {watchText}</Body>}
    </Card>
    <Body>Study records stay on your devices until you choose to share an export.</Body>
    <Body>For research use only. For medical decisions and emergency navigation, use the resources in your study’s approved protocol.</Body>
  </Screen>;
}
const home = StyleSheet.create({
  hero: { gap: 12, paddingVertical: 16 },
  lead: { color: palette.quiet, fontSize: 18, lineHeight: 26, maxWidth: 340 },
});
