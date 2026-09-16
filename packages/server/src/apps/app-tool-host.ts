import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createWorkspaceBinaryArtifact,
  createFileMutationRequestId,
  envelopeFactsForArtifacts,
  getRelayRegistry,
  getWorkspaceFileContentCommitExecution,
  getWorkspaceFileContentRecoveryExecution,
  physicalPathFromStorageUri,
  resolveWorkspaceArtifact,
  sha256Hex,
  USER_SAVE_TEXT_LIMIT_BYTES,
  validateLogicalPath,
  withAgentTrustContext,
  executeLocalOfficeOperation,
  parseOfficeRunReadArgv,
  writeLocalZoneText,
  writeLocalZoneBytes,
  readLocalZoneText,
  readLocalZoneBytes,
  queryLocalZoneStat,
  requireLocalMutationTurnId,
  formatLocalMutationTurnIdError,
  parseLocalWriteRevisionId,
  LOCAL_HISTORY_INPUT_REQUIRED,
  FOCUSED_RELAY_MISMATCH_MESSAGE,
  liveReviewWriteGateFailure,
  resolveFocusedRelayHintForPath,
  resolveLocalFileRelay,
  resolveLocalOfficeRelay,
  type WorkspaceFileContentCommitExecution,
  type ToolRelayRegistry,
  type ZoneContext,
  type LocalZoneIoContext,
  type WorkspaceArtifactCreationActor,
} from "@nautilo/agent";
import {
  getArtifactNamespaces,
  getArtifactStateForNamespaces,
  findArtifactByInternalIdForNamespaces,
  setArtifactState,
} from "@nautilo/db";
import {
  envelopeReadableNamespaces,
  envelopeMutableNamespaces,
  envelopeWritableNamespaces,
} from "@nautilo/trust";
import { readAppSourceFile } from "./app-source-store";
import type { MiniAppManifest } from "./app-manifest";
import {
  accessAllowsRead,
  accessAllowsWrite,
  appStateStorageKey,
  capabilityDeniedMessage,
  documentAccessLevel,
  documentSurfaceForTarget,
  stateAccessLevel,
  validateAppDocumentTarget,
  validateBasenameFilename,
  validateStateKey,
  validateWorkspaceLogicalPath,
  type DocumentSurface,
} from "./app-tool-target";
import type {
  AppDocumentCreateResult,
  AppDocumentReadResult,
  AppDocumentStatResult,
  AppDocumentTarget,
  AppDocumentWriteResult,
  AppOfficeRunArgs,
  AppOfficeRunResult,
  AppDocumentCreateDocumentResult,
  AppToolRunnerContext,
  AppToolCurrentFileIdentityResolver,
  AppDirectMutationGateFailure,
  ServerNautiloAppHost,
} from "./app-tool-types";
import type { LiveMiniAppSessionBinding } from "./live-mini-app-session-registry";
import {
  docxMediaMapToDataUrls,
  extractDocxMediaByRelId,
  runOfficeCliRaw,
  stageOfficeRunImageInputs,
  verifyOfficeCliOnce,
} from "@nautilo/config/officecli";
import { warn } from "@nautilo/logger";
import { liveMiniAppSessionRegistry } from "./live-mini-app-session-registry";
import "./first-party-live-review-extensions";
import {
  getLiveAppSessionExtension,
  getRegisteredLiveReviewAppIds,
  isDirectMutationLiveReviewExtension,
} from "./live-review-extension-registry";
import { rasterizeResourceFreeSvg } from "./svg-raster";
import { hasFirstPartyAssetAuthority } from "./first-party-asset-authority";
import sharp from "sharp";
import { findActorByOwnerId } from "@nautilo/trust";
import { parseMiniAppAssetRef } from "./mini-app-assets";
import {
  defaultSlideTemplateService,
  listPrivateSlideTemplates,
  readPrivateSlideTemplate,
  removePrivateSlideTemplate,
  resolvePrivateSlideTemplateNamespace,
  savePrivateSlideTemplate,
  type SlideTemplateRouteService,
} from "../lib/slide-template-service";
import {
  inspectWorkspaceRasterAsset,
  resolveMiniAppAssetReferencesInSvg,
  resolveWorkspaceRasterAsset,
  type MiniAppAssetDependencies,
  type ResolvedSvgAssets,
} from "./mini-app-assets";
import { liveAppCommandBroker } from "./live-app-command-broker";

type WorkspaceRememberedBase = {
  bytes: Buffer;
  artifactInternalId: string;
  baseSha256: string;
  baseRevision: number | null;
};

export type AppDocumentOperations = {
  createFromAction(input: {
    actionId: string;
    targetSurface: "workspace" | "currentFolder";
    filename: string;
    openAfterCreate?: boolean;
  }): Promise<AppDocumentCreateResult>;
  read(target: AppDocumentTarget, options?: { encoding?: "utf8" | "base64" }): Promise<AppDocumentReadResult>;
  stat(target: AppDocumentTarget): Promise<AppDocumentStatResult>;
  write(
    target: AppDocumentTarget,
    next: { content: string },
    opts?: { baseSha256?: string | null; baseRevision?: number | null },
  ): Promise<AppDocumentWriteResult>;
  getState(target: AppDocumentTarget, key: string): Promise<unknown>;
  setState(target: AppDocumentTarget, key: string, value: unknown): Promise<void>;
};

export type CreateAppToolHostOptions = {
  invocation?: { toolId: string; signal: AbortSignal; deadline: number };
  appId: string;
  /** Exact installed source root used to build this invocation's worker. */
  appRoot?: string;
  appsRoot: string;
  /** Exact source identity captured by the server before worker dispatch. */
  sourceHash?: string;
  /** Test seam for namespace resolution and artifact byte custody. */
  assetDependencies?: MiniAppAssetDependencies;
  /** Test seam over the same private Human template service used by HTTP routes. */
  slideTemplateService?: SlideTemplateRouteService;
  /** Test seam; production derives the canonical actor from the authenticated Human id. */
  resolveHumanActorId?: (userId: string) => Promise<string | null>;
  manifest: MiniAppManifest;
  context: AppToolRunnerContext;
  documentOps?: AppDocumentOperations;
  /** Test seam; production still executes this reader inside the caller's trust transaction. */
  getArtifactNamespacesFn?: typeof getArtifactNamespaces;
  relayRegistry?: ToolRelayRegistry | null | undefined;
  liveReviewArtifactId?: (target: { surface: "workspace"; path: string }, context: AppToolRunnerContext) => Promise<string | null>;
  liveReviewCurrentFileIdentity?: AppToolCurrentFileIdentityResolver;
  /** Validated direct-live target authority; server-only and never exposed to the app worker. */
  liveMutationBinding?: LiveMiniAppSessionBinding;
  /** Remaining invocation time from the runner's existing monotonic deadline. */
  remainingToolTimeMs?: () => number;
};

type ArtifactNamespaceConnection = Parameters<typeof getArtifactNamespaces>[1];

export async function getArtifactNamespacesInTrustContext(
  artifactId: string,
  facts: { userId: string; agentId?: string },
  reader: typeof getArtifactNamespaces = getArtifactNamespaces,
  runWithTrust: (
    context: { userId: string; agentId?: string },
    read: (connection: ArtifactNamespaceConnection) => Promise<string[]>,
  ) => Promise<string[]> = (context, read) => withAgentTrustContext(
    context,
    async (tx) => read(tx as unknown as ArtifactNamespaceConnection),
  ),
): Promise<string[]> {
  return runWithTrust(
    { userId: facts.userId, ...(facts.agentId ? { agentId: facts.agentId } : {}) },
    async (connection) => reader(artifactId, connection),
  );
}

function requireDocumentRead(manifest: MiniAppManifest, surface: DocumentSurface): string | null {
  const level = documentAccessLevel(manifest, surface);
  if (!accessAllowsRead(level)) {
    return capabilityDeniedMessage("read", surface);
  }
  return null;
}

function requireDocumentWrite(manifest: MiniAppManifest, surface: DocumentSurface): string | null {
  const level = documentAccessLevel(manifest, surface);
  if (!accessAllowsWrite(level)) {
    return capabilityDeniedMessage("write", surface);
  }
  return null;
}

async function rejectOpenLiveReviewWrite(
  context: AppToolRunnerContext,
  target: AppDocumentTarget | { surface: "workspace" | "currentFolder"; path: string },
  relayRegistry: ToolRelayRegistry | null,
  resolveArtifactId?: CreateAppToolHostOptions["liveReviewArtifactId"],
  resolveCurrentIdentity?: CreateAppToolHostOptions["liveReviewCurrentFileIdentity"],
  liveMutationBinding?: LiveMiniAppSessionBinding,
  selectionKind: "file" | "office" = "file",
): Promise<void> {
  if (target.surface === "workspace") {
    if (liveMutationBinding?.targetKind === "currentFile") {
      throw new HostOperationError("The active mini-app mutation is limited to its open document.");
    }
    if (resolveArtifactId) {
      const artifactId = await resolveArtifactId(
        { surface: "workspace", path: target.path },
        context,
      );
      if (liveMutationBinding && artifactId !== liveMutationBinding.artifactId) {
        throw new HostOperationError("The active mini-app mutation is limited to its open document.");
      }
      if (artifactId && hasOpenLiveSessionForArtifact(context.userId, artifactId) && !liveMutationBinding) {
        throw new HostOperationError(liveReviewWriteGateFailure());
      }
      return;
    }
    if (liveMutationBinding) {
      throw new HostOperationError("The active mini-app mutation is limited to its open document.");
    }
    const factsResult = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
    if (!factsResult.ok) return;
    const resolution = await resolveWorkspaceArtifact({
      logicalPath: target.path,
      facts: factsResult.facts,
      intent: "mutate",
    });
    if (resolution.ok && resolution.artifact && hasOpenLiveSessionForArtifact(context.userId, resolution.artifact.id)) {
      throw new HostOperationError(liveReviewWriteGateFailure());
    }
    return;
  }

  if (liveMutationBinding?.targetKind === "artifact") {
    throw new HostOperationError("The active mini-app mutation is limited to its open document.");
  }
  if (!resolveCurrentIdentity || !relayRegistry || !context.currentFolder) {
    if (liveMutationBinding) {
      throw new HostOperationError("The active mini-app mutation is limited to its open document.");
    }
    return;
  }
  const relativePath = "relativePath" in target ? target.relativePath : target.path;
  const candidatePath = resolve(context.currentFolder, relativePath);
  if (!isAbsolute(candidatePath)) return;
  const relayHint = resolveFocusedRelayHintForPath({
    path: relativePath,
    zone: "current",
    currentFolder: context.currentFolder,
  });
  const hintOptions = relayHint
    ? {
        relayIdHint: relayHint,
        relayHintMismatchMessage: FOCUSED_RELAY_MISMATCH_MESSAGE,
      }
    : {};
  const selection =
    selectionKind === "office"
      ? resolveLocalOfficeRelay({
          ownerId: context.ownerId,
          mutating: true,
          registry: relayRegistry,
          ...hintOptions,
        })
      : resolveLocalFileRelay({
          command: "write",
          ownerId: context.ownerId,
          registry: relayRegistry,
          ...hintOptions,
        });
  if (!selection.ok) {
    if (liveMutationBinding) {
      throw new HostOperationError("The active mini-app mutation is limited to its open document.");
    }
    return;
  }
  const identity = await resolveCurrentIdentity(
    {
      ownerId: context.ownerId,
      relayId: selection.relayId,
      candidatePath,
    },
    context,
  );
  if (
    liveMutationBinding &&
    (identity === null ||
      liveMutationBinding.relayId !== selection.relayId ||
      liveMutationBinding.canonicalPath !== identity)
  ) {
    throw new HostOperationError("The active mini-app mutation is limited to its open document.");
  }
  if (identity && hasOpenLiveSessionForCurrentFileIdentity(context.userId, selection.relayId, identity) && !liveMutationBinding) {
    throw new HostOperationError(liveReviewWriteGateFailure());
  }
}

