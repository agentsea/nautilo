import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { ModelSwitcherSheet } from "@/components/model-switcher-sheet";
import {
  RoomChatComposer,
  RoomChatPane,
  useRoomChatController,
} from "@/features/room-chat-pane";
import { dockedRoomChatCapabilitiesForPlatform } from "@/features/room-chat-pane/platform-capabilities";
import {
  classifyArtifactKind,
  type ArtifactBytesResult,
} from "@/lib/artifact-bytes";
import { getApiClient } from "@/lib/api";
import {
  WRITE_ARTIFACTS_REQUIRED_COPY,
  refreshMobileCapabilityDenial,
  type MobileCapabilityScope,
} from "@/lib/mobile-capability-denial";
import { releaseArtifactFileUri } from "@/lib/artifact-byte-download";
import {
  isArtifactFileHandoffAvailable,
  openArtifactFile,
} from "@/lib/artifact-file-handoff";
import {
  type DiscussionRoom,
  artifactDiscussionRef,
  fetchAggregateArtifactBytes,
  isDiscussionCandidate,
  readDiscussionRoomHint,
  writeDiscussionRoomHint,
} from "@/features/files-discussion/artifact-discussion";
import {
  ArtifactEditAction,
  artifactViewerActionButtonStyle,
  artifactViewerActionLabelStyle,
  shouldMountArtifactDiscussion,
  shouldResolveArtifactEdit,
} from "@/features/artifacts/artifact-viewer-routing";
import { ArtifactMarkdownPreview } from "@/features/artifacts/artifact-markdown-preview";
import { ArtifactDocumentPreview } from "@/features/artifacts/artifact-document-preview";
import { ArtifactVideoPreview } from "@/features/artifacts/artifact-video-preview";
import { artifactDocumentScope } from "@/features/artifacts/artifact-document-scope";
import { ArtifactImageInspector } from "@/features/artifacts/artifact-image-inspector";
import { ArtifactRenameCoordinator } from "@/features/artifacts/artifact-rename";
import { ArtifactDeleteCoordinator } from "@/features/artifacts/artifact-delete";
import {
  shouldExitAfterArtifactConvergence,
  shouldInstallArtifactConvergenceResult,
  shouldPassivelyRefreshArtifactViewerOnFocus,
  viewerConvergenceAction,
} from "@/features/artifacts/artifact-convergence";
import { ArtifactViewerActionsSheet } from "@/features/artifacts/artifact-viewer-actions-sheet";
import { WorkspaceShareSheet } from "@/features/artifacts/workspace-share-sheet";
import { useArtifactSave } from "@/features/artifacts/use-artifact-save";
import { isMediaLibraryCandidate } from "@/features/artifacts/artifact-media-export";
import { canShareOriginalFile } from "@/lib/original-file-share";
import { ArtifactSaveStatus } from "@/features/artifacts/artifact-save-status";
import { loadArtifactForEdit } from "@/features/artifacts/artifact-edit-loader";
import { useServers } from "@/providers/server-registry";
import { useAuth } from "@/providers/auth";
import { useAppTheme } from "@/providers/theme";
import { useArtifactEvents } from "@/providers/artifact-events";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";
import type { AppTheme } from "@/theme/tokens";

type ViewerState =
  | { kind: "loading" }
  | { kind: "result"; result: ArtifactBytesResult };
type ArtifactLoadOptions = {
  /** Passive convergence may retain an already-mounted canonical viewer. */
  mode?: "passive" | "reconcile";
  onResult?: (result: ArtifactBytesResult) => void;
};

type ChatDockSnap = "collapsed" | "half" | "full";

// Collapsed still keeps the docked composer usable (handle + title +
// auto-approve strip + input/control rows), rather than hiding it behind
// overflow.
const COLLAPSED_DOCK_HEIGHT = 168;
const MIN_DOCK_HEIGHT = COLLAPSED_DOCK_HEIGHT;

export default function ArtifactViewerScreen() {
  const { activeServer } = useServers();
  const { viewer } = useAuth();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  // Reset only this file session when its authority changes. Routine network
  // recovery must not remount the app, but another account must never inherit
  // the previous reader, draft, pending action, or discussion state.
  const scope = artifactDocumentScope(activeServer?.id, activeServer?.serverUrl, viewer?.userId, firstParam(params.id));
  return <ArtifactViewerSession key={scope} />;
}

