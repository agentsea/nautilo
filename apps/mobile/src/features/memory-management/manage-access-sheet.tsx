import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getApiClient } from "@/lib/api";
import { memoryAccessRecipients } from "@/features/memory/presentation";
import { formatMakeMemoryPrivateOutcome, formatRevokeMemoryOutcome } from "@/features/memory-management/mutation-outcomes";
import { isListableRoom, roomDisplayName, sortRoomsByRecency } from "@/lib/rooms";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { RoomSummaryDto } from "@nautilo/types";

export type AccessPerson = { displayName: string; userHandle: string };

type Props = {
  visible: boolean;
  memoryId: string;
  accessList: AccessPerson[];
  currentUserHandle?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
};

type TargetKind = "person" | "conversation";
type Person = { userId: string; handle: string; displayName: string };

export function ManageAccessSheet({
  visible,
  memoryId,
  accessList,
  currentUserHandle,
  onClose,
  onChanged,
}: Props) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { activeServer } = useServers();
  const [targetKind, setTargetKind] = useState<TargetKind | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [rooms, setRooms] = useState<RoomSummaryDto[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const resetTarget = (): void => {
    setTargetKind(null);
    setQuery("");
    setTargetError(null);
  };

  const loadTargets = useCallback(async (kind: TargetKind) => {
    if (!activeServer) return;
    setLoadingTargets(true);
    setTargetError(null);
    try {
      const client = getApiClient(activeServer.serverUrl);
      if (kind === "person") {
        setPeople(await client.listDirectoryHumans());
      } else {
        const response = await client.listRooms();
        setRooms(sortRoomsByRecency(response.rooms.filter((room) => isListableRoom(room.kind))));
      }
    } catch (caught) {
      setTargetError(caught instanceof Error ? caught.message : "Could not load sharing targets.");
    } finally {
      setLoadingTargets(false);
    }
  }, [activeServer]);

  useEffect(() => {
    if (targetKind) void loadTargets(targetKind);
  }, [loadTargets, targetKind]);

  const share = (label: string, target: { userHandle: string } | { roomId: string }): void => {
    if (!activeServer) return;
    Alert.alert("Share memory?", `Share this memory with ${label}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Share",
        onPress: () => {
          void (async () => {
            setBusy(true);
            setOutcome(null);
            try {
              const result = await getApiClient(activeServer.serverUrl).grantMemory(memoryId, target);
              await onChanged();
              setOutcome(
                result.minted
                  ? `Shared with ${result.roomLabel ?? label}.`
                  : `Access granted to ${result.roomLabel ?? label}.`,
              );
              resetTarget();
            } catch (caught) {
              setOutcome(caught instanceof Error ? caught.message : "Could not share this memory.");
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const revoke = (person: AccessPerson): void => {
    if (!activeServer) return;
    Alert.alert(
      `Remove ${person.displayName || `@${person.userHandle}`}?`,
      "They will no longer have access to this memory. Other recipients keep their access.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              setOutcome(null);
              try {
                const result = await getApiClient(activeServer.serverUrl).revokeMemory(memoryId, person.userHandle);
                await onChanged();
                setOutcome(formatRevokeMemoryOutcome(result));
              } catch (caught) {
                setOutcome(caught instanceof Error ? caught.message : "Could not remove access.");
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const makePrivate = (): void => {
    if (!activeServer) return;
    Alert.alert(
      "Make this memory private?",
      "This removes other writable access. You and your Genie will keep private access.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Make private",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              setOutcome(null);
              try {
                const result = await getApiClient(activeServer.serverUrl).makeMemoryPrivate(memoryId);
                await onChanged();
                setOutcome(formatMakeMemoryPrivateOutcome(result));
              } catch (caught) {
                setOutcome(caught instanceof Error ? caught.message : "Could not make this memory private.");
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const recipients = memoryAccessRecipients(accessList, currentUserHandle);
  const inaccessibleHandles = new Set(
    [
      ...accessList.map((person) => person.userHandle),
      ...(currentUserHandle ? [currentUserHandle] : []),
    ].map((handle) => handle.trim().toLocaleLowerCase()),
  );
  const loweredQuery = query.trim().toLocaleLowerCase();
  const matchingPeople = people.filter(
    (person) =>
      !inaccessibleHandles.has(person.handle.trim().toLocaleLowerCase()) &&
      `${person.displayName} ${person.handle}`.toLocaleLowerCase().includes(loweredQuery),
  );
  const matchingRooms = rooms.filter((room) => roomDisplayName(room).toLocaleLowerCase().includes(loweredQuery));

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior="padding"
        style={[
          styles.container,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.header}>
          <Pressable
            onPress={targetKind ? resetTarget : onClose}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel={targetKind ? "Back to manage access" : "Close manage access"}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={24} color={t.color.text.foreground} />
          </Pressable>
          <Text style={styles.title}>{targetKind ? "Share memory" : "Manage access"}</Text>
          <View style={styles.headerButton} />
        </View>
        {outcome ? <Text style={styles.outcome}>{outcome}</Text> : null}
        {targetKind ? (
          <>
            <View style={styles.search}>
              <Ionicons name="search-outline" size={18} color={t.color.text.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                style={styles.searchInput}
                placeholder={targetKind === "person" ? "Search people" : "Search conversations"}
                placeholderTextColor={t.color.text.dim}
                autoCorrect={false}
              />
            </View>
            {loadingTargets ? (
              <View style={styles.center}><ActivityIndicator color={t.color.brand.accent} /></View>
            ) : targetError ? (
              <Text style={styles.error}>{targetError}</Text>
            ) : (
              <ScrollView contentContainerStyle={styles.list}>
                {(targetKind === "person" ? matchingPeople : matchingRooms).map((entry) => {
                  const label = targetKind === "person"
                    ? (entry as Person).displayName || `@${(entry as Person).handle}`
                    : roomDisplayName(entry as RoomSummaryDto);
                  return (
                    <Pressable
                      key={targetKind === "person" ? (entry as Person).userId : (entry as RoomSummaryDto).id}
                      style={styles.targetRow}
                      disabled={busy}
                      onPress={() => void share(
                        label,
                        targetKind === "person"
                          ? { userHandle: (entry as Person).handle }
                          : { roomId: (entry as RoomSummaryDto).id },
                      )}
                    >
                      <Ionicons name={targetKind === "person" ? "person-outline" : "chatbubble-outline"} size={20} color={t.color.text.muted} />
                      <Text style={styles.targetLabel}>{label}</Text>
                      <Text style={styles.targetAction}>Select</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.sectionLabel}>Shared with</Text>
            {recipients.length ? recipients.map((person) => (
              <View key={person.userHandle} style={styles.personRow}>
                <View style={styles.avatar}><Ionicons name="person-outline" size={18} color={t.color.text.muted} /></View>
                <Text style={styles.personName}>{person.displayName || `@${person.userHandle}`}</Text>
                <Pressable disabled={busy} onPress={() => revoke(person)}>
                  <Text style={styles.remove}>Remove</Text>
                </Pressable>
              </View>
            )) : <Text style={styles.empty}>Only you can access this memory.</Text>}
            <Pressable style={styles.actionRow} disabled={busy} onPress={() => setTargetKind("person")}>
              <Ionicons name="person-add-outline" size={20} color={t.color.brand.accent} /><Text style={styles.actionLabel}>Share with a person</Text>
            </Pressable>
            <Pressable style={styles.actionRow} disabled={busy} onPress={() => setTargetKind("conversation")}>
              <Ionicons name="chatbubbles-outline" size={20} color={t.color.brand.accent} /><Text style={styles.actionLabel}>Share with a conversation</Text>
            </Pressable>
            {recipients.length ? (
              <>
                <View style={styles.divider} />
                <Pressable style={styles.actionRow} disabled={busy} onPress={makePrivate}>
                  <Ionicons name="lock-closed-outline" size={20} color={t.color.status.error} /><Text style={[styles.actionLabel, { color: t.color.status.error }]}>Make private</Text>
                </Pressable>
              </>
            ) : null}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: t.spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    headerButton: { width: 36, paddingVertical: t.spacing.xs },
    title: { color: t.color.text.foreground, ...t.typography.subheading },
    body: { padding: t.spacing.lg, gap: t.spacing.sm },
    sectionLabel: { marginBottom: t.spacing.xs, color: t.color.text.muted, ...t.typography.caption },
    personRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingVertical: t.spacing.sm },
    avatar: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: t.color.surface.element },
    personName: { flex: 1, color: t.color.text.foreground, ...t.typography.body },
    remove: { color: t.color.status.error, ...t.typography.label },
    empty: { color: t.color.text.muted, ...t.typography.body },
    actionRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingVertical: t.spacing.md },
    actionLabel: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.color.border.default, marginVertical: t.spacing.sm },
    outcome: { margin: t.spacing.lg, padding: t.spacing.md, borderRadius: t.radii.md, color: t.color.text.foreground, backgroundColor: t.color.surface.subtle, ...t.typography.caption },
    search: { margin: t.spacing.lg, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.element },
    searchInput: { flex: 1, paddingVertical: t.spacing.sm, color: t.color.text.foreground, ...t.typography.body },
    list: { paddingHorizontal: t.spacing.lg },
    targetRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingVertical: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    targetLabel: { flex: 1, color: t.color.text.foreground, ...t.typography.body },
    targetAction: { color: t.color.brand.accent, ...t.typography.label },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    error: { margin: t.spacing.lg, color: t.color.status.error, ...t.typography.body },
  });
}
