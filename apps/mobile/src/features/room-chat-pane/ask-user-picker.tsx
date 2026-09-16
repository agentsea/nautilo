import { Ionicons } from "@expo/vector-icons";
import { BottomSheetFlatList, BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { MessageAvatar } from "@/components/message-avatar";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import {
  isSearchableAskUserChoice,
  filterAskUserCandidates,
  resolveAskUserCandidates,
  type AskUserCandidate,
  type AskUserRoutingState,
} from "./ask-user-routing";
import type { RoomMemberDto } from "@nautilo/types";

export function AskUserPicker({
  choice,
  members,
  serverUrl,
  onCancel,
  onSelect,
}: {
  choice: AskUserRoutingState | null;
  members: readonly RoomMemberDto[];
  serverUrl: string | undefined;
  onCancel: () => void;
  onSelect: (botActorId: string) => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const candidates = useMemo(
    () => choice ? resolveAskUserCandidates(choice.options, members) : [],
    [choice, members],
  );
  const searchable = isSearchableAskUserChoice(candidates.length);
  const visibleCandidates = useMemo(
    () => searchable ? filterAskUserCandidates(candidates, query) : candidates,
    [candidates, query, searchable],
  );

  useEffect(() => {
    if (!choice) setQuery("");
  }, [choice]);

  const renderCandidate = useCallback(({ item }: { item: AskUserCandidate }) => {
    const selecting = choice?.selectingActorId === item.botActorId;
    const disabled = !choice?.originalContent || choice.selectingActorId !== null;
    return (
      <Pressable
        style={[styles.row, selecting && styles.rowPending]}
        disabled={disabled}
        onPress={() => onSelect(item.botActorId)}
        accessibilityRole="button"
        accessibilityLabel={`Ask ${item.displayName} to reply`}
        accessibilityState={{ disabled, busy: selecting }}>
        {serverUrl ? (
          <MessageAvatar
            serverUrl={serverUrl}
            roomId={choice?.roomId ?? ""}
            displayName={item.displayName}
            agentId={item.agentId}
            agentAvatar={item.agentAvatar}
            size={36}
          />
        ) : (
          <View style={styles.avatarFallback}><Text style={styles.avatarFallbackText}>?</Text></View>
        )}
        <View style={styles.rowCopy}>
          <Text style={styles.rowName} numberOfLines={1}>{item.displayName}</Text>
          <Text style={styles.rowHandle} numberOfLines={1}>{item.displayHandle}</Text>
        </View>
        {selecting ? <ActivityIndicator size="small" color={t.color.brand.accent} /> : <Ionicons name="chevron-forward" size={18} color={t.color.text.dim} />}
      </Pressable>
    );
  }, [choice, onSelect, serverUrl, styles, t.color.brand.accent, t.color.text.dim]);

  const initialContentReady = Boolean(choice?.originalContent);
  return (
    <BottomSheet
      visible={choice !== null}
      onClose={onCancel}
      snapPoints={searchable || candidates.length > 3 ? ["75%"] : ["50%"]}
      backdrop>
      <View style={styles.header} accessibilityViewIsModal>
        <View style={styles.titleRow}>
          <View style={styles.titleCopy}>
            <Text style={styles.title}>Choose who should reply</Text>
            <Text style={styles.subtitle}>This sends your original message to one Genie.</Text>
          </View>
          <Pressable
            style={styles.closeButton}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel choosing a Genie">
            <Ionicons name="close" size={22} color={t.color.text.foreground} />
          </Pressable>
        </View>
        {searchable ? (
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={18} color={t.color.text.muted} />
            <BottomSheetTextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search Genies"
              placeholderTextColor={t.color.text.dim}
              autoCorrect={false}
              returnKeyType="search"
              style={styles.searchInput}
              accessibilityLabel="Search Genie candidates"
            />
            {query ? (
              <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="Clear Genie search">
                <Ionicons name="close-circle" size={18} color={t.color.text.muted} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {!initialContentReady ? <Text style={styles.pendingCopy}>Preparing your original message…</Text> : null}
        {choice?.retryable ? <Text style={styles.retryCopy}>Could not send that choice. Tap a Genie to try again.</Text> : null}
      </View>
      {searchable ? (
        <BottomSheetFlatList
          data={visibleCandidates}
          keyExtractor={(item) => item.botActorId}
          renderItem={renderCandidate}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          style={[styles.list, { height: Math.max(200, height * 0.42) }]}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={<Text style={styles.empty}>No Genie matches that search.</Text>}
        />
      ) : (
        <View style={styles.directList}>{visibleCandidates.map((candidate) => (
          <View key={candidate.botActorId}>{renderCandidate({ item: candidate })}</View>
        ))}</View>
      )}
    </BottomSheet>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    header: { gap: t.spacing.sm, paddingTop: t.spacing.xs },
    titleRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.sm },
    titleCopy: { flex: 1, gap: 2 },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    subtitle: { ...t.typography.caption, color: t.color.text.muted },
    closeButton: { width: 44, height: 44, borderRadius: t.radii.pill, alignItems: "center", justifyContent: "center" },
    searchBox: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.element },
    searchInput: { flex: 1, minHeight: 48, color: t.color.text.foreground, ...t.typography.body },
    pendingCopy: { ...t.typography.caption, color: t.color.text.muted },
    retryCopy: { ...t.typography.caption, color: t.color.status.error },
    list: { marginTop: t.spacing.sm },
    listContent: { paddingBottom: t.spacing.xl },
    directList: { marginTop: t.spacing.sm, gap: t.spacing.xs },
    row: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, minHeight: 60, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm, borderRadius: t.radii.md },
    rowPending: { backgroundColor: t.color.surface.subtle },
    rowCopy: { flex: 1, gap: 2, minWidth: 0 },
    rowName: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    rowHandle: { ...t.typography.caption, color: t.color.text.muted },
    avatarFallback: { width: 36, height: 36, borderRadius: t.radii.pill, alignItems: "center", justifyContent: "center", backgroundColor: t.color.surface.element },
    avatarFallbackText: { ...t.typography.caption, color: t.color.text.muted },
    empty: { ...t.typography.body, color: t.color.text.muted, paddingVertical: t.spacing.xl, textAlign: "center" },
  });
}
