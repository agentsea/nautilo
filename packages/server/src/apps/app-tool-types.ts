import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { TrustedLiveMiniAppSessionContext } from "@nautilo/types";
import type { SlideTemplateContentDto, SlideTemplateListPageDto, SlideTemplateSummaryDto } from "@nautilo/api-client";
import type { MiniAppAgentToolManifest, MiniAppManifest } from "./app-manifest";
import type {
  LiveMiniAppSessionBinding,
  LiveMiniAppSessionCurrentFileBinding,
} from "./live-mini-app-session-registry";

export type AppDocumentTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };

export type AppDocumentReadResult = {
  content: string;
  /** Omitted for UTF-8 compatibility. Base64 is explicit and byte-exact. */
  encoding?: "utf8" | "base64";
  byteLength?: number;
  mimeType: string | null;
  displayPath: string;
  baseSha256: string | null;
  baseRevision: number | null;
};

export type AppDocumentStatResult = {
  exists: boolean;
  size: number | null;
  mimeType: string | null;
  baseSha256: string | null;
  baseRevision: number | null;
};

export type AppDocumentWriteResult =
  | { kind: "saved"; sha256: string; revision?: number; localRevisionId?: string; size?: number }
  | {
      kind: "conflict";
      currentSha256: string | null;
      conflictKind?: "anchor_not_found" | "anchor_ambiguous" | "stale_base_unrebaseable";
      latestRevision?: number | null;
    }
  | { kind: "error"; message: string };

export type AppDirectMutationGateFailure = {
  ok: false;
  status: "use_edit_open_writer";
  code: "use_edit_open_writer";
  message: "This document is open in Writer review. Use edit-open-writer.";
};

export type AppDocumentCreateResult = {
  target: AppDocumentTarget;
  displayPath: string;
  opened: boolean;
  sha256?: string;
  byteLength?: number;
  openInApp?: {
    appId: string;
    appName: string;
    target:
      | { surface: "workspace"; path: string; artifactInternalId: string; mimeType: string; roomId?: string; sizeBytes?: number }
      | { surface: "currentFolder"; relativePath: string; currentFolderRoot: string };
  };
};

/**
 * M205 — args for the generic `office.run` host primitive. Format-agnostic:
 * the server core reads/writes bytes + runs the OfficeCLI binary, but never
 * parses any document format. The mapper (in the app worker) supplies OfficeCLI
 * argv (read) / batch ops (write); the host stages bytes and runs the binary.
 */
export type AppOfficeRunDataUrlImageInput = {
  /** Supported data URL only: data:image/png|jpeg|gif|svg+xml;base64,... */
  dataUrl: string;
};

export type AppOfficeRunArgs = {
  /** Read an existing office file and return its OfficeCLI JSON. */
  input?: { surface: "workspace" | "currentFolder"; path: string };
  /**
   * OfficeCLI argv for a read, AFTER the input file positional (e.g.
   * `["get", "/body", "--depth", "6", "--json"]`). The host injects the staged
   * input file path as the first positional arg after the subcommand.
   */
  readArgv?: string[];
  /** Generate/mutate: OfficeCLI batch commands applied to a freshly created file. */
  ops?: unknown[];
  /**
   * Structured data-URL image payloads referenced by picture batch commands via
   * `_imageIndex`. The host decodes and stages bytes beside OfficeCLI — never
   * arbitrary filesystem paths from the mapper.
   */
  imageInputs?: AppOfficeRunDataUrlImageInput[];
  /** Where to write the produced office bytes. */
  output?: { surface: "workspace" | "currentFolder"; path: string };
  /**
   * M205 — write-path collision policy. Default (false/undefined): an existing
   * target is a structured `EXISTS` result (the UI prompts overwrite / rename /
   * cancel). True: overwrite in place (workspace = revision bump, current folder
   * = re-write the file).
   */
  overwrite?: boolean;
};

export type AppOfficeRunResult =
  | {
      ok: true;
      /** Parsed OfficeCLI JSON (read path only). */
      json?: unknown;
      /**
       * Inline DOCX media keyed by OfficeCLI relationship id (`format.relId`).
       * Populated on read when the host can safely extract embedded media bytes.
       */
      mediaByRelId?: Record<string, string>;
      /** sha256 of the written bytes (write path only). */
      sha256?: string;
      /** Byte length of the written bytes (write path only). */
      byteLength?: number;
      /** Display path of the written output (write path only). */
      displayPath?: string;
    }
  | { ok: false; code: string; message: string };

