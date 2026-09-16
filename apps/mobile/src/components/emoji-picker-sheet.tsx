import AsyncStorage from "@react-native-async-storage/async-storage";
import { BottomSheetFlatList, BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BackHandler,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import {
  filterMobileEmoji,
  MOBILE_EMOJI_CATALOGUE,
  MOBILE_EMOJI_CATEGORIES,
  recordRecentEmoji,
  type MobileEmoji,
} from "@/features/reactions/mobile-emoji-catalogue";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

const RECENT_EMOJI_KEY = "nautilo.mobile.reactions.recent.v1";
const KNOWN_EMOJI = new Set(MOBILE_EMOJI_CATALOGUE.map((entry) => entry.emoji));

export function EmojiPickerSheet({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [recent, setRecent] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setCategory(null);
    void AsyncStorage.getItem(RECENT_EMOJI_KEY).then((raw) => {
      if (raw == null) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setRecent(parsed.filter((entry): entry is string =>
            typeof entry === "string" && KNOWN_EMOJI.has(entry),
          ).slice(0, 24));
        }
      } catch {
        // Corrupt cosmetic history must never prevent someone from reacting.
      }
    }).catch(() => undefined);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, visible]);

  const filtered = useMemo(
    () => filterMobileEmoji(query, category),
    [category, query],
  );
  const pick = useCallback((emoji: string) => {
    const next = recordRecentEmoji(recent, emoji);
    setRecent(next);
    void AsyncStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)).catch(() => undefined);
    onPick(emoji);
    onClose();
  }, [onClose, onPick, recent]);
  const renderEmoji = useCallback(({ item }: { item: MobileEmoji }) => (
    <Pressable
      style={styles.emojiButton}
      onPress={() => pick(item.emoji)}
      accessibilityRole="button"
      accessibilityLabel={`React with ${item.name}`}>
      <Text style={styles.emoji}>{item.emoji}</Text>
    </Pressable>
  ), [pick, styles]);

  return (
    <BottomSheet visible={visible} onClose={onClose} snapPoints={["90%"]} backdrop>
      <View style={styles.header} accessibilityViewIsModal>
        <Text style={styles.title}>Choose a reaction</Text>
        <BottomSheetTextInput
          value={query}
          onChangeText={(value) => {
            setQuery(value);
            if (value.trim()) setCategory(null);
          }}
          placeholder="Search emoji"
          placeholderTextColor={t.color.text.muted}
          autoCorrect={false}
          returnKeyType="search"
          style={styles.search}
          accessibilityLabel="Search emoji"
        />
      </View>
      {recent.length > 0 && !query ? (
        <View style={styles.recentBlock}>
          <Text style={styles.sectionLabel}>Recently used</Text>
          <FlatList
            horizontal
            data={recent}
            keyExtractor={(emoji) => emoji}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <Pressable
                style={styles.emojiButton}
                onPress={() => pick(item)}
                accessibilityRole="button"
                accessibilityLabel={`React with ${item}`}>
                <Text style={styles.emoji}>{item}</Text>
              </Pressable>
            )}
          />
        </View>
      ) : null}
      <FlatList
        horizontal
        data={MOBILE_EMOJI_CATEGORIES}
        keyExtractor={(item) => item.slug}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.categories}
        renderItem={({ item }) => {
          const active = item.slug === category;
          return (
            <Pressable
              style={[styles.categoryButton, active && styles.categoryButtonActive]}
              onPress={() => {
                setQuery("");
                setCategory(active ? null : item.slug);
              }}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              accessibilityState={{ selected: active }}>
              <Text style={styles.categoryEmoji}>{item.icon}</Text>
            </Pressable>
          );
        }}
      />
      <Text style={styles.resultLabel}>
        {query ? `${filtered.length} results` : category == null ? "All emoji" :
          MOBILE_EMOJI_CATEGORIES.find((entry) => entry.slug === category)?.name}
      </Text>
      <BottomSheetFlatList
        data={filtered}
        keyExtractor={(item: MobileEmoji) => item.emoji}
        renderItem={renderEmoji}
        numColumns={8}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator
        style={{ height: Math.max(220, height * 0.48) }}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={<Text style={styles.empty}>No emoji match that search.</Text>}
      />
    </BottomSheet>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    header: { gap: t.spacing.sm, paddingTop: t.spacing.xs },
    title: { ...t.typography.heading, color: t.color.text.foreground },
    search: {
      ...t.typography.body,
      minHeight: 48,
      paddingHorizontal: t.spacing.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.element,
    },
    recentBlock: { gap: t.spacing.xs, marginTop: t.spacing.md },
    sectionLabel: { ...t.typography.label, color: t.color.text.muted },
    categories: { gap: t.spacing.xs, paddingVertical: t.spacing.md },
    categoryButton: {
      width: 44,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    categoryButtonActive: {
      borderColor: t.color.brand.accent,
      backgroundColor: t.color.surface.subtle,
    },
    categoryEmoji: { fontSize: 20 },
    resultLabel: { ...t.typography.label, color: t.color.text.muted, marginBottom: t.spacing.xs },
    grid: { paddingBottom: t.spacing.xl },
    emojiButton: {
      flex: 1,
      minWidth: 40,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.sm,
    },
    emoji: { fontSize: 25, lineHeight: 31 },
    empty: { ...t.typography.body, color: t.color.text.muted, paddingVertical: t.spacing.xl },
  });
}
