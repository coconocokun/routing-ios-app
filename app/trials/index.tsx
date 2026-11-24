import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { TextInput, View } from "react-native";
import { database, type Trial } from "../../src/db";
import { Body, Button, Card, Label, Notice, Screen, Title, displayStatus, duration, message, styles } from "../../src/ui";
import type { Route } from "../../src/routes";

export default function TrialHistory() {
  const [rows, setRows] = useState<Trial[]>();
  const [problem, setProblem] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [newest, setNewest] = useState(true);
  useFocusEffect(useCallback(() => {
    let focused = true;
    const load = async () => {
      try {
        const db = await database();
        const items = await db.getAllAsync<Trial>("SELECT * FROM trials ORDER BY created_at_ms DESC");
        if (focused) setRows(items);
      } catch (error) { if (focused) setProblem(message(error)); }
    };
    void load();
    const timer = setInterval(load, 4500);
    return () => { focused = false; clearInterval(timer); };
  }, []));
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = rows?.filter((row) => row.title.toLocaleLowerCase().includes(normalized) && (!pending || row.status === "sync_pending"));
  if (!newest) filtered?.reverse();
  return <Screen>
    <Title>Previous trials</Title>
    <TextInput accessibilityLabel="Find a trial" placeholder="Find a trial" style={styles.input} value={query} onChangeText={setQuery} />
    <View style={styles.row}>
      <Button title={pending ? "Show all trials" : "Show pending sync"} secondary onPress={() => setPending(!pending)} />
      <Button title={newest ? "Newest first" : "Oldest first"} secondary onPress={() => setNewest(!newest)} />
    </View>
    {problem ? <Notice>{problem}</Notice> : null}
    {!filtered ? <Body>Loading trials…</Body> : !filtered.length ? <Body>No matching trials.</Body> :
      filtered.map((row) => {
        const route: Route = JSON.parse(row.route_json);
        return <Card key={row.id}>
          <Label>{row.title}</Label>
          <Body>{new Date(row.created_at_ms).toLocaleString()} · {displayStatus(row.status)}</Body>
          <Body>{row.mode === "demo" ? "Synthetic demo · " : ""}{route.labels.join(" · ")}
            {row.phone_started_at_ms && row.phone_stopped_at_ms ? ` · ${duration(row.phone_stopped_at_ms - row.phone_started_at_ms)}` : ""}</Body>
          <Button title={["preparing", "recording", "paused"].includes(row.status) ? "Open current walk" : "Review"}
            onPress={() => router.push({ pathname: ["preparing", "recording", "paused"].includes(row.status) ? "/navigate" : "/trials/[id]",
              params: { id: row.id } })} secondary />
        </Card>;
      })}
  </Screen>;
}