function hasOpenLiveSessionForArtifact(userId: string, artifactId: string): boolean {
  return getRegisteredLiveReviewAppIds().some((appId) =>
    liveMiniAppSessionRegistry.hasOpenSessionForArtifact({ appId, userId, artifactId }),
  );
}

function hasOpenLiveSessionForCurrentFileIdentity(
  userId: string,
  relayId: string,
  canonicalTargetIdentity: string,
): boolean {
  return getRegisteredLiveReviewAppIds().some((appId) =>
    liveMiniAppSessionRegistry.hasOpenSessionForCurrentFileIdentity({
      appId,
      userId,
      relayId,
      canonicalTargetIdentity,
    }),
  );
}

function requireStateRead(manifest: MiniAppManifest): string | null {
  if (!accessAllowsRead(stateAccessLevel(manifest))) {
    return capabilityDeniedMessage("read", "state");
  }
  return null;
}

function requireStateWrite(manifest: MiniAppManifest): string | null {
  if (!accessAllowsWrite(stateAccessLevel(manifest))) {
    return capabilityDeniedMessage("write", "state");
  }
  return null;
}

function buildZoneContext(context: AppToolRunnerContext): ZoneContext {
  return {
    workspaceRoot: context.workspacePath ?? "",
    currentFolder: context.currentFolder ?? null,
  };
}

function buildLocalZoneIoContext(
  context: AppToolRunnerContext,
  opts?: {
    turnId?: string;
    appOperationId?: string;
    mutationRequestId?: string;
    approvalObtained?: boolean;
  },
): LocalZoneIoContext {
  const turnId =
    opts?.turnId ?? (typeof context.turnId === "string" && context.turnId.length > 0 ? context.turnId : undefined);
  const appOperationId =
    opts?.appOperationId ??
    (typeof context.appOperationId === "string" && context.appOperationId.length > 0
      ? context.appOperationId
      : undefined);
  return {
    ownerId: context.ownerId,
    agentId: context.agentId,
    ...(turnId ? { turnId } : {}),
    ...(appOperationId && !turnId ? { appOperationId } : {}),
    ...(opts?.mutationRequestId ? { mutationRequestId: opts.mutationRequestId } : {}),
    zoneCtx: buildZoneContext(context),
    approvalObtained: opts?.approvalObtained === true,
  };
}

function createAppLocalMutationRequestId(
  context: AppToolRunnerContext,
  fallbackDispatchId: string,
  operation: string,
  semantics: Readonly<Record<string, unknown>>,
): string {
  const trustedDispatchId =
    typeof context.appOperationId === "string" && context.appOperationId.length > 0
      ? context.appOperationId
      : fallbackDispatchId;
  return createFileMutationRequestId(trustedDispatchId, { operation, ...semantics });
}

function workspaceArtifactCreationActor(
  context: AppToolRunnerContext,
): WorkspaceArtifactCreationActor | null {
  if (context.turnId) {
    return { kind: "agent", agentId: context.agentId };
  }
  if (context.appOperationId) {
    return { kind: "human", userId: context.userId };
  }
  try {
    warn("[app-tool-host] Workspace Artifact creation event suppressed: initiating actor provenance is unavailable");
  } catch {
    // Diagnostics must not fail the underlying Artifact operation.
  }
  return null;
}

function parseDispatchJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function dispatchErrorMessage(raw: string): string {
  if (raw.startsWith("Error:")) return raw.slice("Error:".length).trim();
  const parsed = parseDispatchJson(raw);
  if (parsed && parsed["applied"] === true) return "";
  if (parsed && typeof parsed["message"] === "string") return parsed["message"];
  if (parsed && typeof parsed["summary"] === "string") return parsed["summary"];
  if (parsed && typeof parsed["error"] === "string") return parsed["error"];
  return raw;
}

