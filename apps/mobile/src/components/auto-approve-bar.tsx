// D382 Batch 1b — AutoApproveBar: composer control row, Tier 1.
// Compact pill toggle for the session-scoped auto-approve mode (port
// of desktop D375). Sits above the ApprovalCard in chat/[roomId].tsx.
//
// - !canToggle → render nothing (v1: always toggleable).
// - OFF: muted pill → tapping opens a confirm-once Alert listing what
//   stays protected; on confirm → setEnabled(true).
// - ON: warning-tinted pill → tap turns it off immediately (no confirm).
import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SettingsConfirmation } from "@/components/settings/settings-confirmation";
import { useAutoApprove } from "@/providers/auto-approve";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

/**
 * The composer's control strip. `leading` holds persistent/transient status on
 * the LEFT (typing indicator, "Stopped" note). `trailing` + the auto-approve
 * pill sit in a right-aligned control group so ephemeral session controls stay
 * apart from typing/status visibility.
 */
export function AutoApproveBar({
  leading,
  trailing,
  showAutoApprove = true,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Direct Human chat keeps status and voice controls, but never Agent approval chrome. */
  showAutoApprove?: boolean;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { enabled, setEnabled, canToggle } = useAutoApprove();
  const [enableConfirmationVisible, setEnableConfirmationVisible] = useState(false);

  const autoApproveVisible = showAutoApprove && canToggle;

  if (!autoApproveVisible && !leading && !trailing) return null;

  const handlePress = () => {
    if (enabled) {
      setEnabled(false);
      return;
    }
    setEnableConfirmationVisible(true);
  };

  return (
    <>
      <View style={styles.row}>
        <View style={styles.leftGroup}>{leading ?? null}</View>
        {autoApproveVisible || trailing ? (
          <View style={styles.rightGroup}>
            {trailing ?? null}
            {autoApproveVisible ? (
              <Pressable
                style={[styles.pill, enabled ? styles.pillOn : styles.pillOff]}
                onPress={handlePress}
                accessibilityRole="switch"
                accessibilityState={{ checked: enabled }}
                accessibilityLabel={
                  enabled
                    ? "Auto-approve on. Tap to turn off."
                    : "Auto-approve off. Tap to turn on."
                }
              >
                <Ionicons
                  name={enabled ? "flash" : "flash-outline"}
                  size={12}
                  color={enabled ? t.color.status.warning : t.color.text.muted}
                />
                <Text style={[styles.label, enabled ? styles.labelOn : styles.labelOff]}>
                  {enabled ? "Auto-approve: on" : "Auto-approve: off"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <SettingsConfirmation
        visible={enableConfirmationVisible}
        title="Turn on Auto-Approve for this session?"
        message="The agent will run eligible tools, edit files, and run shell commands without asking first. Network access, detailed review, PIN, and destructive actions stay gated."
        confirmLabel="Turn on"
        destructive
        onCancel={() => setEnableConfirmationVisible(false)}
        onConfirm={() => {
          setEnabled(true);
          setEnableConfirmationVisible(false);
        }}
      />
    </>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: t.spacing.md,
      paddingTop: t.spacing.xs,
      paddingBottom: t.spacing.sm,
    },
    leftGroup: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      flexShrink: 1,
      minWidth: 0,
    },
    rightGroup: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      flexShrink: 0,
    },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.xs,
      paddingVertical: t.spacing.xs,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.pill,
      borderWidth: 1,
    },
    pillOff: {
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.subtle,
    },
    pillOn: {
      borderColor: t.color.status.warning,
      backgroundColor: t.color.surface.subtle,
    },
    label: { ...t.typography.caption },
    labelOff: { color: t.color.text.muted },
    labelOn: { color: t.color.status.warning, fontWeight: "700" },
  });
}
