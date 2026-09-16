import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  buildAddArgv,
  buildAddPartArgv,
  buildBatchArgv,
  buildCloseArgv,
  buildDumpArgv,
  buildGetArgv,
  buildHelpArgv,
  buildMergeArgv,
  buildMoveArgv,
  buildOpenArgv,
  buildQueryArgv,
  buildRawArgv,
  buildRawSetArgv,
  buildRefreshArgv,
  buildRemoveArgv,
  buildSaveArgv,
  buildSetArgv,
  buildSwapArgv,
  buildValidateArgv,
  buildViewArgv,
  formatOfficeHelpFailure,
  generateOffice,
  makeOfficeCreateRun,
  OFFICECLI_CREATE_DATA_ERROR,
  OFFICE_HELP_FORMAT_ERROR,
  renderOffice,
  resolveVendoredOfficeCliOrNull,
  resolveOfficeHelpFormat,
  type OfficeBatchCommand,
  type OfficeCliRunResult,
  type OfficeCreateRunFn,
  type OfficeDocType,
  type RawSetAction,
} from "@nautilo/config/officecli";
import { mimeFromExtensionOr } from "@nautilo/attachments";
import { readImagePixelSize } from "@nautilo/loffice";
import { getCurrentTurnId } from "@nautilo/logger";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { ActiveMiniAppRequestContext } from "@nautilo/types";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, dirname, join, resolve as pathResolve } from "node:path";
import { z } from "zod";
import { getArtifactZone } from "../artifacts/storage-registry";
import { LocalFileBackend } from "../file/backend";
import type { ToolRelayRegistry } from "../../nodes/tools";
import {
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  validateLogicalPath,
  type EnvelopeFacts,
  type WorkspaceArtifactPatchMeta,
} from "../file/artifact-store";
import { applyBinaryContentPatch, encodeAppliedResult, type CommandResolution, type DispatchContext } from "../file/commands/_shared";
import { computeImagePlacementRect } from "./office";
import { assertGeneratedSizeForFormat } from "../file/delivered/limits";
import type { OfficeSessionManager } from "./session-manager";
import { getOfficeSessionManager } from "./session-manager";
import {
  executeLocalOfficeOperation,
  localOfficeDispatchErrorText,
  type LocalOfficeDispatchContext,
} from "./local-office-dispatch";
import {
  getWorkspaceOfficeCliCommitExecution,
  type WorkspaceOfficeCliCommitExecution,
  type WorkspaceOfficeCliSnapshot,
} from "./workspace-runtime-adapter";

type OfficeCliCommand =
  | "create"
  | "view"
  | "get"
  | "query"
  | "set"
  | "add"
  | "remove"
  | "move"
  | "swap"
  | "validate"
  | "dump"
  | "merge"
  | "batch"
  | "raw"
  | "raw_set"
  | "add_part"
  | "open"
  | "save"
  | "close"
  | "refresh"
  | "help";

const OFFICECLI_COMMANDS = [
  "create",
  "view",
  "get",
  "query",
  "set",
  "add",
  "remove",
  "move",
  "swap",
  "validate",
  "dump",
  "merge",
  "batch",
  "raw",
  "raw_set",
  "add_part",
  "open",
  "save",
  "close",
  "refresh",
  "help",
] as const;

const READ_ONLY_COMMANDS = new Set<OfficeCliCommand>([
  "view",
  "get",
  "query",
  "validate",
  "dump",
  "raw",
  "help",
]);

const VIEW_MODES = [
  "text",
  "annotated",
  "outline",
  "stats",
  "issues",
  "html",
  "svg",
  "screenshot",
  "pdf",
  "forms",
] as const;

const RAW_SET_ACTIONS = [
  "append",
  "prepend",
  "insertbefore",
  "insertafter",
  "replace",
  "remove",
  "setattr",
] as const;

const OFFICECLI_IMAGE_SOURCES = ["workspace", "fs"] as const;
const OFFICECLI_IMAGE_ANCHORS = [
  "center",
  "top-left",
  "top",
  "top-right",
  "left",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/svg+xml"]);
const MAX_OFFICECLI_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_SLIDE_SIZE_CM = { w: 25.4, h: 19.05 };

const OfficeCliImageInputSchema = z.object({
  source: z.enum(OFFICECLI_IMAGE_SOURCES).optional().describe("workspace = Nautilo artifact/asset path; fs = local filesystem path."),
  path: z.string().min(1).describe("Workspace logical path or filesystem path to the image."),
  parent: z.string().optional().describe("OfficeCLI parent path for the add picture command, e.g. /slide[1], /body, or /sheet[1]."),
  at: z.union([
    z.enum(OFFICECLI_IMAGE_ANCHORS),
    z.object({ x: z.number(), y: z.number() }),
  ]).optional().describe("Placement anchor: named anchor or explicit top-left {x,y} in cm."),
  size: z.union([
    z.literal("fit"),
    z.number().positive(),
    z.object({ w: z.number().positive().optional(), h: z.number().positive().optional() }),
  ]).optional().describe("fit, fraction of slide width, or explicit cm size."),
  w: z.number().positive().optional().describe("Explicit width in cm; legacy alias folded into size intent."),
  h: z.number().positive().optional().describe("Explicit height in cm; legacy alias folded into size intent."),
  slideSize: z.object({ w: z.number().positive(), h: z.number().positive() }).optional().describe("Placement canvas size in cm; defaults to 25.4 x 19.05."),
  alt: z.string().optional(),
  decorative: z.boolean().optional(),
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Additional OfficeCLI picture props; placement props remain authoritative."),
  mime: z.string().optional().describe("Optional expected MIME type; must be PNG, JPG, GIF, or SVG."),
  provenance: z.record(z.string(), z.unknown()).optional().describe("Generated-image provenance to preserve with the reversible office patch."),
});

const BatchPropsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional();

const OfficeCliBatchCommandSchema = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("add"),
    parent: z.string().min(1).describe("Parent object path, e.g. /body or /slide[1]. Do not use path for add."),
    type: z.string().optional().describe("For DOCX, type:'markdown' with props.markdown expands supported Markdown into native Word elements."),
    props: BatchPropsSchema,
    from: z.string().optional(),
    index: z.number().int().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
  }).strict(),
  z.object({
    command: z.literal("set"),
    path: z.string().min(1),
    props: BatchPropsSchema,
    find: z.string().optional(),
    replace: z.string().optional(),
  }).strict(),
  z.object({
    command: z.literal("remove"),
    path: z.string().min(1),
    shift: z.enum(["left", "up"]).optional(),
    props: BatchPropsSchema,
  }).strict(),
  z.object({
    command: z.literal("move"),
    path: z.string().min(1),
    to: z.string().optional(),
    index: z.number().int().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    props: BatchPropsSchema,
  }).strict(),
  z.object({
    command: z.literal("swap"),
    path: z.string().min(1),
    path2: z.string().min(1),
  }).strict(),
  z.object({
    command: z.literal("get"),
    path: z.string().min(1),
    depth: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    command: z.literal("query"),
    selector: z.string().min(1),
    find: z.string().optional(),
  }).strict(),
  z.object({
    command: z.literal("validate"),
  }).strict(),
  z.object({
    command: z.literal("raw"),
    part: z.string().optional(),
  }).strict(),
  z.object({
    command: z.literal("raw-set"),
    part: z.string().min(1),
    xpath: z.string().min(1),
    action: z.enum(RAW_SET_ACTIONS),
    xml: z.string().optional(),
  }).strict(),
  z.object({
    command: z.literal("add-part"),
    parent: z.string().min(1),
    type: z.string().min(1),
  }).strict(),
]);