function ArtifactViewerSession() {
  const fileSave = useArtifactSave();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { activeServer } = useServers();
  const { viewer, refreshViewer } = useAuth();
  const { subscribe: subscribeArtifactEvents } = useArtifactEvents();
  const params = useLocalSearchParams<{ id?: string | string[]; roomId?: string | string[] }>();
  const artifactId = firstParam(params.id);
  const originRoomId = firstParam(params.roomId);
  const controllerRef = useRef<AbortController | null>(null);
  const focusedSessionKeyRef = useRef<string | undefined>(undefined);
  const [state, setState] = useState<ViewerState>({ kind: "loading" });
  const stateRef = useRef<ViewerState>(state);
  stateRef.current = state;
  const retainedFileUri = state.kind === "result" && state.result.kind === "file"
    ? state.result.fileUri
    : null;
  useEffect(() => () => {
    if (retainedFileUri) releaseArtifactFileUri(retainedFileUri);
  }, [retainedFileUri]);
  const [discussionRoomId, setDiscussionRoomId] = useState<string>();
  const [dockAreaHeight, setDockAreaHeight] = useState(0);
  const [discussionLoading, setDiscussionLoading] = useState(false);
  const [chooserVisible, setChooserVisible] = useState(false);
  const [candidates, setCandidates] = useState<DiscussionRoom[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [creatingDiscussion, setCreatingDiscussion] = useState(false);
  const [discussionError, setDiscussionError] = useState<string | null>(null);
  const [renameVisible, setRenameVisible] = useState(false);
  const shareScope = JSON.stringify([activeServer?.id, viewer?.userId, artifactId, originRoomId]);
  const shareScopeRef = useRef(shareScope);
  shareScopeRef.current = shareScope;
  const isShareScopeCurrent = useCallback(() => shareScopeRef.current === shareScope, [shareScope]);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const [renameRetryable, setRenameRetryable] = useState(false);
  const [renameReloadOnClose, setRenameReloadOnClose] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteRetryable, setDeleteRetryable] = useState(false);
  const [deleteReconcileOnClose, setDeleteReconcileOnClose] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const capabilityScopeRef = useRef<MobileCapabilityScope | null>(null);
  capabilityScopeRef.current = activeServer && viewer
    ? { serverId: activeServer.id, userId: viewer.userId }
    : null;
  const currentCapabilityScope = useCallback(() => capabilityScopeRef.current, []);
  const recoverArtifactCapability = useCallback((
    actionScope: MobileCapabilityScope | null,
  ): void => {
    void refreshMobileCapabilityDenial({
      denial: { capability: "write_artifacts", message: WRITE_ARTIFACTS_REQUIRED_COPY },
      actionScope,
      getCurrentScope: currentCapabilityScope,
      refreshViewer,
    }).then((denial) => {
      if (denial) setCapabilityError(denial.message);
    });
  }, [currentCapabilityScope, refreshViewer]);
  const renameCoordinator = useMemo(() => new ArtifactRenameCoordinator(), [activeServer?.id, artifactId]);
  const deleteCoordinator = useMemo(() => new ArtifactDeleteCoordinator(), [activeServer?.id, artifactId]);
  const renameRequestGeneration = useRef(0);
  const deleteRequestGeneration = useRef(0);
  const mutationBusyRef = useRef(false);
  const mutationOperationsRef = useRef({ rename: false, delete: false });
  const setMutationBusy = useCallback((operation: "rename" | "delete", busy: boolean): void => {
    mutationOperationsRef.current[operation] = busy;
    mutationBusyRef.current = mutationOperationsRef.current.rename || mutationOperationsRef.current.delete;
  }, []);

  const returnToFiles = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(drawer)/(tabs)/files");
  }, []);

  const loadArtifact = useCallback((options?: ArtifactLoadOptions) => {
    // Both convergence modes retain a mounted artifact (and its optional
    // Discuss controller) during fetch. They differ only in whether a
    // transient completion replaces that retained canonical result.
    const preserveMountedResult = options?.mode !== undefined && stateRef.current.kind === "result";
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!preserveMountedResult) setState({ kind: "loading" });

    if (!activeServer || !artifactId) {
      const result: ArtifactBytesResult = { kind: "not_found" };
      setState({ kind: "result", result });
      options?.onResult?.(result);
      return () => controller.abort();
    }

    const client = getApiClient(activeServer.serverUrl);
    void (async () => {
      const result = await fetchAggregateArtifactBytes({
        serverId: activeServer.id,
        baseUrl: activeServer.serverUrl,
        client,
        artifactId,
        signal: controller.signal,
      });
      const install = !controller.signal.aborted && shouldInstallArtifactConvergenceResult(
        options?.mode,
        preserveMountedResult,
        result.kind,
      );
      if (install) {
        setState({ kind: "result", result });
        options?.onResult?.(result);
      } else if (result.kind === "file") {
        releaseArtifactFileUri(result.fileUri);
      }
    })();

    return () => controller.abort();
  }, [activeServer, artifactId]);

  useEffect(() => {
    // A server/artifact session change must not carry a prior action sheet,
    // frozen retry, busy state, or room chat into the new artifact.
    setDiscussionRoomId(undefined);
    setDockAreaHeight(0);
    setDiscussionLoading(false);
    setChooserVisible(false);
    setCandidates([]);
    setSelectedCandidateId(undefined);
    setCreatingDiscussion(false);
    setDiscussionError(null);
    setRenameVisible(false);
    setRenameBusy(false);
    setRenameError(undefined);
    setRenameRetryable(false);
    setRenameReloadOnClose(false);
    setDeleteBusy(false);
    setDeleteError(undefined);
    setDeleteRetryable(false);
    setDeleteReconcileOnClose(false);
    setCapabilityError(null);
    mutationOperationsRef.current = { rename: false, delete: false };
    mutationBusyRef.current = false;
    return () => {
      renameRequestGeneration.current += 1;
      deleteRequestGeneration.current += 1;
      renameCoordinator.dispose();
      deleteCoordinator.dispose();
    };
  }, [deleteCoordinator, renameCoordinator]);

  const result = state.kind === "result" ? state.result : null;
  const artifact = result && ("artifact" in result ? result.artifact : null);
  const title = artifact ? fileName(artifact.path) : "File";
  const viewerSessionKey = `${activeServer?.id ?? ""}\0${artifactId ?? ""}`;
  const reloadPassiveArtifact = useCallback(() => {
    return loadArtifact({ mode: "passive", onResult: (fresh) => {
      if (shouldExitAfterArtifactConvergence(fresh.kind)) returnToFiles();
    } });
  }, [loadArtifact, returnToFiles]);
  useFocusEffect(useCallback(() => {
    const refresh = shouldPassivelyRefreshArtifactViewerOnFocus(
      focusedSessionKeyRef.current,
      viewerSessionKey,
    );
    focusedSessionKeyRef.current = viewerSessionKey;
    // A same-session return (notably after editor Save) must converge from the
    // server while keeping the existing viewer/Discuss surface mounted.
    return refresh ? reloadPassiveArtifact() : loadArtifact();
  }, [loadArtifact, reloadPassiveArtifact, viewerSessionKey]));
  const reconcileArtifact = useCallback(() => {
    loadArtifact({ mode: "reconcile", onResult: (fresh) => {
      if (shouldExitAfterArtifactConvergence(fresh.kind)) returnToFiles();
    } });
  }, [loadArtifact, returnToFiles]);
  const closeActions = useCallback(() => {
    setRenameVisible(false);
    setRenameError(undefined);
    setRenameRetryable(false);
    if (renameReloadOnClose) {
      renameCoordinator.abandon();
      reconcileArtifact();
    }
    setRenameReloadOnClose(false);
    setDeleteError(undefined);
    setDeleteRetryable(false);
    if (deleteReconcileOnClose) {
      deleteCoordinator.abandon();
      reconcileArtifact();
    }
    setDeleteReconcileOnClose(false);
  }, [deleteCoordinator, deleteReconcileOnClose, reconcileArtifact, renameCoordinator, renameReloadOnClose]);
  const applyRenameOutcome = useCallback((
    outcome: Awaited<ReturnType<ArtifactRenameCoordinator["retry"]>>,
    actionScope: MobileCapabilityScope | null,
  ) => {
    if (outcome.state === "unchanged") {
      setRenameReloadOnClose(false);
      setRenameRetryable(false);
      setRenameError(undefined);
      setRenameVisible(false);
      return;
    }
    if (outcome.state === "saved") {
      // A rename can alter an extension and therefore the derived viewer kind.
      // Canonical metadata+bytes reload avoids retaining a misclassified cache.
      setRenameReloadOnClose(false);
      setRenameRetryable(false);
      setRenameError(undefined);
      setRenameVisible(false);
      reconcileArtifact();
      return;
    }
    if (outcome.reason === "capability") {
      recoverArtifactCapability(actionScope);
      setRenameVisible(false);
      reconcileArtifact();
    }
    setRenameReloadOnClose(outcome.reloadBeforeClose);
    setRenameRetryable(outcome.retryable);
    setRenameError(renameMessage(outcome.reason));
  }, [reconcileArtifact, recoverArtifactCapability]);
  const rename = useCallback(async (basename: string) => {
    if (!artifact || !activeServer || !artifact.canWrite) return;
    const actionScope = currentCapabilityScope();
    setCapabilityError(null);
    const requestGeneration = ++renameRequestGeneration.current;
    setMutationBusy("rename", true);
    setRenameBusy(true);
    setRenameError(undefined);
    const outcome = await renameCoordinator.rename({
      client: getApiClient(activeServer.serverUrl), artifact, basename,
      serverId: activeServer.id,
    });
    if (requestGeneration !== renameRequestGeneration.current) return;
    setMutationBusy("rename", false);
    setRenameBusy(false);
    applyRenameOutcome(outcome, actionScope);
  }, [activeServer, applyRenameOutcome, artifact, currentCapabilityScope, originRoomId, renameCoordinator, setMutationBusy]);
  const retryRename = useCallback(async () => {
    if (!activeServer) return;
    const actionScope = currentCapabilityScope();
    setCapabilityError(null);
    const requestGeneration = ++renameRequestGeneration.current;
    setMutationBusy("rename", true);
    setRenameBusy(true);
    setRenameError(undefined);
    const outcome = await renameCoordinator.retry(getApiClient(activeServer.serverUrl));
    if (requestGeneration !== renameRequestGeneration.current) return;
    setMutationBusy("rename", false);
    setRenameBusy(false);
    applyRenameOutcome(outcome, actionScope);
  }, [activeServer, applyRenameOutcome, currentCapabilityScope, renameCoordinator, setMutationBusy]);
  const applyDeleteOutcome = useCallback((
    outcome: Awaited<ReturnType<ArtifactDeleteCoordinator["retry"]>>,
    actionScope: MobileCapabilityScope | null,
  ) => {
    if (outcome.state === "deleted") {
      setDeleteError(undefined);
      setDeleteRetryable(false);
      setDeleteReconcileOnClose(false);
      setRenameVisible(false);
      returnToFiles();
      return;
    }
    if (outcome.reason === "capability") {
      recoverArtifactCapability(actionScope);
      setRenameVisible(false);
      reconcileArtifact();
    }
    setDeleteReconcileOnClose(outcome.reconcileBeforeClose);
    setDeleteRetryable(outcome.retryable);
    setDeleteError(deleteMessage(outcome.reason));
  }, [reconcileArtifact, recoverArtifactCapability, returnToFiles]);
  const deleteArtifact = useCallback(async () => {
    if (!artifact || !activeServer || !artifact.canWrite) return;
    const actionScope = currentCapabilityScope();
    setCapabilityError(null);
    const requestGeneration = ++deleteRequestGeneration.current;
    setMutationBusy("delete", true);
    setDeleteBusy(true);
    setDeleteError(undefined);
    const outcome = await deleteCoordinator.delete({
      client: getApiClient(activeServer.serverUrl), id: artifact.id, serverId: activeServer.id,
    });
    if (requestGeneration !== deleteRequestGeneration.current) return;
    setMutationBusy("delete", false);
    setDeleteBusy(false);
    applyDeleteOutcome(outcome, actionScope);
  }, [activeServer, applyDeleteOutcome, artifact, currentCapabilityScope, deleteCoordinator, originRoomId, setMutationBusy]);
  const retryDelete = useCallback(async () => {
    if (!activeServer) return;
    const actionScope = currentCapabilityScope();
    setCapabilityError(null);
    const requestGeneration = ++deleteRequestGeneration.current;
    setMutationBusy("delete", true);
    setDeleteBusy(true);
    setDeleteError(undefined);
    const outcome = await deleteCoordinator.retry(getApiClient(activeServer.serverUrl));
    if (requestGeneration !== deleteRequestGeneration.current) return;
    setMutationBusy("delete", false);
    setDeleteBusy(false);
    applyDeleteOutcome(outcome, actionScope);
  }, [activeServer, applyDeleteOutcome, currentCapabilityScope, deleteCoordinator, setMutationBusy]);
  useEffect(() => subscribeArtifactEvents((event) => {
    const action = viewerConvergenceAction(event, artifactId, mutationBusyRef.current);
    if (action === "reconcile") reconcileArtifact();
    else if (action === "reload") reloadPassiveArtifact();
  }), [artifactId, reconcileArtifact, reloadPassiveArtifact, subscribeArtifactEvents]);
  const loadEditAdmission = useCallback((signal: AbortSignal) => {
    if (!activeServer || !artifactId) return Promise.resolve({ kind: "not-found" } as const);
    return loadArtifactForEdit({
      client: getApiClient(activeServer.serverUrl), artifactId,
      serverId: activeServer.id, baseUrl: activeServer.serverUrl, signal,
      ...(result?.kind === "text" ? { sourceContent: result.content } : {}),
    });
  }, [activeServer, artifactId, result]);

  const editResultKind = result?.kind === "text" || result?.kind === "file" || result?.kind === "unsupported"
    ? result.kind
    : "other";
  const showEditAdmission = artifactId !== undefined && shouldResolveArtifactEdit({
    resultKind: editResultKind,
  });
  const mimeBarActionAppearance = {
    backgroundColor: t.color.surface.element,
    borderColor: t.color.border.interactive,
    textColor: t.color.brand.accent,
  };

  const openDiscussion = useCallback(async (roomId: string) => {
    if (!activeServer || !artifactId) return;
    setDiscussionRoomId(roomId);
    setChooserVisible(false);
    setDiscussionError(null);
    await writeDiscussionRoomHint(activeServer.id, artifactId, roomId);
  }, [activeServer, artifactId]);

  const discuss = useCallback(async () => {
    if (!activeServer || !artifactId) return;
    setDiscussionLoading(true);
    setDiscussionError(null);
    try {
      const rooms = (await getApiClient(activeServer.serverUrl).listArtifactDiscussionRooms(artifactId)).rooms;
      if (isDiscussionCandidate(originRoomId, rooms)) return void openDiscussion(originRoomId);
      const hint = await readDiscussionRoomHint(activeServer.id, artifactId);
      if (isDiscussionCandidate(hint, rooms)) return void openDiscussion(hint);
      if (rooms.length === 1) return void openDiscussion(rooms[0].id);
      setCandidates(rooms);
      setSelectedCandidateId(rooms[0]?.id);
      setChooserVisible(true);
      if (rooms.length === 0) setDiscussionError("There are no eligible conversations for this file.");
    } catch (caught) {
      setDiscussionError(caught instanceof Error ? caught.message : "Could not find eligible conversations.");
    } finally {
      setDiscussionLoading(false);
    }
  }, [activeServer, artifactId, openDiscussion, originRoomId]);

  const startNewDiscussion = useCallback(async () => {
    if (!activeServer || !artifactId) return;
    setCreatingDiscussion(true);
    setDiscussionError(null);
    try {
      const room = await getApiClient(activeServer.serverUrl).createArtifactDiscussionRoom(artifactId);
      await openDiscussion(room.id);
    } catch (caught) {
      setDiscussionError(caught instanceof Error ? caught.message : "Could not start a new conversation.");
    } finally {
      setCreatingDiscussion(false);
    }
  }, [activeServer, artifactId, openDiscussion]);

  return (
    <View style={styles.container}>
      <AppBar title={title} left={<AppBarBackButton onPress={() => router.back()} />}
        showOverflow={artifact !== null} embedOverflowSheet={false}
        onOverflowPress={() => { setRenameError(undefined); setRenameRetryable(false); setDeleteError(undefined); setDeleteRetryable(false); setRenameVisible(true); }} />
      {capabilityError ? (
        <View style={styles.capabilityError} accessibilityRole="alert">
          <Text style={styles.capabilityErrorText}>{capabilityError}</Text>
        </View>
      ) : null}
      {!renameVisible ? <ArtifactSaveStatus operation={fileSave} /> : null}
      {artifact ? <ArtifactViewerActionsSheet key={shareScope} artifact={artifact} visible={renameVisible}
        onSaveFile={() => { void fileSave.save(artifact.id); }} saveBusy={fileSave.busy}
        {...(canShareOriginalFile() ? { onShareFile: () => { void fileSave.save(artifact.id, "share"); } } : {})}
        {...(isMediaLibraryCandidate(artifact.mimeType) ? { onSaveMedia: () => { void fileSave.save(artifact.id, "media"); } } : {})}
        saveStatus={<ArtifactSaveStatus operation={fileSave} />}
        shareContent={artifact.canWrite && activeServer && viewer ? <WorkspaceShareSheet embedded
          serverUrl={activeServer.serverUrl} artifactId={artifact.id} path={artifact.path} roomId={originRoomId} viewerId={viewer.userId}
          isCurrent={isShareScopeCurrent} onClose={closeActions} /> : undefined}
        renameBusy={renameBusy} renameRetryable={renameRetryable} deleteBusy={deleteBusy} deleteRetryable={deleteRetryable} deleteReconcileRequired={deleteReconcileOnClose}
        {...(renameError ? { renameError } : {})} {...(deleteError ? { deleteError } : {})} onClose={() => { fileSave.cancel(); closeActions(); }}
        onRename={(basename) => { void rename(basename); }} onRetryRename={() => { void retryRename(); }}
        onDelete={() => { void deleteArtifact(); }} onRetryDelete={() => { void retryDelete(); }} /> : null}
      {artifact ? (
        <View style={styles.mimeBar}>
          <Text style={styles.mimeText} numberOfLines={1}>{artifact.mimeType}</Text>
          <Pressable onPress={() => void fileSave.save(artifact.id)} disabled={fileSave.busy}
            accessibilityRole="button" accessibilityLabel="Save original file" accessibilityState={{ disabled: fileSave.busy }}
            hitSlop={4}
            style={({ pressed }) => artifactViewerActionButtonStyle(mimeBarActionAppearance, pressed)}>
            <Text style={artifactViewerActionLabelStyle(mimeBarActionAppearance)}>Save file…</Text>
          </Pressable>
          {showEditAdmission ? (
            <ArtifactEditAction
              artifactId={artifactId}
              artifact={artifact}
              {...(result?.kind === "text" ? { content: result.content } : {})}
              load={loadEditAdmission}
              roomId={originRoomId}
              appearance={mimeBarActionAppearance}
            />
          ) : null}
        </View>
      ) : null}
      <View
        style={styles.contentPrimary}
        onLayout={(event) => setDockAreaHeight(event.nativeEvent.layout.height)}>
        <View style={styles.artifactContent}>
          {state.kind === "loading" ? (
            <View style={styles.stateWrap}>
              <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading file" />
              <Text style={styles.stateSub}>Loading file…</Text>
            </View>
          ) : result?.kind === "text" ? (
            <TextPreview result={result} styles={styles} />
          ) : result?.kind === "video" ? (
            <ArtifactVideoPreview artifactId={result.artifact.id} revision={result.artifact.revision} />
          ) : result?.kind === "file" && classifyArtifactKind(result.artifact.path, result.mimeType) === "image" ? (
            <ImagePreview
              fileUri={result.fileUri}
              sourceKey={JSON.stringify([
                activeServer?.id,
                viewer?.userId,
                result.artifact.id,
                result.artifact.artifactId,
                result.artifact.revision,
              ])}
            />
          ) : result?.kind === "file" && classifyArtifactKind(result.artifact.path, result.mimeType) === "pdf" ? (
            <PdfPreview result={result} styles={styles} theme={t} />
          ) : result?.kind === "file" ? (
            <UnavailableFilePreview styles={styles} theme={t} />
          ) : result?.kind === "cancelled" ? null : result ? (
            <Outcome result={result} onRetry={loadArtifact} styles={styles} theme={t} />
          ) : null}
        </View>
        {artifact && !discussionRoomId ? <View style={styles.discussBar}>
          {discussionError ? <Text style={styles.discussionError}>{discussionError}</Text> : null}
          <Pressable style={[styles.discussButton, discussionLoading && styles.disabledButton]}
            onPress={() => void discuss()} disabled={discussionLoading}
            accessibilityRole="button" accessibilityLabel="Discuss this file">
            <Ionicons name="chatbubble-ellipses-outline" size={18} color="#fff" />
            <Text style={styles.discussButtonText}>{discussionLoading ? "Finding conversations…" : "Discuss this file"}</Text>
          </Pressable>
        </View> : null}
        {discussionRoomId && artifact && shouldMountArtifactDiscussion(true, discussionRoomId) ? (
          <ArtifactDiscussionDock
            roomId={discussionRoomId}
            artifactRef={artifactDiscussionRef(artifact)}
            dockAreaHeight={dockAreaHeight}
            styles={styles}
            theme={t}
          />
        ) : null}
      </View>
      <Modal visible={chooserVisible} transparent animationType="fade" onRequestClose={() => setChooserVisible(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setChooserVisible(false)}
            accessibilityRole="button" accessibilityLabel="Dismiss conversation chooser" />
          <View style={styles.chooserPanel}>
            <Text style={styles.chooserTitle}>Discuss this file</Text>
            <Text style={styles.chooserSub}>Where should this conversation continue?</Text>
            {discussionError ? <Text style={styles.discussionError}>{discussionError}</Text> : null}
            {candidates.map((candidate) => <Pressable key={candidate.id} style={styles.choiceRow}
              onPress={() => setSelectedCandidateId(candidate.id)} accessibilityRole="radio"
              accessibilityLabel={candidate.label} accessibilityState={{ selected: selectedCandidateId === candidate.id }}>
              <Ionicons name={selectedCandidateId === candidate.id ? "radio-button-on" : "radio-button-off"} size={20} color={t.color.brand.accent} />
              <Text style={styles.choiceLabel}>{candidate.label}</Text>
            </Pressable>)}
            <Pressable style={[styles.newConversationButton, creatingDiscussion && styles.disabledButton]}
              disabled={creatingDiscussion} onPress={() => void startNewDiscussion()}
              accessibilityRole="button" accessibilityLabel="Start a new conversation">
              <Ionicons name="add-circle-outline" size={19} color={t.color.brand.accent} />
              <Text style={styles.newConversationText}>{creatingDiscussion ? "Starting new conversation…" : "Start a new conversation"}</Text>
            </Pressable>
            <Pressable style={[styles.discussButton, !selectedCandidateId && styles.disabledButton]}
              disabled={!selectedCandidateId} onPress={() => selectedCandidateId && void openDiscussion(selectedCandidateId)}
              accessibilityRole="button" accessibilityLabel="Continue discussion">
              <Text style={styles.discussButtonText}>Continue</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ArtifactDiscussionDock({
  roomId,
  artifactRef,
  dockAreaHeight,
  styles,
  theme,
}: {
  roomId: string;
  artifactRef: ReturnType<typeof artifactDiscussionRef>;
  dockAreaHeight: number;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  // Keep the stateful chat controller outside the base artifact viewer. It
  // must not connect, hydrate, or schedule state until Discuss has resolved a
  // concrete destination.
  const chat = useRoomChatController({ roomId, artifactRefs: [artifactRef] });
  const platformCapabilities = usePlatformCapabilities();
  const dockedChatCapabilities = useMemo(
    () => dockedRoomChatCapabilitiesForPlatform(platformCapabilities),
    [platformCapabilities],
  );
  const [dockSnap, setDockSnap] = useState<ChatDockSnap>("half");
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [modelSheetVisible, setModelSheetVisible] = useState(false);
  const dragStartHeight = useRef(COLLAPSED_DOCK_HEIGHT);

  useEffect(() => {
    if (!chat.canInvokeAgents) setModelSheetVisible(false);
  }, [chat.canInvokeAgents]);

  const snapHeights = useMemo(() => {
    const full = Math.max(COLLAPSED_DOCK_HEIGHT, dockAreaHeight - 56);
    return {
      collapsed: COLLAPSED_DOCK_HEIGHT,
      half: Math.max(COLLAPSED_DOCK_HEIGHT, Math.round(dockAreaHeight * 0.5)),
      full,
    };
  }, [dockAreaHeight]);
  const dockHeight = dragHeight ?? snapHeights[dockSnap];

  const snapToNearestHeight = useCallback(
    (height: number) => {
      const next = (Object.keys(snapHeights) as ChatDockSnap[]).reduce(
        (closest, snap) =>
          Math.abs(snapHeights[snap] - height) < Math.abs(snapHeights[closest] - height)
            ? snap
            : closest,
        "collapsed",
      );
      setDragHeight(null);
      setDockSnap(next);
    },
    [snapHeights],
  );

  const cycleDockSnap = useCallback(() => {
    setDragHeight(null);
    setDockSnap((current) =>
      current === "collapsed" ? "half" : current === "half" ? "full" : "collapsed",
    );
  }, []);

  const dockPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartHeight.current = dockHeight;
        },
        onPanResponderMove: (_event, gesture) => {
          const maxHeight = snapHeights.full;
          setDragHeight(
            Math.max(MIN_DOCK_HEIGHT, Math.min(maxHeight, dragStartHeight.current - gesture.dy)),
          );
        },
        onPanResponderRelease: (_event, gesture) => {
          snapToNearestHeight(dragStartHeight.current - gesture.dy);
        },
        onPanResponderTerminate: () => snapToNearestHeight(dragStartHeight.current),
      }),
    [dockHeight, snapHeights.full, snapToNearestHeight],
  );

  return (
    <>
      <KeyboardStickyView style={[styles.chatDock, { height: dockHeight }]}>
        <View
          {...dockPanResponder.panHandlers}
          style={styles.dockHandleArea}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Resize room chat"
          accessibilityHint="Drag up or down to resize the room chat"
          accessibilityValue={{ text: `${dockSnap} height` }}
          accessibilityActions={[
            { name: "increment", label: "Expand room chat" },
            { name: "decrement", label: "Collapse room chat" },
          ]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "increment") {
              setDockSnap((current) => (current === "collapsed" ? "half" : "full"));
            } else if (event.nativeEvent.actionName === "decrement") {
              setDockSnap((current) => (current === "full" ? "half" : "collapsed"));
            }
          }}>
          <View style={styles.dockHandle} />
        </View>
        <View style={styles.dockHeader}>
          <Text style={styles.dockTitle}>Room chat</Text>
          <Pressable
            style={styles.dockToggle}
            onPress={cycleDockSnap}
            accessibilityRole="button"
            accessibilityLabel={`Room chat: ${dockSnap}. Change height`}>
            <Ionicons
              name={dockSnap === "full" ? "chevron-down" : "chevron-up"}
              size={18}
              color={theme.color.text.muted}
            />
          </Pressable>
        </View>
        {dockSnap !== "collapsed" || dragHeight != null ? (
          <View style={styles.chatTranscript}>
            <RoomChatPane controller={chat} actionSurface="room" />
          </View>
        ) : null}
        {chat.canInvokeAgents || (!chat.roomMembersLoading && !chat.directAgentRoom) ? (
          <RoomChatComposer
            controller={chat}
            capabilities={dockedChatCapabilities}
            onOpenModelSheet={() => setModelSheetVisible(true)}
          />
        ) : null}
      </KeyboardStickyView>
      {chat.canInvokeAgents ? (
        <ModelSwitcherSheet
          visible={modelSheetVisible}
          onClose={() => setModelSheetVisible(false)}
          selectedModelId={chat.modelId}
          defaultModelLabel={chat.defaultModelLabel}
          onSelect={chat.handleModelSelect}
        />
      ) : null}
    </>
  );
}

