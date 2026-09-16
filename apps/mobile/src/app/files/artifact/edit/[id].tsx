import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { loadArtifactForEdit, type ArtifactEditLoadResult } from "@/features/artifacts/artifact-edit-loader";
import { ArtifactEditorShell } from "@/features/artifacts/artifact-editor-shell";
import { selectArtifactEditorRoute } from "@/features/artifacts/artifact-editor-routing";
import {
  ArtifactSourceSaveController,
  createArtifactReloadFence,
  type SourceSaveFailure,
} from "@/features/artifacts/artifact-source-save-controller";
import { commitNativeSourceBaseline } from "@/features/artifacts/native-source-buffer";
import {
  NativeSourceEditor,
  NativeSourceToolbar,
  replaceNativeSourceDocument,
  useNativeSourceEditorSession,
} from "@/features/artifacts/native-source-editor";
import { getApiClient } from "@/lib/api";
import {
  WRITE_ARTIFACTS_REQUIRED_COPY,
  refreshMobileCapabilityDenial,
  type MobileCapabilityScope,
} from "@/lib/mobile-capability-denial";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";

export default function ArtifactEditRoute() {
  const { activeServer } = useServers();
  const params = useLocalSearchParams<{
    id?: string | string[];
    roomId?: string | string[];
  }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const roomId = Array.isArray(params.roomId) ? params.roomId[0] : params.roomId;
  const [state, setState] = useState<ArtifactEditLoadResult>();
  const [retryEpoch, setRetryEpoch] = useState(0);
  const run = useRef(0);
  const navigateBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (id) {
      router.replace({
        pathname: "/files/artifact/[id]",
        params: { id, ...(roomId ? { roomId } : {}) },
      });
      return;
    }
    router.replace("/(drawer)/(tabs)/files");
  }, [id, roomId]);

  useEffect(() => {
    const current = ++run.current;
    const abort = new AbortController();
    setState(undefined);
    if (!activeServer || !id) {
      navigateBack();
      return;
    }
    void loadArtifactForEdit({
      client: getApiClient(activeServer.serverUrl),
      artifactId: id,
      serverId: activeServer.id,
      baseUrl: activeServer.serverUrl,
      signal: abort.signal,
    }).then((result) => {
      if (run.current === current && !abort.signal.aborted) setState(result);
    }).catch(() => {
      if (!abort.signal.aborted) navigateBack();
    });
    return () => abort.abort();
  }, [activeServer, id, navigateBack, retryEpoch, roomId]);

  useEffect(() => {
    if (state && state.kind !== "ready" && state.kind !== "network") navigateBack();
    if (state?.kind === "ready" && selectArtifactEditorRoute(state.admission).kind === "none") navigateBack();
  }, [navigateBack, state]);

  const sessionKey = `${activeServer?.id ?? "none"}:${id ?? "none"}:${roomId ?? "aggregate"}:${state?.kind === "ready" ? state.artifact.revision : retryEpoch}`;
  if (!state) {
    return (
      <ArtifactEditorShell
        title="Edit file"
        sessionKey={sessionKey}
        phase={{ kind: "loading" }}
        onBack={navigateBack}
      />
    );
  }
  if (state.kind === "network") {
    return (
      <ArtifactEditorShell
        title="Edit file"
        sessionKey={sessionKey}
        phase={{
          kind: "error",
          message: "Could not load this file. Check your connection and try again.",
          onRetry: () => setRetryEpoch((current) => current + 1),
        }}
        onBack={navigateBack}
      />
    );
  }
  if (state.kind !== "ready") return null;
  const selectedEditor = selectArtifactEditorRoute(state.admission);
  if (selectedEditor.kind === "source" && state.admission.kind === "source" && activeServer) {
    return (
      <SourceArtifactEditor
        key={sessionKey}
        ready={{ ...state, admission: state.admission }}
        sessionKey={sessionKey}
        serverId={activeServer.id}
        baseUrl={activeServer.serverUrl}
        onBack={navigateBack}
      />
    );
  }
  return null;
}

type ReadyArtifact = Extract<ArtifactEditLoadResult, { kind: "ready" }>;
type ReadySourceArtifact = ReadyArtifact & {
  admission: Extract<ReadyArtifact["admission"], { kind: "source" }>;
};

