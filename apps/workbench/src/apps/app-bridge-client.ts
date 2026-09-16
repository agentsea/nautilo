import type { AppRecoveryRead, AppRecoveryWrite } from "./app-draft-recovery";
import type { AppSlideTemplateLibrary } from "./app-slide-templates";

/**
 * M185 — iframe-side client for the mini-app postMessage bridge.
 *
 * Runs inside the sandboxed mini-app `srcDoc` iframe. The parent workbench
 * (`mini-app-surface.tsx`, wired separately) installs the host-side handler
 * that binds artifact/fs targets from closure. Mini-app JS calls
 * `window.nautiloApp.document.*`, `window.nautiloApp.state.*`, and
 * `window.nautiloApp.context.set(...)`.
 *
 * Contract:
 *   - `await nautiloApp.document.read()` / `stat()` / `write(next, opts?)`
 *   - `await nautiloApp.state.get(key)` / `set(key, value)`
 *   - `nautiloApp.context.set(summary)` — one-way, no response
 *
 * Failure modes:
 *   - Host failures surface as `new Error(<reason>)` with upstream status
 *     when present: `[403] No writable namespace`.
 *   - Elapsed wall time never manufactures a bridge failure. Requests remain
 *     pending until the bound host returns their authoritative disposition.
 *
 * Security:
 *   - No cookies, localStorage, fetch, or Authorization headers.
 *   - No host IDs (appId, artifactId, path, roomId, bearer, etc.) on the
 *     global or in postMessage envelopes.
 *   - Responses accepted only when `event.source === window.parent`.
 */

import type { PreparedAppExport } from "./mini-app-export";
export type { PreparedAppExport } from "./mini-app-export";

export interface AppContextSummary {
  [key: string]: unknown;
}

type AppPreferenceKey =
  | "writer.spellcheck"
  | "design.agentReceipts"
  | "video.agentReceipts"
  | "video.firstSourceRate";

/**
 * Presentation is host-owned, finite, and deliberately not persisted by a
 * mini-app. A sandbox receives its resolved mode so it need not (and cannot)
 * inspect the host's DOM or local storage.
 */
export type MiniAppTheme = "light" | "dark";

export type AppHumanEditUpdate = {
  state: "clean" | "dirty" | "saving" | "conflict";
  draftPatch?: {
    kind: "anchored_text";
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    scope?: { from: number; to: number };
  };
};

export type AppPrepareCloseRequest = {
  reason: "close" | "replace" | "navigate" | "suspend" | "quit";
  action: "prepare-close" | "save-copy";
};

export type AppPrepareCloseResult = {
  /** No local draft was admitted, for example an initial load failed. */
  noLocalChanges?: boolean;
  documentSaved: boolean;
  recoveryPersisted: boolean;
  recoverableDraftExact: boolean;
  errorMessage?: string | null;
};
export type NautiloVideoGenerationRequest = Readonly<{
  document: Readonly<{ sha256: string; revision: number | null }>;
  sourceFingerprint: string;
  job: Readonly<{
    source: Readonly<{ kind: "quick-brief" }> | Readonly<{ kind: "shot"; shotId: string }>;
    shotLabel?: string;
    prompt: string;
    modelId: "venice:seedance-2-5-text-to-video-basic" | "venice:seedance-2-5-reference-to-video-basic" | "venice:minimax-h3-enhanced-text-to-video";
    continuationTakeId?: string;
    requestedSettings?: Readonly<{
      durationSeconds?: number;
      aspectRatio?: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
      resolution?: "480p" | "720p" | "1080p" | "768P" | "2K";
      audio?: boolean;
    }>;
  }>;
}>;

export type NautiloVideoGenerationRequestResult =
  | Readonly<{ kind: "queued"; takeId?: string }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "submission-unknown"; takeId: string }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "unavailable"; code: string }>;

/** Parent-curated lineage only; it is never a receipt, URL, or byte transport. */
export type NautiloVideoGenerationTake = Readonly<{
  id: string;
  briefRevision: number;
  shotId?: string;
  shotLabel?: string;
  mediaKind: "video" | "audio";
  modelId: string;
  settings: Readonly<{ durationSeconds?: number; resolution?: string; aspectRatio?: string; audioEnabled?: boolean; instrumental?: boolean }>;
  /** `path` is a logical Workspace name, never a local filesystem path. */
  artifact: Readonly<{ artifactId: string; path: string; zone: "workspace"; mime: string; bytes: number }>;
}>;

export type NautiloVideoGenerationTakeStatus = Readonly<{
  takeId: string;
  revision: number;
  mediaKind: "video" | "audio";
  state: "preparing" | "submitting" | "queued" | "generating" | "downloading" | "saving" | "ready" | "cleanup-pending" | "needs-action" | "failed" | "unknown";
  modelId: string;
  settings: NautiloVideoGenerationTake["settings"];
  progress?: Readonly<{ phase: string; elapsedSeconds?: number; estimatedSeconds?: number; message?: string }>;
  artifact?: NautiloVideoGenerationTake["artifact"];
  failure?: Readonly<{ code: string; message: string; phase: string; retrySafe: boolean; stateChanged: boolean; completionCertainty: string; chargeCertainty: string; creditsRefunded?: boolean }>;
  recoveryActions: ReadonlyArray<Readonly<{ kind: string; label: string; newSpend: boolean }>>;
}>;

export type NautiloVideoGenerationTakeListResult =
  | Readonly<{ kind: "ready"; takes: ReadonlyArray<Readonly<{ takeId: string; shotId: string; shotLabel: string; documentRevision: number }>> }>
  | Readonly<{ kind: "unavailable"; code: string }>;
export type NautiloVideoGenerationTakeStatusResult =
  | Readonly<{ kind: "ready"; status: NautiloVideoGenerationTakeStatus }>
  | Readonly<{ kind: "unavailable"; code: string }>;
export type NautiloVideoGenerationPreviewResult =
  | Readonly<{ kind: "opened" }>
  | Readonly<{ kind: "unavailable"; code: string }>;
export type NautiloVideoGenerationRevalidationResult =
  | Readonly<{ status: "ready"; take: NautiloVideoGenerationTake; durationSec: number }>
  | Readonly<{ status: "stale" | "deleted" | "unavailable" | "malformed"; takeId: string }>;

export type NautiloVideoGenerationReferencesImportResult =
  | Readonly<{ kind: "ready"; assets: readonly Extract<NautiloVideoGenerationReferenceImportResult, { kind: "ready" }>["asset"][]; failures: readonly Readonly<{ label: string; code: string }>[] }>
  | Readonly<{ kind: "unavailable"; code: string }>;

export type NautiloVideoGenerationReferenceImportResult =
  | Readonly<{
      kind: "ready";
      asset: Readonly<{
        artifactId: string;
        path: string;
        label: string;
        mediaKind: "image" | "video" | "audio";
        mimeType: string;
        sizeBytes: number;
      }>;
    }>
  | Readonly<{ kind: "unavailable"; code: string }>;

export type AppDocumentChangeEvent =
  | { type: "changed" | "renamed" | "deleted" | "reconnected"; path?: string; reloadRequired?: boolean }
  | {
      type: "patch_applied";
      path?: string;
      patchId: string;
      revision: number | null;
      sha256: string;
      previousRevision: number | null;
      previousSha256: string;
      patch: {
        kind: "anchored_text";
        oldString: string;
        newString: string;
        replaceAll?: boolean;
        scope?: { from: number; to: number };
      };
      author?: { kind: "human" | "agent" | "app_tool"; displayName: string };
      rebased?: boolean;
      envelope: {
        content: string;
        mimeType: string;
        path: string;
        baseSha256: string;
        baseRevision: number | null;
      };
    };

export type AppLiveSessionCapability = {
  sessionToken: string;
  sessionId: string;
  documentVersion:
    | { kind: "artifact_revision"; revision: number }
    | { kind: "local_sha"; sha256: string };
};

export type AppLiveProposal = {
  proposalId: string;
  appId: string;
  sessionId: string;
  documentVersion:
    | { kind: "artifact_revision"; revision: number }
    | { kind: "local_sha"; sha256: string };
  operations: unknown[];
};

export type AppLiveSessionClosedEvent = {
  sessionId: string;
  reason: "relay_disconnected" | "session_closed";
};