/** M205 — result of `document.createDocument`. */
export type AppDocumentCreateDocumentResult =
  | { ok: true; artifactPath: string; artifactInternalId?: string; artifactId?: string; sha256: string; byteLength: number }
  | {
      ok: false; code: string; message: string;
      displayPath?: string; bytesWritten?: number; metadataConfirmed?: false;
      stateChanged?: true; retrySafe?: false;
    };

export type AppRasterAssetInspectResult =
  | { ok: true; ref: string; name: string; width: number; height: number }
  | { ok: false; code: string; message: string };

export type AppAssetReadResult =
  | { ok: true; displayPath: string; mimeType: string; width: number; height: number; byteLength: number; sha256: string; dataUrl: string }
  | { ok: false; code: string; message: string };

export type AppTemplateMutationFailure = {
  ok: false;
  code: string;
  phase: "admission" | "persist" | "remove" | "reconcile";
  retrySafe: boolean;
  stateChanged: false | "unknown";
  recoveryActions: string[];
  message: string;
};

/** A destination-confirmed or explicitly partial write, retained even if app code subsequently fails. */
export type AppToolCompletedHostMutation = {
  method: "document.createDocument" | "document.createRasterFromSvg" | "document.createFromAction";
  target: { surface: "workspace" | "currentFolder"; path: string };
  receipt: AppDocumentCreateDocumentResult;
};

export type AppToolRunnerContext = {
  ownerId: string;
  userId: string;
  agentId: string;
  roomId?: string | null;
  /** Active agent graph turn — present for catalog/agent-invoked app tools. */
  turnId?: string | null;
  /**
   * Host-issued UI/app mutation transaction id (`app:<appId>:<uuid>`).
   * Not an agent turn; journals and undo_turn group local mutations by this id.
   */
  appOperationId?: string | null;
  /** Stable host correlation for one admitted model tool call. */
  toolCallId?: string | null;
  /** Server-authored durable Task identity; absent for foreground turns. */
  currentTaskId?: string | null;
  /** Server-authored exact TaskRun identity; absent for foreground turns. */
  currentTaskRunId?: string | null;
  currentFolder?: string | null;
  workspacePath?: string | null;
  memoryAccessEnvelope: MemoryAccessEnvelope;
  /** Trusted ingress state; never sourced from model arguments. */
  liveMiniAppSession?: TrustedLiveMiniAppSessionContext | null;
};

/**
 * Resolves a workspace path to its internal artifact id using the runner
 * context's authorized mutable namespace envelope. `null` means no mutable
 * artifact is resolvable at that path.
 */
export type AppToolWorkspaceArtifactResolver = (
  workspacePath: string,
  context: AppToolRunnerContext,
) => Promise<string | null>;

export type AppToolCurrentFileIdentityResolver = (
  input: {
    ownerId: string;
    relayId: string;
    candidatePath: string;
  },
  context: AppToolRunnerContext,
) => Promise<string | null>;

export type AppToolInvokeRequest = {
  appId: string;
  appRoot: string;
  appsRoot: string;
  sourceHash: string;
  cacheDir: string;
  bundlePath: string;
  manifest: MiniAppManifest;
  tool: MiniAppAgentToolManifest;
  args: unknown;
  context: AppToolRunnerContext;
  /**
   * A server-only gate enforced by the worker before it loads app code. This
   * protocol is deliberately independent of any app's result/error strings.
   */
  platformGate?: AppToolPlatformGate;
  /**
   * Server-only binding for a direct mutation of an active mini-app document.
   * The runner gives this to the host and deliberately omits it from the
   * worker payload, so an app handler never receives target authority.
   */
  liveMutationBinding?: LiveMiniAppSessionBinding;
};

export type AppToolPlatformGate = {
  kind: "live_review";
  sessionSentinel: string;
  nonce: string;
};

export type AppToolPlatformFailure = {
  kind: "live_review";
  code:
    | "live_review_missing_opt_in"
    | "live_review_unregistered_extension"
    | "live_review_extension_failed"
    | "live_review_session_sentinel_mismatch";
  status: "session_closed" | "stale_version";
};

export type LiveBoundCanonicalReadResult =
  | { ok: true; content: string }
  | { ok: false; status: "session_closed" | "stale_version" };

