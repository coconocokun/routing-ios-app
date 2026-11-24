import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { Body, palette } from "./ui";

type PlotPoint = { x: number; y: number; label?: string };
export function Scatter({ points, xTitle, yTitle, color = palette.green }: {
  points: PlotPoint[]; xTitle: string; yTitle: string; color?: string;
}) {
  const [selected, setSelected] = useState<PlotPoint>();
  if (!points.length) return <Body>No valid pairs are available for this view.</Body>;
  const extent = (key: "x" | "y") => points.reduce<[number, number]>((limits, p) =>
    [Math.min(limits[0], p[key]), Math.max(limits[1], p[key])], [Infinity, -Infinity]);
  const [x0, x1] = extent("x");
  const [y0, y1] = extent("y");
  const x = (v: number) => 47 + ((v - x0) / (x1 - x0 || 1)) * 278;
  const y = (v: number) => 158 - ((v - y0) / (y1 - y0 || 1)) * 137;
  const step = Math.max(1, Math.ceil(points.length / 850));
  return <View>
    <Body>{yTitle}</Body>
    <Svg width="100%" height={194} viewBox="0 0 340 194" accessibilityLabel={`${yTitle} by ${xTitle}, ${points.length} observations`}>
      {[0, 0.5, 1].map((part) => <Line key={part} x1={47} y1={21 + 137 * part} x2={325} y2={21 + 137 * part} stroke={palette.line} />)}
      <Line x1={47} y1={21} x2={47} y2={158} stroke={palette.line} />
      <SvgText x={42} y={25} textAnchor="end" fontSize={10} fill={palette.quiet}>{y1.toFixed(1)}</SvgText>
      <SvgText x={42} y={160} textAnchor="end" fontSize={10} fill={palette.quiet}>{y0.toFixed(1)}</SvgText>
      <SvgText x={47} y={175} fontSize={10} fill={palette.quiet}>{x0.toFixed(1)}</SvgText>
      <SvgText x={325} y={175} textAnchor="end" fontSize={10} fill={palette.quiet}>{x1.toFixed(1)}</SvgText>
      {points.filter((_, i) => i % step === 0 || i === points.length - 1).map((point, i) =>
        <Circle key={i} cx={x(point.x)} cy={y(point.y)} r={point === selected ? 6 : 3.3}
          fill={color} onPress={() => setSelected(point)} />)}
    </Svg>
    <Body>{xTitle}{step > 1 ? ` · showing every ${step}th point for readability` : ""}</Body>
    {selected && <Pressable onPress={() => setSelected(undefined)} accessibilityRole="button">
      <Text style={{ color: palette.green }}>{selected.label ?? `${selected.x.toFixed(1)}, ${selected.y.toFixed(1)}`}</Text>
    </Pressable>}
  </View>;
}

export function heatColor(bpm: number | null) {
  if (bpm === null) return "#747978";
  if (bpm < 90) return "#2f66bd";
  if (bpm < 110) return "#00816b";
  if (bpm < 130) return "#95600c";
  return "#b6405a";
}
export const legend = [[null, "Unmatched"], [80, "Below 90"], [100, "90–109"], [120, "110–129"], [140, "130 and up"]] as const;