export type NautiloAcceptProposalResult =
  | {
      ok: true;
      documentVersion: AppLiveSessionCapability["documentVersion"];
      contentSha256: string;
      localRevisionRef?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type NautiloAppBridgeClientCapabilities = Readonly<{
  /** Native Desktop crash-recovery journal exposed only to editable Slides frames. */
  recovery?: boolean;
  templates?: boolean;
}>;

export interface NautiloAppBridge {
  version: 1;
  templates?: AppSlideTemplateLibrary;
  /** Omitted when the host has no native recovery journal. */
  recovery?: {
    read(): Promise<AppRecoveryRead>;
    write(input: AppRecoveryWrite): Promise<{ revision: string | null }>;
  };
  assets: { pick(): Promise<unknown>; read(ref: string): Promise<unknown> };
  document: {
    read(opts?: { fresh?: boolean }): Promise<unknown>;
    authoredChange(): Promise<unknown>;
    stat(): Promise<unknown>;
    write(
      next: string | { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null; conflictPolicy?: "strict" },
    ): Promise<unknown>;
    saveCopy(next: string | { content: string }): Promise<{ path: string }>;
    /** Download a recovery copy without changing the bound document. */
    downloadCopy(content: string): Promise<void>;
    onChange(handler: (event: AppDocumentChangeEvent) => void): () => void;
  };
  state: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  preferences: {
    get<T = unknown>(key: AppPreferenceKey): Promise<T>;
    set<T = unknown>(key: AppPreferenceKey, value: T): Promise<T>;
    subscribe<T = unknown>(key: AppPreferenceKey, handler: (value: T) => void): () => void;
  };
  context: {
    readonly mode: "edit" | "preview";
    set(summary: AppContextSummary): void;
  };
  humanEdit: {
    /**
     * Publishes draft state only. The parent binds the target and resolves the
     * canonical base/version; mini-apps never receive or send that authority.
     */
    set(update: AppHumanEditUpdate): void;
  };
  lifecycle: {
    /** Register the app's one awaited persistence boundary before host removal. */
    onPrepareClose(
      handler: (request: AppPrepareCloseRequest) => AppPrepareCloseResult | Promise<AppPrepareCloseResult>,
    ): () => void;
  };
  exports: {
    onPrepare(
      handler: (request: { actionId: string; mimeType: string }) => PreparedAppExport | Promise<PreparedAppExport>,
    ): () => void;
  };
  session: {
    onCommand(handler: (command: unknown, version: AppLiveSessionCapability["documentVersion"]) => unknown): () => void;
    onChange(handler: (capability: AppLiveSessionCapability) => void): () => void;
    onProposal(handler: (proposal: AppLiveProposal) => void): () => void;
    /** Marks a proposal as visibly entered into review; delivery remains retryable until then. */
    acknowledgeProposal(input: {
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
    }): void;
    onClosed(handler: (event: AppLiveSessionClosedEvent) => void): () => void;
    acceptProposal(input: {
      requestId: string;
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
      acceptedOperationIndexes: number[];
      acceptedContent: string;
    }): Promise<NautiloAcceptProposalResult>;
    resolveProposal(input: {
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
      outcome: "accepted" | "rejected";
    }): Promise<{ ok: true; taskStatus: string }>;
    invalidateProposal(input: {
      proposalSessionToken: string;
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
      reason: "human_changed" | "stale_version" | "remote_changed" | "session_closed" | "no_effective_change";
    }): Promise<{ ok: true; taskStatus: string }>;
  };
  asset?: {
    read(
      input: { ref: string },
      options?: { signal?: AbortSignal },
    ): Promise<
      | { kind: "ready"; mimeType: "image/png" | "image/jpeg" | "image/webp"; sizeBytes: number; bytes: Uint8Array }
      | { kind: "unavailable"; code: string }
    >;
  };
  media?: {
    getExportCapabilities(): Promise<{ workspace: boolean }>;
    importVideo(): Promise<
      | ({ kind: "ready"; mediaRef: string; label: string;
          /** Public Workspace lineage, never a local path or byte capability. */
          source?: { kind: "workspace-artifact"; artifactId: string; path: string };
        } & (
          | { mediaKind?: "video"; durationSec: number; frameRate: { numerator: number; denominator: number } }
          | { mediaKind: "audio"; durationSec: number; frameRate?: never }
          | { mediaKind: "image"; durationSec?: never; frameRate?: never }
        ))
      | { kind: "unavailable"; code: string }
    >;
    openPreview(
      input: { ref: string } | { mediaId: string } | { referenceId: string },
      options?: { signal?: AbortSignal },
    ): Promise<
      | { kind: "ready"; url: string; mimeType: "video/mp4" | "audio/mp4" | "audio/wav" | "audio/mpeg" | "image/png" | "image/jpeg" | "image/webp"; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } }
      | { kind: "unavailable"; code: string }
    >;
    closePreview(revokeToken: string): Promise<void>;
    exportVideo(input: { document: { sha256: string; revision: number | null }; publishToWorkspace?: boolean; exportSettings?: import("@nautilo/types").VideoExportSettings }, options?: { signal?: AbortSignal; onProgress?: (progress: { stage: "preparing" | "rendering" | "saving" | "publishing"; processedTimeUs?: number }) => void }): Promise<
      | { kind: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[]; workspace?: { status: "published" | "not_published" | "unknown"; path: string; artifactId?: string } }
      | { kind: "cancelled" }
      | { kind: "unavailable"; code: string }
    >;
    saveWorkspaceCopy(input: { sha256: string }, options?: { signal?: AbortSignal; onProgress?: (progress: { stage: string; completed?: number; total?: number }) => void }): Promise<
      | { kind: "succeeded"; path: string; roomLabel: string; mediaCount: number }
      | { kind: "cancelled" | "unknown" | "unavailable"; code?: string; retainedPaths: string[] }
    >;
    getWorkspaceCopyCapabilities(): Promise<{ available: boolean; roomLabel?: string }>;
    openWorkspaceCopy(): Promise<{ opened: boolean; code?: string }>;
  };
  /** Parent-mediated request only; no token, approval or spend authority. */
  videoGeneration?: {
    request(input: NautiloVideoGenerationRequest): Promise<NautiloVideoGenerationRequestResult>;
    listTakes(): Promise<NautiloVideoGenerationTakeListResult>;
    getTakeStatus(input: { takeId: string }): Promise<NautiloVideoGenerationTakeStatusResult>;
    /** Opens a parent-owned preview; the iframe never receives a media URL. */
    previewTake(input: { takeId: string }): Promise<NautiloVideoGenerationPreviewResult>;
    /** Re-checks readable artifact lineage and returns a host-measured duration. */
    revalidateTake(input: { takeId: string }): Promise<NautiloVideoGenerationRevalidationResult>;
    /** Parent-owned native picker and Workspace admission; no path or bytes cross the bridge. */
    importReferences(input: { mediaKind: "image" }): Promise<NautiloVideoGenerationReferencesImportResult>;
    importReference(input: { mediaKind: "image" | "video" | "audio" }): Promise<NautiloVideoGenerationReferenceImportResult>;
  };
  /** Exact first-party Video request; the host owns only its Genie-rail half. */
  hostLayout?: {
    setFullWidth(input: { enabled: boolean }): Promise<void>;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  acceptProposal?: boolean;
}

interface BridgeState {
  commandHandler?: (command: unknown, version: AppLiveSessionCapability["documentVersion"]) => unknown;
  pending: Map<string, PendingRequest>;
  documentChangeListeners: Set<(event: AppDocumentChangeEvent) => void>;
  queuedDocumentChanges: AppDocumentChangeEvent[];
  liveSessionListeners: Set<(capability: AppLiveSessionCapability) => void>;
  /** Last parent capability observed; proposals cannot precede it into Writer. */
  liveSession: AppLiveSessionCapability | null;
  queuedLiveSession: AppLiveSessionCapability | null;
  proposalListeners: Set<(proposal: AppLiveProposal) => void>;
  receivedProposalIds: Set<string>;
  queuedLiveProposals: Map<string, AppLiveProposal>;
  liveSessionClosedListeners: Set<(event: AppLiveSessionClosedEvent) => void>;
  preferenceListeners: Set<(key: AppPreferenceKey, value: unknown) => void>;
  prepareCloseHandler: ((request: AppPrepareCloseRequest) => AppPrepareCloseResult | Promise<AppPrepareCloseResult>) | null;
  prepareExportHandler: ((request: { actionId: string; mimeType: string }) => PreparedAppExport | Promise<PreparedAppExport>) | null;
}

interface ResponseEnvelope {
  type: "nautilo.app.res";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  status?: number;
  code?: string;
  message?: string;
}

interface DocumentChangedEnvelope {
  type: "nautilo.app.document.changed";
  event: AppDocumentChangeEvent;
}

interface LiveSessionEnvelope {
  type: "nautilo.app.live-session";
  capability: AppLiveSessionCapability;
}

interface LiveProposalEnvelope {
  type: "nautilo.app.live-proposal";
  proposal: AppLiveProposal;
}

interface LiveSessionClosedEnvelope {
  type: "nautilo.app.live-session.closed";
  sessionId: string;
  reason: AppLiveSessionClosedEvent["reason"];
}

interface AppPreferenceChangedEnvelope {
  type: "nautilo.app.preferences.changed";
  key: AppPreferenceKey;
  value: unknown;
}

interface AppPresentationThemeEnvelope {
  type: "nautilo.app.presentation.theme";
  theme: MiniAppTheme;
}

interface PrepareCloseEnvelope {
  type: "nautilo.app.lifecycle.prepare-close";
  requestId: string;
  reason: AppPrepareCloseRequest["reason"];
  action: AppPrepareCloseRequest["action"];
}

interface PrepareExportEnvelope {
  type: "nautilo.app.export.prepare";
  requestId: string;
  actionId: string;
  mimeType: string;
}

function escapeInlineScriptClosingTag(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/**
 * Self-contained installer used by both the module entry and the inline
 * srcDoc bootstrap script. Must not close over module-scope values.
 */
function bridgeClientInstaller(
  win: Window,
  bootstrap: MiniAppTheme | { initialTheme?: MiniAppTheme; assetReadRaster?: true; mediaProxy?: true; videoGeneration?: true; videoHostLayout?: true } | null = {},
  normalizeExportSettings: typeof normalizeVideoExportSettings,
  mode: "edit" | "preview" = "edit",
  recoveryEnabled = false,
  templatesEnabled = false,
): void {
  const STATE_KEY_MAX = 128;
  const PROPOSAL_DEDUPE_LIMIT = 256;
  const stateKey = "__nautiloAppBridgeState";
  const winRecord = win as Window & Record<string, unknown>;
  const initialTheme = typeof bootstrap === "string" ? bootstrap : bootstrap?.initialTheme;
  const grants = typeof bootstrap === "object" && bootstrap !== null ? bootstrap : {};
  // Keep the static iframe bootstrap free of host identifier vocabulary. The
  // key is still strictly validated only after a host response arrives.
  const publicArtifactIdKey = ["artifact", "Id"].join("");
  const mediaPreviewUrls = new Map<string, string>();
  win.addEventListener("pagehide", () => {
    for (const url of mediaPreviewUrls.values()) URL.revokeObjectURL(url);
    mediaPreviewUrls.clear();
  }, { once: true });

  function isRasterMimeType(value: unknown): value is "image/png" | "image/jpeg" | "image/webp" {
    return value === "image/png" || value === "image/jpeg" || value === "image/webp";
  }

  function isPrepareCloseEnvelope(x: unknown): x is PrepareCloseEnvelope {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return o["type"] === "nautilo.app.lifecycle.prepare-close" &&
      typeof o["requestId"] === "string" && o["requestId"].length > 0 &&
      (o["reason"] === "close" || o["reason"] === "replace" ||
        o["reason"] === "navigate" || o["reason"] === "suspend" || o["reason"] === "quit") &&
      (o["action"] === "prepare-close" || o["action"] === "save-copy") &&
      Object.keys(o).every((key) =>
        key === "type" || key === "requestId" || key === "reason" || key === "action");
  }

  function isPrepareExportEnvelope(x: unknown): x is PrepareExportEnvelope {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return o["type"] === "nautilo.app.export.prepare" &&
      typeof o["requestId"] === "string" && o["requestId"].length > 0 &&
      typeof o["actionId"] === "string" && o["actionId"].length > 0 &&
      typeof o["mimeType"] === "string" && o["mimeType"].length > 0 &&
      Object.keys(o).every((key) =>
        key === "type" || key === "requestId" || key === "actionId" || key === "mimeType");
  }

  function isResponseEnvelope(x: unknown): x is ResponseEnvelope {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return (
      o["type"] === "nautilo.app.res" &&
      typeof o["requestId"] === "string" &&
      typeof o["ok"] === "boolean"
    );
  }

  function isAnchoredTextPatch(x: unknown): boolean {
    if (!x || typeof x !== "object") return false;
    const p = x as Record<string, unknown>;
    return (
      p["kind"] === "anchored_text" &&
      typeof p["oldString"] === "string" &&
      typeof p["newString"] === "string"
    );
  }

  function isPatchAppliedDocumentEvent(e: Record<string, unknown>): boolean {
    if (e["type"] !== "patch_applied") return false;
    if (e["path"] !== undefined && typeof e["path"] !== "string") return false;
    if (typeof e["patchId"] !== "string") return false;
    if (!("revision" in e) || (e["revision"] !== null && typeof e["revision"] !== "number")) {
      return false;
    }
    if (typeof e["sha256"] !== "string") return false;
    if (
      !("previousRevision" in e) ||
      (e["previousRevision"] !== null && typeof e["previousRevision"] !== "number")
    ) {
      return false;
    }
    if (typeof e["previousSha256"] !== "string") return false;
    if (!isAnchoredTextPatch(e["patch"])) return false;
    const envelope = e["envelope"];
    if (!envelope || typeof envelope !== "object") return false;
    const env = envelope as Record<string, unknown>;
    if (typeof env["content"] !== "string") return false;
    if (typeof env["mimeType"] !== "string") return false;
    if (typeof env["path"] !== "string") return false;
    if (typeof env["baseSha256"] !== "string") return false;
    if (
      !("baseRevision" in env) ||
      (env["baseRevision"] !== null && typeof env["baseRevision"] !== "number")
    ) {
      return false;
    }
    if (e["author"] !== undefined) {
      const author = e["author"];
      if (!author || typeof author !== "object") return false;
      const a = author as Record<string, unknown>;
      if (a["kind"] !== "human" && a["kind"] !== "agent" && a["kind"] !== "app_tool") return false;
      if (typeof a["displayName"] !== "string") return false;
    }
    if (e["rebased"] !== undefined && typeof e["rebased"] !== "boolean") return false;
    return true;
  }

  function isDocumentChangedEnvelope(x: unknown): x is DocumentChangedEnvelope {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    if (o["type"] !== "nautilo.app.document.changed") return false;
    const event = o["event"];
    if (!event || typeof event !== "object") return false;
    const e = event as Record<string, unknown>;
    if (isPatchAppliedDocumentEvent(e)) return true;
    if (e["type"] !== "changed" && e["type"] !== "renamed" && e["type"] !== "deleted" && e["type"] !== "reconnected") return false;
    if (e["path"] !== undefined && typeof e["path"] !== "string") return false;
    if (e["reloadRequired"] !== undefined && typeof e["reloadRequired"] !== "boolean") return false;
    return true;
  }

  function isAppPreferenceChangedEnvelope(x: unknown): x is AppPreferenceChangedEnvelope {
    if (!x || typeof x !== "object") return false;
    const value = x as Record<string, unknown>;
    return value["type"] === "nautilo.app.preferences.changed" &&
      (value["key"] === "writer.spellcheck" ||
        value["key"] === "design.agentReceipts" ||
        value["key"] === "video.agentReceipts" || value["key"] === "video.firstSourceRate");
  }

  function isMiniAppTheme(value: unknown): value is MiniAppTheme {
    return value === "light" || value === "dark";
  }

  function isAppPresentationThemeEnvelope(x: unknown): x is AppPresentationThemeEnvelope {
    if (!x || typeof x !== "object") return false;
    const value = x as Record<string, unknown>;
    return value["type"] === "nautilo.app.presentation.theme" && isMiniAppTheme(value["theme"]);
  }

  function applyTheme(theme: MiniAppTheme): void {
    const root = win.document?.documentElement;
    if (!root) return;
    root.dataset["theme"] = theme;
    root.style.colorScheme = theme;
  }

  // The bootstrap runs before the app's own bundle. It prevents a blank or
  // stale system-mode frame while the parent waits for the iframe load event.
  if (isMiniAppTheme(initialTheme)) applyTheme(initialTheme);

  function isLiveDocumentVersion(value: unknown): value is AppLiveSessionCapability["documentVersion"] {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    if (v["kind"] === "artifact_revision") {
      return Number.isSafeInteger(v["revision"]) && (v["revision"] as number) >= 0;
    }
    if (v["kind"] === "local_sha") {
      return typeof v["sha256"] === "string" && /^[0-9a-f]{64}$/.test(v["sha256"]);
    }
    return false;
  }

  const ACCEPT_PROPOSAL_SAFE_ERROR_CODES = [
    "acceptance_conflict",
    "proposal_closed",
    "stale_version",
    "session_closed",
    "relay_unavailable",
    "local_target_forbidden",
    "invalid_request",
    "payload_too_large",
  ] as const;
  const ACCEPT_PROPOSAL_SAFE_ERROR_CODE_SET = new Set<string>(ACCEPT_PROPOSAL_SAFE_ERROR_CODES);

  function isAcceptProposalSafeErrorCode(code: unknown): code is (typeof ACCEPT_PROPOSAL_SAFE_ERROR_CODES)[number] {
    return typeof code === "string" && ACCEPT_PROPOSAL_SAFE_ERROR_CODE_SET.has(code);
  }

  function acceptProposalFailClosed(): NautiloAcceptProposalResult {
    return { ok: false, code: "invalid_request", message: "invalid_request" };
  }

  function acceptProposalFailureFromBridge(data: ResponseEnvelope): NautiloAcceptProposalResult {
    if (isAcceptProposalSafeErrorCode(data.code)) {
      const message =
        typeof data.message === "string" && data.message.length > 0 ? data.message : data.code;
      return { ok: false, code: data.code, message };
    }
    return acceptProposalFailClosed();
  }

  function normalizeAcceptProposalResult(value: unknown): NautiloAcceptProposalResult {
    if (!value || typeof value !== "object") return acceptProposalFailClosed();
    const record = value as Record<string, unknown>;
    if (record["ok"] === false) {
      const code = record["code"];
      if (isAcceptProposalSafeErrorCode(code)) {
        const message =
          typeof record["message"] === "string" && record["message"].length > 0
            ? record["message"]
            : code;
        return { ok: false, code, message };
      }
      return acceptProposalFailClosed();
    }
    const documentVersion = record["documentVersion"];
    const contentSha256 = record["contentSha256"];
    const localRevisionRef = record["localRevisionRef"];
    if (record["ok"] === true) {
      if (
        !isLiveDocumentVersion(documentVersion) ||
        typeof contentSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(contentSha256)
      ) return acceptProposalFailClosed();
      return {
        ok: true,
        documentVersion,
        contentSha256,
        ...(typeof localRevisionRef === "string" ? { localRevisionRef } : {}),
      };
    }
    if (
      isLiveDocumentVersion(documentVersion) &&
      typeof contentSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(contentSha256)
    ) {
      return {
        ok: true,
        documentVersion,
        contentSha256,
        ...(typeof localRevisionRef === "string" ? { localRevisionRef } : {}),
      };
    }
    return acceptProposalFailClosed();
  }

  function isLiveSessionEnvelope(x: unknown): x is LiveSessionEnvelope {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    const capability = o["capability"];
    if (!capability || typeof capability !== "object") return false;
    const cap = capability as Record<string, unknown>;
    return (
      o["type"] === "nautilo.app.live-session" &&
      typeof cap["sessionToken"] === "string" &&
      typeof cap["sessionId"] === "string" &&
      cap["sessionId"].length > 0 &&
      isLiveDocumentVersion(cap["documentVersion"])
    );
  }

  function isLiveProposalEnvelope(x: unknown): x is LiveProposalEnvelope {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    const proposal = o["proposal"];
    if (!proposal || typeof proposal !== "object" || o["type"] !== "nautilo.app.live-proposal") {
      return false;
    }
    const p = proposal as Record<string, unknown>;
    return (
      typeof p["proposalId"] === "string" &&
      p["proposalId"].length > 0 &&
      typeof p["appId"] === "string" &&
      p["appId"].length > 0 &&
      typeof p["sessionId"] === "string" &&
      p["sessionId"].length > 0 &&
      isLiveDocumentVersion(p["documentVersion"]) &&
      Array.isArray(p["operations"])
    );
  }

  function isLiveSessionClosedEnvelope(x: unknown): x is LiveSessionClosedEnvelope {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return (
      o["type"] === "nautilo.app.live-session.closed" &&
      typeof o["sessionId"] === "string" &&
      o["sessionId"].length > 0 &&
      (o["reason"] === "relay_disconnected" || o["reason"] === "session_closed")
    );
  }

  function rememberProposalId(ids: Set<string>, proposalId: string): boolean {
    if (ids.has(proposalId)) return false;
    ids.add(proposalId);
    if (ids.size > PROPOSAL_DEDUPE_LIMIT) {
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
    }
    return true;
  }

  function assertStateKey(key: string, op: "get" | "set"): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`nautiloApp.state.${op}: key must be a non-empty string`);
    }
    if (key.length > STATE_KEY_MAX) {
      throw new Error(
        `nautiloApp.state.${op}: key must be at most ${STATE_KEY_MAX} characters`,
      );
    }
    if (key.includes(":")) {
      throw new Error(`nautiloApp.state.${op}: key must not contain ':'`);
    }
  }

  let bridgeState = winRecord[stateKey] as BridgeState | undefined;
  let flushQueuedLiveProposals: () => void = () => {};
  if (!bridgeState) {
    bridgeState = {
      pending: new Map<string, PendingRequest>(),
      documentChangeListeners: new Set(),
      queuedDocumentChanges: [],
      liveSessionListeners: new Set(),
      liveSession: null,
      queuedLiveSession: null,
      proposalListeners: new Set(),
      receivedProposalIds: new Set(),
      queuedLiveProposals: new Map(),
      liveSessionClosedListeners: new Set(),
      preferenceListeners: new Set(),
      prepareCloseHandler: null,
      prepareExportHandler: null,
    };
    winRecord[stateKey] = bridgeState;

    win.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== win.parent) return;
      const data: unknown = event.data;
      if (isPrepareExportEnvelope(data)) {
        const handler = bridgeState!.prepareExportHandler;
        if (!handler) {
          win.parent.postMessage({
            type: "nautilo.app.export.prepare.result",
            requestId: data.requestId,
            ok: false,
            error: "The app has no export handler registered.",
          }, "*");
          return;
        }
        void Promise.resolve()
          .then(() => handler({ actionId: data.actionId, mimeType: data.mimeType }))
          .then((result) => win.parent.postMessage({
            type: "nautilo.app.export.prepare.result", requestId: data.requestId, ok: true, result,
          }, "*"))
          .catch((error: unknown) => win.parent.postMessage({
            type: "nautilo.app.export.prepare.result", requestId: data.requestId, ok: false,
            error: error instanceof Error ? error.message : String(error),
          }, "*"));
        return;
      }
      if (isPrepareCloseEnvelope(data)) {
        const handler = bridgeState!.prepareCloseHandler;
        if (!handler) return;
        void Promise.resolve()
          .then(() => handler({ reason: data.reason, action: data.action }))
          .then((result) => {
            win.parent.postMessage({
              type: "nautilo.app.lifecycle.prepare-close.result",
              requestId: data.requestId,
              ok: true,
              result,
            }, "*");
          })
          .catch((error: unknown) => {
            win.parent.postMessage({
              type: "nautilo.app.lifecycle.prepare-close.result",
              requestId: data.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }, "*");
          });
        return;
      }
      if (data && typeof data === "object" && (data as Record<string, unknown>).type === "nautilo.app.live-command") {
        const request = data as { sessionId?: unknown; documentVersion?: unknown; deadline?: unknown; command?: unknown };
        const port = event.ports?.[0];
        if (!port) return;
        const capability = bridgeState!.liveSession;
        const version = request.documentVersion as AppLiveSessionCapability["documentVersion"] | undefined;
        const matches = capability && version && capability.documentVersion.kind === version.kind &&
          (version.kind === "artifact_revision" ? (capability.documentVersion as { revision: number }).revision === version.revision : (capability.documentVersion as { sha256: string }).sha256 === version.sha256);
        try {
          const result = matches && request.sessionId === capability.sessionId && typeof request.deadline === "number" &&
            Number.isFinite(request.deadline) && request.deadline > Date.now() && bridgeState!.commandHandler
            ? bridgeState!.commandHandler(request.command, version)
            : { status: "rejected", code: "session_closed", stateChanged: false, retrySafe: false };
          port.postMessage(result);
        } catch {
          port.postMessage({ status: "unknown", stateChanged: "unknown", retrySafe: false });
        } finally {
          port.close();
        }
        return;
      }
      if (isAppPresentationThemeEnvelope(data)) {
        applyTheme(data.theme);
        return;
      }
      if (isLiveSessionEnvelope(data)) {
        bridgeState!.liveSession = data.capability;
        if (bridgeState!.liveSessionListeners.size === 0) {
          bridgeState!.queuedLiveSession = data.capability;
        } else {
          for (const listener of bridgeState!.liveSessionListeners) listener(data.capability);
          flushQueuedLiveProposals();
        }
        return;
      }
      if (isLiveSessionClosedEnvelope(data)) {
        if (bridgeState!.liveSession?.sessionId === data.sessionId) {
          bridgeState!.liveSession = null;
        }
        const event = { sessionId: data.sessionId, reason: data.reason };
        for (const listener of bridgeState!.liveSessionClosedListeners) listener(event);
        return;
      }
      if (isLiveProposalEnvelope(data)) {
        const proposal = data.proposal;
        if (!rememberProposalId(bridgeState!.receivedProposalIds, proposal.proposalId)) return;
        if (
          // Writer registers its capability handler before its proposal
          // handler. Once that ordering is in play, never let a review reach
          // it before a capability; retain it in the existing proposal queue.
          (!bridgeState!.liveSession && bridgeState!.liveSessionListeners.size > 0) ||
          bridgeState!.queuedLiveSession !== null ||
          bridgeState!.proposalListeners.size === 0
        ) {
          bridgeState!.queuedLiveProposals.set(proposal.proposalId, proposal);
        } else {
          for (const listener of bridgeState!.proposalListeners) listener(proposal);
        }
        return;
      }
      if (isDocumentChangedEnvelope(data)) {
        if (bridgeState!.documentChangeListeners.size === 0) {
          bridgeState!.queuedDocumentChanges.push(data.event);
        } else {
          for (const listener of bridgeState!.documentChangeListeners) {
            listener(data.event);
          }
        }
        return;
      }
      if (isAppPreferenceChangedEnvelope(data)) {
        for (const listener of bridgeState!.preferenceListeners) listener(data.key, data.value);
        return;
      }
      if (!isResponseEnvelope(data)) return;
      const req = bridgeState!.pending.get(data.requestId);
      if (!req) return;
      bridgeState!.pending.delete(data.requestId);
      if (req.acceptProposal) {
        if (data.ok) {
          req.resolve(normalizeAcceptProposalResult(data.value));
        } else {
          req.resolve(acceptProposalFailureFromBridge(data));
        }
        return;
      }
      if (data.ok) {
        req.resolve(data.value);
      } else {
        const errMsg =
          typeof data.error === "string" ? data.error : "nautiloApp error (no message)";
        const e = new Error(
          typeof data.status === "number" ? `[${data.status}] ${errMsg}` : errMsg,
        );
        req.reject(e);
      }
    });
  }
  const state = bridgeState;
  flushQueuedLiveProposals = (): void => {
    // Writer must observe the capability callback before any matching review.
    if (
      !state.liveSession ||
      state.queuedLiveSession !== null ||
      state.proposalListeners.size === 0
    ) return;
    const queued = [...state.queuedLiveProposals.values()];
    state.queuedLiveProposals.clear();
    for (const proposal of queued) {
      for (const listener of state.proposalListeners) listener(proposal);
    }
  };

  function newRequestId(): string {
    const cryptoObj = win.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID();
    }
    return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function postRequest(
    msg: Record<string, unknown>,
    requestIdOverride?: string,
    acceptProposal = false,
  ): Promise<unknown> {
    const requestId =
      typeof requestIdOverride === "string" && requestIdOverride.length > 0
        ? requestIdOverride
        : newRequestId();
    return new Promise<unknown>((resolve, reject) => {
      bridgeState!.pending.set(requestId, { resolve, reject, acceptProposal });
      win.parent.postMessage({ ...msg, requestId }, "*");
    });
  }

  const documentApi = Object.freeze({
    authoredChange(): Promise<unknown> {
      return postRequest({ type: "nautilo.app.document.req", op: "authoredChange" });
    },
    read(opts?: { fresh?: boolean }): Promise<unknown> {
      return postRequest({ type: "nautilo.app.document.req", op: "read", ...(opts?.fresh ? { fresh: true } : {}) });
    },
    stat(): Promise<unknown> {
      return postRequest({ type: "nautilo.app.document.req", op: "stat" });
    },
    write(
      next: string | { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null; conflictPolicy?: "strict" },
    ): Promise<unknown> {
      const msg: Record<string, unknown> = {
        type: "nautilo.app.document.req",
        op: "write",
        value: next,
      };
      if (opts && "baseSha256" in opts) {
        msg["baseSha256"] = opts.baseSha256;
      }
      if (opts && "baseRevision" in opts) {
        msg["baseRevision"] = opts.baseRevision;
      }
      if (opts?.conflictPolicy) msg["conflictPolicy"] = opts.conflictPolicy;
      return postRequest(msg);
    },
    saveCopy(next: string | { content: string }): Promise<{ path: string }> {
      return postRequest({
        type: "nautilo.app.document.req",
        op: "saveCopy",
        value: next,
      }) as Promise<{ path: string }>;
    },
    async downloadCopy(content: string): Promise<void> {
      await postRequest({ type: "nautilo.app.document.req", op: "downloadCopy", value: content });
    },
    onChange(handler: (event: AppDocumentChangeEvent) => void): () => void {
      state.documentChangeListeners.add(handler);
      if (state.queuedDocumentChanges.length > 0) {
        const queued = state.queuedDocumentChanges.splice(0);
        queueMicrotask(() => {
          if (!state.documentChangeListeners.has(handler)) return;
          for (const event of queued) {
            handler(event);
          }
        });
      }
      return () => {
        state.documentChangeListeners.delete(handler);
      };
    },
  });

  const stateApi = Object.freeze({
    async get<T = unknown>(key: string): Promise<T | undefined> {
      assertStateKey(key, "get");
      return (await postRequest({
        type: "nautilo.app.state.req",
        op: "get",
        key,
      })) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      assertStateKey(key, "set");
      await postRequest({
        type: "nautilo.app.state.req",
        op: "set",
        key,
        value,
      });
    },
  });

  const recoveryApi = Object.freeze({
    read(): Promise<AppRecoveryRead> {
      return postRequest({ type: "nautilo.app.recovery.req", op: "read" }) as Promise<AppRecoveryRead>;
    },
    write(input: AppRecoveryWrite): Promise<{ revision: string | null }> {
      return postRequest({ type: "nautilo.app.recovery.req", op: "write", input }) as Promise<{ revision: string | null }>;
    },
  });

  const templatesApi = Object.freeze({
    list(): Promise<Array<{ id: string; name: string }>> {
      return postRequest({ type: "nautilo.app.templates.req", op: "list" }) as Promise<Array<{ id: string; name: string }>>;
    },
    read(id: string): Promise<{ content: string }> {
      return postRequest({ type: "nautilo.app.templates.req", op: "read", templateId: id }) as Promise<{ content: string }>;
    },
    save(input: { name: string; content: string }): Promise<{ id: string; name: string }> {
      return postRequest({ type: "nautilo.app.templates.req", op: "save", name: input.name, content: input.content }) as Promise<{ id: string; name: string }>;
    },
    async remove(id: string): Promise<void> {
      await postRequest({ type: "nautilo.app.templates.req", op: "remove", templateId: id });
    },
  });

  const preferencesApi = Object.freeze({
    get<T = unknown>(key: AppPreferenceKey): Promise<T> {
      return postRequest({ type: "nautilo.app.preferences.req", op: "get", key }) as Promise<T>;
    },
    set<T = unknown>(key: AppPreferenceKey, value: T): Promise<T> {
      return postRequest({ type: "nautilo.app.preferences.req", op: "set", key, value }) as Promise<T>;
    },
    subscribe<T = unknown>(key: AppPreferenceKey, handler: (value: T) => void): () => void {
      const listener = (changedKey: AppPreferenceKey, value: unknown) => {
        if (changedKey === key) handler(value as T);
      };
      state.preferenceListeners.add(listener);
      win.parent.postMessage({ type: "nautilo.app.preferences.subscribe", key }, "*");
      return () => state.preferenceListeners.delete(listener);
    },
  });

  const contextApi = Object.freeze({
    mode,
    set(summary: AppContextSummary): void {
      win.parent.postMessage({ type: "nautilo.app.context.update", summary }, "*");
    },
  });

  const humanEditApi = Object.freeze({
    set(update: AppHumanEditUpdate): void {
      win.parent.postMessage({ type: "nautilo.app.human-edit.update", update }, "*");
    },
  });

  const lifecycleApi = Object.freeze({
    onPrepareClose(
      handler: (request: AppPrepareCloseRequest) => AppPrepareCloseResult | Promise<AppPrepareCloseResult>,
    ): () => void {
      if (typeof handler !== "function") {
        throw new Error("nautiloApp.lifecycle.onPrepareClose: handler must be a function");
      }
      state.prepareCloseHandler = handler;
      win.parent.postMessage({ type: "nautilo.app.lifecycle.register" }, "*");
      return () => {
        if (state.prepareCloseHandler !== handler) return;
        state.prepareCloseHandler = null;
        win.parent.postMessage({ type: "nautilo.app.lifecycle.unregister" }, "*");
      };
    },
  });

  const exportsApi = Object.freeze({
    onPrepare(
      handler: (request: { actionId: string; mimeType: string }) => PreparedAppExport | Promise<PreparedAppExport>,
    ): () => void {
      if (typeof handler !== "function") {
        throw new Error("nautiloApp.exports.onPrepare: handler must be a function");
      }
      state.prepareExportHandler = handler;
      return () => {
        if (state.prepareExportHandler === handler) state.prepareExportHandler = null;
      };
    },
  });

  const sessionApi = Object.freeze({
    onChange(handler: (capability: AppLiveSessionCapability) => void): () => void {
      state.liveSessionListeners.add(handler);
      const queued = state.queuedLiveSession;
      if (queued) {
        state.queuedLiveSession = null;
        queueMicrotask(() => {
          if (!state.liveSessionListeners.has(handler)) return;
          handler(queued);
          flushQueuedLiveProposals();
        });
      }
      return () => state.liveSessionListeners.delete(handler);
    },
    onProposal(handler: (proposal: AppLiveProposal) => void): () => void {
      state.proposalListeners.add(handler);
      queueMicrotask(() => {
        if (!state.proposalListeners.has(handler)) return;
        flushQueuedLiveProposals();
      });
      return () => state.proposalListeners.delete(handler);
    },
    acknowledgeProposal(input: {
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
    }): void {
      win.parent.postMessage({
        type: "nautilo.app.live-proposal.ack",
        proposalId: input.proposalId,
        documentVersion: input.documentVersion,
      }, "*");
    },
    onCommand(handler: (command: unknown, version: AppLiveSessionCapability["documentVersion"]) => unknown): () => void {
      state.commandHandler = handler;
      return () => { if (state.commandHandler === handler) delete state.commandHandler; };
    },
    onClosed(handler: (event: AppLiveSessionClosedEvent) => void): () => void {
      state.liveSessionClosedListeners.add(handler);
      return () => state.liveSessionClosedListeners.delete(handler);
    },
    acceptProposal(input: {
      requestId: string;
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
      acceptedOperationIndexes: number[];
      acceptedContent: string;
    }): Promise<NautiloAcceptProposalResult> {
      return postRequest(
        {
          type: "nautilo.app.session.req",
          op: "acceptProposal",
          proposalId: input.proposalId,
          documentVersion: input.documentVersion,
          acceptedOperationIndexes: input.acceptedOperationIndexes,
          acceptedContent: input.acceptedContent,
        },
        input.requestId,
        true,
      ) as Promise<NautiloAcceptProposalResult>;
    },
    resolveProposal(input: {
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
      outcome: "accepted" | "rejected";
    }): Promise<{ ok: true; taskStatus: string }> {
      return postRequest({
        type: "nautilo.app.session.req",
        op: "resolveProposal",
        proposalId: input.proposalId,
        documentVersion: input.documentVersion,
        outcome: input.outcome,
      }) as Promise<{ ok: true; taskStatus: string }>;
    },
    invalidateProposal(input: {
      proposalSessionToken: string;
      proposalId: string;
      documentVersion: AppLiveSessionCapability["documentVersion"];
      reason: "human_changed" | "stale_version" | "remote_changed" | "session_closed" | "no_effective_change";
    }): Promise<{ ok: true; taskStatus: string }> {
      return postRequest({
        type: "nautilo.app.session.req",
        op: "invalidateProposal",
        proposalSessionToken: input.proposalSessionToken,
        proposalId: input.proposalId,
        documentVersion: input.documentVersion,
        reason: input.reason,
      }) as Promise<{ ok: true; taskStatus: string }>;
    },
  });

  const assetApi = grants.assetReadRaster === true
    ? Object.freeze({
        async read(input: { ref: string }, options?: { signal?: AbortSignal }) {
          if (!input || typeof input.ref !== "string") throw new Error("nautiloApp.asset.read: ref is required");
          const requestId = newRequestId();
          const signal = options?.signal;
          if (signal?.aborted) return { kind: "unavailable" as const, code: "cancelled" };
          let onAbort: (() => void) | undefined;
          const response = postRequest(
            { type: "nautilo.app.asset.req", op: "read", ref: input.ref },
            requestId,
          );
          const cancelled = new Promise<{ kind: "unavailable"; code: "cancelled" }>((resolve) => {
            if (!signal) return;
            onAbort = () => {
              state.pending.delete(requestId);
              win.parent.postMessage({ type: "nautilo.app.asset.cancel", requestId }, "*");
              resolve({ kind: "unavailable", code: "cancelled" });
            };
            signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            const value = await (signal ? Promise.race([response, cancelled]) : response);
            if (!value || typeof value !== "object") return { kind: "unavailable" as const, code: "invalid_response" };
            const record = value as Record<string, unknown>;
            if (record["kind"] === "ready") {
              const mimeType = record["mimeType"];
              const bytes = record["bytes"];
              const sizeBytes = record["sizeBytes"];
              if (
                isRasterMimeType(mimeType) &&
                bytes instanceof Uint8Array &&
                Number.isSafeInteger(sizeBytes) &&
                sizeBytes === bytes.byteLength
              ) return {
                kind: "ready" as const,
                mimeType,
                sizeBytes,
                bytes,
              };
            }
            return {
              kind: "unavailable" as const,
              code: typeof record["code"] === "string" ? record["code"] : "invalid_response",
            };
          } finally {
            if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          }
        },
      })
    : undefined;

  // Video Workspace projects use the same deliberately small preview API as
  // Current Folder. The selector is an opaque project-local media id; the
  // parent rereads and resolves durable lineage. A generation grant is enough
  // to expose that selector, but never the Desktop import action.
  const mediaApi = grants.mediaProxy === true || grants.videoGeneration === true
    ? Object.freeze({
        async getExportCapabilities(): Promise<{ workspace: boolean }> {
          const value = await postRequest({ type: "nautilo.app.media.req", op: "exportCapabilities" });
          if (!value || typeof value !== "object" || Array.isArray(value)) return { workspace: false };
          const record = value as Record<string, unknown>;
          return { workspace: Object.keys(record).every((key) => key === "workspace") && record["workspace"] === true };
        },
        async importVideo() {
          if (grants.mediaProxy !== true) return { kind: "unavailable" as const, code: "unsupported_environment" };
          const requestId = newRequestId();
          const value = await postRequest({ type: "nautilo.app.media.req", op: "importVideo" }, requestId);
          if (!value || typeof value !== "object") return { kind: "unavailable" as const, code: "invalid_response" };
          const record = value as Record<string, unknown>;
          const mediaKind = record["mediaKind"] ?? "video";
          const frameRate = record["frameRate"];
          const source = record["source"];
          const sourceRecord = source && typeof source === "object" && !Array.isArray(source)
            ? source as Record<string, unknown>
            : null;
          const sourceArtifactId = sourceRecord?.[publicArtifactIdKey];
          const sourcePath = sourceRecord?.["path"];
          const workspaceSource = sourceRecord !== null &&
            Object.keys(sourceRecord).every((key) => key === "kind" || key === publicArtifactIdKey || key === "path") &&
            sourceRecord["kind"] === "workspace-artifact" && typeof sourceArtifactId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sourceArtifactId) &&
            typeof sourcePath === "string" && sourcePath === record["mediaRef"] && sourcePath.length > 0 &&
            !sourcePath.startsWith("/") && !sourcePath.includes("\\") && !/(?:https?:|data:|blob:|file:)/iu.test(sourcePath) &&
            !sourcePath.split("/").some((part: string) => !part || part === "." || part === "..");
          // Keep the runtime bundle free of a static host-identifier key. The
          // narrowing cast is safe: `workspaceSource` validates every member,
          // including the dynamically constructed public artifact id key.
          const parsedWorkspaceSource = workspaceSource
            ? ({ kind: "workspace-artifact" as const, [publicArtifactIdKey]: sourceArtifactId, path: sourcePath } as { kind: "workspace-artifact"; artifactId: string; path: string })
            : undefined;
          const mediaRef = record["mediaRef"];
          const label = record["label"];
          const safeRef = typeof mediaRef === "string" && mediaRef.length > 0 &&
            !mediaRef.startsWith("/") && !mediaRef.includes("\\") && !/(?:https?:|data:|blob:|file:)/iu.test(mediaRef) &&
            !mediaRef.split("/").some((part) => !part || part === "." || part === "..");
          const safeLabel = typeof label === "string" && label.length > 0 && new TextEncoder().encode(label).byteLength <= 256 &&
            !/[\r\n\0]/u.test(label) && !/(?:https?:|data:|blob:|file:)/iu.test(label);
          const duration = record["durationSec"];
          const durationValid = typeof duration === "number" && Number.isFinite(duration) && duration > 0;
          const frame = frameRate && typeof frameRate === "object" && !Array.isArray(frameRate) ? frameRate as Record<string, unknown> : null;
          const frameValid = frame !== null && Object.keys(frame).every((key) => key === "numerator" || key === "denominator") &&
            Number.isSafeInteger(frame["numerator"]) && Number(frame["numerator"]) > 0 &&
            Number.isSafeInteger(frame["denominator"]) && Number(frame["denominator"]) > 0;
          const closed = Object.keys(record).every((key) => ["kind", "mediaKind", "mediaRef", "label", "durationSec", "frameRate", "source"].includes(key));
          const metadataValid = mediaKind === "video" ? durationValid && frameValid :
            mediaKind === "audio" ? durationValid && frameRate === undefined :
              mediaKind === "image" ? duration === undefined && frameRate === undefined : false;
          if (record["kind"] === "ready" && closed && safeRef && safeLabel && metadataValid && (source === undefined || parsedWorkspaceSource)) {
            const common = { kind: "ready" as const, mediaRef, label, ...(parsedWorkspaceSource ? { source: parsedWorkspaceSource } : {}) };
            if (mediaKind === "video") return { ...common, ...(record["mediaKind"] === "video" ? { mediaKind: "video" as const } : {}), durationSec: duration as number,
              frameRate: { numerator: frame!["numerator"] as number, denominator: frame!["denominator"] as number } };
            if (mediaKind === "audio") return { ...common, mediaKind: "audio" as const, durationSec: duration as number };
            return { ...common, mediaKind: "image" as const };
          }
          return { kind: "unavailable" as const, code: typeof record["code"] === "string" ? record["code"] : "invalid_response" };
        },
        async openPreview(input: { ref: string } | { mediaId: string } | { referenceId: string }, options?: { signal?: AbortSignal }) {
          const hasRef = Boolean(input) && typeof (input as { ref?: unknown }).ref === "string";
          const hasMediaId = Boolean(input) && typeof (input as { mediaId?: unknown }).mediaId === "string";
          const hasReferenceId = Boolean(input) && typeof (input as { referenceId?: unknown }).referenceId === "string";
          if (Number(hasRef) + Number(hasMediaId) + Number(hasReferenceId) !== 1) {
            throw new Error("nautiloApp.media.openPreview: exactly one of ref, mediaId or referenceId is required");
          }
          if (hasMediaId && !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test((input as { mediaId: string }).mediaId)) {
            return { kind: "unavailable" as const, code: "invalid_media" };
          }
          if (hasReferenceId && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test((input as { referenceId: string }).referenceId)) return { kind: "unavailable" as const, code: "invalid_media" };
          const requestId = newRequestId();
          const signal = options?.signal;
          if (signal?.aborted) return { kind: "unavailable" as const, code: "cancelled" };
          let onAbort: (() => void) | undefined;
          const response = postRequest(
            {
              type: "nautilo.app.media.req",
              op: "openPreview",
              ...(hasRef ? { ref: (input as { ref: string }).ref } : hasMediaId ? { mediaId: (input as { mediaId: string }).mediaId } : { referenceId: (input as { referenceId: string }).referenceId }),
            },
            requestId,
          );
          const cancelled = new Promise<{ kind: "unavailable"; code: "cancelled" }>((resolve) => {
            if (!signal) return;
            onAbort = () => {
              state.pending.delete(requestId);
              win.parent.postMessage({ type: "nautilo.app.media.cancel", requestId }, "*");
              resolve({ kind: "unavailable", code: "cancelled" });
            };
            signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            const value = await (signal ? Promise.race([response, cancelled]) : response);
            if (!value || typeof value !== "object") return { kind: "unavailable" as const, code: "invalid_response" };
            const record = value as Record<string, unknown>;
            const mimeType = record["mimeType"];
            const waveform = record["waveform"] as { peaks?: unknown; samplesPerSecond?: unknown } | undefined;
            const validWaveform = waveform === undefined || (waveform !== null && typeof waveform === "object" &&
              Object.keys(waveform).every((key) => key === "peaks" || key === "samplesPerSecond") &&
              typeof waveform.samplesPerSecond === "number" && Number.isFinite(waveform.samplesPerSecond) && waveform.samplesPerSecond > 0 &&
              Array.isArray(waveform.peaks) && waveform.peaks.every((peak) => typeof peak === "number" && Number.isFinite(peak) && peak >= 0 && peak <= 1));
            if (
              record["kind"] === "ready" &&
              Object.keys(record).every((key) => ["kind", "url", "blob", "mimeType", "sizeBytes", "revokeToken", "waveform"].includes(key)) && validWaveform &&
              typeof record["url"] === "string" &&
              typeof mimeType === "string" && ["video/mp4", "audio/mp4", "audio/wav", "audio/mpeg", "image/png", "image/jpeg", "image/webp"].includes(mimeType) &&
              Number.isSafeInteger(record["sizeBytes"]) && Number(record["sizeBytes"]) > 0 &&
              typeof record["revokeToken"] === "string" && record["revokeToken"].length > 0 &&
              (record["blob"] === undefined || (record["blob"] instanceof Blob && record["blob"].size === record["sizeBytes"] && record["blob"].type === mimeType))
            ) {
              let url = record["url"];
              if (record["blob"] instanceof Blob) {
                url = URL.createObjectURL(record["blob"]);
                const previous = mediaPreviewUrls.get(record["revokeToken"]);
                if (previous) URL.revokeObjectURL(previous);
                mediaPreviewUrls.set(record["revokeToken"], url);
              }
              return {
              kind: "ready" as const,
              url,
              mimeType: mimeType as "video/mp4" | "audio/mp4" | "audio/wav" | "audio/mpeg" | "image/png" | "image/jpeg" | "image/webp",
              sizeBytes: record["sizeBytes"] as number,
              revokeToken: record["revokeToken"],
              ...(waveform ? { waveform: waveform as { peaks: number[]; samplesPerSecond: number } } : {}),
              };
            }
            return { kind: "unavailable" as const, code: typeof record["code"] === "string" ? record["code"] : "invalid_response" };
          } finally {
            if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          }
        },
        async closePreview(revokeToken: string): Promise<void> {
          if (typeof revokeToken !== "string" || revokeToken.length === 0) return;
          const url = mediaPreviewUrls.get(revokeToken);
          if (url) { URL.revokeObjectURL(url); mediaPreviewUrls.delete(revokeToken); }
          await postRequest({ type: "nautilo.app.media.req", op: "closePreview", revokeToken });
        },
        async exportVideo(input: { document: { sha256: string; revision: number | null }; publishToWorkspace?: boolean; exportSettings?: import("@nautilo/types").VideoExportSettings }, options?: { signal?: AbortSignal; onProgress?: (progress: { stage: "preparing" | "rendering" | "saving" | "publishing"; processedTimeUs?: number }) => void }) {
          if (!input?.document || !/^[a-f0-9]{64}$/u.test(input.document.sha256) || (input.document.revision !== null && !Number.isSafeInteger(input.document.revision)) || (input.publishToWorkspace !== undefined && typeof input.publishToWorkspace !== "boolean")) return { kind: "unavailable" as const, code: "invalid_request" };
          const exportSettings = normalizeExportSettings(input.exportSettings);
          if (!exportSettings) return { kind: "unavailable" as const, code: "invalid_settings" };
          const requestId = newRequestId(); const signal = options?.signal;
          if (signal?.aborted) return { kind: "cancelled" as const };
          const onMessage = (event: MessageEvent) => {
            if (event.source !== win.parent || !event.data || typeof event.data !== "object") return;
            const record = event.data as Record<string, unknown>; const progress = record["progress"];
            if (record["type"] !== "nautilo.app.media.export-progress" || record["requestId"] !== requestId || !progress || typeof progress !== "object") return;
            const value = progress as Record<string, unknown>;
            if ((value["stage"] === "preparing" || value["stage"] === "rendering" || value["stage"] === "saving" || value["stage"] === "publishing") && (value["processedTimeUs"] === undefined || Number.isSafeInteger(value["processedTimeUs"]))) options?.onProgress?.({ stage: value["stage"], ...(typeof value["processedTimeUs"] === "number" ? { processedTimeUs: value["processedTimeUs"] } : {}) });
          };
          const abort = () => { win.parent.postMessage({ type: "nautilo.app.media.cancel", requestId }, "*"); };
          win.addEventListener("message", onMessage); signal?.addEventListener("abort", abort, { once: true });
          try {
            const response = postRequest({ type: "nautilo.app.media.req", op: "exportVideo", sha256: input.document.sha256, revision: input.document.revision, ...(input.publishToWorkspace === true ? { publishToWorkspace: true } : {}), ...(input.exportSettings ? { exportSettings } : {}) }, requestId);
            const value = await response;
            if (!value || typeof value !== "object") return { kind: "unavailable" as const, code: "invalid_response" };
            const record = value as Record<string, unknown>;
            const isSafeText = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.length > 0 && !/[\r\n\0]/u.test(candidate);
            const isRelativeWorkspacePath = (candidate: unknown) => isSafeText(candidate) && !candidate.startsWith("/") && !candidate.includes("\\") && !/(?:https?:|data:|blob:|file:)/iu.test(candidate) && !candidate.split("/").some((part) => !part || part === "." || part === "..");
            const workspace = record["workspace"];
            const isWorkspaceReceipt = (candidate: unknown): candidate is { status: "published" | "not_published" | "unknown"; path: string; artifactId?: string } => {
              if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
              const receipt = candidate as Record<string, unknown>;
              if (!Object.keys(receipt).every((key) => key === "status" || key === "path" || key === publicArtifactIdKey) || !isRelativeWorkspacePath(receipt["path"])) return false;
              if (receipt["status"] === "published") return typeof receipt[publicArtifactIdKey] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(receipt[publicArtifactIdKey]);
              return (receipt["status"] === "not_published" || receipt["status"] === "unknown") && receipt[publicArtifactIdKey] === undefined;
            };
            if (record["kind"] === "cancelled" && Object.keys(record).every((key) => key === "kind")) return { kind: "cancelled" as const };
            const code = record["code"];
            if (record["kind"] === "unavailable" && Object.keys(record).every((key) => key === "kind" || key === "code") && isSafeText(code)) return { kind: "unavailable" as const, code };
            if (record["kind"] === "succeeded" && Object.keys(record).every((key) => key === "kind" || key === "label" || key === "sizeBytes" || key === "warnings" || key === "workspace") && typeof record["label"] === "string" && record["label"].length > 0 && Number.isSafeInteger(record["sizeBytes"]) && (record["sizeBytes"] as number) >= 0 && Array.isArray(record["warnings"]) && (workspace === undefined || isWorkspaceReceipt(workspace))) return { kind: "succeeded" as const, label: record["label"], sizeBytes: record["sizeBytes"] as number, warnings: record["warnings"], ...(workspace === undefined ? {} : { workspace }) };
            return { kind: "unavailable" as const, code: "invalid_response" };
          } finally { win.removeEventListener("message", onMessage); signal?.removeEventListener("abort", abort); }
        },
        async saveWorkspaceCopy(input: { sha256: string }, options?: { signal?: AbortSignal; onProgress?: (progress: { stage: string; completed?: number; total?: number }) => void }) {
          if (!/^[a-f0-9]{64}$/u.test(input?.sha256)) return { kind: "unavailable" as const, code: "invalid_request", retainedPaths: [] };
          const requestId = newRequestId(); const signal = options?.signal;
          if (signal?.aborted) return { kind: "cancelled" as const, retainedPaths: [] };
          const onMessage = (event: MessageEvent) => {
            const record = event.data as Record<string, unknown> | null; const progress = record?.["progress"] as Record<string, unknown> | undefined;
            if (event.source !== win.parent || record?.["type"] !== "nautilo.app.media.promotion-progress" || record["requestId"] !== requestId || !progress || typeof progress["stage"] !== "string") return;
            options?.onProgress?.({ stage: progress["stage"], ...(typeof progress["completed"] === "number" ? { completed: progress["completed"] } : {}), ...(typeof progress["total"] === "number" ? { total: progress["total"] } : {}) });
          };
          const abort = () => win.parent.postMessage({ type: "nautilo.app.media.cancel", requestId }, "*");
          win.addEventListener("message", onMessage); signal?.addEventListener("abort", abort, { once: true });
          try {
            const value = await postRequest({ type: "nautilo.app.media.req", op: "saveWorkspaceCopy", sha256: input.sha256 }, requestId);
            if (!value || typeof value !== "object") return { kind: "unavailable" as const, code: "invalid_response", retainedPaths: [] };
            const row = value as Record<string, unknown>;
            if (row["kind"] === "succeeded" && typeof row["path"] === "string" && typeof row["roomLabel"] === "string" && Number.isSafeInteger(row["mediaCount"])) return { kind: "succeeded" as const, path: row["path"], roomLabel: row["roomLabel"], mediaCount: row["mediaCount"] as number };
            const retainedPaths = Array.isArray(row["retainedPaths"]) && row["retainedPaths"].every((item) => typeof item === "string") ? row["retainedPaths"] : [];
            const kind: "cancelled" | "unknown" | "unavailable" = row["kind"] === "cancelled" || row["kind"] === "unknown" ? row["kind"] : "unavailable";
            return { kind, ...(typeof row["code"] === "string" ? { code: row["code"] } : {}), retainedPaths };
          } finally { win.removeEventListener("message", onMessage); signal?.removeEventListener("abort", abort); }
        },
        async getWorkspaceCopyCapabilities() {
          const value = await postRequest({ type: "nautilo.app.media.req", op: "workspaceCopyCapabilities" });
          const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
          return row && typeof row["available"] === "boolean" ? { available: row["available"], ...(typeof row["roomLabel"] === "string" ? { roomLabel: row["roomLabel"] } : {}) } : { available: false };
        },
        async openWorkspaceCopy() {
          const value = await postRequest({ type: "nautilo.app.media.req", op: "openWorkspaceCopy" });
          const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
          return row && typeof row["opened"] === "boolean" ? { opened: row["opened"], ...(typeof row["code"] === "string" ? { code: row["code"] } : {}) } : { opened: false, code: "invalid_response" };
        },
      })
    : undefined;

  const isClosedVideoRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key));
  const isSafeVideoText = (value: unknown, max?: number): value is string =>
    typeof value === "string" && value.length > 0 && (max === undefined || new TextEncoder().encode(value).byteLength <= max) && !/[\r\n\0]/u.test(value) && !/(?:https?:|data:|blob:|file:)/iu.test(value);
  const parseVideoSettings = (value: unknown): NautiloVideoGenerationTake["settings"] | null => {
    if (!isClosedVideoRecord(value, ["durationSeconds", "resolution", "aspectRatio", "audioEnabled", "instrumental"])) return null;
    if ((value["durationSeconds"] !== undefined && (!Number.isSafeInteger(value["durationSeconds"]) || (value["durationSeconds"] as number) <= 0)) ||
      (value["resolution"] !== undefined && (typeof value["resolution"] !== "string" || !/^[A-Za-z0-9._:+-]{1,64}$/u.test(value["resolution"]))) ||
      (value["aspectRatio"] !== undefined && (typeof value["aspectRatio"] !== "string" || !/^[A-Za-z0-9._:+-]{1,64}$/u.test(value["aspectRatio"]))) ||
      (value["audioEnabled"] !== undefined && typeof value["audioEnabled"] !== "boolean") ||
      (value["instrumental"] !== undefined && typeof value["instrumental"] !== "boolean")) return null;
    return {
      ...(value["durationSeconds"] === undefined ? {} : { durationSeconds: value["durationSeconds"] as number }),
      ...(value["resolution"] === undefined ? {} : { resolution: value["resolution"] }),
      ...(value["aspectRatio"] === undefined ? {} : { aspectRatio: value["aspectRatio"] }),
      ...(value["audioEnabled"] === undefined ? {} : { audioEnabled: value["audioEnabled"] }),
      ...(value["instrumental"] === undefined ? {} : { instrumental: value["instrumental"] }),
    };
  };
  const parseVideoArtifact = (value: unknown): NautiloVideoGenerationTake["artifact"] | null => {
    if (!isClosedVideoRecord(value, [publicArtifactIdKey, "path", "zone", "mime", "bytes"]) || typeof value[publicArtifactIdKey] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value[publicArtifactIdKey]) ||
      typeof value["path"] !== "string" || value["path"].length === 0 || value["path"].startsWith("/") || value["path"].includes("\\") ||
      /(?:https?:|data:|blob:|file:)/iu.test(value["path"]) || value["path"].split("/").some((part) => !part || part === "." || part === "..") ||
      value["zone"] !== "workspace" || typeof value["mime"] !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value["mime"]) ||
      !Number.isSafeInteger(value["bytes"]) || (value["bytes"] as number) <= 0) return null;
    return { [publicArtifactIdKey]: value[publicArtifactIdKey], path: value["path"], zone: "workspace", mime: value["mime"], bytes: value["bytes"] as number } as NautiloVideoGenerationTake["artifact"];
  };
  const parseVideoTake = (value: unknown): NautiloVideoGenerationTake | null => {
    if (!isClosedVideoRecord(value, ["id", "briefRevision", "shotId", "shotLabel", "mediaKind", "modelId", "settings", "artifact"]) || !safeTakeId(value["id"]) ||
      !Number.isSafeInteger(value["briefRevision"]) || (value["briefRevision"] as number) < 0 ||
      (value["shotId"] !== undefined && (typeof value["shotId"] !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value["shotId"]))) ||
      (value["shotLabel"] !== undefined && !isSafeVideoText(value["shotLabel"])) || (value["mediaKind"] !== "video" && value["mediaKind"] !== "audio") ||
      typeof value["modelId"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value["modelId"])) return null;
    const settings = parseVideoSettings(value["settings"]);
    const artifact = parseVideoArtifact(value["artifact"]);
    if (!settings || !artifact || (value["mediaKind"] === "video" ? !artifact.mime.startsWith("video/") : !artifact.mime.startsWith("audio/"))) return null;
    return { id: value["id"], briefRevision: value["briefRevision"] as number, ...(value["shotId"] === undefined ? {} : { shotId: value["shotId"] }), ...(value["shotLabel"] === undefined ? {} : { shotLabel: value["shotLabel"] }), mediaKind: value["mediaKind"], modelId: value["modelId"], settings, artifact };
  };
  const unavailableVideoGenerationResult = (value: unknown): Readonly<{ kind: "unavailable"; code: string }> => {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
    return { kind: "unavailable", code: typeof record?.["code"] === "string" ? record["code"] : "invalid_response" };
  };
  const safeTakeId = (value: unknown): value is string => typeof value === "string" && /^take_[A-Za-z0-9_-]{16,128}$/u.test(value);
  const parseVideoGenerationReferenceImport = (value: unknown): NautiloVideoGenerationReferenceImportResult => {
    if (!value || typeof value !== "object") return unavailableVideoGenerationResult(value);
    const result = value as Record<string, unknown>;
    if (result["kind"] !== "ready" || !isClosedVideoRecord(result, ["kind", "asset"]) || !isClosedVideoRecord(result["asset"], [publicArtifactIdKey, "path", "label", "mediaKind", "mimeType", "sizeBytes"])) {
      return unavailableVideoGenerationResult(value);
    }
    const asset = result["asset"];
    const publicIdentity = asset[publicArtifactIdKey];
    const mediaKind = asset["mediaKind"];
    const mimeType = asset["mimeType"];
    const path = asset["path"];
    if (typeof publicIdentity !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(publicIdentity) ||
        typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\") || /(?:https?:|data:|blob:|file:)/iu.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") ||
        !isSafeVideoText(asset["label"]) || (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") ||
        typeof mimeType !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mimeType) ||
        (mediaKind === "image" && !mimeType.startsWith("image/")) || (mediaKind === "video" && !mimeType.startsWith("video/")) || (mediaKind === "audio" && !mimeType.startsWith("audio/")) ||
        !Number.isSafeInteger(asset["sizeBytes"]) || (asset["sizeBytes"] as number) <= 0 || (asset["sizeBytes"] as number) > 100 * 1024 * 1024) return unavailableVideoGenerationResult(value);
    return {
      kind: "ready",
      asset: { [publicArtifactIdKey]: publicIdentity, path, label: asset["label"], mediaKind, mimeType, sizeBytes: asset["sizeBytes"] } as Extract<NautiloVideoGenerationReferenceImportResult, { kind: "ready" }>["asset"],
    };
  };

  const videoGenerationApi = grants.videoGeneration === true
    ? Object.freeze({
        async request(input: NautiloVideoGenerationRequest): Promise<NautiloVideoGenerationRequestResult> {
          const requestId = newRequestId();
          const value = await postRequest({ type: "nautilo.app.video-generation.request", ...input }, requestId);
          if (!value || typeof value !== "object") return { kind: "unavailable", code: "invalid_response" };
          const result = value as Record<string, unknown>;
          if (result["kind"] === "queued") {
            return { kind: "queued", ...(safeTakeId(result["takeId"]) ? { takeId: result["takeId"] } : {}) };
          }
          if (result["kind"] === "submission-unknown" && safeTakeId(result["takeId"]) && isClosedVideoRecord(result, ["kind", "takeId"])) return { kind: "submission-unknown", takeId: result["takeId"] };
          if (result["kind"] === "cancelled" || result["kind"] === "expired") {
            return { kind: result["kind"] };
          }
          return result["kind"] === "unavailable" && typeof result["code"] === "string"
            ? { kind: "unavailable", code: result["code"] }
            : { kind: "unavailable", code: "invalid_response" };
        },
        async listTakes(): Promise<NautiloVideoGenerationTakeListResult> {
          const value = await postRequest({ type: "nautilo.app.video-generation.req", op: "listTakes" }, newRequestId());
          if (!value || typeof value !== "object") return unavailableVideoGenerationResult(value);
          const result = value as Record<string, unknown>;
          if (result["kind"] !== "ready" || !Array.isArray(result["takes"])) return unavailableVideoGenerationResult(value);
          const takes = result["takes"].map((candidate) => {
            if (!candidate || typeof candidate !== "object") return null;
            const take = candidate as Record<string, unknown>;
            return safeTakeId(take["takeId"]) && typeof take["shotId"] === "string" && typeof take["shotLabel"] === "string" &&
              Number.isSafeInteger(take["documentRevision"]) && (take["documentRevision"] as number) >= 0
              ? { takeId: take["takeId"], shotId: take["shotId"], shotLabel: take["shotLabel"], documentRevision: take["documentRevision"] as number }
              : null;
          });
          return takes.every((take) => take !== null) ? { kind: "ready", takes: takes as Array<{ takeId: string; shotId: string; shotLabel: string; documentRevision: number }> } : unavailableVideoGenerationResult(value);
        },
        async getTakeStatus(input: { takeId: string }): Promise<NautiloVideoGenerationTakeStatusResult> {
          if (!input || !safeTakeId(input.takeId)) return { kind: "unavailable", code: "invalid_take" };
          const value = await postRequest({ type: "nautilo.app.video-generation.req", op: "getTakeStatus", takeId: input.takeId }, newRequestId());
          if (!value || typeof value !== "object") return unavailableVideoGenerationResult(value);
          const result = value as Record<string, unknown>;
          const raw = result["status"];
          if (result["kind"] !== "ready" || !isClosedVideoRecord(raw, ["takeId", "revision", "mediaKind", "state", "modelId", "settings", "progress", "artifact", "failure", "recoveryActions"]) ||
            !safeTakeId(raw["takeId"]) || !Number.isSafeInteger(raw["revision"]) || (raw["revision"] as number) < 0 ||
            (raw["mediaKind"] !== "video" && raw["mediaKind"] !== "audio") || typeof raw["state"] !== "string" ||
            !["preparing", "submitting", "queued", "generating", "downloading", "saving", "ready", "cleanup-pending", "needs-action", "failed", "unknown"].includes(raw["state"]) ||
            typeof raw["modelId"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(raw["modelId"])) return unavailableVideoGenerationResult(value);
          const settings = parseVideoSettings(raw["settings"]);
          const artifact = raw["artifact"] === undefined ? undefined : parseVideoArtifact(raw["artifact"]);
          const progress = raw["progress"];
          const failure = raw["failure"];
          const recoveryActions = raw["recoveryActions"];
          if (!settings || (raw["artifact"] !== undefined && !artifact) || !Array.isArray(recoveryActions) || recoveryActions.length > 16 ||
            !recoveryActions.every((action) => isClosedVideoRecord(action, ["kind", "label", "newSpend"]) && typeof action["kind"] === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(action["kind"]) && isSafeVideoText(action["label"], 160) && typeof action["newSpend"] === "boolean") ||
            (progress !== undefined && (!isClosedVideoRecord(progress, ["phase", "elapsedSeconds", "estimatedSeconds", "message"]) || typeof progress["phase"] !== "string" ||
              (progress["elapsedSeconds"] !== undefined && (!Number.isSafeInteger(progress["elapsedSeconds"]) || (progress["elapsedSeconds"] as number) < 0)) ||
              (progress["estimatedSeconds"] !== undefined && (!Number.isSafeInteger(progress["estimatedSeconds"]) || (progress["estimatedSeconds"] as number) < 0)) ||
              (progress["message"] !== undefined && !isSafeVideoText(progress["message"], 512)))) ||
            (failure !== undefined && (!isClosedVideoRecord(failure, ["code", "message", "phase", "retrySafe", "stateChanged", "completionCertainty", "chargeCertainty", "creditsRefunded"]) ||
              typeof failure["code"] !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(failure["code"]) || !isSafeVideoText(failure["message"], 512) ||
              typeof failure["phase"] !== "string" || typeof failure["retrySafe"] !== "boolean" || typeof failure["stateChanged"] !== "boolean" ||
              typeof failure["completionCertainty"] !== "string" || typeof failure["chargeCertainty"] !== "string" ||
              (failure["creditsRefunded"] !== undefined && typeof failure["creditsRefunded"] !== "boolean")))) return unavailableVideoGenerationResult(value);
          return {
            kind: "ready",
            status: {
              takeId: raw["takeId"], revision: raw["revision"] as number, mediaKind: raw["mediaKind"], state: raw["state"] as NautiloVideoGenerationTakeStatus["state"], modelId: raw["modelId"], settings,
              ...(progress === undefined ? {} : { progress: { phase: progress["phase"] as string, ...(progress["elapsedSeconds"] === undefined ? {} : { elapsedSeconds: progress["elapsedSeconds"] as number }), ...(progress["estimatedSeconds"] === undefined ? {} : { estimatedSeconds: progress["estimatedSeconds"] as number }), ...(progress["message"] === undefined ? {} : { message: progress["message"] as string }) } }),
              ...(artifact ? { artifact } : {}),
              ...(failure === undefined ? {} : { failure: { code: failure["code"] as string, message: failure["message"] as string, phase: failure["phase"] as string, retrySafe: failure["retrySafe"] as boolean, stateChanged: failure["stateChanged"] as boolean, completionCertainty: failure["completionCertainty"] as string, chargeCertainty: failure["chargeCertainty"] as string, ...(failure["creditsRefunded"] === undefined ? {} : { creditsRefunded: failure["creditsRefunded"] as boolean }) } }),
              recoveryActions: recoveryActions.map((action) => ({ kind: (action as Record<string, unknown>)["kind"] as string, label: (action as Record<string, unknown>)["label"] as string, newSpend: (action as Record<string, unknown>)["newSpend"] as boolean })),
            },
          };
        },
        async previewTake(input: { takeId: string }): Promise<NautiloVideoGenerationPreviewResult> {
          if (!input || !safeTakeId(input.takeId)) return { kind: "unavailable", code: "invalid_take" };
          const value = await postRequest({ type: "nautilo.app.video-generation.req", op: "previewTake", takeId: input.takeId }, newRequestId());
          if (value && typeof value === "object" && (value as Record<string, unknown>)["kind"] === "opened") return { kind: "opened" };
          return unavailableVideoGenerationResult(value);
        },
        async revalidateTake(input: { takeId: string }): Promise<NautiloVideoGenerationRevalidationResult> {
          if (!input || !safeTakeId(input.takeId)) return { status: "malformed", takeId: typeof input?.takeId === "string" ? input.takeId : "" };
          const value = await postRequest({ type: "nautilo.app.video-generation.req", op: "revalidateTake", takeId: input.takeId }, newRequestId());
          if (!value || typeof value !== "object") return { status: "unavailable", takeId: input.takeId };
          const result = value as Record<string, unknown>;
          const take = parseVideoTake(result["take"]);
          if (result["status"] === "ready" && take && typeof result["durationSec"] === "number" && Number.isFinite(result["durationSec"]) && result["durationSec"] > 0) {
            return { status: "ready", take, durationSec: result["durationSec"] };
          }
          return (result["status"] === "stale" || result["status"] === "deleted" || result["status"] === "unavailable" || result["status"] === "malformed") && safeTakeId(result["takeId"])
            ? { status: result["status"], takeId: result["takeId"] }
            : { status: "unavailable", takeId: input.takeId };
        },
        async importReferences(input: { mediaKind: "image" }): Promise<NautiloVideoGenerationReferencesImportResult> {
          if (input?.mediaKind !== "image") return { kind: "unavailable", code: "invalid_media" };
          const value = await postRequest({ type: "nautilo.app.video-generation.req", op: "importReferences", mediaKind: "image" }, newRequestId());
          if (!isClosedVideoRecord(value, ["kind", "assets", "failures"]) || value["kind"] !== "ready" || !Array.isArray(value["assets"]) || !Array.isArray(value["failures"])) return unavailableVideoGenerationResult(value);
          const assets: Extract<NautiloVideoGenerationReferenceImportResult, { kind: "ready" }>["asset"][] = [];
          const rawAssets: readonly unknown[] = value["assets"];
          for (const asset of rawAssets) {
            const parsed = parseVideoGenerationReferenceImport({ kind: "ready", asset });
            if (parsed.kind !== "ready" || parsed.asset.mediaKind !== "image") return unavailableVideoGenerationResult(null);
            assets.push(parsed.asset);
          }
          const failures: { label: string; code: string }[] = [];
          for (const failure of value["failures"]) {
            if (!isClosedVideoRecord(failure, ["label", "code"]) || !isSafeVideoText(failure["label"]) || typeof failure["code"] !== "string" || !/^[a-z_]+$/u.test(failure["code"])) return unavailableVideoGenerationResult(null);
            failures.push({ label: failure["label"], code: failure["code"] });
          }
          return { kind: "ready", assets, failures };
        },
        async importReference(input: { mediaKind: "image" | "video" | "audio" }): Promise<NautiloVideoGenerationReferenceImportResult> {
          if (!input || (input.mediaKind !== "image" && input.mediaKind !== "video" && input.mediaKind !== "audio")) {
            return { kind: "unavailable", code: "invalid_media" };
          }
          const value = await postRequest(
            { type: "nautilo.app.video-generation.req", op: "importReference", mediaKind: input.mediaKind },
            newRequestId(),
          );
          return parseVideoGenerationReferenceImport(value);
        },
      })
    : undefined;

  const hostLayoutApi = grants.videoHostLayout === true
    ? Object.freeze({
        async setFullWidth(input: { enabled: boolean }): Promise<void> {
          if (!input || typeof input.enabled !== "boolean") return;
          await postRequest({ type: "nautilo.app.video-host-layout.req", op: "setFullWidth", enabled: input.enabled }, newRequestId());
        },
      })
    : undefined;

  winRecord["nautiloApp"] = Object.freeze({
    version: 1 as const,
    assets: Object.freeze({
      pick: () => postRequest({ type: "nautilo.app.assets.req", op: "pick" }),
      read: (ref: string) => postRequest({ type: "nautilo.app.assets.req", op: "read", ref }),
    }),
    document: documentApi,
    state: stateApi,
    ...(mode === "edit" && recoveryEnabled ? { recovery: recoveryApi } : {}),
    ...(mode === "edit" && templatesEnabled ? { templates: templatesApi } : {}),
    preferences: preferencesApi,
    context: contextApi,
    humanEdit: humanEditApi,
    lifecycle: lifecycleApi,
    exports: exportsApi,
    session: sessionApi,
    ...(assetApi ? { asset: assetApi } : {}),
    ...(mediaApi ? { media: mediaApi } : {}),
    ...(videoGenerationApi ? { videoGeneration: videoGenerationApi } : {}),
    ...(hostLayoutApi ? { hostLayout: hostLayoutApi } : {}),
  }) satisfies NautiloAppBridge;
}

