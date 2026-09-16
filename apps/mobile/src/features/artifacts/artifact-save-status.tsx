import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "@/providers/theme";
import type { useArtifactSave } from "./use-artifact-save";

export function ArtifactSaveStatus({ operation }: { operation: ReturnType<typeof useArtifactSave> }) {
  const theme = useAppTheme();
  if (!operation.state.message) return null;
  return <View style={[styles.container, { backgroundColor: theme.color.surface.panel }]}>
    {operation.busy ? <ActivityIndicator color={theme.color.brand.accent} accessibilityLabel="Saving file" /> : null}
    <Text accessibilityLiveRegion="polite" style={[styles.message, { color: theme.color.text.foreground }]}>{operation.state.message}</Text>
    {operation.busy ? <Pressable onPress={operation.cancel} accessibilityRole="button" accessibilityLabel="Cancel saving file" style={styles.cancel}>
      <Text style={{ color: theme.color.brand.accent }}>Cancel</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", padding: 12, gap: 8 },
  message: { flex: 1, flexShrink: 1 },
  cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
});
