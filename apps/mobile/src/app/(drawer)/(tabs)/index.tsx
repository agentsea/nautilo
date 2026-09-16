// D369 Phase 5 — the Chats tab. Replaces the Phase-1 placeholder with the
// real conversation list: server switcher, persistent search,
// All/Chats/Group Chats/Archive
// filter chips, WhatsApp-shaped rows (name, last-activity relative time,
// unread dot). Live `room.notification.changed` WS events patch the matching
// top-level row's own unread count in place; a delta for an unknown room
// triggers a single
// refetch (mirrors workbench's room-navigation-context).
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
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
import { AppBar, useOpenAppDrawer } from "@/components/app-bar";
import { ChatManagementSheet } from "@/components/chat-management-sheet";
import { ChatRenameSheet } from "@/components/chat-rename-sheet";
import {
  publishRoomProjection,
  subscribeRoomProjection,
  type RoomProjectionScope,
} from "@/features/chat-management/chat-management-projection";
import {
  createChatSearchController,
  type ChatSearchController,
  type ChatSearchScope,
} from "@/features/chat-search/chat-search-controller";
import { decodeChatSearchSnippet } from "@/features/chat-search/chat-search-presentation";
import { getApiClient } from "@/lib/api";
import { INVITE_COMPLETION_NOTICE, INVITE_COMPLETION_NOTICE_PARAM } from "@/features/invite-redemption/invite-landing";
import { applyNotificationUnread } from "@/lib/notification-unread";
import {
  shouldRefreshRoomCatalogueForEvent,
  shouldRefreshRoomCatalogueOnRecovery,
} from "@/lib/room-catalogue-refresh";
import {
  conversationCatalogueKind,
  conversationCatalogueLabel,
  conversationMatchesQuery,
  formatRelativeTime,
  isConversationVisibleToViewer,
  isGroupChatConversation,
  isListableRoom,
  roomDisplayName,
  sortRoomsByRecency,
} from "@/lib/rooms";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useAuth } from "@/providers/auth";
import { useRealtime } from "@/providers/realtime";
import { useNotificationState } from "@/providers/notification-state";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { ChatSearchMessageHit, RoomDetailResponse, RoomSummaryDto, ServerEvent } from "@nautilo/types";

type PrimaryFilter = "all" | "chats" | "group-chats" | "archive";
type ChatFilter = "people" | "genies";
type CatalogueRow =
  | { kind: "conversation"; key: string; room: RoomSummaryDto }
  | { kind: "message-heading"; key: "message-heading" }
  | { kind: "message"; key: string; hit: ChatSearchMessageHit };
type RoomMutationTarget = {
  room: RoomSummaryDto;
  scope: RoomProjectionScope;
  serverUrl: string;
  canManage: boolean;
  canLeave: boolean;
  isArchived: boolean;
};
const INVITE_COMPLETION_NOTICE_DURATION_MS = 5_000;