const OfficeCliSchema = z.object({
  command: z.enum(OFFICECLI_COMMANDS),
  zone: z.enum(["workspace", "current", "absolute", "home", "scratch"]).default("workspace"),
  path: z.string().optional().describe("Document path for existing-file commands. workspace/home/scratch = relative to that zone; current = relative to the user's open folder; absolute = an absolute path on the user's machine (both routed through the desktop relay)."),
  out: z.string().optional().describe(
    "Output artifact path. Required for create. For mutating commands, omit or set equal to path to edit the closed input in place; a different out mints a NEW zero-clobber artifact.",
  ),
  target: z.string().optional().describe("OfficeCLI object path, such as /body/p[1]. Defaults to / where applicable."),
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  commands: z.array(OfficeCliBatchCommandSchema).max(50).optional().describe(
    "OfficeCLI batch command array, capped at 50 operations per call. This cap does not limit document elements or read results. Use the binary's shape exactly: each item needs command (not cmd); add uses parent+type, set/remove/move/get use path. For DOCX, add type:'markdown' with props.markdown expands supported Markdown into native Word elements; it is not a convert format.",
  ),
  type: z.string().optional().describe("Element type for add. For help only, docx|xlsx|pptx remains a legacy format alias; otherwise DOCX type:'markdown' with props.markdown expands supported Markdown into native Word elements."),
  parent: z.string().optional(),
  to: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  path2: z.string().optional(),
  selector: z.string().optional(),
  mode: z.enum(VIEW_MODES).optional(),
  format: z.enum(["docx", "xlsx", "pptx"]).optional(),
  verb: z.string().optional().describe(
    "Help-only schema verb. OfficeCLI accepts add, set, get, query, or remove. Omit verb for create or general format help; create is a top-level command, not a help verb.",
  ),
  element: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
  from: z.string().optional(),
  index: z.number().int().optional(),
  depth: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional().describe(
    "Optional command-specific result cap. Omit it when view mode='text' should return the complete closed document.",
  ),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
  maxLines: z.number().int().positive().optional(),
  cols: z.string().optional(),
  page: z.string().optional(),
  browser: z.boolean().optional(),
  screenshotWidth: z.number().int().positive().optional(),
  screenshotHeight: z.number().int().positive().optional(),
  grid: z.union([z.string(), z.boolean()]).optional(),
  render: z.enum(["auto", "native", "html"]).optional(),
  pageCount: z.boolean().optional(),
  data: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Merge-only template data. Do not supply data to create; use commands, including add /body type:'markdown' with props.markdown for DOCX Markdown authoring."),
  part: z.string().optional(),
  xpath: z.string().optional(),
  action: z.enum(RAW_SET_ACTIONS).optional(),
  xml: z.string().optional(),
  locale: z.string().optional(),
  minimal: z.boolean().optional(),
  force: z.boolean().optional(),
  imageInputs: z.array(OfficeCliImageInputSchema).max(20).optional().describe(
    "Images to embed as OfficeCLI add picture batch commands. Use source='workspace' for generated Nautilo artifacts/assets or source='fs' for user-provided local files.",
  ),
  json: z.boolean().default(true),
});

type OfficeCliArgs = z.infer<typeof OfficeCliSchema>;
type OfficeCliImageInput = z.infer<typeof OfficeCliImageInputSchema>;

interface OfficeCliToolContext {
  ownerId: string;
  agentId: string;
  roomId: string;
  workspacePath: string;
  currentFolder: string;
  turnId?: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
  activeMiniApp: ActiveMiniAppRequestContext | null;
}

type SessionManagerWithProbe = OfficeSessionManager & {
  hasActiveSession?: (artifactInternalId: string) => boolean;
  hasOpenSession?: (artifactInternalId: string) => boolean;
  isOpen?: (artifactInternalId: string) => boolean;
};

export interface CreateOfficeCliToolDeps {
  run?: OfficeCreateRunFn;
  resolveOfficeCliPath?: typeof resolveVendoredOfficeCliOrNull;
  makeOfficeCreateRun?: typeof makeOfficeCreateRun;
  /** Hermetic test seam; production uses the server-installed global port. */
  workspaceCommitExecution?: WorkspaceOfficeCliCommitExecution;
  applyBinaryContentPatch?: typeof applyBinaryContentPatch;
  resolveWorkspaceArtifact?: typeof resolveWorkspaceArtifact;
  resolveImageBytes?: (input: OfficeCliImageInput, ctx: {
    officeArgs: OfficeCliArgs;
    toolContext: OfficeCliToolContext;
    facts: EnvelopeFacts | null;
  }) => Promise<ResolvedOfficeCliImage | { error: string }>;
  readImagePixelSize?: typeof readImagePixelSize;
  getOfficeSessionManager?: () => SessionManagerWithProbe;
  /**
   * M206 — relay registry accessor (legacy test seam; local zones use
   * executeLocalOfficeOperation instead of fs byte transport).
   */
  getRelayRegistry?: () => ToolRelayRegistry | null;
  /** Hermetic test seam; production dispatches exactly one structured relay operation. */
  executeLocalOfficeOperation?: typeof executeLocalOfficeOperation;
  tempDirRoot?: string;
}

interface ResolvedOfficeCliImage {
  bytes: Buffer | Uint8Array;
  fileName?: string;
  mimeType?: string;
  artifactId?: string;
  logicalPath?: string;
  provenance?: Record<string, unknown>;
}

interface PreparedOfficeCliImages {
  commands: OfficeBatchCommand[];
  metadata: Array<Record<string, unknown>>;
  cleanup: () => Promise<void>;
}

function contextFromUnknown(ctx: unknown): OfficeCliToolContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const envRaw = c["memoryAccessEnvelope"];
  const activeRaw = c["activeMiniApp"];
  const envelope =
    envRaw && typeof envRaw === "object"
      ? (envRaw as MemoryAccessEnvelope)
      : null;
  const activeMiniApp =
    activeRaw && typeof activeRaw === "object"
      ? (activeRaw as ActiveMiniAppRequestContext)
      : null;
  const turnId = typeof c["turnId"] === "string" && c["turnId"].length > 0
    ? c["turnId"]
    : undefined;
  return {
    ownerId: typeof c["ownerId"] === "string" ? c["ownerId"] : "",
    agentId: typeof c["agentId"] === "string" ? c["agentId"] : "",
    roomId: typeof c["roomId"] === "string" ? c["roomId"] : "",
    workspacePath: typeof c["workspacePath"] === "string" ? c["workspacePath"] : "",
    currentFolder: typeof c["currentFolder"] === "string" ? c["currentFolder"] : "",
    ...(turnId !== undefined ? { turnId } : {}),
    memoryAccessEnvelope: envelope,
    activeMiniApp,
  };
}

function propsToStrings(props: Record<string, string | number | boolean> | undefined): Record<string, string> | undefined {
  if (!props) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) out[key] = String(value);
  return out;
}

function asBatchCommands(commands: OfficeCliArgs["commands"]): OfficeBatchCommand[] {
  return (commands ?? []).map((command) => {
    const props = "props" in command ? propsToStrings(command.props) : undefined;
    return props !== undefined
      ? ({ ...command, props } as OfficeBatchCommand)
      : (command as OfficeBatchCommand);
  });
}

function error(message: string): string {
  return `Error: ${message}`;
}

function requireNonEmpty(value: string | undefined, field: string): string | { error: string } {
  if (value === undefined || value.trim().length === 0) return { error: `${field} is required` };
  return value;
}

function isWriteCommand(command: OfficeCliCommand): boolean {
  return !READ_ONLY_COMMANDS.has(command);
}

