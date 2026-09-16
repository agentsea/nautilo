import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ToolCatalog, ToolRegistration } from "@nautilo/catalog";
import { getToolCatalog } from "@nautilo/catalog";
import { warn } from "@nautilo/logger";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { findArtifactByInternalIdForNamespaces } from "@nautilo/db";
import { envelopeMutableNamespaces } from "@nautilo/trust";
import {
  envelopeFactsForArtifacts,
  physicalPathFromStorageUri,
  resolveWorkspaceArtifact,
} from "@nautilo/agent";
import { z, type ZodTypeAny } from "zod";
import { buildMiniApp } from "./app-builder";
import {
  generateMiniAppAgentToolName,
  type MiniAppAgentToolManifest,
  type MiniAppManifest,
} from "./app-manifest";
import { scanInstalledApps, type RegisteredMiniApp } from "./app-registry";
import {
  invokeAppTool,
  type AppToolRunnerOptions,
} from "./app-tool-runner";
import type {
  AppToolInvokeRequest,
  AppToolInvokeResult,
  AppToolPlatformFailure,
  AppToolRunnerContext,
  AppToolCurrentFileIdentityResolver,
  AppToolWorkspaceArtifactResolver,
  LiveBoundCanonicalReadResult,
  LiveCurrentFileCanonicalReader,
} from "./app-tool-types";
import type {
  LiveMiniAppSessionBinding,
  LiveMiniAppSessionRegistry,
} from "./live-mini-app-session-registry";
import { officeCliAvailable } from "@nautilo/config/officecli";
import "./first-party-live-review-extensions";
import type { LiveDocumentVersion } from "@nautilo/types";
import { parseLiveDocumentVersion, parseNonNegativeSafeInteger } from "@nautilo/types";
import {
  liveMiniAppSessionRegistry,
} from "./live-mini-app-session-registry";
import {
  getLiveAppSessionExtension,
  isDirectMutationLiveReviewExtension,
  isProposalLiveReviewExtension,
} from "./live-review-extension-registry";
import type { LiveLocalDocumentAuthority } from "./live-local-document-authority";
import {
  recordTaskWriterReviewReadCoverage,
  registerTaskWriterReviewProposal,
} from "@nautilo/runtime";

/**
 * The shared reader contract intentionally stays conservative for Current
 * Folder. Artifact reads can safely identify their authoritative revision, so
 * the registration boundary carries that bounded recovery fact locally.
 */
type LiveCanonicalReadResult =
  | LiveBoundCanonicalReadResult
  | {
      ok: false;
      status: "stale_version";
      currentDocumentVersion: LiveDocumentVersion;
      canonicalContent: string;
    };

export type AppToolRegistrationResult =
  | { status: "registered"; appId: string; sourceServer: string; toolCount: number; toolNames: string[] }
  | { status: "none"; appId: string }
  | { status: "skipped"; appId: string; reason: string };

export type RegisterAppToolsOptions = {
  catalog?: ToolCatalog | null;
  invoke?: (request: AppToolInvokeRequest, options?: AppToolRunnerOptions) => Promise<AppToolInvokeResult>;
  /**
   * Override the OfficeCLI availability check used to platform-gate
   * tools that declare `officeTransform`. Defaults to `officeCliAvailable()` from
   * `@nautilo/config/officecli`. Exposed for tests; production callers should
   * leave this unset so the real probe runs.
   */
  officeCliAvailable?: () => boolean;
  /** Override only for focused live-session registration tests. */
  liveSessionRegistry?: Pick<
    LiveMiniAppSessionRegistry,
    | "validateForSubject"
    | "validateOpenForSubject"
    | "refresh"
    | "hasOpenSessionForArtifact"
    | "issueLocator"
    | "validateLocator"
    | "registerProposal"
    | "completeProposalReview"
    | "claimDirectMutation"
    | "completeDirectMutation"
    | "abortDirectMutation"
  >;
  /**
   * Resolves a live-review mutation target through the authorized mutable
   * namespace envelope. Exposed only for focused registration tests.
   */
  resolveLiveReviewMutationTarget?: AppToolWorkspaceArtifactResolver;
  /** Test seam for the server-authoritative canonical read across live bindings. */
  readLiveCanonical?: (
    binding: LiveMiniAppSessionBinding,
    context: AppToolRunnerContext,
  ) => Promise<LiveCanonicalReadResult>;
  /** Test seam for pinned-relay Current Folder canonical reads. */
  readLiveCanonicalCurrentFile?: LiveCurrentFileCanonicalReader;
  resolveLiveCurrentFileIdentity?: AppToolCurrentFileIdentityResolver;
};

export function createLiveAppToolRegistrationOptions(
  getAuthority: () => LiveLocalDocumentAuthority | null,
): Pick<
  RegisterAppToolsOptions,
  "readLiveCanonicalCurrentFile" | "resolveLiveCurrentFileIdentity"
> {
  return {
    readLiveCanonicalCurrentFile: async (binding) => {
      const authority = getAuthority();
      if (!authority) return { ok: false, status: "session_closed" };
      const read = await authority.readCurrentFileCanonical(binding);
      return read.ok
        ? { ok: true, content: read.content }
        : { ok: false, status: read.status };
    },
    resolveLiveCurrentFileIdentity: async (input) => {
      const authority = getAuthority();
      if (!authority) throw new Error("Live local document authority is unavailable.");
      const identity = await authority.resolveCanonicalTargetIdentity(input);
      if (!identity.ok) {
        if (identity.code === "not_found") return null;
        throw new Error("Unable to resolve canonical local mutation identity.");
      }
      return identity.canonicalTargetIdentity;
    },
  };
}

type JsonSchema = Record<string, unknown>;

/**
 * Returns true when the given tool should be EXCLUDED from the registered
 * agent-tool set because it requires OfficeCLI and OfficeCLI is not available
 * on this host.
 */
function isToolGatedByOfficeCli(
  tool: MiniAppAgentToolManifest,
  officeCliAvailableResult: boolean,
): boolean {
  if (officeCliAvailableResult) return false;
  return tool.officeTransform !== undefined;
}

/** Browser-prepared exports receive their bytes from the mounted app frame. */
function browserPreparedExportToolIds(manifest: MiniAppManifest): ReadonlySet<string> {
  return new Set(
    (manifest.conversions?.export ?? [])
      .filter((conversion) => conversion.prepareInApp === true)
      .map((conversion) => conversion.tool),
  );
}

