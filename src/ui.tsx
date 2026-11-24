import type { ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

export const palette = { paper: "#f4f5ed", card: "#fffef8", ink: "#142c28", quiet: "#4e6258",
  green: "#165b4a", mint: "#c9edd9", line: "#d6ded0", amber: "#824914", warn: "#f9eacd" };

export function Screen({ children }: { children: ReactNode }) {
  return <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic"
    keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>{children}</ScrollView>;
}
export function Title({ children }: { children: ReactNode }) { return <Text accessibilityRole="header" style={styles.title}>{children}</Text>; }
export function Body({ children }: { children: ReactNode }) { return <Text style={styles.body}>{children}</Text>; }
export function Label({ children }: { children: ReactNode }) { return <Text style={styles.label}>{children}</Text>; }
export function Card({ children }: { children: ReactNode }) { return <View style={styles.card}>{children}</View>; }
export function Notice({ children }: { children: ReactNode }) {
  return <Text accessibilityLiveRegion="polite" style={styles.notice}>{children}</Text>;
}
export function MapAttribution() {
  return <Text accessibilityRole="link" style={styles.attribution}
    onPress={() => void Linking.openURL("https://www.openstreetmap.org/copyright")}>© OpenStreetMap contributors</Text>;
}
export function Button({ title, onPress, secondary = false, disabled = false }: {
  title: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, (pressed || disabled) && { opacity: 0.53 }]}>
    <Text style={[styles.buttonText, secondary && { color: palette.green }]}>{title}</Text>
  </Pressable>;
}
export function Metric({ label, value }: { label: string; value: string }) {
  return <View style={{ flex: 1, minWidth: 90, gap: 3 }}>
    <Text style={styles.metric}>{value}</Text><Text style={styles.body}>{label}</Text>
  </View>;
}
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const displayStatus = (status: string) => ({
  preparing: "Preparing", recording: "Recording", paused: "Paused", sync_pending: "Sync pending",
  complete: "Complete", incomplete: "Incomplete", abandoned: "Abandoned",
}[status] ?? status);
export const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.paper },
  content: { padding: 20, paddingBottom: 42, gap: 15 },
  title: { color: palette.ink, fontSize: 37, fontWeight: "700", letterSpacing: -1.55 },
  label: { color: palette.ink, fontSize: 17, fontWeight: "700" },
  body: { color: palette.quiet, fontSize: 15, lineHeight: 21 },
  card: { gap: 11, backgroundColor: palette.card, padding: 16, borderColor: palette.line, borderWidth: 1, borderRadius: 19 },
  notice: { color: palette.amber, backgroundColor: palette.warn, padding: 12, borderRadius: 11, fontSize: 14, lineHeight: 20 },
  button: { backgroundColor: palette.green, minHeight: 48, alignItems: "center", justifyContent: "center", padding: 10, borderRadius: 12 },
  secondary: { backgroundColor: palette.mint },
  buttonText: { color: "white", fontSize: 15, fontWeight: "700", textAlign: "center" },
  metric: { color: palette.ink, fontSize: 22, fontWeight: "700", fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  input: { minHeight: 45, padding: 10, borderColor: palette.line, borderWidth: 1, borderRadius: 10, color: palette.ink, backgroundColor: palette.card },
  map: { height: 280, borderRadius: 16, overflow: "hidden" },
  attribution: { color: palette.quiet, fontSize: 13, textDecorationLine: "underline" },
});