export function createProductionDocumentOperations(options: {
  appId: string;
  appsRoot: string;
  manifest: MiniAppManifest;
  context: AppToolRunnerContext;
  relayRegistry?: ToolRelayRegistry | null;
  resolveWorkspaceArtifactFn?: typeof resolveWorkspaceArtifact;
  readWorkspaceFile?: (path: string) => Promise<Buffer>;
  workspaceContentCommitExecution?: WorkspaceFileContentCommitExecution;
  getArtifactNamespacesFn?: typeof getArtifactNamespaces;
}): AppDocumentOperations {
  const { appId, appsRoot, manifest, context } = options;
  const resolveWorkspace = options.resolveWorkspaceArtifactFn ?? resolveWorkspaceArtifact;
  const readWorkspaceFile = options.readWorkspaceFile ?? ((path: string) => fsp.readFile(path));
  const readArtifactNamespaces = options.getArtifactNamespacesFn ?? getArtifactNamespaces;
  const rememberedWorkspaceBases = new Map<string, WorkspaceRememberedBase>();
  const workspaceReadsRequired = new Set<string>();

  return {
    async createFromAction(input) {
      const filenameCheck = validateBasenameFilename(input.filename);
      if (!filenameCheck.ok) {
        throw new HostOperationError(filenameCheck.reason);
      }

      const action = (manifest.createActions ?? []).find((entry) => entry.id === input.actionId);
      if (!action) {
        throw new HostOperationError(`Unknown create action: ${input.actionId}`);
      }
      if (!action.targetSurfaces.includes(input.targetSurface)) {
        throw new HostOperationError(
          `Create action "${input.actionId}" does not support surface "${input.targetSurface}".`,
        );
      }

      const templateFile = await readAppSourceFile(appsRoot, appId, action.template.path);
      // Reuse the canonical exclusive-create path. Never send a template through
      // the ordinary overwrite command, even if the filename looked unused.
      const created = await executeCreateDocument({
        surface: input.targetSurface,
        path: filenameCheck.filename,
        content: Buffer.from(templateFile.content, "utf8").toString("base64"),
        encoding: "base64",
        mimeType: action.mimeType,
        overwrite: false,
      }, context, readArtifactNamespaces);
      if (!created.ok) {
        const collision = created.code === "EXISTS" || created.code === "CONFLICT";
        // Host errors already cross the worker boundary as JSON messages. Keep
        // creation failures machine-readable without claiming an uncertain write
        // did not happen or encouraging a blind retry.
        throw new HostOperationError(JSON.stringify({
          ok: false,
          status: "create_failed",
          code: collision ? "destination_exists" : created.code,
          phase: "create",
          message: created.message,
          stateChanged: created.stateChanged ?? (collision ? false : "unknown"),
          retrySafe: false,
          recoveryActions: collision
            ? ["choose_another_filename", "inspect_existing_document"]
            : ["inspect_destination_before_retry"],
        }));
      }
      const target: AppDocumentTarget = input.targetSurface === "workspace"
        ? { surface: "workspace", path: created.artifactPath }
        : { surface: "currentFolder", relativePath: created.artifactPath };
      return {
        target,
        displayPath: created.artifactPath,
        // The server created a document; no client has acknowledged opening it.
        opened: false,
        sha256: created.sha256,
        byteLength: created.byteLength,
        // A replayable Human action is always useful, including when a legacy
        // caller says not to navigate automatically. Creation never navigates.
        ...((input.targetSurface === "workspace" ? created.artifactInternalId : context.currentFolder)
          ? { openInApp: {
          appId,
          appName: manifest.name,
          target: input.targetSurface === "workspace"
            ? { surface: "workspace" as const, path: created.artifactPath,
                artifactInternalId: created.artifactInternalId!, mimeType: action.mimeType,
                sizeBytes: created.byteLength, ...((context.roomId ?? context.memoryAccessEnvelope.roomId)
                  ? { roomId: context.roomId ?? context.memoryAccessEnvelope.roomId } : {}) }
            : { surface: "currentFolder" as const, relativePath: created.artifactPath,
                currentFolderRoot: context.currentFolder! },
        } } : {}),
      };
    },

    async read(target, readOptions) {
      if (target.surface === "workspace") {
        const factsResult = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
        if (!factsResult.ok) throw new HostOperationError(factsResult.reason);
        const resolution = await resolveWorkspace({
          logicalPath: target.path,
          facts: factsResult.facts,
          intent: "read",
        });
        if (!resolution.ok) throw new HostOperationError(resolution.reason);
        if (!resolution.artifact) {
          throw new HostOperationError(`No workspace artifact at "${target.path}".`);
        }

        const bytes = await readWorkspaceFile(resolution.physicalPath);
        if (bytes.byteLength > USER_SAVE_TEXT_LIMIT_BYTES) {
          throw new HostOperationError(
            `Document exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte read limit.`,
          );
        }

        const encoding = readOptions?.encoding ?? "utf8";
        const content = bytes.toString(encoding);
        if (encoding === "utf8") {
          workspaceReadsRequired.delete(target.path);
          rememberedWorkspaceBases.set(target.path, {
            bytes,
            artifactInternalId: resolution.artifact.id,
            baseSha256: sha256Hex(bytes),
            baseRevision: resolution.artifact.revision ?? null,
          });
        }

        return {
          content,
          ...(encoding === "base64" ? { encoding, byteLength: bytes.byteLength } : {}),
          mimeType: resolution.artifact.mimeType ?? null,
          displayPath: resolution.artifact.path,
          baseSha256: sha256Hex(bytes),
          baseRevision: resolution.artifact.revision ?? null,
        };
      }

      if (readOptions?.encoding === "base64") {
        const read = await readLocalZoneBytes(target.relativePath, "current", buildLocalZoneIoContext(context), { requireBinary: true });
        if (!read.ok) throw new HostOperationError(read.error);
        return {
          content: read.bytes.toString("base64"), encoding: "base64",
          byteLength: read.bytes.byteLength, mimeType: null,
          displayPath: target.relativePath, baseSha256: sha256Hex(read.bytes), baseRevision: null,
        };
      }
      const ioCtx = buildLocalZoneIoContext(context);
      const read = await readLocalZoneText(target.relativePath, "current", ioCtx);
      if (!read.ok) {
        throw new HostOperationError(read.error);
      }
      if (read.text.startsWith("Error:")) {
        throw new HostOperationError(dispatchErrorMessage(read.text));
      }
      if (Buffer.byteLength(read.text, "utf8") > USER_SAVE_TEXT_LIMIT_BYTES) {
        throw new HostOperationError(
          `Document exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte read limit.`,
        );
      }

      return {
        content: read.text,
        mimeType: null,
        displayPath: target.relativePath,
        baseSha256: sha256Hex(Buffer.from(read.text, "utf8")),
        baseRevision: null,
      };
    },

    async stat(target) {
      if (target.surface === "workspace") {
        const factsResult = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
        if (!factsResult.ok) throw new HostOperationError(factsResult.reason);
        const resolution = await resolveWorkspace({
          logicalPath: target.path,
          facts: factsResult.facts,
          intent: "read",
        });
        if (!resolution.ok) throw new HostOperationError(resolution.reason);
        if (!resolution.artifact) {
          return {
            exists: false,
            size: null,
            mimeType: null,
            baseSha256: null,
            baseRevision: null,
          };
        }

        let size: number | null = resolution.artifact.size ?? null;
        let baseSha256: string | null = null;
        try {
          const bytes = await readWorkspaceFile(resolution.physicalPath);
          size = bytes.byteLength;
          baseSha256 = sha256Hex(bytes);
        } catch {
          const storagePath = physicalPathFromStorageUri(resolution.artifact.storageUri);
          if (storagePath) {
            try {
              const st = await fsp.stat(storagePath);
              size = st.size;
            } catch {
              /* keep row size */
            }
          }
        }

        return {
          exists: true,
          size,
          mimeType: resolution.artifact.mimeType ?? null,
          baseSha256,
          baseRevision: resolution.artifact.revision ?? null,
        };
      }

      const ioCtx = buildLocalZoneIoContext(context);
      const stat = await queryLocalZoneStat(target.relativePath, "current", ioCtx);
      if (!stat.ok) {
        throw new HostOperationError(stat.error);
      }
      if (!stat.stat.exists) {
        return {
          exists: false,
          size: null,
          mimeType: null,
          baseSha256: null,
          baseRevision: null,
        };
      }

      let baseSha256: string | null = null;
      try {
        const read = await readLocalZoneText(target.relativePath, "current", ioCtx);
        if (read.ok && !read.text.startsWith("Error:")) {
          baseSha256 = sha256Hex(Buffer.from(read.text, "utf8"));
        }
      } catch {
        /* stat-only path */
      }

      return {
        exists: true,
        size: stat.stat.size,
        mimeType: stat.stat.mimeType,
        baseSha256,
        baseRevision: null,
      };
    },

    async write(target, next, opts) {
      if (target.surface === "workspace") {
        if (workspaceReadsRequired.has(target.path)) {
          return { kind: "error", message: "Read the Workspace document again before editing; the previous save included concurrent changes." };
        }
        const factsResult = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
        if (!factsResult.ok) {
          return { kind: "error", message: factsResult.reason };
        }

        const resolution = await resolveWorkspace({
          logicalPath: target.path,
          facts: factsResult.facts,
          intent: "mutate",
        });
        if (!resolution.ok) {
          return { kind: "error", message: resolution.reason };
        }
        if (!resolution.artifact) {
          return { kind: "error", message: `No workspace artifact at "${target.path}".` };
        }

        let remembered = rememberedWorkspaceBases.get(target.path);
        const resolvedRevision = resolution.artifact.revision ?? null;
        if (
          opts?.baseRevision !== undefined &&
          (opts.baseRevision !== resolvedRevision ||
            (remembered !== undefined && opts.baseRevision !== remembered.baseRevision))
        ) {
          return { kind: "conflict", currentSha256: null };
        }
        if (!remembered) {
          try {
            const bytes = await readWorkspaceFile(resolution.physicalPath);
            const currentSha256 = sha256Hex(bytes);
            if (opts?.baseSha256 && opts.baseSha256 !== currentSha256) {
              return { kind: "conflict", currentSha256 };
            }
            remembered = {
              bytes,
              artifactInternalId: resolution.artifact.id,
              baseSha256: currentSha256,
              baseRevision: resolvedRevision,
            };
            rememberedWorkspaceBases.set(target.path, remembered);
          } catch (err) {
            return {
              kind: "error",
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }

        if (
          remembered.artifactInternalId !== resolution.artifact.id ||
          remembered.baseRevision !== resolvedRevision ||
          (opts?.baseSha256 != null && opts.baseSha256 !== remembered.baseSha256)
        ) {
          return { kind: "conflict", currentSha256: null };
        }
        const outputBytes = Buffer.from(next.content, "utf8");
        if (remembered.bytes.equals(outputBytes)) {
          return {
            kind: "saved",
            sha256: remembered.baseSha256,
            ...(remembered.baseRevision !== null ? { revision: remembered.baseRevision } : {}),
            size: outputBytes.byteLength,
          };
        }

        const execution = options.workspaceContentCommitExecution ?? getWorkspaceFileContentCommitExecution();
        const turnCheck = requireLocalMutationTurnId(context.turnId, "document.write", context.appOperationId);
        const roomId = context.roomId ?? context.memoryAccessEnvelope.roomId;
        if (!execution || !turnCheck.ok || !context.agentId || !roomId || remembered.baseRevision === null) {
          return { kind: "error", message: "Workspace document mutation coordinator context is unavailable." };
        }
        const commandArgs = {
          appId,
          path: target.path,
          artifactInternalId: resolution.artifact.id,
          baseSha256: remembered.baseSha256,
          baseRevision: remembered.baseRevision,
          sha256: sha256Hex(outputBytes),
        };
        const request = {
          authority: {
            envelope: context.memoryAccessEnvelope,
            ownerId: context.ownerId,
            agentId: context.agentId,
            roomId,
            turnId: turnCheck.turnId,
          },
          mutationRequestId: createFileMutationRequestId(
            context.toolCallId ?? context.appOperationId ?? turnCheck.turnId,
            { operation: "document.write", ...commandArgs },
          ),
          command: "app_document_write",
          commandArgs,
          source: {
            artifactInternalId: resolution.artifact.id,
            artifactId: resolution.artifact.artifactId,
            logicalPath: target.path,
            revision: remembered.baseRevision,
            bytes: Uint8Array.from(remembered.bytes),
          },
          output: {
            artifactInternalId: resolution.artifact.id,
            artifactId: resolution.artifact.artifactId,
            logicalPath: target.path,
            bytes: Uint8Array.from(outputBytes),
          },
        };
        let result = await execution(request);
        if (!result.ok && result.code === "unknown") {
          const recover = getWorkspaceFileContentRecoveryExecution();
          if (recover) result = await recover({ authority: request.authority, mutationRequestId: request.mutationRequestId, command: request.command });
        }
        if (!result.ok) {
          return result.code === "reapply_required" || result.code === "human_edit_conflict"
            ? { kind: "conflict", currentSha256: null }
            : { kind: "error", message: result.message };
        }
        // Only the immutable commit receipt describes the saved postimage. A
        // coordinator rebase can include Human edits absent from our candidate.
        const committed = result.committed;
        if (!committed || sha256Hex(Buffer.from(committed.bytes)) !== committed.sha256 ||
            committed.bytes.byteLength !== committed.size ||
            (result.artifactInternalId !== undefined && result.artifactInternalId !== resolution.artifact.id)) {
          return { kind: "error", message: "Workspace save completed without a matching document receipt. Read the document again before editing." };
        }
        rememberedWorkspaceBases.delete(target.path);
        if (result.rebased || committed.sha256 !== commandArgs.sha256) workspaceReadsRequired.add(target.path);
        return {
          kind: "saved",
          sha256: committed.sha256,
          revision: committed.revision,
          size: committed.size,
        };
      }

      const turnCheck = requireLocalMutationTurnId(
        context.turnId,
        "document.write",
        context.appOperationId,
      );
      if (!turnCheck.ok) {
        return { kind: "error", message: formatLocalMutationTurnIdError(turnCheck) };
      }

      const ioCtx = buildLocalZoneIoContext(context, {
        ...(turnCheck.source === "agent_turn"
          ? { turnId: turnCheck.turnId }
          : { appOperationId: turnCheck.turnId }),
        mutationRequestId: createAppLocalMutationRequestId(context, turnCheck.turnId, "document.write", {
          path: target.relativePath,
          contentSha256: sha256Hex(Buffer.from(next.content, "utf8")),
          ...(opts?.baseSha256 ? { baseSha256: opts.baseSha256 } : {}),
        }),
        approvalObtained: true,
      });

      const written = await writeLocalZoneText(
        target.relativePath,
        "current",
        next.content,
        ioCtx,
        opts?.baseSha256 ? { expectedSha256: opts.baseSha256 } : undefined,
      );
      if (!written.ok) {
        if (written.code === "stale_sha256") {
          return {
            kind: "conflict",
            currentSha256: written.currentSha256 ?? null,
          };
        }
        return { kind: "error", message: written.error };
      }
      const message = written.resultText;
      if (/^Error\b/.test(message)) {
        return { kind: "error", message: dispatchErrorMessage(message) };
      }

      const localRevisionId = parseLocalWriteRevisionId(message);
      return {
        kind: "saved",
        sha256: sha256Hex(Buffer.from(next.content, "utf8")),
        ...(localRevisionId ? { localRevisionId } : {}),
      };
    },

    async getState(target, key) {
      if (target.surface === "currentFolder") {
        throw new HostOperationError("App state is only supported for workspace artifact documents.");
      }

      const keyCheck = validateStateKey(key);
      if (!keyCheck.ok) throw new HostOperationError(keyCheck.reason);

      const envelope = context.memoryAccessEnvelope;
      const agentId = envelope.agentId;
      if (!agentId) throw new HostOperationError("Agent context required for artifact state.");

      const factsResult = envelopeFactsForArtifacts(envelope);
      if (!factsResult.ok) throw new HostOperationError(factsResult.reason);

      const pathCheck = validateLogicalPath(target.path);
      if (!pathCheck.ok) throw new HostOperationError(pathCheck.reason);

      const resolution = await resolveWorkspace({
        logicalPath: pathCheck.path,
        facts: factsResult.facts,
        intent: "read",
      });
      if (!resolution.ok) throw new HostOperationError(resolution.reason);
      if (!resolution.artifact) {
        throw new HostOperationError(`No workspace artifact at "${target.path}".`);
      }

      const readable = envelopeReadableNamespaces(envelope);
      const storageKey = appStateStorageKey(appId, keyCheck.key);
      const stateRow = await withAgentTrustContext(
        { userId: factsResult.facts.userId, agentId },
        async () =>
          getArtifactStateForNamespaces({
            readableNamespaceIds: readable,
            agentId,
            artifactId: resolution.artifact!.artifactId,
            key: storageKey,
          }),
      );
      if (!stateRow) return undefined;
      return stateRow.value;
    },

    async setState(target, key, value) {
      if (target.surface === "currentFolder") {
        throw new HostOperationError("App state is only supported for workspace artifact documents.");
      }

      const keyCheck = validateStateKey(key);
      if (!keyCheck.ok) throw new HostOperationError(keyCheck.reason);

      const envelope = context.memoryAccessEnvelope;
      const agentId = envelope.agentId;
      if (!agentId) throw new HostOperationError("Agent context required for artifact state.");

      const writable = envelopeWritableNamespaces(envelope);
      if (writable.length === 0) {
        throw new HostOperationError("No writable namespace in this envelope; cannot persist state.");
      }

      const factsResult = envelopeFactsForArtifacts(envelope);
      if (!factsResult.ok) throw new HostOperationError(factsResult.reason);

      const pathCheck = validateLogicalPath(target.path);
      if (!pathCheck.ok) throw new HostOperationError(pathCheck.reason);

      const resolution = await resolveWorkspace({
        logicalPath: pathCheck.path,
        facts: factsResult.facts,
        intent: "read",
      });
      if (!resolution.ok) throw new HostOperationError(resolution.reason);
      if (!resolution.artifact) {
        throw new HostOperationError(`No workspace artifact at "${target.path}".`);
      }

      const readable = envelopeReadableNamespaces(envelope);
      const attached = await getArtifactNamespacesInTrustContext(
        resolution.artifact.id,
        factsResult.facts,
        readArtifactNamespaces,
      );
      const targetNamespace =
        attached.find((namespaceId) => writable.includes(namespaceId)) ??
        attached.find((namespaceId) => readable.includes(namespaceId));
      if (!targetNamespace) {
        throw new HostOperationError("Artifact is not attached to any namespace you can access.");
      }

      const storageKey = appStateStorageKey(appId, keyCheck.key);
      await withAgentTrustContext({ userId: factsResult.facts.userId, agentId }, async () =>
        setArtifactState({
          namespaceId: targetNamespace,
          agentId,
          artifactId: resolution.artifact!.artifactId,
          key: storageKey,
          value,
        }),
      );
    },

  };
}

export class HostOperationError extends Error {
  override readonly name = "HostOperationError";
  readonly directMutationFailure?: AppDirectMutationGateFailure;
  constructor(message: string | AppDirectMutationGateFailure) {
    super(typeof message === "string" ? message : JSON.stringify(message));
    if (typeof message !== "string") this.directMutationFailure = message;
  }
}

const OFFICECLI_REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

async function resolveOfficeImportBinaryPath(): Promise<
  | { ok: true; binaryPath: string }
  | { ok: false; error: string; code: string }
> {
  // D391 2.4 — verify-once integrity gate (cached per process, darwin-tolerant).
  // Replaces the previous per-call `checkOfficeCliProvisioning` re-hash of the
  // ~34MB binary on every import/export invocation.
  const outcome = await verifyOfficeCliOnce({ repoRoot: OFFICECLI_REPO_ROOT });
  if (!outcome.ok) {
    return { ok: false, error: outcome.error, code: outcome.code };
  }
  if (outcome.note !== undefined) {
    warn(`[app-tool-host] officecli: ${outcome.note}`);
  }
  return { ok: true, binaryPath: outcome.binaryPath };
}

// ---------------------------------------------------------------------------
// M205 — generic `office.run` host primitive.
//
// Format-agnostic OfficeCLI runner with zone-aware byte I/O. The server core
// reads/writes bytes and runs the binary but NEVER parses a document format:
// the app worker's mapper supplies OfficeCLI read argv / batch ops, and only
// OfficeCLI JSON / batch-ops cross the worker RPC. Produced office bytes are
// written host-side (workspace artifact store or relay `fs`) and never returned
// to the worker.
// ---------------------------------------------------------------------------

const OFFICE_OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Conservative upper bound on produced office bytes (max of per-format caps). */
const MAX_OFFICE_OUTPUT_BYTES = 200 * 1024 * 1024;

function officeTypeForPath(path: string): "docx" | "xlsx" | "pptx" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".pptx")) return "pptx";
  return null;
}