function TextPreview({
  result,
  styles,
}: {
  result: Extract<ArtifactBytesResult, { kind: "text" }>;
  styles: ReturnType<typeof createStyles>;
}) {
  const viewerKind = classifyArtifactKind(result.artifact.path, result.mimeType);

  if (viewerKind === "markdown") {
    return (
      <ScrollView contentContainerStyle={styles.textContent}>
        <ArtifactMarkdownPreview source={result.content} />
      </ScrollView>
    );
  }
  if (viewerKind === "writer") {
    return <ArtifactDocumentPreview key={result.artifact.revision} source={result.content} />;
  }
  return (
    <ScrollView contentContainerStyle={styles.textContent}>
      <Text selectable style={styles.textPreview}>{result.content}</Text>
    </ScrollView>
  );
}

function ImagePreview({ fileUri, sourceKey }: { fileUri: string; sourceKey: string }) {
  return (
    <ArtifactImageInspector uri={fileUri} sourceKey={sourceKey} accessibilityLabel="Artifact image preview" />
  );
}

type PdfHandoffState =
  | { kind: "ready" }
  | { kind: "opening" }
  | { kind: "unavailable" }
  | { kind: "failed" };

function PdfPreview({
  result,
  styles,
  theme,
}: {
  result: Extract<ArtifactBytesResult, { kind: "file" }>;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const [handoffState, setHandoffState] = useState<PdfHandoffState>({ kind: "ready" });

  const openPdf = useCallback(async () => {
    setHandoffState({ kind: "opening" });
    try {
      if (!(await isArtifactFileHandoffAvailable(result.fileUri))) {
        setHandoffState({ kind: "unavailable" });
        return;
      }
      await openArtifactFile(result.fileUri, {
        title: "Open PDF",
        mimeType: result.mimeType,
      });
      setHandoffState({ kind: "ready" });
    } catch {
      setHandoffState({ kind: "failed" });
    }
  }, [result.fileUri, result.mimeType]);

  const statusCopy = pdfHandoffCopy(handoffState);
  return (
    <View style={styles.stateWrap}>
      <Ionicons name="document-text-outline" size={36} color={theme.color.text.muted} />
      <Text style={styles.stateTitle}>{statusCopy.title}</Text>
      <Text style={styles.stateSub}>{statusCopy.detail}</Text>
      <Pressable
        style={[styles.retryButton, handoffState.kind === "opening" && styles.disabledButton]}
        onPress={() => void openPdf()}
        disabled={handoffState.kind === "opening"}
        accessibilityRole="button"
        accessibilityLabel="Open PDF in another app"
        accessibilityState={{ disabled: handoffState.kind === "opening" }}
      >
        <Text style={styles.retryText}>{handoffState.kind === "opening" ? "Opening PDF…" : "Open PDF"}</Text>
      </Pressable>
    </View>
  );
}

function pdfHandoffCopy(state: PdfHandoffState) {
  switch (state.kind) {
    case "opening":
      return { title: "Opening PDF", detail: "Preparing the PDF viewer." };
    case "unavailable":
      return {
        title: "PDF handoff unavailable",
        detail: "This browser or device cannot open this PDF right now.",
      };
    case "failed":
      return {
        title: "Could not open PDF",
        detail: "The downloaded PDF could not be opened. Try again.",
      };
    case "ready":
      return {
        title: "PDF ready to open",
        detail: "Open this PDF in an available viewer.",
      };
  }
}

function UnavailableFilePreview({ styles, theme }: { styles: ReturnType<typeof createStyles>; theme: AppTheme }) {
  return (
    <View style={styles.stateWrap}>
      <Ionicons name="document-attach-outline" size={36} color={theme.color.text.muted} />
      <Text style={styles.stateTitle}>File</Text>
      <Text style={styles.stateSub}>Use the actions menu to manage this file, or discuss it below.</Text>
    </View>
  );
}

function Outcome({
  result,
  onRetry,
  styles,
  theme,
}: {
  result: Exclude<ArtifactBytesResult, { kind: "text" | "file" | "video" | "cancelled" }>;
  onRetry: () => (() => void);
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
}) {
  const copy = outcomeCopy(result);
  return (
    <View style={styles.stateWrap}>
      <Ionicons name={copy.icon} size={36} color={theme.color.text.muted} />
      <Text style={styles.stateTitle}>{copy.title}</Text>
      <Text style={styles.stateSub}>{copy.detail}</Text>
      {copy.retry ? (
        <Pressable style={styles.retryButton} onPress={() => onRetry()} accessibilityRole="button" accessibilityLabel="Retry loading file">
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function outcomeCopy(result: Exclude<ArtifactBytesResult, { kind: "text" | "file" | "video" | "cancelled" }>) {
  switch (result.kind) {
    case "too_large":
      return {
        icon: "expand-outline" as const,
        title: "File is too large to preview",
        detail: `${formatBytes(result.sizeBytes)} exceeds the ${formatBytes(result.maxBytes)} preview limit.`,
        retry: false,
      };
    case "unsupported":
      return {
        icon: "document-attach-outline" as const,
        title: "File",
        detail: "Use the actions menu to manage this file, or discuss it below.",
        retry: false,
      };
    case "missing_room":
      return { icon: "shield-outline" as const, title: "File unavailable", detail: "Choose a conversation before opening a file.", retry: false };
    case "not_found":
      return { icon: "alert-circle-outline" as const, title: "File not found", detail: "This file may have been removed.", retry: false };
    case "forbidden":
      return { icon: "lock-closed-outline" as const, title: "Access denied", detail: "You don’t have permission to view this file.", retry: false };
    case "auth_dead":
      return { icon: "key-outline" as const, title: "Sign in required", detail: "Your session has expired. Sign in again to view this file.", retry: false };
    case "not_implemented":
      return { icon: "construct-outline" as const, title: "Preview unavailable", detail: "This preview is not available on this server.", retry: false };
    case "network":
      return { icon: "cloud-offline-outline" as const, title: "Could not load file", detail: "Check your connection and try again.", retry: true };
    case "server":
      return { icon: "alert-circle-outline" as const, title: "Could not load file", detail: "The server could not prepare this file preview.", retry: true };
  }
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function renameMessage(reason: "auth-dead" | "capability" | "conflict" | "disposed" | "missing" | "offline" | "permission" | "server" | "validation"): string {
  switch (reason) {
    case "auth-dead": return "Your session expired.";
    case "capability": return WRITE_ARTIFACTS_REQUIRED_COPY;
    case "conflict": return "That filename is already in use.";
    case "missing": return "This file is no longer available or can no longer be renamed.";
    case "permission": return "You no longer have permission to rename this file.";
    case "offline": return "Could not confirm the rename. Retry uses the original filename, or close to reload.";
    case "server": return "The server could not confirm the rename. Retry uses the original filename, or close to reload.";
    case "disposed": return "This rename is no longer active.";
    case "validation": return "Enter a different filename without folders or spaces at either end.";
  }
}

function deleteMessage(reason: "auth-dead" | "capability" | "disposed" | "missing" | "offline" | "permission" | "server"): string {
  switch (reason) {
    case "auth-dead": return "Your session expired.";
    case "capability": return WRITE_ARTIFACTS_REQUIRED_COPY;
    case "missing": return "The delete could not be confirmed. Close this sheet to check the latest file state.";
    case "permission": return "You no longer have permission to delete this file. Close this sheet to check the latest file state.";
    case "offline": return "Could not confirm the delete. Retry sends the same request, or close to check the latest file state.";
    case "server": return "The server could not confirm the delete. Retry sends the same request, or close to check the latest file state.";
    case "disposed": return "This delete is no longer active.";
  }
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    capabilityError: {
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.status.error,
      backgroundColor: t.color.surface.panel,
    },
    capabilityErrorText: { ...t.typography.caption, color: t.color.status.error },
    contentPrimary: { flex: 1, minHeight: 0 },
    artifactContent: { flex: 1, minHeight: 0 },
    mimeBar: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: t.spacing.md,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    mimeText: { flex: 1, color: t.color.text.muted, ...t.typography.caption },
    discussBar: { padding: t.spacing.lg, gap: t.spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.color.border.default },
    discussButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent },
    discussButtonText: { color: "#fff", ...t.typography.label },
    discussionError: { color: t.color.text.muted, textAlign: "center", ...t.typography.caption },
    chatDock: {
      borderTopWidth: 1,
      borderTopColor: t.color.border.default,
      backgroundColor: t.color.surface.background,
      overflow: "hidden",
    },
    dockHandleArea: {
      height: 24,
      alignItems: "center",
      justifyContent: "center",
    },
    dockHandle: {
      width: 40,
      height: 4,
      borderRadius: t.radii.pill,
      backgroundColor: t.color.border.interactive,
    },
    dockHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.xs,
    },
    dockTitle: { color: t.color.text.foreground, ...t.typography.label },
    dockToggle: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.pill,
    },
    chatTranscript: { flex: 1, minHeight: 0 },
    modalRoot: { flex: 1, justifyContent: "center", padding: t.spacing.lg },
    modalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0, 0, 0, 0.48)" },
    chooserPanel: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.background },
    chooserTitle: { color: t.color.text.foreground, ...t.typography.subheading },
    chooserSub: { color: t.color.text.muted, ...t.typography.body },
    choiceRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, minHeight: 44 },
    choiceLabel: { flex: 1, color: t.color.text.foreground, ...t.typography.body },
    newConversationButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: t.spacing.sm, minHeight: 44, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md },
    newConversationText: { color: t.color.brand.accent, ...t.typography.label },
    stateWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.sm, padding: t.spacing.xl },
    stateTitle: { color: t.color.text.foreground, textAlign: "center", ...t.typography.subheading },
    stateSub: { color: t.color.text.muted, textAlign: "center", ...t.typography.body },
    retryButton: { marginTop: t.spacing.sm, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default },
    disabledButton: { opacity: 0.6 },
    retryText: { color: t.color.text.foreground, ...t.typography.label },
    textContent: { padding: t.spacing.lg, paddingBottom: t.spacing.xxl },
    textPreview: { color: t.color.text.foreground, fontFamily: "monospace", ...t.typography.body },
  });
}