type SourceSaveNotice = {
  reason: SourceSaveFailure;
  message: string;
  onRetry?: () => void;
  actions?: Array<{ label: string; onPress: () => void; disabled?: boolean }>;
};

function saveFailureMessage(reason: SourceSaveFailure): string {
  switch (reason) {
    case "auth-dead": return "Your session expired. Your edits are preserved.";
    case "capability": return `${WRITE_ARTIFACTS_REQUIRED_COPY} Your edits are preserved.`;
    case "conflict": return "This file changed elsewhere. Your edits are preserved.";
    case "missing": return "This file is no longer available. Your edits are preserved.";
    case "permission": return "You no longer have permission to save this file. Your edits are preserved.";
    case "size": return "This edit is too large to save on mobile. Your edits are preserved.";
    case "validation": return "This edit could not be saved. Your edits are preserved.";
    case "server": return "The server could not confirm the save. Your edits are preserved.";
    case "offline": return "Could not confirm the save. Check your connection; your edits are preserved.";
    case "disposed": return "The save result is no longer active.";
  }
}

function SourceArtifactEditor({ ready, sessionKey, serverId, baseUrl, onBack }: {
  ready: ReadySourceArtifact;
  sessionKey: string;
  serverId: string;
  baseUrl: string;
  onBack: () => void;
}) {
  const { activeServer } = useServers();
  const { viewer, refreshViewer } = useAuth();
  const capabilityScopeRef = useRef<MobileCapabilityScope | null>(null);
  capabilityScopeRef.current = activeServer && viewer
    ? { serverId: activeServer.id, userId: viewer.userId }
    : null;
  const currentCapabilityScope = useCallback(() => capabilityScopeRef.current, []);
  const [document, setDocument] = useState(ready);
  const session = useNativeSourceEditorSession(ready.admission.content);
  const controllerRef = useRef<ArtifactSourceSaveController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new ArtifactSourceSaveController(
      { revision: ready.artifact.revision, sha256: ready.baseSha256 },
      Crypto.randomUUID,
    );
  }
  const controller = controllerRef.current;
  const mounted = useRef(true);
  const reloadFence = useRef(createArtifactReloadFence()).current;
  const reloadInFlight = useRef(false);
  const recoveryControls = useRef<{ markDirty: () => void; markClean: () => void } | undefined>(undefined);
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [saveNotice, setSaveNotice] = useState<SourceSaveNotice>();
  const [conflicted, setConflicted] = useState(false);
  const [writeCapabilityDenied, setWriteCapabilityDenied] = useState(false);
  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => () => {
    mounted.current = false;
    reloadFence.cancel();
    controller.dispose();
  }, [controller, reloadFence]);

  const reportDirty = (dirty: boolean, controls: { markDirty: () => void; markClean: () => void }) => {
    if (dirty) controls.markDirty();
    else controls.markClean();
  };
  const save = async (
    controls: { markDirty: () => void; markClean: () => void },
    retry: boolean,
  ) => {
    const actionScope = currentCapabilityScope();
    setSaveState("saving");
    setSaveNotice(undefined);
    const client = getApiClient(baseUrl);
    const result = retry
      ? await controller.retry(client)
      : await controller.save({
        client,
        id: document.artifact.id,
        content: session.buffer.current.current,
        mimeType: document.artifact.mimeType,
        checkpoint: true,
      });
    if (!mounted.current) return;
    setSaveState("idle");
    if (result.state === "idle") {
      reportDirty(
        commitNativeSourceBaseline(session.buffer.current, result.acceptedContent),
        controls,
      );
      setSaveNotice(undefined);
      return;
    }
    if (result.reason === "capability") {
      const denial = await refreshMobileCapabilityDenial({
        denial: { capability: "write_artifacts", message: WRITE_ARTIFACTS_REQUIRED_COPY },
        actionScope,
        getCurrentScope: currentCapabilityScope,
        refreshViewer,
      });
      if (!mounted.current || !denial) return;
      setWriteCapabilityDenied(true);
    }
    const notice: SourceSaveNotice = {
      reason: result.reason,
      message: saveFailureMessage(result.reason),
    };
    if (result.retryable) {
      notice.onRetry = () => { void save(controls, true); };
    }
    if (result.state === "conflict") {
      recoveryControls.current = controls;
      setConflicted(true);
      setRecoveryExpanded(true);
    }
    setSaveNotice(notice);
  };

  const copyChanges = async () => {
    setCopying(true);
    try {
      await Clipboard.setStringAsync(session.buffer.current.current);
    } catch {
      if (mounted.current) {
        setSaveNotice({ reason: "conflict", message: "Could not copy your changes. Your edits are preserved." });
      }
    } finally {
      if (mounted.current) setCopying(false);
    }
  };

  const applyLatest = async () => {
    if (reloadInFlight.current) return;
    const captured = session.buffer.current.current;
    const reload = reloadFence.begin();
    reloadInFlight.current = true;
    setSaveNotice({ reason: "conflict", message: "Loading the latest file…" });
    try {
      const latest = await loadArtifactForEdit({
        client: getApiClient(baseUrl),
        artifactId: document.artifact.id,
        serverId,
        baseUrl,
        signal: reload.signal,
      });
      if (!mounted.current || !reloadFence.isCurrent(reload.generation)) return;
      if (session.buffer.current.current !== captured) {
        setSaveNotice({ reason: "conflict", message: "You edited while the latest file was loading. Your edits are preserved." });
        setRecoveryExpanded(true);
        return;
      }
      if (latest.kind !== "ready" || latest.admission.kind !== "source") {
        setSaveNotice({ reason: "conflict", message: "Could not load an editable latest version. Your edits are preserved." });
        setRecoveryExpanded(true);
        return;
      }
      if (!controller.resolveConflictWithLatest({ revision: latest.artifact.revision, sha256: latest.baseSha256 })) {
        setSaveNotice({ reason: "conflict", message: "Could not apply the latest version. Your edits are preserved." });
        setRecoveryExpanded(true);
        return;
      }
      replaceNativeSourceDocument(session, latest.admission.content);
      setDocument({ ...latest, admission: latest.admission });
      recoveryControls.current?.markClean();
      setConflicted(false);
      setRecoveryExpanded(false);
      setSaveNotice(undefined);
    } catch {
      if (mounted.current && reloadFence.isCurrent(reload.generation)) {
        setSaveNotice({ reason: "conflict", message: "Could not load the latest file. Your edits are preserved." });
        setRecoveryExpanded(true);
      }
    } finally {
      if (reloadFence.isCurrent(reload.generation)) reloadInFlight.current = false;
    }
  };

  const confirmReloadLatest = () => {
    Alert.alert(
      "Reload latest?",
      "This replaces your local edits with the latest saved file.",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Reload latest", style: "destructive", onPress: () => { void applyLatest(); } },
      ],
    );
  };

  const keepEditing = () => {
    if (reloadInFlight.current) {
      reloadFence.cancel();
      reloadInFlight.current = false;
      setSaveNotice({ reason: "conflict", message: "This file changed elsewhere. Your edits are preserved." });
    }
    setRecoveryExpanded(false);
  };

  const presentedNotice = conflicted ? {
    reason: "conflict" as const,
    message: saveNotice?.message ?? "This file changed elsewhere. Your edits are preserved.",
    actions: recoveryExpanded ? [
      { label: "Reload latest", onPress: confirmReloadLatest, disabled: reloadInFlight.current },
      { label: copying ? "Copying…" : "Copy changes", onPress: () => { void copyChanges(); }, disabled: copying },
      { label: "Keep editing", onPress: keepEditing },
    ] : [
      { label: "Review options", onPress: () => setRecoveryExpanded(true) },
    ],
  } : saveNotice;
  return (
    <ArtifactEditorShell
      title={document.artifact.path}
      sessionKey={sessionKey}
      phase={{ kind: "ready" }}
      saveState={conflicted || writeCapabilityDenied ? "unavailable" : saveState}
      onSave={(controls) => { void save(controls, false); }}
      onBack={onBack}
      saveNotice={presentedNotice}
      toolbar={document.admission.format === "markdown" ? (controls) => (
        <NativeSourceToolbar
          session={session}
          onDirtyChange={(dirty) => reportDirty(dirty, controls)}
        />
      ) : undefined}
    >
      {(controls) => (
        <NativeSourceEditor
          content={ready.admission.content}
          session={session}
          onDirtyChange={(dirty) => reportDirty(dirty, controls)}
        />
      )}
    </ArtifactEditorShell>
  );
}
