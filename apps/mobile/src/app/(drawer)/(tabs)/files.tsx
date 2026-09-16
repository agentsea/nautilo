import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar, useOpenAppDrawer } from "@/components/app-bar";
import { shouldRefreshFocusedArtifactList } from "@/features/artifacts/artifact-convergence";
import { canBrowseComputerFiles } from "@/features/artifacts/file-source-capabilities";
import { useArtifactSave } from "@/features/artifacts/use-artifact-save";
import { ArtifactSaveStatus } from "@/features/artifacts/artifact-save-status";
import { showArtifactExportMenu } from "@/features/artifacts/artifact-export-menu";
import { decideArtifactListFocus, effectiveArtifactRoom, resetArtifactListFocus, type ServerOwnedRoom } from "@/features/artifacts/artifact-list-focus";
import { useRemoteHosts } from "@/features/remote/remote-hosts";
import { classifyArtifactKind } from "@/lib/artifact-bytes";
import { getApiClient } from "@/lib/api";
import {
  formatRelativeTime,
  isConversationVisibleToViewer,
  isListableRoom,
  roomDisplayName,
  sortRoomsByRecency,
} from "@/lib/rooms";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import { useArtifactEvents } from "@/providers/artifact-events";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";
import type { AppTheme } from "@/theme/tokens";
import { ApiError, type ArtifactDto, type RemoteHost, type RemoteHostFileRootKind } from "@nautilo/api-client/browser";
import type { RoomSummaryDto } from "@nautilo/types";

