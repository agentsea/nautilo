/**
 * D306 — dedicated first-class `convert` tool.
 *
 * Converts inline HTML/Markdown or file/artifact sources to delivered
 * formats. Local backend handles Markdown → PDF/DOCX; CloudConvert
 * (when keyed) handles the broader matrix.
 */

import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getCloudConvertConfig,
  isCloudConvertConfigured,
  convert as cloudConvert,
} from "@nautilo/cloudconvert";
import { getCurrentTurnId, log } from "@nautilo/logger";
import { assertCanUseServerProviderCredentials, ServerProviderCredentialsDeniedError, type MemoryAccessEnvelope } from "@nautilo/trust";
import {
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  validateLogicalPath,
} from "../file/artifact-store";
import {
  applyBinaryContentPatch,
  encodeAppliedResult,
  type CommandResolution,
} from "../file/commands/_shared";
import type { DispatchContext } from "../file/dispatch";
import { assertGeneratedSize, DELIVERED_FORMAT_LIMITS } from "../file/delivered/limits";
import { markdownToDocxBuffer } from "../file/delivered/convert/md-to-docx";
import { markdownToPdfBuffer } from "../file/delivered/convert/md-to-pdf";
import { prepareWorkspaceArtifactTarget } from "../file/workspace-commands";
import { resolveZone, type ZoneContext } from "../file/zones";
import {
  normalizeFormat,
  resolveConvertBackend,
  type ConvertBackend,
} from "./backend-resolver";
import {
  expectedExtensionForFormat,
  inferFormatFromPath,
  pathMatchesOutputFormat,
} from "./format";
import {
  getConversionRuntime,
  type CloudConversionDestinationBinding,
  type CloudConversionExecutionResult,
  type CloudConversionRecoveryRequest,
  type ConversionRuntime,
} from "./conversion-runtime";
import {
  createFileMutationRequestId,
  getWorkspaceFileContentCommitExecution,
  getWorkspaceFileContentRecoveryExecution,
  type WorkspaceFileContentCommitResult,
} from "../file/workspace-runtime-adapter";
import { readLocalZoneBytes, type LocalZoneIoContext } from "../file/local-zone-io";
import {
  executeLocalOfficeOperation,
  localOfficeDispatchErrorText,
} from "../office/local-office-dispatch";
import {
  createToolProviderCostRecorder,
  type ProviderCostRecorder,
} from "../../usage/provider-cost-recorder";
import { getCapabilityFundingSession } from "../../runtime/capability-funding";
import { getUsageContext } from "../../usage/usage-context";

const CLOUD_FORMAT_MATRIX =
  "CloudConvert routes (when connected): HTML → PDF/DOCX/ODT/RTF/PNG/JPG/TXT/MD/EPUB/MOBI/AZW3 and more; " +
  "Office/spreadsheet/presentation ↔ conversions; PDF → XLSX; image/audio/video/archive formats. " +
  "No html→xlsx — use the officecli tool for spreadsheets.";

const LOCAL_DESCRIPTION =
  "Convert documents to delivered formats. Local (keyless) routes: Markdown → PDF or DOCX. " +
  "Provide inline markdown/html or sourcePath+sourceZone, plus format and destinationPath " +
  "(destinationZone defaults to workspace artifacts). " +
  "Set backend to local|cloud|auto (or NAUTILO_CONVERT_BACKEND env).";

function buildConvertToolDescription(cloudConfigured: boolean): string {
  if (!cloudConfigured) {
    return LOCAL_DESCRIPTION;
  }
  return `${LOCAL_DESCRIPTION}\n\n${CLOUD_FORMAT_MATRIX}`;
}

interface ConvertToolContext {
  ownerId: string;
  causalHumanUserId: string;
  currentFolder: string;
  workspacePath: string;
  activeModelId: string;
  agentId: string;
  roomId: string;
  stableToolCallId: string;
  currentTaskId: string;
  currentTaskRunId: string;
  jobId: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
}

export interface ConvertToolDeps {
  isCloudConvertConfigured?: () => boolean;
  cloudConvert?: typeof cloudConvert;
  markdownToPdfBuffer?: typeof markdownToPdfBuffer;
  markdownToDocxBuffer?: typeof markdownToDocxBuffer;
  recordProviderCost?: ProviderCostRecorder;
  assertServerFunding?: typeof assertCanUseServerProviderCredentials;
  conversionRuntime?: ConversionRuntime;
  prepareWorkspaceDestination?: typeof prepareDestination;
}

function contextFromUnknown(ctx: unknown): ConvertToolContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const envRaw = c["memoryAccessEnvelope"];
  const envelope =
    envRaw && typeof envRaw === "object"
      ? (envRaw as MemoryAccessEnvelope)
      : null;
  return {
    ownerId: typeof c["ownerId"] === "string" ? c["ownerId"] : "",
    causalHumanUserId: typeof c["causalHumanUserId"] === "string" ? c["causalHumanUserId"].trim() : "",
    currentFolder: typeof c["currentFolder"] === "string" ? c["currentFolder"] : "",
    workspacePath: typeof c["workspacePath"] === "string" ? c["workspacePath"] : "",
    agentId: typeof c["agentId"] === "string" ? c["agentId"] : "",
    roomId: typeof c["roomId"] === "string" ? c["roomId"] : "",
    stableToolCallId: typeof c["stableToolCallId"] === "string" ? c["stableToolCallId"] : "",
    currentTaskId: typeof c["currentTaskId"] === "string" ? c["currentTaskId"] : "",
    currentTaskRunId: typeof c["currentTaskRunId"] === "string" ? c["currentTaskRunId"] : "",
    jobId: typeof c["jobId"] === "string" ? c["jobId"] : "",
    activeModelId: typeof c["activeModelId"] === "string" ? c["activeModelId"] : "",
    memoryAccessEnvelope: envelope,
  };
}

