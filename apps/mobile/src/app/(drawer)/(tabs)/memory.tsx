import { Ionicons } from "@expo/vector-icons";
import { router, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { AppBar, useOpenAppDrawer } from "@/components/app-bar";
import {
  formatMemoryTime,
  memoryAudienceLabel,
  memoryErrorMessage,
  memorySnippet,
  memoryTypeLabel,
} from "@/features/memory/presentation";
import { getApiClient } from "@/lib/api";
import { useServers } from "@/providers/server-registry";
import { useAuth } from "@/providers/auth";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type MemoryMode = "namespace" | "scope";
type Filter = "all" | "private" | "archived";
type MemoryRow = {
  id: string;
  type: string;
  content: string;
  importance: number;
  tier: number;
  createdAt: string;
  updatedAt?: string;
  namespaceIds?: string[];
  accessList?: Array<{ displayName: string; userHandle: string }>;
  scopeOrigin?: "seed" | "scope";
  origin?: "seed" | "scope";
  score?: number;
};

const PAGE_SIZE = 30;

export default function MemoryScreen() {
  const openDrawer = useOpenAppDrawer();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { activeServer } = useServers();
  const { viewer } = useAuth();
  const isFocused = useIsFocused();
  const searchInputRef = useRef<TextInput>(null);
  const requestGeneration = useRef(0);
  const memoryModeRef = useRef<MemoryMode | null>(null);
  const [memoryMode, setMemoryMode] = useState<MemoryMode | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MemoryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<MemoryRow[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [pagingLoading, setPagingLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const updateMode = (mode: MemoryMode): void => {
    memoryModeRef.current = mode;
    setMemoryMode(mode);
  };

  const loadList = useCallback(
    async ({ cursor, refresh = false }: { cursor?: string; refresh?: boolean } = {}) => {
      const generation = ++requestGeneration.current;
      const isPaging = Boolean(cursor);
      if (isPaging) setPagingLoading(true);
      else if (refresh) setRefreshing(true);
      else setListLoading(true);
      if (!isPaging) setError(null);

      if (!activeServer) {
        if (generation === requestGeneration.current) {
          setItems([]);
          setNextCursor(null);
          setListLoading(false);
          setRefreshing(false);
        }
        return;
      }

      try {
        const response = await getApiClient(activeServer.serverUrl).listMemories({
          cursor,
          limit: PAGE_SIZE,
          includeArchive: filter === "archived",
          // The API rejects audience in scope mode. Private is only selectable
          // after a namespace envelope has identified it as supported.
          ...(filter === "private" && memoryModeRef.current === "namespace"
            ? { audience: "private" as const }
            : {}),
        });
        if (generation !== requestGeneration.current) return;
        updateMode(response.memoryMode);
        setNextCursor(response.nextCursor);
        setItems((previous) => {
          if (!cursor) return response.items;
          const known = new Set(previous.map((item) => item.id));
          return [...previous, ...response.items.filter((item) => !known.has(item.id))];
        });
      } catch (caught) {
        if (generation !== requestGeneration.current) return;
        setError(memoryErrorMessage(caught, "load"));
        if (!cursor) {
          setItems([]);
          setNextCursor(null);
        }
      } finally {
        if (generation === requestGeneration.current) {
          setListLoading(false);
          setPagingLoading(false);
          setRefreshing(false);
        }
      }
    },
    [activeServer, filter],
  );

  const performSearch = useCallback(
    async (searchQuery: string, refresh = false) => {
      const generation = ++requestGeneration.current;
      if (refresh) setRefreshing(true);
      else setSearchLoading(true);
      setSearchError(null);

      if (!activeServer) {
        if (generation === requestGeneration.current) {
          setSearchResults([]);
          setSearchLoading(false);
          setRefreshing(false);
        }
        return;
      }

      try {
        const response = await getApiClient(activeServer.serverUrl).searchMemories({
          q: searchQuery,
          mode: "text",
          limit: PAGE_SIZE,
          includeArchive: filter === "archived",
        });
        if (generation !== requestGeneration.current) return;
        updateMode(response.memoryMode);
        setSearchResults(response.results);
      } catch (caught) {
        if (generation !== requestGeneration.current) return;
        setSearchError(memoryErrorMessage(caught, "search"));
        setSearchResults([]);
      } finally {
        if (generation === requestGeneration.current) {
          setSearchLoading(false);
          setRefreshing(false);
        }
      }
    },
    [activeServer, filter],
  );

  useEffect(() => {
    // A server can use the other memory-envelope mode. Do not carry a prior
    // namespace-mode capability assumption into the new server's requests.
    memoryModeRef.current = null;
    setMemoryMode(null);
    setFilter("all");
    setItems([]);
    setNextCursor(null);
  }, [activeServer?.serverUrl]);

  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!trimmedQuery) {
      setSearchResults(null);
      setSearchError(null);
      void loadList();
      return;
    }

    // The public client does not expose AbortSignal for these wrappers. Advance
    // the generation as soon as input changes so an already-running response
    // cannot replace the body during the debounce window.
    requestGeneration.current += 1;
    setSearchResults(null);
    setSearchLoading(true);
    const timer = setTimeout(() => {
      void performSearch(trimmedQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [loadList, performSearch, trimmedQuery]);

  // Detail mutations are server-authoritative. Re-fetch the active list or
  // search when this tab regains focus so snippets, access state, archives,
  // and deletions never remain stale after returning from a detail screen.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    const regainedFocus = isFocused && !wasFocusedRef.current;
    wasFocusedRef.current = isFocused;
    if (!regainedFocus) return;
    if (trimmedQuery) void performSearch(trimmedQuery, true);
    else void loadList({ refresh: true });
  }, [isFocused, loadList, performSearch, trimmedQuery]);

  const selectFilter = (nextFilter: Filter): void => {
    if (nextFilter === "private" && memoryMode !== "namespace") return;
    setFilter(nextFilter);
  };

  const clearSearch = (): void => {
    setQuery("");
    searchInputRef.current?.focus();
  };

  const refresh = (): void => {
    if (trimmedQuery) void performSearch(trimmedQuery, true);
    else void loadList({ refresh: true });
  };

  const rows = searchResults ?? items;
  const isSearching = Boolean(trimmedQuery);
  const activeError = isSearching ? searchError : error;
  const isInitialLoading = isSearching ? searchLoading && searchResults === null : listLoading;

  const renderItem = ({ item }: { item: MemoryRow }) => {
    // Search responses intentionally omit access/namespace metadata. Do not
    // infer "Private" from absent fields; that would mislabel shared results.
    const audience = isSearching
      ? "Search result"
      : memoryAudienceLabel(item, memoryMode, viewer?.handle);
    const updated = formatMemoryTime(item.updatedAt ?? item.createdAt);
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => router.push({ pathname: "/memory/[id]", params: { id: item.id } })}
        accessibilityRole="button"
        accessibilityLabel={`${memoryTypeLabel(item.type)} memory: ${memorySnippet(item.content, 80)}`}
      >
        <View style={styles.rowIcon}>
          <Ionicons name="sparkles-outline" size={20} color={t.color.brand.accent} />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowHeading}>
            <Text style={styles.rowType}>{memoryTypeLabel(item.type)}</Text>
            {updated ? <Text style={styles.rowTime}>{updated}</Text> : null}
          </View>
          <Text style={styles.rowContent} numberOfLines={2}>
            {memorySnippet(item.content)}
          </Text>
          <View style={styles.rowMeta}>
            <Text style={styles.rowMetaText} numberOfLines={1}>
              {audience}
            </Text>
            <Text style={styles.rowMetaText}>Tier {item.tier}</Text>
            {typeof item.score === "number" ? (
              <Text style={styles.rowMetaText}>Match {Math.round(item.score * 100)}%</Text>
            ) : null}
          </View>
        </View>
        <Ionicons name="chevron-forward" size={18} color={t.color.text.dim} />
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <AppBar title="Memory" onMenuPress={openDrawer} />

      <View style={styles.searchSection}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={20} color={t.color.text.muted} />
          <TextInput
            ref={searchInputRef}
            value={query}
            onChangeText={setQuery}
            style={styles.searchInput}
            placeholder="Search memories"
            placeholderTextColor={t.color.text.dim}
            accessibilityLabel="Search memories"
            returnKeyType="search"
            autoCorrect={false}
          />
          {query ? (
            <Pressable
              onPress={clearSearch}
              style={styles.clearButton}
              accessibilityRole="button"
              accessibilityLabel="Clear memory search"
            >
              <Ionicons name="close-circle" size={20} color={t.color.text.muted} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.chipsRow}>
          <FilterChip label="All" active={filter === "all"} onPress={() => selectFilter("all")} styles={styles} />
          {memoryMode === "namespace" && !isSearching ? (
            <FilterChip
              label="Private"
              active={filter === "private"}
              onPress={() => selectFilter("private")}
              styles={styles}
            />
          ) : null}
          <FilterChip
            label="Include archived"
            active={filter === "archived"}
            onPress={() => selectFilter("archived")}
            styles={styles}
          />
        </View>
        {memoryMode ? (
          <Text style={styles.modeHint}>
            {memoryMode === "scope"
              ? "Showing memories from your private context"
              : "Showing memories you can access"}
          </Text>
        ) : null}
      </View>

      {isInitialLoading ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading memories" />
          <Text style={styles.stateSub}>{isSearching ? "Searching memories…" : "Loading memories…"}</Text>
        </View>
      ) : activeError ? (
        <View style={styles.stateWrap}>
          <Ionicons name="cloud-offline-outline" size={30} color={t.color.text.muted} />
          <Text style={styles.stateTitle}>
            {isSearching ? "Could not search memories" : "Could not load memories"}
          </Text>
          <Text style={styles.stateSub}>{activeError}</Text>
          <Pressable style={styles.retryButton} onPress={refresh} accessibilityRole="button">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.stateWrap}>
          <Ionicons
            name={isSearching ? "search-outline" : "sparkles-outline"}
            size={34}
            color={t.color.text.muted}
          />
          <Text style={styles.stateTitle}>
            {isSearching ? "No matching memories" : "No memories yet"}
          </Text>
          <Text style={styles.stateSub}>
            {isSearching
              ? "Try different words or clear your search."
              : "Memories saved in this context will appear here."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listBody}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={t.color.brand.accent}
              accessibilityLabel="Refresh memories"
            />
          }
          onEndReached={() => {
            if (!isSearching && nextCursor && !pagingLoading) void loadList({ cursor: nextCursor });
          }}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            pagingLoading ? (
              <View style={styles.footer}>
                <ActivityIndicator color={t.color.brand.accent} />
                <Text style={styles.footerText}>Loading more memories…</Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      style={[styles.filterChip, active && styles.filterChipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} memories`}
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    searchSection: {
      backgroundColor: t.color.surface.background,
      paddingHorizontal: t.spacing.lg,
      paddingTop: t.spacing.md,
      paddingBottom: t.spacing.sm,
      gap: t.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    searchBox: {
      minHeight: 42,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.element,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    searchInput: {
      flex: 1,
      minWidth: 0,
      paddingVertical: t.spacing.sm,
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    clearButton: { padding: t.spacing.xs },
    chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
    filterChip: {
      paddingVertical: t.spacing.xs + 2,
      paddingHorizontal: t.spacing.md,
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
    modeHint: { color: t.color.text.dim, ...t.typography.caption },
    listBody: { paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingVertical: t.spacing.md,
    },
    rowPressed: { backgroundColor: t.color.surface.subtle },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: t.color.surface.element,
      alignItems: "center",
      justifyContent: "center",
    },
    rowBody: { flex: 1, minWidth: 0, gap: t.spacing.xs / 2 },
    rowHeading: { flexDirection: "row", justifyContent: "space-between", gap: t.spacing.sm },
    rowType: { flexShrink: 1, color: t.color.text.foreground, ...t.typography.label },
    rowTime: { color: t.color.text.dim, ...t.typography.caption },
    rowContent: { color: t.color.text.foreground, ...t.typography.body },
    rowMeta: { flexDirection: "row", gap: t.spacing.sm, alignItems: "center" },
    rowMetaText: { flexShrink: 1, color: t.color.text.muted, ...t.typography.caption },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginLeft: 52,
      backgroundColor: t.color.border.default,
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
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radii.pill,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    retryText: { color: t.color.text.foreground, ...t.typography.label },
    footer: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingVertical: t.spacing.lg,
    },
    footerText: { color: t.color.text.muted, ...t.typography.caption },
  });
}