export default function FilesScreen() {
  const fileSave = useArtifactSave();
  const openDrawer = useOpenAppDrawer();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { activeServer } = useServers();
  const { viewer } = useAuth();
  const canInvokeAgents = viewerCan(viewer, "invoke_agents");
  const platformCapabilities = usePlatformCapabilities();
  const computerFilesAvailable = canBrowseComputerFiles(platformCapabilities);
  const { subscribe: subscribeArtifactEvents } = useArtifactEvents();
  const remoteHosts = useRemoteHosts();
  const searchInputRef = useRef<TextInput>(null);
  const requestGeneration = useRef(0);
  const artifactFocusState = useRef(resetArtifactListFocus());
  const artifactScreenFocused = useRef(false);
  const eventRefreshQueued = useRef(false);
  const [rooms, setRooms] = useState<RoomSummaryDto[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<ServerOwnedRoom<RoomSummaryDto> | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [source, setSource] = useState<"nautilo" | "computer">("nautilo");
  const effectiveRoom = effectiveArtifactRoom(selectedRoom, activeServer?.id);
  const artifactScope = `${activeServer?.id ?? "no-server"}:${source}:${effectiveRoom?.id ?? "all-contexts"}`;

  const loadRooms = useCallback(async () => {
    if (!activeServer) {
      setRooms([]);
      setRoomsLoading(false);
      return;
    }
    setRoomsLoading(true);
    setRoomsError(null);
    try {
      const response = await getApiClient(activeServer.serverUrl).listRooms();
      setRooms(sortRoomsByRecency(response.rooms.filter((room) =>
        isListableRoom(room.kind)
        && isConversationVisibleToViewer(room, viewer?.userId, canInvokeAgents))));
    } catch (caught) {
      setRoomsError(messageOf(caught, "Could not load conversations."));
      setRooms([]);
    } finally {
      setRoomsLoading(false);
    }
  }, [activeServer, canInvokeAgents, viewer?.userId]);

  const loadArtifacts = useCallback(async (room: RoomSummaryDto | null, refresh = false) => {
    const generation = ++requestGeneration.current;
    if (!activeServer) return;
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const client = getApiClient(activeServer.serverUrl);
      // Membership and Artifact visibility are server-authoritative. A Room
      // scope narrows the readable aggregate; it does not require owning an
      // Agent or any particular Role name.
      const response = await client.listWorkspaceArtifacts(room ? { roomId: room.id } : undefined);
      if (generation === requestGeneration.current) setArtifacts(response.artifacts);
    } catch (caught) {
      if (generation === requestGeneration.current) {
        setArtifacts([]);
        setError(artifactLoadMessage(caught));
      }
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [activeServer]);

  useEffect(() => {
    requestGeneration.current += 1;
    setSelectedRoom(null);
    setArtifacts([]);
    setError(null);
    setQuery("");
    setDebouncedQuery("");
    artifactFocusState.current = resetArtifactListFocus();
    void loadRooms();
  }, [activeServer?.id, loadRooms]);

  // This is the sole initial artifact request and also refreshes after a viewer
  // mutation when the tab regains focus. A server/source/room scope change
  // first clears rows and blocks; only same-scope return focus is a refresh.
  useFocusEffect(useCallback(() => {
    artifactScreenFocused.current = true;
    const focus = decideArtifactListFocus(
      artifactFocusState.current,
      artifactScope,
      source === "nautilo" && activeServer !== undefined,
    );
    artifactFocusState.current = focus.next;
    if (focus.scopeChanged) {
      requestGeneration.current += 1;
      setArtifacts([]);
      setError(null);
    }
    if (focus.action !== "none") {
      void loadArtifacts(effectiveRoom, focus.action === "refresh");
    }
    return () => { artifactScreenFocused.current = false; };
  }, [activeServer, artifactScope, effectiveRoom, loadArtifacts, source]));

  useEffect(() => subscribeArtifactEvents((event) => {
    if (source !== "nautilo" || !artifactScreenFocused.current || !shouldRefreshFocusedArtifactList(event) || eventRefreshQueued.current) return;
    eventRefreshQueued.current = true;
    void Promise.resolve().then(() => {
      eventRefreshQueued.current = false;
      if (artifactScreenFocused.current) void loadArtifacts(effectiveRoom, true);
    });
  }), [effectiveRoom, loadArtifacts, source, subscribeArtifactEvents]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const selectRoom = (room: RoomSummaryDto): void => {
    if (!activeServer) return;
    setSelectedRoom({ serverId: activeServer.id, room });
    setPickerVisible(false);
    setQuery("");
  };
  const selectAllContexts = (): void => {
    setSelectedRoom(null);
    setPickerVisible(false);
    setQuery("");
  };
  const rows = useMemo(
    () => !debouncedQuery ? artifacts : artifacts.filter((artifact) =>
      [artifact.path, artifact.mimeType].some((value) => value.toLowerCase().includes(debouncedQuery))),
    [artifacts, debouncedQuery],
  );
  const searching = debouncedQuery.length > 0;

  return (
    <View style={styles.container}>
      <AppBar title="Files" onMenuPress={openDrawer} />
      {computerFilesAvailable ? <View style={styles.sourceSection}>
        <Text style={styles.sourceLabel}>Source</Text>
        <View style={styles.sourcePicker}>
          <Pressable
            style={[styles.sourceOption, source === "nautilo" && styles.sourceOptionSelected]}
            onPress={() => setSource("nautilo")}
            accessibilityRole="tab"
            accessibilityLabel="Nautilo files"
            accessibilityState={{ selected: source === "nautilo" }}
          >
            <Ionicons name="server-outline" size={18} color={source === "nautilo" ? t.color.text.onPrimary : t.color.text.foreground} />
            <Text style={source === "nautilo" ? styles.sourceOptionSelectedText : styles.sourceOptionText}>Nautilo</Text>
          </Pressable>
          <Pressable
            style={[styles.sourceOption, source === "computer" && styles.sourceOptionSelected]}
            onPress={() => setSource("computer")}
            accessibilityRole="tab"
            accessibilityLabel="Browse files on a paired computer"
            accessibilityHint="Choose a paired computer, then choose Workspace or Current Folder"
            accessibilityState={{ selected: source === "computer" }}
          >
            <Ionicons name="laptop-outline" size={18} color={source === "computer" ? t.color.text.onPrimary : t.color.text.foreground} />
            <Text style={source === "computer" ? styles.sourceOptionSelectedText : styles.sourceOptionText}>Computer</Text>
          </Pressable>
        </View>
        <Text style={styles.sourceHint}>
          Nautilo files are server artifacts. Computer files stay on the paired Mac.
        </Text>
      </View> : null}
      {computerFilesAvailable && source === "computer" ? (
        <ComputerSource
          hosts={remoteHosts.hosts}
          activeHostId={remoteHosts.activeHostId}
          setActiveHost={remoteHosts.setActiveHost}
          loading={remoteHosts.loading}
          error={remoteHosts.error}
          refresh={remoteHosts.refresh}
          styles={styles}
          theme={t}
        />
      ) : <>
      <View style={styles.contextSection}>
        <Pressable style={styles.contextChip} onPress={() => setPickerVisible(true)}
          accessibilityRole="button" accessibilityLabel="Choose files conversation">
          <Ionicons name="chatbubble-ellipses-outline" size={17} color={t.color.brand.accent} />
          <Text style={styles.contextText} numberOfLines={1}>
            {effectiveRoom ? roomDisplayName(effectiveRoom) : "All contexts"}
          </Text>
          <Ionicons name="chevron-down" size={17} color={t.color.text.muted} />
        </Pressable>
        <Text style={styles.contextHint}>Filter by a conversation when you need a narrower view.</Text>
      </View>
      <View style={styles.searchSection}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={20} color={t.color.text.muted} />
          <TextInput ref={searchInputRef} value={query} onChangeText={setQuery} style={styles.searchInput}
            placeholder="Search files" placeholderTextColor={t.color.text.dim} accessibilityLabel="Search files"
            returnKeyType="search" autoCorrect={false} />
          {query ? <Pressable onPress={() => { setQuery(""); searchInputRef.current?.focus(); }}
            style={styles.clearButton} accessibilityRole="button" accessibilityLabel="Clear file search">
            <Ionicons name="close-circle" size={20} color={t.color.text.muted} />
          </Pressable> : null}
        </View>
      </View>
      <ArtifactSaveStatus operation={fileSave} />
      {loading ? <View style={styles.stateWrap}>
        <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading files" />
        <Text style={styles.stateSub}>Checking conversation access…</Text>
      </View> : error ? <View style={styles.stateWrap}>
        <Ionicons name="shield-outline" size={34} color={t.color.text.muted} />
        <Text style={styles.stateTitle}>Cannot load files</Text><Text style={styles.stateSub}>{error}</Text>
        <Pressable style={styles.retryButton} onPress={() => void loadArtifacts(effectiveRoom)}
          accessibilityRole="button" accessibilityLabel="Retry loading files"><Text style={styles.retryText}>Retry</Text></Pressable>
      </View> : rows.length === 0 ? <State icon={searching ? "search-outline" : "folder-open-outline"}
        title={searching ? "No matching files" : "No files yet"}
        detail={searching ? "Try a filename, path, or file type." : effectiveRoom ? "Files shared in this conversation will appear here." : "Files you can access across your contexts will appear here."}
        styles={styles} theme={t} /> :
      <FlatList data={rows} keyExtractor={(item) => item.id} contentContainerStyle={styles.listBody}
        renderItem={({ item }) => <ArtifactRow artifact={item} roomId={effectiveRoom?.id} styles={styles} theme={t} onSave={() => {
          showArtifactExportMenu({
            filename: item.path.split("/").at(-1) ?? "File actions",
            mimeType: item.mimeType,
            onExport: (destination) => { void fileSave.save(item.id, destination); },
          });
        }} saveBusy={fileSave.busy} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void loadArtifacts(effectiveRoom, true)}
          tintColor={t.color.brand.accent} accessibilityLabel="Refresh files" />} />}
      </>}

      <Modal visible={pickerVisible} transparent animationType="slide"
        onRequestClose={() => setPickerVisible(false)} statusBarTranslucent>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setPickerVisible(false)}
            accessibilityRole="button" accessibilityLabel="Dismiss conversation picker" />
          <View style={[styles.pickerPanel, { paddingBottom: Math.max(Number(insets.bottom), t.spacing.md) }]}>
            <View style={styles.pickerHandle} />
            <View style={styles.pickerHeader}><Text style={styles.pickerTitle}>Filter files</Text>
              <Text style={styles.pickerSub}>All contexts is the complete library you can access.</Text></View>
            {roomsLoading ? <View style={styles.pickerState}><ActivityIndicator color={t.color.brand.accent} /></View> :
            roomsError ? <View style={styles.pickerState}><Text style={styles.stateSub}>{roomsError}</Text>
              <Pressable style={styles.retryButton} onPress={() => void loadRooms()}><Text style={styles.retryText}>Retry</Text></Pressable>
            </View> : <FlatList data={rooms} keyExtractor={(item) => item.id} style={styles.roomList}
              ListHeaderComponent={<Pressable style={[styles.roomRow, !effectiveRoom && styles.roomRowSelected]} onPress={selectAllContexts}
                accessibilityRole="button" accessibilityLabel="Show files from all contexts" accessibilityState={{ selected: !effectiveRoom }}>
                <Ionicons name="layers-outline" size={19} color={t.color.brand.accent} />
                <Text style={styles.roomName}>All contexts</Text>
                {!effectiveRoom ? <Ionicons name="checkmark" size={19} color={t.color.brand.accent} /> : null}
              </Pressable>}
              ListEmptyComponent={<View style={styles.pickerState}><Text style={styles.stateSub}>No conversations are available to filter by.</Text></View>}
              renderItem={({ item }) => {
              const selected = item.id === effectiveRoom?.id;
              return <Pressable style={[styles.roomRow, selected && styles.roomRowSelected]} onPress={() => selectRoom(item)}
                accessibilityRole="button" accessibilityLabel={`Choose conversation ${roomDisplayName(item)}`}
                accessibilityState={{ selected }}>
                <Ionicons name="chatbubble-outline" size={19} color={t.color.brand.accent} />
                <Text style={styles.roomName} numberOfLines={1}>{roomDisplayName(item)}</Text>
                {selected ? <Ionicons name="checkmark" size={19} color={t.color.brand.accent} /> : null}
              </Pressable>;
            }} />}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ComputerSource({ hosts, activeHostId, setActiveHost, loading, error, refresh, styles, theme }: {
  hosts: readonly RemoteHost[];
  activeHostId: string | null;
  setActiveHost: (remoteHostId: string) => Promise<void>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const activeHost = hosts.find((host) => host.remoteHostId === activeHostId) ?? null;
  return <FlatList
    data={activeHost ? [activeHost] : []}
    keyExtractor={(host) => host.remoteHostId}
    contentContainerStyle={styles.computerList}
    refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()}
      tintColor={theme.color.brand.accent} accessibilityLabel="Refresh paired computers" />}
    ListHeaderComponent={<>
      <View style={styles.computerHeader}>
        <View style={styles.activeComputerHeading}>
          <View style={styles.computerNameWrap}>
            <Text style={styles.sourceLabel}>Active computer</Text>
            <Text style={styles.stateTitle}>{activeHost?.label ?? (hosts.length > 0 ? "Choose a computer" : "No paired computer")}</Text>
            {activeHost ? <Text style={[styles.computerStatus, { color: activeHost.readiness === "compatible_online" ? theme.color.status.success : theme.color.text.muted }]}>
              {activeHost.readiness === "compatible_online" ? "Online" : "Offline"}
            </Text> : null}
          </View>
          {hosts.length > 1 ? <Pressable style={styles.changeComputerButton} onPress={() => setPickerVisible(true)}
            accessibilityRole="button" accessibilityLabel="Change active computer">
            <Text style={styles.changeComputerText}>Change</Text>
          </Pressable> : null}
        </View>
        <Text style={styles.computerIntro}>Browse this computer’s Workspace or Current Folder. Changing it here affects Files only.</Text>
        {error ? <Text style={styles.computerError} accessibilityRole="alert">{error}</Text> : null}
      </View>
      <Modal visible={pickerVisible} transparent animationType="slide" onRequestClose={() => setPickerVisible(false)} statusBarTranslucent>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setPickerVisible(false)} accessibilityRole="button" accessibilityLabel="Cancel computer selection" />
          <View style={styles.pickerPanel}>
            <View style={styles.pickerHandle} />
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Choose active computer</Text>
              <Text style={styles.pickerSub}>This choice controls only the Computer source in Files.</Text>
            </View>
            <FlatList data={hosts} keyExtractor={(host) => host.remoteHostId} renderItem={({ item }) => {
              const selected = item.remoteHostId === activeHostId;
              return <Pressable style={[styles.roomRow, selected && styles.roomRowSelected]} onPress={() => {
                void setActiveHost(item.remoteHostId).then(() => setPickerVisible(false));
              }} accessibilityRole="button" accessibilityLabel={`Use ${item.label ?? "this computer"} in Files`} accessibilityState={{ selected }}>
                <Ionicons name="laptop-outline" size={19} color={theme.color.brand.accent} />
                <View style={styles.computerNameWrap}>
                  <Text style={styles.roomName} numberOfLines={1}>{item.label ?? "Paired computer"}</Text>
                  <Text style={styles.computerStatus}>{item.readiness === "compatible_online" ? "Online" : "Offline"}</Text>
                </View>
                {selected ? <Ionicons name="checkmark" size={19} color={theme.color.brand.accent} /> : null}
              </Pressable>;
            }} />
          </View>
        </View>
      </Modal>
    </>}
    ListEmptyComponent={<View style={styles.stateWrap}>
      {loading ? <ActivityIndicator color={theme.color.brand.accent} /> : <Ionicons name="laptop-outline" size={34} color={theme.color.text.muted} />}
      <Text style={styles.stateTitle}>{loading ? "Checking computers…" : hosts.length > 1 ? "Choose an active computer" : "No paired computers"}</Text>
      {!loading ? <Text style={styles.stateSub}>{hosts.length > 1 ? "Choose which paired computer to browse in Files." : "Pair a computer before browsing files that stay on that Mac."}</Text> : null}
      {!loading && hosts.length > 1 ? <Pressable style={styles.retryButton} onPress={() => setPickerVisible(true)}
        accessibilityRole="button" accessibilityLabel="Choose active computer"><Text style={styles.retryText}>Choose computer</Text></Pressable> : null}
      {!loading && hosts.length === 0 ? <Pressable style={styles.retryButton} onPress={() => router.push("/(drawer)/computers")}
        accessibilityRole="button" accessibilityLabel="Pair or manage computers"><Text style={styles.retryText}>Pair or manage computers</Text></Pressable> : null}
    </View>}
    renderItem={({ item }) => <ComputerCard host={item} styles={styles} theme={theme} />}
    ListFooterComponent={hosts.length > 0 ? <Pressable style={styles.manageComputers} onPress={() => router.push("/(drawer)/computers")}
      accessibilityRole="button" accessibilityLabel="Pair or manage computers"><Text style={styles.retryText}>Pair or manage computers</Text></Pressable> : null}
  />;
}

function ComputerCard({ host, styles, theme }: { host: RemoteHost; styles: ReturnType<typeof createStyles>; theme: AppTheme }) {
  const online = host.readiness === "compatible_online";
  const openRoot = (rootKind: RemoteHostFileRootKind): void => {
    if (!online) return;
    router.push({
      pathname: "/files/computer/[remoteHostId]/[rootKind]",
      params: { remoteHostId: host.remoteHostId, rootKind },
    });
  };
  const chooseCurrentFolder = (): void => {
    if (!online) return;
    router.push({
      pathname: "/files/computer/[remoteHostId]/[rootKind]",
      params: { remoteHostId: host.remoteHostId, rootKind: "paired_filesystem", mode: "choose" },
    });
  };
  return <View style={styles.computerCard}>
    <RootButton title="Workspace" detail="Nautilo’s workspace on this Mac" enabled={online} onPress={() => openRoot("workspace")} styles={styles} theme={theme} />
    <RootButton title="Current Folder" detail="The project folder selected on this Mac" enabled={online} onPress={() => openRoot("current_folder")} styles={styles} theme={theme} />
    <RootButton title="Change Current Folder" detail="Browse this Mac and choose the folder to use" enabled={online} onPress={chooseCurrentFolder} styles={styles} theme={theme} />
    {!online ? <Text style={styles.offlineHint}>Reconnect Nautilo Desktop on this Mac to browse its files.</Text> : null}
  </View>;
}

function RootButton({ title, detail, enabled, onPress, styles, theme }: { title: string; detail: string; enabled: boolean; onPress: () => void; styles: ReturnType<typeof createStyles>; theme: AppTheme }) {
  return <Pressable style={[styles.rootButton, !enabled && styles.disabled]} disabled={!enabled} onPress={onPress}
    accessibilityRole="button" accessibilityLabel={`Browse ${title}`} accessibilityHint={detail} accessibilityState={{ disabled: !enabled }}>
    <View style={styles.rootCopy}><Text style={styles.rootName}>{title}</Text><Text style={styles.rootDetail}>{detail}</Text></View>
    <Ionicons name="chevron-forward" size={19} color={theme.color.text.muted} />
  </Pressable>;
}

function ArtifactRow({ artifact, roomId, styles, theme, onSave, saveBusy }: {
  artifact: ArtifactDto;
  roomId?: string;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
  onSave: () => void;
  saveBusy: boolean;
}) {
  const kind = classifyArtifactKind(artifact.path, artifact.mimeType);
  const name = artifact.path.split("/").filter(Boolean).at(-1) ?? artifact.path;
  const kindLabel = kind === "unsupported" ? "File" : `${kind[0].toUpperCase()}${kind.slice(1)}`;
  return <Pressable style={styles.row} onPress={() => router.push({
    pathname: "/files/artifact/[id]",
    params: roomId ? { id: artifact.id, roomId } : { id: artifact.id },
  })} accessibilityRole="button" accessibilityLabel={`Open ${name}, ${artifact.mimeType}, ${formatBytes(artifact.size)}, ${kindLabel} viewer`}>
    <View style={styles.rowIcon}><Ionicons name={iconForKind(kind)} size={21} color={theme.color.brand.accent} /></View>
    <View style={styles.rowBody}><View style={styles.rowHeading}><Text style={styles.rowName} numberOfLines={1}>{name}</Text>
      <Text style={styles.rowTime}>{formatRelativeTime(artifact.updatedAt) ?? ""}</Text></View>
      <Text style={styles.rowMeta} numberOfLines={1}>{artifact.mimeType} · {formatBytes(artifact.size)}</Text>
      {artifact.path !== name ? <Text style={styles.rowPath} numberOfLines={1}>{artifact.path}</Text> : null}</View>
    <View style={styles.viewerBadge}><Text style={styles.viewerBadgeText}>{kindLabel}</Text></View>
    <Pressable onPress={(event) => { event.stopPropagation(); onSave(); }} disabled={saveBusy}
      accessibilityRole="button" accessibilityLabel={`File actions for ${name}`} accessibilityState={{ disabled: saveBusy }}
      style={styles.fileActionsButton}><Ionicons name="ellipsis-horizontal" size={22} color={theme.color.brand.accent} /></Pressable>
  </Pressable>;
}

function State({ icon, title, detail, styles, theme }: { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string; styles: ReturnType<typeof createStyles>; theme: AppTheme }) {
  return <View style={styles.stateWrap}><Ionicons name={icon} size={34} color={theme.color.text.muted} />
    <Text style={styles.stateTitle}>{title}</Text><Text style={styles.stateSub}>{detail}</Text></View>;
}

function iconForKind(kind: ReturnType<typeof classifyArtifactKind>): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case "image": return "image-outline";
    case "video": return "videocam-outline";
    case "markdown": return "document-text-outline";
    case "pdf": return "document-text-outline";
    case "text": return "document-outline";
    default: return "document-attach-outline";
  }
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}
function artifactLoadMessage(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.status === 401) return "Session expired — sign in again.";
    if (caught.status === 403) return "You don’t have permission to view files in this room.";
    if (caught.status === 404) return "You’re not a member of this room.";
    if (caught.status === 501) return "Files are not available in this context.";
  }
  const message = messageOf(caught, "Could not verify this conversation.");
  if (message.includes("404") || message.includes("Not found")) return "You’re not a member of this room.";
  return message;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    sourceSection: { paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.md, gap: t.spacing.xs },
    sourceLabel: { color: t.color.text.muted, ...t.typography.caption, textTransform: "uppercase", letterSpacing: 0.6 },
    sourcePicker: { flexDirection: "row", gap: t.spacing.sm },
    sourceOption: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.color.border.default, backgroundColor: t.color.surface.element },
    sourceOptionSelected: { borderColor: t.color.action.primaryBg, backgroundColor: t.color.action.primaryBg },
    sourceOptionText: { color: t.color.text.foreground, ...t.typography.label },
    sourceOptionSelectedText: { color: t.color.text.onPrimary, ...t.typography.label },
    sourceHint: { color: t.color.text.dim, ...t.typography.caption },
    contextSection: { paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.md, paddingBottom: t.spacing.sm, gap: t.spacing.xs },
    contextChip: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default, backgroundColor: t.color.surface.element },
    contextText: { flex: 1, color: t.color.text.foreground, ...t.typography.label },
    contextHint: { color: t.color.text.dim, ...t.typography.caption },
    searchSection: { paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    searchBox: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.element, borderWidth: 1, borderColor: t.color.border.default },
    searchInput: { flex: 1, minWidth: 0, paddingVertical: t.spacing.sm, color: t.color.text.foreground, ...t.typography.body },
    clearButton: { padding: t.spacing.xs },
    fileActionsButton: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
    listBody: { paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl },
    row: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingVertical: t.spacing.md },
    rowIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: t.color.surface.element },
    rowBody: { flex: 1, minWidth: 0, gap: t.spacing.xs / 2 },
    rowHeading: { flexDirection: "row", justifyContent: "space-between", gap: t.spacing.sm },
    rowName: { flex: 1, color: t.color.text.foreground, ...t.typography.label },
    rowTime: { color: t.color.text.dim, ...t.typography.caption },
    rowMeta: { color: t.color.text.muted, ...t.typography.caption },
    rowPath: { color: t.color.text.dim, ...t.typography.caption },
    viewerBadge: { paddingVertical: t.spacing.xs, paddingHorizontal: t.spacing.sm, borderRadius: t.radii.pill, backgroundColor: t.color.surface.element },
    viewerBadgeText: { color: t.color.text.muted, ...t.typography.caption },
    separator: { height: StyleSheet.hairlineWidth, marginLeft: 52, backgroundColor: t.color.border.default },
    stateWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.sm, padding: t.spacing.xl },
    stateTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    stateSub: { color: t.color.text.muted, textAlign: "center", ...t.typography.body },
    retryButton: { marginTop: t.spacing.sm, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default },
    retryText: { color: t.color.text.foreground, ...t.typography.label },
    pickerHeader: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, gap: t.spacing.xs },
    pickerTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    pickerSub: { color: t.color.text.muted, ...t.typography.caption },
    pickerState: { alignItems: "center", gap: t.spacing.sm, padding: t.spacing.xl },
    modalRoot: { flex: 1, justifyContent: "flex-end" },
    modalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0, 0, 0, 0.48)" },
    pickerPanel: {
      maxHeight: "72%",
      borderTopLeftRadius: t.radii.lg,
      borderTopRightRadius: t.radii.lg,
      backgroundColor: t.color.surface.background,
      overflow: "hidden",
    },
    pickerHandle: {
      width: 36,
      height: 4,
      borderRadius: t.radii.pill,
      alignSelf: "center",
      marginTop: t.spacing.sm,
      backgroundColor: t.color.border.default,
    },
    roomList: { flexGrow: 0 },
    roomRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, minHeight: 52, paddingHorizontal: t.spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.color.border.default },
    roomRowSelected: { backgroundColor: t.color.surface.subtle },
    roomName: { flex: 1, color: t.color.text.foreground, ...t.typography.body },
    computerList: { flexGrow: 1, paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xxl, gap: t.spacing.md },
    computerHeader: { gap: t.spacing.xs, paddingTop: t.spacing.lg },
    activeComputerHeading: { flexDirection: "row", alignItems: "center", gap: t.spacing.md },
    changeComputerButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.md },
    changeComputerText: { color: t.color.brand.accent, ...t.typography.label },
    computerIntro: { color: t.color.text.muted, ...t.typography.body },
    computerError: { color: t.color.status.error, ...t.typography.body },
    computerCard: { gap: t.spacing.sm, padding: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.element },
    computerNameWrap: { flex: 1, gap: t.spacing.xs / 2 },
    computerStatus: { ...t.typography.caption },
    rootButton: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, backgroundColor: t.color.surface.background },
    rootCopy: { flex: 1, gap: t.spacing.xs / 2 },
    rootName: { color: t.color.text.foreground, ...t.typography.label },
    rootDetail: { color: t.color.text.muted, ...t.typography.caption },
    offlineHint: { color: t.color.text.muted, ...t.typography.caption },
    manageComputers: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.lg },
    disabled: { opacity: 0.5 },
  });
}
