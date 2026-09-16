import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentPhotoLibraryApiError } from "@nautilo/api-client/browser";
import type {
  AgentPhotoLibraryCreateResponse,
  AgentPhotoLibraryEntryDto,
  AgentPhotoLibraryScopeDto,
  AgentPhotoLibrarySelectionResponse,
} from "@nautilo/types";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { ChangeAgentPhotoSheet } from "@/features/settings/change-agent-photo-sheet";
import {
  AgentPhotoLibraryReadDeadlineError,
  AGENT_PHOTO_PRIMARY_SECTIONS,
  agentPhotoLibraryCatalogueIsPresentable,
  agentPhotoMutationCompletionDisposition,
  applyAgentPhotoProjectionPage,
  agentPhotoLibraryLayout,
  agentPhotoMediaSource,
  cancelAgentPhotoSelection,
  createAgentPhotoIdentityKey,
  createAgentPhotoMutationCoordinator,
  finishAgentPhotoSelection,
  requestAgentPhotoDelete,
  readAgentPhotoLibraryCatalogue,
  readAgentPhotoLibraryWithDeadline,
  stageAgentPhotoSelection,
} from "@/features/settings/agent-photo-library-controller";
import {
  prepareAgentAvatarUpload,
  type AgentAvatarFile,
  type PickedAgentImage,
} from "@/features/settings/agent-avatar-source";
import { getApiClient } from "@/lib/api";
import { ensureValidToken } from "@/lib/auth";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type Section = "recent" | "presets" | "upload" | "generate" | "deleted";
type Projection = "recent" | "deleted";
type PendingSelection = ReturnType<typeof stageAgentPhotoSelection>;
type RetryAction = { label: string; run: () => void };

const PAGE_SIZE = 48;

