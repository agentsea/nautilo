// D408 — thin conductor agent-focus bar (§6.5.4). Horizontally scrollable agent
// faces under the app-bar; single-focus toggle; collapsible.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { BottomSheetScrollView, BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { MessageAvatar } from "@/components/message-avatar";
import {
  agentFinderMetadata,
  agentOwnerLabel,
  agentRailOverflows,
  agentRailSecondaryLabel,
  filterAgentFinderEntries,
  orderAgentsByRecentUse,
} from "@/components/agent-focus-bar-model";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { RoomMemberDto } from "@nautilo/types";

const AVATAR_SIZE = 32;
const COLLAPSE_STORAGE_PREFIX = "@nautilo/agent-focus-bar-collapsed/";

function formatTimeLeft(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type AgentFocusBarProps = {
  agents: readonly RoomMemberDto[];
  serverUrl: string;
  roomId: string;
  /** Primary focus, retained under the legacy name for current chat callers. */
  focusedBotActorId: string | null;
  isFocused: (botActorId: string) => boolean;
  secondsLeft: (botActorId: string) => number | null;
  toggleFocus: (botActorId: string) => void;
};

export function AgentFocusBar({
  agents,
  serverUrl,
  roomId,
  focusedBotActorId,
  isFocused,
  secondsLeft,
  toggleFocus,
}: AgentFocusBarProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [collapsed, setCollapsed] = useState(false);
  const [finderVisible, setFinderVisible] = useState(false);
  const [finderQuery, setFinderQuery] = useState("");
  const [railAvailableWidth, setRailAvailableWidth] = useState(0);
  const [railContentWidth, setRailContentWidth] = useState(0);
  const [recentActorIds, setRecentActorIds] = useState<readonly string[]>([]);
  const railRef = useRef<ScrollView>(null);

  const collapseKey = `${COLLAPSE_STORAGE_PREFIX}${roomId}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(collapseKey);
        if (cancelled) return;
        setCollapsed(raw === "1");
      } catch {
        // in-memory default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collapseKey]);

  const setCollapsedPersisted = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      void AsyncStorage.setItem(collapseKey, next ? "1" : "0").catch(() => {
        /* best-effort */
      });
    },
    [collapseKey],
  );

  const focusedAgent = useMemo(
    () =>
      focusedBotActorId != null
        ? agents.find((a) => a.actorId === focusedBotActorId)
        : undefined,
    [agents, focusedBotActorId],
  );
  const focusedAgentCount = useMemo(
    () => agents.filter((agent) => isFocused(agent.actorId)).length,
    [agents, isFocused],
  );
  const primarySecondsLeft = focusedAgent ? secondsLeft(focusedAgent.actorId) : null;
  const primaryTimeLabel =
    primarySecondsLeft != null ? formatTimeLeft(primarySecondsLeft) : null;
  const finderAgents = useMemo(
    () => filterAgentFinderEntries(agents, finderQuery),
    [agents, finderQuery],
  );
  const railAgents = useMemo(
    () => orderAgentsByRecentUse(agents, recentActorIds),
    [agents, recentActorIds],
  );
  const showFinder =
    railAvailableWidth > 0 &&
    railContentWidth > 0 &&
    agentRailOverflows(railContentWidth, railAvailableWidth);

  useEffect(() => {
    if (!finderVisible) setFinderQuery("");
  }, [finderVisible]);

  useEffect(() => {
    if (recentActorIds.length === 0) return;
    const frame = requestAnimationFrame(() => {
      railRef.current?.scrollTo({ x: 0, animated: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [recentActorIds]);

  const toggleAgentFocus = useCallback((actorId: string) => {
    setRecentActorIds((current) => [actorId, ...current.filter((id) => id !== actorId)]);
    toggleFocus(actorId);
  }, [toggleFocus]);

  const renderAgentChip = (agent: RoomMemberDto) => {
    const focused = isFocused(agent.actorId);
    const primary = focused && agent.actorId === focusedBotActorId;
    const remaining = focused ? secondsLeft(agent.actorId) : null;
    const timeLabel =
      focused && remaining != null ? formatTimeLeft(remaining) : null;
    const focusLabel = primary ? "focused primary" : "focused";
    const ownerLabel = agentOwnerLabel(agent);
    const railIdentity = agentRailSecondaryLabel(agent, agents);
    const secondaryLabel = [railIdentity, timeLabel].filter(Boolean).join(" · ");
    const spokenIdentity = ownerLabel
      ? `${agent.displayName}, owned by ${ownerLabel}`
      : agent.displayName;

    return (
      <Pressable
        key={agent.actorId}
        style={styles.agentChip}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        onPress={() => toggleAgentFocus(agent.actorId)}
        accessibilityRole="button"
        accessibilityLabel={
          focused && timeLabel
            ? `${spokenIdentity}, ${focusLabel}, ${timeLabel} left. Double tap to clear this focus`
            : focused
              ? `${spokenIdentity}, focused. Double tap to clear this focus`
              : `${spokenIdentity}. Double tap to add focus`
        }
        accessibilityState={{ selected: focused }}>
        <View style={[styles.avatarRing, focused && styles.avatarRingFocused]}>
          <MessageAvatar
            serverUrl={serverUrl}
            roomId={roomId}
            displayName={agent.displayName}
            agentId={agent.agentId}
            agentAvatar={agent.agentAvatar}
            size={AVATAR_SIZE}
          />
        </View>
        <View style={styles.agentIdentity}>
          <Text style={styles.agentName} numberOfLines={1}>
            {agent.displayName}
          </Text>
          {secondaryLabel ? (
            <Text style={styles.ownerName} numberOfLines={1}>
              {secondaryLabel}
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  const handleFinderPick = useCallback(
    (agent: RoomMemberDto) => {
      toggleAgentFocus(agent.actorId);
      setFinderVisible(false);
    },
    [toggleAgentFocus],
  );

  if (collapsed) {
    return (
      <View style={styles.bar}>
        <Pressable
          style={styles.collapseButton}
          hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
          onPress={() => setCollapsedPersisted(false)}
          accessibilityRole="button"
          accessibilityLabel="Expand agent focus bar">
          <Text style={styles.collapseGlyph}>▸</Text>
        </Pressable>
        {focusedAgent ? (
          <Pressable
            style={styles.collapsedBody}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
            onPress={() => setCollapsedPersisted(false)}
            accessibilityRole="button"
            accessibilityLabel={[
              `Focused on ${focusedAgent.displayName}`,
              primaryTimeLabel ? `${primaryTimeLabel} left` : null,
              focusedAgentCount > 1 ? `${focusedAgentCount} agents focused` : null,
              "Double tap to expand agent focus bar",
            ]
              .filter(Boolean)
              .join(". ")}>
            <View style={[styles.avatarRing, styles.avatarRingFocused]}>
              <MessageAvatar
                serverUrl={serverUrl}
                roomId={roomId}
                displayName={focusedAgent.displayName}
                agentId={focusedAgent.agentId}
                agentAvatar={focusedAgent.agentAvatar}
                size={AVATAR_SIZE}
              />
            </View>
            <Text style={styles.collapsedName} numberOfLines={1}>
              {focusedAgent.displayName}
              {primaryTimeLabel ? ` · ${primaryTimeLabel}` : ""}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.collapsedBody}
            hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
            onPress={() => setCollapsedPersisted(false)}
            accessibilityRole="button"
            accessibilityLabel="Expand agent focus bar">
            <Text style={styles.collapsedHint}>Agents</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <>
      <View style={styles.bar}>
        <Pressable
          style={styles.collapseButton}
          hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
          onPress={() => setCollapsedPersisted(true)}
          accessibilityRole="button"
          accessibilityLabel="Collapse agent focus bar">
          <Text style={styles.collapseGlyph}>⌄</Text>
        </Pressable>
        <View
          style={styles.railBody}
          onLayout={(event) => setRailAvailableWidth(event.nativeEvent.layout.width)}>
          <ScrollView
            ref={railRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            onContentSizeChange={(width) => setRailContentWidth(width)}>
            {railAgents.map(renderAgentChip)}
          </ScrollView>
          {showFinder ? (
            <Pressable
              style={styles.findButton}
              onPress={() => setFinderVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="Find a Genie">
              <Ionicons name="search-outline" size={17} color={t.color.brand.accent} />
              <Text style={styles.findLabel}>Find</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <BottomSheet
        visible={finderVisible}
        onClose={() => setFinderVisible(false)}
        snapPoints={["65%"]}
        backdrop>
        <View style={styles.finderHeader} accessibilityViewIsModal>
          <View style={styles.finderTitleRow}>
            <View style={styles.finderTitleCopy}>
              <Text style={styles.finderTitle}>Choose a Genie</Text>
              <Text style={styles.finderCount}>{agents.length} available</Text>
            </View>
            <Pressable
              style={styles.finderClose}
              onPress={() => setFinderVisible(false)}
              accessibilityRole="button"
              accessibilityLabel="Close Genie finder">
              <Ionicons name="close" size={22} color={t.color.text.foreground} />
            </Pressable>
          </View>
          <View style={styles.finderSearchBox}>
            <Ionicons name="search-outline" size={18} color={t.color.text.muted} />
            <BottomSheetTextInput
              value={finderQuery}
              onChangeText={setFinderQuery}
              placeholder="Search Genie, owner, or handle"
              placeholderTextColor={t.color.text.dim}
              style={styles.finderSearchInput}
              accessibilityLabel="Search Genies"
              autoCorrect={false}
              returnKeyType="search"
            />
            {finderQuery ? (
              <Pressable
                onPress={() => setFinderQuery("")}
                style={styles.finderClear}
                accessibilityRole="button"
                accessibilityLabel="Clear Genie search">
                <Ionicons name="close-circle" size={18} color={t.color.text.muted} />
              </Pressable>
            ) : null}
          </View>
        </View>
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.finderList}>
          {finderAgents.length === 0 ? (
            <View style={styles.finderEmpty}>
              <Text style={styles.finderEmptyTitle}>No matching Genies</Text>
              <Text style={styles.finderEmptyBody}>Try a Genie name, owner, or handle.</Text>
            </View>
          ) : finderAgents.map((agent) => {
            const focused = isFocused(agent.actorId);
            const metadata = agentFinderMetadata(agent);
            return (
              <Pressable
                key={agent.actorId}
                style={[styles.finderRow, focused && styles.finderRowFocused]}
                onPress={() => handleFinderPick(agent)}
                accessibilityRole="button"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={`${agent.displayName}${metadata ? `, ${metadata}` : ""}. ${focused ? "Double tap to clear this focus" : "Double tap to add focus"}`}>
                <MessageAvatar
                  serverUrl={serverUrl}
                  roomId={roomId}
                  displayName={agent.displayName}
                  agentId={agent.agentId}
                  agentAvatar={agent.agentAvatar}
                  size={36}
                />
                <View style={styles.finderRowCopy}>
                  <Text style={styles.finderRowName} numberOfLines={1}>{agent.displayName}</Text>
                  {metadata ? (
                    <Text style={styles.finderRowMeta} numberOfLines={1}>{metadata}</Text>
                  ) : null}
                </View>
                {focused ? (
                  <Ionicons name="checkmark" size={18} color={t.color.brand.accent} />
                ) : null}
              </Pressable>
            );
          })}
        </BottomSheetScrollView>
      </BottomSheet>
    </>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 44,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
    },
    collapseButton: {
      width: 28,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    collapseGlyph: {
      fontSize: 14,
      color: t.color.text.muted,
      lineHeight: 18,
    },
    scroll: {
      flex: 1,
    },
    railBody: {
      flex: 1,
      flexDirection: "row",
      minWidth: 0,
    },
    scrollContent: {
      alignItems: "center",
      gap: 4,
      paddingHorizontal: t.spacing.xs,
    },
    agentChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.xs,
      flexShrink: 0,
      minHeight: 40,
      maxWidth: 148,
      paddingLeft: 2,
      paddingRight: t.spacing.sm,
      borderRadius: t.radii.pill,
      backgroundColor: t.color.surface.element,
    },
    avatarRing: {
      borderRadius: t.radii.pill,
      padding: 2,
      borderWidth: 2,
      borderColor: "transparent",
    },
    avatarRingFocused: {
      borderColor: t.color.brand.accent,
    },
    agentIdentity: {
      minWidth: 48,
      maxWidth: 96,
      flexShrink: 1,
    },
    agentName: {
      ...t.typography.caption,
      color: t.color.text.foreground,
      fontWeight: "600",
    },
    ownerName: {
      color: t.color.text.dim,
      fontSize: 10,
      lineHeight: 13,
    },
    findButton: {
      width: 52,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      gap: 1,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
    },
    findLabel: {
      color: t.color.brand.accent,
      fontSize: 10,
      lineHeight: 12,
    },
    collapsedBody: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingVertical: t.spacing.xs,
    },
    collapsedName: {
      ...t.typography.caption,
      color: t.color.text.foreground,
      fontWeight: "600",
      flexShrink: 1,
    },
    collapsedHint: {
      ...t.typography.caption,
      color: t.color.text.muted,
    },
    finderHeader: {
      paddingTop: t.spacing.xs,
      paddingBottom: t.spacing.sm,
    },
    finderTitleRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: t.spacing.md,
    },
    finderTitleCopy: { flex: 1 },
    finderTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    finderCount: { color: t.color.text.muted, ...t.typography.caption },
    finderClose: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.pill,
    },
    finderSearchBox: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
    },
    finderSearchInput: {
      flex: 1,
      minHeight: 44,
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    finderClear: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    finderList: { paddingBottom: t.spacing.xl },
    finderRow: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
    },
    finderRowFocused: { backgroundColor: t.color.surface.subtle },
    finderRowCopy: { flex: 1, minWidth: 0 },
    finderRowName: { color: t.color.text.foreground, ...t.typography.bodyStrong },
    finderRowMeta: { color: t.color.text.dim, ...t.typography.caption },
    finderEmpty: {
      paddingVertical: t.spacing.xl,
      alignItems: "center",
      gap: t.spacing.sm,
    },
    finderEmptyTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    finderEmptyBody: { color: t.color.text.muted, ...t.typography.body },
  });
}
