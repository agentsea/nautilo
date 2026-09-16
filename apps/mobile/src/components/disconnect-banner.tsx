// D369 Phase 4 — global connection-status strip. Reads useRealtime() and
// shows a thin, safe-area-aware banner only for an actual interruption.
// Routine connecting/authenticating transitions are normal machinery and stay
// silent; the user only needs a visible state when the app is offline and work
// may be affected.
//
// Mounted as a sibling of <Stack> in _layout.tsx. It reads insets from the
// single root SafeAreaProvider (in _layout) — it must NOT wrap itself in its
// own SafeAreaProvider: that provider defaults to flex:1 and, as a sibling of
// the navigator in a column, would steal half the screen even while the
// banner renders null. Returns null (zero layout footprint) when connected.
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRealtime } from "@/providers/realtime";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export function DisconnectBanner() {
  const { connectionState } = useRealtime();
  const insets = useSafeAreaInsets();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  if (connectionState !== "closed") return null;

  return (
    <View style={[styles.strip, { paddingTop: insets.top }]}>
      <Text style={styles.text} numberOfLines={1}>
        Offline — trying again…
      </Text>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    strip: {
      backgroundColor: t.color.status.warning,
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.xs + 2,
      width: "100%",
    },
    text: { color: t.color.text.onPrimary, ...t.typography.caption, fontWeight: "600" },
  });
}
