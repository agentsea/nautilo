import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { RemoteHostFileEntry, RemoteHostFileRootKind } from "@nautilo/api-client/browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import {
  computerFilesPresentation,
  listComputerFiles,
  parentRelativePath,
  pairedFilesystemDisplayPath,
  readComputerFilePreview,
  rootTitle,
  selectComputerCurrentFolder,
} from "@/features/remote/computer-files";
import { useRemoteHosts } from "@/features/remote/remote-hosts";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import { base64ToBytes } from "@/lib/base64";

type BrowserState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly entries: readonly RemoteHostFileEntry[]; readonly nextCursor: string | null }
  | { readonly kind: "error"; readonly error: unknown };

type PreviewState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly name: string }
  | { readonly kind: "ready"; readonly name: string; readonly text: string | null }
  | { readonly kind: "error"; readonly name: string; readonly error: unknown };

const PAGE_SIZE = 50;

export default function ComputerFilesBrowserScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { activeServer } = useServers();
  const params = useLocalSearchParams<{
    remoteHostId?: string | string[];
    rootKind?: string | string[];
    path?: string | string[];
    mode?: string | string[];
    locationLabel?: string | string[];
  }>();
  const remoteHostId = firstParam(params.remoteHostId);
  const rootKind = asRootKind(firstParam(params.rootKind));
  const routePath = firstParam(params.path) ?? "";
  const locationLabel = firstParam(params.locationLabel);
  const relativePath = validRelativePath(routePath) ? routePath : "";
  const selecting = firstParam(params.mode) === "choose";
  const { hosts } = useRemoteHosts();
  const host = hosts.find((candidate) => candidate.remoteHostId === remoteHostId);
  const hostLabel = host?.label ?? "this computer";
  const requestGeneration = useRef(0);
  const [state, setState] = useState<BrowserState>({ kind: "loading" });
  const stateRef = useRef<BrowserState>(state);
  stateRef.current = state;
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selectingFolder, setSelectingFolder] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timeout);
  }, [query]);

  const target = useMemo(
    () => activeServer ? {
      id: activeServer.id,
      serverUrl: activeServer.serverUrl,
      displayName: activeServer.displayName,
    } : null,
    [activeServer],
  );

  const load = useCallback(async (mode: "initial" | "refresh" | "more") => {
    if (!target || !remoteHostId || !rootKind || !validRelativePath(routePath)) {
      setState({ kind: "error", error: new Error("This computer folder is no longer available.") });
      return;
    }
    const previous = stateRef.current.kind === "ready" ? stateRef.current : null;
    const cursor = mode === "more" ? previous?.nextCursor ?? null : null;
    if (mode === "more" && !cursor) return;
    const generation = ++requestGeneration.current;
    if (mode === "initial" && !previous) setState({ kind: "loading" });
    if (mode === "initial" && previous) setUpdating(true);
    if (mode === "refresh") setRefreshing(true);
    if (mode === "more") setLoadingMore(true);
    try {
      const response = await listComputerFiles(target, {
        remoteHostId,
        rootKind,
        relativePath,
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
        includeHidden: showHidden,
        query: debouncedQuery,
      });
      if (generation !== requestGeneration.current) return;
      setState({
        kind: "ready",
        entries: mode === "more" ? [...(previous?.entries ?? []), ...response.entries] : response.entries,
        nextCursor: response.nextCursor,
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setState({ kind: "error", error });
    } finally {
      if (generation === requestGeneration.current) {
        setRefreshing(false);
        setUpdating(false);
        setLoadingMore(false);
      }
    }
  }, [debouncedQuery, relativePath, remoteHostId, rootKind, routePath, showHidden, target]);

  useEffect(() => {
    void load("initial");
  }, [load]);

  const openEntry = (entry: RemoteHostFileEntry): void => {
    if (entry.isDirectory) {
      navigateToRelative(entry.path, entry.name);
      return;
    }
    void openPreview(entry);
  };

  const navigateToRelative = (path: string, enteredLocationLabel?: string): void => {
    if (!remoteHostId || !rootKind) return;
    const nextLocationLabel = rootKind === "paired_filesystem"
      ? relativePath === "" ? enteredLocationLabel : locationLabel
      : undefined;
    router.push({
      pathname: "/files/computer/[remoteHostId]/[rootKind]",
      params: {
        remoteHostId,
        rootKind,
        ...(path ? { path } : {}),
        ...(selecting ? { mode: "choose" } : {}),
        ...(nextLocationLabel ? { locationLabel: nextLocationLabel } : {}),
      },
    });
  };

  const confirmSelection = (): void => {
    if (!target || !remoteHostId || !rootKind || selectingFolder) return;
    if (rootKind === "paired_filesystem" && relativePath === "") return;
    const shownPath = rootKind === "paired_filesystem"
      ? pairedFilesystemDisplayPath(relativePath, locationLabel)
      : `${rootTitle(rootKind)}${relativePath ? ` / ${relativePath}` : ""}`;
    Alert.alert(
      `Change Current Folder on ${hostLabel}?`,
      `${shownPath}\n\nJeannie will use this location for local file and shell operations on this computer.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Use folder",
          onPress: () => {
            setSelectingFolder(true);
            void selectComputerCurrentFolder(target, {
              remoteHostId,
              sourceRootKind: rootKind,
              relativePath,
            }).then((result) => {
              Alert.alert(
                "Current Folder changed",
                `${result.label} is now the Current Folder on ${hostLabel}.`,
                [{
                  text: "Done",
                  onPress: () => router.replace({
                    pathname: "/(drawer)/computers/[remoteHostId]",
                    params: { remoteHostId },
                  }),
                }],
              );
            }).catch((error) => {
              const presentation = computerFilesPresentation(error);
              Alert.alert(presentation.title, presentation.detail);
            }).finally(() => setSelectingFolder(false));
          },
        },
      ],
    );
  };

  const openPreview = async (entry: RemoteHostFileEntry): Promise<void> => {
    if (!target || !remoteHostId || !rootKind) return;
    setPreview({ kind: "loading", name: entry.name });
    try {
      const response = await readComputerFilePreview(target, {
        remoteHostId,
        rootKind,
        relativePath: entry.path,
      });
      setPreview({
        kind: "ready",
        name: entry.name,
        text: decodeTextPreview(response.dataBase64),
      });
    } catch (error) {
      setPreview({ kind: "error", name: entry.name, error });
    }
  };

  const parent = parentRelativePath(relativePath);
  const displayedRelativePath = rootKind === "paired_filesystem"
    ? pairedFilesystemDisplayPath(relativePath, locationLabel)
    : relativePath || "Root";
  const title = selecting ? "Choose Current Folder" : rootKind ? rootTitle(rootKind) : "Computer files";
  const stateError = state.kind === "error"
    ? computerFilesPresentation(state.error)
    : computerFilesPresentation(new Error("transport"));
  const canChooseReplacement = state.kind === "error" && rootKind === "current_folder" &&
    (errorCodeForSelection(state.error) === "no_current_folder" || errorCodeForSelection(state.error) === "root_stale");

  const chooseReplacement = (): void => {
    if (!remoteHostId) return;
    router.replace({
      pathname: "/files/computer/[remoteHostId]/[rootKind]",
      params: { remoteHostId, rootKind: "paired_filesystem", mode: "choose" },
    });
  };

  return (
    <View style={styles.container}>
      <AppBar title={title} left={<AppBarBackButton onPress={() => router.back()} />} />
      {state.kind === "loading" ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={theme.color.brand.accent} accessibilityLabel="Loading computer files" />
          <Text style={styles.stateDetail}>Loading this computer’s files…</Text>
        </View>
      ) : state.kind === "error" ? (
        <View style={styles.stateWrap} accessibilityRole="alert">
          <Ionicons name="cloud-offline-outline" size={34} color={theme.color.text.muted} />
          <Text style={styles.stateTitle}>{stateError.title}</Text>
          <Text style={styles.stateDetail}>{stateError.detail}</Text>
          {canChooseReplacement ? (
            <Pressable style={styles.primaryAction} onPress={chooseReplacement}
              accessibilityRole="button" accessibilityLabel="Choose Current Folder on this computer">
              <Text style={styles.primaryActionText}>Choose a folder</Text>
            </Pressable>
          ) : null}
          {stateError.retryable ? (
            <Pressable style={styles.actionButton} onPress={() => void load("initial")}
              accessibilityRole="button" accessibilityLabel={stateError.retryLabel ?? "Try again"}>
              <Text style={styles.actionText}>{stateError.retryLabel ?? "Try again"}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.secondaryAction} onPress={() => router.back()}
            accessibilityRole="button" accessibilityLabel="Return to computer sources">
            <Text style={styles.actionText}>Back to computer</Text>
          </Pressable>
        </View>
      ) : state.kind === "ready" ? (
          <FlatList
            style={styles.browserBody}
            data={state.entries}
            keyExtractor={(entry) => entry.path}
            contentContainerStyle={styles.listBody}
            alwaysBounceVertical
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={<View style={styles.listHeader}>
              <Text style={styles.relativePath} numberOfLines={1}>{displayedRelativePath}</Text>
              <Text style={styles.listHint}>
                {selecting
                  ? relativePath
                    ? `Choosing on ${hostLabel}. Opening folders does not change anything.`
                    : rootKind === "paired_filesystem"
                      ? "Choose a location, then open a folder. Nothing changes until you confirm."
                      : "Open a folder to choose it. Nothing changes until you confirm."
                  : `Showing files relative to this ${title.toLowerCase()}.`}
              </Text>
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={19} color={theme.color.text.muted} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search this folder"
                  placeholderTextColor={theme.color.text.dim}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  accessibilityLabel="Search this folder"
                  style={styles.searchInput}
                />
                {query ? <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="Clear folder search" style={styles.clearSearch}>
                  <Ionicons name="close-circle" size={20} color={theme.color.text.muted} />
                </Pressable> : null}
              </View>
              <View style={styles.hiddenRow}>
                <Text style={styles.hiddenLabel}>Show hidden files</Text>
                <Switch
                  value={showHidden}
                  onValueChange={setShowHidden}
                  accessibilityLabel="Show hidden files"
                  trackColor={{ false: theme.color.border.default, true: theme.color.brand.accent }}
                />
              </View>
              {updating ? <View style={styles.updatingRow} accessibilityLabel="Updating folder contents">
                <ActivityIndicator size="small" color={theme.color.brand.accent} />
                <Text style={styles.updatingText}>Updating folder…</Text>
              </View> : null}
              {parent !== null ? (
                <Pressable style={styles.parentButton} onPress={() => navigateToRelative(parent)} accessibilityRole="button" accessibilityLabel="Go to parent folder">
                  <Ionicons name="arrow-up-outline" size={18} color={theme.color.brand.accent} />
                  <Text style={styles.parentText}>Up one folder</Text>
                </Pressable>
              ) : null}
            </View>}
            refreshControl={<RefreshControl
              refreshing={refreshing}
              onRefresh={() => void load("refresh")}
              tintColor={theme.color.brand.accent}
              accessibilityLabel="Refresh computer files"
            />}
            ListEmptyComponent={<View style={styles.emptyWrap}>
              <Ionicons name="folder-open-outline" size={32} color={theme.color.text.muted} />
              <Text style={styles.emptyTitle}>{debouncedQuery ? "No matching files" : "No files here"}</Text>
              <Text style={styles.emptyDetail}>{debouncedQuery ? "Try another name or show hidden files." : "This folder is empty."}</Text>
            </View>}
            renderItem={({ item }) => <EntryRow entry={item} onPress={() => openEntry(item)} theme={theme} styles={styles} />}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListFooterComponent={state.nextCursor ? (
              <Pressable
                style={[styles.moreButton, loadingMore && styles.disabled]}
                disabled={loadingMore}
                onPress={() => void load("more")}
                accessibilityRole="button"
                accessibilityLabel="Load more computer files"
              >
                {loadingMore ? <ActivityIndicator color={theme.color.brand.accent} /> : <Text style={styles.actionText}>Load more</Text>}
              </Pressable>
            ) : <View style={styles.listEnd} />}
          />
      ) : null}
      {state.kind === "ready" && selecting ? (
        <View style={[styles.selectionBar, { paddingBottom: Math.max(Number(insets.bottom), theme.spacing.md) }]}>
          <View style={styles.selectionCopy}>
            <Text style={styles.selectionEyebrow}>USE ON {hostLabel.toUpperCase()}</Text>
            <Text style={styles.selectionPath} numberOfLines={2}>
              {rootKind === "paired_filesystem"
                ? pairedFilesystemDisplayPath(relativePath, locationLabel)
                : `${rootKind ? rootTitle(rootKind) : "Folder"}${relativePath ? ` / ${relativePath}` : ""}`}
            </Text>
          </View>
          <Pressable
            style={[styles.useFolderButton, (selectingFolder || (rootKind === "paired_filesystem" && relativePath === "")) && styles.disabled]}
            disabled={selectingFolder || (rootKind === "paired_filesystem" && relativePath === "")}
            onPress={confirmSelection}
            accessibilityRole="button"
            accessibilityLabel={`Use this folder as Current Folder on ${hostLabel}`}
          >
            {selectingFolder
              ? <ActivityIndicator color={theme.color.text.onPrimary} />
              : <Text style={styles.useFolderText}>Use this folder</Text>}
          </Pressable>
        </View>
      ) : null}
      <PreviewModal preview={preview} close={() => setPreview({ kind: "idle" })} theme={theme} styles={styles} />
    </View>
  );
}

function EntryRow({ entry, onPress, theme, styles }: {
  entry: RemoteHostFileEntry;
  onPress: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  const actionable = !entry.isSymbolicLink;
  const label = entry.isSymbolicLink
    ? "Linked item unavailable"
    : entry.isDirectory ? "Open folder" : "Preview file";
  return (
    <Pressable style={[styles.entryRow, !actionable && styles.disabled]} onPress={onPress} disabled={!actionable}
      accessibilityRole="button" accessibilityState={{ disabled: !actionable }}
      accessibilityLabel={`${label} ${entry.name}`}
      accessibilityHint={entry.isSymbolicLink ? "Links are not opened from Computer Files." : undefined}>
      <View style={styles.entryIcon}>
        <Ionicons name={entry.isDirectory ? "folder-outline" : "document-outline"} size={21} color={theme.color.brand.accent} />
      </View>
      <Text style={styles.entryName} numberOfLines={1}>{entry.name}</Text>
      {entry.isSymbolicLink ? <Text style={styles.linkBadge}>Link</Text> : null}
      {actionable ? <Ionicons name="chevron-forward" size={19} color={theme.color.text.muted} /> : null}
    </Pressable>
  );
}

function PreviewModal({ preview, close, theme, styles }: {
  preview: PreviewState;
  close: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  if (preview.kind === "idle") return null;
  const error = preview.kind === "error" ? computerFilesPresentation(preview.error) : null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={styles.modalRoot}>
        <Pressable style={styles.modalBackdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Dismiss preview" />
        <View style={styles.previewPanel}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle} numberOfLines={1}>{preview.name}</Text>
            <Pressable style={styles.closeButton} onPress={close} accessibilityRole="button" accessibilityLabel="Close preview">
              <Ionicons name="close" size={22} color={theme.color.text.foreground} />
            </Pressable>
          </View>
          {preview.kind === "loading" ? <View style={styles.previewState}><ActivityIndicator color={theme.color.brand.accent} /><Text style={styles.stateDetail}>Preparing preview…</Text></View> :
          preview.kind === "error" ? <View style={styles.previewState} accessibilityRole="alert"><Text style={styles.stateTitle}>{error?.title}</Text><Text style={styles.stateDetail}>{error?.detail}</Text></View> :
          preview.text === null ? <View style={styles.previewState}><Ionicons name="document-outline" size={32} color={theme.color.text.muted} /><Text style={styles.stateTitle}>Binary file</Text><Text style={styles.stateDetail}>This file is available on the computer but cannot be shown as text here.</Text></View> :
          <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewBody}><Text selectable style={styles.previewText}>{preview.text}</Text></ScrollView>}
        </View>
      </View>
    </Modal>
  );
}

function decodeTextPreview(dataBase64: string): string | null {
  try {
    const bytes = base64ToBytes(dataBase64);
    // A NUL is a useful, conservative signal that the file is not text.
    if (bytes.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asRootKind(value: string | undefined): RemoteHostFileRootKind | null {
  return value === "workspace" || value === "current_folder" || value === "paired_filesystem" ? value : null;
}

function validRelativePath(value: string): boolean {
  return !value.includes("\0") && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === ".");
}

function errorCodeForSelection(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("message" in error && typeof error.message === "string") return error.message.trim().toLowerCase();
  return null;
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface.background },
    stateWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing.sm, padding: theme.spacing.xl },
    stateTitle: { color: theme.color.text.foreground, ...theme.typography.subheading, textAlign: "center" },
    stateDetail: { color: theme.color.text.muted, ...theme.typography.body, textAlign: "center" },
    actionButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing.lg, borderRadius: theme.radii.sm, borderWidth: 1, borderColor: theme.color.border.default },
    primaryAction: { minHeight: 48, justifyContent: "center", paddingHorizontal: theme.spacing.lg, borderRadius: theme.radii.sm, backgroundColor: theme.color.brand.accent },
    primaryActionText: { color: theme.color.text.onPrimary, ...theme.typography.label },
    secondaryAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing.lg, borderRadius: theme.radii.sm, borderWidth: 1, borderColor: theme.color.border.default },
    actionText: { color: theme.color.brand.accent, ...theme.typography.label },
    browserBody: { flex: 1 },
    listBody: { flexGrow: 1, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxl },
    listHeader: { gap: theme.spacing.xs, paddingTop: theme.spacing.md, paddingBottom: theme.spacing.sm },
    relativePath: { color: theme.color.text.foreground, ...theme.typography.bodyStrong },
    listHint: { color: theme.color.text.dim, ...theme.typography.caption },
    searchBox: { minHeight: 46, marginTop: theme.spacing.sm, paddingHorizontal: theme.spacing.md, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.sm, backgroundColor: theme.color.surface.element },
    searchInput: { flex: 1, minHeight: 44, color: theme.color.text.foreground, ...theme.typography.body },
    clearSearch: { minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" },
    hiddenRow: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    hiddenLabel: { color: theme.color.text.foreground, ...theme.typography.body },
    updatingRow: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
    updatingText: { color: theme.color.text.muted, ...theme.typography.caption },
    parentButton: { alignSelf: "flex-start", minHeight: 40, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, paddingHorizontal: theme.spacing.sm, marginTop: theme.spacing.xs },
    parentText: { color: theme.color.brand.accent, ...theme.typography.label },
    entryRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: theme.spacing.md, paddingVertical: theme.spacing.sm },
    entryIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surface.element },
    entryName: { flex: 1, color: theme.color.text.foreground, ...theme.typography.body },
    linkBadge: { color: theme.color.text.muted, ...theme.typography.caption },
    separator: { height: StyleSheet.hairlineWidth, marginLeft: 54, backgroundColor: theme.color.border.default },
    emptyWrap: { alignItems: "center", gap: theme.spacing.sm, paddingVertical: theme.spacing.xxl },
    emptyTitle: { color: theme.color.text.foreground, ...theme.typography.subheading },
    emptyDetail: { color: theme.color.text.muted, ...theme.typography.body },
    moreButton: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: theme.spacing.md, borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.sm },
    listEnd: { height: theme.spacing.xl },
    selectionBar: { flexDirection: "row", alignItems: "center", gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.default, backgroundColor: theme.color.surface.background },
    selectionCopy: { flex: 1, gap: 2 },
    selectionEyebrow: { color: theme.color.text.dim, ...theme.typography.caption },
    selectionPath: { color: theme.color.text.foreground, ...theme.typography.label },
    useFolderButton: { minHeight: 48, minWidth: 138, alignItems: "center", justifyContent: "center", paddingHorizontal: theme.spacing.md, borderRadius: theme.radii.sm, backgroundColor: theme.color.brand.accent },
    useFolderText: { color: theme.color.text.onPrimary, ...theme.typography.label },
    disabled: { opacity: 0.5 },
    modalRoot: { flex: 1, justifyContent: "flex-end" },
    modalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0, 0, 0, 0.48)" },
    previewPanel: { maxHeight: "78%", minHeight: 240, backgroundColor: theme.color.surface.background, borderTopLeftRadius: theme.radii.lg, borderTopRightRadius: theme.radii.lg, overflow: "hidden" },
    previewHeader: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, paddingLeft: theme.spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border.default },
    previewTitle: { flex: 1, color: theme.color.text.foreground, ...theme.typography.subheading },
    closeButton: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
    previewState: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: theme.spacing.sm, padding: theme.spacing.lg },
    previewScroll: { flexGrow: 0 },
    previewBody: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxl },
    previewText: { color: theme.color.text.foreground, ...theme.typography.body },
  });
}
