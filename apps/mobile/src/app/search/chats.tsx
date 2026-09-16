import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import {
  createChatSearchController,
  type ChatSearchController,
  type ChatSearchScope,
} from "@/features/chat-search/chat-search-controller";
import { decodeChatSearchSnippet } from "@/features/chat-search/chat-search-presentation";
import { getApiClient } from "@/lib/api";
import { formatRelativeTime, roomDisplayName } from "@/lib/rooms";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type {
  ChatSearchConversationHit,
  ChatSearchMessageHit,
} from "@nautilo/types";

type SearchRow =
  | { kind: "conversation-heading"; key: string }
  | { kind: "conversation"; key: string; hit: ChatSearchConversationHit }
  | { kind: "message-heading"; key: string }
  | { kind: "message"; key: string; hit: ChatSearchMessageHit };

export default function SearchChatsScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const { activeServer } = useServers();
  const { status: authStatus, viewer } = useAuth();
  const viewerEpochRef = useRef({ viewer, epoch: 0 });
  if (viewerEpochRef.current.viewer !== viewer) {
    viewerEpochRef.current = { viewer, epoch: viewerEpochRef.current.epoch + 1 };
  }
  const viewerEpoch = viewerEpochRef.current.epoch;
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;

  const controllerRef = useRef<ChatSearchController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createChatSearchController({
      fetchPage: async (scope, options, signal) => {
        const server = activeServerRef.current;
        if (!server || server.id !== scope.serverId) {
          throw new Error("The active server changed.");
        }
        return getApiClient(server.serverUrl).searchChats(options, { signal });
      },
    });
  }
  const controller = controllerRef.current;
  const [state, setState] = useState(() => controller.getSnapshot());

  useEffect(
    () => controller.subscribe(() => setState(controller.getSnapshot())),
    [controller],
  );
  useEffect(() => () => controller.dispose(), [controller]);

  const scope = useMemo<ChatSearchScope | null>(
    () => activeServer && authStatus === "signed-in" && viewer
      ? { serverId: activeServer.id, viewerActorId: viewer.actorId, viewerEpoch }
      : null,
    [activeServer, authStatus, viewer, viewerEpoch],
  );
  useEffect(() => controller.setScope(scope), [controller, scope]);

  useFocusEffect(useCallback(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []));

  const rows = useMemo<SearchRow[]>(() => {
    const next: SearchRow[] = [];
    if (state.conversations.length > 0) {
      next.push({ kind: "conversation-heading", key: "conversation-heading" });
      for (const hit of state.conversations) {
        next.push({ kind: "conversation", key: `conversation:${hit.room.id}`, hit });
      }
    }
    if (state.messages.length > 0) {
      next.push({ kind: "message-heading", key: "message-heading" });
      for (const hit of state.messages) {
        next.push({ kind: "message", key: `message:${hit.roomId}:${hit.messageId}`, hit });
      }
    }
    return next;
  }, [state.conversations, state.messages]);

  const openConversation = useCallback((hit: ChatSearchConversationHit) => {
    const key = `conversation:${hit.room.id}`;
    if (!controller.claimNavigation(key)) return;
    Keyboard.dismiss();
    router.push({ pathname: "/chat/[roomId]", params: { roomId: hit.room.id } });
  }, [controller]);

  const openMessage = useCallback((hit: ChatSearchMessageHit) => {
    const key = `message:${hit.roomId}:${hit.messageId}`;
    if (!controller.claimNavigation(key)) return;
    Keyboard.dismiss();
    router.push({
      pathname: "/chat/[roomId]",
      params: { roomId: hit.roomId, targetMessageId: hit.messageId },
    });
  }, [controller]);

  const renderItem = useCallback(({ item }: { item: SearchRow }) => {
    if (item.kind === "conversation-heading") {
      return (
        <View>
          <Text style={styles.sectionHeading}>MATCHING CHATS</Text>
          <Text style={styles.sectionDetail}>Chat names or participants</Text>
        </View>
      );
    }
    if (item.kind === "message-heading") {
      return (
        <View>
          <Text style={styles.sectionHeading}>MATCHING MESSAGES</Text>
          <Text style={styles.sectionDetail}>Text inside your chats</Text>
        </View>
      );
    }
    if (item.kind === "conversation") {
      const participantLine = item.hit.room.roster
        ?.filter((member) => member.actorId !== state.scope?.viewerActorId)
        .map((member) => member.displayName.trim())
        .filter(Boolean)
        .join(" · ");
      return (
        <Pressable
          style={({ pressed }) => [styles.card, pressed && styles.pressed]}
          onPress={() => openConversation(item.hit)}
          accessibilityRole="button"
          accessibilityLabel={`Open conversation ${roomDisplayName(item.hit.room)}`}
        >
          <View style={styles.cardCopy}>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {roomDisplayName(item.hit.room)}
            </Text>
            <Text style={styles.cardMeta} numberOfLines={2}>
              {participantLine || (item.hit.matchedBy === "participant" ? "Participant match" : "Conversation")}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={t.color.text.muted} />
        </Pressable>
      );
    }
    const breadcrumb = item.hit.parentRoomLabel
      ? `${item.hit.parentRoomLabel} › ${item.hit.roomLabel || "Thread"}`
      : item.hit.roomLabel;
    const time = formatRelativeTime(item.hit.createdAt);
    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && styles.pressed]}
        onPress={() => openMessage(item.hit)}
        accessibilityRole="button"
        accessibilityLabel={`Open matching message in ${breadcrumb}`}
      >
        <View style={styles.cardCopy}>
          <Text style={styles.cardTitle} numberOfLines={2}>{breadcrumb}</Text>
          <Text style={styles.snippet} numberOfLines={4}>
            {decodeChatSearchSnippet(item.hit.snippet)}
          </Text>
          {time ? <Text style={styles.cardMeta}>{time}</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={20} color={t.color.text.muted} />
      </Pressable>
    );
  }, [openConversation, openMessage, state.scope?.viewerActorId, styles, t.color.text.muted]);

  const searching = state.status === "debouncing" || state.status === "loading";
  const hasResults = rows.length > 0;

  const header = (
    <View>
      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={20} color={t.color.text.muted} />
        <TextInput
          ref={inputRef}
          value={state.query}
          onChangeText={(value) => controller.setQuery(value)}
          placeholder="Search chat names, people, and messages"
          placeholderTextColor={t.color.text.dim}
          style={styles.searchInput}
          accessibilityLabel="Search all chats"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="never"
          autoFocus
        />
        {state.query ? (
          <Pressable
            style={styles.clearButton}
            onPress={() => {
              controller.setQuery("");
              inputRef.current?.focus();
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear chat search"
          >
            <Ionicons name="close-circle" size={20} color={t.color.text.muted} />
          </Pressable>
        ) : null}
      </View>
      {hasResults ? (
        <Text style={styles.resultSummary} accessibilityRole="text">
          {`${state.conversations.length}${state.conversationsTruncated ? "+" : ""} matching chat${state.conversations.length === 1 && !state.conversationsTruncated ? "" : "s"} · ${state.messages.length}${state.hasMoreOlderMessages ? "+" : ""} message match${state.messages.length === 1 && !state.hasMoreOlderMessages ? "" : "es"} shown`}
        </Text>
      ) : null}
      {state.status === "invalid" && state.error ? (
        <Text style={styles.validation} accessibilityRole="alert">{state.error}</Text>
      ) : null}
      {(state.status === "offline" || state.status === "error") && hasResults ? (
        <InlineFailure
          title={state.status === "offline" ? "You're offline" : "Search was interrupted"}
          detail={state.error ?? "Try again."}
          onRetry={() => void controller.retry()}
          styles={styles}
        />
      ) : null}
      {state.conversationsTruncated ? (
        <Text style={styles.notice}>More conversations match. Refine your search to narrow the list.</Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <AppBar title="Search all chats" left={<AppBarBackButton onPress={() => router.back()} />} />
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={
          searching ? (
            <SearchSkeleton styles={styles} />
          ) : state.status === "empty" ? (
            <SearchState
              icon="search-outline"
              title="No chat names, participants, or messages match"
              detail="Try different words. This searches chats and message text, not files directly."
              styles={styles}
              color={t.color.text.muted}
            />
          ) : state.status === "offline" || state.status === "error" ? (
            <SearchState
              icon="cloud-offline-outline"
              title={state.status === "offline" ? "You're offline" : "Could not search chats"}
              detail={state.error ?? "Try again."}
              styles={styles}
              color={t.color.text.muted}
              onRetry={() => void controller.retry()}
            />
          ) : state.scope === null ? (
            <SearchState
              icon="person-circle-outline"
              title="Search is unavailable"
              detail="Sign in to an active server, then try again."
              styles={styles}
              color={t.color.text.muted}
            />
          ) : state.status === "invalid" ? null : (
            <SearchState
              icon="chatbubbles-outline"
              title="Search all chats"
              detail={`Search ${activeServer?.displayName ?? "this server"} by chat name, participant, or message text.`}
              styles={styles}
              color={t.color.text.muted}
            />
          )
        }
        ListFooterComponent={
          state.hasMoreOlderMessages ? (
            <Pressable
              disabled={state.loadingOlder}
              style={[styles.loadOlder, state.loadingOlder && styles.disabled]}
              onPress={() => void controller.loadOlder()}
              accessibilityRole="button"
              accessibilityLabel="Load older chat search results"
            >
              {state.loadingOlder ? <ActivityIndicator size="small" color={t.color.brand.accent} /> : null}
              <Text style={styles.loadOlderText}>
                {state.loadingOlder ? "Loading…" : "Load older results"}
              </Text>
            </Pressable>
          ) : state.pageLimitReached ? (
            <Text style={styles.notice}>Refine your search to see older results.</Text>
          ) : null
        }
        contentContainerStyle={[styles.listBody, { paddingBottom: insets.bottom + t.spacing.xl }]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={Keyboard.dismiss}
      />
    </View>
  );
}

function SearchSkeleton({ styles }: { styles: ReturnType<typeof createStyles> }) {
  const opacity = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.85, duration: 650, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.45, duration: 650, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View style={[styles.skeletonWrap, { opacity }]} accessibilityLabel="Loading chat search results">
      <View style={[styles.skeletonLine, styles.skeletonHeading]} />
      <View style={styles.skeletonCard} />
      <View style={[styles.skeletonLine, styles.skeletonHeading]} />
      <View style={styles.skeletonCard} />
      <View style={styles.skeletonCard} />
    </Animated.View>
  );
}

function SearchState({
  icon,
  title,
  detail,
  color,
  styles,
  onRetry,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  color: string;
  styles: ReturnType<typeof createStyles>;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.stateWrap}>
      <Ionicons name={icon} size={34} color={color} />
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateDetail}>{detail}</Text>
      {onRetry ? (
        <Pressable style={styles.retryButton} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function InlineFailure({
  title,
  detail,
  onRetry,
  styles,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.inlineFailure} accessibilityRole="alert">
      <View style={styles.cardCopy}>
        <Text style={styles.inlineFailureTitle}>{title}</Text>
        <Text style={styles.cardMeta}>{detail}</Text>
      </View>
      <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry chat search">
        <Text style={styles.retryText}>Retry</Text>
      </Pressable>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    listBody: { flexGrow: 1, paddingHorizontal: t.spacing.lg, gap: t.spacing.sm },
    searchBox: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      marginTop: t.spacing.md,
      marginBottom: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
    },
    searchInput: { flex: 1, minWidth: 0, color: t.color.text.foreground, ...t.typography.body },
    clearButton: { minWidth: 32, minHeight: 40, alignItems: "center", justifyContent: "center" },
    sectionHeading: {
      marginTop: t.spacing.md,
      color: t.color.text.muted,
      letterSpacing: 0.8,
      ...t.typography.label,
    },
    sectionDetail: {
      marginTop: t.spacing.xs,
      color: t.color.text.muted,
      ...t.typography.caption,
    },
    resultSummary: {
      marginBottom: t.spacing.sm,
      color: t.color.text.muted,
      ...t.typography.caption,
    },
    card: {
      minHeight: 76,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      padding: t.spacing.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.panel,
    },
    pressed: { opacity: 0.72 },
    cardCopy: { flex: 1, minWidth: 0, gap: t.spacing.xs },
    cardTitle: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    cardMeta: { color: t.color.text.muted, ...t.typography.caption },
    snippet: { color: t.color.text.foreground, ...t.typography.body },
    validation: { color: t.color.status.error, marginBottom: t.spacing.sm, ...t.typography.caption },
    notice: {
      marginVertical: t.spacing.sm,
      color: t.color.text.muted,
      textAlign: "center",
      ...t.typography.caption,
    },
    inlineFailure: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      padding: t.spacing.md,
      marginBottom: t.spacing.sm,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.status.warning,
      backgroundColor: t.color.surface.panel,
    },
    inlineFailureTitle: { color: t.color.text.foreground, ...t.typography.label },
    stateWrap: {
      flex: 1,
      minHeight: 300,
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
      padding: t.spacing.xl,
    },
    stateTitle: { color: t.color.text.foreground, textAlign: "center", ...t.typography.subheading },
    stateDetail: { color: t.color.text.muted, textAlign: "center", ...t.typography.body },
    retryButton: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: t.spacing.lg,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.pill,
    },
    retryText: { color: t.color.brand.accent, ...t.typography.label },
    loadOlder: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.sm,
      marginTop: t.spacing.sm,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
    },
    loadOlderText: { color: t.color.brand.accent, ...t.typography.label },
    disabled: { opacity: 0.55 },
    skeletonWrap: { gap: t.spacing.sm, paddingVertical: t.spacing.lg },
    skeletonLine: { backgroundColor: t.color.surface.subtle, borderRadius: t.radii.sm },
    skeletonHeading: { width: "36%", height: 16, marginTop: t.spacing.sm },
    skeletonCard: { height: 88, backgroundColor: t.color.surface.subtle, borderRadius: t.radii.md },
  });
}
