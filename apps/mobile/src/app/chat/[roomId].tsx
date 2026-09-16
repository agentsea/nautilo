// D369 Phase 6 / D424 Phase 4.1 — chat/[roomId] conversation screen.
//
// This route is now wiring-only for full-screen-only chrome: the room header
// title, members sheet, agent focus bar, model switcher sheet, and the
// keyboard/safe-area wrapper. All room-independent controller behavior
// (transcript, streaming, send, reactions, typing, paging, approvals, voice,
// attachments, model selection) lives in the shared `useRoomChatController`
// hook and renders through the shared `RoomChatPane` + `RoomChatComposer` so
// the docked artifact viewer (Phase 4.2) can embed chat without duplicating
// send/streaming logic.
import { Ionicons } from "@expo/vector-icons";
import { router, useIsFocused, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, BackHandler, findNodeHandle, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AgentFocusBar } from "@/components/agent-focus-bar";
import { MembersSheet } from "@/components/members-sheet";
import { useChatHeaderActions } from "@/components/chat-header-actions";
import { ChatRenameSheet } from "@/components/chat-rename-sheet";
import {
  publishRoomProjection,
  type RoomProjectionScope,
} from "@/features/chat-management/chat-management-projection";
import { ModelSwitcherSheet } from "@/components/model-switcher-sheet";
import {
  RoomChatComposer,
  RoomChatPane,
  useRoomChatController,
} from "@/features/room-chat-pane";
import { roomChatCapabilitiesForPlatform } from "@/features/room-chat-pane/platform-capabilities";
import { TaskWorkStrip } from "@/features/task-work/task-work-strip";
import { projectTaskWorkStrip } from "@/features/task-work/task-work-strip-presentation";
import { TaskWorkStatusAnnouncer } from "@/features/task-work/task-work-status-announcer";
import { createTaskDetailHandoffCoordinator } from "@/features/task-work/task-detail-handoff";
import { useTaskWork } from "@/features/task-work/use-task-work";
import { TaskWorkOverviewShell } from "@/features/task-work/task-work-overview-shell";
import { canOpenTaskWorkOverview, shouldCloseTaskWorkOverview, taskWorkOverviewCloseAccessibilityAction, taskWorkOverviewScopeKey, type TaskWorkOverviewCloseReason } from "@/features/task-work/task-work-overview-presentation";
import { useRoomFocus } from "@/lib/use-room-focus";
import {
  createRoomMessageSearchController,
  type RoomMessageSearchController,
  type RoomSearchScope,
} from "@/features/room-chat-search/room-message-search-controller";
import { getApiClient } from "@/lib/api";
import { openMobileSubthread } from "@/features/threads/mobile-thread-api";
import { useAppTheme } from "@/providers/theme";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";
import { viewerCan } from "@/lib/viewer-capabilities";
import type { AppTheme } from "@/theme/tokens";

function sameProjectionScope(
  left: RoomProjectionScope | null,
  right: RoomProjectionScope | null,
): boolean {
  return left !== null && right !== null &&
    left.serverId === right.serverId && left.viewerActorId === right.viewerActorId;
}

