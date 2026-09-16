/**
 * D306 — dedicated first-class `convert` tool.
 *
 * Converts inline HTML/Markdown or file/artifact sources to delivered
 * formats. Local backend handles Markdown → PDF/DOCX; CloudConvert
 * (when keyed) handles the broader matrix.
 */

import * as fsp from "node:fs/promises";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getCloudConvertConfig,
  isCloudConvertConfigured,
  convert as cloudConvert,
} from "@nautilo/cloudconvert";
import { getCurrentTurnId, log } from "@nautilo/logger";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
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
import { readLocalZoneBytes, type LocalZoneIoContext } from "../file/local-zone-io";
import {
  executeLocalOfficeOperation,
  localOfficeDispatchErrorText,
} from "../office/local-office-dispatch";
import {
  createToolProviderCostRecorder,
  type ProviderCostRecorder,
} from "../../usage/provider-cost-recorder";

const CLOUD_FORMAT_MATRIX =
  "CloudConvert routes (when CLOUDCONVERT_API_KEY is set): HTML → PDF/DOCX/ODT/RTF/PNG/JPG/TXT/MD/EPUB/MOBI/AZW3 and more; " +
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
  currentFolder: string;
  workspacePath: string;
  activeModelId: string;
  agentId: string;
  roomId: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
}

export interface ConvertToolDeps {
  isCloudConvertConfigured?: () => boolean;
  cloudConvert?: typeof cloudConvert;
  markdownToPdfBuffer?: typeof markdownToPdfBuffer;
  markdownToDocxBuffer?: typeof markdownToDocxBuffer;
  recordProviderCost?: ProviderCostRecorder;
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
    currentFolder: typeof c["currentFolder"] === "string" ? c["currentFolder"] : "",
    workspacePath: typeof c["workspacePath"] === "string" ? c["workspacePath"] : "",
    agentId: typeof c["agentId"] === "string" ? c["agentId"] : "",
    roomId: typeof c["roomId"] === "string" ? c["roomId"] : "",
    activeModelId: typeof c["activeModelId"] === "string" ? c["activeModelId"] : "",
    memoryAccessEnvelope: envelope,
  };
}

const convertSchema = z
  .object({
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
    format: z.string().min(1).describe("Output format (e.g. pdf, docx, png)."),
    destinationPath: z.string().min(1).describe("Path for the generated file."),
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
  | { kind: "file"; inputFormat: string; bytes: Buffer; sourcePath: string; sourceZone: "workspace" | "current" | "absolute" };

async function readWorkspaceSourceBytes(
  sourcePath: string,
  ctx: DispatchContext,
): Promise<{ ok: true; bytes: Buffer; inputFormat: string } | { ok: false; error: string }> {
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
    return { ok: true, bytes, inputFormat };
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
    return {
      ok: true,
      resolution: {
        resolved: prepared.physicalPath,
        resolvedZone: "workspace",
      },
      ctx: { ...dispatchCtx, workspaceArtifactMeta: prepared.meta },
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

function buildCommandArgs(input: ConvertInput, source: ResolvedSource, backend: ConvertBackend): Record<string, unknown> {
  const base: Record<string, unknown> = {
    format: input.format,
    destinationPath: input.destinationPath,
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

export function createConvertTool(context?: unknown, deps: ConvertToolDeps = {}) {
  const toolCtx = contextFromUnknown(context);
  const cloudConfigured = (deps.isCloudConvertConfigured ?? isCloudConvertConfigured)();
  const recordProviderCost = deps.recordProviderCost ?? createToolProviderCostRecorder(
    context as Record<string, unknown> | undefined,
  );

  return new DynamicStructuredTool({
    name: "convert",
    description: buildConvertToolDescription(cloudConfigured),
    schema: convertSchema,
    func: async (input: ConvertInput) => {
      const outputFormat = normalizeFormat(input.format);
      const expectedExt = expectedExtensionForFormat(outputFormat);
      if (!pathMatchesOutputFormat(input.destinationPath, outputFormat)) {
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
      };

      const ioCtx: LocalZoneIoContext = {
        ownerId: toolCtx.ownerId,
        agentId: toolCtx.agentId,
        ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
        ...(toolCtx.activeModelId ? { activeModelId: toolCtx.activeModelId } : {}),
        zoneCtx,
        approvalObtained: true,
      };

      if (isFullyLocalFileConvert(input)) {
        const inputFormat = inferFormatFromPath(input.sourcePath);
        if (!inputFormat) {
          return `Error: Could not infer input format from source path "${input.sourcePath}"`;
        }
        const backendResult = resolveConvertBackend({
          explicit: input.backend,
          inputFormat,
          outputFormat,
          isCloudConfigured: deps.isCloudConvertConfigured ?? isCloudConvertConfigured,
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
          destinationPath: input.destinationPath,
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
        isCloudConfigured: deps.isCloudConvertConfigured ?? isCloudConvertConfigured,
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

      let generatedBytes: Buffer;
      try {
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
        input.destinationPath,
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