const convertSchema = z
  .object({
    action: z.enum(["start", "resume", "cancel"]).optional().default("start"),
    recoveryHandle: z.string().regex(/^cvr_[0-9a-f]{32}$/).optional()
      .describe("Opaque handle returned by an interrupted cloud conversion."),
    html: z.string().optional().describe("Inline HTML source (mutually exclusive with markdown/sourcePath)."),
    markdown: z.string().optional().describe("Inline Markdown source (mutually exclusive with html/sourcePath)."),
    sourcePath: z
      .string()
      .optional()
      .describe("Path to an existing file or workspace artifact to convert."),
    sourceZone: z
      .enum(["workspace", "current", "absolute"])
      .optional()
      .describe("Zone for sourcePath (defaults to workspace)."),
    format: z.string().min(1).optional().describe("Output format (e.g. pdf, docx, png)."),
    destinationPath: z.string().min(1).optional().describe("Path for the generated file."),
    destinationZone: z
      .enum(["workspace", "current", "absolute"])
      .optional()
      .default("workspace")
      .describe("Where to write the output (default workspace artifact)."),
    backend: z
      .enum(["local", "cloud", "auto"])
      .optional()
      .describe("Conversion backend override (else NAUTILO_CONVERT_BACKEND env, else local)."),
  })
  .superRefine((val, ctx) => {
    if (val.action === "cancel") {
      if (!val.recoveryHandle) ctx.addIssue({ code: "custom", message: "cancel requires recoveryHandle." });
      return;
    }
    if (!val.format || !val.destinationPath) {
      ctx.addIssue({ code: "custom", message: `${val.action} requires format and destinationPath.` });
    }
    if (val.action === "resume") {
      if (!val.recoveryHandle) ctx.addIssue({ code: "custom", message: "resume requires recoveryHandle." });
      return;
    }
    const hasHtml = typeof val.html === "string";
    const hasMarkdown = typeof val.markdown === "string";
    const hasSourcePath = typeof val.sourcePath === "string" && val.sourcePath.length > 0;
    const sourceCount = [hasHtml, hasMarkdown, hasSourcePath].filter(Boolean).length;
    if (sourceCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one source: html, markdown, or sourcePath.",
      });
    }
  });

type ConvertInput = z.infer<typeof convertSchema>;

type ResolvedSource =
  | { kind: "inline"; inputFormat: string; bytes: Buffer }
  | {
      kind: "file";
      inputFormat: string;
      bytes: Buffer;
      sourcePath: string;
      sourceZone: "workspace" | "current" | "absolute";
      artifactInternalId?: string;
      artifactRevision?: number;
    };