/**
 * M206 — `current`/`absolute` zones dispatch one structured `kind:"office"`
 * local-file operation to the Electron relay. The server never stages local
 * OOXML bytes or runs OfficeCLI for these zones.
 */
function isRelayZone(zone: OfficeCliArgs["zone"]): zone is "current" | "absolute" {
  return zone === "current" || zone === "absolute";
}

function localOfficeContext(ctx: OfficeCliToolContext): LocalOfficeDispatchContext {
  return {
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    zoneCtx: officeZoneContext(ctx),
    approvalObtained: true,
  };
}

function officeArgsWithoutZone(args: OfficeCliArgs): Record<string, unknown> {
  const { zone: _z, ...rest } = args;
  return rest as Record<string, unknown>;
}

async function dispatchLocalOfficeCli(
  args: OfficeCliArgs,
  ctx: OfficeCliToolContext,
  deps: CreateOfficeCliToolDeps,
  extraPayload: Record<string, unknown> = {},
): Promise<string> {
  if (args.imageInputs && args.imageInputs.length > 0) {
    return error(
      "officecli imageInputs on local zones are not supported in v1 — use workspace artifacts for embedded images or omit imageInputs.",
    );
  }

  const outcome = await (deps.executeLocalOfficeOperation ?? executeLocalOfficeOperation)(
    {
      subkind: "officecli",
      zone: args.zone as "current" | "absolute",
      command: args.command,
      payload: { ...officeArgsWithoutZone(args), ...extraPayload },
      _routing: {
        ownerId: ctx.ownerId,
        agentId: ctx.agentId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        currentFolder: ctx.currentFolder || null,
        workspaceRoot: ctx.workspacePath,
      },
    },
    localOfficeContext(ctx),
  );
  if (!outcome.ok) return localOfficeDispatchErrorText(outcome);

  const result = annotateOfficeCliTextViewCount(args, outcome.result);
  if (typeof result === "string") return result;
  if (args.command === "create" || isWriteCommand(args.command)) {
    if (result && typeof result === "object" && (result as { applied?: boolean }).applied) {
      const r = result as { summary?: string; path?: string; byteLength?: number; command?: string };
      const cmd = r.command ?? args.command;
      const p = r.path ?? args.out ?? args.path ?? "";
      const n = r.byteLength ?? 0;
      return r.summary ?? `Applied officecli ${cmd} ${p} (${n} bytes).`;
    }
  }
  if (typeof result === "object" && result !== null) {
    return JSON.stringify(result);
  }
  if (
    typeof result === "number" ||
    typeof result === "boolean" ||
    typeof result === "bigint" ||
    typeof result === "symbol"
  ) {
    return String(result);
  }
  return "";
}

function officeZoneContext(ctx: OfficeCliToolContext): { workspaceRoot: string; currentFolder: string | null } {
  return { workspaceRoot: ctx.workspacePath, currentFolder: ctx.currentFolder || null };
}

function makeRun(deps: CreateOfficeCliToolDeps): OfficeCreateRunFn | { error: string } {
  if (deps.run) return deps.run;
  const resolver = deps.resolveOfficeCliPath ?? resolveVendoredOfficeCliOrNull;
  const binaryPath = resolver();
  if (!binaryPath) {
    return { error: "officecli binary not found for this platform. The bundled OfficeCLI binary is missing or not executable." };
  }
  return (deps.makeOfficeCreateRun ?? makeOfficeCreateRun)({ binaryPath });
}

function buildDispatchContext(ctx: OfficeCliToolContext, meta?: WorkspaceArtifactPatchMeta): DispatchContext {
  const turnId = ctx.turnId ?? getCurrentTurnId();
  return {
    zoneCtx: {
      workspaceRoot: ctx.workspacePath,
      currentFolder: ctx.currentFolder || null,
    },
    backend: new LocalFileBackend(),
    ownerId: ctx.ownerId,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.roomId ? { roomId: ctx.roomId } : {}),
    memoryAccessEnvelope: ctx.memoryAccessEnvelope,
    ...(meta ? { workspaceArtifactMeta: meta } : {}),
  };
}

function workspaceFacts(ctx: OfficeCliToolContext): EnvelopeFacts | { error: string } {
  const factsResult = envelopeFactsForArtifacts(ctx.memoryAccessEnvelope);
  if (!factsResult.ok) return { error: factsResult.reason };
  if (!factsResult.facts.agentId) {
    return { error: "workspace artifact access requires an authenticated agent context." };
  }
  return factsResult.facts;
}

/** Normalize workspace logical paths for out===path in-place comparison. */
function sameLogicalPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^\/+/, "").replace(/\\/g, "/");
  return norm(a) === norm(b);
}

function isInPlaceMutation(args: OfficeCliArgs): boolean {
  if (!args.path || !args.out) return false;
  return sameLogicalPath(args.path, args.out);
}

async function prepareWorkspaceOutput(
  outPath: string,
  facts: EnvelopeFacts,
  deps: CreateOfficeCliToolDeps,
  options?: { inPlace?: boolean },
): Promise<{ resolution: CommandResolution; meta: WorkspaceArtifactPatchMeta } | { error: string }> {
  const validated = validateLogicalPath(outPath);
  if (!validated.ok) return { error: validated.reason };
  const inPlace = options?.inPlace === true;
  const resolveArtifact = deps.resolveWorkspaceArtifact ?? resolveWorkspaceArtifact;
  const resolved = await resolveArtifact({
    logicalPath: validated.path,
    facts,
    intent: inPlace ? "create_or_update" : "create",
  });
  if (!resolved.ok) return { error: resolved.reason };
  await mkdir(dirname(resolved.physicalPath), { recursive: true });

  if (inPlace) {
    if (!resolved.artifact) {
      return {
        error: `No workspace artifact at "${validated.path}" to edit in place. Pass a different out to create a new artifact.`,
      };
    }
    if (facts.writableNamespaces.length === 0 && facts.mutableNamespaces.length === 0) {
      return {
        error:
          "no writable namespace for workspace artifact updates. Open a room with namespace write access before mutating office outputs.",
      };
    }
    const namespaceId = facts.writableNamespaces[0] ?? facts.mutableNamespaces[0]!;
    const meta: WorkspaceArtifactPatchMeta = {
      mode: "update",
      artifactId: resolved.artifactId,
      logicalPath: resolved.logicalPath,
      namespaceId,
      storageUri: resolved.storageUri,
      rowId: resolved.artifact.id,
      mimeType: mimeFromExtensionOr(resolved.logicalPath),
    };
    return {
      resolution: { resolved: resolved.physicalPath, resolvedZone: "workspace" },
      meta,
    };
  }

  if (facts.writableNamespaces.length === 0) {
    return {
      error:
        "no writable namespace for new workspace artifacts. Open a room with namespace write access before writing office outputs.",
    };
  }
  const meta: WorkspaceArtifactPatchMeta = {
    mode: "create",
    artifactId: resolved.artifactId,
    logicalPath: resolved.logicalPath,
    namespaceId: facts.writableNamespaces[0]!,
    storageUri: resolved.storageUri,
    mimeType: mimeFromExtensionOr(resolved.logicalPath),
  };
  return {
    resolution: { resolved: resolved.physicalPath, resolvedZone: "workspace" },
    meta,
  };
}

async function admitWorkspaceOfficeCliMutation(
  outputPath: string,
  sourcePath: string | undefined,
  facts: EnvelopeFacts,
  deps: CreateOfficeCliToolDeps,
): Promise<{ error: string } | null> {
  const validated = validateLogicalPath(outputPath);
  if (!validated.ok) return { error: validated.reason };
  const inPlace =
    sourcePath !== undefined && sameLogicalPath(sourcePath, outputPath);
  const resolveArtifact =
    deps.resolveWorkspaceArtifact ?? resolveWorkspaceArtifact;
  const resolution = await resolveArtifact({
    logicalPath: validated.path,
    facts,
    intent: inPlace ? "mutate" : "create",
  });
  if (!resolution.ok) return { error: resolution.reason };
  return null;
}

