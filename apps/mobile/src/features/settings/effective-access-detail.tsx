import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { provenanceSummary, type AccessCapability } from "./access-presentation";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export function EffectiveAccessDetail({
  capability,
  visible,
  onClose,
}: {
  capability: AccessCapability | null;
  visible: boolean;
  onClose: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  return (
    <BottomSheet visible={visible} snapPoints={["65%"]} onClose={onClose}>
      <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.headingRow}>
            <View style={styles.headingCopy}>
              <Text style={styles.title}>Access source</Text>
              <Text style={styles.capability}>{capability?.slug ?? "Capability"}</Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close access source details"
              style={styles.close}
            >
              <Text style={styles.closeLabel}>Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.description}>{capability?.description}</Text>
            {capability?.provenance.length ? (
              capability.provenance.map((path) => (
                <View key={`${path.groupId}:${path.roleSlug}`} style={styles.path}>
                  <Text style={styles.pathTitle}>{provenanceSummary(path)}</Text>
                  <Text style={styles.pathMeta}>
                    {path.groupIsSystem ? "System group" : path.groupType}
                    {path.roleIsSystem ? " · System role" : ""}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.empty}>This capability is not currently granted by a group role.</Text>
            )}
          </ScrollView>
      </View>
    </BottomSheet>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    sheet: { flex: 1 },
    headingRow: { flexDirection: "row", alignItems: "flex-start", gap: t.spacing.md },
    headingCopy: { flex: 1, gap: 2 },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    capability: { ...t.typography.caption, color: t.color.text.muted },
    close: { paddingVertical: t.spacing.xs, paddingLeft: t.spacing.sm },
    closeLabel: { ...t.typography.label, color: t.color.brand.accent },
    content: { gap: t.spacing.md, paddingTop: t.spacing.lg },
    description: { ...t.typography.body, color: t.color.text.foreground },
    path: {
      gap: 2,
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
    },
    pathTitle: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    pathMeta: { ...t.typography.caption, color: t.color.text.muted },
    empty: { ...t.typography.body, color: t.color.text.muted },
  });
}
