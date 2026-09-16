import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { MessageArtifactOpenRef } from "@nautilo/types";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type ArtifactOpenCardProps = {
  artifact: MessageArtifactOpenRef;
  outgoing: boolean;
  /** Align with grouped incoming message text, without fabricating an avatar. */
  groupedIncoming?: boolean;
};

const INCOMING_AVATAR_COLUMN = 28 + 8;

/** Server-authorized artifact pointer rendered beneath its owning chat message. */
export function ArtifactOpenCard({
  artifact,
  outgoing,
  groupedIncoming = false,
}: ArtifactOpenCardProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const meta = `${artifact.mimeType} · ${formatBytes(artifact.sizeBytes)}`;

  return (
    <Pressable
      style={[
        styles.card,
        outgoing ? styles.outgoing : styles.incoming,
        !outgoing && groupedIncoming ? styles.groupedIncoming : null,
      ]}
      onPress={() =>
        router.push({
          pathname: "/files/artifact/[id]",
          params: { id: artifact.artifactInternalId, roomId: artifact.roomId },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`Open ${artifact.basename}, ${meta}`}
      accessibilityHint="Opens the file viewer"
    >
      <View style={styles.icon}>
        <Ionicons name="document-attach-outline" size={20} color={t.color.brand.accent} />
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {artifact.basename}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.color.text.muted} />
    </Pressable>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      maxWidth: "90%",
      gap: t.spacing.sm,
      marginTop: t.spacing.xs,
      marginBottom: t.spacing.xs,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    outgoing: { alignSelf: "flex-end" },
    incoming: { alignSelf: "flex-start" },
    groupedIncoming: { marginLeft: INCOMING_AVATAR_COLUMN },
    icon: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.sm,
      backgroundColor: t.color.surface.subtle,
    },
    body: { flex: 1, minWidth: 0 },
    name: { color: t.color.text.foreground, ...t.typography.label },
    meta: { marginTop: 2, color: t.color.text.muted, ...t.typography.caption },
  });
}
