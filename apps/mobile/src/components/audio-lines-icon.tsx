import { View } from "react-native";

// D401 — desktop-parity "voice mode" glyph. Mirrors Lucide `AudioLines`
// (used by the desktop nav-rail voice toggle) as pure RN Views — no
// react-native-svg / lucide-react-native native dep, so it hot-reloads.
// Lucide audio-lines bar heights (24-viewBox): [3, 11, 18, 7, 13, 3].
const BAR_HEIGHT_FRACTIONS = [3, 11, 18, 7, 13, 3].map((h) => h / 18);

export function AudioLinesIcon({
  color,
  size = 18,
}: {
  color: string;
  size?: number;
}) {
  const barWidth = Math.max(1.5, size * 0.11);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        height: size,
        gap: barWidth * 0.9,
      }}>
      {BAR_HEIGHT_FRACTIONS.map((fraction, i) => (
        <View
          key={i}
          style={{
            width: barWidth,
            height: Math.max(barWidth, Math.round(size * fraction)),
            borderRadius: barWidth,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}