/**
 * Install `window.nautiloApp` on the given window (defaults to `window`).
 * Replaces any server-injected placeholder with the real frozen bridge API.
 */
export function installNautiloAppBridgeClient(
  win: Window = window,
  bootstrap: MiniAppTheme | { initialTheme?: MiniAppTheme; assetReadRaster?: true; mediaProxy?: true; videoGeneration?: true; videoHostLayout?: true } = {},
  mode: "edit" | "preview" = "edit",
  capabilities?: NautiloAppBridgeClientCapabilities,
): void {
  bridgeClientInstaller(
    win,
    bootstrap,
    normalizeVideoExportSettings,
    mode,
    capabilities?.recovery === true,
    capabilities?.templates === true,
  );
}

/**
 * Inline script source for srcDoc injection before the app bundle runs.
 * Self-contained — safe to evaluate in the iframe global scope.
 */
export function buildNautiloAppBridgeClientScript(
  bootstrap: MiniAppTheme | { initialTheme?: MiniAppTheme; assetReadRaster?: true; mediaProxy?: true; videoGeneration?: true; videoHostLayout?: true } = {},
  mode: "edit" | "preview" = "edit",
  capabilities?: NautiloAppBridgeClientCapabilities,
): string {
  const source = `(${bridgeClientInstaller.toString()})(
    typeof window !== "undefined" ? window : self,
    ${JSON.stringify(bootstrap)},
    (${normalizeVideoExportSettings.toString()}),
    ${JSON.stringify(mode)},
    ${JSON.stringify(capabilities?.recovery === true)},
    ${JSON.stringify(capabilities?.templates === true)}
  );`;
  return escapeInlineScriptClosingTag(source);
}

declare global {
  interface Window {
    nautiloApp?: NautiloAppBridge;
  }
}
import { normalizeVideoExportSettings } from "@nautilo/types";