export default function ChatsScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { activeServer } = useServers();
  const { status: authStatus, viewer } = useAuth();
  const canInvokeAgents = viewerCan(viewer, "invoke_agents");
  const params = useLocalSearchParams<{ inviteNotice?: string | string[] }>();
  const inviteCompletionNotice = params.inviteNotice === INVITE_COMPLETION_NOTICE_PARAM;
  const { recoveryRevision, subscribe } = useRealtime();
  const { activeSnapshot, roomAttention } = useNotificationState();
  const [rooms, setRooms] = useState<RoomSummaryDto[]>([]);
  const [archivedRooms, setArchivedRooms] = useState<RoomSummaryDto[]>([]);
  const [manageableRoomIds, setManageableRoomIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<PrimaryFilter>("all");
  const [chatFilter, setChatFilter] = useState<ChatFilter>("genies");
  const [searchQuery, setSearchQuery] = useState("");
  const [managementRoom, setManagementRoom] = useState<RoomMutationTarget | null>(null);
  const [renameRoom, setRenameRoom] = useState<RoomMutationTarget | null>(null);
  const viewerEpochRef = useRef({ viewer, epoch: 0 });
  if (viewerEpochRef.current.viewer !== viewer) {
    viewerEpochRef.current = { viewer, epoch: viewerEpochRef.current.epoch + 1 };
  }
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const viewerActorIdRef = useRef(viewer?.actorId ?? null);
  viewerActorIdRef.current = viewer?.actorId ?? null;
  const searchControllerRef = useRef<ChatSearchController | null>(null);
  if (!searchControllerRef.current) {
    searchControllerRef.current = createChatSearchController({
      fetchPage: async (scope, options, signal) => {
        const server = activeServerRef.current;
        if (!server || server.id !== scope.serverId) {
          throw new Error("The active server changed.");
        }
        return getApiClient(server.serverUrl).searchChats(options, { signal });
      },
    });
  }
  const searchController = searchControllerRef.current;
  const [searchState, setSearchState] = useState(() => searchController.getSnapshot());
  const openDrawer = useOpenAppDrawer();
  const [completionNotice, setCompletionNotice] = useState(inviteCompletionNotice);
  const consumedInviteNoticeRef = useRef(false);
  // Ref mirror of rooms so the WS handler can read the latest without being
  // a dependency of the subscribe effect (keeps the subscription stable for
  // the screen's lifetime and avoids re-subscribing on every list update).
  const roomsRef = useRef<RoomSummaryDto[]>(rooms);
  roomsRef.current = rooms;
  const archivedRoomsRef = useRef<RoomSummaryDto[]>(archivedRooms);
  archivedRoomsRef.current = archivedRooms;
  const catalogueRequestRef = useRef(0);

  useEffect(
    () => searchController.subscribe(() => setSearchState(searchController.getSnapshot())),
    [searchController],
  );
  useEffect(() => () => searchController.dispose(), [searchController]);

  const searchScope = useMemo<ChatSearchScope | null>(
    () => activeServer && authStatus === "signed-in" && viewer
      ? {
          serverId: activeServer.id,
          viewerActorId: viewer.actorId,
          viewerEpoch: viewerEpochRef.current.epoch,
        }
      : null,
    [activeServer, authStatus, viewer],
  );
  const catalogueProjectionScope = useMemo<RoomProjectionScope | null>(
    () => activeServer && viewer?.actorId
      ? { serverId: activeServer.id, viewerActorId: viewer.actorId }
      : null,
    [activeServer?.id, viewer?.actorId],
  );
  useEffect(() => searchController.setScope(searchScope), [searchController, searchScope]);

  // A Room selected under one Server/viewer must never inherit another
  // identity's URL or mutation authority while its sheet is still mounted.
  useEffect(() => {
    setManagementRoom(null);
    setRenameRoom(null);
  }, [activeServer?.id, viewer?.actorId]);

  const loadRooms = useCallback(async () => {
    const requestId = ++catalogueRequestRef.current;
    if (!activeServer) {
      setRooms([]);
      setArchivedRooms([]);
      setManageableRoomIds(new Set());
      setLoading(false);
      return;
    }
    const serverId = activeServer.id;
    const viewerActorId = viewer?.actorId ?? null;
    setLoading(true);
    setError(null);
    // Never retain a prior identity's archive/management capabilities while
    // the bounded catalogue refresh for the new viewer is in flight.
    setArchivedRooms([]);
    setManageableRoomIds(new Set());
    try {
      const client = getApiClient(activeServer.serverUrl);
      const [res, manageable, allManageable] = await Promise.all([
        client.listRooms(),
        client.listManageableRooms(),
        client.listManageableRooms({ includeArchived: true }),
      ]);
      if (
        requestId !== catalogueRequestRef.current ||
        activeServerRef.current?.id !== serverId ||
        viewerActorIdRef.current !== viewerActorId
      ) return;
      setRooms(res.rooms.filter((r) => isListableRoom(r.kind)));
      const activeManageable = new Set(manageable.rooms.map((room) => room.id));
      setManageableRoomIds(new Set(allManageable.rooms.map((room) => room.id)));
      setArchivedRooms(allManageable.rooms.filter((room) =>
        !activeManageable.has(room.id) &&
        isListableRoom(room.kind) &&
        viewerActorId !== null &&
        (room.roster?.some((member) => member.actorId === viewerActorId) ?? false),
      ));
    } catch (e) {
      if (requestId === catalogueRequestRef.current) {
        setError(e instanceof Error ? e.message : "Could not load conversations.");
      }
    } finally {
      if (requestId === catalogueRequestRef.current) setLoading(false);
    }
  }, [activeServer, viewer?.actorId]);

  useFocusEffect(useCallback(() => {
    void loadRooms();
  }, [loadRooms]));

  const previousRecoveryRevisionRef = useRef(recoveryRevision);
  useEffect(() => {
    const previous = previousRecoveryRevisionRef.current;
    previousRecoveryRevisionRef.current = recoveryRevision;
    if (shouldRefreshRoomCatalogueOnRecovery(previous, recoveryRevision)) {
      void loadRooms();
    }
  }, [recoveryRevision, loadRooms]);

  useEffect(() => {
    if (!canInvokeAgents && chatFilter === "genies") setChatFilter("people");
  }, [canInvokeAgents, chatFilter]);

  useEffect(() => {
    if (!inviteCompletionNotice || consumedInviteNoticeRef.current) return;
    consumedInviteNoticeRef.current = true;
    setCompletionNotice(true);
    router.setParams({ inviteNotice: undefined });
  }, [inviteCompletionNotice]);

  useEffect(() => {
    if (!completionNotice) return;
    const timer = setTimeout(() => setCompletionNotice(false), INVITE_COMPLETION_NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [completionNotice]);

  // Live unread deltas. The workbench pattern: if the delta is for a known
  // room, patch its unreadCount in place; if it's for an unknown room with a
  // positive count, refetch once so the new conversation appears.
  useEffect(() => {
    const handler = (event: ServerEvent): void => {
      if (shouldRefreshRoomCatalogueForEvent(event)) {
        void loadRooms();
        return;
      }
      if (
        event.type !== "room.notification.changed"
      ) {
        return;
      }
      const projected = applyNotificationUnread(roomsRef.current, event);
      if (projected.kind === "unknown-positive") {
        void loadRooms();
        return;
      }
      if (projected.kind === "patched") {
        setRooms((current) => applyNotificationUnread(current, event).rooms);
      }
    };
    return subscribe(handler);
  }, [subscribe, loadRooms]);

  const visibleRooms = useMemo(
    () => rooms.filter((room) =>
      isConversationVisibleToViewer(room, viewer?.userId, canInvokeAgents)),
    [canInvokeAgents, rooms, viewer?.userId],
  );
  const sortedRooms = useMemo(() => sortRoomsByRecency(visibleRooms), [visibleRooms]);
  const sortedArchivedRooms = useMemo(() => sortRoomsByRecency(archivedRooms), [archivedRooms]);

  const categoryRooms = useMemo(() => {
    if (filter === "archive") return sortedArchivedRooms;
    return filter === "all" ? sortedRooms : sortedRooms.filter((room) => {
      const category = conversationCatalogueKind(room, viewer?.userId);
      if (filter === "group-chats") return isGroupChatConversation(room, viewer?.userId);
      if (isGroupChatConversation(room, viewer?.userId)) return false;
      if (chatFilter === "people") return category === "person";
      return category === "genie";
    });
  }, [sortedRooms, sortedArchivedRooms, filter, chatFilter, viewer?.userId]);

  const filteredRooms = useMemo(
    () => categoryRooms.filter((room) => conversationMatchesQuery(room, searchQuery)),
    [categoryRooms, searchQuery],
  );
  const categoryRoomIds = useMemo(() => new Set(categoryRooms.map((room) => room.id)), [categoryRooms]);
  const filteredMessageHits = useMemo(
    () => searchQuery && filter !== "archive"
      ? searchState.messages.filter((hit) => categoryRoomIds.has(hit.parentRoomId ?? hit.roomId))
      : [],
    [categoryRoomIds, filter, searchQuery, searchState.messages],
  );
  const catalogueRows = useMemo<CatalogueRow[]>(() => {
    const next: CatalogueRow[] = filteredRooms.map((room) => ({
      kind: "conversation",
      key: `conversation:${room.id}`,
      room,
    }));
    if (filteredMessageHits.length > 0) {
      next.push({ kind: "message-heading", key: "message-heading" });
      for (const hit of filteredMessageHits) {
        next.push({ kind: "message", key: `message:${hit.roomId}:${hit.messageId}`, hit });
      }
    }
    return next;
  }, [filteredMessageHits, filteredRooms]);

  const applyRenamedRoom = useCallback((detail: RoomDetailResponse) => {
    const label = detail.label;
    const patch = (current: RoomSummaryDto[]) => current.map((room) =>
      room.id === detail.id ? { ...room, label } : room,
    );
    setRooms(patch);
    setArchivedRooms(patch);
    searchController.applyRoomProjection({ roomId: detail.id, label });
  }, [searchController]);

  const applyArchiveChange = useCallback((roomId: string, archived: boolean) => {
    const movedRoom = archived
      ? roomsRef.current.find((candidate) => candidate.id === roomId)
      : archivedRoomsRef.current.find((candidate) => candidate.id === roomId);
    if (archived) {
      setRooms((current) => current.filter((candidate) => candidate.id !== roomId));
      if (movedRoom) {
        setArchivedRooms((current) => [movedRoom, ...current.filter((candidate) => candidate.id !== roomId)]);
      }
      searchController.applyRoomProjection({ roomId, removed: true });
      return;
    }
    setArchivedRooms((current) => current.filter((candidate) => candidate.id !== roomId));
    if (movedRoom) setRooms((current) => [movedRoom, ...current.filter((candidate) => candidate.id !== roomId)]);
  }, [searchController]);

  const removeRoomProjection = useCallback((roomId: string) => {
    setRooms((current) => current.filter((room) => room.id !== roomId));
    setArchivedRooms((current) => current.filter((room) => room.id !== roomId));
    setManageableRoomIds((current) => {
      const next = new Set(current);
      next.delete(roomId);
      return next;
    });
    searchController.applyRoomProjection({ roomId, removed: true });
  }, [searchController]);

  useEffect(() => {
    if (!catalogueProjectionScope) return;
    return subscribeRoomProjection(catalogueProjectionScope, (change) => {
    if (change.kind === "renamed") applyRenamedRoom(change.room);
    else if (change.kind === "archived") applyArchiveChange(change.roomId, change.archived);
    else removeRoomProjection(change.roomId);
    });
  }, [applyArchiveChange, applyRenamedRoom, catalogueProjectionScope, removeRoomProjection]);

  const renderConversation = (item: RoomSummaryDto) => {
    const time = formatRelativeTime(item.lastMessageAt);
    const category = conversationCatalogueKind(item, viewer?.userId);
    const attention = roomAttention(item.id, roomDisplayName(item));
    // Room summaries are already canonical server data. Until the richer
    // notification snapshot hydrates, retain only their ambient unread dot;
    // never infer an important count that the summary does not carry.
    const showAmbientFallback = activeSnapshot === null && (item.unreadCount ?? 0) > 0;
    const isArchived = filter === "archive";
    const canManage = manageableRoomIds.has(item.id);
    const canLeave = (category === "group" || category === "room") &&
      (item.roster?.some((member) => member.actorId === viewer?.actorId) ?? false);
    return (
      <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.rowPressTarget, pressed && styles.rowPressed]}
        onPress={() => router.push(`/chat/${item.id}`)}
        accessibilityRole="button"
        accessibilityLabel={attention?.accessibilityLabel ?? roomDisplayName(item)}
      >
        <View style={styles.avatar}>
          <Ionicons
            name={iconForCategory(category)}
            size={22}
            color={t.color.text.foreground}
          />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.rowName} numberOfLines={1}>
              {roomDisplayName(item)}
            </Text>
            {time ? <Text style={styles.rowTime}>{time}</Text> : null}
          </View>
          <View style={styles.rowBottom}>
            <Text style={styles.rowSub} numberOfLines={1}>
              {conversationCatalogueLabel(item, viewer?.userId)}
              {typeof item.memberCount === "number" ? ` · ${item.memberCount}` : ""}
            </Text>
            {attention?.hasUnread || showAmbientFallback ? (
              attention?.importantText ? (
                <View accessible={false} style={styles.importantBadge}>
                  <Text style={styles.importantBadgeText}>{attention.importantText}</Text>
                </View>
              ) : <View accessible={false} style={styles.unreadDot} />
            ) : null}
          </View>
        </View>
      </Pressable>
      {canManage || canLeave ? (
        <Pressable
          style={({ pressed }) => [styles.managementButton, pressed && styles.managementButtonPressed]}
          onPress={() => {
            if (!activeServer || !catalogueProjectionScope) return;
            setManagementRoom({
              room: item,
              scope: catalogueProjectionScope,
              serverUrl: activeServer.serverUrl,
              canManage,
              canLeave,
              isArchived,
            });
          }}
          accessibilityRole="button"
          accessibilityLabel={`More actions for ${roomDisplayName(item)}`}>
          <Ionicons name="ellipsis-horizontal" size={20} color={t.color.text.muted} />
        </Pressable>
      ) : null}
      {isArchived ? <Text style={styles.archivedLabel}>Archived</Text> : null}
      </View>
    );
  };

  const renderItem = ({ item }: { item: CatalogueRow }) => {
    if (item.kind === "conversation") return renderConversation(item.room);
    if (item.kind === "message-heading") {
      return (
        <View style={styles.searchSectionHeading}>
          <Text style={styles.searchSectionTitle}>MATCHING MESSAGES</Text>
          <Text style={styles.searchSectionDetail}>Text inside the selected conversations</Text>
        </View>
      );
    }
    const breadcrumb = item.hit.parentRoomLabel
      ? `${item.hit.parentRoomLabel} › ${item.hit.roomLabel || "Thread"}`
      : item.hit.roomLabel;
    return (
      <Pressable
        style={({ pressed }) => [styles.messageResult, pressed && styles.rowPressed]}
        onPress={() => {
          const key = `message:${item.hit.roomId}:${item.hit.messageId}`;
          if (!searchController.claimNavigation(key)) return;
          router.push({
            pathname: "/chat/[roomId]",
            params: { roomId: item.hit.roomId, targetMessageId: item.hit.messageId },
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={`Open matching message in ${breadcrumb}`}
      >
        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>{breadcrumb}</Text>
          <Text style={styles.messageSnippet} numberOfLines={3}>
            {decodeChatSearchSnippet(item.hit.snippet)}
          </Text>
          <Text style={styles.rowTime}>{formatRelativeTime(item.hit.createdAt)}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={t.color.text.muted} />
      </Pressable>
    );
  };
  return (
    <View style={styles.container}>
      <AppBar onMenuPress={openDrawer} />

      {completionNotice ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.completionNotice}>
          <Text style={styles.completionNoticeText}>{INVITE_COMPLETION_NOTICE}</Text>
        </View>
      ) : null}

      <View style={styles.searchField}>
        <Ionicons name="search-outline" size={20} color={t.color.text.muted} />
        <TextInput
          value={searchQuery}
          onChangeText={(value) => {
            if (!searchQuery.trim() && value.trim()) setFilter("all");
            setSearchQuery(value);
            searchController.setQuery(value);
          }}
          style={styles.searchInput}
          placeholder="Search conversations"
          placeholderTextColor={t.color.text.dim}
          accessibilityLabel="Search conversations"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {searchQuery ? (
          <Pressable
            onPress={() => {
              setSearchQuery("");
              searchController.setQuery("");
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear conversation search"
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={20} color={t.color.text.muted} />
          </Pressable>
        ) : null}
      </View>

      {searchQuery && (searchState.status === "offline" || searchState.status === "error") ? (
        <View style={styles.searchFailure} accessibilityRole="alert">
          <Text style={styles.searchFailureText}>{searchState.error ?? "Search could not be completed."}</Text>
          <Pressable onPress={() => void searchController.retry()} accessibilityRole="button">
            <Text style={styles.searchRetryText}>Try again</Text>
          </Pressable>
        </View>
      ) : searchQuery && searchState.status === "invalid" && searchState.error ? (
        <Text style={styles.searchValidation} accessibilityRole="alert">{searchState.error}</Text>
      ) : null}

      <View style={styles.chipsRow}>
        {(["all", "chats", "group-chats", "archive"] as const).map((f) => (
          <Pressable
            key={f}
            style={[styles.primaryFilterChip, filter === f && styles.filterChipActive]}
            onPress={() => setFilter(f)}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === f }}
            accessibilityLabel={f === "all" ? "All conversations" : f === "chats" ? "Chats" : f === "group-chats" ? "Group chats" : "Archived conversations"}
          >
            <Text
              style={[styles.filterChipText, filter === f && styles.filterChipTextActive]}
            >
              {f === "all" ? "All" : f === "chats" ? "Chats" : f === "group-chats" ? "Group Chats" : "Archive"}
            </Text>
          </Pressable>
        ))}
      </View>

      {filter === "chats" ? (
        <View style={styles.chatChipsRow}>
          {(canInvokeAgents
            ? (["genies", "people"] as const)
            : (["people"] as const)
          ).map((f) => (
            <Pressable
              key={f}
              style={[styles.chatFilterChip, chatFilter === f && styles.chatFilterChipActive]}
              onPress={() => setChatFilter(f)}
              accessibilityRole="tab"
              accessibilityState={{ selected: chatFilter === f }}
              accessibilityLabel={f === "people" ? "People" : "Genies"}
            >
              <Text style={[styles.chatFilterChipText, chatFilter === f && styles.chatFilterChipTextActive]}>
                {f === "people" ? "People" : "Genies"}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={t.color.brand.accent} />
        </View>
      ) : error ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>Could not load conversations</Text>
          <Text style={styles.stateSub}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={() => void loadRooms()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : searchQuery && catalogueRows.length === 0 &&
        (searchState.status === "debouncing" || searchState.status === "loading") ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={t.color.brand.accent} />
          <Text style={styles.stateSub}>Searching conversations and messages…</Text>
        </View>
      ) : catalogueRows.length === 0 ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>
            {visibleRooms.length === 0 ? "No conversations yet" : searchQuery ? "No matches" : "Nothing here"}
          </Text>
          <Text style={styles.stateSub}>
            {visibleRooms.length === 0
              ? "Start a new chat to get going."
              : searchQuery
                ? "Try a different search."
              : "Try a different filter."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={catalogueRows}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListFooterComponent={searchQuery && searchState.hasMoreOlderMessages ? (
            <Pressable
              disabled={searchState.loadingOlder}
              style={styles.loadOlder}
              onPress={() => void searchController.loadOlder()}
              accessibilityRole="button"
              accessibilityLabel="Load older chat search results"
            >
              {searchState.loadingOlder ? <ActivityIndicator size="small" color={t.color.brand.accent} /> : null}
              <Text style={styles.searchRetryText}>
                {searchState.loadingOlder ? "Loading…" : "Load older results"}
              </Text>
            </Pressable>
          ) : null}
          contentContainerStyle={styles.listBody}
          keyboardShouldPersistTaps="handled"
        />
      )}

      <Pressable
        style={({ pressed }) => [styles.newConversationButton, pressed && styles.newConversationButtonPressed]}
        onPress={() => router.push("/chat/new")}
        accessibilityRole="button"
        accessibilityLabel="New conversation"
      >
        <Ionicons name="add" size={22} color={t.color.text.onPrimary} />
        <Text style={styles.newConversationButtonText}>New chat</Text>
      </Pressable>

      <ChatManagementSheet
        visible={managementRoom !== null}
        room={managementRoom?.room ?? null}
        serverUrl={managementRoom?.serverUrl}
        viewerActorId={managementRoom?.scope.viewerActorId ?? null}
        canManage={managementRoom?.canManage ?? false}
        canLeave={managementRoom?.canLeave ?? false}
        isArchived={managementRoom?.isArchived ?? false}
        onClose={() => setManagementRoom(null)}
        onRename={(room) => {
          if (!managementRoom) return;
          setRenameRoom({ ...managementRoom, room });
          setManagementRoom(null);
        }}
        onArchiveChange={(roomId, archived) => {
          if (managementRoom) {
            publishRoomProjection(managementRoom.scope, { kind: "archived", roomId, archived });
          }
        }}
        onLeft={(roomId) => {
          if (managementRoom) publishRoomProjection(managementRoom.scope, { kind: "left", roomId });
        }}
      />
      <ChatRenameSheet
        visible={renameRoom !== null}
        roomId={renameRoom?.room.id ?? null}
        initialLabel={renameRoom?.room.label ?? ""}
        serverUrl={renameRoom?.serverUrl}
        onClose={() => setRenameRoom(null)}
        onRenamed={(detail) => {
          if (renameRoom) publishRoomProjection(renameRoom.scope, { kind: "renamed", room: detail });
          setRenameRoom(null);
        }}
      />

    </View>
  );
}

function iconForCategory(category: ReturnType<typeof conversationCatalogueKind>) {
  if (category === "person") return "person-outline" as const;
  if (category === "genie") return "sparkles-outline" as const;
  if (category === "room") return "chatbubbles-outline" as const;
  return "people-outline" as const;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    completionNotice: {
      marginHorizontal: t.spacing.lg,
      padding: t.spacing.md,
      borderRadius: t.radii.sm,
      backgroundColor: t.color.surface.subtle,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    completionNoticeText: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    searchField: {
      minHeight: 46,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      marginHorizontal: t.spacing.lg,
      marginTop: t.spacing.sm,
      marginBottom: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    searchInput: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 0,
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    searchFailure: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: t.spacing.sm,
      marginHorizontal: t.spacing.lg,
      marginBottom: t.spacing.sm,
    },
    searchFailureText: { flex: 1, color: t.color.status.error, ...t.typography.caption },
    searchRetryText: { color: t.color.brand.accent, ...t.typography.label },
    searchValidation: {
      marginHorizontal: t.spacing.lg,
      marginBottom: t.spacing.sm,
      color: t.color.status.error,
      ...t.typography.caption,
    },
    chipsRow: {
      flexDirection: "row",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.sm,
    },
    primaryFilterChip: {
      flex: 1,
      alignItems: "center",
      paddingVertical: t.spacing.xs + 2,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    filterChipActive: {
      backgroundColor: t.color.action.primaryBg,
      borderColor: t.color.action.primaryBg,
    },
    filterChipText: { color: t.color.text.muted, ...t.typography.caption },
    filterChipTextActive: { color: t.color.text.onPrimary },
    chatChipsRow: {
      flexDirection: "row",
      gap: t.spacing.xs,
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.sm,
    },
    chatFilterChip: {
      flex: 1,
      minHeight: 36,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.xs,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    chatFilterChipActive: { borderBottomColor: t.color.brand.accent },
    chatFilterChipText: { color: t.color.text.muted, textAlign: "center", ...t.typography.caption },
    chatFilterChipTextActive: { color: t.color.brand.accent, ...t.typography.label },
    listBody: { paddingHorizontal: t.spacing.lg, paddingBottom: 96 },
    searchSectionHeading: { paddingTop: t.spacing.lg, paddingBottom: t.spacing.sm },
    searchSectionTitle: { color: t.color.text.foreground, ...t.typography.label },
    searchSectionDetail: { color: t.color.text.muted, ...t.typography.caption },
    messageResult: {
      minHeight: 72,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingVertical: t.spacing.md,
    },
    messageSnippet: { color: t.color.text.muted, ...t.typography.body },
    loadOlder: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
      marginTop: t.spacing.md,
    },
    newConversationButton: {
      position: "absolute",
      right: t.spacing.lg,
      bottom: t.spacing.lg,
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.pill,
      backgroundColor: t.color.action.primaryBg,
      shadowColor: "#000",
      shadowOpacity: 0.24,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    newConversationButtonPressed: { opacity: 0.82 },
    newConversationButtonText: { color: t.color.text.onPrimary, ...t.typography.bodyStrong },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.md,
    },
    rowPressTarget: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: t.spacing.md },
    rowPressed: { backgroundColor: t.color.surface.subtle },
    managementButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22 },
    managementButtonPressed: { backgroundColor: t.color.surface.subtle },
    archivedLabel: { color: t.color.text.dim, ...t.typography.caption },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: t.color.surface.element,
      alignItems: "center",
      justifyContent: "center",
    },
    rowBody: { flex: 1, gap: t.spacing.xs / 2 },
    rowTop: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: t.spacing.sm,
    },
    rowName: { color: t.color.text.foreground, flexShrink: 1, ...t.typography.bodyStrong },
    rowTime: { color: t.color.text.dim, ...t.typography.caption },
    rowBottom: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    rowSub: { color: t.color.text.muted, ...t.typography.caption },
    unreadDot: {
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: t.color.brand.accent,
    },
    importantBadge: {
      minWidth: 22,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.brand.accent,
    },
    importantBadgeText: { color: t.color.text.onPrimary, ...t.typography.caption },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: t.color.border.default,
      marginLeft: 56,
    },
    stateWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
      padding: t.spacing.xl,
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
  });
}
