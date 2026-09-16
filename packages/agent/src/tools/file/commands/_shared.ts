import { createPatch } from "diff";
import type { ToolMessage } from "@langchain/core/messages";
import { mimeFromExtensionOr } from "@nautilo/attachments";
import { deriveAnchoredEdit } from "../anchor";
import type { BlockOp } from "../blocks/types";
import type { FileBackend } from "../backend";
import { getFileBackend, type DispatchContext } from "../dispatch";
import type { FileCommandArgs, FileToolArgs } from "../schema";
import {
  constructPatch,
  sha256Hex,
  type AnchoredEdit,
  type StagedPatch,
  type StructuralOp,
} from "../staged-patches";
import { applyEphemeralPatch } from "./apply-core";
import { getWorkspaceFileContentCommitExecution } from "../workspace-runtime-adapter";
import type { WorkspaceArtifactPatchMeta } from "../artifact-store";

export type CommandResolution = {
  resolved: string;
  resolvedZone: "workspace" | "current" | "absolute";
};

export type { DispatchContext };

export type CommandHandler<C extends FileToolArgs["command"]> = (
  args: FileCommandArgs<C>,
  resolution: CommandResolution,
  ctx: DispatchContext,
) => Promise<C extends "read" ? string | ToolMessage : string>;

export interface StagedResultEnvelope {
  staged: true;
  patchId: string;
  path: string;
  zone: "workspace" | "current" | "absolute";
  command: string;
  stats: { additions: number; deletions: number };
  summary: string;
  unifiedDiff: string;
  binary?: true;
  bytes?: number;
  warnings?: string[];
  diffPreviewOmitted?: true;
  artifactId?: string;
  artifactInternalId?: string;
  structural?: StructuralOp;
  destinationPath?: string;
  blockOps?: BlockOp[];
}

export interface AppliedResultEnvelope {
  applied: true;
  revisionId?: string;
  path: string;
  zone: "workspace" | "current" | "absolute";
  command: string;
  stats: { additions: number; deletions: number };
  summary: string;
  unifiedDiff: string;
  binary?: true;
  bytes?: number;
  warnings?: string[];
  diffPreviewOmitted?: true;
  artifactId?: string;
  artifactInternalId?: string;
  structural?: StructuralOp;
  destinationPath?: string;
  blockOps?: BlockOp[];
}

export type AppliedPatchResult = AppliedResultEnvelope | { errorText: string };

export async function readBytesOrEmpty(
  absPath: string,
  backend: FileBackend,
): Promise<Buffer> {
  try {
    return await backend.readFile(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT") || msg.includes("EISDIR")) {
      return Buffer.alloc(0);
    }
    throw err;
  }
}