const OFFICE_MIME_BY_TYPE: Record<"docx" | "xlsx" | "pptx", string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function isOoxmlBuffer(bytes: Buffer): boolean {
  if (bytes.byteLength < OFFICE_OOXML_MAGIC.length) return false;
  for (let i = 0; i < OFFICE_OOXML_MAGIC.length; i++) {
    if (bytes[i] !== OFFICE_OOXML_MAGIC[i]) return false;
  }
  return true;
}

function safeOfficeBasename(path: string, fallbackExt: string): string {
  const base = path.replace(/^\/+/, "").split("/").filter(Boolean).pop() ?? `file${fallbackExt}`;
  const cleaned = base.replace(/[^\w.-]+/g, "_");
  return cleaned.length > 0 ? cleaned : `file${fallbackExt}`;
}

async function dispatchLocalOfficeRunRead(
  input: { path: string },
  readArgv: string[],
  context: AppToolRunnerContext,
): Promise<
  | { ok: true; json: unknown; mediaByRelId?: Record<string, string> }
  | { ok: false; code: string; message: string }
> {
  const parsed = parseOfficeRunReadArgv(readArgv);
  if (!parsed.ok) {
    return { ok: false, code: "INVALID_ARGS", message: parsed.error };
  }
  const zoneCtx = buildZoneContext(context);
  const outcome = await executeLocalOfficeOperation(
    {
      subkind: "officeRun",
      mode: "read",
      inputPath: input.path,
      readSpec: parsed.spec,
      _routing: {
        ownerId: context.ownerId,
        agentId: context.agentId,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.appOperationId ? { appOperationId: context.appOperationId } : {}),
        currentFolder: zoneCtx.currentFolder ?? null,
        workspaceRoot: zoneCtx.workspaceRoot,
      },
    },
    {
      ownerId: context.ownerId,
      agentId: context.agentId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.appOperationId ? { appOperationId: context.appOperationId } : {}),
      zoneCtx,
      approvalObtained: false,
    },
  );
  if (!outcome.ok) {
    return { ok: false, code: "NO_RELAY", message: outcome.error };
  }
  const payload = outcome.result as { json?: unknown; mediaByRelId?: Record<string, string> };
  if (payload?.json === undefined) {
    return { ok: false, code: "OFFICECLI_ENVELOPE_PARSE", message: "local office.run read returned no JSON" };
  }
  return {
    ok: true,
    json: payload.json,
    ...(payload.mediaByRelId ? { mediaByRelId: payload.mediaByRelId } : {}),
  };
}

async function dispatchLocalOfficeRunWrite(
  output: { path: string },
  ops: unknown[],
  imageInputs: AppOfficeRunArgs["imageInputs"],
  officeType: "docx" | "xlsx" | "pptx",
  overwrite: boolean,
  context: AppToolRunnerContext,
): Promise<
  | { ok: true; sha256: string; byteLength: number; displayPath: string; localRevisionId?: string }
  | { ok: false; code: string; message: string }
> {
  const turnCheck = requireLocalMutationTurnId(
    context.turnId,
    "office.run write",
    context.appOperationId,
  );
  if (!turnCheck.ok) {
    return {
      ok: false,
      code: LOCAL_HISTORY_INPUT_REQUIRED,
      message: formatLocalMutationTurnIdError(turnCheck),
    };
  }
  const zoneCtx = buildZoneContext(context);
  const routingTxn =
    turnCheck.source === "agent_turn"
      ? { turnId: turnCheck.turnId }
      : { appOperationId: turnCheck.turnId };
  const mutationRequestId = createAppLocalMutationRequestId(context, turnCheck.turnId, "office.run write", {
    path: output.path,
    officeType,
    overwrite,
    ops,
    ...(imageInputs && imageInputs.length > 0 ? { imageInputs } : {}),
  });
  const outcome = await executeLocalOfficeOperation(
    {
      subkind: "officeRun",
      mode: "write",
      outputPath: output.path,
      ops,
      ...(imageInputs && imageInputs.length > 0 ? { imageInputs } : {}),
      overwrite,
      officeType,
      _routing: {
        ownerId: context.ownerId,
        agentId: context.agentId,
        ...routingTxn,
        mutationRequestId,
        currentFolder: zoneCtx.currentFolder ?? null,
        workspaceRoot: zoneCtx.workspaceRoot,
      },
    },
    {
      ownerId: context.ownerId,
      agentId: context.agentId,
      ...routingTxn,
      mutationRequestId,
      zoneCtx,
      approvalObtained: true,
    },
  );
  if (!outcome.ok) {
    const code = outcome.code === "EXISTS" ? "EXISTS" : "NO_RELAY";
    return { ok: false, code, message: outcome.error };
  }
  const payload = outcome.result as { sha256?: string; byteLength?: number; displayPath?: string };
  if (!payload.sha256 || payload.byteLength === undefined || !payload.displayPath) {
    return { ok: false, code: "WRITE_FAILED", message: "local office.run write returned incomplete metadata" };
  }
  return {
    ok: true,
    sha256: payload.sha256,
    byteLength: payload.byteLength,
    displayPath: payload.displayPath,
  };
}