/** Pinned relay canonical read for Current Folder live sessions. */
export type LiveCurrentFileCanonicalReader = (
  binding: LiveMiniAppSessionCurrentFileBinding,
  context: AppToolRunnerContext,
) => Promise<LiveBoundCanonicalReadResult>;

export type AppToolInvokeResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: string;
      code?: "timeout" | "handler" | "runner" | "bounded";
      completedHostMutations?: readonly AppToolCompletedHostMutation[];
    }
  | {
      ok: false;
      error: string;
      code: "platform";
      platformFailure: AppToolPlatformFailure;
      completedHostMutations?: readonly AppToolCompletedHostMutation[];
    }
  | {
      ok: false;
      error: string;
      code: "direct_mutation";
      directMutationFailure: AppDirectMutationGateFailure;
      completedHostMutations?: readonly AppToolCompletedHostMutation[];
    };

export type ServerNautiloAppHost = {
  assets: {
    /** Inspect one known Workspace artifact; this never lists assets or returns bytes. */
    inspect(args: { artifactId: string }): Promise<AppRasterAssetInspectResult>;
    read?(input: AppDocumentTarget | { ref: string }): Promise<AppAssetReadResult>;
  };
  templates?: {
    list(args?: { cursor?: string }): Promise<SlideTemplateListPageDto>;
    read(args: { templateId: string }): Promise<SlideTemplateContentDto>;
    save(args: { name: string; content: string }): Promise<{ ok: true; template: SlideTemplateSummaryDto; stateChanged: boolean; warnings?: string[] } | AppTemplateMutationFailure>;
    remove(args: { templateId: string }): Promise<{ ok: true; stateChanged: boolean; warnings?: string[] } | AppTemplateMutationFailure>;
  };
  session: { command(input: unknown): Promise<unknown> };
  document: {
    createFromAction(
      actionId: string,
      opts: {
        targetSurface: "workspace" | "currentFolder";
        filename: string;
        openAfterCreate?: boolean;
      },
    ): Promise<AppDocumentCreateResult>;
    read(target: AppDocumentTarget, options?: { encoding?: "utf8" | "base64" }): Promise<AppDocumentReadResult>;
    stat(target: AppDocumentTarget): Promise<AppDocumentStatResult>;
    write(
      target: AppDocumentTarget,
      next: { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null },
    ): Promise<AppDocumentWriteResult>;
    /**
     * Writes only the server-validated live binding. App code supplies no
     * path and cannot select another document.
     */
    writeBound(
      next: { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null },
    ): Promise<AppDocumentWriteResult>;
    /**
     * Create a new document through canonical storage. Local mutations require
     * an agent turnId or a host-issued appOperationId for durable journaling:
     *   - `surface: "workspace"` → a workspace artifact, optionally colocated
     *     in the SAME namespace as an existing artifact (`colocateWith`).
     *   - `surface: "currentFolder"` → a file written to the current folder via
     *     the Desktop document coordinator; create-only publication is atomic.
     * Distinct from `write`, which edits an EXISTING bound document.
     */
    createDocument(args: {
      surface: "workspace" | "currentFolder";
      path: string;
      content: string;
      /** Base64 creates exact binary bytes in the declared document surface; omitted means UTF-8. */
      encoding?: "utf8" | "base64";
      mimeType?: string;
      colocateWith?: { surface: "workspace"; path: string };
      /**
       * M205 — collision policy. Default: an existing target is a structured
       * `EXISTS` failure. True: overwrite in place (workspace = revision bump,
       * current folder = re-write).
       */
      overwrite?: boolean;
    }): Promise<AppDocumentCreateDocumentResult>;
    /** Rasterize a resource-free SVG and create a PNG through existing document authority. */
    createRasterFromSvg(args: {
      surface: "workspace" | "currentFolder";
      path: string;
      svg: string;
      format: "png";
      colocateWith?: { surface: "workspace"; path: string };
      overwrite?: boolean;
    }): Promise<AppDocumentCreateDocumentResult>;
  };
  state: {
    get(target: AppDocumentTarget, key: string): Promise<unknown>;
    set(target: AppDocumentTarget, key: string, value: unknown): Promise<void>;
  };
  office: {
    run(args: AppOfficeRunArgs): Promise<AppOfficeRunResult>;
  };
};