function safeProviderPath(root: string, logicalPath: string): string | { error: string } {
  const normalized = logicalPath.split(/[\\/]+/).filter((segment) => segment.length > 0).join(path.sep);
  if (!normalized || normalized.split(path.sep).some((segment) => segment === "..")) {
    return { error: "path must be relative and may not contain '..' segments" };
  }
  const absoluteRoot = pathResolve(root);
  const absolute = pathResolve(absoluteRoot, normalized);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    return { error: "path escapes artifact zone root" };
  }
  return absolute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * OfficeCLI's DOCX text view may count non-content OOXML nodes such as sectPr
 * in totalElements even though no record is emitted for them. Preserve that
 * vendor field for compatibility and add the exact returned array length.
 */
function annotateOfficeCliTextViewCount(args: OfficeCliArgs, result: unknown): unknown {
  if (args.command !== "view" || (args.mode ?? "text") !== "text" || args.json === false) {
    return result;
  }

  let parsed = result;
  const wasString = typeof result === "string";
  if (wasString) {
    try {
      parsed = JSON.parse(result);
    } catch {
      return result;
    }
  }
  if (!isRecord(parsed)) return result;

  const payload = isRecord(parsed["data"]) ? parsed["data"] : parsed;
  const elements = payload["elements"];
  if (!Array.isArray(elements) || payload["returnedElements"] !== undefined) return result;

  payload["returnedElements"] = elements.length;
  return wasString ? JSON.stringify(parsed) : parsed;
}

function imageSourceFor(input: OfficeCliImageInput): "workspace" | "fs" {
  if (input.source) return input.source;
  return path.isAbsolute(input.path) || input.path.startsWith(".") ? "fs" : "workspace";
}

function safeImageFileName(input: OfficeCliImageInput, resolved: ResolvedOfficeCliImage, index: number): string {
  const raw = (resolved.fileName ?? basename(resolved.logicalPath ?? input.path)) || `image-${index + 1}`;
  const cleaned = raw.replace(/[^\w.-]+/g, "_");
  const ext = path.extname(cleaned);
  if (ext.length > 0) return cleaned;
  const mime = resolved.mimeType ?? input.mime;
  if (mime === "image/jpeg") return `${cleaned}.jpg`;
  if (mime === "image/gif") return `${cleaned}.gif`;
  if (mime === "image/svg+xml") return `${cleaned}.svg`;
  return `${cleaned}.png`;
}

function mimeFromImageBytes(bytes: Uint8Array, fallback: string | undefined): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  const textPrefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 512))).toString("utf-8").trimStart().toLowerCase();
  if (textPrefix.startsWith("<svg") || (textPrefix.startsWith("<?xml") && textPrefix.includes("<svg"))) {
    return "image/svg+xml";
  }
  const normalizedFallback = fallback === "image/jpg" ? "image/jpeg" : fallback;
  return normalizedFallback && SUPPORTED_IMAGE_MIME_TYPES.has(normalizedFallback) ? normalizedFallback : null;
}

function validateImageBytes(input: OfficeCliImageInput, resolved: ResolvedOfficeCliImage): { bytes: Buffer; mimeType: string } | { error: string } {
  const bytes = Buffer.isBuffer(resolved.bytes) ? resolved.bytes : Buffer.from(resolved.bytes);
  if (bytes.byteLength === 0) return { error: `image ${input.path} is empty` };
  if (bytes.byteLength > MAX_OFFICECLI_IMAGE_BYTES) {
    return { error: `image ${input.path} is ${bytes.byteLength} bytes; max is ${MAX_OFFICECLI_IMAGE_BYTES} bytes` };
  }
  const expectedMime = input.mime ?? resolved.mimeType ?? mimeFromExtensionOr(resolved.fileName ?? resolved.logicalPath ?? input.path);
  const mimeType = mimeFromImageBytes(bytes, expectedMime);
  if (!mimeType) {
    return { error: `image ${input.path} must be PNG, JPG, GIF, or SVG` };
  }
  if (input.mime !== undefined && input.mime !== mimeType && !(input.mime === "image/jpg" && mimeType === "image/jpeg")) {
    return { error: `image ${input.path} MIME mismatch: expected ${input.mime}, got ${mimeType}` };
  }
  return { bytes, mimeType };
}

async function defaultResolveImageBytes(
  input: OfficeCliImageInput,
  ctx: OfficeCliToolContext,
  facts: EnvelopeFacts | null,
  deps: CreateOfficeCliToolDeps,
): Promise<ResolvedOfficeCliImage | { error: string }> {
  const source = imageSourceFor(input);
  if (source === "workspace") {
    if (!facts) return { error: "workspace image inputs require room/namespace context." };
    const validated = validateLogicalPath(input.path);
    if (!validated.ok) return { error: `image path: ${validated.reason}` };
    const resolveArtifact = deps.resolveWorkspaceArtifact ?? resolveWorkspaceArtifact;
    const resolved = await resolveArtifact({
      logicalPath: validated.path,
      facts,
      intent: "read",
    });
    if (!resolved.ok) return { error: resolved.reason };
    if (!resolved.artifact) return { error: `No workspace image artifact at "${validated.path}".` };
    const bytes = await readFile(resolved.physicalPath);
    const artifactRecord = resolved.artifact as unknown;
    const artifactMetadata = isRecord(artifactRecord) && isRecord(artifactRecord["metadata"])
      ? artifactRecord["metadata"]
      : undefined;
    return {
      bytes,
      fileName: basename(resolved.logicalPath),
      mimeType: resolved.artifact.mimeType ?? mimeFromExtensionOr(resolved.logicalPath),
      artifactId: resolved.artifactId,
      logicalPath: resolved.logicalPath,
      ...(artifactMetadata !== undefined ? { provenance: artifactMetadata } : {}),
    };
  }

  const root = ctx.currentFolder || ctx.workspacePath || process.cwd();
  const physicalPath = path.isAbsolute(input.path) ? input.path : pathResolve(root, input.path);
  const bytes = await readFile(physicalPath);
  return {
    bytes,
    fileName: basename(physicalPath),
    mimeType: mimeFromExtensionOr(physicalPath),
  };
}

function cm(value: number): string {
  return `${Number(value.toFixed(4))}cm`;
}

function defaultImageParent(args: OfficeCliArgs, input: OfficeCliImageInput): string {
  if (input.parent && input.parent.trim().length > 0) return input.parent;
  if (args.parent && args.parent.trim().length > 0) return args.parent;
  const name = args.out ?? args.path ?? "";
  const ext = path.extname(name).toLowerCase();
  if (args.format === "docx" || ext === ".docx") return "/body";
  if (args.format === "xlsx" || ext === ".xlsx") return "/sheet[1]";
  if (args.format === "pptx" || ext === ".pptx") return "/slide[1]";
  return "/";
}

function buildImageMetadata(
  input: OfficeCliImageInput,
  resolved: ResolvedOfficeCliImage,
  mimeType: string,
  byteLength: number,
  placement: ReturnType<typeof computeImagePlacementRect>,
): Record<string, unknown> {
  return {
    source: imageSourceFor(input),
    path: input.path,
    mimeType,
    bytes: byteLength,
    ...(resolved.artifactId !== undefined ? { artifactId: resolved.artifactId } : {}),
    ...(resolved.logicalPath !== undefined ? { logicalPath: resolved.logicalPath } : {}),
    ...(input.provenance !== undefined || resolved.provenance !== undefined
      ? { provenance: { ...(resolved.provenance ?? {}), ...(input.provenance ?? {}) } }
      : {}),
    placement,
  };
}