/** Read raw bytes for an `office.run` input (workspace artifact or relay currentFolder). */
async function readOfficeInputBytes(
  input: { surface: "workspace" | "currentFolder"; path: string },
  context: AppToolRunnerContext,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string; message: string }> {
  if (input.surface === "workspace") {
    const pathCheck = validateWorkspaceLogicalPath(input.path);
    if (!pathCheck.ok) return { ok: false, code: "INVALID_INPUT", message: pathCheck.reason };
    const factsResult = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
    if (!factsResult.ok) return { ok: false, code: "READ_FAILED", message: factsResult.reason };
    const wsResolution = await resolveWorkspaceArtifact({
      logicalPath: pathCheck.path,
      facts: factsResult.facts,
      intent: "read",
    });
    if (!wsResolution.ok) return { ok: false, code: "READ_FAILED", message: wsResolution.reason };
    if (!wsResolution.artifact) {
      return { ok: false, code: "READ_FAILED", message: `No workspace artifact at "${pathCheck.path}".` };
    }
    try {
      return { ok: true, bytes: await fsp.readFile(wsResolution.physicalPath) };
    } catch (err) {
      return { ok: false, code: "READ_FAILED", message: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    ok: false,
    code: "INVALID_INPUT",
    message: "readOfficeInputBytes supports workspace surface only",
  };
}

/** Write produced office bytes to an `office.run` output (workspace artifact only). */
async function writeOfficeOutputBytes(
  output: { surface: "workspace" | "currentFolder"; path: string },
  bytes: Buffer,
  mimeType: string,
  context: AppToolRunnerContext,
  overwrite: boolean,
): Promise<
  | { ok: true; sha256: string; byteLength: number; displayPath: string }
  | { ok: false; code: string; message: string }
> {
  if (output.surface === "workspace") {
    const pathCheck = validateWorkspaceLogicalPath(output.path);
    if (!pathCheck.ok) return { ok: false, code: "INVALID_OUTPUT", message: pathCheck.reason };
    const saved = await createWorkspaceBinaryArtifact({
      envelope: context.memoryAccessEnvelope,
      actor: workspaceArtifactCreationActor(context),
      logicalPath: pathCheck.path,
      bytes,
      mimeType,
      overwrite,
    });
    if (!saved.ok) return { ok: false, code: saved.code, message: saved.message };
    return { ok: true, sha256: saved.sha256, byteLength: saved.size, displayPath: saved.displayPath };
  }

  return {
    ok: false,
    code: "INVALID_OUTPUT",
    message: "writeOfficeOutputBytes supports workspace surface only",
  };
}

/**
 * M205 — create a NEW document from a conversion (import). Writes DIRECTLY
 * (never through the turn-scoped agent patch pipeline, which throws without an
 * agent `turnId`). Format-agnostic — no document-format knowledge lives here.
 *   - `surface: "currentFolder"` → journaled Desktop content commit; create-only
 *     publication unless the caller explicitly requests overwrite.
 *   - `surface: "workspace"` → workspace artifact, optionally colocated in the
 *     source artifact's namespace (`colocateWith`); fails on collision (parity
 *     with the legacy import route's 409).
 */
async function executeCreateDocument(
  args: {
    surface: "workspace" | "currentFolder";
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
    colocateWith?: { surface: "workspace"; path: string };
    overwrite?: boolean;
  },
  context: AppToolRunnerContext,
  readArtifactNamespaces: typeof getArtifactNamespaces = getArtifactNamespaces,
): Promise<AppDocumentCreateDocumentResult> {
  const overwrite = args.overwrite === true;

  // Current Folder writes use the Desktop document coordinator. Create-only
  // commits publish against a missing preimage atomically; no stat/write race.
  if (args.surface === "currentFolder") {
    const turnCheck = requireLocalMutationTurnId(
      context.turnId,
      "createDocument",
      context.appOperationId,
    );
    if (!turnCheck.ok) {
      return {
        ok: false,
        code: LOCAL_HISTORY_INPUT_REQUIRED,
        message: formatLocalMutationTurnIdError(turnCheck),
      };
    }
    const bytes = Buffer.from(args.content, args.encoding ?? "utf8");
    const ioCtx = buildLocalZoneIoContext(context, {
      ...(turnCheck.source === "agent_turn"
        ? { turnId: turnCheck.turnId }
        : { appOperationId: turnCheck.turnId }),
      mutationRequestId: createAppLocalMutationRequestId(context, turnCheck.turnId, "createDocument", {
        ownerId: context.ownerId,
        userId: context.userId,
        agentId: context.agentId,
        roomId: context.roomId ?? context.memoryAccessEnvelope.roomId,
        currentFolder: context.currentFolder ?? null,
        path: args.path,
        contentSha256: sha256Hex(bytes),
        overwrite,
      }),
      approvalObtained: true,
    });
    if (args.encoding === "base64") {
      const written = await writeLocalZoneBytes(args.path, "current", bytes, ioCtx, `Exported ${args.path}`, overwrite ? {} : { expectedSha256: null });
      if (!written.ok) {
        const conflict = written.code === "destination_exists" || written.code === "stale_sha256";
        return {
          ok: false, code: conflict ? "CONFLICT" : "UNCONFIRMED_WRITE",
          message: conflict ? written.error : `The local export was not confirmed. Check the destination before retrying. ${written.error}`,
          ...(conflict ? {} : { retrySafe: false as const }),
        };
      }
      const receipt = JSON.parse(written.resultText) as { sha256?: unknown };
      if (receipt.sha256 !== sha256Hex(bytes)) return {
        ok: false, code: "UNCONFIRMED_WRITE",
        message: "The local write receipt did not confirm the exported bytes. Check the destination before retrying.",
        stateChanged: true, retrySafe: false, metadataConfirmed: false,
      };
      return { ok: true, artifactPath: args.path, sha256: receipt.sha256, byteLength: bytes.byteLength };
    }
    const written = await writeLocalZoneText(args.path, "current", args.content, ioCtx, {
      createOnly: !overwrite,
    });
    if (!written.ok) {
      return { ok: false, code: written.code === "EXISTS" ? "EXISTS" : "WRITE_FAILED", message: written.error };
    }
    return {
      ok: true,
      artifactPath: args.path,
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
    };
  }

  const factsResult = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
  if (!factsResult.ok) {
    return { ok: false, code: "FORBIDDEN", message: factsResult.reason };
  }

  // Colocation: resolve the source artifact and pin the new one to a namespace
  // the source lives in that the caller can also write.
  let namespaceId: string | undefined;
  if (args.encoding === "base64" && args.colocateWith) {
    const sourceResolution = await resolveWorkspaceArtifact({
      logicalPath: args.colocateWith.path,
      facts: factsResult.facts,
      intent: "read",
    });
    if (!sourceResolution.ok) return { ok: false, code: "FORBIDDEN", message: sourceResolution.reason };
    if (!sourceResolution.artifact) return { ok: false, code: "NOT_FOUND", message: "The source document is no longer available for colocation." };
    let sourceNamespaces: string[];
    try {
      sourceNamespaces = await getArtifactNamespacesInTrustContext(
        sourceResolution.artifact.id, factsResult.facts, readArtifactNamespaces,
      );
    } catch {
      return { ok: false, code: "COLOCATION_FAILED", message: "Could not confirm the source document namespace." };
    }
    namespaceId = sourceNamespaces.find(id => factsResult.facts.writableNamespaces.includes(id));
    if (!namespaceId) return { ok: false, code: "FORBIDDEN", message: "No writable namespace is shared with the source document." };
  }
  if (args.encoding !== "base64" && args.colocateWith && args.colocateWith.surface === "workspace") {
    const sourcePathCheck = validateWorkspaceLogicalPath(args.colocateWith.path);
    if (sourcePathCheck.ok) {
      const sourceResolution = await resolveWorkspaceArtifact({
        logicalPath: sourcePathCheck.path,
        facts: factsResult.facts,
        intent: "read",
      });
      if (sourceResolution.ok && sourceResolution.artifact) {
        try {
          const sourceNamespaces = await getArtifactNamespacesInTrustContext(
            sourceResolution.artifact.id, factsResult.facts, readArtifactNamespaces,
          );
          namespaceId = sourceNamespaces.find((id) =>
            factsResult.facts.writableNamespaces.includes(id),
          );
        } catch {
          /* fall back to the default writable namespace below */
        }
      }
    }
  }

  const created = await createWorkspaceBinaryArtifact({
    envelope: context.memoryAccessEnvelope,
    actor: workspaceArtifactCreationActor(context),
    logicalPath: args.path,
    bytes: Buffer.from(args.content, args.encoding ?? "utf8"),
    mimeType: args.mimeType ?? "text/html",
    overwrite,
    ...(namespaceId ? { namespaceId } : {}),
  });
  // The binary writer can confirm that destination bytes changed even when
  // metadata persistence is uncertain. Preserve those facts so callers do
  // not treat an unsafe retry as an ordinary failed create.
  if (!created.ok) return created;
  return {
    ok: true,
    artifactPath: created.displayPath,
    artifactInternalId: created.artifactInternalId,
    artifactId: created.artifactId,
    sha256: created.sha256,
    byteLength: created.size,
  };
}

async function executeCreateRasterDocument(
  args: {
    surface: "workspace";
    path: string;
    svg: string;
    colocateWith?: { surface: "workspace"; path: string };
    overwrite?: boolean;
  },
  context: AppToolRunnerContext,
  resolvedAssets?: ResolvedSvgAssets,
  readArtifactNamespaces: typeof getArtifactNamespaces = getArtifactNamespaces,
): Promise<AppDocumentCreateDocumentResult> {
  const overwrite = args.overwrite === true;
  const factsResult = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
  if (!factsResult.ok) return { ok: false, code: "FORBIDDEN", message: factsResult.reason };

  let namespaceId: string | undefined;
  if (args.colocateWith?.surface === "workspace") {
    const sourcePathCheck = validateWorkspaceLogicalPath(args.colocateWith.path);
    if (sourcePathCheck.ok) {
      const sourceResolution = await resolveWorkspaceArtifact({
        logicalPath: sourcePathCheck.path,
        facts: factsResult.facts,
        intent: "read",
      });
      if (sourceResolution.ok && sourceResolution.artifact) {
        try {
          const sourceNamespaces = await getArtifactNamespacesInTrustContext(
            sourceResolution.artifact.id, factsResult.facts, readArtifactNamespaces,
          );
          namespaceId = sourceNamespaces.find((id) => factsResult.facts.writableNamespaces.includes(id));
        } catch {
          // Match createDocument: fall back to the default writable namespace.
        }
      }
    }
  }

  const raster = await rasterizeResourceFreeSvg(
    resolvedAssets?.svg ?? args.svg,
    resolvedAssets
      ? { isHostResolvedPngDataUrl: (href) => resolvedAssets.approvedPngDataUrls.has(href) }
      : {},
  );
  if (!raster.ok) return raster;

  const created = await createWorkspaceBinaryArtifact({
    envelope: context.memoryAccessEnvelope,
    actor: workspaceArtifactCreationActor(context),
    logicalPath: args.path,
    bytes: raster.bytes,
    mimeType: "image/png",
    overwrite,
    ...(namespaceId ? { namespaceId } : {}),
  });
  if (!created.ok) return created;
  return {
    ok: true,
    artifactPath: created.displayPath,
    sha256: created.sha256,
    byteLength: created.size,
  };
}

async function executeOfficeRun(
  args: AppOfficeRunArgs,
  deps: {
    manifest: MiniAppManifest;
    context: AppToolRunnerContext;
    relayRegistry: ToolRelayRegistry | null;
  },
): Promise<AppOfficeRunResult> {
  if (deps.manifest.capabilities.office !== "convert") {
    throw new HostOperationError(
      'office.run requires manifest capabilities.office "convert".',
    );
  }
  if (!args || typeof args !== "object") {
    return { ok: false, code: "INVALID_ARGS", message: "office.run requires an args object." };
  }

  // --- READ path: input + readArgv → OfficeCLI JSON. ---
  if (args.input) {
    if (!Array.isArray(args.readArgv) || args.readArgv.length === 0) {
      return { ok: false, code: "INVALID_ARGS", message: "office.run read requires a non-empty readArgv." };
    }
    const readArgv = args.readArgv;
    if (!readArgv.every((v) => typeof v === "string")) {
      return { ok: false, code: "INVALID_ARGS", message: "office.run readArgv must be strings." };
    }

    if (args.input.surface === "currentFolder") {
      const localRead = await dispatchLocalOfficeRunRead(args.input, readArgv, deps.context);
      if (!localRead.ok) return localRead;
      return {
        ok: true,
        json: localRead.json,
        ...(localRead.mediaByRelId ? { mediaByRelId: localRead.mediaByRelId } : {}),
      };
    }

    // Validate/read the workspace input BEFORE resolving the OfficeCLI binary.
    // Source errors (missing/unsupported workspace artifact) must surface as
    // READ_FAILED rather than being masked by UNAVAILABLE when the binary is
    // not provisioned. Binary resolution runs only once the input bytes are
    // known-good: currentFolder already returned above before any binary
    // work, and a valid workspace input still resolves the binary and runs
    // OfficeCLI below.
    const read = await readOfficeInputBytes(args.input, deps.context);
    if (!read.ok) return read;
    if (read.bytes.byteLength === 0) {
      return { ok: false, code: "EMPTY_BYTES", message: "Source office file is empty." };
    }

    const binaryResult = await resolveOfficeImportBinaryPath();
    if (!binaryResult.ok) {
      return { ok: false, code: binaryResult.code, message: binaryResult.error };
    }
    const binaryPath = binaryResult.binaryPath;

    const ext = officeTypeForPath(args.input.path);
    const scratchDir = await fsp.mkdtemp(join(tmpdir(), "office-run-read-"));
    const stagedPath = join(scratchDir, safeOfficeBasename(args.input.path, ext ? `.${ext}` : ".bin"));
    try {
      await fsp.writeFile(stagedPath, read.bytes);
      const fullArgv = [readArgv[0]!, stagedPath, ...readArgv.slice(1)];
      const result = await runOfficeCliRaw({ binaryPath, argv: fullArgv });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          code: "OFFICECLI_NON_ZERO_EXIT",
          message: `officecli ${readArgv[0]} exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
        };
      }
      const trimmed = result.stdout.trim();
      if (trimmed.length === 0) {
        return { ok: false, code: "OFFICECLI_ENVELOPE_PARSE", message: "officecli returned empty stdout." };
      }
      let json: unknown;
      try {
        json = JSON.parse(trimmed);
      } catch (err) {
        return {
          ok: false,
          code: "OFFICECLI_ENVELOPE_PARSE",
          message: `officecli stdout was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const ext = officeTypeForPath(args.input.path);
      const mediaByRelId =
        ext === "docx" ? docxMediaMapToDataUrls(extractDocxMediaByRelId(read.bytes)) : undefined;
      return {
        ok: true,
        json,
        ...(mediaByRelId && Object.keys(mediaByRelId).length > 0 ? { mediaByRelId } : {}),
      };
    } finally {
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // --- WRITE path: ops + output → create/batch/close → write bytes host-side. ---
  if (args.output) {
    if (!Array.isArray(args.ops)) {
      return { ok: false, code: "INVALID_ARGS", message: "office.run write requires an ops array." };
    }
    const officeType = officeTypeForPath(args.output.path);
    if (!officeType) {
      return {
        ok: false,
        code: "INVALID_OUTPUT",
        message: "office.run output path must end with .docx, .xlsx, or .pptx.",
      };
    }

    if (args.output.surface === "currentFolder") {
      const localWrite = await dispatchLocalOfficeRunWrite(
        args.output,
        args.ops,
        args.imageInputs,
        officeType,
        args.overwrite === true,
        deps.context,
      );
      if (!localWrite.ok) return localWrite;
      return {
        ok: true,
        sha256: localWrite.sha256,
        byteLength: localWrite.byteLength,
        displayPath: localWrite.displayPath,
      };
    }

    const binaryResult = await resolveOfficeImportBinaryPath();
    if (!binaryResult.ok) {
      return { ok: false, code: binaryResult.code, message: binaryResult.error };
    }
    const binaryPath = binaryResult.binaryPath;

    const ops = args.ops;
    const imageInputs = args.imageInputs;
    const scratchDir = await fsp.mkdtemp(join(tmpdir(), "office-run-write-"));
    const outPath = join(scratchDir, `output.${officeType}`);
    const imageScratch = join(scratchDir, "images");
    await fsp.mkdir(imageScratch, { recursive: true });
    const staged = await stageOfficeRunImageInputs(ops, imageInputs, imageScratch);
    if ("error" in staged) {
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, code: "INVALID_ARGS", message: staged.error };
    }
    try {
      const create = await runOfficeCliRaw({
        binaryPath,
        argv: ["create", outPath, "--type", officeType, "--locale", "en-US", "--force", "--json"],
      });
      if (create.exitCode !== 0) {
        return {
          ok: false,
          code: "OFFICECLI_CREATE_FAILED",
          message: `officecli create failed (${create.exitCode}): ${create.stderr.slice(0, 500)}`,
        };
      }
      if (staged.resolvedOps.length > 0) {
        const batch = await runOfficeCliRaw({
          binaryPath,
          argv: ["batch", outPath, "--commands", JSON.stringify(staged.resolvedOps), "--stop-on-error", "--json"],
        });
        if (batch.exitCode !== 0) {
          return {
            ok: false,
            code: "OFFICECLI_BATCH_FAILED",
            message: `officecli batch failed (${batch.exitCode}): ${batch.stderr.slice(0, 500)}`,
          };
        }
        const failedSummary = extractBatchFailure(batch.stdout);
        if (failedSummary) {
          return { ok: false, code: "OFFICECLI_BATCH_FAILED", message: failedSummary };
        }
      }
      const close = await runOfficeCliRaw({ binaryPath, argv: ["close", outPath, "--json"] });
      if (close.exitCode !== 0) {
        return {
          ok: false,
          code: "OFFICECLI_CLOSE_FAILED",
          message: `officecli close failed (${close.exitCode}): ${close.stderr.slice(0, 500)}`,
        };
      }
      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(outPath);
      } catch (err) {
        return {
          ok: false,
          code: "READ_BACK_FAILED",
          message: `Failed to read produced office file: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!isOoxmlBuffer(bytes)) {
        return {
          ok: false,
          code: "INVALID_OUTPUT_BYTES",
          message: "officecli did not produce a valid OOXML/ZIP office file.",
        };
      }
      if (bytes.byteLength > MAX_OFFICE_OUTPUT_BYTES) {
        return {
          ok: false,
          code: "TOO_LARGE",
          message: `Produced office file is ${bytes.byteLength} bytes; max is ${MAX_OFFICE_OUTPUT_BYTES}.`,
        };
      }
      return writeOfficeOutputBytes(
        args.output,
        bytes,
        OFFICE_MIME_BY_TYPE[officeType],
        deps.context,
        args.overwrite === true,
      );
    } finally {
      await staged.cleanup().catch(() => {});
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    ok: false,
    code: "INVALID_ARGS",
    message: "office.run requires either { input, readArgv } or { ops, output }.",
  };
}

/** Parse an officecli `batch --json` stdout for a failure summary; null if all ops succeeded. */
function extractBatchFailure(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const summary = (parsed as { summary?: unknown }).summary;
  if (!summary || typeof summary !== "object") return null;
  const failed = (summary as { failed?: unknown }).failed;
  if (typeof failed === "number" && failed > 0) {
    return `officecli batch reported ${failed} failed command(s).`;
  }
  return null;
}

type ResourceAppToolHost = ServerNautiloAppHost & {
  assets: ServerNautiloAppHost["assets"] & { read(input: unknown): Promise<unknown> };
  templates: {
    list(args?: { cursor?: unknown }): Promise<unknown>;
    read(args: { templateId: string }): Promise<unknown>;
    save(args: { name: unknown; content: unknown }): Promise<unknown>;
    remove(args: { templateId: string }): Promise<unknown>;
  };
};

class AssetDecodeError extends Error {
  constructor(readonly code: "ASSET_DECODE_FAILED" | "ASSET_DECODE_LIMIT" | "ASSET_DECODE_TIMEOUT", message: string) {
    super(message);
  }
}

export function createAppToolHost(options: CreateAppToolHostOptions): ResourceAppToolHost {
  const { manifest } = options;
  const liveMutationBinding = options.liveMutationBinding;
  const liveMutationBindingMatchesContext =
    !liveMutationBinding ||
    (liveMutationBinding.appId === options.appId && liveMutationBinding.userId === options.context.userId);
  const requireValidLiveMutationBinding = (): void => {
    if (!liveMutationBindingMatchesContext) {
      throw new HostOperationError("The active mini-app session is not valid for this app or user.");
    }
  };
  const relayRegistry = options.relayRegistry ?? getRelayRegistry();
  const documentOps =
    options.documentOps ??
    createProductionDocumentOperations({
      appId: options.appId,
      appsRoot: options.appsRoot,
      manifest,
      context: options.context,
      ...(options.relayRegistry !== undefined ? { relayRegistry: options.relayRegistry } : {}),
      ...(options.getArtifactNamespacesFn ? { getArtifactNamespacesFn: options.getArtifactNamespacesFn } : {}),
    });
  let assetAuthorityPromise: Promise<boolean> | undefined;
  const hasAssetAuthority = (): Promise<boolean> => {
    assetAuthorityPromise ??= manifest.id === options.appId && options.appRoot && options.sourceHash
      ? hasFirstPartyAssetAuthority({
          appId: options.appId,
          appRoot: options.appRoot,
          sourceHash: options.sourceHash,
        })
      : Promise.resolve(false);
    return assetAuthorityPromise;
  };
  const resolveSvgAssets = (svg: string) => resolveMiniAppAssetReferencesInSvg(
    svg,
    (ref) => resolveWorkspaceRasterAsset(
      ref,
      envelopeReadableNamespaces(options.context.memoryAccessEnvelope),
      options.assetDependencies,
    ),
  );
  const templateService = options.slideTemplateService ?? defaultSlideTemplateService;
  const requireSlidesAuthority = async (): Promise<void> => {
    requireValidLiveMutationBinding();
    if (options.appId !== "nautilo-presentation" || !(await hasAssetAuthority())) {
      throw new HostOperationError("This host resource is available only to the verified first-party Slides app.");
    }
  };
  const privateTemplateNamespace = async (): Promise<string> => {
    await requireSlidesAuthority();
    const actorId = options.resolveHumanActorId
      ? await options.resolveHumanActorId(options.context.userId)
      : (await findActorByOwnerId(options.context.userId))?.id ?? null;
    if (!actorId) throw new HostOperationError("The signed-in Human identity is unavailable.");
    const namespaceId = await resolvePrivateSlideTemplateNamespace(
      options.context.userId, actorId, templateService,
    );
    if (!namespaceId) throw new HostOperationError("Your private Workspace is unavailable. Reconnect and try again.");
    return namespaceId;
  };
  const templateRetryId = (namespaceId: string): string | null => {
    const callId = options.context.toolCallId;
    if (!callId) return null;
    const bytes = createHash("sha256").update(JSON.stringify({
      domain: "nautilo.slides.private-template.v1", appId: options.appId,
      userId: options.context.userId, namespaceId, callId,
      turnId: options.context.turnId ?? null,
      taskId: options.context.currentTaskId ?? null,
      taskRunId: options.context.currentTaskRunId ?? null,
    })).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const inspectExactImage = async (bytes: Buffer): Promise<{ mimeType: string; width: number; height: number }> => {
    const remainingSeconds = (): number | undefined => {
      const remainingMs = options.remainingToolTimeMs?.();
      if (remainingMs === undefined) return undefined;
      if (!(remainingMs > 0)) throw new AssetDecodeError("ASSET_DECODE_TIMEOUT", "Image decoding exceeded the app tool deadline.");
      return Math.max(1, Math.ceil(remainingMs / 1_000));
    };
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    const image = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: true,
      limitInputChannels: true,
      unlimited: false,
      sequentialRead: true,
      pages: 1,
    });
    const metadataSeconds = remainingSeconds();
    if (metadataSeconds !== undefined) image.timeout({ seconds: metadataSeconds });
    try {
      metadata = await image.metadata();
    } catch (error) {
      if (error instanceof Error && /pixel limit|channel limit/iu.test(error.message)) {
        throw new AssetDecodeError("ASSET_DECODE_LIMIT", "Image dimensions or channels exceed decoder safety limits. Resize the image or choose a smaller source.");
      }
      if (error instanceof Error && /timeout/iu.test(error.message)) {
        throw new AssetDecodeError("ASSET_DECODE_TIMEOUT", "Image decoding exceeded the app tool deadline.");
      }
      throw new AssetDecodeError("ASSET_DECODE_FAILED", "Image bytes could not be decoded.");
    }
    const format = metadata.format as string | undefined;
    const mimeType = format === "jpeg" ? "image/jpeg"
      : format === "png" ? "image/png"
      : format === "webp" ? "image/webp"
      : format === "gif" ? "image/gif"
      : null;
    if (!mimeType || !metadata.width || !metadata.height) {
      throw new AssetDecodeError("ASSET_DECODE_FAILED", "Asset is not a decodable image.");
    }
    const seconds = remainingSeconds();
    if (seconds !== undefined) image.timeout({ seconds });
    try {
      await image.stats();
    } catch (error) {
      if (error instanceof Error && /timeout/iu.test(error.message)) {
        throw new AssetDecodeError("ASSET_DECODE_TIMEOUT", "Image decoding exceeded the app tool deadline.");
      }
      throw new AssetDecodeError("ASSET_DECODE_FAILED", "Image pixels could not be decoded.");
    }
    remainingSeconds();
    return { mimeType, width: metadata.width, height: metadata.height };
  };

  return {
    assets: {
      async inspect(args) {
        if (!args || typeof args !== "object" || typeof args.artifactId !== "string") {
          throw new HostOperationError("assets.inspect requires { artifactId: string }.");
        }
        if (!(await hasAssetAuthority())) {
          return {
            ok: false,
            code: "FORBIDDEN",
            message: "Raster asset inspection is available only to the verified first-party Design app.",
          };
        }
        return inspectWorkspaceRasterAsset(
          args.artifactId,
          envelopeReadableNamespaces(options.context.memoryAccessEnvelope),
          options.assetDependencies,
        );
      },
      async read(input: unknown) {
        requireValidLiveMutationBinding();
        if (!(await hasAssetAuthority())) {
          return { ok: false, code: "FORBIDDEN", message: "Image reads require a verified first-party visual-authoring app." };
        }
        let bytes: Buffer;
        let displayPath: string;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return { ok: false, code: "INVALID_ASSET_SOURCE", message: "Image source must be one Workspace reference or one document target." };
        }
        const sourceKeys = Object.keys(input);
        const hasRef = Object.hasOwn(input, "ref");
        if (hasRef && (sourceKeys.length !== 1 || sourceKeys[0] !== "ref")) {
          return { ok: false, code: "INVALID_ASSET_SOURCE", message: "Image source is ambiguous; provide either ref or a document target." };
        }
        if (input && typeof input === "object" && typeof (input as { ref?: unknown }).ref === "string") {
          const parsed = parseMiniAppAssetRef((input as { ref: string }).ref);
          if (!parsed) return { ok: false, code: "INVALID_ASSET_REF", message: "Workspace image reference is invalid." };
          const readableNamespaceIds = envelopeReadableNamespaces(options.context.memoryAccessEnvelope);
          const artifact = await (options.assetDependencies?.findArtifact ?? findArtifactByInternalIdForNamespaces)({
            internalId: parsed.artifactId, readableNamespaceIds: [...readableNamespaceIds],
          });
          if (!artifact) return { ok: false, code: "ASSET_NOT_FOUND", message: "Image is missing or is not readable in this Workspace." };
          const physicalPath = physicalPathFromStorageUri(artifact.storageUri);
          if (!physicalPath) return { ok: false, code: "ASSET_BYTES_UNAVAILABLE", message: "Image bytes are unavailable." };
          try { bytes = Buffer.from(await (options.assetDependencies?.readArtifactBytes ?? fsp.readFile)(physicalPath)); }
          catch { return { ok: false, code: "ASSET_BYTES_UNAVAILABLE", message: "Image bytes are unavailable." }; }
          if (sha256Hex(bytes) !== parsed.sha256) return { ok: false, code: "ASSET_CHANGED", message: "Image bytes changed. Relink the image." };
          displayPath = artifact.path;
        } else {
          const validated = validateAppDocumentTarget(input);
          if (!validated.ok) throw new HostOperationError(validated.reason);
          const expectedKeys = validated.target.surface === "workspace"
            ? new Set(["surface", "path"])
            : new Set(["surface", "relativePath"]);
          if (sourceKeys.length !== expectedKeys.size || sourceKeys.some((key) => !expectedKeys.has(key))) {
            return { ok: false, code: "INVALID_ASSET_SOURCE", message: "Image source must contain exactly one document target." };
          }
          const denied = requireDocumentRead(manifest, documentSurfaceForTarget(validated.target));
          if (denied) throw new HostOperationError(denied);
          const read = await documentOps.read(validated.target, { encoding: "base64" });
          bytes = Buffer.from(read.content, "base64");
          displayPath = read.displayPath;
        }
        try {
          const inspected = await inspectExactImage(bytes);
          const base64 = bytes.toString("base64");
          return { ok: true, displayPath, ...inspected, byteLength: bytes.byteLength, sha256: sha256Hex(bytes), dataUrl: `data:${inspected.mimeType};base64,${base64}` };
        } catch (error) {
          return { ok: false, code: error instanceof AssetDecodeError ? error.code : "ASSET_DECODE_FAILED", message: error instanceof Error ? error.message : "Image bytes could not be decoded." };
        }
      },
    },
    templates: {
      async list(args: { cursor?: unknown } = {}) {
        const namespaceId = await privateTemplateNamespace();
        return listPrivateSlideTemplates({ userId: options.context.userId, namespaceId, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}) }, templateService);
      },
      async read(args: { templateId: string }) {
        const namespaceId = await privateTemplateNamespace();
        const result = await readPrivateSlideTemplate(args.templateId, namespaceId, templateService);
        if (!result) throw new HostOperationError("Template not found.");
        return result;
      },
      async save(args: { name: unknown; content: unknown }) {
        const namespaceId = await privateTemplateNamespace();
        const templateId = templateRetryId(namespaceId);
        if (!templateId) return { ok: false, code: "TEMPLATE_RETRY_ID_UNAVAILABLE", phase: "admission", retrySafe: false, stateChanged: false, recoveryActions: ["Start a new tool invocation."], message: "Template save requires a stable host tool-call identity." };
        return savePrivateSlideTemplate({ userId: options.context.userId, namespaceId, templateId, name: args.name, content: args.content }, templateService);
      },
      async remove(args: { templateId: string }) {
        const namespaceId = await privateTemplateNamespace();
        return removePrivateSlideTemplate({ userId: options.context.userId, namespaceId, templateId: args.templateId }, templateService);
      },
    },
    session: {
      async command(input) {
        const extension = getLiveAppSessionExtension(options.appId);
        const trusted = options.context.liveMiniAppSession;
        const invocation = options.invocation;
        const policy = extension && isDirectMutationLiveReviewExtension(extension) ? extension.sessionCommands : undefined;
        if (!policy || !invocation || !policy.toolIds.includes(invocation.toolId) ||
            options.context.currentTaskId || options.context.currentTaskRunId || !trusted || trusted.appId !== options.appId ||
            manifest.liveReview?.enabled !== true || invocation.signal.aborted) {
          return { status: "unavailable", stateChanged: false, retrySafe: false };
        }
        const command = policy.parseCommand(input);
        if (!command) throw new HostOperationError("Invalid live app command.");
        const validated = liveMiniAppSessionRegistry.validateForSubject(trusted.sessionToken, {
          appId: options.appId, userId: options.context.userId, documentVersion: trusted.documentVersion,
        });
        if (!validated.ok) return { status: "unavailable", stateChanged: false, retrySafe: false };
        const result = await liveAppCommandBroker.invoke(validated.sessionId, {
          command, documentVersion: validated.binding.documentVersion, deadline: invocation.deadline,
        }, invocation.signal);
        if (result.status !== "completed") return result;
        return policy.parseResult(result.result) ?? { status: "unknown", stateChanged: "unknown", retrySafe: false };
      },
    },
    document: {
      async createFromAction(actionId, opts) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app mutation cannot create documents.");
        }
        const surface: DocumentSurface =
          opts.targetSurface === "workspace" ? "artifact" : "currentFolder";
        const denied = requireDocumentWrite(manifest, surface);
        if (denied) throw new HostOperationError(denied);

        const filenameCheck = validateBasenameFilename(opts.filename);
        if (!filenameCheck.ok) throw new HostOperationError(filenameCheck.reason);

        const action = (manifest.createActions ?? []).find((entry) => entry.id === actionId);
        if (!action) {
          throw new HostOperationError(`Unknown create action: ${actionId}`);
        }
        if (!action.targetSurfaces.includes(opts.targetSurface)) {
          throw new HostOperationError(
            `Create action "${actionId}" does not support surface "${opts.targetSurface}".`,
          );
        }

        await rejectOpenLiveReviewWrite(
          options.context,
          opts.targetSurface === "workspace"
            ? { surface: "workspace", path: filenameCheck.filename }
            : { surface: "currentFolder", path: filenameCheck.filename },
          relayRegistry,
          options.liveReviewArtifactId,
          options.liveReviewCurrentFileIdentity,
          options.liveMutationBinding,
        );
        return documentOps.createFromAction({ actionId, ...opts });
      },
      async read(targetInput, readOptions) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app session provides canonical document content; targeted reads are unavailable.");
        }
        const validated = validateAppDocumentTarget(targetInput);
        if (!validated.ok) throw new HostOperationError(validated.reason);
        const denied = requireDocumentRead(manifest, documentSurfaceForTarget(validated.target));
        if (denied) throw new HostOperationError(denied);
        if (readOptions !== undefined && (
          !readOptions || typeof readOptions !== "object" || Array.isArray(readOptions)
          || (readOptions.encoding !== undefined && readOptions.encoding !== "utf8" && readOptions.encoding !== "base64")
        )) throw new HostOperationError('Document read encoding must be "utf8" or "base64".');
        return documentOps.read(validated.target, readOptions);
      },
      async stat(targetInput) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app session provides canonical document content; targeted stats are unavailable.");
        }
        const validated = validateAppDocumentTarget(targetInput);
        if (!validated.ok) throw new HostOperationError(validated.reason);
        const denied = requireDocumentRead(manifest, documentSurfaceForTarget(validated.target));
        if (denied) throw new HostOperationError(denied);
        return documentOps.stat(validated.target);
      },
      async write(targetInput, next, opts) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app mutation must use document.writeBound.");
        }
        const validated = validateAppDocumentTarget(targetInput);
        if (!validated.ok) throw new HostOperationError(validated.reason);
        const denied = requireDocumentWrite(manifest, documentSurfaceForTarget(validated.target));
        if (denied) throw new HostOperationError(denied);
        if (!next || typeof next !== "object" || typeof next.content !== "string") {
          throw new HostOperationError("write requires { content: string }.");
        }
        await rejectOpenLiveReviewWrite(
          options.context,
          validated.target,
          relayRegistry,
          options.liveReviewArtifactId,
          options.liveReviewCurrentFileIdentity,
          options.liveMutationBinding,
        );
        return documentOps.write(validated.target, next, opts);
      },
      async writeBound(next, opts) {
        const binding = liveMutationBinding;
        if (!binding) {
          throw new HostOperationError("document.writeBound requires a validated active mini-app session.");
        }
        requireValidLiveMutationBinding();
        if (!next || typeof next !== "object" || typeof next.content !== "string") {
          throw new HostOperationError("writeBound requires { content: string }.");
        }
        const surface = binding.targetKind === "artifact" ? "artifact" : "currentFolder";
        const denied = requireDocumentWrite(manifest, surface);
        if (denied) throw new HostOperationError(denied);

        if (binding.targetKind === "artifact") {
          const artifact = await findArtifactByInternalIdForNamespaces({
            internalId: binding.artifactId,
            readableNamespaceIds: envelopeMutableNamespaces(options.context.memoryAccessEnvelope),
          });
          if (!artifact || artifact.revision !== binding.documentVersion.revision) {
            throw new HostOperationError("The active mini-app document is no longer current.");
          }
          return documentOps.write(
            { surface: "workspace", path: artifact.path },
            next,
            { ...opts, baseRevision: binding.documentVersion.revision },
          );
        }
        await rejectOpenLiveReviewWrite(
          options.context,
          { surface: "currentFolder", path: binding.relativePath },
          relayRegistry,
          options.liveReviewArtifactId,
          options.liveReviewCurrentFileIdentity,
          binding,
        );
        return documentOps.write(
          { surface: "currentFolder", relativePath: binding.relativePath },
          next,
          { ...opts, baseSha256: binding.documentVersion.sha256 },
        );
      },
      async createDocument(args) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app mutation cannot create documents.");
        }
        if (!args || typeof args !== "object" || typeof args.path !== "string") {
          throw new HostOperationError("createDocument requires { surface, path, content }.");
        }
        if (typeof args.content !== "string") {
          throw new HostOperationError("createDocument requires string content.");
        }
        if (args.surface !== "workspace" && args.surface !== "currentFolder") {
          throw new HostOperationError('createDocument requires surface "workspace" or "currentFolder".');
        }
        if (args.encoding !== undefined && args.encoding !== "utf8" && args.encoding !== "base64") {
          throw new HostOperationError('createDocument encoding must be "utf8" or "base64".');
        }
        const denied = requireDocumentWrite(
          manifest,
          args.surface === "workspace" ? "artifact" : "currentFolder",
        );
        if (denied) throw new HostOperationError(denied);
        if (args.encoding === "base64") {
          const target = validateAppDocumentTarget(args.surface === "workspace"
            ? { surface: "workspace", path: args.path }
            : { surface: "currentFolder", relativePath: args.path });
          if (!target.ok) throw new HostOperationError(target.reason);
          if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") {
            throw new HostOperationError("createDocument overwrite must be a boolean.");
          }
          if (args.colocateWith !== undefined) {
            if (!args.colocateWith || args.colocateWith.surface !== "workspace" || typeof args.colocateWith.path !== "string") {
              throw new HostOperationError("createDocument colocateWith must be a workspace target.");
            }
            const sourcePath = validateWorkspaceLogicalPath(args.colocateWith.path);
            if (!sourcePath.ok) throw new HostOperationError(sourcePath.reason);
          }
          if (typeof args.mimeType !== "string" || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(args.mimeType)) {
            throw new HostOperationError("Binary document creation requires an explicit valid mimeType without parameters.");
          }
          if (Buffer.from(args.content, "base64").toString("base64") !== args.content) {
            throw new HostOperationError("Binary document content must be canonical base64.");
          }
        }
        await rejectOpenLiveReviewWrite(
          options.context,
          args,
          relayRegistry,
          options.liveReviewArtifactId,
          options.liveReviewCurrentFileIdentity,
          options.liveMutationBinding,
        );
        let preparedArgs = args;
        const svgContent = args.mimeType === "image/svg+xml" && args.encoding === "base64"
          ? Buffer.from(args.content, "base64").toString("utf8")
          : args.content;
        if (
          args.mimeType === "image/svg+xml" &&
          options.appId === "nautilo-design" &&
          (svgContent.includes("nautilo-asset:") || /<image(?:\s|>)/iu.test(svgContent))
        ) {
          if (!(await hasAssetAuthority())) {
            return {
              ok: false,
              code: "FORBIDDEN_ASSET_REFERENCE",
              message: "SVG image assets require the verified first-party Design app.",
            };
          }
          const resolved = await resolveSvgAssets(svgContent);
          if (!resolved.ok) return resolved;
          preparedArgs = { ...args, content: args.encoding === "base64" ? Buffer.from(resolved.svg, "utf8").toString("base64") : resolved.svg };
        }
        return executeCreateDocument(
          preparedArgs,
          options.context,
          options.getArtifactNamespacesFn ?? getArtifactNamespaces,
        );
      },
      async createRasterFromSvg(args) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app mutation cannot create documents.");
        }
        if (!args || typeof args !== "object" || typeof args.path !== "string") {
          throw new HostOperationError("createRasterFromSvg requires { surface, path, svg, format }.");
        }
        if (typeof args.svg !== "string") {
          throw new HostOperationError("createRasterFromSvg requires string svg.");
        }
        if (args.format !== "png") {
          throw new HostOperationError('createRasterFromSvg requires format "png".');
        }
        if (args.surface !== "workspace" && args.surface !== "currentFolder") {
          throw new HostOperationError(
            'createRasterFromSvg requires surface "workspace" or "currentFolder".',
          );
        }
        if (args.surface === "currentFolder") {
          return {
            ok: false,
            code: "UNSUPPORTED_CURRENT_FOLDER",
            message:
              "PNG export to Current Folder is unavailable until the relay provides atomic create-only binary writes. Export to Workspace instead.",
          };
        }
        const pathCheck = validateWorkspaceLogicalPath(args.path);
        if (!pathCheck.ok) throw new HostOperationError(pathCheck.reason);
        const normalizedPath = pathCheck.path;
        if (!args.path.toLowerCase().endsWith(".png")) {
          throw new HostOperationError('createRasterFromSvg path must end with ".png".');
        }
        if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") {
          throw new HostOperationError("createRasterFromSvg overwrite must be a boolean.");
        }
        if (
          args.colocateWith !== undefined &&
          (!args.colocateWith ||
            typeof args.colocateWith !== "object" ||
            args.colocateWith.surface !== "workspace" ||
            typeof args.colocateWith.path !== "string")
        ) {
          throw new HostOperationError(
            "createRasterFromSvg colocateWith must be a workspace document target.",
          );
        }
        const colocatePathCheck = args.colocateWith
          ? validateWorkspaceLogicalPath(args.colocateWith.path)
          : null;
        if (colocatePathCheck && !colocatePathCheck.ok) {
          throw new HostOperationError(colocatePathCheck.reason);
        }
        const denied = requireDocumentWrite(manifest, "artifact");
        if (denied) throw new HostOperationError(denied);
        await rejectOpenLiveReviewWrite(
          options.context,
          args,
          relayRegistry,
          options.liveReviewArtifactId,
          options.liveReviewCurrentFileIdentity,
          options.liveMutationBinding,
        );
        let resolvedAssets: ResolvedSvgAssets | undefined;
        if (args.svg.includes("nautilo-asset:")) {
          if (!(await hasAssetAuthority())) {
            return {
              ok: false,
              code: "FORBIDDEN_ASSET_REFERENCE",
              message: "PNG image assets require the verified first-party Design app.",
            };
          }
          const resolved = await resolveSvgAssets(args.svg);
          if (!resolved.ok) return resolved;
          resolvedAssets = resolved;
        }
        return executeCreateRasterDocument(
          {
            surface: "workspace",
            path: normalizedPath,
            svg: args.svg,
            ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
            ...(colocatePathCheck?.ok
              ? { colocateWith: { surface: "workspace" as const, path: colocatePathCheck.path } }
              : {}),
          },
          options.context,
          resolvedAssets,
          options.getArtifactNamespacesFn ?? getArtifactNamespaces,
        );
      },
    },
    state: {
      async get(targetInput, key) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app mutation cannot access app state.");
        }
        const validated = validateAppDocumentTarget(targetInput);
        if (!validated.ok) throw new HostOperationError(validated.reason);
        const denied = requireStateRead(manifest);
        if (denied) throw new HostOperationError(denied);
        if (validated.target.surface === "currentFolder") {
          throw new HostOperationError(
            "App state is only supported for workspace artifact documents.",
          );
        }
        const keyCheck = validateStateKey(key);
        if (!keyCheck.ok) throw new HostOperationError(keyCheck.reason);
        return documentOps.getState(validated.target, keyCheck.key);
      },
      async set(targetInput, key, value) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app mutation cannot access app state.");
        }
        const validated = validateAppDocumentTarget(targetInput);
        if (!validated.ok) throw new HostOperationError(validated.reason);
        const denied = requireStateWrite(manifest);
        if (denied) throw new HostOperationError(denied);
        if (validated.target.surface === "currentFolder") {
          throw new HostOperationError(
            "App state is only supported for workspace artifact documents.",
          );
        }
        const keyCheck = validateStateKey(key);
        if (!keyCheck.ok) throw new HostOperationError(keyCheck.reason);
        await documentOps.setState(validated.target, keyCheck.key, value);
      },
    },
    office: {
      async run(args) {
        if (liveMutationBinding) {
          requireValidLiveMutationBinding();
          throw new HostOperationError("The active mini-app mutation cannot use office operations.");
        }
        if (args?.output && args.overwrite === true) {
          await rejectOpenLiveReviewWrite(
            options.context,
            args.output,
            relayRegistry,
            options.liveReviewArtifactId,
            options.liveReviewCurrentFileIdentity,
            options.liveMutationBinding,
            "office",
          );
        }
        return executeOfficeRun(args, {
          manifest,
          context: options.context,
          relayRegistry,
        });
      },
    },
  };
}

export function handleHostRpc(
  host: ServerNautiloAppHost,
  method: string,
  args: unknown[],
): Promise<unknown> {
  switch (method) {
    case "assets.inspect":
      return host.assets.inspect(args[0] as never);
    case "assets.read":
      return (host.assets as unknown as { read(input: unknown): Promise<unknown> }).read(args[0]);
    case "templates.list":
      return (host as unknown as { templates: { list(input?: unknown): Promise<unknown> } }).templates.list(args[0]);
    case "templates.read":
      return (host as unknown as { templates: { read(input: unknown): Promise<unknown> } }).templates.read(args[0]);
    case "templates.save":
      return (host as unknown as { templates: { save(input: unknown): Promise<unknown> } }).templates.save(args[0]);
    case "templates.remove":
      return (host as unknown as { templates: { remove(input: unknown): Promise<unknown> } }).templates.remove(args[0]);
    case "document.createFromAction":
      return host.document.createFromAction(args[0] as string, args[1] as never);
    case "session.command":
      return host.session.command(args[0]);
    case "document.read":
      // JSON arrays encode an explicitly omitted optional argument as null.
      return host.document.read(args[0] as never, (args[1] ?? undefined) as never);
    case "document.stat":
      return host.document.stat(args[0] as never);
    case "document.write":
      return host.document.write(args[0] as never, args[1] as never, args[2] as never);
    case "document.writeBound":
      return host.document.writeBound(args[0] as never, args[1] as never);
    case "document.createDocument":
      return host.document.createDocument(args[0] as never);
    case "document.createRasterFromSvg":
      return host.document.createRasterFromSvg(args[0] as never);
    case "state.get":
      return host.state.get(args[0] as never, args[1] as string);
    case "state.set":
      return host.state.set(args[0] as never, args[1] as string, args[2]);
    case "office.run":
      return host.office.run(args[0] as never);
    default:
      return Promise.reject(new HostOperationError(`Unsupported host RPC method: ${method}`));
  }
}