export function looksLikeBinary(buf: Buffer, window = 8192): boolean {
  const end = Math.min(buf.byteLength, window);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function buildUnifiedDiff(
  displayPath: string,
  oldBytes: Buffer,
  newBytes: Buffer,
  context = 3,
): string {
  const oldText = oldBytes.toString("utf-8");
  const newText = newBytes.toString("utf-8");
  return createPatch(displayPath, oldText, newText, "", "", { context });
}

function workspaceArtifactEnvelopeExtra(
  ctx: DispatchContext,
  resolvedZone: "workspace" | "current" | "absolute",
): Pick<StagedResultEnvelope, "artifactId" | "artifactInternalId"> | undefined {
  if (resolvedZone !== "workspace" || !ctx.workspaceArtifactMeta) return undefined;
  const m = ctx.workspaceArtifactMeta;
  return {
    artifactId: m.artifactId,
    ...(m.rowId ? { artifactInternalId: m.rowId } : {}),
  };
}

export const DIFF_PREVIEW_MAX_BYTES = 2_000_000;

export function boundDiffPreview(
  unifiedDiff: string,
  summary: string,
): { unifiedDiff: string; summary: string; omitted: boolean } {
  if (unifiedDiff.length <= DIFF_PREVIEW_MAX_BYTES) {
    return { unifiedDiff, summary, omitted: false };
  }
  return {
    unifiedDiff:
      `Inline diff preview omitted — this change is ${unifiedDiff.length} bytes, ` +
      `over the ${DIFF_PREVIEW_MAX_BYTES}-byte preview limit. The full ` +
      `change has been applied exactly as proposed.`,
    summary: `${summary} — large change; inline preview omitted.`,
    omitted: true,
  };
}

/**
 * Immediate-apply helpers return an applied envelope on success or
 * `{ errorText }` for documented apply-core errors; handlers return that
 * string directly to preserve the old tool-result error surface.
 */
export async function applyContentPatch(args: {
  resolution: CommandResolution;
  ctx: DispatchContext;
  command: string;
  commandArgs: Record<string, unknown>;
  newBytes: Buffer;
  summary: string;
  metadataExtra?: Record<string, unknown>;
  anchoredEdit?: AnchoredEdit | null;
  deriveAnchoredEdit?: boolean;
  anchoredScope?: AnchoredEdit["scope"];
}): Promise<AppliedPatchResult> {
  const { resolution, ctx, command, commandArgs, newBytes, summary, metadataExtra } = args;
  const backend = getFileBackend(ctx);
  const turnId = requireTurnId(ctx, command);
  const originalBytes = await readBytesOrEmpty(resolution.resolved, backend);
  const originalSha256 = sha256Hex(originalBytes);
  const unifiedDiff = buildUnifiedDiff(resolution.resolved, originalBytes, newBytes);
  const anchoredEdit = resolveAnchoredEdit(args, originalBytes, newBytes);
  const patch = constructPatch({
    turnId,
    ownerId: ctx.ownerId,
    path: resolution.resolved,
    zone: resolution.resolvedZone,
    zoneCtx: ctx.zoneCtx,
    originalBytes,
    originalSha256,
    newBytes,
    ...(anchoredEdit ? { anchoredEdit } : {}),
    unifiedDiff,
    metadata: buildMetadata(ctx, command, commandArgs, metadataExtra),
  });
  return await applyPatchAndEnvelope(patch, ctx, command, summary, workspaceArtifactEnvelopeExtra(ctx, resolution.resolvedZone));
}

function workspaceArtifactMetaForBinaryPatch(
  ctx: DispatchContext,
): DispatchContext {
  const meta = ctx.workspaceArtifactMeta;
  if (!meta) return ctx;
  const mimeType =
    meta.mimeType && meta.mimeType.length > 0
      ? meta.mimeType
      : mimeFromExtensionOr(meta.logicalPath);
  if (mimeType === meta.mimeType) return ctx;
  return {
    ...ctx,
    workspaceArtifactMeta: { ...meta, mimeType },
  };
}

export async function applyBinaryContentPatch(args: {
  resolution: CommandResolution;
  ctx: DispatchContext;
  command: string;
  commandArgs: Record<string, unknown>;
  newBytes: Buffer;
  summary: string;
  bytes: number;
  warnings?: string[];
}): Promise<AppliedPatchResult> {
  const ctx = workspaceArtifactMetaForBinaryPatch(args.ctx);
  const backend = getFileBackend(ctx);
  const turnId = requireTurnId(ctx, args.command);
  const originalBytes = await readBytesOrEmpty(args.resolution.resolved, backend);
  const originalSha256 = sha256Hex(originalBytes);
  const unifiedDiff =
    `Binary files differ: ${args.resolution.resolved}\n` +
    `Proposed binary payload: ${args.bytes} bytes\n`;
  const patch = constructPatch({
    turnId,
    ownerId: ctx.ownerId,
    path: args.resolution.resolved,
    zone: args.resolution.resolvedZone,
    zoneCtx: ctx.zoneCtx,
    originalBytes,
    originalSha256,
    newBytes: args.newBytes,
    unifiedDiff,
    metadata: {
      ...buildMetadata(ctx, args.command, args.commandArgs),
      binary: true,
      bytes: args.bytes,
      ...(args.warnings ? { warnings: args.warnings } : {}),
    },
  });
  return await applyPatchAndEnvelope(patch, ctx, args.command, args.summary, {
    binary: true,
    bytes: args.bytes,
    ...(args.warnings ? { warnings: args.warnings } : {}),
    ...workspaceArtifactEnvelopeExtra(ctx, args.resolution.resolvedZone),
  });
}

export function encodeAppliedResult(env: AppliedResultEnvelope): string {
  return JSON.stringify(env);
}

function requireTurnId(ctx: DispatchContext, command: string): string {
  const turnId = ctx.turnId;
  if (!turnId) {
    throw new Error(
      `[file:${command}] apply pipeline requires ctx.turnId; dispatch wiring did not propagate it`,
    );
  }
  return turnId;
}

function resolveAnchoredEdit(
  args: {
    anchoredEdit?: AnchoredEdit | null;
    deriveAnchoredEdit?: boolean;
    anchoredScope?: AnchoredEdit["scope"];
  },
  originalBytes: Buffer,
  newBytes: Buffer,
): AnchoredEdit | null {
  return args.anchoredEdit !== undefined
    ? args.anchoredEdit
    : args.deriveAnchoredEdit === true
      ? deriveAnchoredEdit(
          originalBytes.toString("utf-8"),
          newBytes.toString("utf-8"),
          args.anchoredScope,
        )
      : null;
}

function buildMetadata(
  ctx: DispatchContext,
  command: string,
  commandArgs: Record<string, unknown>,
  metadataExtra?: Record<string, unknown>,
): { command: string; args: Record<string, unknown>; [key: string]: unknown } {
  return {
    command,
    args: commandArgs,
    ...(metadataExtra ?? {}),
    ...(ctx.workspaceArtifactMeta ? { workspaceArtifact: ctx.workspaceArtifactMeta } : {}),
  };
}

async function applyPatchAndEnvelope(
  patch: StagedPatch,
  ctx: DispatchContext,
  command: string,
  summary: string,
  extra?: Pick<
    AppliedResultEnvelope,
    "binary" | "bytes" | "warnings" | "artifactId" | "artifactInternalId"
  >,
): Promise<AppliedPatchResult> {
  const outcome = shouldCommitWorkspaceContentThroughCoordinator(patch)
    ? await commitWorkspaceContentPatch(patch, ctx)
    : await applyEphemeralPatch(patch, ctx);
  if (outcome.error) {
    return { errorText: outcome.text };
  }
  const bounded = boundDiffPreview(patch.unifiedDiff, outcome.text || summary);
  // M162 — for workspace artifacts, surface the LOGICAL artifact path
  // (e.g. "artifacts/notes.html") rather than the internal physical
  // storage path (`<artifactsRoot>/<uuid>`). The Revert button templates
  // this into the undo chat message; the workspace undo handler resolves
  // a logical path, so a physical path there would fail to resolve.
  const displayPath = ctx.workspaceArtifactMeta?.logicalPath ?? patch.path;
  const coordinatorArtifactId =
    "artifactId" in outcome && typeof outcome.artifactId === "string"
      ? outcome.artifactId
      : undefined;
  const coordinatorArtifactInternalId =
    "artifactInternalId" in outcome &&
    typeof outcome.artifactInternalId === "string"
      ? outcome.artifactInternalId
      : undefined;
  const artifactId =
    coordinatorArtifactId ?? extra?.artifactId;
  const artifactInternalId =
    coordinatorArtifactInternalId ?? extra?.artifactInternalId;
  const envelope: AppliedResultEnvelope = {
    applied: true,
    ...(outcome.revisionId ? { revisionId: outcome.revisionId } : {}),
    path: displayPath,
    zone: patch.zone,
    command,
    stats: patch.stats,
    summary: bounded.summary,
    unifiedDiff: bounded.unifiedDiff,
    ...(bounded.omitted ? { diffPreviewOmitted: true as const } : {}),
    ...(extra?.binary ? { binary: extra.binary } : {}),
    ...(typeof extra?.bytes === "number" ? { bytes: extra.bytes } : {}),
    ...(extra?.warnings ? { warnings: extra.warnings } : {}),
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(artifactInternalId === undefined ? {} : { artifactInternalId }),
  };
  addStructuralEnvelopeFields(envelope, patch);
  return envelope;
}

const WORKSPACE_COORDINATOR_CONTENT_COMMANDS = new Set([
  "write",
  "insert",
  "str_replace",
  "replace_block",
  "insert_block",
  "move_block",
  "rewrite_block",
]);

function shouldCommitWorkspaceContentThroughCoordinator(patch: StagedPatch): boolean {
  return (
    patch.zone === "workspace" &&
    patch.structural === undefined &&
    patch.metadata["binary"] !== true &&
    WORKSPACE_COORDINATOR_CONTENT_COMMANDS.has(patch.metadata.command)
  );
}

async function commitWorkspaceContentPatch(
  patch: StagedPatch,
  ctx: DispatchContext,
): Promise<{
  text: string;
  revisionId?: string;
  artifactId?: string;
  artifactInternalId?: string;
  error?: boolean;
}> {
  const execution = getWorkspaceFileContentCommitExecution();
  if (execution === undefined) {
    return {
      text: "Error: Workspace file mutation coordinator is unavailable.",
      error: true,
    };
  }
  const rawMeta = patch.metadata["workspaceArtifact"];
  const meta =
    rawMeta !== null && typeof rawMeta === "object"
      ? (rawMeta as WorkspaceArtifactPatchMeta)
      : null;
  const envelope = ctx.memoryAccessEnvelope;
  const agentId = ctx.agentId;
  const roomId = ctx.roomId;
  if (
    meta === null ||
    (meta.mode !== "create" && meta.mode !== "update") ||
    envelope === null ||
    envelope === undefined ||
    !agentId ||
    !roomId ||
    !ctx.turnId ||
    !ctx.mutationRequestId
  ) {
    return {
      text: "Error: Workspace file mutation coordinator context is unavailable.",
      error: true,
    };
  }
  if (
    meta.mode === "update" &&
    (!meta.rowId || meta.expectedRevision === undefined)
  ) {
    return {
      text: "Error: Workspace file mutation source version is unavailable.",
      error: true,
    };
  }

  const result = await execution({
    authority: {
      envelope,
      ownerId: ctx.ownerId,
      agentId,
      roomId,
      turnId: ctx.turnId,
    },
    mutationRequestId: ctx.mutationRequestId,
    command: patch.metadata.command,
    commandArgs: patch.metadata.args,
    ...(meta.mode === "update"
      ? {
          source: {
            artifactInternalId: meta.rowId!,
            artifactId: meta.artifactId,
            logicalPath: meta.logicalPath,
            revision: meta.expectedRevision!,
            bytes: Uint8Array.from(patch.originalBytes),
          },
        }
      : {}),
    output: {
      artifactInternalId: meta.rowId ?? meta.artifactId,
      artifactId: meta.artifactId,
      logicalPath: meta.logicalPath,
      bytes: Uint8Array.from(patch.newBytes),
    },
    ...(patch.anchoredEdit === undefined
      ? {}
      : { anchoredEdit: patch.anchoredEdit }),
  });
  if (!result.ok) {
    if (result.code === "unknown" && result.mutationRequestId) {
      return {
        text: JSON.stringify({
          error: "unknown",
          code: "unknown",
          message: result.message,
          retryable: true,
          mutationRequestId: result.mutationRequestId,
        }),
        error: true,
      };
    }
    const text =
      result.code === "human_edit_conflict"
        ? "Error: a human edit conflicts with this Workspace file mutation. Re-read the document and reapply the edit."
        : result.code === "reapply_required"
          ? "Error: the Workspace artifact changed before this mutation committed. Re-read the document and reapply the edit."
          : result.message;
    return { text, error: true };
  }
  return {
    text: `Applied ${patch.metadata.command} to ${meta.logicalPath} (${patch.newBytes.byteLength} bytes, +${patch.stats.additions}/-${patch.stats.deletions}).`,
    revisionId: result.revisionId,
    ...(result.artifactId === undefined
      ? {}
      : { artifactId: result.artifactId }),
    ...(result.artifactInternalId === undefined
      ? {}
      : { artifactInternalId: result.artifactInternalId }),
    error: false,
  };
}

function addStructuralEnvelopeFields(
  envelope: StagedResultEnvelope | AppliedResultEnvelope,
  patch: StagedPatch,
): void {
  if (patch.structural) {
    envelope.structural = patch.structural;
    if (patch.structural.kind === "move" || patch.structural.kind === "copy") {
      envelope.destinationPath = patch.path;
    }
  }
}