export default function ChatRoomScreen() {
  const t = useAppTheme();
  const platformCapabilities = usePlatformCapabilities();
  const chatCapabilities = useMemo(
    () => roomChatCapabilitiesForPlatform(platformCapabilities),
    [platformCapabilities],
  );
  const styles = useMemo(() => createStyles(t), [t]);
  const { roomId, targetMessageId } = useLocalSearchParams<{
    roomId: string;
    targetMessageId?: string;
  }>();
  const navigation = useNavigation();
  const isScreenFocused = useIsFocused();
  const { setOnMembersPress, setOnRenamePress, setOnSearchPress } = useChatHeaderActions();
  const { activeServer } = useServers();
  const { status: authStatus, viewer, viewerState } = useAuth();

  const controller = useRoomChatController({ roomId, targetMessageId });
  const roomProjectionScope = useMemo<RoomProjectionScope | null>(
    () => controller.serverId && controller.viewerActorId
      ? { serverId: controller.serverId, viewerActorId: controller.viewerActorId }
      : null,
    [controller.serverId, controller.viewerActorId],
  );
  const activeRoomProjectionScopeRef = useRef(roomProjectionScope);
  activeRoomProjectionScopeRef.current = roomProjectionScope;
  const canInvokeAgents = viewerCan(controller.viewer, "invoke_agents");
  // Owner-wide delegated work is separate from this Room's focus preference.
  // An unfocused stacked route releases its Task custody immediately.
  const taskWorkServer = useMemo(
    () => isScreenFocused && activeServer && activeServer.id === controller.serverId && controller.serverUrl
      ? { id: activeServer.id, serverUrl: controller.serverUrl }
      : null,
    [activeServer, controller.serverId, controller.serverUrl, isScreenFocused],
  );
  const taskWork = useTaskWork({
    server: taskWorkServer,
    authStatus,
    viewerId: viewer?.userId ?? null,
    viewerActorId: viewer?.actorId ?? null,
    viewerState,
    canInvokeAgents,
    viewerIdentity: viewer,
  });
  const overviewScopeKey = taskWorkOverviewScopeKey({ roomId, serverUrl: taskWorkServer?.serverUrl ?? null, scope: taskWork.scope });
  const [openOverviewScopeKey, setOpenOverviewScopeKey] = useState<string | null>(null);
  const taskDetailHandoffRef = useRef(createTaskDetailHandoffCoordinator());
  const overviewOpen = openOverviewScopeKey !== null && openOverviewScopeKey === overviewScopeKey;
  const stripRef = useRef<View>(null);
  const chatContentRef = useRef<View>(null);
  const closeAccessibilityRef = useRef<{ readonly scopeKey: string; readonly reason: TaskWorkOverviewCloseReason } | null>(null);
  const closeOverview = useCallback((reason: TaskWorkOverviewCloseReason = "teardown") => {
    if (openOverviewScopeKey !== null) {
      closeAccessibilityRef.current = { scopeKey: openOverviewScopeKey, reason };
    }
    setOpenOverviewScopeKey((current) => current === null ? current : null);
  }, [openOverviewScopeKey]);
  const openOverview = useCallback(() => {
    if (overviewOpen) return;
    if (!canOpenTaskWorkOverview({ isScreenFocused, scopeKey: overviewScopeKey, view: taskWork })) return;
    taskDetailHandoffRef.current.reset();
    Keyboard.dismiss();
    setOpenOverviewScopeKey((current) => current === overviewScopeKey ? current : overviewScopeKey);
  }, [isScreenFocused, overviewOpen, overviewScopeKey, taskWork]);
  const openTaskDetail = useCallback((taskId: string) => {
    const handoff = taskDetailHandoffRef.current.begin({
      openOverviewScopeKey,
      currentOverviewScopeKey: overviewScopeKey,
      roomId,
      taskId,
      view: taskWork,
    });
    if (handoff.status !== "navigate") return;
    // Close before push so the preserved Chat is immediately interactive again
    // if the detail route is later dismissed or cannot load.
    closeOverview("teardown");
    router.push({ pathname: "/tasks/[taskId]", params: { taskId: handoff.taskId, originRoomId: handoff.originRoomId } });
  }, [closeOverview, openOverviewScopeKey, overviewScopeKey, roomId, taskWork]);
  useEffect(() => {
    if (openOverviewScopeKey !== null && (!overviewOpen || !isScreenFocused || shouldCloseTaskWorkOverview(taskWork))) closeOverview();
  }, [closeOverview, isScreenFocused, openOverviewScopeKey, overviewOpen, taskWork]);
  useEffect(() => {
    if (overviewOpen) return;
    const closeAccessibility = closeAccessibilityRef.current;
    if (!closeAccessibility) return;
    closeAccessibilityRef.current = null;
    const action = taskWorkOverviewCloseAccessibilityAction({
      reason: closeAccessibility.reason,
      openScopeKey: closeAccessibility.scopeKey,
      currentScopeKey: overviewScopeKey,
      stripAvailable: stripRef.current !== null,
    });
    if (action === "focus-strip" && platformCapabilities.platform === "web") {
      stripRef.current?.focus?.();
      return;
    }
    if (action === "focus-strip") {
      const node = findNodeHandle(stripRef.current);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
      return;
    }
    if (action === "announce-conversation") {
      if (platformCapabilities.platform === "web") {
        chatContentRef.current?.focus?.();
      } else {
        AccessibilityInfo.announceForAccessibility("Delegated work closed. Conversation restored.");
      }
    }
  }, [overviewOpen, overviewScopeKey, platformCapabilities.platform]);
  useEffect(() => {
    if (!overviewOpen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { closeOverview("explicit"); return true; });
    return () => subscription.remove();
  }, [closeOverview, overviewOpen]);
  useEffect(() => navigation.addListener("beforeRemove", (event) => {
    if (!overviewOpen || (event.data.action.type !== "GO_BACK" && event.data.action.type !== "POP")) return;
    event.preventDefault();
    closeOverview("explicit");
  }), [closeOverview, navigation, overviewOpen]);
  useEffect(() => {
    if (platformCapabilities.platform !== "web" || !overviewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeOverview("explicit"); };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [closeOverview, overviewOpen, platformCapabilities.platform]);
  const [searchOpen, setSearchOpen] = useState(false);
  const activeSearchScopeRef = useRef<RoomSearchScope | null>(null);
  const threadOpenPromiseRef = useRef<Promise<void> | null>(null);
  const searchServerUrlRef = useRef(controller.serverUrl);
  searchServerUrlRef.current = controller.serverUrl;
  const searchControllerRef = useRef<RoomMessageSearchController | null>(null);
  if (!searchControllerRef.current) {
    searchControllerRef.current = createRoomMessageSearchController({
      fetchPage: async (scope, options, signal) => {
        const active = activeSearchScopeRef.current;
        if (!active || active.serverId !== scope.serverId || active.roomId !== scope.roomId) {
          throw new Error("The active conversation changed.");
        }
        const serverUrl = searchServerUrlRef.current;
        if (!serverUrl) throw new Error("No active server.");
        return getApiClient(serverUrl).searchRoomMessages(options, { signal });
      },
    });
  }
  const searchController = searchControllerRef.current;
  const [searchState, setSearchState] = useState(() => searchController.getSnapshot());
  const viewerEpochRef = useRef({ viewer: controller.viewer, epoch: 0 });
  if (viewerEpochRef.current.viewer !== controller.viewer) {
    viewerEpochRef.current = {
      viewer: controller.viewer,
      epoch: viewerEpochRef.current.epoch + 1,
    };
  }
  const searchScope = useMemo<RoomSearchScope | null>(() =>
    controller.serverId && controller.viewerActorId && controller.roomIdValid
      ? {
          serverId: controller.serverId,
          roomId,
          viewerActorId: controller.viewerActorId,
          viewerEpoch: viewerEpochRef.current.epoch,
        }
      : null,
  [controller.roomIdValid, controller.serverId, controller.viewerActorId, controller.viewer, roomId]);
  activeSearchScopeRef.current = searchScope;

  useEffect(
    () => searchController.subscribe(() => setSearchState(searchController.getSnapshot())),
    [searchController],
  );
  useEffect(() => () => searchController.dispose(), [searchController]);
  useEffect(() => searchController.setScope(searchScope), [searchController, searchScope]);

  // Full-screen-only room-target wiring: agent avatar → focus. Passed to the
  // shared pane's `onAgentAvatarPress` so the message column can wire
  // onAvatarPress without the pane owning the focus provider.
  const { focusedBotActorId, isFocused, secondsLeft, toggleFocus } = useRoomFocus(
    controller.serverUrl,
    controller.roomIdValid ? roomId : undefined,
    controller.viewerActorId,
  );

  // D408 — members sheet (§6.5.3) visibility; opened from the app-bar [👥].
  const [membersSheetVisible, setMembersSheetVisible] = useState(false);
  const [renameMutationContext, setRenameMutationContext] = useState<{
    scope: RoomProjectionScope;
    serverUrl: string;
  } | null>(null);
  const [canManageRoom, setCanManageRoom] = useState(false);
  const [roomArchived, setRoomArchived] = useState(false);
  const [modelSheetVisible, setModelSheetVisible] = useState(false);
  const [threadOpenError, setThreadOpenError] = useState<string | null>(null);

  const handleThreadPress = async (anchorMessageId: number): Promise<void> => {
    const serverUrl = controller.serverUrl;
    if (!serverUrl) return;
    if (threadOpenPromiseRef.current) return threadOpenPromiseRef.current;
    const task = (async () => {
      setThreadOpenError(null);
      try {
        const threadRoomId = await openMobileSubthread(
          getApiClient(serverUrl),
          roomId,
          anchorMessageId,
        );
        router.push({
          pathname: "/chat/thread/[threadRoomId]",
          params: { threadRoomId, parentRoomId: roomId },
        });
      } catch (error) {
        setThreadOpenError(error instanceof Error ? error.message : "Could not open this thread.");
      }
    })();
    threadOpenPromiseRef.current = task;
    try {
      await task;
    } finally {
      if (threadOpenPromiseRef.current === task) threadOpenPromiseRef.current = null;
    }
  };

  // A membership update can turn the currently open room into a direct Human
  // conversation. Close and unmount the sheet immediately so it cannot fetch
  // or remain visible after its entry point disappears.
  useEffect(() => {
    if (controller.directHumanRoom || !canInvokeAgents) setModelSheetVisible(false);
  }, [canInvokeAgents, controller.directHumanRoom]);

  useEffect(() => {
    if (!controller.roomMembersLoading && controller.directAgentRoom && !canInvokeAgents) {
      router.replace("/(drawer)/(tabs)");
    }
  }, [canInvokeAgents, controller.directAgentRoom, controller.roomMembersLoading]);

  // Push the room label to the shared AppBar via the chat stack header
  // (chat/_layout.tsx reads Stack.Screen `options.title`).
  useEffect(() => {
    navigation.setOptions({ title: controller.roomLabel });
  }, [controller.roomLabel, navigation]);

  // One bounded manageable-catalogue lookup determines header affordances;
  // never fetch detail once per rendered row.
  useEffect(() => {
    if (!controller.serverUrl || !controller.roomIdValid) {
      setCanManageRoom(false);
      setRoomArchived(false);
      return;
    }
    let cancelled = false;
    const client = getApiClient(controller.serverUrl);
    void Promise.all([client.listManageableRooms(), client.listManageableRooms({ includeArchived: true })]).then(([active, all]) => {
      if (cancelled) return;
      const activeIds = new Set(active.rooms.map((room) => room.id));
      setCanManageRoom(all.rooms.some((room) => room.id === roomId));
      setRoomArchived(!activeIds.has(roomId) && all.rooms.some((room) => room.id === roomId));
    }).catch(() => {
      if (!cancelled) {
        setCanManageRoom(false);
        setRoomArchived(false);
      }
    });
    return () => { cancelled = true; };
  }, [controller.roomIdValid, controller.serverUrl, roomId]);

  const canRenameRoom = canManageRoom && controller.roomType === "private";

  useEffect(() => {
    setMembersSheetVisible(false);
    setRenameMutationContext(null);
  }, [controller.serverId, controller.viewerActorId]);

  useEffect(() => {
    if (!isScreenFocused || !canRenameRoom || !roomProjectionScope || !controller.serverUrl) {
      setOnRenamePress(null);
      return;
    }
    const context = { scope: roomProjectionScope, serverUrl: controller.serverUrl };
    setOnRenamePress(() => () => setRenameMutationContext(context));
    return () => setOnRenamePress(null);
  }, [canRenameRoom, controller.serverUrl, isScreenFocused, roomProjectionScope, setOnRenamePress]);

  // D408 — expose the members-sheet trigger to the shared app-bar header, but
  // only for group conversations (§6.5.3 is a group-chat surface). Cleared on
  // unmount / when the room is no longer a group so the [👥] icon disappears.
  useEffect(() => {
    if (!isScreenFocused || !controller.groupedRoom) {
      setOnMembersPress(null);
      return;
    }
    setOnMembersPress(() => () => setMembersSheetVisible(true));
    return () => setOnMembersPress(null);
  }, [controller.groupedRoom, isScreenFocused, setOnMembersPress]);

  useEffect(() => {
    if (!isScreenFocused || !controller.roomIdValid) {
      setOnSearchPress(null);
      return;
    }
    setOnSearchPress(() => () => setSearchOpen(true));
    return () => setOnSearchPress(null);
  }, [controller.roomIdValid, isScreenFocused, setOnSearchPress]);

  useEffect(() => {
    if (!searchOpen) return;
    const hit = searchState.selectedHit;
    if (!hit) {
      controller.cancelMessageTargetNavigation();
      return;
    }
    void controller.activateMessageTarget(hit.messageId);
  }, [
    controller.activateMessageTarget,
    controller.cancelMessageTargetNavigation,
    searchOpen,
    searchState.selectedHit,
  ]);

  if (!controller.roomIdValid) {
    return (
      <View style={styles.container}>
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>Conversation not found</Text>
        </View>
      </View>
    );
  }
  const hasAgentFocusBar = canInvokeAgents && controller.roomAgents.length > 0 && Boolean(controller.serverUrl);
  const taskWorkStripServerUrl = taskWorkServer?.serverUrl ?? null;
  const hasTaskWorkStrip = taskWorkStripServerUrl !== null && projectTaskWorkStrip(taskWork) !== null;
  const hasTopWorkStack = hasAgentFocusBar || hasTaskWorkStrip;

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.container}>
      {hasTopWorkStack ? <View
        accessibilityElementsHidden={overviewOpen}
        importantForAccessibility={overviewOpen ? "no-hide-descendants" : "auto"}
        {...(platformCapabilities.platform === "web" && overviewOpen ? { "aria-hidden": true, inert: true } as unknown as Record<string, unknown> : {})}>
        {canInvokeAgents && controller.roomAgents.length > 0 && controller.serverUrl ? (
          <AgentFocusBar
            agents={controller.roomAgents}
            serverUrl={controller.serverUrl}
            roomId={roomId}
            focusedBotActorId={focusedBotActorId}
            isFocused={isFocused}
            secondsLeft={secondsLeft}
            toggleFocus={toggleFocus}
          />
        ) : null}
        {hasTaskWorkStrip ? <TaskWorkStrip ref={stripRef} view={taskWork} serverUrl={taskWorkStripServerUrl} onOpenOverview={openOverview} onCloseOverview={() => closeOverview("explicit")} expanded={overviewOpen} /> : null}
      </View> : null}
      <TaskWorkStatusAnnouncer scopeKey={overviewScopeKey} view={taskWork} />
      <View
        style={styles.chatStage}>
      <View
        ref={chatContentRef}
        style={styles.chatContent}
        pointerEvents={overviewOpen ? "none" : "auto"}
        accessibilityElementsHidden={overviewOpen}
        importantForAccessibility={overviewOpen ? "no-hide-descendants" : "auto"}
        {...(platformCapabilities.platform === "web" ? { tabIndex: -1, role: "main", "aria-label": "Conversation" } as unknown as Record<string, unknown> : {})}
        {...(platformCapabilities.platform === "web" && overviewOpen ? { "aria-hidden": true, inert: true } as unknown as Record<string, unknown> : {})}>
      {searchOpen ? (
        <View style={styles.searchPanel}>
          <View style={styles.searchRow}>
            <Ionicons name="search-outline" size={20} color={t.color.text.muted} />
            <TextInput
              autoFocus
              value={searchState.query}
              onChangeText={(value) => searchController.setQuery(value)}
              placeholder="Search in this chat"
              placeholderTextColor={t.color.text.dim}
              style={styles.searchInput}
              accessibilityLabel="Search in this chat"
              returnKeyType="search"
            />
            <Pressable
              onPress={() => {
                searchController.clear();
                controller.cancelMessageTargetNavigation();
                setSearchOpen(false);
              }}
              accessibilityRole="button"
              accessibilityLabel="Close search in this chat">
              <Ionicons name="close" size={22} color={t.color.text.foreground} />
            </Pressable>
          </View>
          <View style={styles.searchStatusRow}>
            <Text style={styles.searchStatus} accessibilityRole="text">
              {searchState.status === "loading" || searchState.status === "debouncing"
                ? "Searching…"
                : searchState.status === "empty"
                  ? "No matching messages"
                  : searchState.status === "invalid"
                    ? (searchState.error ?? "Enter a search term")
                    : searchState.status === "offline" || searchState.status === "error"
                      ? (searchState.error ?? "Search failed")
                      : searchState.selectedIndex >= 0
                        ? `Result ${searchState.selectedIndex + 1} of ${searchState.hits.length}${searchState.hasOlder ? "+" : ""}`
                        : "Search message text in this chat"
              }
            </Text>
            {searchState.status === "loading" || searchState.loadingOlder ? (
              <ActivityIndicator size="small" color={t.color.brand.accent} />
            ) : null}
            {(searchState.status === "offline" || searchState.status === "error") ? (
              <Pressable onPress={() => void searchController.retry()} accessibilityRole="button">
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            ) : null}
            <Pressable
              disabled={!searchState.hasOlder && searchState.selectedIndex + 1 >= searchState.hits.length}
              onPress={() => void searchController.moveOlder()}
              accessibilityRole="button"
              accessibilityLabel="Older search result"
              style={!searchState.hasOlder && searchState.selectedIndex + 1 >= searchState.hits.length ? styles.disabled : undefined}>
              <Ionicons name="arrow-up" size={20} color={t.color.text.foreground} />
            </Pressable>
            <Pressable
              disabled={!searchState.canMoveNewer}
              onPress={() => searchController.moveNewer()}
              accessibilityRole="button"
              accessibilityLabel="Newer search result"
              style={!searchState.canMoveNewer ? styles.disabled : undefined}>
              <Ionicons name="arrow-down" size={20} color={t.color.text.foreground} />
            </Pressable>
          </View>
          {searchState.pageLimitReached ? (
            <Text style={styles.searchHint}>Refine your search to see older results.</Text>
          ) : null}
        </View>
      ) : null}
      <RoomChatPane
        controller={controller}
        actionSurface="room"
        onAgentAvatarPress={canInvokeAgents ? toggleFocus : undefined}
        onThreadPress={(messageId) => void handleThreadPress(messageId)}
      />

      {threadOpenError ? (
        <View style={styles.threadError} accessibilityRole="alert">
          <Text style={styles.threadErrorText}>{threadOpenError}</Text>
          <Pressable onPress={() => setThreadOpenError(null)} accessibilityRole="button">
            <Ionicons name="close" size={18} color={t.color.text.muted} />
          </Pressable>
        </View>
      ) : null}

      {canInvokeAgents || (!controller.roomMembersLoading && !controller.directAgentRoom) ? (
        <RoomChatComposer
          controller={controller}
          capabilities={chatCapabilities}
          onOpenModelSheet={() => setModelSheetVisible(true)}
          interactionDisabled={overviewOpen}
        />
      ) : null}
      </View>
      {overviewOpen ? <TaskWorkOverviewShell onClose={() => closeOverview("explicit")} onSelectTask={openTaskDetail} view={taskWork} serverUrl={taskWorkServer?.serverUrl ?? null} /> : null}
      </View>
      {canInvokeAgents && !controller.directHumanRoom ? (
        <ModelSwitcherSheet
          visible={modelSheetVisible}
          onClose={() => setModelSheetVisible(false)}
          selectedModelId={controller.modelId}
          defaultModelLabel={controller.defaultModelLabel}
          onSelect={controller.handleModelSelect}
        />
      ) : null}
      <MembersSheet
        visible={membersSheetVisible}
        onClose={() => setMembersSheetVisible(false)}
        serverUrl={controller.serverUrl}
        roomId={roomId}
        viewerActorId={controller.viewerActorId}
        canInvokeAgents={canInvokeAgents}
        canManage={canManageRoom}
        isArchived={roomArchived}
        onArchiveChange={(archived) => {
          if (roomProjectionScope) {
            publishRoomProjection(roomProjectionScope, { kind: "archived", roomId, archived });
          }
          if (!sameProjectionScope(roomProjectionScope, activeRoomProjectionScopeRef.current)) return;
          setRoomArchived(archived);
          if (archived) router.back();
        }}
        onBlockChanged={() => {
          void controller.refreshDirectHumanBlockStatus();
          void controller.refreshBlockedHumanUserIds();
        }}
        onLeft={() => {
          if (roomProjectionScope) publishRoomProjection(roomProjectionScope, { kind: "left", roomId });
          if (!sameProjectionScope(roomProjectionScope, activeRoomProjectionScopeRef.current)) return;
          router.back();
        }}
      />
      <ChatRenameSheet
        visible={renameMutationContext !== null}
        roomId={roomId}
        initialLabel={controller.roomLabel}
        serverUrl={renameMutationContext?.serverUrl}
        onClose={() => setRenameMutationContext(null)}
        onRenamed={(detail) => {
          if (renameMutationContext) {
            publishRoomProjection(renameMutationContext.scope, { kind: "renamed", room: detail });
          }
          if (!sameProjectionScope(renameMutationContext?.scope ?? null, activeRoomProjectionScopeRef.current)) return;
          controller.applyCanonicalRoomDetail(detail);
          setRenameMutationContext(null);
        }}
      />
    </KeyboardAvoidingView>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    chatStage: { flex: 1, position: "relative" },
    chatContent: { flex: 1 },
    stateWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
      padding: t.spacing.xl,
    },
    stateTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    searchPanel: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      gap: t.spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
    },
    searchRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.sm,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
    },
    searchInput: { flex: 1, minWidth: 0, color: t.color.text.foreground, ...t.typography.body },
    searchStatusRow: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: t.spacing.sm },
    searchStatus: { flex: 1, color: t.color.text.muted, ...t.typography.caption },
    searchHint: { color: t.color.text.muted, ...t.typography.caption },
    retryText: { color: t.color.brand.accent, ...t.typography.label },
    disabled: { opacity: 0.35 },
    threadError: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      backgroundColor: t.color.surface.panel,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.color.status.error,
    },
    threadErrorText: { flex: 1, color: t.color.status.error, ...t.typography.caption },
  });
}
