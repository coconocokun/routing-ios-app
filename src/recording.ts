import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { active, addEvent, appendGps, database, getTrial, write } from "./db.ts";
import { distance, project, type Route } from "./routes.ts";

const task = "walking-study-location-v1";
TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(task, async ({ data, error }) => {
  const db = await database();
  await write(db, async (tx) => {
    const trial = await active(tx);
    if (!trial || trial.mode === "demo" || !trial.phone_started_at_ms) return;
    if (error) {
      await addEvent(tx, trial.id, "location_error", Date.now(), { message: error.message });
      return;
    }
    const route: Route = JSON.parse(trial.route_json);
    const fixes = (data?.locations ?? []).filter((fix) => fix.timestamp >= trial.phone_started_at_ms!).map(({ coords, timestamp }) => ({
      observed_at_ms: Math.round(timestamp), ingested_at_ms: Date.now(), lat: coords.latitude, lon: coords.longitude,
      horizontal_accuracy_m: coords.accuracy, altitude_m: coords.altitude, vertical_accuracy_m: coords.altitudeAccuracy,
      speed_mps: coords.speed === null || coords.speed < 0 ? null : coords.speed,
      heading_deg: coords.heading === null || coords.heading < 0 ? null : coords.heading,
    }));
    await appendGps(tx, trial.id, fixes);
    if (trial.status !== "recording") return;
    const recent = await tx.getAllAsync<{ lat: number; lon: number; observed_at_ms: number }>(`
      SELECT lat,lon,observed_at_ms FROM gps_samples WHERE trial_id = ? AND horizontal_accuracy_m BETWEEN 0 AND 20
      ORDER BY observed_at_ms DESC LIMIT 3`, trial.id);
    if (recent.length !== 3 || recent[0].observed_at_ms - recent[2].observed_at_ms > 30_000) return;
    const prior = await tx.getFirstAsync<{ type: string }>(`SELECT type FROM events WHERE trial_id = ? AND device = 'phone'
      AND type IN ('off_route','back_on_route') ORDER BY observed_at_ms DESC LIMIT 1`, trial.id);
    const deviations = recent.map((row) => project({ latitude: row.lat, longitude: row.lon }, route).separation);
    if (prior?.type !== "off_route" && deviations.every((value) => value > 30)) {
      await addEvent(tx, trial.id, "off_route", recent[0].observed_at_ms, { separation_m: deviations[0] });
    } else if (prior?.type === "off_route" && deviations.every((value) => value < 20)) {
      await addEvent(tx, trial.id, "back_on_route", recent[0].observed_at_ms);
    }
  });
});

export async function requestLocation() {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error("Allow location access in Settings to record a walk.");
  const background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) throw new Error("Allow location Always in Settings so the walk can record while locked.");
}

export async function beginGps(id: string, recovery = false) {
  const db = await database();
  const trial = await getTrial(db, id);
  if (!trial || !["preparing", "recording", "paused"].includes(trial.status)) return;
  const started = await Location.hasStartedLocationUpdatesAsync(task);
  const time = Date.now();
  await write(db, async (tx) => {
    const result = await tx.runAsync(`UPDATE trials SET phone_started_at_ms = COALESCE(phone_started_at_ms,?),
      status = CASE WHEN status = 'preparing' THEN 'recording' ELSE status END
      WHERE id = ? AND status IN ('preparing','recording','paused')`, time, id);
    if (result.changes && (!trial.phone_started_at_ms || recovery)) {
      await addEvent(tx, id, trial.phone_started_at_ms ? "recovered" : "start", time);
    }
  });
  if (!started) {
    try {
      await Location.startLocationUpdatesAsync(task, {
        accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2,
        activityType: Location.ActivityType.Fitness, pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
    } catch (error) {
      await write(db, async (tx) => {
        await tx.runAsync("UPDATE trials SET status = 'incomplete', reason = ? WHERE id = ? AND status IN ('recording','paused')",
          "iPhone location could not start. Existing samples were kept.", id);
        await addEvent(tx, id, "location_error", Date.now(), { message: String(error) });
      });
      throw error;
    }
  }
}

export async function endGps() {
  if (await Location.hasStartedLocationUpdatesAsync(task)) await Location.stopLocationUpdatesAsync(task);
}

export const gpsRunning = () => Location.hasStartedLocationUpdatesAsync(task);
export const nearDestination = (point: Route["geometry"][number], route: Route) => distance(point, route.geometry[route.geometry.length - 1]) <= 30;
