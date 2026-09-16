import { Ionicons } from "@expo/vector-icons";
import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { MessageActionDescriptor } from "@nautilo/types";

const ICON_BY_ACTION = {
  reply: "arrow-undo-outline",
  react: "happy-outline",
  "reply-in-thread": "git-branch-outline",
  copy: "copy-outline",
  edit: "pencil",
  report: "flag-outline",
  delete: "trash-outline",
} as const;

type MessageActionRailProps = {
  actions: readonly MessageActionDescriptor[];
  visible: boolean;
  outgoing: boolean;
  onAction: (id: MessageActionDescriptor["id"]) => void;
};

/** Mobile keeps the transcript compact: only latest and explicitly revealed rails mount. */
export function MessageActionRail({ actions, visible, outgoing, onAction }: MessageActionRailProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  if (actions.length === 0 || !visible) return null;

  return (
    <View style={[styles.slot, outgoing ? styles.slotOutgoing : null]}>
      <View style={styles.rail}>
        {actions.map((action) => (
          <Pressable
            key={action.id}
            onPress={() => onAction(action.id)}
            accessibilityRole="button"
            accessibilityLabel={action.accessibleLabel}
            accessibilityHint={
              action.id === "delete"
                ? "Permanently delete this message"
                : undefined
            }
            style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}>
            {({ pressed }) => (
              <Ionicons
                name={ICON_BY_ACTION[action.id]}
                size={20}
                color={
                  action.destructive && pressed
                    ? t.color.status.error
                    : t.color.text.muted
                }
              />
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    slot: { minHeight: 44, marginTop: t.spacing.xs, alignSelf: "flex-start" },
    slotOutgoing: { alignSelf: "flex-end" },
    rail: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
      overflow: "hidden",
    },
    button: {
      width: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: { opacity: 0.65 },
  });
}