function literalSchema(value: unknown): ZodTypeAny {
  if (value === null) return z.null();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return z.literal(value);
  }
  return z.unknown();
}

function enumSchema(values: unknown[]): ZodTypeAny {
  const literals = values.map(literalSchema);
  if (literals.length === 0) return z.never();
  if (literals.length === 1) return literals[0]!;
  return z.union(literals as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function typeSchema(typeValue: unknown, schema: JsonSchema): ZodTypeAny {
  if (Array.isArray(typeValue)) {
    const variants = typeValue.map((entry) => typeSchema(entry, schema));
    if (variants.length === 0) return z.unknown();
    if (variants.length === 1) return variants[0]!;
    return z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  switch (typeValue) {
    case "string": {
      let value = z.string();
      if (typeof schema["minLength"] === "number") value = value.min(schema["minLength"]);
      if (typeof schema["maxLength"] === "number") value = value.max(schema["maxLength"]);
      return value;
    }
    case "number":
    case "integer": {
      let value = typeValue === "integer" ? z.number().int() : z.number();
      if (typeof schema["minimum"] === "number") value = value.min(schema["minimum"]);
      if (typeof schema["exclusiveMinimum"] === "number") value = value.gt(schema["exclusiveMinimum"]);
      if (typeof schema["maximum"] === "number") value = value.max(schema["maximum"]);
      if (typeof schema["exclusiveMaximum"] === "number") value = value.lt(schema["exclusiveMaximum"]);
      return value;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const items = schema["items"];
      let value = z.array(
        items && typeof items === "object" && !Array.isArray(items)
          ? jsonSchemaToZod(items as JsonSchema)
          : z.unknown(),
      );
      if (typeof schema["minItems"] === "number") value = value.min(schema["minItems"]);
      if (typeof schema["maxItems"] === "number") value = value.max(schema["maxItems"]);
      return value;
    }
    case "object":
      return objectSchema(schema);
    default:
      if (schema["properties"] && typeof schema["properties"] === "object") {
        return objectSchema(schema);
      }
      if (schema["items"] && typeof schema["items"] === "object") {
        return typeSchema("array", schema);
      }
      return z.unknown();
  }
}

function objectSchema(schema: JsonSchema): ZodTypeAny {
  const propertiesRaw = schema["properties"];
  const properties =
    propertiesRaw && typeof propertiesRaw === "object" && !Array.isArray(propertiesRaw)
      ? (propertiesRaw as Record<string, JsonSchema>)
      : {};
  const requiredRaw = schema["required"];
  const required = new Set(Array.isArray(requiredRaw) ? requiredRaw.filter((entry) => typeof entry === "string") : []);

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    const child = jsonSchemaToZod(value);
    shape[key] = required.has(key) ? child : child.optional();
  }

  const object = z.object(shape);
  return schema["additionalProperties"] === false ? object.strict() : object.passthrough();
}

export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return z.unknown();
  const record = schema as JsonSchema;
  if ("const" in record) return literalSchema(record["const"]);
  if (Array.isArray(record["enum"])) return enumSchema(record["enum"]);
  if (Array.isArray(record["oneOf"])) {
    const branches = record["oneOf"].map((branch) => jsonSchemaToZod(branch));
    if (branches.length === 0) return z.never();
    if (branches.length === 1) return branches[0]!;
    return z.union(branches as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  return typeSchema(record["type"], record);
}

function contextFromUnknown(context: unknown): AppToolRunnerContext | null {
  const raw = (context ?? {}) as Record<string, unknown>;
  const envelope = raw["memoryAccessEnvelope"];
  if (!envelope || typeof envelope !== "object") return null;

  const ownerId = typeof raw["ownerId"] === "string" ? raw["ownerId"] : "";
  const userId = typeof raw["userId"] === "string" ? raw["userId"] : ownerId;
  const agentId = typeof raw["agentId"] === "string" ? raw["agentId"] : "";
  if (!ownerId || !userId || !agentId) return null;

  return {
    ownerId,
    userId,
    agentId,
    memoryAccessEnvelope: envelope as AppToolRunnerContext["memoryAccessEnvelope"],
    ...(raw["liveMiniAppSession"] !== undefined
      ? { liveMiniAppSession: raw["liveMiniAppSession"] as NonNullable<AppToolRunnerContext["liveMiniAppSession"]> | null }
      : {}),
    ...(typeof raw["roomId"] === "string" ? { roomId: raw["roomId"] } : {}),
    ...(typeof raw["turnId"] === "string" ? { turnId: raw["turnId"] } : {}),
    ...(typeof raw["appOperationId"] === "string" ? { appOperationId: raw["appOperationId"] } : {}),
    ...(typeof raw["toolCallId"] === "string" ? { toolCallId: raw["toolCallId"] } : {}),
    ...(typeof raw["currentTaskId"] === "string" ? { currentTaskId: raw["currentTaskId"] } : {}),
    ...(typeof raw["currentTaskRunId"] === "string" ? { currentTaskRunId: raw["currentTaskRunId"] } : {}),
    ...(typeof raw["currentFolder"] === "string" ? { currentFolder: raw["currentFolder"] } : {}),
    ...(typeof raw["workspacePath"] === "string" ? { workspacePath: raw["workspacePath"] } : {}),
  };
}

function resultToToolContent(result: AppToolInvokeResult, compact = false): string {
  if (!result.ok) {
    if ((result.completedHostMutations?.length ?? 0) > 0) {
      return JSON.stringify({
        ok: false,
        status: "completed_host_mutation",
        error: result.error,
        code: result.code ?? "tool_error",
        stateChanged: true,
        retrySafe: false,
        completedHostMutations: result.completedHostMutations,
      });
    }
    if (result.code === "direct_mutation") {
      return JSON.stringify(result.directMutationFailure);
    }
    return `Error executing app tool: ${result.error}`;
  }
  if (typeof result.result === "string") return result.result;
  return compact ? JSON.stringify(result.result) : JSON.stringify(result.result, null, 2);
}

const LIVE_SESSION_VALIDATED_SENTINEL = "server-validated-live-session";

function liveReviewGateFailure(
  status: "session_closed" | "stale_version",
  currentDocumentVersion?: LiveDocumentVersion,
): string {
  if (status === "stale_version" && currentDocumentVersion?.kind === "artifact_revision") {
    return JSON.stringify({
      ok: false,
      status,
      stateChanged: false,
      retrySafe: true,
      recovery: {
        action: "reinspect",
        documentVersion: cloneLiveDocumentVersion(currentDocumentVersion),
      },
    });
  }
  return JSON.stringify({ ok: false, status });
}

function parseLiveToolDocumentVersion(args: Record<string, unknown>): LiveDocumentVersion | null {
  const parsed = parseLiveDocumentVersion(args["documentVersion"]);
  if (parsed) return parsed;
  const legacyRevision = parseNonNegativeSafeInteger(args["baseRevision"]);
  if (legacyRevision !== null) {
    return { kind: "artifact_revision", revision: legacyRevision };
  }
  return null;
}

function cloneLiveDocumentVersion(version: LiveDocumentVersion): LiveDocumentVersion {
  if (version.kind === "artifact_revision") {
    return { kind: "artifact_revision", revision: version.revision };
  }
  return { kind: "local_sha", sha256: version.sha256 };
}

/** Writer's proposal handlers still emit legacy artifact baseRevision echoes. */
function withWorkerVersionLegacyShim(
  binding: LiveMiniAppSessionBinding,
  invokeArgs: Record<string, unknown>,
  includeLegacyArtifactRevision: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...invokeArgs,
    documentVersion: cloneLiveDocumentVersion(binding.documentVersion),
  };
  if (includeLegacyArtifactRevision && binding.targetKind === "artifact") {
    next["baseRevision"] = binding.documentVersion.revision;
  }
  return next;
}

async function readBoundLiveArtifactCanonical(
  binding: Extract<LiveMiniAppSessionBinding, { targetKind: "artifact" }>,
  context: AppToolRunnerContext,
): Promise<LiveCanonicalReadResult> {
  const namespaces = envelopeMutableNamespaces(context.memoryAccessEnvelope);
  const artifact = await findArtifactByInternalIdForNamespaces({
    internalId: binding.artifactId,
    readableNamespaceIds: namespaces,
  });
  if (!artifact) return { ok: false, status: "session_closed" };
  if (artifact.revision !== binding.documentVersion.revision) {
    const physicalPath = physicalPathFromStorageUri(artifact.storageUri);
    if (!physicalPath) return { ok: false, status: "session_closed" };
    try {
    return {
      ok: false,
      status: "stale_version",
      currentDocumentVersion: {
        kind: "artifact_revision",
        revision: artifact.revision,
      },
      canonicalContent: (await readFile(physicalPath)).toString("utf8"),
    };
    } catch {
      return { ok: false, status: "session_closed" };
    }
  }
  const physicalPath = physicalPathFromStorageUri(artifact.storageUri);
  if (!physicalPath) return { ok: false, status: "session_closed" };
  try {
    return { ok: true, content: (await readFile(physicalPath)).toString("utf8") };
  } catch {
    return { ok: false, status: "session_closed" };
  }
}

async function readBoundLiveCanonical(
  binding: LiveMiniAppSessionBinding,
  context: AppToolRunnerContext,
  readCurrentFile: LiveCurrentFileCanonicalReader | null,
): Promise<LiveCanonicalReadResult> {
  if (binding.targetKind === "artifact") {
    return readBoundLiveArtifactCanonical(binding, context);
  }
  if (!readCurrentFile) return { ok: false, status: "session_closed" };
  return readCurrentFile(binding, context);
}

async function resolveAuthorizedWorkspaceMutationTarget(
  workspacePath: string,
  context: AppToolRunnerContext,
): Promise<string | null> {
  const facts = envelopeFactsForArtifacts(context.memoryAccessEnvelope);
  if (!facts.ok) return null;
  const resolution = await resolveWorkspaceArtifact({
    logicalPath: workspacePath,
    facts: facts.facts,
    intent: "mutate",
  });
  return resolution.ok && resolution.artifact ? resolution.artifact.id : null;
}

function platformFailure(
  code: AppToolPlatformFailure["code"],
  status: AppToolPlatformFailure["status"] = "session_closed",
): AppToolPlatformFailure {
  return { kind: "live_review", code, status };
}

function platformFailureToToolContent(failure: AppToolPlatformFailure): string {
  return liveReviewGateFailure(failure.status);
}

function invalidReviewProposal(error: {
  code: string;
  operationIndex?: number;
  conflictingOperationIndexes?: number[];
  message: string;
}): string {
  const operationIndex = error.operationIndex ?? 0;
  const recovery = error.code === "anchor_ambiguous"
    ? " Use the live-review locator tool with bounded anchors, then resubmit using its locator handle."
    : "";
  return JSON.stringify({
    ok: false,
    status: "proposal_invalid",
    code: error.code,
    operationIndex,
    ...("conflictingOperationIndexes" in error ? { conflictingOperationIndexes: error.conflictingOperationIndexes } : {}),
    message: `Operation ${operationIndex}: ${error.message}.${recovery}`,
  });
}

const DIRECT_MUTATION_OPERATIONS_MAX_BYTES = 256 * 1024;
const DIRECT_MUTATION_OPERATIONS_MAX_NODES = 10_000;
const DIRECT_MUTATION_OPERATIONS_MAX_DEPTH = 64;

function canonicalJsonValue(
  value: unknown,
  state: { nodes: number },
  depth: number,
): unknown {
  state.nodes += 1;
  if (
    state.nodes > DIRECT_MUTATION_OPERATIONS_MAX_NODES ||
    depth > DIRECT_MUTATION_OPERATIONS_MAX_DEPTH
  ) {
    throw new Error("Direct mutation operations exceed the fingerprint bound.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalJsonValue(entry, state, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      canonical[key] = canonicalJsonValue(record[key], state, depth + 1);
    }
    return canonical;
  }
  throw new Error("Direct mutation operations must be JSON values.");
}

function directMutationOperationFingerprint(
  operations: unknown,
  preconditions: unknown,
): string | null {
  if (!Array.isArray(operations)) return null;
  try {
    const canonical = JSON.stringify(canonicalJsonValue(
      preconditions === undefined ? { operations } : { operations, preconditions },
      { nodes: 0 },
      0,
    ));
    if (Buffer.byteLength(canonical, "utf8") > DIRECT_MUTATION_OPERATIONS_MAX_BYTES) {
      return null;
    }
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return null;
  }
}

const MAX_STALE_SEMANTIC_CONFLICTS = 64;
const MAX_STALE_SEMANTIC_PROPERTY_GROUPS = 16;
const MAX_STALE_SEMANTIC_HANDLE_LENGTH = 512;
const MAX_STALE_SEMANTIC_PROPERTY_GROUP_LENGTH = 64;
const MAX_STALE_SEMANTIC_CONFLICT_SCAN = 256;

function staleSemanticConflictToToolContent(conflict: unknown): string {
  const rawConflicts =
    conflict !== null &&
    typeof conflict === "object" &&
    Array.isArray((conflict as Record<string, unknown>)["conflicts"])
      ? (conflict as { conflicts: unknown[] }).conflicts
      : [];
  const conflicts: Array<{ handle: string; propertyGroups: string[] }> = [];
  for (const candidate of rawConflicts.slice(0, MAX_STALE_SEMANTIC_CONFLICT_SCAN)) {
    if (conflicts.length >= MAX_STALE_SEMANTIC_CONFLICTS) break;
    if (candidate === null || typeof candidate !== "object") continue;
    const handle = (candidate as Record<string, unknown>)["handle"];
    const propertyGroups = (candidate as Record<string, unknown>)["propertyGroups"];
    const safePropertyGroups = Array.isArray(propertyGroups)
      ? propertyGroups.filter(
          (group): group is string =>
            typeof group === "string" &&
            group.length > 0 &&
            group.length <= MAX_STALE_SEMANTIC_PROPERTY_GROUP_LENGTH,
        )
      : [];
    if (
      typeof handle !== "string" ||
      handle.length === 0 ||
      handle.length > MAX_STALE_SEMANTIC_HANDLE_LENGTH ||
      !Array.isArray(propertyGroups) ||
      propertyGroups.length === 0 ||
      propertyGroups.length > MAX_STALE_SEMANTIC_PROPERTY_GROUPS ||
      safePropertyGroups.length !== propertyGroups.length
    ) {
      continue;
    }
    conflicts.push({ handle, propertyGroups: safePropertyGroups });
  }
  return JSON.stringify({
    ok: false,
    status: "semantic_conflict",
    stateChanged: false,
    retrySafe: false,
    conflicts,
    conflictCount: rawConflicts.length,
    omittedConflictCount: rawConflicts.length - conflicts.length,
    recovery: { action: "ask_user", reason: "refresh_intent" },
  });
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(freezeJsonValue);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(freezeJsonValue);
    return Object.freeze(value);
  }
  return value;
}

function frozenLiveToolArgs(toolArgs: unknown): Readonly<Record<string, unknown>> {
  return freezeJsonValue(structuredClone(toolArgs)) as Readonly<Record<string, unknown>>;
}

function directMutationClaimFailure(failure: {
  code: string;
  currentDocumentVersion?: LiveDocumentVersion;
}): string {
  if (failure.code === "session_closed" || failure.code === "stale_version") {
    return liveReviewGateFailure(failure.code, failure.currentDocumentVersion);
  }
  const status = failure.code === "idempotency_conflict"
    ? "idempotency_conflict"
    : failure.code === "idempotency_in_progress"
      ? "idempotency_in_progress"
      : "retry_later";
  return JSON.stringify({ ok: false, status, code: failure.code });
}

function successfulDirectMutationDocumentVersion(
  result: AppToolInvokeResult,
): LiveDocumentVersion | null {
  if (
    !result.ok ||
    result.result === null ||
    typeof result.result !== "object" ||
    Array.isArray(result.result) ||
    (result.result as Record<string, unknown>)["ok"] !== true
  ) {
    return null;
  }
  return parseLiveDocumentVersion(
    (result.result as Record<string, unknown>)["documentVersion"],
  );
}

function createAppToolRegistration(args: {
  app: RegisteredMiniApp;
  manifest: MiniAppManifest;
  tool: MiniAppAgentToolManifest;
  appsRoot: string;
  sourceHash: string;
  cacheDir: string;
  bundlePath: string;
  invoke: NonNullable<RegisterAppToolsOptions["invoke"]>;
  liveSessionRegistry: Pick<
    LiveMiniAppSessionRegistry,
    | "validateForSubject"
    | "validateOpenForSubject"
    | "refresh"
    | "hasOpenSessionForArtifact"
    | "issueLocator"
    | "validateLocator"
    | "registerProposal"
    | "completeProposalReview"
    | "claimDirectMutation"
    | "completeDirectMutation"
    | "abortDirectMutation"
  >;
  readLiveCanonical: NonNullable<RegisterAppToolsOptions["readLiveCanonical"]>;
  resolveLiveReviewMutationTarget: AppToolWorkspaceArtifactResolver;
  resolveLiveCurrentFileIdentity?: AppToolCurrentFileIdentityResolver;
}): ToolRegistration {
  const {
    app,
    manifest,
    tool,
    appsRoot,
    sourceHash,
    cacheDir,
    bundlePath,
    invoke,
    liveSessionRegistry,
    readLiveCanonical,
    resolveLiveReviewMutationTarget,
    resolveLiveCurrentFileIdentity,
  } = args;
  const name = generateMiniAppAgentToolName(app.id, tool.id);
  const schema = jsonSchemaToZod(tool.inputSchema);
  const registeredLiveReviewExtension = getLiveAppSessionExtension(app.id);
  let liveReviewExtension: typeof registeredLiveReviewExtension = null;
  let isLiveReviewTool = false;
  let isDirectLiveExtension = false;
  let isDirectMutationLiveTool = false;
  let registrationFailure: AppToolPlatformFailure | null = null;
  try {
    if (manifest.liveReview?.enabled === true) {
      if (registeredLiveReviewExtension === null) {
        registrationFailure = platformFailure("live_review_unregistered_extension");
      } else {
        liveReviewExtension = registeredLiveReviewExtension;
        isLiveReviewTool = registeredLiveReviewExtension.liveToolIds.includes(tool.id);
        isDirectLiveExtension = isLiveReviewTool && isDirectMutationLiveReviewExtension(registeredLiveReviewExtension);
        isDirectMutationLiveTool =
          isLiveReviewTool &&
          isDirectMutationLiveReviewExtension(registeredLiveReviewExtension) &&
          registeredLiveReviewExtension.directMutationToolIds.includes(tool.id);
      }
    } else if (registeredLiveReviewExtension?.liveToolIds.includes(tool.id)) {
      registrationFailure = platformFailure("live_review_missing_opt_in");
    }
  } catch {
    registrationFailure = platformFailure("live_review_extension_failed");
  }

  // A trusted boot-time extension, rather than an app-id branch or manifest
  // hook, defines this live surface. The metadata is descriptive only;
  // server-side session validation remains authoritative.
  const liveReviewDiscovery = isLiveReviewTool
    ? {
        tags: ["live-review", ...(isDirectLiveExtension ? ["direct-mutation"] : ["review", "proposal"])],
        discovery: isDirectLiveExtension
          ? { preferredLiveSessionWorkflow: true }
          : { preferredReviewWorkflow: true },
        guidance:
          liveReviewExtension?.guidance ??
          (isDirectLiveExtension
            ? "Use this validated active-document surface. Keep sessionToken and documentVersion in tool arguments only."
            : "Use this validated review surface for proposals. Keep sessionToken and documentVersion in tool arguments only; read bounded context and recover ambiguous text with the locator before proposing."),
      }
    : {};

  return {
    name,
    source: "plugin",
    exposure: "discoverable",
    sourceServer: `app:${app.id}:${sourceHash}`,
    category: "documents",
    discoveryCategories: ["extensions"],
    trustTier: "standard",
    impact: tool.impact,
    executor: "cloud",
    requiredCapabilities: tool.requiredCapability ? [tool.requiredCapability] : [],
    requiresApproval: tool.impact !== "read-only",
    ...(tool.approvalMode ? { approvalMode: tool.approvalMode } : {}),
    resultScanPolicy: tool.resultScanPolicy ?? "never",
    tags: ["app", "mini-app", app.id, ...("tags" in liveReviewDiscovery ? liveReviewDiscovery.tags : [])],
    ...("discovery" in liveReviewDiscovery ? { discovery: liveReviewDiscovery.discovery } : {}),
    ...("guidance" in liveReviewDiscovery ? { guidance: liveReviewDiscovery.guidance } : {}),
    factory: (context) =>
      new DynamicStructuredTool({
        name,
        description: tool.description,
        schema,
        func: async (toolArgs: unknown, _runManager, config) => {
          if (registrationFailure !== null) {
            return platformFailureToToolContent(registrationFailure);
          }
          const runnerContext = contextFromUnknown(context);
          let invokeArgs = toolArgs;
          let liveSessionId: string | null = null;
          let liveDocumentVersion: LiveDocumentVersion | null = null;
          let liveCanonicalContent: string | null = null;
          let liveMutationBinding: LiveMiniAppSessionBinding | null = null;
          let directMutationClaim: {
            token: string;
            appId: string;
            userId: string;
            sessionId: string;
            documentVersion: LiveDocumentVersion;
            idempotencyKey: string;
            operationFingerprint: string;
          } | null = null;
          let preflightedOperations: readonly unknown[] | null = null;
          let preflightedMetadata: readonly unknown[] | null = null;
          if (!runnerContext) {
            return isLiveReviewTool
              ? liveReviewGateFailure("session_closed")
              : "Error executing app tool: authenticated app tool context is unavailable.";
          }
          if (isLiveReviewTool && liveReviewExtension !== null) {
            try {
            const trustedSession = runnerContext.liveMiniAppSession;
            const hostOwnsSessionBinding =
              isDirectMutationLiveReviewExtension(liveReviewExtension) &&
              liveReviewExtension.hostOwnsSessionBinding === true;
            if (hostOwnsSessionBinding && trustedSession && trustedSession.appId !== app.id) {
              return liveReviewGateFailure("session_closed");
            }
            const request: Record<string, unknown> = {
              ...(toolArgs as Record<string, unknown>),
              ...(hostOwnsSessionBinding && trustedSession?.appId === app.id
                ? {
                    sessionToken: trustedSession.sessionToken,
                    documentVersion: cloneLiveDocumentVersion(trustedSession.documentVersion),
                  }
                : {}),
            };
            invokeArgs = request;
            let documentVersion = parseLiveToolDocumentVersion(request);
            if (
              typeof runnerContext.userId !== "string" ||
              runnerContext.userId.length === 0 ||
              typeof request["sessionToken"] !== "string" ||
              documentVersion === null
            ) {
              return liveReviewGateFailure("session_closed");
            }
            const token = request["sessionToken"];
            if (hostOwnsSessionBinding) {
              const current = liveSessionRegistry.validateOpenForSubject(token, {
                appId: app.id,
                userId: runnerContext.userId,
              });
              if (!current.ok) return liveReviewGateFailure("session_closed");
              documentVersion = cloneLiveDocumentVersion(current.binding.documentVersion);
              request["documentVersion"] = cloneLiveDocumentVersion(documentVersion);
            }
            let validation;
            if (isDirectMutationLiveTool) {
              const operationFingerprint = directMutationOperationFingerprint(
                request["operations"],
                request["preconditions"],
              );
              const hostOwnsIdempotencyKey =
                isDirectMutationLiveReviewExtension(liveReviewExtension) &&
                liveReviewExtension.hostOwnsIdempotencyKey === true;
              if (
                hostOwnsIdempotencyKey &&
                request["idempotencyKey"] === undefined &&
                operationFingerprint !== null
              ) {
                const invocationId = runnerContext.toolCallId ?? runnerContext.appOperationId;
                if (typeof invocationId === "string" && invocationId.length > 0) {
                  // Invocation identity is stable across retries; changed operations
                  // must conflict against its separately recorded fingerprint. Scope
                  // provider call IDs to the turn so later turns may reuse them.
                  request["idempotencyKey"] = `host-${createHash("sha256")
                    .update(JSON.stringify([2, app.id, runnerContext.turnId ?? null, invocationId]))
                    .digest("hex")}`;
                }
              }
              const idempotencyKey = request["idempotencyKey"];
              if (
                typeof idempotencyKey !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(idempotencyKey) ||
                operationFingerprint === null
              ) {
                return JSON.stringify({
                  ok: false,
                  status: "invalid_request",
                  code: "invalid_idempotency_request",
                });
              }
              const claim = liveSessionRegistry.claimDirectMutation(token, {
                appId: app.id,
                userId: runnerContext.userId,
                documentVersion,
                idempotencyKey,
                operationFingerprint,
              });
              if (!claim.ok) return directMutationClaimFailure(claim);
              if (claim.status === "replay") return claim.resultContent;
              validation = {
                ok: true as const,
                binding: claim.binding,
                sessionId: claim.sessionId,
              };
              directMutationClaim = {
                token,
                appId: app.id,
                userId: runnerContext.userId,
                sessionId: claim.sessionId,
                documentVersion: cloneLiveDocumentVersion(documentVersion),
                idempotencyKey,
                operationFingerprint,
              };
            } else {
              validation = liveSessionRegistry.validateForSubject(token, {
                appId: app.id,
                userId: runnerContext.userId,
                documentVersion,
              });
              if (!validation.ok) {
                return liveReviewGateFailure(
                  validation.code,
                  validation.code === "stale_version"
                    ? validation.currentDocumentVersion
                    : undefined,
                );
              }
            }
            liveSessionId = validation.sessionId;
            liveDocumentVersion = cloneLiveDocumentVersion(validation.binding.documentVersion);
            if (isDirectMutationLiveTool) liveMutationBinding = validation.binding;
            invokeArgs = withWorkerVersionLegacyShim(
              validation.binding,
              {
                ...request,
                sessionToken: LIVE_SESSION_VALIDATED_SENTINEL,
              },
              isProposalLiveReviewExtension(liveReviewExtension),
            );
            if (isLiveReviewTool) {
              const canonical = await readLiveCanonical(validation.binding, runnerContext);
              if (!canonical.ok) {
                const currentDocumentVersion = canonical.status === "stale_version" &&
                  "currentDocumentVersion" in canonical
                  ? canonical.currentDocumentVersion
                  : undefined;
                const staleCanonicalContent = "canonicalContent" in canonical
                  ? canonical.canonicalContent
                  : null;
                const semanticRebase =
                  isDirectMutationLiveTool &&
                  isDirectMutationLiveReviewExtension(liveReviewExtension) &&
                  liveReviewExtension.rebaseStaleDirectMutation !== undefined &&
                  request["preconditions"] !== undefined &&
                  currentDocumentVersion?.kind === "artifact_revision" &&
                  staleCanonicalContent !== null
                    ? liveReviewExtension.rebaseStaleDirectMutation({
                        canonicalContent: staleCanonicalContent,
                        frozenArgs: frozenLiveToolArgs(request),
                      })
                    : null;
                if (semanticRebase?.status === "semantic_conflict") {
                  if (directMutationClaim) {
                    liveSessionRegistry.abortDirectMutation(
                      directMutationClaim.token,
                      directMutationClaim,
                    );
                  }
                  return staleSemanticConflictToToolContent(semanticRebase);
                }
                const refreshed = semanticRebase?.status === "allow_current_binding" &&
                  currentDocumentVersion?.kind === "artifact_revision"
                  ? liveSessionRegistry.refresh(
                      token,
                      currentDocumentVersion,
                      validation.binding,
                    )
                  : null;
                if (refreshed?.ok) {
                  liveSessionId = refreshed.sessionId;
                  liveDocumentVersion = cloneLiveDocumentVersion(refreshed.binding.documentVersion);
                  liveMutationBinding = refreshed.binding;
                  invokeArgs = withWorkerVersionLegacyShim(
                    refreshed.binding,
                    {
                      ...request,
                      sessionToken: LIVE_SESSION_VALIDATED_SENTINEL,
                    },
                    isProposalLiveReviewExtension(liveReviewExtension),
                  );
                  liveCanonicalContent = staleCanonicalContent;
                } else {
                if (directMutationClaim) {
                  liveSessionRegistry.abortDirectMutation(
                    directMutationClaim.token,
                    directMutationClaim,
                  );
                }
                const recoveryRefresh = currentDocumentVersion?.kind === "artifact_revision"
                  ? liveSessionRegistry.refresh(
                      token,
                      currentDocumentVersion,
                      validation.binding,
                    )
                  : null;
                const latest =
                  currentDocumentVersion?.kind === "artifact_revision" &&
                  recoveryRefresh !== null &&
                  !recoveryRefresh.ok
                    ? liveSessionRegistry.validateForSubject(token, {
                        appId: app.id,
                        userId: runnerContext.userId,
                        documentVersion,
                      })
                    : null;
                return liveReviewGateFailure(
                  canonical.status,
                  recoveryRefresh?.ok
                    ? recoveryRefresh.binding.documentVersion
                    : latest?.ok === false && latest.code === "stale_version"
                      ? latest.currentDocumentVersion
                      : undefined,
                );
                }
              } else {
                liveCanonicalContent = canonical.content;
              }
              if (!isProposalLiveReviewExtension(liveReviewExtension) || tool.id !== liveReviewExtension.proposalToolId) {
                invokeArgs = {
                  ...(invokeArgs as Record<string, unknown>),
                  __canonicalContent: liveCanonicalContent,
                };
              }
            }
            if (isProposalLiveReviewExtension(liveReviewExtension) && tool.id === liveReviewExtension.proposalToolId) {
              const operations = (invokeArgs as { operations?: unknown[] }).operations;
              if (Array.isArray(operations)) {
                const resolved: unknown[] = [];
                for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
                  const operation = operations[operationIndex]!;
                  const handle = liveReviewExtension.locatorHandleForOperation(operation);
                  if (handle === null) {
                    resolved.push(operation);
                    continue;
                  }
                  const locator = liveSessionRegistry.validateLocator(handle, {
                    sessionId: validation.sessionId,
                    documentVersion: validation.binding.documentVersion,
                  });
                  if (!locator.ok) return liveReviewGateFailure(locator.code);
                  const replacement = liveReviewExtension.resolveLocatorOperation(locator.payload, operation);
                  if (!replacement.ok) return liveReviewGateFailure("session_closed");
                  resolved.push(replacement.operation);
                }
                invokeArgs = { ...(invokeArgs as Record<string, unknown>), operations: resolved };
                const proposalExecution = liveReviewExtension.preflightProposal(
                  liveCanonicalContent!,
                  resolved,
                );
                if (!proposalExecution.ok) return invalidReviewProposal(proposalExecution.error);
                preflightedOperations = proposalExecution.operations;
                preflightedMetadata = proposalExecution.operationMetadata;
              }
            }
            } catch {
              if (directMutationClaim) {
                liveSessionRegistry.abortDirectMutation(
                  directMutationClaim.token,
                  directMutationClaim,
                );
              }
              return platformFailureToToolContent(platformFailure("live_review_extension_failed"));
            }
          }
          let result: AppToolInvokeResult;
          try {
            result = await invoke(
              {
              appId: app.id,
              appRoot: app.root,
              appsRoot,
              sourceHash,
              cacheDir,
              bundlePath,
              manifest,
              tool,
              args: invokeArgs,
              context: liveDocumentVersion && liveReviewExtension &&
                isDirectMutationLiveReviewExtension(liveReviewExtension) && liveReviewExtension.sessionCommands?.toolIds.includes(tool.id) && runnerContext.liveMiniAppSession
                ? { ...runnerContext, liveMiniAppSession: { ...runnerContext.liveMiniAppSession, documentVersion: liveDocumentVersion } }
                : runnerContext,
              ...(liveMutationBinding ? { liveMutationBinding } : {}),
              ...(isLiveReviewTool
                ? {
                    platformGate: {
                      kind: "live_review" as const,
                      sessionSentinel: LIVE_SESSION_VALIDATED_SENTINEL,
                      nonce: crypto.randomUUID(),
                    },
                  }
                : {}),
              },
              {
                ...(config?.signal ? { signal: config.signal } : {}),
                liveReviewArtifactId: resolveLiveReviewMutationTarget,
                ...(resolveLiveCurrentFileIdentity
                  ? { liveReviewCurrentFileIdentity: resolveLiveCurrentFileIdentity }
                  : {}),
              },
            );
          } catch (error) {
            if (directMutationClaim) {
              liveSessionRegistry.abortDirectMutation(
                directMutationClaim.token,
                directMutationClaim,
              );
            }
            throw error;
          }
          if (!result.ok && "platformFailure" in result) {
            if (directMutationClaim) {
              liveSessionRegistry.abortDirectMutation(
                directMutationClaim.token,
                directMutationClaim,
              );
            }
            return platformFailureToToolContent(result.platformFailure);
          }
          if (
            isLiveReviewTool &&
            liveReviewExtension !== null &&
            isProposalLiveReviewExtension(liveReviewExtension) &&
            liveReviewExtension.readCoverageFactFromResult !== undefined &&
            liveSessionId !== null &&
            liveDocumentVersion !== null &&
            liveCanonicalContent !== null &&
            runnerContext.currentTaskId &&
            runnerContext.currentTaskRunId &&
            result.ok &&
            result.result !== null
          ) {
            // Read coverage is first-party semantic evidence, not model input:
            // record only the app-classified structural fact for this exact
            // process-local Task/run/version. A failed/mismatched fact simply
            // leaves the eventual verification continuation incomplete.
            const coverage = liveReviewExtension.readCoverageFactFromResult({
              canonicalContent: liveCanonicalContent,
              args: invokeArgs as Record<string, unknown>,
              result: result.result,
            });
            if (coverage) {
              recordTaskWriterReviewReadCoverage({
                taskId: runnerContext.currentTaskId,
                taskRunId: runnerContext.currentTaskRunId,
                ownerId: runnerContext.ownerId,
                coverage,
              });
            }
          }
          if (
            liveReviewExtension !== null &&
            isProposalLiveReviewExtension(liveReviewExtension) &&
            tool.id === liveReviewExtension.locatorToolId &&
            liveSessionId !== null &&
            result.ok &&
            result.result
          ) {
            let locator: ReturnType<typeof liveReviewExtension.locatorPayloadFromResult>;
            try {
              locator = liveReviewExtension.locatorPayloadFromResult(result.result);
            } catch {
              return platformFailureToToolContent(platformFailure("live_review_extension_failed"));
            }
            if (!locator.ok) {
              if (locator.publicResult !== undefined) {
                result.result = locator.publicResult;
                return resultToToolContent(result);
              }
              return liveReviewGateFailure("session_closed");
            }
            const handle = liveSessionRegistry.issueLocator(
              liveSessionId,
              liveDocumentVersion!,
              locator.payload,
            );
            result.result = { ...locator.publicResult, locatorHandle: handle };
          }
          if (
            isLiveReviewTool &&
            liveReviewExtension !== null &&
            isProposalLiveReviewExtension(liveReviewExtension) &&
            tool.id === liveReviewExtension.proposalToolId &&
            liveSessionId !== null &&
            liveDocumentVersion !== null &&
            preflightedOperations !== null &&
            preflightedMetadata !== null &&
            result.ok &&
            result.result !== null &&
            typeof result.result === "object" &&
            !Array.isArray(result.result) &&
            (result.result as Record<string, unknown>)["ok"] === true &&
            (result.result as Record<string, unknown>)["status"] === "proposal_ready" &&
            Array.isArray((result.result as Record<string, unknown>)["operations"])
          ) {
            const turnId = runnerContext.turnId;
            if (typeof turnId !== "string" || turnId.length === 0) {
              return liveReviewGateFailure("session_closed");
            }
            const registration = liveSessionRegistry.registerProposal({
              sessionId: liveSessionId,
              documentVersion: liveDocumentVersion,
              agentId: runnerContext.agentId,
              turnId,
              operations: preflightedOperations,
              deliveryOperations: (result.result as Record<string, unknown>)["operations"] as unknown[],
              operationMetadata: preflightedMetadata,
            });
            if (!registration.ok) {
              return liveReviewGateFailure(
                registration.code === "missing_turn_id" ? "session_closed" : registration.code,
              );
            }
            if (
              runnerContext.currentTaskId &&
              runnerContext.currentTaskRunId &&
              !registerTaskWriterReviewProposal({
                taskId: runnerContext.currentTaskId,
                taskRunId: runnerContext.currentTaskRunId,
                ownerId: runnerContext.ownerId,
                sessionId: liveSessionId,
                proposalId: registration.proposalId,
                documentVersion: liveDocumentVersion,
              })
            ) {
              // The proposed edit never acquired a Task lifecycle owner.
              // Release this exact visible Writer slot so a later proposal
              // cannot be stranded behind a non-existent Task.
              liveSessionRegistry.completeProposalReview({
                sessionId: liveSessionId,
                proposalId: registration.proposalId,
                outcome: "rejected",
              });
              return liveReviewGateFailure("session_closed");
            }
            result.result = {
              ...(result.result as Record<string, unknown>),
              __nautiloLiveReview: {
                kind: "proposal_ready",
                appId: app.id,
                sessionId: liveSessionId,
                proposalId: registration.proposalId,
                documentVersion: cloneLiveDocumentVersion(liveDocumentVersion),
              },
            };
          }
          const resultContent = resultToToolContent(result, isLiveReviewTool);
          if (directMutationClaim) {
            const nextDocumentVersion = successfulDirectMutationDocumentVersion(result);
            if (nextDocumentVersion) {
              const completed = liveSessionRegistry.completeDirectMutation(
                directMutationClaim.token,
                directMutationClaim,
                resultContent,
                nextDocumentVersion,
              );
              if (!completed) {
                liveSessionRegistry.abortDirectMutation(
                  directMutationClaim.token,
                  directMutationClaim,
                );
              }
            } else {
              liveSessionRegistry.abortDirectMutation(
                directMutationClaim.token,
                directMutationClaim,
              );
            }
          }
          return resultContent;
        },
      }),
  };
}

