import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import {
  DIRECTORY_PAGE_SIZE,
  directoryKindsForViewer,
  directoryEntryKey,
  filterDirectoryEntriesForViewer,
  mergeDirectoryEntries,
  type DirectoryEntry,
} from "@/features/new-conversation/directory";
import { getApiClient } from "@/lib/api";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { CreateRoomMemberInput, RoomDetailResponse } from "@nautilo/types";

type CreationMode = "chooser" | "direct" | "group" | "room";
type DirectoryKind = "user" | "agent";

const TITLE_BY_MODE: Record<CreationMode, string> = {
  chooser: "New conversation",
  direct: "Direct message",
  group: "New group",
  room: "New room",
};

export default function NewChatScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const navigation = useNavigation();
  const { activeServer } = useServers();
  const { viewer, viewerState } = useAuth();
  const params = useLocalSearchParams<{ query?: string }>();
  const [mode, setMode] = useState<CreationMode>("chooser");
  const [query, setQuery] = useState(params.query ?? "");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [selected, setSelected] = useState<Map<string, DirectoryEntry>>(new Map());
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offsetsRef = useRef<Record<DirectoryKind, number>>({ user: 0, agent: 0 });
  const hasMoreRef = useRef<Record<DirectoryKind, boolean>>({ user: true, agent: true });
  const requestGenerationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const listRef = useRef<FlatList<DirectoryEntry>>(null);
  const nameOffsetRef = useRef(0);
  const searchOffsetRef = useRef(0);

  const viewerUserId = viewer?.userId ?? null;
  const canInvokeAgents = viewerCan(viewer, "invoke_agents");
  const canCreateRooms =
    viewerCan(viewer, "create_rooms") || viewerCan(viewer, "manage_rooms");
  const canManageRooms = viewer?.capabilities.includes("manage_rooms") ?? false;
  const directoryVisible = mode !== "chooser";

  const revealHeaderControl = useCallback((offset: number) => {
    setTimeout(() => {
      listRef.current?.scrollToOffset({
        animated: true,
        offset: Math.max(0, offset - t.spacing.sm),
      });
    }, 180);
  }, [t.spacing.sm]);

  useEffect(() => {
    navigation.setOptions({ title: TITLE_BY_MODE[mode] });
  }, [mode, navigation]);

  const loadDirectory = useCallback(
    async (reset: boolean) => {
      if (!activeServer || !directoryVisible) return;
      if (!reset && (!hasMoreRef.current.user && !hasMoreRef.current.agent)) return;
      if (!reset && loadingMoreRef.current) return;
      const generation = reset ? ++requestGenerationRef.current : requestGenerationRef.current;
      if (reset) {
        offsetsRef.current = { user: 0, agent: 0 };
        hasMoreRef.current = { user: true, agent: canInvokeAgents };
        setEntries([]);
        setLoading(true);
      } else {
        loadingMoreRef.current = true;
        setLoadingMore(true);
      }
      setError(null);
      const trimmed = query.trim();
      const client = getApiClient(activeServer.serverUrl);
      try {
        const kinds = directoryKindsForViewer(canInvokeAgents).filter(
          (kind) => reset || hasMoreRef.current[kind],
        );
        const pages = await Promise.all(
          kinds.map(async (kind) => ({
            kind,
            entries: await client.searchDirectory({
              ...(trimmed ? { q: trimmed } : {}),
              kind,
              limit: DIRECTORY_PAGE_SIZE,
              offset: reset ? 0 : offsetsRef.current[kind],
            }),
          })),
        );
        if (requestGenerationRef.current !== generation) return;
        const incoming = pages.flatMap((page) => {
          offsetsRef.current[page.kind] += page.entries.length;
          hasMoreRef.current[page.kind] = page.entries.length === DIRECTORY_PAGE_SIZE;
          return page.entries;
        });
        setEntries((current) => filterDirectoryEntriesForViewer(
          mergeDirectoryEntries(reset ? [] : current, incoming),
          canInvokeAgents,
        ));
      } catch {
        if (requestGenerationRef.current !== generation) return;
        setError("Couldn’t load people and Genies. Check your connection and try again.");
      } finally {
        if (requestGenerationRef.current === generation) {
          setLoading(false);
          setLoadingMore(false);
          loadingMoreRef.current = false;
        }
      }
    },
    [activeServer, canInvokeAgents, directoryVisible, query],
  );

  useEffect(() => {
    if (canInvokeAgents) return;
    setEntries((current) => filterDirectoryEntriesForViewer(current, false));
    setSelected((current) => new Map(
      [...current].filter(([, entry]) => entry.kind === "user"),
    ));
  }, [canInvokeAgents]);

  useEffect(() => {
    if (!directoryVisible) return;
    const timer = setTimeout(() => void loadDirectory(true), 250);
    return () => clearTimeout(timer);
  }, [directoryVisible, loadDirectory]);

  const enterMode = useCallback((nextMode: Exclude<CreationMode, "chooser">) => {
    setMode(nextMode);
    setQuery("");
    setSelected(new Map());
    setName("");
    setIsPublic(false);
    setError(null);
  }, []);

  const navigateToRoom = useCallback((room: RoomDetailResponse) => {
    router.replace(`/chat/${room.id}`);
  }, []);

  const startDirect = useCallback(
    async (entry: DirectoryEntry) => {
      if (!activeServer || !viewerUserId || entry.actionable === false) return;
      const key = directoryEntryKey(entry);
      setCreatingKey(key);
      setError(null);
      try {
        const client = getApiClient(activeServer.serverUrl);
        const created = await client.createRoom(
          entry.kind === "agent"
            ? {
                label: entry.displayName,
                kind: "private",
                members: [
                  { kind: "user", id: viewerUserId },
                  { kind: "agent", id: entry.id },
                ],
              }
            : {
                label: entry.displayName,
                kind: "private",
                directHumanUserId: entry.id,
              },
        );
        navigateToRoom(created);
      } catch {
        setError("Couldn’t open this conversation. Check your connection and try again.");
      } finally {
        setCreatingKey(null);
      }
    },
    [activeServer, navigateToRoom, viewerUserId],
  );

  const toggleSelected = useCallback((entry: DirectoryEntry) => {
    setSelected((current) => {
      const next = new Map(current);
      const key = directoryEntryKey(entry);
      if (next.has(key)) next.delete(key);
      else next.set(key, entry);
      return next;
    });
  }, []);

  const createRoom = useCallback(async () => {
    if (!activeServer || !viewerUserId || mode === "chooser" || mode === "direct") return;
    const label = name.trim();
    const minimumSelection = mode === "group" ? 2 : 0;
    if (!label) {
      setError(mode === "group" ? "Enter a group name." : "Enter a room name.");
      return;
    }
    if (selected.size < minimumSelection) {
      setError("Select at least two people or Genies for a group.");
      return;
    }
    if (!canCreateRooms || (isPublic && !canManageRooms)) {
      setError("You do not have permission to create groups or rooms on this server.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const members: CreateRoomMemberInput[] = [
        { kind: "user", id: viewerUserId },
        ...[...selected.values()].map((entry) => ({ kind: entry.kind, id: entry.id })),
      ];
      const created = await getApiClient(activeServer.serverUrl).createRoom({
        label,
        members,
        kind: mode === "room" ? (isPublic ? "open" : "private") : "group",
        catalogueKind: mode === "room" ? "room" : "chat",
      });
      navigateToRoom(created);
    } catch {
      setError("Couldn’t create this conversation. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  }, [activeServer, canCreateRooms, canManageRooms, isPublic, mode, name, navigateToRoom, selected, viewerUserId]);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => entry.kind !== "user" || entry.id !== viewerUserId),
    [entries, viewerUserId],
  );
  const selectableVisibleEntries = useMemo(
    () => visibleEntries.filter((entry) => entry.actionable !== false),
    [visibleEntries],
  );
  const allVisibleSelected =
    selectableVisibleEntries.length > 0 &&
    selectableVisibleEntries.every((entry) => selected.has(directoryEntryKey(entry)));
  const setVisibleSelection = useCallback((shouldSelect: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      for (const entry of selectableVisibleEntries) {
        const key = directoryEntryKey(entry);
        if (shouldSelect) next.set(key, entry);
        else next.delete(key);
      }
      return next;
    });
  }, [selectableVisibleEntries]);
  const canCreate =
    !creating &&
    canCreateRooms &&
    (!isPublic || canManageRooms) &&
    name.trim().length > 0 &&
    (mode === "room" || (mode === "group" && selected.size >= 2));

  const renderDirectoryRow = useCallback(
    ({ item }: { item: DirectoryEntry }) => {
      const key = directoryEntryKey(item);
      const checked = selected.has(key);
      const rowBusy = creatingKey === key;
      const unavailable = item.actionable === false;
      const direct = mode === "direct";
      return (
        <Pressable
          style={({ pressed }) => [styles.directoryRow, pressed && styles.pressed]}
          onPress={() => (direct ? void startDirect(item) : toggleSelected(item))}
          disabled={creating || creatingKey !== null || unavailable}
          accessibilityRole={direct ? "button" : "checkbox"}
          accessibilityState={direct ? undefined : { checked }}
          accessibilityLabel={`${item.displayName}, @${item.handle}${unavailable ? ", unavailable" : ""}`}
        >
          <View style={styles.avatar}>
            <Ionicons
              name={item.kind === "user" ? "person-outline" : "sparkles-outline"}
              size={21}
              color={t.color.text.foreground}
            />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowName} numberOfLines={1}>{item.displayName}</Text>
            <Text style={styles.rowHandle} numberOfLines={1}>
              {item.kind === "user"
                ? `Human · @${item.handle}`
                : `${item.agentOwnerDisplayName?.trim() || (item.agentOwnerHandle ? `@${item.agentOwnerHandle}` : "Unknown owner")}’s Genie · @${item.handle}`}
            </Text>
            {unavailable ? (
              <Text style={styles.rowHandle} numberOfLines={1}>
                Your role cannot invoke Genies
              </Text>
            ) : null}
          </View>
          {rowBusy ? (
            <ActivityIndicator color={t.color.brand.accent} />
          ) : direct ? (
            <Ionicons name="chevron-forward" size={20} color={t.color.text.dim} />
          ) : (
            <View style={[styles.check, checked && styles.checkSelected]}>
              {checked ? <Ionicons name="checkmark" size={15} color={t.color.text.onPrimary} /> : null}
            </View>
          )}
        </Pressable>
      );
    },
    [creating, creatingKey, mode, selected, startDirect, styles, t, toggleSelected],
  );

  if (viewerState === "loading") {
    return <View style={[styles.container, styles.center]}><ActivityIndicator color={t.color.brand.accent} /></View>;
  }
  if (!viewerUserId) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.stateTitle}>Sign in required</Text>
        <Text style={styles.stateBody}>Sign in to start or create a conversation.</Text>
      </View>
    );
  }

  if (mode === "chooser") {
    return (
      <View style={styles.container}>
        <Text style={styles.chooserIntro}>What would you like to start?</Text>
        <View style={styles.chooserList}>
          <ChoiceRow icon="person-outline" title="Direct message" detail={canInvokeAgents ? "Talk privately with one person or Genie" : "Talk privately with one person"} onPress={() => enterMode("direct")} styles={styles} theme={t} />
          <ChoiceRow icon="people-outline" title="New group" detail={canInvokeAgents ? "Bring people and Genies together" : "Bring people together"} onPress={() => enterMode("group")} styles={styles} theme={t} />
          <ChoiceRow icon="chatbubbles-outline" title="New room" detail="Create a private or public space" onPress={() => enterMode("room")} styles={styles} theme={t} />
        </View>
      </View>
    );
  }

  const listHeader = (
    <View>
      {mode !== "direct" ? (
        <View
          style={styles.nameSection}
          onLayout={(event) => { nameOffsetRef.current = event.nativeEvent.layout.y; }}
        >
          <Text style={styles.fieldLabel}>{mode === "group" ? "Group name" : "Room name"}</Text>
          <TextInput
            value={name}
            onChangeText={(value) => setName(value.slice(0, 80))}
            style={styles.nameInput}
            placeholder={mode === "group" ? "Casey, Jeannie, and you" : "launch-planning"}
            placeholderTextColor={t.color.text.disabled}
            returnKeyType="next"
            onFocus={() => revealHeaderControl(nameOffsetRef.current)}
          />
        </View>
      ) : (
        <Text style={styles.directIntro}>{canInvokeAgents
          ? "Choose a person to open your existing DM, or choose a Genie to start a fresh chat."
          : "Choose a person to open your existing DM."}</Text>
      )}

      {mode === "room" ? (
        <View style={styles.visibilitySection}>
          <Text style={styles.fieldLabel}>Who can find this room?</Text>
          <View style={styles.segmented}>
            <VisibilityChoice selected={!isPublic} label="Private" icon="lock-closed-outline" onPress={() => setIsPublic(false)} styles={styles} theme={t} />
            <VisibilityChoice selected={isPublic} label="Public" icon="globe-outline" onPress={() => setIsPublic(true)} styles={styles} theme={t} />
          </View>
        </View>
      ) : null}

      {mode !== "direct" ? (
        <View style={styles.selectionHeader}>
          <View style={styles.selectionTitleRow}>
            <Text style={styles.sectionTitle}>People and Genies</Text>
            <Pressable
              onPress={() => setVisibleSelection(!allVisibleSelected)}
              disabled={selectableVisibleEntries.length === 0}
              accessibilityRole="button"
              accessibilityLabel={allVisibleSelected ? "Clear everyone" : `Select everyone (${selectableVisibleEntries.length})`}
              style={styles.selectionActionButton}
            >
              <Text style={styles.selectionAction}>
                {allVisibleSelected ? "Clear everyone" : `Select everyone (${selectableVisibleEntries.length})`}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.selectionCount}>
            {mode === "group" ? `${selected.size} selected · choose at least 2` : `${selected.size} selected · optional`}
          </Text>
        </View>
      ) : null}

      <View
        style={styles.searchBox}
        onLayout={(event) => { searchOffsetRef.current = event.nativeEvent.layout.y; }}
      >
        <Ionicons name="search-outline" size={20} color={t.color.text.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          style={styles.searchInput}
          placeholder="Search people or Genies"
          placeholderTextColor={t.color.text.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onFocus={() => revealHeaderControl(searchOffsetRef.current)}
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={20} color={t.color.text.dim} />
          </Pressable>
        ) : null}
      </View>

      {selected.size > 0 && mode !== "direct" ? (
        <View style={styles.selectedSummary}>
          {[...selected.values()].slice(0, 3).map((entry) => (
            <View key={directoryEntryKey(entry)} style={styles.selectedChip}>
              <Text style={styles.selectedChipText} numberOfLines={1}>{entry.displayName}</Text>
              <Pressable onPress={() => toggleSelected(entry)} accessibilityLabel={`Remove ${entry.displayName}`}>
                <Ionicons name="close" size={16} color={t.color.text.muted} />
              </Pressable>
            </View>
          ))}
          {selected.size > 3 ? <Text style={styles.moreSelected}>+{selected.size - 3} more</Text> : null}
        </View>
      ) : null}

      {error && visibleEntries.length > 0 ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="height"
      automaticOffset
    >
        <FlatList
          ref={listRef}
          data={visibleEntries}
          keyExtractor={directoryEntryKey}
          renderItem={renderDirectoryRow}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            loading ? (
              <View style={styles.listState}><ActivityIndicator color={t.color.brand.accent} /></View>
            ) : (
              <View style={styles.listState}>
                <Text style={styles.stateTitle}>{error ? "Couldn’t load the directory" : query.trim() ? "No matches" : "No one is available yet"}</Text>
                <Text style={styles.stateBody}>{error ?? (query.trim() ? "Try another name or handle." : "People and Genies will appear here when they’re available.")}</Text>
                {error ? <Pressable style={styles.retry} onPress={() => void loadDirectory(true)}><Text style={styles.retryText}>Try again</Text></Pressable> : null}
              </View>
            )
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.loadingMore} color={t.color.brand.accent} /> : <View style={styles.listTail} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onEndReached={() => void loadDirectory(false)}
          onEndReachedThreshold={0.4}
          contentContainerStyle={styles.listContent}
        />
      {mode !== "direct" ? (
        <View style={styles.fixedFooter}>
          <Pressable
            style={[styles.createButton, !canCreate && styles.createButtonDisabled]}
            onPress={() => void createRoom()}
            disabled={!canCreate}
            accessibilityRole="button"
          >
            {creating ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.createButtonText}>{mode === "group" ? "Create group" : "Create room"}</Text>}
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function ChoiceRow(props: { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string; onPress: () => void; styles: ReturnType<typeof createStyles>; theme: AppTheme }) {
  return (
    <Pressable style={({ pressed }) => [props.styles.choiceRow, pressed && props.styles.pressed]} onPress={props.onPress} accessibilityRole="button">
      <View style={props.styles.choiceIcon}><Ionicons name={props.icon} size={24} color={props.theme.color.brand.accent} /></View>
      <View style={props.styles.rowBody}><Text style={props.styles.choiceTitle}>{props.title}</Text><Text style={props.styles.choiceDetail}>{props.detail}</Text></View>
      <Ionicons name="chevron-forward" size={20} color={props.theme.color.text.dim} />
    </Pressable>
  );
}

function VisibilityChoice(props: { selected: boolean; label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; styles: ReturnType<typeof createStyles>; theme: AppTheme }) {
  return (
    <Pressable style={[props.styles.visibilityChoice, props.selected && props.styles.visibilityChoiceSelected]} onPress={props.onPress} accessibilityRole="radio" accessibilityState={{ selected: props.selected }}>
      <Ionicons name={props.icon} size={18} color={props.selected ? props.theme.color.text.onPrimary : props.theme.color.text.foreground} />
      <Text style={[props.styles.visibilityText, props.selected && props.styles.visibilityTextSelected]}>{props.label}</Text>
    </Pressable>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    center: { alignItems: "center", justifyContent: "center", gap: t.spacing.sm, padding: t.spacing.xl },
    chooserIntro: { color: t.color.text.muted, ...t.typography.body, paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.lg, paddingBottom: t.spacing.md },
    chooserList: { marginHorizontal: t.spacing.lg, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.lg, overflow: "hidden" },
    choiceRow: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: t.spacing.md, padding: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    choiceIcon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: t.color.surface.element },
    choiceTitle: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    choiceDetail: { color: t.color.text.muted, ...t.typography.caption },
    pressed: { backgroundColor: t.color.surface.subtle },
    listContent: { paddingHorizontal: t.spacing.lg },
    directIntro: { color: t.color.text.muted, ...t.typography.body, paddingTop: t.spacing.md, paddingBottom: t.spacing.md },
    nameSection: { paddingTop: t.spacing.md, paddingBottom: t.spacing.lg, gap: t.spacing.sm },
    fieldLabel: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    nameInput: { minHeight: 54, color: t.color.text.foreground, ...t.typography.body, paddingHorizontal: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.element },
    visibilitySection: { gap: t.spacing.sm, paddingBottom: t.spacing.lg },
    segmented: { flexDirection: "row", gap: t.spacing.sm },
    visibilityChoice: { flex: 1, minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: t.spacing.sm, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.element },
    visibilityChoiceSelected: { backgroundColor: t.color.action.primaryBg, borderColor: t.color.action.primaryBg },
    visibilityText: { color: t.color.text.foreground, ...t.typography.label },
    visibilityTextSelected: { color: t.color.text.onPrimary },
    selectionHeader: { paddingBottom: t.spacing.sm },
    selectionTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.spacing.sm },
    sectionTitle: { flexShrink: 1, color: t.color.text.foreground, ...t.typography.subheading },
    selectionActionButton: { flexShrink: 0, paddingVertical: t.spacing.xs, paddingHorizontal: t.spacing.sm },
    selectionAction: { color: t.color.brand.accent, ...t.typography.caption },
    selectionCount: { color: t.color.text.muted, ...t.typography.caption, marginTop: t.spacing.xs },
    searchBox: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.element, marginBottom: t.spacing.sm },
    searchInput: { flex: 1, color: t.color.text.foreground, ...t.typography.body },
    selectedSummary: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.xs, paddingBottom: t.spacing.sm },
    selectedChip: { maxWidth: 150, flexDirection: "row", alignItems: "center", gap: t.spacing.xs, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.xs, borderRadius: t.radii.pill, backgroundColor: t.color.surface.element },
    selectedChipText: { flexShrink: 1, color: t.color.text.foreground, ...t.typography.caption },
    moreSelected: { color: t.color.text.muted, alignSelf: "center", ...t.typography.caption },
    errorBox: { padding: t.spacing.sm, marginBottom: t.spacing.sm, borderRadius: t.radii.sm, backgroundColor: t.color.surface.panel, borderWidth: 1, borderColor: t.color.status.error },
    errorText: { color: t.color.status.error, ...t.typography.caption },
    directoryRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    avatar: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: t.color.surface.element },
    rowBody: { flex: 1, gap: 2 },
    rowName: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    rowHandle: { color: t.color.text.muted, ...t.typography.caption },
    check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: t.color.border.default, alignItems: "center", justifyContent: "center" },
    checkSelected: { borderColor: t.color.brand.accent, backgroundColor: t.color.brand.accent },
    listState: { minHeight: 220, alignItems: "center", justifyContent: "center", gap: t.spacing.sm, padding: t.spacing.lg },
    stateTitle: { color: t.color.text.foreground, textAlign: "center", ...t.typography.subheading },
    stateBody: { color: t.color.text.muted, textAlign: "center", ...t.typography.body },
    retry: { paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.lg, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.pill },
    retryText: { color: t.color.text.foreground, ...t.typography.label },
    loadingMore: { margin: t.spacing.md },
    listTail: { height: t.spacing.md },
    fixedFooter: { paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.sm, paddingBottom: t.spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.color.border.default, backgroundColor: t.color.surface.background },
    createButton: { minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, backgroundColor: t.color.action.primaryBg },
    createButtonDisabled: { opacity: 0.45 },
    createButtonText: { color: t.color.text.onPrimary, ...t.typography.bodyStrong },
  });
}
