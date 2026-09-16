import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { messageSentDate } from "@/lib/message-time";
import { useAppTheme } from "@/providers/theme";

export function MessageTimestamp({ sentAt }: { sentAt?: string }) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const date = messageSentDate(sentAt);
  if (!date) return null;
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const exact = `${date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} · ${zone}`;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Sent ${exact}`} accessibilityHint="Show full message time"
      onPress={() => setExpanded(true)} style={{ alignSelf: "flex-end", paddingHorizontal: theme.spacing.sm, paddingVertical: theme.spacing.sm }}>
      <Text style={{ color: theme.color.text.muted, ...theme.typography.caption }}>{time}</Text>
    </Pressable>
    <Modal transparent visible={expanded} onRequestClose={() => setExpanded(false)}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: theme.color.surface.overlay }}>
        <Pressable style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel="Dismiss message time" onPress={() => setExpanded(false)} />
        <View accessibilityViewIsModal style={{ padding: theme.spacing.xl, paddingBottom: Math.max(insets.bottom, theme.spacing.xl), gap: theme.spacing.lg, backgroundColor: theme.color.surface.panel, borderTopLeftRadius: theme.radii.lg, borderTopRightRadius: theme.radii.lg }}>
          <Text accessibilityRole="header" style={{ color: theme.color.text.foreground, ...theme.typography.subheading }}>Message sent</Text>
          <Text selectable style={{ color: theme.color.text.foreground, ...theme.typography.body }}>{exact}</Text>
          <Pressable accessibilityRole="button" onPress={() => setExpanded(false)} style={{ padding: theme.spacing.md }}>
            <Text style={{ color: theme.color.brand.accent, ...theme.typography.label }}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  </>;
}