export default function AgentPhotosScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { activeServer } = useServers();
  const { refreshViewer, viewer, viewerState } = useAuth();
  const identityKey = createAgentPhotoIdentityKey({
    serverId: activeServer?.id,
    viewerId: viewer?.userId,
    viewerState,
  });

  const generation = useRef(0);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const readController = useRef<AbortController | null>(null);
  const pageController = useRef<AbortController | null>(null);
  const mutationBusy = useRef(false);
  const pageBusy = useRef(false);
  const mutations = useRef(createAgentPhotoMutationCoordinator(() => Crypto.randomUUID()));
  const [loadedIdentityKey, setLoadedIdentityKey] = useState<string | null>(null);
  const [scope, setScope] = useState<AgentPhotoLibraryScopeDto | null>(null);
  const [recent, setRecent] = useState<AgentPhotoLibraryEntryDto[]>([]);
  const [deleted, setDeleted] = useState<AgentPhotoLibraryEntryDto[]>([]);
  const [recentCursor, setRecentCursor] = useState<string | null>(null);
  const [deletedCursor, setDeletedCursor] = useState<string | null>(null);
  const [presets, setPresets] = useState<{ id: string; thumbnailUrl: string }[]>([]);
  const [currentPresetId, setCurrentPresetId] = useState<string | null>(null);
  const [undoRevisionId, setUndoRevisionId] = useState<string | null>(null);
  const [token, setToken] = useState<{ identityKey: string; value: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [mutationLabel, setMutationLabel] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState<Projection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPhotoWarning, setCurrentPhotoWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<RetryAction | null>(null);
  const [picker, setPicker] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState<1 | 2 | 3 | 4>(1);
  const [section, setSection] = useState<Section>("recent");
  const [selected, setSelected] = useState<PendingSelection>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [uploadDraft, setUploadDraft] = useState<AgentAvatarFile | null>(null);
  const [failedDeletedMedia, setFailedDeletedMedia] = useState<Set<string>>(() => new Set());

  const snapshotReady = loadedIdentityKey === identityKey;
  const busy = loading || mutating || pageLoading !== null;
  const generating = mutationLabel === "Generation";
  const layout = agentPhotoLibraryLayout({
    selected: selected !== null,
    snapshotReady,
    busy,
    safeAreaBottom: insets.bottom,
    minimumBottomSpacing: t.spacing.sm,
  });

  const clearSnapshot = useCallback(() => {
    setLoadedIdentityKey(null);
    setToken(null);
    setScope(null);
    setRecent([]);
    setDeleted([]);
    setRecentCursor(null);
    setDeletedCursor(null);
    setPresets([]);
    setCurrentPresetId(null);
    setUndoRevisionId(null);
    setSelected(null);
    setConfirmDelete(null);
    setRetry(null);
    setError(null);
    setCurrentPhotoWarning(null);
    setNotice(null);
    setPicker(false);
    setPrompt("");
    setUploadDraft(null);
    setSection("recent");
    setFailedDeletedMedia(new Set());
  }, []);

  useEffect(() => {
    generation.current += 1;
    readController.current?.abort();
    pageController.current?.abort();
    mutations.current.abortAndReset();
    mutationBusy.current = false;
    pageBusy.current = false;
    setMutating(false);
    setLoading(false);
    setPageLoading(null);
    clearSnapshot();
  }, [clearSnapshot, identityKey]);

  const load = useCallback(async (options: { clearMessage?: boolean } = {}) => {
    if (!activeServer || viewerState !== "verified" || !viewer) {
      setLoading(false);
      return false;
    }
    const requestIdentityKey = identityKey;
    const requestGeneration = ++generation.current;
    readController.current?.abort();
    const abort = new AbortController();
    readController.current = abort;
    setLoading(true);
    if (options.clearMessage !== false) {
      setError(null);
      setRetry(null);
    }
    try {
      const api = getApiClient(activeServer.serverUrl);
      const [current, currentWarning, recentPage, deletedPage, presetPage, accessToken] = await readAgentPhotoLibraryWithDeadline({
        controller: abort,
        read: async (signal) => {
          // Recent establishes an authoritative scope even when a legacy
          // custom-photo reference can no longer be resolved by /current.
          const recentPage = await api.listAgentPhotoLibrary({
            projection: "recent",
            limit: PAGE_SIZE,
            signal,
          });
          const fence = {
            ...recentPage.scope,
            requestGeneration,
            getCurrentGeneration: () => generation.current,
          };
          const catalogue = await readAgentPhotoLibraryCatalogue({
            readRecent: () => Promise.resolve(recentPage),
            readCurrent: async () => api.getAgentPhotoLibraryCurrent({ signal, fence }),
            readDeleted: async () => api.listAgentPhotoLibrary({
              projection: "deleted",
              limit: PAGE_SIZE,
              signal,
              fence,
            }),
            readPresets: async () => api.listAgentPhotoLibraryPresets({ signal, fence }),
            readToken: async () => ensureValidToken(activeServer.id, activeServer.serverUrl),
          });
          return [
            catalogue.current,
            catalogue.currentWarning,
            catalogue.recent,
            catalogue.deleted,
            catalogue.presets,
            catalogue.token,
          ] as const;
        },
      });
      if (generation.current !== requestGeneration || identityRef.current !== requestIdentityKey) return false;
      setScope(recentPage.scope);
      setRecent(recentPage.entries);
      setDeleted(deletedPage.entries);
      setRecentCursor(recentPage.nextCursor);
      setDeletedCursor(deletedPage.nextCursor);
      setPresets(presetPage.presets);
      setCurrentPresetId(current?.current.avatarRef?.kind === "preset" ? current.current.avatarRef.id : null);
      setUndoRevisionId(current?.current.lastUndoableRevisionId ?? null);
      setCurrentPhotoWarning(currentWarning);
      setToken(accessToken ? { identityKey: requestIdentityKey, value: accessToken } : null);
      setLoadedIdentityKey(requestIdentityKey);
      setFailedDeletedMedia(new Set());
      return true;
    } catch (cause) {
      // The catalogue reads form one scoped snapshot. Apart from the narrowly
      // recoverable missing-current warning above, retaining an earlier
      // snapshot would falsely claim that Recent or Presets is empty.
      if (generation.current === requestGeneration && identityRef.current === requestIdentityKey) {
        setLoadedIdentityKey(null);
        setCurrentPhotoWarning(null);
        setSelected(null);
        setConfirmDelete(null);
      }
      if (cause instanceof AgentPhotoLibraryReadDeadlineError) {
        setError(cause.message);
      } else if (abort.signal.aborted) {
        return false;
      } else if (cause instanceof AgentPhotoLibraryApiError && cause.code === "authentication_required") {
        setError("Your session has expired. Sign in again to view Agent photos.");
        void refreshViewer();
      } else {
        setError(cause instanceof Error ? cause.message : "Could not load Agent photos.");
      }
      return false;
    } finally {
      if (generation.current === requestGeneration) setLoading(false);
    }
  }, [activeServer, identityKey, refreshViewer, viewer, viewerState]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      readController.current?.abort();
      pageController.current?.abort();
      mutations.current.abortAndReset();
    };
  }, [load]);

  const makeFence = () => scope && snapshotReady ? {
    ...scope,
    requestGeneration: generation.current,
    getCurrentGeneration: () => generation.current,
  } : null;

  const mutate = async <T,>(input: {
    key: string;
    label: string;
    action: (options: {
      idempotencyKey: string;
      origin: "mobile";
      signal: AbortSignal;
      fence: NonNullable<ReturnType<typeof makeFence>>;
    }) => Promise<T>;
    apply: (value: T) => void;
  }): Promise<boolean> => {
    if (mutationBusy.current) return false;
    const capturedFence = makeFence();
    const capturedIdentityKey = identityKey;
    if (!capturedFence) return false;
    mutationBusy.current = true;
    setMutating(true);
    setMutationLabel(input.label);
    setError(null);
    setNotice(null);
    setRetry(null);
    try {
      const result = await mutations.current.run(input.key, (operationId, signal) => input.action({
        idempotencyKey: operationId,
        origin: "mobile",
        signal,
        fence: capturedFence,
      }));
      const disposition = agentPhotoMutationCompletionDisposition({
        status: result.status,
        sameIdentity: identityRef.current === capturedIdentityKey,
        sameGeneration: generation.current === capturedFence.requestGeneration,
      });
      if (disposition === "ignore") return false;
      if (result.status === "busy") return false;
      if (result.status === "applied") {
        if (disposition === "apply") input.apply(result.value);
        setNotice(`${input.label} complete.`);
        // The canonical websocket event for our own successful mutation can
        // advance the read generation before the HTTP response arrives. The
        // server has still confirmed the operation: clear the retry draft and
        // reconcile instead of replaying it under a new idempotency key.
        void load({ clearMessage: false });
        return true;
      }
      setError(result.message);
      if (result.status === "retry") {
        setRetry({ label: `Retry ${input.label.toLowerCase()}`, run: () => { void mutate(input); } });
      } else if (result.status === "auth") {
        void refreshViewer();
      } else if (result.status === "refresh") {
        if (result.scope) setScope(result.scope);
        if (result.current) {
          setCurrentPresetId(result.current.avatarRef?.kind === "preset" ? result.current.avatarRef.id : null);
        }
        void load({ clearMessage: false });
      }
      return false;
    } finally {
      mutationBusy.current = false;
      setMutating(false);
      setMutationLabel(null);
    }
  };

  const applySelection = (result: AgentPhotoLibrarySelectionResponse) => {
    setScope(result.scope);
    setCurrentPresetId(result.currentAvatarRef?.kind === "preset" ? result.currentAvatarRef.id : null);
    setUndoRevisionId(result.operation === "undo" ? null : result.changed ? result.revisionId : null);
    setRecent((rows) => rows.map((row) => ({ ...row, isCurrent: row.id === result.currentEntryId })));
  };

  const select = (target: NonNullable<PendingSelection>["target"]) => {
    if (!activeServer || !scope) return Promise.resolve(false);
    const serverUrl = activeServer.serverUrl;
    const expectedSelectionRevision = scope.selectionRevision;
    const targetKey = target.kind === "entry" ? target.entryId : target.presetId;
    return mutate({
      key: `select:${target.kind}:${targetKey}`,
      label: "Agent photo change",
      action: (options) => getApiClient(serverUrl).selectAgentPhotoLibraryEntry({ target, expectedSelectionRevision }, options),
      apply: applySelection,
    });
  };

  const useSelected = async () => {
    if (!selected) return;
    const applied = await select(selected.target);
    setSelected((current) => finishAgentPhotoSelection(current, applied));
  };

  const undo = () => {
    if (!activeServer || !scope || !undoRevisionId) return;
    const serverUrl = activeServer.serverUrl;
    const revisionId = undoRevisionId;
    const expectedSelectionRevision = scope.selectionRevision;
    void mutate({
      key: `undo:${revisionId}`,
      label: "Undo",
      action: (options) => getApiClient(serverUrl).undoAgentPhotoLibrarySelection({ revisionId, expectedSelectionRevision }, options),
      apply: applySelection,
    });
  };

  const loadMore = async (projection: Projection) => {
    const cursor = projection === "recent" ? recentCursor : deletedCursor;
    const capturedFence = makeFence();
    const capturedIdentityKey = identityKey;
    if (!activeServer || !cursor || !capturedFence || pageBusy.current) return;
    const abort = new AbortController();
    pageController.current?.abort();
    pageController.current = abort;
    pageBusy.current = true;
    setPageLoading(projection);
    setError(null);
    let refreshAfterError = false;
    try {
      const page = await getApiClient(activeServer.serverUrl).listAgentPhotoLibrary({
        projection,
        limit: PAGE_SIZE,
        cursor,
        signal: abort.signal,
        fence: capturedFence,
      });
      if (identityRef.current !== capturedIdentityKey || generation.current !== capturedFence.requestGeneration) return;
      const next = applyAgentPhotoProjectionPage({
        recent: { entries: recent, nextCursor: recentCursor },
        deleted: { entries: deleted, nextCursor: deletedCursor },
      }, projection, page);
      setRecent(next.recent.entries);
      setRecentCursor(next.recent.nextCursor);
      setDeleted(next.deleted.entries);
      setDeletedCursor(next.deleted.nextCursor);
    } catch (cause) {
      if (
        abort.signal.aborted
        || identityRef.current !== capturedIdentityKey
        || generation.current !== capturedFence.requestGeneration
      ) return;
      if (cause instanceof AgentPhotoLibraryApiError && cause.code === "authentication_required") {
        setError("Your session has expired. Sign in again to view Agent photos.");
        void refreshViewer();
      } else if (
        cause instanceof AgentPhotoLibraryApiError
        && (cause.code === "stale_library_revision" || cause.code === "stale_viewer_scope")
      ) {
        setError("This Agent photo library changed. Refreshing the current server state.");
        refreshAfterError = true;
      } else {
        setError(cause instanceof Error ? cause.message : "Could not load more photos.");
      }
    } finally {
      if (
        pageController.current === abort
        && identityRef.current === capturedIdentityKey
        && generation.current === capturedFence.requestGeneration
      ) {
        pageController.current = null;
        pageBusy.current = false;
        setPageLoading(null);
      }
    }
    if (
      refreshAfterError
      && identityRef.current === capturedIdentityKey
      && generation.current === capturedFence.requestGeneration
    ) void load({ clearMessage: false });
  };

  const applyCreated = (result: AgentPhotoLibraryCreateResponse) => {
    const entries: AgentPhotoLibraryEntryDto[] = result.entries.map((entry) => ({
      ...entry,
      deletedAt: null,
      purgeAfter: null,
      isCurrent: false,
    }));
    setScope(result.scope);
    setRecent((rows) => [...new Map([...entries, ...rows].map((entry) => [entry.id, entry])).values()]);
    setSection("recent");
  };

  const uploadPrepared = async (file: AgentAvatarFile) => {
    if (!activeServer) return;
    const serverUrl = activeServer.serverUrl;
    const applied = await mutate({
      key: "upload",
      label: "Upload",
      action: (options) => getApiClient(serverUrl).uploadAgentPhotoLibraryEntry(file, options),
      apply: applyCreated,
    });
    if (applied) setUploadDraft(null);
  };

  const upload = async (asset: PickedAgentImage) => {
    setPicker(false);
    const prepared = prepareAgentAvatarUpload(asset, new File(asset.uri));
    if (!prepared.ok) {
      setError(prepared.message);
      return;
    }
    mutations.current.discard("upload");
    setUploadDraft(prepared.file);
    await uploadPrepared(prepared.file);
  };

  const generate = () => {
    if (!activeServer) return;
    const serverUrl = activeServer.serverUrl;
    const capturedPrompt = prompt.trim();
    const capturedCount = count;
    if (!capturedPrompt) return;
    void mutate({
      key: `generate:${capturedCount}:${capturedPrompt}`,
      label: "Generation",
      action: (options) => getApiClient(serverUrl).generateAgentPhotoLibraryEntries({
        prompt: capturedPrompt,
        count: capturedCount,
      }, options),
      apply: applyCreated,
    });
  };

  const deleteEntry = async (entry: AgentPhotoLibraryEntryDto) => {
    if (!activeServer) return;
    const serverUrl = activeServer.serverUrl;
    const applied = await mutate({
      key: `delete:${entry.id}`,
      label: "Delete",
      action: (options) => getApiClient(serverUrl).deleteAgentPhotoLibraryEntry(entry.id, options),
      apply: (result) => {
        setScope(result.scope);
        setRecent((rows) => rows.filter((row) => row.id !== entry.id));
        setDeleted((rows) => [{ ...entry, deletedAt: new Date().toISOString(), isCurrent: false }, ...rows]);
      },
    });
    if (applied) {
      setConfirmDelete(null);
      setSelected(null);
    }
  };

  const restoreEntry = (entry: AgentPhotoLibraryEntryDto) => {
    if (!activeServer) return;
    const serverUrl = activeServer.serverUrl;
    void mutate({
      key: `restore:${entry.id}`,
      label: "Restore",
      action: (options) => getApiClient(serverUrl).restoreAgentPhotoLibraryEntry(entry.id, options),
      apply: (result) => {
        setScope(result.scope);
        setDeleted((rows) => rows.filter((row) => row.id !== entry.id));
        setRecent((rows) => [{ ...entry, deletedAt: null, purgeAfter: null }, ...rows]);
      },
    });
  };

  const changeSection = (next: Section) => {
    if (busy) return;
    setSection(next);
    setSelected(null);
    setConfirmDelete(null);
  };

  const source = (path: string) => agentPhotoMediaSource({
    serverUrl: activeServer?.serverUrl ?? "",
    path,
    identityKey,
    token,
  });

  const shownRecent = snapshotReady ? recent : [];
  const shownDeleted = snapshotReady ? deleted : [];
  const shownPresets = snapshotReady ? presets : [];
  const cataloguePresentable = agentPhotoLibraryCatalogueIsPresentable({
    snapshotReady,
    hasError: error !== null,
  });
  const selectedTarget = selected?.target;
  const selectedEntry = selectedTarget?.kind === "entry"
    ? shownRecent.find((entry) => entry.id === selectedTarget.entryId) ?? null
    : null;

  return (
    <View style={styles.container} accessibilityState={{ busy }}>
      <AppBar title="Agent photos" left={<AppBarBackButton onPress={() => router.back()} />} />
      <Screen edgeTop={false} scroll={layout.scroll} contentStyle={styles.content}>
        {error ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.messageStack}>
            <SettingsStatus tone="error">{error}</SettingsStatus>
            {retry ? <Pressable accessibilityRole="button" disabled={busy} style={styles.outline} onPress={retry.run}><Text style={styles.accent}>{retry.label}</Text></Pressable> : null}
            <Pressable accessibilityRole="button" disabled={busy} style={styles.outline} onPress={() => void load()}><Text style={styles.buttonText}>Refresh library</Text></Pressable>
          </View>
        ) : null}
        {currentPhotoWarning ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="polite">
            <SettingsStatus tone="warning">{currentPhotoWarning}</SettingsStatus>
          </View>
        ) : null}
        {notice ? <View accessibilityRole="summary" accessibilityLiveRegion="polite"><SettingsStatus tone="success">{notice}</SettingsStatus></View> : null}
        {loading ? <ActivityIndicator accessibilityLabel="Loading Agent photo library" color={t.color.brand.accent} /> : null}
        {loading && !snapshotReady ? <View style={styles.grid}>{[0, 1, 2, 3].map((key) => <View key={key} style={[styles.card, styles.skeleton]} />)}</View> : null}
        {snapshotReady && undoRevisionId && scope ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={styles.outline} onPress={undo}><Text style={styles.accent}>Undo last photo change</Text></Pressable> : null}

        <View accessibilityRole="tablist" accessibilityLabel="Photo library sections" style={styles.tabs}>
          {AGENT_PHOTO_PRIMARY_SECTIONS.map((name) => (
            <Pressable
              key={name}
              accessibilityRole="tab"
              accessibilityState={{ selected: section === name, disabled: busy }}
              disabled={busy}
              onPress={() => changeSection(name)}
              style={[styles.tab, section === name && styles.tabActive]}
            >
              <Text style={section === name ? styles.accent : styles.buttonText}>{name[0].toUpperCase() + name.slice(1)}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: section === "deleted", disabled: busy }} disabled={busy} onPress={() => changeSection("deleted")} style={styles.deletedLink}><Text style={styles.accent}>Recently deleted</Text></Pressable>

        {selected && cataloguePresentable ? <View accessibilityLabel="Selected photo preview" style={styles.preview}><Image source={source(selected.imagePath)} style={styles.previewImage} /></View> : null}

        {section === "recent" && cataloguePresentable ? <PhotoGridSection title="Recent" empty="No saved photos yet." rows={shownRecent} busy={busy} source={source} onPress={(entry) => !entry.isCurrent && setSelected((current) => stageAgentPhotoSelection(current, { target: { kind: "entry", entryId: entry.id }, imagePath: entry.media.fullUrl ?? entry.media.thumbnailUrl }))} styles={styles} /> : null}
        {section === "recent" && cataloguePresentable && recentCursor ? <Pressable accessibilityRole="button" disabled={busy} style={styles.outline} onPress={() => void loadMore("recent")}><Text style={styles.buttonText}>{pageLoading === "recent" ? "Loading…" : "Load more"}</Text></Pressable> : null}

        {section === "presets" && cataloguePresentable ? <><Text style={styles.heading}>Presets</Text><View style={styles.grid}>{shownPresets.map((preset) => <Pressable key={preset.id} accessibilityRole="button" accessibilityLabel={`Preset ${preset.id}${currentPresetId === preset.id ? ", current" : ""}`} accessibilityState={{ selected: selected?.target.kind === "preset" && selected.target.presetId === preset.id, disabled: busy || currentPresetId === preset.id }} disabled={busy || currentPresetId === preset.id} style={styles.card} onPress={() => setSelected((current) => stageAgentPhotoSelection(current, { target: { kind: "preset", presetId: preset.id }, imagePath: preset.thumbnailUrl }))}><Image source={source(preset.thumbnailUrl)} style={styles.image} />{currentPresetId === preset.id ? <Text style={styles.current}>Current</Text> : <Text style={styles.accent}>Preview</Text>}</Pressable>)}</View></> : null}

        {section === "upload" && cataloguePresentable ? <><Text style={styles.heading}>Upload</Text><Pressable accessibilityRole="button" disabled={busy || !snapshotReady} style={styles.outline} onPress={() => setPicker(true)}><Text style={styles.buttonText}>Choose from phone</Text></Pressable>{uploadDraft ? <Pressable accessibilityRole="button" disabled={busy || !snapshotReady} style={styles.outline} onPress={() => void uploadPrepared(uploadDraft)}><Text style={styles.accent}>Retry same upload</Text></Pressable> : null}<Text style={styles.note}>The upload is saved unselected. Preview it from Recent, then choose Use.</Text></> : null}

        {section === "generate" && cataloguePresentable ? <><Text style={styles.heading}>Generate</Text><TextInput accessibilityLabel="Describe a new Agent photo" editable={!busy} value={prompt} onChangeText={setPrompt} placeholder="Describe a new photo" placeholderTextColor={t.color.text.muted} style={styles.input} maxLength={500} /><View accessibilityRole="radiogroup" accessibilityLabel="Number of photos" style={styles.tabs}>{([1, 2, 3, 4] as const).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: count === value, disabled: busy }} disabled={busy} style={[styles.tab, count === value && styles.tabActive]} onPress={() => setCount(value)}><Text style={count === value ? styles.accent : styles.buttonText}>{value}</Text></Pressable>)}</View>{generating ? <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Generating Agent photos" style={styles.generationStatus}><ActivityIndicator color={t.color.brand.accent} /><View style={styles.generationCopy}><Text style={styles.buttonText}>Creating your Agent photo…</Text><Text style={styles.note}>This can take up to a minute. Your result will open in Recent.</Text></View></View> : null}<Pressable accessibilityRole="button" accessibilityState={{ disabled: !prompt.trim() || busy || !snapshotReady }} style={styles.primary} disabled={!prompt.trim() || busy || !snapshotReady} onPress={generate}><Text style={styles.primaryText}>{generating ? "Generating…" : `Generate ${count}`}</Text></Pressable><Text style={styles.note}>Generated photos are saved unselected.</Text></> : null}

        {section === "deleted" && cataloguePresentable ? <><Text style={styles.heading}>Recently deleted</Text>{shownDeleted.length === 0 && snapshotReady ? <Text style={styles.note}>No recoverable photos.</Text> : <View style={styles.grid}>{shownDeleted.map((entry) => <View key={entry.id} style={styles.card}>{failedDeletedMedia.has(entry.id) ? <View style={styles.deletedPlaceholder} accessibilityLabel="Deleted photo preview unavailable"><Text style={styles.note}>Preview unavailable</Text></View> : <Image source={source(entry.media.thumbnailUrl)} style={styles.image} onError={() => setFailedDeletedMedia((current) => new Set(current).add(entry.id))} />}<Text style={styles.meta}>{entry.purgeAfter ? `Recoverable until ${new Date(entry.purgeAfter).toLocaleDateString()}` : "Recoverable until expiration"}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Restore photo ${entry.id}`} disabled={busy} onPress={() => restoreEntry(entry)}><Text style={styles.accent}>Restore</Text></Pressable></View>)}</View>}{snapshotReady && deletedCursor ? <Pressable accessibilityRole="button" disabled={busy} style={styles.outline} onPress={() => void loadMore("deleted")}><Text style={styles.buttonText}>{pageLoading === "deleted" ? "Loading…" : "Load more"}</Text></Pressable> : null}</> : null}
      </Screen>

      {layout.stickyActions.visible ? <View accessibilityLabel="Selected photo actions" style={[styles.stickyActions, { paddingBottom: layout.stickyActions.paddingBottom }]}>{selectedEntry && confirmDelete === selectedEntry.id ? <><Text style={styles.buttonText}>Move this photo to Recently deleted?</Text><Pressable accessibilityRole="button" accessibilityLabel="Delete photo" accessibilityState={{ disabled: layout.stickyActions.disabled }} disabled={layout.stickyActions.disabled} style={styles.dangerOutline} onPress={() => void deleteEntry(selectedEntry)}><Text style={styles.danger}>Delete photo</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Keep photo" accessibilityState={{ disabled: layout.stickyActions.disabled }} disabled={layout.stickyActions.disabled} style={styles.outline} onPress={() => setConfirmDelete(null)}><Text style={styles.buttonText}>Keep photo</Text></Pressable></> : <><Pressable accessibilityRole="button" accessibilityState={{ disabled: layout.stickyActions.disabled }} disabled={layout.stickyActions.disabled} style={styles.primary} onPress={() => void useSelected()}><Text style={styles.primaryText}>Use this photo</Text></Pressable>{selectedEntry ? <Pressable accessibilityRole="button" accessibilityLabel="Delete" accessibilityState={{ disabled: layout.stickyActions.disabled }} disabled={layout.stickyActions.disabled} style={styles.dangerOutline} onPress={() => setConfirmDelete(requestAgentPhotoDelete(selectedEntry))}><Text style={styles.danger}>Delete</Text></Pressable> : null}<Pressable accessibilityRole="button" accessibilityState={{ disabled: layout.stickyActions.disabled }} disabled={layout.stickyActions.disabled} style={styles.outline} onPress={() => { setConfirmDelete(null); setSelected(cancelAgentPhotoSelection()); }}><Text style={styles.buttonText}>Cancel</Text></Pressable></>}</View> : null}
      <ChangeAgentPhotoSheet visible={picker} onClose={() => setPicker(false)} onPick={(asset) => void upload(asset)} />
    </View>
  );
}

function PhotoGridSection({ title, empty, rows, busy, source, onPress, styles }: {
  title: string;
  empty: string;
  rows: AgentPhotoLibraryEntryDto[];
  busy: boolean;
  source: (path: string) => { uri: string; headers?: { Authorization: string } };
  onPress: (entry: AgentPhotoLibraryEntryDto) => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return <><Text style={styles.heading}>{title}</Text>{rows.length === 0 && !busy ? <Text style={styles.note}>{empty}</Text> : <View style={styles.grid}>{rows.map((entry) => <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`${entry.source.replace("_", " ")} photo${entry.isCurrent ? ", current" : ", preview"}`} accessibilityState={{ disabled: busy || entry.isCurrent }} disabled={busy || entry.isCurrent} style={styles.card} onPress={() => onPress(entry)}><Image source={source(entry.media.thumbnailUrl)} style={styles.image} /><Text style={styles.meta}>{entry.source.replace("_", " ")}</Text>{entry.isCurrent ? <Text style={styles.current}>Current</Text> : <Text style={styles.accent}>Preview</Text>}</Pressable>)}</View>}</>;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    content: { gap: t.spacing.md },
    messageStack: { gap: t.spacing.sm },
    heading: { ...t.typography.heading, color: t.color.text.foreground, marginTop: t.spacing.sm },
    tabs: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
    deletedLink: { minHeight: 44, alignSelf: "flex-start", justifyContent: "center", paddingHorizontal: t.spacing.xs },
    tab: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.sm, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.pill },
    tabActive: { borderColor: t.color.brand.accent, backgroundColor: t.color.surface.subtle },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
    card: { width: "47%", gap: t.spacing.xs, padding: t.spacing.sm, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, backgroundColor: t.color.surface.panel },
    image: { width: "100%", aspectRatio: 1, borderRadius: t.radii.sm },
    deletedPlaceholder: { width: "100%", aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: t.radii.sm, backgroundColor: t.color.surface.subtle },
    preview: { gap: t.spacing.sm, padding: t.spacing.md, borderWidth: 1, borderColor: t.color.brand.accent, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel },
    previewImage: { width: "100%", aspectRatio: 1, borderRadius: t.radii.md },
    stickyActions: { gap: t.spacing.sm, paddingHorizontal: t.spacing.xl, paddingTop: t.spacing.sm, borderTopWidth: 1, borderTopColor: t.color.border.default, backgroundColor: t.color.surface.background },
    skeleton: { aspectRatio: 1, backgroundColor: t.color.surface.subtle },
    meta: { ...t.typography.caption, color: t.color.text.muted },
    current: { ...t.typography.bodyStrong, color: t.color.status.success },
    accent: { ...t.typography.bodyStrong, color: t.color.brand.accent },
    danger: { ...t.typography.bodyStrong, color: t.color.status.error },
    note: { ...t.typography.body, color: t.color.text.muted },
    outline: { minHeight: 48, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm },
    dangerOutline: { minHeight: 48, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: t.color.status.error, borderRadius: t.radii.sm },
    buttonText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    input: { minHeight: 52, padding: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, color: t.color.text.foreground, backgroundColor: t.color.surface.panel },
    generationStatus: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, padding: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, backgroundColor: t.color.surface.panel },
    generationCopy: { flex: 1, gap: t.spacing.xs },
    primary: { minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: t.radii.sm, backgroundColor: t.color.action.primaryBg },
    primaryText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
  });
}
