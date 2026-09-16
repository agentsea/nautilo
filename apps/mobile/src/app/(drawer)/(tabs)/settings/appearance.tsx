import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Screen } from "@/components/screen";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

/** Canonical device-local appearance preference; behavior remains in ThemeToggle. */
export default function AppearanceSettingsScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  return (
    <Screen edgeTop={false}>
      <View style={styles.card}>
        <Text style={styles.label}>Theme</Text>
        <ThemeToggle />
        <Text style={styles.hint}>Stored on this phone. System follows your device.</Text>
      </View>
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    card: {
      gap: t.spacing.md,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.panel,
      padding: t.spacing.lg,
    },
    label: { ...t.typography.subheading, color: t.color.text.foreground },
    hint: { ...t.typography.caption, color: t.color.text.muted },
  });
}
