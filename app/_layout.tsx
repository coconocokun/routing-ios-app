import "../src/recording";
import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { database } from "../src/db";
import { command, drainWatch, watchStatus } from "../src/watch";
import { palette } from "../src/ui";

export default function Layout() {
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let busy = false;
    let lastRepair = 0;
    const update = async () => {
      if (busy || AppState.currentState !== "active") return;
      busy = true;
      try {
        await drainWatch();
        if (watchStatus().activated && Date.now() - lastRepair > 60_000) {
          lastRepair = Date.now();
          const db = await database();
          const pending = await db.getAllAsync<{ id: string; status: string }>(
            `SELECT id,status FROM trials WHERE mode = 'paired' AND status IN ('sync_pending','abandoned','incomplete')
             AND watch_stopped_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM events WHERE trial_id = trials.id AND type = 'cancelled')`);
          for (const { id, status } of pending) await command("STOP", id, { interrupted: status === "abandoned" });
          const deletions = await db.getAllAsync<{ id: string }>("SELECT id FROM deleted_trials WHERE watch_pending = 1");
          for (const { id } of deletions) await command("DELETE", id);
        }
      } catch { /* A durable inbox entry is retried on the next poll. */ }
      finally { busy = false; }
    };
    void update();
    const timer = setInterval(update, 2600);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void update(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);
  return <Stack screenOptions={{ headerTintColor: palette.green, headerStyle: { backgroundColor: palette.paper },
    headerShadowVisible: false, contentStyle: { backgroundColor: palette.paper } }}>
    <Stack.Screen name="index" options={{ title: "Walking Study" }} />
    <Stack.Screen name="plan" options={{ title: "Plan a walk" }} />
    <Stack.Screen name="navigate" options={{ title: "Current walk", gestureEnabled: false }} />
    <Stack.Screen name="trials/index" options={{ title: "Trials" }} />
    <Stack.Screen name="trials/[id]" options={{ title: "Review trial" }} />
  </Stack>;
}
