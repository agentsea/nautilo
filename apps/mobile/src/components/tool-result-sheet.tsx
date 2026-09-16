import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export type ToolResultDisclosure = {
  readonly name: string;
  readonly result: string;
  readonly failed: boolean;
  readonly truncated: boolean;
};

export function ToolResultSheet({
  disclosure,
  onClose,
}: {
  readonly disclosure: ToolResultDisclosure | null;
  readonly onClose: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  return (
    <BottomSheet visible={disclosure !== null} snapPoints={["72%"]} scrollable backdrop onClose={onClose}>
      {disclosure ? (
        <View style={styles.content} accessibilityViewIsModal accessibilityLabel={`${disclosure.name} available result`}>
          <Text style={styles.title}>{disclosure.name}</Text>
          <Text style={disclosure.failed ? styles.failed : styles.status}>
            {disclosure.failed ? "Failed" : "Completed"}
          </Text>
          {disclosure.truncated ? (
            <Text style={styles.notice}>This result was truncated in transit.</Text>
          ) : null}
          <Text selectable style={styles.result}>{disclosure.result}</Text>
        </View>
      ) : null}
    </BottomSheet>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { gap: t.spacing.sm },
    title: { color: t.color.text.foreground, ...t.typography.subheading },
    status: { color: t.color.text.muted, ...t.typography.caption },
    failed: { color: t.color.status.error, ...t.typography.caption, fontWeight: "700" },
    notice: { color: t.color.text.muted, ...t.typography.caption },
    result: { color: t.color.text.foreground, ...t.typography.body, fontFamily: "monospace" },
  });
}
