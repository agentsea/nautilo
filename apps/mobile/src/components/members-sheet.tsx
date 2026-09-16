// D408 Wave 3 — Members sheet (mobile-surface-map §6.5.3). The chat app-bar's
// [👥] button opens this. Two modes:
//   • roster — fresh `getRoom` roster on open; avatar + name + role label
//     (Person/Bot · admin/member, "You" on the viewer's own row). Footer:
//     "Add people or agents" (admin only) + "Leave group" (any member).
//   • add — searchable multi-select of people/agents NOT already in the room
//     (mirrors chat/new.tsx directory search); each pick → addRoomMember with
//     roomRole "member"; refresh roster after adds.
// Read + add + leave only — per-member role/response-mode/conductor toggles are
// DEFERRED (out of this stack's scope). Live `room_members_changed` WS is
// DEFERRED too — the roster re-fetches on open and after each add/leave.
// Mirrors the model-switcher-sheet structure + theming (useAppTheme +
// createStyles). Avatars via MessageAvatar. No hardcoded colors.
import { Ionicons } from "@expo/vector-icons";
import { BottomSheetScrollView, BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { MessageAvatar } from "@/components/message-avatar";
import {
  ReportContentSheet,
  type MobileReportTarget,
} from "@/components/report-content-sheet";
import { getApiClient } from "@/lib/api";
import {
  directoryKindsForViewer,
  filterDirectoryEntriesForViewer,
  mergeDirectoryEntries,
  type DirectoryEntry,
} from "@/features/new-conversation/directory";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { RoomDetailResponse, RoomMemberDto } from "@nautilo/types";

interface Props {
  visible: boolean;
  onClose: () => void;
  serverUrl: string | undefined;
  roomId: string;
  /** Resolved by the chat screen via whoami; identifies the viewer's own row. */
  viewerActorId: string | null;
  canInvokeAgents: boolean;
  /** Navigate the viewer out of the room after a successful self-leave. */
  onLeft: () => void;
  /** Bounded manageable-catalogue eligibility from the owning chat route. */
  canManage: boolean;
  isArchived: boolean;
  /** Converge route and catalogue after the canonical archive mutation succeeds. */
  onArchiveChange: (archived: boolean) => void;
  /** Refresh direct-composer posture after a caller-owned block changes. */
  onBlockChanged?: () => void;
}

function entryKey(kind: "user" | "agent", id: string): string {
  return `${kind}:${id}`;
}

/**
 * Role label per §6.5.3: combine the "You" self cue, Bot (agent members), and
 * the admin badge. Plain user members get no label (member is the implicit
 * default), matching the design mock where only admins/bots/self are tagged.
 */
function roleLabel(member: RoomMemberDto, isSelf: boolean): string {
  const parts: string[] = [];
  if (isSelf) parts.push("You");
  if (member.kind === "agent") parts.push("bot");
  if (member.roomRole === "admin") parts.push("admin");
  return parts.join(" · ");
}

export function MembersSheet({
  visible,
  onClose,
  serverUrl,
  roomId,
  viewerActorId,
  canInvokeAgents,
  onLeft,
  canManage,
  isArchived,
  onArchiveChange,
  onBlockChanged,
}: Props) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  const [room, setRoom] = useState<RoomDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set());
  const [reportTarget, setReportTarget] = useState<MobileReportTarget | null>(null);

  // Add-mode state.
  const [mode, setMode] = useState<"roster" | "add">("roster");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const loadRoster = useCallback(async () => {
    if (!serverUrl) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await getApiClient(serverUrl).getRoom(roomId);
      setRoom(detail);
      try {
        setBlockedUserIds(
          new Set(await getApiClient(serverUrl).listBlockedHumanUserIds()),
        );
      } catch {
        setBlockedUserIds(new Set());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load members.");
    } finally {
      setLoading(false);
    }
  }, [serverUrl, roomId]);

  // Fetch a fresh roster on open; reset to roster mode + clear add-state.
  useEffect(() => {
    if (!visible) return;
    setMode("roster");
    setQuery("");
    setSelected(new Set());
    setEntries([]);
    void loadRoster();
  }, [visible, loadRoster]);

  const members = room?.members ?? [];
  const viewerMember = useMemo(
    () => members.find((m) => m.actorId === viewerActorId) ?? null,
    [members, viewerActorId],
  );
  const viewerIsAdmin = viewerMember?.roomRole === "admin";
  const viewerIsMember = viewerMember !== null;

  const memberUserIds = useMemo(
    () => new Set(members.filter((m) => m.userId).map((m) => m.userId as string)),
    [members],
  );
  const memberAgentIds = useMemo(
    () => new Set(members.filter((m) => m.agentId).map((m) => m.agentId as string)),
    [members],
  );

  // Directory search (add mode only), mirrors chat/new.tsx debounce.
  const runSearch = useCallback(
    async (q: string) => {
      if (!serverUrl) {
        setEntries([]);
        return;
      }
      setSearchLoading(true);
      try {
        const trimmed = q.trim();
        const pages = await Promise.all(directoryKindsForViewer(canInvokeAgents).map((kind) =>
          getApiClient(serverUrl).searchDirectory({
            ...(trimmed ? { q: trimmed } : {}),
            kind,
          }),
        ));
        setEntries(filterDirectoryEntriesForViewer(
          pages.reduce<DirectoryEntry[]>(
            (current, page) => mergeDirectoryEntries(current, page as DirectoryEntry[]),
            [],
          ),
          canInvokeAgents,
        ));
      } catch {
        setEntries([]);
      } finally {
        setSearchLoading(false);
      }
    },
    [canInvokeAgents, serverUrl],
  );

  useEffect(() => {
    if (!visible || mode !== "add") return;
    const handle = setTimeout(() => {
      void runSearch(query);
    }, 200);
    return () => clearTimeout(handle);
  }, [visible, mode, query, runSearch]);

  // Candidates = directory entries not already in the room.
  const candidates = useMemo(
    () =>
      entries.filter((e) =>
        e.kind === "user" ? !memberUserIds.has(e.id) : !memberAgentIds.has(e.id),
      ),
    [entries, memberUserIds, memberAgentIds],
  );

  const toggleCandidate = useCallback((entry: DirectoryEntry) => {
    const key = entryKey(entry.kind, entry.id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleAddSelected = useCallback(async () => {
    if (!serverUrl || selected.size === 0) return;
    setAdding(true);
    const client = getApiClient(serverUrl);
    const failures: string[] = [];
    for (const entry of candidates) {
      const key = entryKey(entry.kind, entry.id);
      if (!selected.has(key)) continue;
      try {
        if (entry.kind === "user") {
          await client.addRoomMember(roomId, {
            kind: "user",
            userId: entry.id,
            roomRole: "member",
          });
        } else {
          await client.addRoomMember(roomId, {
            kind: "agent",
            agentId: entry.id,
            roomRole: "member",
          });
        }
      } catch {
        failures.push(entry.displayName || entry.handle);
      }
    }
    setAdding(false);
    setSelected(new Set());
    await loadRoster();
    setMode("roster");
    if (failures.length > 0) {
      Alert.alert(
        "Some invites failed",
        `Couldn't add: ${failures.join(", ")}.`,
      );
    }
  }, [serverUrl, roomId, selected, candidates, loadRoster]);

  const handleLeave = useCallback(() => {
    if (!serverUrl || !viewerActorId) return;
    Alert.alert("Leave group", "You'll stop receiving messages from this room.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setLeaving(true);
            try {
              await getApiClient(serverUrl).removeRoomMember(roomId, viewerActorId);
              setLeaving(false);
              onClose();
              onLeft();
            } catch (e) {
              setLeaving(false);
              Alert.alert(
                "Could not leave",
                e instanceof Error ? e.message : "Please try again.",
              );
            }
          })();
        },
      },
    ]);
  }, [serverUrl, roomId, viewerActorId, onClose, onLeft]);

  const handleArchive = useCallback(() => {
    if (!serverUrl || archiving) return;
    const verb = isArchived ? "Unarchive" : "Archive";
    Alert.alert(`${verb} chat`, isArchived
      ? "This chat will return to your active conversations."
      : "This hides the chat from active conversations. Messages are kept.", [
      { text: "Cancel", style: "cancel" },
      {
        text: verb,
        style: isArchived ? "default" : "destructive",
        onPress: () => {
          void (async () => {
            setArchiving(true);
            try {
              if (isArchived) await getApiClient(serverUrl).unarchiveRoom(roomId);
              else await getApiClient(serverUrl).archiveRoom(roomId);
              setArchiving(false);
              if (!isArchived) onClose();
              onArchiveChange(!isArchived);
            } catch (e) {
              setArchiving(false);
              Alert.alert(`Could not ${verb.toLowerCase()}`, e instanceof Error ? e.message : "Please try again.");
            }
          })();
        },
      },
    ]);
  }, [archiving, isArchived, onArchiveChange, onClose, roomId, serverUrl]);

  const handleHumanMember = useCallback((member: RoomMemberDto) => {
    if (!serverUrl || member.kind !== "user" || !member.userId || member.actorId === viewerActorId) {
      return;
    }
    const isBlocked = blockedUserIds.has(member.userId);
    const verb = isBlocked ? "Unblock" : "Block";
    const changeBlock = (): void => {
      Alert.alert(
        `${verb} ${member.displayName}?`,
        isBlocked
          ? "You will be able to start or continue direct chats again unless they have blocked you."
          : "You will both be unable to start or continue a direct chat. Shared rooms and existing history stay visible.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: verb,
            style: isBlocked ? "default" : "destructive",
            onPress: () => {
              void (async () => {
                try {
                  const client = getApiClient(serverUrl);
                  if (isBlocked) await client.unblockHuman(member.userId!);
                  else await client.blockHuman(member.userId!);
                  setBlockedUserIds((current) => {
                    const next = new Set(current);
                    if (isBlocked) next.delete(member.userId!);
                    else next.add(member.userId!);
                    return next;
                  });
                  onBlockChanged?.();
                } catch {
                  Alert.alert(`Could not ${verb.toLowerCase()}`, "Please try again.");
                }
              })();
            },
          },
        ],
      );
    };
    Alert.alert(member.displayName, "Choose an action", [
      {
        text: "Report person",
        onPress: () => setReportTarget({
          type: "person",
          roomId,
          userId: member.userId!,
          label: member.displayName,
        }),
      },
      {
        text: `${verb} person`,
        style: isBlocked ? "default" : "destructive",
        onPress: changeBlock,
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [blockedUserIds, onBlockChanged, roomId, serverUrl, viewerActorId]);

  const headerTitle =
    mode === "add"
      ? canInvokeAgents ? "Add people or agents" : "Add people"
      : room
        ? `${room.label && room.label.length > 0 ? room.label : "Room"} · ${members.length} ${members.length === 1 ? "member" : "members"}`
        : "Members";

  return (
    <>
    <BottomSheet visible={visible} onClose={onClose} snapPoints={["70%"]}>
      <View style={styles.header}>
        {mode === "add" ? (
          <Pressable
            style={styles.backButton}
            onPress={() => setMode("roster")}
            accessibilityRole="button"
            accessibilityLabel="Back to members">
            <Ionicons name="chevron-back" size={20} color={t.color.text.foreground} />
          </Pressable>
        ) : null}
        <Text style={styles.title} numberOfLines={1}>
          {headerTitle}
        </Text>
      </View>

      {mode === "roster" ? (
        loading ? (
          <View style={styles.stateWrap}>
            <ActivityIndicator color={t.color.brand.accent} />
          </View>
        ) : error ? (
          <View style={styles.stateWrap}>
            <Text style={styles.stateTitle}>Could not load members</Text>
            <Text style={styles.stateSub}>{error}</Text>
            <Pressable style={styles.retryButton} onPress={() => void loadRoster()}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <BottomSheetScrollView showsVerticalScrollIndicator={false}>
            {members.map((m) => {
              const isSelf = m.actorId === viewerActorId;
              const label = roleLabel(m, isSelf);
              return (
                <Pressable
                  key={m.actorId}
                  style={styles.row}
                  disabled={m.kind !== "user" || isSelf}
                  onPress={() => handleHumanMember(m)}
                  accessibilityRole={m.kind === "user" && !isSelf ? "button" : undefined}
                  accessibilityLabel={m.kind === "user" && !isSelf ? `Actions for ${m.displayName}` : undefined}>
                  {serverUrl ? (
                    <MessageAvatar
                      serverUrl={serverUrl}
                      roomId={roomId}
                      displayName={m.displayName}
                      userId={m.userId}
                      agentId={m.agentId}
                      agentAvatar={m.agentAvatar}
                      size={36}
                    />
                  ) : (
                    <View style={styles.avatarFallback} />
                  )}
                  <View style={styles.rowMeta}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {m.displayName}
                    </Text>
                    {m.handle ? (
                      <Text style={styles.rowSub} numberOfLines={1}>
                        @{m.handle}
                      </Text>
                    ) : null}
                  </View>
                  {blockedUserIds.has(m.userId ?? "") ? (
                    <Text style={styles.roleLabel}>blocked</Text>
                  ) : label ? <Text style={styles.roleLabel}>{label}</Text> : null}
                </Pressable>
              );
            })}

            <View style={styles.divider} />

            {viewerIsAdmin ? (
              <Pressable
                style={styles.actionRow}
                onPress={() => setMode("add")}
                accessibilityRole="button"
                accessibilityLabel={canInvokeAgents ? "Add people or agents" : "Add people"}>
                <Ionicons
                  name="person-add-outline"
                  size={20}
                  color={t.color.text.foreground}
                />
                <Text style={styles.actionLabel}>{canInvokeAgents ? "Add people or agents" : "Add people"}</Text>
              </Pressable>
            ) : null}

            {viewerIsMember ? (
              <Pressable
                style={styles.actionRow}
                onPress={handleLeave}
                disabled={leaving}
                accessibilityRole="button"
                accessibilityLabel="Leave group">
                {leaving ? (
                  <ActivityIndicator size="small" color={t.color.status.error} />
                ) : (
                  <Ionicons name="exit-outline" size={20} color={t.color.status.error} />
                )}
                <Text style={[styles.actionLabel, styles.destructiveLabel]}>
                  Leave group
                </Text>
              </Pressable>
            ) : null}
            {canManage ? (
              <Pressable
                style={styles.actionRow}
                onPress={handleArchive}
                disabled={archiving}
                accessibilityRole="button"
                accessibilityLabel={isArchived ? "Unarchive chat" : "Archive chat"}>
                {archiving ? (
                  <ActivityIndicator size="small" color={t.color.text.foreground} />
                ) : (
                  <Ionicons name="archive-outline" size={20} color={t.color.text.foreground} />
                )}
                <Text style={styles.actionLabel}>{isArchived ? "Unarchive chat" : "Archive chat"}</Text>
              </Pressable>
            ) : null}
          </BottomSheetScrollView>
        )
      ) : (
        <>
          <View style={styles.searchRow}>
            <Ionicons
              name="search-outline"
              size={18}
              color={t.color.text.disabled}
              style={styles.searchIcon}
            />
            <BottomSheetTextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder={canInvokeAgents ? "Search people and agents" : "Search people"}
              placeholderTextColor={t.color.text.disabled}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>

          <BottomSheetScrollView
            style={styles.candidateList}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            {searchLoading ? (
              <View style={styles.stateWrap}>
                <ActivityIndicator color={t.color.brand.accent} />
              </View>
            ) : candidates.length === 0 ? (
              <View style={styles.stateWrap}>
                <Text style={styles.stateTitle}>
                  {query.trim() ? "No matches" : "No one to add"}
                </Text>
                <Text style={styles.stateSub}>
                  {query.trim()
                    ? "Try a different name."
                    : "Everyone available is already in this room."}
                </Text>
              </View>
            ) : (
              candidates.map((entry) => {
                const key = entryKey(entry.kind, entry.id);
                const isSelected = selected.has(key);
                return (
                  <Pressable
                    key={key}
                    style={styles.row}
                    onPress={() => toggleCandidate(entry)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}>
                    <View style={styles.candidateAvatar}>
                      <Ionicons
                        name={entry.kind === "user" ? "person-outline" : "sparkles-outline"}
                        size={18}
                        color={t.color.text.foreground}
                      />
                    </View>
                    <View style={styles.rowMeta}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {entry.displayName}
                      </Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        @{entry.handle}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.checkCircle,
                        isSelected && styles.checkCircleSelected,
                      ]}>
                      {isSelected ? (
                        <Ionicons
                          name="checkmark"
                          size={14}
                          color={t.color.text.onPrimary}
                        />
                      ) : null}
                    </View>
                  </Pressable>
                );
              })
            )}
          </BottomSheetScrollView>

          <Pressable
            style={[
              styles.addButton,
              (selected.size === 0 || adding) && styles.addButtonDisabled,
            ]}
            onPress={() => void handleAddSelected()}
            disabled={selected.size === 0 || adding}>
            {adding ? (
              <ActivityIndicator color={t.color.text.onPrimary} />
            ) : (
              <Text style={styles.addButtonText}>
                {selected.size > 0 ? `Add ${selected.size}` : "Add"}
              </Text>
            )}
          </Pressable>
        </>
      )}
    </BottomSheet>
    <ReportContentSheet
      serverUrl={serverUrl}
      target={reportTarget}
      onClose={() => setReportTarget(null)}
    />
    </>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.xs,
      paddingVertical: t.spacing.sm,
      marginBottom: t.spacing.xs,
    },
    backButton: { padding: t.spacing.xs, marginLeft: -t.spacing.xs },
    title: { flex: 1, color: t.color.text.foreground, ...t.typography.subheading },
    stateWrap: {
      paddingVertical: t.spacing.xl,
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
    },
    stateTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    stateSub: { color: t.color.text.muted, textAlign: "center", ...t.typography.body },
    retryButton: {
      marginTop: t.spacing.sm,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    retryText: { color: t.color.text.foreground, ...t.typography.label },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.sm + 2,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
    },
    avatarFallback: {
      width: 36,
      height: 36,
      borderRadius: t.radii.pill,
      backgroundColor: t.color.surface.element,
    },
    rowMeta: { flex: 1, gap: t.spacing.xs / 2 },
    rowName: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    rowSub: { color: t.color.text.muted, ...t.typography.caption },
    roleLabel: { color: t.color.text.dim, ...t.typography.caption },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: t.color.border.default,
      marginVertical: t.spacing.sm,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.md,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
    },
    actionLabel: { color: t.color.text.foreground, ...t.typography.body },
    destructiveLabel: { color: t.color.status.error },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm + 2,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      marginBottom: t.spacing.sm,
    },
    searchIcon: { opacity: 0.5 },
    searchInput: { flex: 1, color: t.color.text.foreground, ...t.typography.body },
    candidateList: { flexGrow: 0 },
    candidateAvatar: {
      width: 36,
      height: 36,
      borderRadius: t.radii.pill,
      backgroundColor: t.color.surface.element,
      alignItems: "center",
      justifyContent: "center",
    },
    checkCircle: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: t.color.border.default,
      alignItems: "center",
      justifyContent: "center",
    },
    checkCircleSelected: {
      borderColor: t.color.brand.accent,
      backgroundColor: t.color.brand.accent,
    },
    addButton: {
      marginTop: t.spacing.md,
      paddingVertical: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.brand.accent,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 48,
    },
    addButtonDisabled: { opacity: 0.6 },
    addButtonText: { color: t.color.text.onPrimary, ...t.typography.bodyStrong },
  });
}