function unregisterExistingAppTools(catalog: ToolCatalog, appId: string): void {
  const prefix = `app:${appId}:`;
  const sourceServers = new Set(
    catalog
      .query({ source: "plugin" })
      .map((entry) => entry.sourceServer)
      .filter((sourceServer): sourceServer is string => typeof sourceServer === "string" && sourceServer.startsWith(prefix)),
  );
  for (const sourceServer of sourceServers) {
    catalog.unregisterByServer(sourceServer);
  }
}

export async function registerAppToolsForApp(
  appsRoot: string,
  appId: string,
  options: RegisterAppToolsOptions = {},
): Promise<AppToolRegistrationResult> {
  const catalog = options.catalog ?? getToolCatalog();
  if (!catalog) return { status: "skipped", appId, reason: "tool catalog not initialized" };

  unregisterExistingAppTools(catalog, appId);

  const installed = await scanInstalledApps(appsRoot);
  const app = installed.find((entry) => entry.id === appId);
  if (!app) return { status: "none", appId };
  if (!app.enabled) {
    return { status: "skipped", appId, reason: "disabled" };
  }
  if (app.status !== "ready" || !app.manifest) {
    return { status: "skipped", appId, reason: app.error ?? app.status };
  }
  const tools = app.manifest.agent?.tools ?? [];
  if (tools.length === 0) return { status: "none", appId };

  const build = await buildMiniApp(app, appsRoot);
  if (!build.ok) return { status: "skipped", appId, reason: build.message };
  if (build.agentToolsBuild.status !== "ok") {
    return {
      status: "skipped",
      appId,
      reason:
        build.agentToolsBuild.status === "failed"
          ? build.agentToolsBuild.message
          : "app declares no agent tools",
    };
  }

  const invoke = options.invoke ?? invokeAppTool;
  const sessionRegistry = options.liveSessionRegistry ?? liveMiniAppSessionRegistry;
  const bundlePath = join(build.cacheDir, build.agentToolsBuild.outputFile);
  const officeCliAvailableFn = options.officeCliAvailable ?? officeCliAvailable;
  const officeCliAvailableResult = officeCliAvailableFn();
  const browserPreparedToolIds = browserPreparedExportToolIds(app.manifest);
  const visibleTools: MiniAppAgentToolManifest[] = [];
  const skippedForOfficeCli: string[] = [];
  for (const tool of tools) {
    if (browserPreparedToolIds.has(tool.id)) continue;
    if (isToolGatedByOfficeCli(tool, officeCliAvailableResult)) {
      skippedForOfficeCli.push(tool.id);
      continue;
    }
    visibleTools.push(tool);
  }
  if (skippedForOfficeCli.length > 0) {
    warn(
      `[app-tools] ${app.id}: hiding OfficeCLI-gated tools on unsupported host (no usable officecli binary): ${skippedForOfficeCli.join(", ")}`,
    );
  }
  if (visibleTools.length === 0) {
    catalog.refresh(`app:${app.id}:${build.sourceHash}`, []);
    return {
      status: "registered",
      appId,
      sourceServer: `app:${app.id}:${build.sourceHash}`,
      toolCount: 0,
      toolNames: [],
    };
  }
  const readCurrentFile = options.readLiveCanonicalCurrentFile ?? null;
  const resolveLiveReviewMutationTarget =
    options.resolveLiveReviewMutationTarget ?? resolveAuthorizedWorkspaceMutationTarget;
  const readCanonical =
    options.readLiveCanonical ??
    ((binding: LiveMiniAppSessionBinding, context: AppToolRunnerContext) =>
      readBoundLiveCanonical(binding, context, readCurrentFile));
  const registrations = visibleTools.map((tool) =>
    createAppToolRegistration({
      app,
      manifest: build.manifest,
      tool,
      appsRoot,
      sourceHash: build.sourceHash,
      cacheDir: build.cacheDir,
      bundlePath,
      invoke,
      liveSessionRegistry: sessionRegistry,
      readLiveCanonical: readCanonical,
      resolveLiveReviewMutationTarget,
      ...(options.resolveLiveCurrentFileIdentity
        ? { resolveLiveCurrentFileIdentity: options.resolveLiveCurrentFileIdentity }
        : {}),
    }),
  );
  const sourceServer = `app:${app.id}:${build.sourceHash}`;
  catalog.refresh(sourceServer, registrations);
  return {
    status: "registered",
    appId,
    sourceServer,
    toolCount: registrations.length,
    toolNames: registrations.map((entry) => entry.name),
  };
}

export async function registerInstalledAppTools(
  appsRoot: string,
  options: RegisterAppToolsOptions = {},
): Promise<AppToolRegistrationResult[]> {
  const catalog = options.catalog ?? getToolCatalog();
  if (!catalog) return [];
  const installed = await scanInstalledApps(appsRoot);
  const results: AppToolRegistrationResult[] = [];
  for (const app of installed) {
    try {
      results.push(await registerAppToolsForApp(appsRoot, app.id, { ...options, catalog }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`[app-tools] failed to register tools for ${app.id}: ${message}`);
      results.push({ status: "skipped", appId: app.id, reason: message });
    }
  }
  return results;
}