async function readWorkspaceSourceBytes(
  sourcePath: string,
  ctx: DispatchContext,
): Promise<{
  ok: true;
  bytes: Buffer;
  inputFormat: string;
  artifactInternalId: string;
  artifactRevision: number;
} | { ok: false; error: string }> {
  const factsResult = envelopeFactsForArtifacts(ctx.memoryAccessEnvelope);
  if (!factsResult.ok) {
    return { ok: false, error: factsResult.reason };
  }
  const validated = validateLogicalPath(sourcePath);
  if (!validated.ok) return { ok: false, error: validated.reason };
  const inputFormat = inferFormatFromPath(validated.path);
  if (!inputFormat) {
    return { ok: false, error: `Could not infer input format from source path "${validated.path}"` };
  }
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts: factsResult.facts,
    intent: "read",
  });
  if (!resolution.ok) return { ok: false, error: resolution.reason };
  if (!resolution.artifact) {
    return { ok: false, error: `No workspace artifact at "${validated.path}" to convert.` };
  }
  try {
    const bytes = await fsp.readFile(resolution.physicalPath);
    return {
      ok: true,
      bytes,
      inputFormat,
      artifactInternalId: resolution.artifact.id,
      artifactRevision: resolution.artifact.revision,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Error reading source artifact: ${msg}` };
  }
}

async function readFilesystemSourceBytes(
  sourcePath: string,
  sourceZone: "current" | "absolute",
  ioCtx: LocalZoneIoContext,
): Promise<{ ok: true; bytes: Buffer; inputFormat: string } | { ok: false; error: string }> {
  const inputFormat = inferFormatFromPath(sourcePath);
  if (!inputFormat) {
    return { ok: false, error: `Could not infer input format from source path "${sourcePath}"` };
  }
  const read = await readLocalZoneBytes(sourcePath, sourceZone, ioCtx);
  if (!read.ok) return { ok: false, error: read.error };
  return { ok: true, bytes: read.bytes, inputFormat };
}

async function resolveSource(
  input: ConvertInput,
  _zoneCtx: ZoneContext,
  dispatchCtx: DispatchContext,
  ioCtx: LocalZoneIoContext,
): Promise<{ ok: true; source: ResolvedSource } | { ok: false; error: string }> {
  if (typeof input.html === "string") {
    if (input.html.length > DELIVERED_FORMAT_LIMITS.markdownChars) {
      return {
        ok: false,
        error: `Inline HTML is too large (${input.html.length} chars; cap ${DELIVERED_FORMAT_LIMITS.markdownChars})`,
      };
    }
    return {
      ok: true,
      source: {
        kind: "inline",
        inputFormat: "html",
        bytes: Buffer.from(input.html, "utf-8"),
      },
    };
  }

  if (typeof input.markdown === "string") {
    if (input.markdown.length > DELIVERED_FORMAT_LIMITS.markdownChars) {
      return {
        ok: false,
        error: `Inline Markdown is too large (${input.markdown.length} chars; cap ${DELIVERED_FORMAT_LIMITS.markdownChars})`,
      };
    }
    return {
      ok: true,
      source: {
        kind: "inline",
        inputFormat: "md",
        bytes: Buffer.from(input.markdown, "utf-8"),
      },
    };
  }

  const sourcePath = input.sourcePath!;
  const sourceZone = input.sourceZone ?? "workspace";
  if (sourceZone === "workspace") {
    const read = await readWorkspaceSourceBytes(sourcePath, dispatchCtx);
    if (!read.ok) return { ok: false, error: read.error };
    return {
      ok: true,
      source: {
        kind: "file",
        inputFormat: read.inputFormat,
        bytes: read.bytes,
        sourcePath,
        sourceZone,
        artifactInternalId: read.artifactInternalId,
        artifactRevision: read.artifactRevision,
      },
    };
  }

  const read = await readFilesystemSourceBytes(sourcePath, sourceZone, ioCtx);
  if (!read.ok) return { ok: false, error: read.error };
  return {
    ok: true,
    source: {
      kind: "file",
      inputFormat: read.inputFormat,
      bytes: read.bytes,
      sourcePath,
      sourceZone,
    },
  };
}

async function runLocalConversion(
  inputFormat: string,
  outputFormat: string,
  sourceBytes: Buffer,
  deps: ConvertToolDeps,
): Promise<Buffer> {
  const input = normalizeFormat(inputFormat);
  const output = normalizeFormat(outputFormat);
  if (input !== "md") {
    throw new Error(`Local backend only supports Markdown sources (got ${input})`);
  }
  const markdown = sourceBytes.toString("utf-8");
  const toPdf = deps.markdownToPdfBuffer ?? markdownToPdfBuffer;
  const toDocx = deps.markdownToDocxBuffer ?? markdownToDocxBuffer;
  if (output === "pdf") return toPdf(markdown);
  if (output === "docx") return toDocx(markdown);
  throw new Error(`Local backend cannot produce ${output}`);
}

async function runCloudConversion(
  inputFormat: string,
  outputFormat: string,
  sourceBytes: Buffer,
  deps: ConvertToolDeps,
  recordProviderCost: ProviderCostRecorder,
): Promise<Buffer> {
  const convertFn = deps.cloudConvert ?? cloudConvert;
  let providerReceiptObserved = false;
  const result = await convertFn(sourceBytes, inputFormat, outputFormat, {
    onCompleted: async ({ jobId }) => {
      providerReceiptObserved = true;
      await recordProviderCost({
        provider: "cloudconvert",
        operation: "conversion",
        receiptId: jobId,
        evidenceState: "unknown",
      });
    },
  });
  if (!providerReceiptObserved) {
    await recordProviderCost({
      provider: "cloudconvert",
      operation: "conversion",
      evidenceState: "unknown",
    });
  }
  return result;
}

function cloudRegionLabel(): string {
  const region = getCloudConvertConfig().region;
  return region && region.length > 0 ? region : "auto";
}

async function dispatchFullyLocalConvert(args: {
  sourcePath: string;
  sourceZone: "current" | "absolute";
  destinationPath: string;
  destinationZone: "current" | "absolute";
  inputFormat: string;
  outputFormat: string;
  backend: ConvertBackend;
  summary: string;
  ioCtx: LocalZoneIoContext;
}): Promise<{ ok: true; resultText: string } | { ok: false; error: string }> {
  const outcome = await executeLocalOfficeOperation(
    {
      subkind: "convert",
      sourceZone: args.sourceZone,
      sourcePath: args.sourcePath,
      destinationZone: args.destinationZone,
      destinationPath: args.destinationPath,
      inputFormat: normalizeFormat(args.inputFormat),
      outputFormat: normalizeFormat(args.outputFormat),
      backend: "local",
      summary: args.summary,
      _routing: {
        ownerId: args.ioCtx.ownerId,
        agentId: args.ioCtx.agentId,
        ...(args.ioCtx.turnId ? { turnId: args.ioCtx.turnId } : {}),
        currentFolder: args.ioCtx.zoneCtx.currentFolder ?? null,
        workspaceRoot: args.ioCtx.zoneCtx.workspaceRoot,
      },
    },
    {
      ownerId: args.ioCtx.ownerId,
      agentId: args.ioCtx.agentId,
      ...(args.ioCtx.turnId ? { turnId: args.ioCtx.turnId } : {}),
      ...(args.ioCtx.activeModelId ? { activeModelId: args.ioCtx.activeModelId } : {}),
      zoneCtx: args.ioCtx.zoneCtx,
      approvalObtained: args.ioCtx.approvalObtained,
    },
  );
  if (!outcome.ok) return { ok: false, error: localOfficeDispatchErrorText(outcome) };
  if (typeof outcome.result === "string") return { ok: true, resultText: outcome.result };
  return { ok: true, resultText: JSON.stringify(outcome.result) };
}

function isLocalZone(zone: string): zone is "current" | "absolute" {
  return zone === "current" || zone === "absolute";
}

function isFullyLocalFileConvert(input: ConvertInput): input is ConvertInput & {
  sourcePath: string;
  sourceZone: "current" | "absolute";
  destinationZone: "current" | "absolute";
} {
  if (!input.sourcePath || input.sourcePath.length === 0) return false;
  const sourceZone = input.sourceZone ?? "workspace";
  return isLocalZone(sourceZone) && isLocalZone(input.destinationZone);
}

function unsupportedLocalConvertPair(
  source: ResolvedSource | null,
  sourceZone: string | undefined,
  destZone: string,
  backend: ConvertBackend,
  inputFormat: string,
): string | null {
  const localDest = isLocalZone(destZone);
  const localSource =
    source?.kind === "file"
      ? isLocalZone(source.sourceZone)
      : sourceZone !== undefined && isLocalZone(sourceZone);
  const anyLocal = localSource || localDest || (source?.kind === "inline" && localDest);

  if (!anyLocal) return null;

  if (backend === "cloud") {
    return (
      "Error: cloud conversion with local source or destination must not read/write server disk. " +
      "Use workspace artifacts for cloud conversion, or a fully local markdown→pdf/docx file pair."
    );
  }

  if (localDest && !(localSource && source?.kind === "file")) {
    return (
      "Error: local destination conversion requires a local-zone source file in current or absolute. " +
      "Inline or workspace sources with local destinations are not supported."
    );
  }

  if (localSource && !localDest) {
    return (
      "Error: local source conversion requires a local-zone destination in current or absolute."
    );
  }

  if (localSource && !["md"].includes(normalizeFormat(inputFormat))) {
    return (
      `Error: local-file source zone only supports markdown sources for keyless conversion (got ${inputFormat}). ` +
      "Use workspace artifacts for other input formats."
    );
  }

  return null;
}

async function prepareDestination(
  destinationPath: string,
  destinationZone: "workspace" | "current" | "absolute",
  zoneCtx: ZoneContext,
  dispatchCtx: DispatchContext,
): Promise<
  | { ok: true; resolution: CommandResolution; ctx: DispatchContext }
  | { ok: false; error: string; structured?: true }
> {
  if (destinationZone === "workspace") {
    const factsResult = envelopeFactsForArtifacts(dispatchCtx.memoryAccessEnvelope);
    if (!factsResult.ok) return { ok: false, error: factsResult.reason };
    const validated = validateLogicalPath(destinationPath);
    if (!validated.ok) return { ok: false, error: validated.reason };
    const prepared = await prepareWorkspaceArtifactTarget(validated.path, factsResult.facts);
    if (!prepared.ok) {
      return {
        ok: false,
        error: prepared.reason,
        ...(prepared.structured ? { structured: true } : {}),
      };
    }
    let meta = prepared.meta;
    if (meta.mode === "update") {
      const current = await resolveWorkspaceArtifact({
        logicalPath: validated.path,
        facts: factsResult.facts,
        intent: "create_or_update",
      });
      if (!current.ok || !current.artifact || current.artifact.id !== meta.rowId) {
        return { ok: false, error: "Destination artifact changed while conversion was prepared." };
      }
      meta = { ...meta, expectedRevision: current.artifact.revision };
    }
    return {
      ok: true,
      resolution: {
        resolved: prepared.physicalPath,
        resolvedZone: "workspace",
      },
      ctx: { ...dispatchCtx, workspaceArtifactMeta: meta },
    };
  }

  const resolved = resolveZone({ path: destinationPath, zone: destinationZone }, zoneCtx);
  if (!resolved.ok) return { ok: false, error: resolved.reason };
  // Local destinations are written via relay dispatch — never server fsp here.
  return {
    ok: false,
    error:
      "Error: local destination paths must be written through the desktop relay (prepareDestination mis-routed).",
  };
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorityDigest(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate !== null && typeof candidate === "object") return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
    return candidate;
  };
  return sha256(JSON.stringify(canonical(value)));
}

function destinationBinding(
  dest: Extract<Awaited<ReturnType<typeof prepareDestination>>, { ok: true }>,
): CloudConversionDestinationBinding | null {
  const meta = dest.ctx.workspaceArtifactMeta;
  const envelope = dest.ctx.memoryAccessEnvelope;
  if (!meta || !envelope) return null;
  return {
    ...(meta.rowId ? { artifactInternalId: meta.rowId } : {}),
    ...(meta.expectedRevision === undefined ? {} : { revision: meta.expectedRevision }),
    namespaceId: meta.namespaceId,
    pathDigest: sha256(meta.logicalPath),
    authorityDigest: authorityDigest({
      domain: "nautilo/cloud-conversion-destination/v1",
      ownerId: dest.ctx.ownerId,
      agentId: dest.ctx.agentId,
      roomId: dest.ctx.roomId,
      actorId: envelope.actorId,
      namespaceId: meta.namespaceId,
      logicalPathDigest: sha256(meta.logicalPath),
    }),
  };
}

function sourceBinding(
  source: ResolvedSource,
  dispatchCtx: DispatchContext,
): {
  kind: "inline" | "artifact";
  artifactInternalId?: string;
  revision?: number;
  sha256: string;
  authorityDigest: string;
} {
  const sourceSha256 = sha256(source.bytes);
  const isArtifact = source.kind === "file"
    && source.sourceZone === "workspace"
    && source.artifactInternalId !== undefined
    && source.artifactRevision !== undefined;
  return {
    kind: isArtifact ? "artifact" : "inline",
    ...(isArtifact ? {
      artifactInternalId: source.artifactInternalId,
      revision: source.artifactRevision,
    } : {}),
    sha256: sourceSha256,
    authorityDigest: authorityDigest({
      domain: "nautilo/cloud-conversion-source/v1",
      ownerId: dispatchCtx.ownerId,
      agentId: dispatchCtx.agentId,
      roomId: dispatchCtx.roomId,
      actorId: dispatchCtx.memoryAccessEnvelope?.actorId ?? null,
      kind: isArtifact ? "artifact" : "inline",
      artifactInternalId: isArtifact ? source.artifactInternalId : null,
      revision: isArtifact ? source.artifactRevision : null,
      sha256: sourceSha256,
    }),
  };
}

function conversionRecoveryRequest(
  recoveryHandle: string,
  causalHumanUserId: string,
  destination: CloudConversionDestinationBinding,
  signal?: AbortSignal,
): CloudConversionRecoveryRequest {
  return {
    recoveryHandle,
    causalHumanUserId,
    destination,
    maxOutputBytes: DELIVERED_FORMAT_LIMITS.generatedBytes,
    ...(signal ? { signal } : {}),
  };
}

function publicationAuthority(
  dest: Extract<Awaited<ReturnType<typeof prepareDestination>>, { ok: true }>,
) {
  const envelope = dest.ctx.memoryAccessEnvelope;
  if (!envelope || !dest.ctx.agentId || !dest.ctx.roomId || !dest.ctx.turnId) return null;
  return {
    envelope,
    ownerId: dest.ctx.ownerId,
    agentId: dest.ctx.agentId,
    roomId: dest.ctx.roomId,
    turnId: dest.ctx.turnId,
  };
}

async function publishCloudConversion(input: {
  runtime: ConversionRuntime;
  result: Extract<CloudConversionExecutionResult, { status: "ready_to_publish" | "recover_publication" | "published" }>;
  recovery: CloudConversionRecoveryRequest;
  dest: Extract<Awaited<ReturnType<typeof prepareDestination>>, { ok: true }>;
  destinationPath: string;
}): Promise<string> {
  let result = input.result;
  if (result.status === "published") {
    return JSON.stringify({
      applied: true,
      recovered: true,
      zone: "workspace",
      command: "convert",
      artifactId: result.artifactId,
      revisionId: result.revisionId,
      recoveryHandle: result.recoveryHandle,
      summary: "Recovered the already published CloudConvert result.",
    });
  }
  const authority = publicationAuthority(input.dest);
  if (!authority) {
    return `Error: Current Workspace publication authority is unavailable. Resume ${result.recoveryHandle} from the original Room.`;
  }
  const commandArgs = {
    command: "convert",
    destinationPathDigest: input.recovery.destination.pathDigest,
    outputFormat: result.outputFormat,
    backend: "cloud",
  };
  const mutationRequestId = createFileMutationRequestId(result.operationKey, commandArgs);
  if (result.status === "recover_publication") {
    const recover = getWorkspaceFileContentRecoveryExecution();
    if (recover) {
      const recovered = await recover({ authority, mutationRequestId, command: "convert" });
      if (recovered.ok) {
        const artifactId = recovered.artifactId ?? input.dest.ctx.workspaceArtifactMeta?.artifactId;
        if (!artifactId) return `Error: Conversion publication recovered without an Artifact identity. Resume ${result.recoveryHandle}.`;
        await input.runtime.confirmPublication({
          operationKey: result.operationKey,
          artifactId,
          revisionId: recovered.revisionId,
        });
        return JSON.stringify({
          applied: true,
          recovered: true,
          path: input.destinationPath,
          zone: "workspace",
          command: "convert",
          artifactId,
          revisionId: recovered.revisionId,
          recoveryHandle: result.recoveryHandle,
          summary: "Recovered the committed CloudConvert Artifact publication.",
        });
      }
      if (recovered.code === "unknown") {
        return `Error: Artifact publication is still uncertain. Resume ${result.recoveryHandle}; the provider job will not be submitted again.`;
      }
    }
    const resumed = await input.runtime.resumePublication(input.recovery);
    if (resumed.status !== "ready_to_publish") {
      return resumed.status === "error"
        ? `Error: ${resumed.message}`
        : `Error: Conversion publication could not be resumed safely. Resume ${result.recoveryHandle}.`;
    }
    result = resumed;
  }
  const commit = getWorkspaceFileContentCommitExecution();
  const meta = input.dest.ctx.workspaceArtifactMeta;
  if (!commit || !meta) {
    return `Error: Workspace Artifact publication is unavailable. Resume ${result.recoveryHandle}.`;
  }
  let source: Parameters<typeof commit>[0]["source"];
  if (meta.mode === "update") {
    if (!meta.rowId || meta.expectedRevision === undefined) {
      return `Error: Destination revision is unavailable. Resume ${result.recoveryHandle} after reopening the Artifact.`;
    }
    let priorBytes: Buffer;
    try {
      priorBytes = await fsp.readFile(input.dest.resolution.resolved);
    } catch {
      return `Error: Destination bytes are unavailable. Resume ${result.recoveryHandle} after reopening the Artifact.`;
    }
    source = {
      artifactInternalId: meta.rowId,
      artifactId: meta.artifactId,
      logicalPath: meta.logicalPath,
      revision: meta.expectedRevision,
      bytes: priorBytes,
    };
  }
  let committed: WorkspaceFileContentCommitResult;
  try {
    committed = await commit({
      authority,
      mutationRequestId,
      command: "convert",
      commandArgs,
      ...(source ? { source } : {}),
      output: {
        artifactInternalId: meta.rowId ?? meta.artifactId,
        artifactId: meta.artifactId,
        logicalPath: meta.logicalPath,
        bytes: result.bytes,
      },
    });
  } catch {
    return `Error: Artifact publication outcome is uncertain. Resume ${result.recoveryHandle}; the provider job will not be submitted again.`;
  }
  if (!committed.ok) {
    if (committed.code === "unknown") {
      return `Error: Artifact publication outcome is uncertain. Resume ${result.recoveryHandle}; the provider job will not be submitted again.`;
    }
    await input.runtime.failPublication({
      operationKey: result.operationKey,
      failureCode: committed.code === "human_edit_conflict" ? "destination_human_edit_conflict" : "destination_publication_failed",
    });
    return `Error: ${committed.message} The provider conversion was not repeated.`;
  }
  const artifactId = committed.artifactId ?? meta.artifactId;
  await input.runtime.confirmPublication({
    operationKey: result.operationKey,
    artifactId,
    revisionId: committed.revisionId,
  });
  return JSON.stringify({
    applied: true,
    path: input.destinationPath,
    zone: "workspace",
    command: "convert",
    binary: true,
    bytes: result.bytes.byteLength,
    artifactId,
    revisionId: committed.revisionId,
    recoveryHandle: result.recoveryHandle,
    summary: `Published CloudConvert ${result.outputFormat.toUpperCase()} output (${result.bytes.byteLength} bytes).`,
    warnings: ["Bytes were sent to CloudConvert."],
  });
}

function buildCommandArgs(input: ConvertInput, source: ResolvedSource, backend: ConvertBackend): Record<string, unknown> {
  const base: Record<string, unknown> = {
    format: input.format ?? "",
    destinationPath: input.destinationPath ?? "",
    destinationZone: input.destinationZone,
    backend: backend,
  };
  if (source.kind === "inline") {
    if (source.inputFormat === "html") base["html"] = "[inline]";
    else base["markdown"] = "[inline]";
  } else {
    base["sourcePath"] = source.sourcePath;
    base["sourceZone"] = source.sourceZone;
  }
  if (input.backend !== undefined) base["backendPreference"] = input.backend;
  return base;
}

function hasPersonalCapabilityFunding(): boolean {
  const funding = getCapabilityFundingSession();
  return funding !== undefined && funding.parentFundingKind !== "server";
}

export function createConvertTool(context?: unknown, deps: ConvertToolDeps = {}) {
  const toolCtx = contextFromUnknown(context);
  const conversionRuntime = deps.conversionRuntime ?? getConversionRuntime();
  const prepareCloudDestination = deps.prepareWorkspaceDestination ?? prepareDestination;
  const cloudConfigured = conversionRuntime !== undefined
    || (!hasPersonalCapabilityFunding()
      && (deps.isCloudConvertConfigured ?? isCloudConvertConfigured)());
  const recordProviderCost = deps.recordProviderCost ?? createToolProviderCostRecorder(
    context as Record<string, unknown> | undefined,
  );

  return new DynamicStructuredTool({
    name: "convert",
    description: buildConvertToolDescription(cloudConfigured),
    schema: convertSchema,
    func: async (input: ConvertInput, _runManager, config) => {
      if (input.action === "cancel") {
        if (!conversionRuntime || !toolCtx.causalHumanUserId || !input.recoveryHandle) {
          return "Error: Cloud conversion recovery is unavailable.";
        }
        const cancelled = await conversionRuntime.cancel({
          operationKey: input.recoveryHandle,
          causalHumanUserId: toolCtx.causalHumanUserId,
          ...(config?.signal ? { signal: config.signal } : {}),
        });
        if (cancelled.status === "error") {
          return JSON.stringify({
            error: cancelled.code,
            message: cancelled.message,
            retryable: cancelled.retryable,
            uncertainEffect: cancelled.uncertainEffect,
            recoveryHandle: input.recoveryHandle,
          });
        }
        return JSON.stringify(cancelled);
      }
      const outputFormat = normalizeFormat(input.format!);
      const destinationZone = input.destinationZone ?? "workspace";
      const expectedExt = expectedExtensionForFormat(outputFormat);
      if (!pathMatchesOutputFormat(input.destinationPath!, outputFormat)) {
        return `Error: format=${outputFormat} requires destinationPath to end in ${expectedExt}`;
      }

      const zoneCtx: ZoneContext = {
        workspaceRoot: toolCtx.workspacePath,
        currentFolder: toolCtx.currentFolder || null,
      };
      const currentTurnId = getCurrentTurnId();
      const dispatchCtx: DispatchContext = {
        zoneCtx,
        ownerId: toolCtx.ownerId,
        ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
        ...(toolCtx.activeModelId ? { activeModelId: toolCtx.activeModelId } : {}),
        ...(toolCtx.agentId ? { agentId: toolCtx.agentId } : {}),
        ...(toolCtx.roomId ? { roomId: toolCtx.roomId } : {}),
        memoryAccessEnvelope: toolCtx.memoryAccessEnvelope,
        ...(config?.signal ? { signal: config.signal } : {}),
      };

      const ioCtx: LocalZoneIoContext = {
        ownerId: toolCtx.ownerId,
        agentId: toolCtx.agentId,
        ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
        ...(toolCtx.activeModelId ? { activeModelId: toolCtx.activeModelId } : {}),
        zoneCtx,
        approvalObtained: true,
      };

      if (input.action === "resume") {
        if (!conversionRuntime || !input.recoveryHandle || !toolCtx.causalHumanUserId) {
          return "Error: Cloud conversion recovery is unavailable.";
        }
        if (destinationZone !== "workspace") {
          return "Error: Cloud conversion recovery requires the original Workspace Artifact destination.";
        }
        const dest = await prepareCloudDestination(
          input.destinationPath!,
          destinationZone,
          zoneCtx,
          dispatchCtx,
        );
        if (!dest.ok) return dest.structured ? dest.error : `Error: ${dest.error}`;
        const binding = destinationBinding(dest);
        if (!binding) return "Error: Current Workspace destination authority is unavailable.";
        const recovery = conversionRecoveryRequest(
          input.recoveryHandle,
          toolCtx.causalHumanUserId,
          binding,
          dispatchCtx.signal,
        );
        const resumed = await conversionRuntime.resume(recovery);
        if (resumed.status === "error") {
          return JSON.stringify({
            error: resumed.code,
            message: resumed.message,
            retryable: resumed.retryable,
            uncertainEffect: resumed.uncertainEffect,
            recoveryHandle: input.recoveryHandle,
          });
        }
        if (resumed.outputFormat !== outputFormat) {
          return "Error: The requested format does not match the durable conversion receipt.";
        }
        return publishCloudConversion({
          runtime: conversionRuntime,
          result: resumed,
          recovery,
          dest,
          destinationPath: input.destinationPath!,
        });
      }

      if (isFullyLocalFileConvert(input)) {
        const inputFormat = inferFormatFromPath(input.sourcePath);
        if (!inputFormat) {
          return `Error: Could not infer input format from source path "${input.sourcePath}"`;
        }
        const backendResult = resolveConvertBackend({
          explicit: input.backend,
          inputFormat,
          outputFormat,
          isCloudConfigured: () => cloudConfigured,
        });
        if (!backendResult.ok) return `Error: ${backendResult.error}`;
        const { backend } = backendResult;
        const unsupported = unsupportedLocalConvertPair(
          {
            kind: "file",
            inputFormat,
            bytes: Buffer.alloc(0),
            sourcePath: input.sourcePath,
            sourceZone: input.sourceZone,
          },
          input.sourceZone,
          input.destinationZone,
          backend,
          inputFormat,
        );
        if (unsupported) return unsupported;

        const label = outputFormat.toUpperCase();
        const summary = `Applied convert ${input.sourcePath} to ${label} via ${backend} backend on desktop relay — revertable.`;
        log(
          `[convert] relay-local ${inputFormat}→${outputFormat} src=${input.sourcePath} dest=${input.destinationPath}`,
        );
        const relayOutcome = await dispatchFullyLocalConvert({
          sourcePath: input.sourcePath,
          sourceZone: input.sourceZone,
          destinationPath: input.destinationPath!,
          destinationZone: input.destinationZone,
          inputFormat,
          outputFormat,
          backend,
          summary,
          ioCtx,
        });
        if (!relayOutcome.ok) {
          return relayOutcome.error.startsWith("Error:") ? relayOutcome.error : `Error: ${relayOutcome.error}`;
        }
        return relayOutcome.resultText;
      }

      const sourceResult = await resolveSource(input, zoneCtx, dispatchCtx, ioCtx);
      if (!sourceResult.ok) return `Error: ${sourceResult.error}`;
      const { source } = sourceResult;

      const backendResult = resolveConvertBackend({
        explicit: input.backend,
        inputFormat: source.inputFormat,
        outputFormat,
        isCloudConfigured: () => cloudConfigured,
      });
      if (!backendResult.ok) return `Error: ${backendResult.error}`;
      const { backend } = backendResult;

      const sourceZone =
        source.kind === "file" ? source.sourceZone : input.sourceZone;
      const unsupported = unsupportedLocalConvertPair(
        source,
        sourceZone,
        input.destinationZone,
        backend,
        source.inputFormat,
      );
      if (unsupported) return unsupported;
      const personalFunding = hasPersonalCapabilityFunding()
        || getUsageContext()?.funding?.kind === "personal";
      if (backend === "cloud" && !conversionRuntime && personalFunding) {
        return "Error: Personal CloudConvert funding requires the durable conversion runtime. No server credential was used.";
      }

      if (backend === "cloud" && conversionRuntime) {
        if (!toolCtx.causalHumanUserId || !toolCtx.stableToolCallId || !currentTurnId
          || !toolCtx.agentId || !toolCtx.roomId) {
          return "Error: Durable cloud conversion requires trusted Human, Room, turn, and tool-call identity.";
        }
        if (destinationZone !== "workspace") {
          return "Error: Cloud conversion requires a Workspace Artifact destination.";
        }
        const dest = await prepareCloudDestination(
          input.destinationPath!,
          destinationZone,
          zoneCtx,
          dispatchCtx,
        );
        if (!dest.ok) return dest.structured ? dest.error : `Error: ${dest.error}`;
        const destination = destinationBinding(dest);
        if (!destination) return "Error: Current Workspace destination authority is unavailable.";
        const result = await conversionRuntime.execute({
          execution: {
            toolCallId: toolCtx.stableToolCallId,
            turnId: currentTurnId,
            causalHumanUserId: toolCtx.causalHumanUserId,
            roomId: toolCtx.roomId,
            agentId: toolCtx.agentId,
            ...(toolCtx.currentTaskId ? { taskId: toolCtx.currentTaskId } : {}),
            ...(toolCtx.currentTaskRunId ? { runId: toolCtx.currentTaskRunId } : {}),
            ...(toolCtx.jobId ? { jobId: toolCtx.jobId } : {}),
          },
          source: sourceBinding(source, dispatchCtx),
          destination,
          inputFormat: source.inputFormat,
          outputFormat,
          bytes: source.bytes,
          maxOutputBytes: DELIVERED_FORMAT_LIMITS.generatedBytes,
          ...(dispatchCtx.signal ? { signal: dispatchCtx.signal } : {}),
        });
        if (result.status === "error") {
          return JSON.stringify({
            error: result.code,
            message: result.message,
            retryable: result.retryable,
            uncertainEffect: result.uncertainEffect,
            ...(result.recoveryHandle ? { recoveryHandle: result.recoveryHandle } : {}),
          });
        }
        const recovery = conversionRecoveryRequest(
          result.recoveryHandle,
          toolCtx.causalHumanUserId,
          destination,
          dispatchCtx.signal,
        );
        return publishCloudConversion({
          runtime: conversionRuntime,
          result,
          recovery,
          dest,
          destinationPath: input.destinationPath!,
        });
      }

      let generatedBytes: Buffer;
      try {
        if (backend === "cloud") {
          if (!toolCtx.causalHumanUserId) throw new ServerProviderCredentialsDeniedError("", "cloud_conversion");
          await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(
            toolCtx.causalHumanUserId,
            "cloud_conversion",
          );
        }
        generatedBytes =
          backend === "local"
            ? await runLocalConversion(source.inputFormat, outputFormat, source.bytes, deps)
            : await runCloudConversion(source.inputFormat, outputFormat, source.bytes, deps, recordProviderCost);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error converting ${source.inputFormat} → ${outputFormat}: ${msg}`;
      }
      const byteCount = generatedBytes.byteLength;
      const sizeError = assertGeneratedSize(byteCount);
      if (sizeError) return `Error: ${sizeError}`;

      const label = outputFormat.toUpperCase();
      let summary =
        source.kind === "inline"
          ? `Applied convert inline ${source.inputFormat.toUpperCase()} to ${label} (${byteCount} bytes) via ${backend} backend — revertable.`
          : `Applied convert ${source.sourcePath} to ${label} (${byteCount} bytes) via ${backend} backend — revertable.`;
      const warnings: string[] = [`Converted via ${backend} backend.`];
      if (backend === "cloud") {
        const region = cloudRegionLabel();
        summary += ` Bytes were sent to CloudConvert (region: ${region}).`;
        warnings.push(`Bytes were sent to CloudConvert (region: ${region}).`);
      }

      log(
        `[convert] ${backend} ${source.inputFormat}→${outputFormat} dest=${input.destinationPath} zone=${input.destinationZone}`,
      );

      const dest = await prepareDestination(
        input.destinationPath!,
        input.destinationZone,
        zoneCtx,
        dispatchCtx,
      );
      if (!dest.ok) return dest.structured ? dest.error : `Error: ${dest.error}`;

      const envelope = await applyBinaryContentPatch({
        resolution: dest.resolution,
        ctx: dest.ctx,
        command: "convert",
        commandArgs: buildCommandArgs(input, source, backend),
        newBytes: generatedBytes,
        summary,
        bytes: byteCount,
        warnings,
      });
      if ("errorText" in envelope) return envelope.errorText;
      return encodeAppliedResult(envelope);
    },
  });
}
