import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { chatManagementActions } from "@/features/chat-management/chat-management-model";
import { getApiClient } from "@/lib/api";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { RoomSummaryDto } from "@nautilo/types";

type Props = {
  visible: boolean;
  room: RoomSummaryDto | null;
  serverUrl: string | undefined;
  viewerActorId: string | null;
  canManage: boolean;
  canLeave: boolean;
  isArchived: boolean;
  onClose: () => void;
  onRename: (room: RoomSummaryDto) => void;
  onArchiveChange: (roomId: string, archived: boolean) => void;
  onLeft: (roomId: string) => void;
};

/** The catalogue's real-action menu. It deliberately has no Delete action. */
export function ChatManagementSheet({
  visible,
  room,
  serverUrl,
  viewerActorId,
  canManage,
  canLeave,
  isArchived,
  onClose,
  onRename,
  onArchiveChange,
  onLeft,
}: Props) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [busy, setBusy] = useState<"archive" | "leave" | null>(null);
  if (!room) return null;
  const actions = chatManagementActions(room, { canManage, canLeave, isArchived, viewerActorId });

  const archive = (archived: boolean): void => {
    if (!serverUrl || busy) return;
    const verb = archived ? "Unarchive" : "Archive";
    Alert.alert(`${verb} chat`, archived
      ? "This chat will return to your active conversations."
      : "This hides the chat from active conversations. Messages are kept.", [
      { text: "Cancel", style: "cancel" },
      {
        text: verb,
        style: archived ? "default" : "destructive",
        onPress: () => {
          void (async () => {
            setBusy("archive");
            try {
              if (archived) await getApiClient(serverUrl).unarchiveRoom(room.id);
              else await getApiClient(serverUrl).archiveRoom(room.id);
              onArchiveChange(room.id, !archived);
              onClose();
            } catch (error) {
              Alert.alert(`Could not ${verb.toLowerCase()}`, error instanceof Error ? error.message : "Please try again.");
            } finally {
              setBusy(null);
            }
          })();
        },
      },
    ]);
  };

  const leave = (): void => {
    if (!serverUrl || !viewerActorId || busy) return;
    Alert.alert("Leave chat", "You'll stop receiving messages from this chat.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy("leave");
            try {
              await getApiClient(serverUrl).removeRoomMember(room.id, viewerActorId);
              onClose();
              onLeft(room.id);
            } catch (error) {
              Alert.alert("Could not leave", error instanceof Error ? error.message : "Please try again.");
            } finally {
              setBusy(null);
            }
          })();
        },
      },
    ]);
  };

  return (
    <BottomSheet visible={visible} onClose={busy ? undefined : onClose} snapPoints={["44%"]} backdrop>
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={1}>{room.label || "Chat"}</Text>
        {actions.includes("rename") ? (
          <ActionRow icon="pencil-outline" label="Rename chat" onPress={() => onRename(room)} disabled={busy !== null} />
        ) : null}
        {actions.includes("archive") ? (
          <ActionRow icon="archive-outline" label="Archive chat" onPress={() => archive(false)} busy={busy === "archive"} disabled={busy !== null} />
        ) : null}
        {actions.includes("unarchive") ? (
          <ActionRow icon="archive-outline" label="Unarchive chat" onPress={() => archive(true)} busy={busy === "archive"} disabled={busy !== null} />
        ) : null}
        {actions.includes("leave") ? <View style={styles.divider} /> : null}
        {actions.includes("leave") ? (
          <ActionRow icon="exit-outline" label="Leave chat" onPress={leave} busy={busy === "leave"} disabled={busy !== null} destructive />
        ) : null}
      </View>
    </BottomSheet>
  );
}

function ActionRow({ icon, label, onPress, busy = false, disabled = false, destructive = false }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const color = destructive ? t.color.status.error : t.color.text.foreground;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}>
      {busy ? <ActivityIndicator color={color} /> : <Ionicons name={icon} size={20} color={color} />}
      <Text style={[styles.actionText, destructive && styles.destructive]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { gap: t.spacing.xs },
    title: { marginBottom: t.spacing.sm, color: t.color.text.foreground, ...t.typography.subheading },
    row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingHorizontal: t.spacing.sm, borderRadius: t.radii.sm },
    rowPressed: { backgroundColor: t.color.surface.subtle },
    actionText: { color: t.color.text.foreground, ...t.typography.body },
    destructive: { color: t.color.status.error },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.color.border.default, marginVertical: t.spacing.xs },
  });
}