async function prepareOfficeCliImages(
  args: OfficeCliArgs,
  ctx: OfficeCliToolContext,
  facts: EnvelopeFacts | null,
  deps: CreateOfficeCliToolDeps,
): Promise<PreparedOfficeCliImages | { error: string }> {
  const inputs = args.imageInputs ?? [];
  if (inputs.length === 0) {
    return { commands: [], metadata: [], cleanup: async () => {} };
  }

  const scratch = await mkdtemp(join(deps.tempDirRoot ?? tmpdir(), "officecli-images-"));
  const commands: OfficeBatchCommand[] = [];
  const metadata: Array<Record<string, unknown>> = [];
  let ok = false;
  try {
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i]!;
      if (typeof input.size === "object" && input.size !== null && input.size.w === undefined && input.size.h === undefined) {
        return { error: `imageInputs[${i}].size needs at least one of w/h` };
      }
      const resolved = deps.resolveImageBytes
        ? await deps.resolveImageBytes(input, { officeArgs: args, toolContext: ctx, facts })
        : await defaultResolveImageBytes(input, ctx, facts, deps);
      if ("error" in resolved) return resolved;
      const validated = validateImageBytes(input, resolved);
      if ("error" in validated) return validated;
      const fileName = safeImageFileName(input, { ...resolved, mimeType: validated.mimeType }, i);
      const tempPath = join(scratch, `${i + 1}-${fileName}`);
      await writeFile(tempPath, validated.bytes);

      const nativePixels = (deps.readImagePixelSize ?? readImagePixelSize)(validated.bytes);
      const slideSize = input.slideSize ?? DEFAULT_SLIDE_SIZE_CM;
      const placement = computeImagePlacementRect(
        nativePixels,
        slideSize,
        { at: input.at, size: input.size, w: input.w, h: input.h },
        input.slideSize ? "engine" : "fallback",
      );
      const rect = placement.placedRect;
      const props: Record<string, string> = {
        ...propsToStrings(input.props),
        path: tempPath,
        x: cm(rect.xCm),
        y: cm(rect.yCm),
        width: cm(rect.wCm),
        height: cm(rect.hCm),
        ...(input.alt !== undefined ? { alt: input.alt } : {}),
        ...(input.decorative !== undefined ? { decorative: String(input.decorative) } : {}),
      };
      commands.push({
        command: "add",
        parent: defaultImageParent(args, input),
        type: "picture",
        props,
      });
      metadata.push(buildImageMetadata(input, resolved, validated.mimeType, validated.bytes.byteLength, placement));
    }
    ok = true;
    return {
      commands,
      metadata,
      cleanup: async () => {
        await rm(scratch, { recursive: true, force: true });
      },
    };
  } finally {
    if (!ok) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

function batchCommandFromDirectArgs(args: OfficeCliArgs): OfficeBatchCommand | null | { error: string } {
  const props = propsToStrings(args.props);
  switch (args.command) {
    case "set": {
      const pathArg = requireNonEmpty(args.target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return {
        command: "set",
        path: pathArg,
        ...(props !== undefined ? { props } : {}),
        ...(args.find !== undefined ? { find: args.find } : {}),
        ...(args.replace !== undefined ? { replace: args.replace } : {}),
      };
    }
    case "add": {
      if (args.imageInputs && args.parent === undefined && args.type === undefined && args.from === undefined) return null;
      const parent = requireNonEmpty(args.parent, "parent");
      if (typeof parent !== "string") return parent;
      return {
        command: "add",
        parent,
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.index !== undefined ? { index: args.index } : {}),
        ...(args.after !== undefined ? { after: args.after } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
        ...(props !== undefined ? { props } : {}),
      };
    }
    case "remove": {
      const pathArg = requireNonEmpty(args.target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return {
        command: "remove",
        path: pathArg,
        ...(props !== undefined ? { props } : {}),
      };
    }
    case "move": {
      const pathArg = requireNonEmpty(args.target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return {
        command: "move",
        path: pathArg,
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.index !== undefined ? { index: args.index } : {}),
        ...(args.after !== undefined ? { after: args.after } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
        ...(props !== undefined ? { props } : {}),
      };
    }
    case "swap": {
      const path1 = requireNonEmpty(args.target, "target");
      if (typeof path1 !== "string") return path1;
      const path2 = requireNonEmpty(args.path2, "path2");
      if (typeof path2 !== "string") return path2;
      return { command: "swap", path: path1, path2 };
    }
    default:
      return { error: `imageInputs can be combined with create, batch, add, set, remove, move, or swap (got ${args.command})` };
  }
}

function argsWithImageBatchCommands(args: OfficeCliArgs, imageCommands: OfficeBatchCommand[]): OfficeCliArgs | { error: string } {
  if (imageCommands.length === 0) return args;
  if (args.command === "batch") {
    return { ...args, commands: [...asBatchCommands(args.commands), ...imageCommands] };
  }
  const direct = batchCommandFromDirectArgs(args);
  if (direct === null) return { ...args, command: "batch", commands: imageCommands };
  if ("error" in direct) return direct;
  return { ...args, command: "batch", commands: [direct, ...imageCommands] };
}

async function prepareOutput(
  args: OfficeCliArgs,
  ctx: OfficeCliToolContext,
  facts: EnvelopeFacts | null,
  deps: CreateOfficeCliToolDeps,
): Promise<{ resolution: CommandResolution; dispatchCtx: DispatchContext } | { error: string }> {
  const out = requireNonEmpty(args.out, "out");
  if (typeof out !== "string") return out;
  if (args.zone === "workspace") {
    if (!facts) return { error: "workspace zone requires room/namespace context." };
    const prepared = await prepareWorkspaceOutput(out, facts, deps, {
      inPlace: isInPlaceMutation(args),
    });
    if ("error" in prepared) return prepared;
    return {
      resolution: prepared.resolution,
      dispatchCtx: buildDispatchContext(ctx, prepared.meta),
    };
  }
  // current/absolute never reach here — applyGeneratedBytes routes them to the
  // relay backend before calling prepareOutput. Guard defensively so the
  // getArtifactZone call below only sees the artifact-store zones.
  if (isRelayZone(args.zone)) {
    return { error: `zone "${args.zone}" is handled by the relay backend, not prepareOutput.` };
  }
  const provider = getArtifactZone(args.zone);
  if (!provider) return { error: `artifact zone "${args.zone}" is not initialised.` };
  const absolute = safeProviderPath(provider.rootPath, out);
  if (typeof absolute !== "string") return absolute;
  await mkdir(dirname(absolute), { recursive: true });
  return {
    resolution: { resolved: absolute, resolvedZone: "absolute" },
    dispatchCtx: buildDispatchContext(ctx),
  };
}

async function applyGeneratedBytes(
  args: OfficeCliArgs,
  ctx: OfficeCliToolContext,
  facts: EnvelopeFacts | null,
  bytes: Buffer,
  deps: CreateOfficeCliToolDeps,
  commandArgs: Record<string, unknown> = args,
  workspaceSource?: WorkspaceOfficeCliSnapshot,
): Promise<string> {
  // Output integrity guard — NEVER persist a blank/corrupt artifact and
  // report success. .docx/.xlsx/.pptx are ZIP (OOXML) packages: valid bytes
  // MUST be non-empty and start with the ZIP local-file magic `PK\x03\x04`.
  // A 0-byte or non-PK buffer means the OfficeCLI write did not land (e.g. an
  // unflushed resident) — surface it as an error, do not write a blank file.
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04
  ) {
    return error(
      `officecli ${args.command} produced an invalid Office document (${bytes.byteLength} bytes; ` +
      `expected a non-empty OOXML/ZIP package). The write did not land — nothing was saved.`,
    );
  }

  // R6 — post-generation byte re-check against the per-format ceiling
  // (xlsx 100MB / pptx 200MB / docx 50MB), keyed off the output extension.
  const outName = args.out ?? args.path ?? "";
  const ext = outName.slice(outName.lastIndexOf(".") + 1);
  const sizeError = assertGeneratedSizeForFormat(bytes.byteLength, ext);
  if (sizeError) return error(sizeError);

  // M206 — current/absolute writes are applied on the Electron relay via
  // structured local-file office dispatch (never server staging).
  if (isRelayZone(args.zone)) {
    return error("applyGeneratedBytes called for relay zone — use dispatchLocalOfficeCli");
  }

  // D448: Workspace OfficeCLI candidates never use the legacy generic binary
  // committer. The server-installed port re-resolves current Room authority,
  // admits human leases, and commits exactly one binary coordinator plan.
  if (args.zone === "workspace") {
    if (!facts) return error("workspace zone requires room/namespace context.");
    const outputPath = args.out;
    if (!outputPath) return error("out is required for Workspace OfficeCLI commits.");
    const turnId = ctx.turnId ?? getCurrentTurnId();
    if (!turnId || !ctx.memoryAccessEnvelope || !ctx.ownerId || !ctx.agentId || !ctx.roomId) {
      return error("Workspace OfficeCLI authority is unavailable for this turn.");
    }
    const execution =
      deps.workspaceCommitExecution ?? getWorkspaceOfficeCliCommitExecution();
    if (!execution) {
      return error("Workspace OfficeCLI commit runtime is unavailable.");
    }
    const committed = await execution({
      authority: {
        envelope: ctx.memoryAccessEnvelope,
        ownerId: ctx.ownerId,
        agentId: ctx.agentId,
        roomId: ctx.roomId,
        turnId,
      },
      ...(workspaceSource === undefined ? {} : { source: workspaceSource }),
      outputPath,
      postImage: Uint8Array.from(bytes),
      commandArgs,
    });
    if (!committed.ok) return error(committed.message);
    return JSON.stringify({
      applied: true,
      revisionId: committed.revisionId,
      path: outputPath,
      zone: "workspace",
      command: "officecli",
      binary: true,
      artifactInternalId: committed.artifactInternalId,
      artifactId: committed.artifactId,
    });
  }

  const target = await prepareOutput(args, ctx, facts, deps);
  if ("error" in target) return error(target.error);
  const summary = `Applied officecli ${args.command} ${target.resolution.resolved} (${bytes.byteLength} bytes) - revertable.`;
  const envelope = await (deps.applyBinaryContentPatch ?? applyBinaryContentPatch)({
    resolution: target.resolution,
    ctx: target.dispatchCtx,
    command: "officecli",
    commandArgs,
    newBytes: bytes,
    summary,
    bytes: bytes.byteLength,
  });
  if ("errorText" in envelope) return envelope.errorText;
  return encodeAppliedResult(envelope);
}

async function resolveInputPath(
  args: OfficeCliArgs,
  _ctx: OfficeCliToolContext,
  facts: EnvelopeFacts | null,
  deps: CreateOfficeCliToolDeps,
): Promise<
  | {
      logicalPath: string;
      physicalPath: string;
      artifactInternalId?: string;
      workspaceSnapshot?: WorkspaceOfficeCliSnapshot;
    }
  | { error: string }
> {
  const input = requireNonEmpty(args.path, "path");
  if (typeof input !== "string") return input;
  if (isRelayZone(args.zone)) {
    return { error: "resolveInputPath must not run for relay zones — use dispatchLocalOfficeCli" };
  }
  if (args.zone === "workspace") {
    if (!facts) return { error: "workspace zone requires room/namespace context." };
    const validated = validateLogicalPath(input);
    if (!validated.ok) return { error: validated.reason };
    const resolveArtifact = deps.resolveWorkspaceArtifact ?? resolveWorkspaceArtifact;
    const resolved = await resolveArtifact({
      logicalPath: validated.path,
      facts,
      intent: "read",
    });
    if (!resolved.ok) return { error: resolved.reason };
    if (!resolved.artifact) return { error: `No workspace artifact at "${validated.path}".` };
    const bytes = new Uint8Array(await readFile(resolved.physicalPath));
    return {
      logicalPath: resolved.logicalPath,
      physicalPath: resolved.physicalPath,
      artifactInternalId: resolved.artifact.id,
      workspaceSnapshot: {
        artifactInternalId: resolved.artifact.id,
        artifactId: resolved.artifact.artifactId,
        logicalPath: resolved.logicalPath,
        revision: resolved.artifact.revision,
        bytes,
      },
    };
  }
  const provider = getArtifactZone(args.zone);
  if (!provider) return { error: `artifact zone "${args.zone}" is not initialised.` };
  const bytes = await provider.read(input);
  const scratch = await mkdtemp(join(deps.tempDirRoot ?? tmpdir(), "officecli-input-"));
  const physicalPath = join(scratch, basename(input));
  await writeFile(physicalPath, bytes);
  return { logicalPath: input, physicalPath };
}

function sessionProbe(manager: SessionManagerWithProbe, artifactInternalId: string): boolean {
  return (
    manager.hasActiveSession?.(artifactInternalId) === true ||
    manager.hasOpenSession?.(artifactInternalId) === true ||
    manager.isOpen?.(artifactInternalId) === true
  );
}

function isActiveMiniAppConflict(ctx: OfficeCliToolContext, logicalPath: string): boolean {
  const active = ctx.activeMiniApp;
  if (!active || active.targetKind !== "artifact") return false;
  return active.documentPath === logicalPath || active.documentPath === `/${logicalPath}`;
}

function enforceWorkspaceLockout(
  args: OfficeCliArgs,
  ctx: OfficeCliToolContext,
  input: { logicalPath: string; artifactInternalId?: string },
  deps: CreateOfficeCliToolDeps,
): string | null {
  if (args.zone !== "workspace" || !isWriteCommand(args.command)) return null;
  if (isActiveMiniAppConflict(ctx, input.logicalPath)) {
    return (
      "Error: officecli refused to mutate this workspace document because it is open in an active office editor session. " +
      "Use an available app-specific interactive editor tool, or close the editor and retry."
    );
  }
  if (input.artifactInternalId) {
    const manager = (deps.getOfficeSessionManager ?? getOfficeSessionManager)();
    if (sessionProbe(manager, input.artifactInternalId)) {
      return (
        "Error: officecli refused to mutate this workspace document because an office editor session is open for it. " +
        "Use an available app-specific interactive editor tool, or close the editor and retry."
      );
    }
  }
  return null;
}

function buildDirectArgv(args: OfficeCliArgs, file: string): string[] | { error: string } {
  const json = args.json !== false;
  const target = args.target;
  const props = propsToStrings(args.props);
  switch (args.command) {
    case "view":
      return buildViewArgv({
        file,
        mode: args.mode ?? "text",
        ...(args.start !== undefined ? { start: args.start } : {}),
        ...(args.end !== undefined ? { end: args.end } : {}),
        ...(args.maxLines !== undefined ? { maxLines: args.maxLines } : {}),
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cols !== undefined ? { cols: args.cols } : {}),
        ...(args.page !== undefined ? { page: args.page } : {}),
        ...(args.browser !== undefined ? { browser: args.browser } : {}),
        ...(args.out !== undefined ? { out: args.out } : {}),
        ...(args.screenshotWidth !== undefined ? { screenshotWidth: args.screenshotWidth } : {}),
        ...(args.screenshotHeight !== undefined ? { screenshotHeight: args.screenshotHeight } : {}),
        ...(args.grid === false || args.grid === undefined ? {} : { grid: args.grid }),
        ...(args.render !== undefined ? { render: args.render } : {}),
        ...(args.pageCount !== undefined ? { pageCount: args.pageCount } : {}),
        json,
      });
    case "get":
      return buildGetArgv({
        file,
        ...(target !== undefined ? { path: target } : {}),
        ...(args.depth !== undefined ? { depth: args.depth } : {}),
        json,
      });
    case "query": {
      const selector = requireNonEmpty(args.selector, "selector");
      if (typeof selector !== "string") return selector;
      return buildQueryArgv({ file, selector, ...(args.find !== undefined ? { find: args.find } : {}), json });
    }
    case "set": {
      const pathArg = requireNonEmpty(target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return buildSetArgv({
        file,
        path: pathArg,
        ...(props !== undefined ? { props } : {}),
        ...(args.find !== undefined ? { find: args.find } : {}),
        ...(args.replace !== undefined ? { replace: args.replace } : {}),
        ...(args.force !== undefined ? { force: args.force } : {}),
        json,
      });
    }
    case "add": {
      const parent = requireNonEmpty(args.parent, "parent");
      if (typeof parent !== "string") return parent;
      return buildAddArgv({
        file,
        parent,
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.index !== undefined ? { index: args.index } : {}),
        ...(args.after !== undefined ? { after: args.after } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
        ...(props !== undefined ? { props } : {}),
        ...(args.force !== undefined ? { force: args.force } : {}),
        json,
      });
    }
    case "remove": {
      const pathArg = requireNonEmpty(target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return buildRemoveArgv({ file, path: pathArg, ...(props !== undefined ? { props } : {}), json });
    }
    case "move": {
      const pathArg = requireNonEmpty(target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return buildMoveArgv({
        file,
        path: pathArg,
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.index !== undefined ? { index: args.index } : {}),
        ...(args.after !== undefined ? { after: args.after } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
        ...(props !== undefined ? { props } : {}),
        json,
      });
    }
    case "swap": {
      const path1 = requireNonEmpty(target, "target");
      if (typeof path1 !== "string") return path1;
      const path2 = requireNonEmpty(args.path2, "path2");
      if (typeof path2 !== "string") return path2;
      return buildSwapArgv({ file, path1, path2, json });
    }
    case "validate":
      return buildValidateArgv({ file, json });
    case "dump":
      return buildDumpArgv({
        file,
        ...(target !== undefined ? { path: target } : {}),
        ...(args.format !== undefined ? { format: args.format } : {}),
        json,
      });
    case "batch":
      return buildBatchArgv({ file, commands: asBatchCommands(args.commands), stopOnError: true, json });
    case "raw":
      return buildRawArgv({
        file,
        ...(args.part !== undefined ? { part: args.part } : {}),
        ...(args.start !== undefined ? { start: args.start } : {}),
        ...(args.end !== undefined ? { end: args.end } : {}),
        ...(args.cols !== undefined ? { cols: args.cols } : {}),
        json,
      });
    case "raw_set": {
      const part = requireNonEmpty(args.part, "part");
      if (typeof part !== "string") return part;
      const xpath = requireNonEmpty(args.xpath, "xpath");
      if (typeof xpath !== "string") return xpath;
      const action = args.action;
      if (!action) return { error: "action is required" };
      return buildRawSetArgv({
        file,
        part,
        xpath,
        action: action as RawSetAction,
        ...(args.xml !== undefined ? { xml: args.xml } : {}),
        json,
      });
    }
    case "add_part": {
      const parent = requireNonEmpty(args.parent, "parent");
      if (typeof parent !== "string") return parent;
      const type = requireNonEmpty(args.type, "type");
      if (typeof type !== "string") return type;
      return buildAddPartArgv({ file, parent, type, json });
    }
    case "open":
      return buildOpenArgv({ file, json });
    case "save":
      return buildSaveArgv({ file, json });
    case "close":
      return buildCloseArgv({ file, json });
    case "refresh":
      return buildRefreshArgv({ file, json });
    default:
      return { error: `unsupported direct command ${args.command}` };
  }
}

async function runDirectRead(args: OfficeCliArgs, run: OfficeCreateRunFn, file: string): Promise<string> {
  if (args.command === "view" && (args.mode === "screenshot" || args.mode === "html" || args.mode === "issues")) {
    const rendered = await renderOffice({
      file,
      run,
      screenshot: args.mode === "screenshot",
      html: args.mode === "html",
      issues: args.mode === "issues",
      ...(args.page !== undefined ? { screenshotPages: args.page } : {}),
      ...(args.screenshotWidth !== undefined ? { screenshotWidth: args.screenshotWidth } : {}),
      ...(args.screenshotHeight !== undefined ? { screenshotHeight: args.screenshotHeight } : {}),
      ...(typeof args.grid === "string" ? { screenshotGrid: args.grid } : {}),
    });
    return JSON.stringify({
      ok: true,
      command: args.command,
      mode: args.mode,
      html: rendered.html,
      issues: rendered.issues,
      screenshots: rendered.screenshots.map((s) => ({
        page: s.page,
        bytes: s.bytes.byteLength,
        base64: s.bytes.toString("base64"),
      })),
    });
  }
  const argv = buildDirectArgv(args, file);
  if ("error" in argv) return error(argv.error);
  const result = await run(argv);
  if (result.exitCode !== 0) {
    return error(`officecli ${args.command} failed: exit ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`);
  }
  if (result.stdout.length === 0) return JSON.stringify({ ok: true, command: args.command });
  const annotated = annotateOfficeCliTextViewCount(args, result.stdout);
  return typeof annotated === "string" ? annotated : JSON.stringify(annotated);
}

async function runDirectMutation(args: OfficeCliArgs, run: OfficeCreateRunFn, file: string): Promise<Buffer | { error: string }> {
  if (args.command === "merge") {
    const outFile = join(dirname(file), basename(args.out ?? "merged" + path.extname(file)));
    const data = typeof args.data === "string" ? args.data : JSON.stringify(args.data ?? {});
    const result = await run(buildMergeArgv({
      template: file,
      output: outFile,
      data,
      ...(args.force !== undefined ? { force: args.force } : { force: true }),
      json: args.json !== false,
    }));
    if (result.exitCode !== 0) return { error: `officecli merge failed: exit ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}` };
    return await readFile(outFile);
  }
  const argv = buildDirectArgv(args, file);
  if ("error" in argv) return argv;
  const result: OfficeCliRunResult = await run(argv);
  if (result.exitCode !== 0) {
    return { error: `officecli ${args.command} failed: exit ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}` };
  }
  return await readFile(file);
}

async function withTempCopy<T>(sourcePath: string, tempDirRoot: string | undefined, fn: (copyPath: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tempDirRoot ?? tmpdir(), "officecli-work-"));
  try {
    const copyPath = join(scratch, basename(sourcePath));
    await writeFile(copyPath, await readFile(sourcePath));
    return await fn(copyPath);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function withOfficeReadableInput<T>(
  input: { logicalPath: string; physicalPath: string },
  tempDirRoot: string | undefined,
  fn: (officePath: string) => Promise<T>,
): Promise<T> {
  // Workspace artifact bytes live under extensionless UUID filenames, but
  // OfficeCLI infers format from the filename extension. Stage those bytes to a
  // temp file named after the logical artifact path (report.docx, data.xlsx,
  // deck.pptx) before invoking the binary. Without this, view/get/mutate on a
  // just-created workspace artifact fails with "Unsupported file type: .".
  const physicalExt = path.extname(input.physicalPath).toLowerCase();
  const logicalExt = path.extname(input.logicalPath);
  const physicalPathAlreadyNamesOfficeFormat =
    physicalExt === ".docx" || physicalExt === ".xlsx" || physicalExt === ".pptx";
  if (physicalPathAlreadyNamesOfficeFormat || logicalExt.length === 0) {
    return await fn(input.physicalPath);
  }
  const scratch = await mkdtemp(join(tempDirRoot ?? tmpdir(), "officecli-input-"));
  try {
    const safeName = basename(input.logicalPath).replace(/[^\w.-]+/g, "_");
    const copyPath = join(scratch, safeName.length > 0 ? safeName : `document${logicalExt}`);
    await writeFile(copyPath, await readFile(input.physicalPath));
    return await fn(copyPath);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function createOfficeCliTool(context?: unknown, deps: CreateOfficeCliToolDeps = {}) {
  const ctx = contextFromUnknown(context);
  return new DynamicStructuredTool({
    name: "officecli",
    description: `Headless OfficeCLI reading, validation, authoring, and rendering for closed .docx, .xlsx, and .pptx files.

To read a complete closed document, use command=view with mode=text and omit start, end, maxLines, and limit. The JSON returnedElements field is the exact number of emitted records; the vendor totalElements field may also count non-content OOXML structure. Use this tool for generate-from-scratch, closed-file edits, validation, and render/look/fix loops. It is NOT the interactive editor path: when a Writer/Spreadsheet/Slides mini-app is open, use an available app-specific interactive editor tool or close the editor first.

Format is inferred from the file extension unless a command needs an explicit format. Prefer intent-level L1 commands first, then L2 object paths, then L3 raw/raw_set/add_part only when help shows the property or OOXML part you need. Use help for prop discovery. Use view screenshot or view issues to render, inspect, and fix.

Workspace writes are zero-clobber when out differs from path (new artifact). To edit a closed workspace file in place, omit out or set out equal to path. Open editor sessions still lock out mutations. The commands batch array is capped at 50 operations per call; this does not limit document elements or read results.

Help grammar: command=help with format, legacy type, or a .docx/.xlsx/.pptx path. Omit verb for create or general format help; help verbs are add, set, get, query, and remove, with optional element. One-call Markdown DOCX: {"command":"create","out":"report.docx","commands":[{"command":"add","parent":"/body","type":"markdown","props":{"markdown":"# Title\\n\\nBody text"}}]}. The markdown add element expands supported Markdown into native Word elements; it is not a convert format. Top-level data is merge-only.`,
    schema: OfficeCliSchema,
    func: async (args: OfficeCliArgs) => {
      if (args.command === "create" && args.data !== undefined) {
        return error(OFFICECLI_CREATE_DATA_ERROR);
      }
      if (isRelayZone(args.zone)) {
        if (args.command === "help") {
          return dispatchLocalOfficeCli(args, ctx, deps);
        }
        if (args.command === "create") {
          return dispatchLocalOfficeCli(args, ctx, deps);
        }
        const inputPath = args.path;
        if (!inputPath) {
          return error(`'${args.command}' requires path for local-zone officecli`);
        }
        // Match workspace: omit out ⇒ in-place overwrite of path.
        const relayArgs: OfficeCliArgs =
          isWriteCommand(args.command) && !args.out
            ? { ...args, out: inputPath }
            : args;
        const argv = buildDirectArgv(relayArgs, inputPath);
        if ("error" in argv) return error(argv.error);
        return dispatchLocalOfficeCli(relayArgs, ctx, deps, { path: inputPath });
      }

      const run = makeRun(deps);
      if ("error" in run) return error(run.error);

      let facts: EnvelopeFacts | null = null;
      if (args.zone === "workspace") {
        const factsResult = workspaceFacts(ctx);
        if ("error" in factsResult) return error(factsResult.error);
        facts = factsResult;
      }

      try {
        if (args.command === "help") {
          const format = resolveOfficeHelpFormat(args);
          if (!format) return error(OFFICE_HELP_FORMAT_ERROR);
          const result = await run(buildHelpArgv({
            format: format as OfficeDocType,
            ...(args.verb !== undefined ? { verb: args.verb } : {}),
            ...(args.element !== undefined ? { element: args.element } : {}),
            json: args.json !== false,
          }));
          if (result.exitCode !== 0) return error(formatOfficeHelpFailure(result));
          return result.stdout;
        }

        if (args.command === "create") {
          const out = requireNonEmpty(args.out, "out");
          if (typeof out !== "string") return error(out.error);
          if (args.zone === "workspace") {
            const admission = await admitWorkspaceOfficeCliMutation(
              out,
              undefined,
              facts!,
              deps,
            );
            if (admission) return error(admission.error);
          }
          const images = await prepareOfficeCliImages(args, ctx, facts, deps);
          if ("error" in images) return error(images.error);
          try {
            const generated = await generateOffice({
              fileName: basename(out),
              commands: [...asBatchCommands(args.commands), ...images.commands],
              run,
              ...(args.locale !== undefined ? { locale: args.locale } : {}),
              ...(args.force !== undefined ? { force: args.force } : {}),
              ...(args.minimal !== undefined ? { minimal: args.minimal } : {}),
              ...(deps.tempDirRoot !== undefined ? { tempDirRoot: deps.tempDirRoot } : {}),
            });
            return await applyGeneratedBytes(
              args,
              ctx,
              facts,
              generated.bytes,
              deps,
              { ...args, officecliImages: images.metadata },
            );
          } finally {
            await images.cleanup();
          }
        }

        const input = await resolveInputPath(args, ctx, facts, deps);
        if ("error" in input) return error(input.error);
        const lockout = enforceWorkspaceLockout(args, ctx, input, deps);
        if (lockout) return lockout;

        if (!isWriteCommand(args.command)) {
          return await withOfficeReadableInput(input, deps.tempDirRoot, async (officePath) => {
            return await runDirectRead(args, run, officePath);
          });
        }

        // In-place = omit out or out === path. A distinct out keeps zero-clobber.
        const effectiveOut = args.out ?? args.path;
        if (!effectiveOut) {
          return error(
            `'${args.command}' requires path (and optional out). Omit out or set out equal to path to edit in place; pass a different out to mint a new artifact.`,
          );
        }
        const writeArgs: OfficeCliArgs = { ...args, out: effectiveOut };
        if (args.zone === "workspace") {
          const admission = await admitWorkspaceOfficeCliMutation(
            effectiveOut,
            args.path,
            facts!,
            deps,
          );
          if (admission) return error(admission.error);
        }
        const images = await prepareOfficeCliImages(writeArgs, ctx, facts, deps);
        if ("error" in images) return error(images.error);
        try {
          const mutationArgs = argsWithImageBatchCommands(writeArgs, images.commands);
          if ("error" in mutationArgs) return error(mutationArgs.error);
          const bytes = await withOfficeReadableInput(input, deps.tempDirRoot, async (officePath) => {
            return await withTempCopy(officePath, deps.tempDirRoot, async (copyPath) => {
              return await runDirectMutation(mutationArgs, run, copyPath);
            });
          });
          if ("error" in bytes) return error(bytes.error);
          return await applyGeneratedBytes(
            writeArgs,
            ctx,
            facts,
            bytes,
            deps,
            { ...writeArgs, officecliImages: images.metadata },
            input.workspaceSnapshot,
          );
        } finally {
          await images.cleanup();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return error(`officecli ${args.command} failed: ${msg}`);
      }
    },
  });
}
