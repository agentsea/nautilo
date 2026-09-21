import { parseLiveDocumentVersion } from "./api";
import { readTaskPreparation } from "./task-presentation";

export const PROTECTED_TASK_METADATA_VERSION = 1 as const;

/** Existing producer limits mirrored at the new shared classification seam. */
export const PROTECTED_TASK_ARTIFACT_REFS_MAX_ITEMS_V1 = 10;
export const PROTECTED_TASK_ARTIFACT_ID_MAX_CHARS_V1 = 256;
export const PROTECTED_TASK_ARTIFACT_PATH_MAX_CHARS_V1 = 1_024;
export const PROTECTED_TASK_ARTIFACT_TOPIC_MAX_CHARS_V1 = 128;
export const PROTECTED_TASK_LIVE_MINI_APP_ID_MAX_CHARS_V1 = 128;
export const PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1 = 512;
export const PROTECTED_TASK_CLAUDE_EXECUTION_TEXT_MAX_UTF8_BYTES_V1 = 320;
export const PROTECTED_TASK_CODEX_WORKING_DIRECTORY_MAX_UTF8_BYTES_V1 = 4_096;

export type ProtectedTaskMetadataJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly ProtectedTaskMetadataJsonValueV1[]
  | Readonly<{ [key: string]: ProtectedTaskMetadataJsonValueV1 }>;

export type ProtectedTaskMetadataProjectionV1 = Readonly<{
  [key: string]: ProtectedTaskMetadataJsonValueV1;
}>;

export type ProtectedTaskMetadataUnsupportedReasonV1 =
  | "unknown_field"
  | "malformed_field"
  | "unsupported_shape";

export type ProtectedTaskMetadataClassificationV1 =
  | Readonly<{
      status: "supported";
      version: typeof PROTECTED_TASK_METADATA_VERSION;
      operational: ProtectedTaskMetadataProjectionV1;
      protectedContent: ProtectedTaskMetadataProjectionV1;
    }>
  | Readonly<{
      status: "unsupported";
      version: typeof PROTECTED_TASK_METADATA_VERSION;
      reason: ProtectedTaskMetadataUnsupportedReasonV1;
      /** Nearest recognized container. Unknown attacker-controlled keys are never echoed. */
      path: string;
    }>;

const TOP_LEVEL_KEYS = new Set([
  "execution",
  "preparation",
  "lastInterruption",
  "deepResearch",
  "target",
  "mode",
  "publish",
  "instructions",
  "bringBack",
  "ordinaryArtifactPeer",
  "expectedArtifactPeerActorId",
  "artifactAwareAskPeer",
  "artifactRefs",
  "artifactOperationId",
  "artifactId",
  "topic",
  "source",
  "liveMiniAppTaskDelegation",
  "writerReviewAwaiting",
  "writerReviewAcceptedReceipt",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const encoder = new TextEncoder();

type MutableJsonRecord = Record<string, ProtectedTaskMetadataJsonValueV1>;
type Unsupported = Extract<ProtectedTaskMetadataClassificationV1, { status: "unsupported" }>;

function unsupported(
  reason: ProtectedTaskMetadataUnsupportedReasonV1,
  path: string,
): Unsupported {
  return Object.freeze({
    status: "unsupported",
    version: PROTECTED_TASK_METADATA_VERSION,
    reason,
    path,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return null;
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  const candidate = record(value);
  if (!candidate) return false;
  const keys = Object.keys(candidate);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(candidate, key))
    && keys.every((key) => allowed.has(key))
    && keys.length === Reflect.ownKeys(candidate).length;
}

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function boundedUtf8(value: unknown, maxBytes: number): value is string {
  return nonEmptyString(value)
    && !value.includes("\0")
    && encoder.encode(value).byteLength <= maxBytes;
}

function containsControl(value: string, includeDelete = true): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (includeDelete && code === 0x7f)) return true;
  }
  return false;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function cloneJson(
  value: unknown,
  ancestors: Set<object> = new Set(),
): ProtectedTaskMetadataJsonValueV1 | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return null;
    ancestors.add(value);
    const output: ProtectedTaskMetadataJsonValueV1[] = [];
    for (const item of value) {
      const cloned = cloneJson(item, ancestors);
      if (cloned === null && item !== null) {
        ancestors.delete(value);
        return null;
      }
      output.push(cloned);
    }
    ancestors.delete(value);
    return output;
  }
  const candidate = record(value);
  if (!candidate) return null;
  if (ancestors.has(candidate)) return null;
  ancestors.add(candidate);
  const output: MutableJsonRecord = {};
  for (const [key, item] of Object.entries(candidate)) {
    const cloned = cloneJson(item, ancestors);
    if (cloned === null && item !== null) {
      ancestors.delete(candidate);
      return null;
    }
    output[key] = cloned;
  }
  ancestors.delete(candidate);
  return output;
}

function cloneRecord(value: unknown): MutableJsonRecord | null {
  const cloned = cloneJson(value);
  return cloned !== null && typeof cloned === "object" && !Array.isArray(cloned)
    ? cloned as MutableJsonRecord
    : null;
}

function deepFreeze<T extends ProtectedTaskMetadataJsonValueV1>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function isUnsupported(value: unknown): value is Unsupported {
  return record(value)?.["status"] === "unsupported";
}

function classifyExecution(
  value: unknown,
): { operational: MutableJsonRecord; protectedContent?: MutableJsonRecord } | Unsupported {
  const execution = record(value);
  if (!execution) return unsupported("malformed_field", "$.execution");
  const harnessId = execution["harnessId"];
  if (harnessId === "codex") {
    const allowed = ["version", "harnessId", "source", "collaborationMode", "harnessModelId", "outputContract", "readiness", "workingDirectory"];
    if (unknownKeys(execution, new Set(allowed))) return unsupported("unknown_field", "$.execution");
    if (!exactKeys(execution,
      ["version", "harnessId", "source", "collaborationMode", "harnessModelId", "readiness"],
      ["outputContract", "workingDirectory"],
    )) return unsupported("malformed_field", "$.execution");
    if (execution["version"] !== 1 || execution["source"] !== "genie"
      || (execution["collaborationMode"] !== "work" && execution["collaborationMode"] !== "plan")
      || !boundedUtf8(execution["harnessModelId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)
      || !codexReadiness(execution["readiness"])
      || (execution["outputContract"] !== undefined && !codexOutputContract(execution["outputContract"]))
      || (execution["workingDirectory"] !== undefined
        && !boundedUtf8(execution["workingDirectory"], PROTECTED_TASK_CODEX_WORKING_DIRECTORY_MAX_UTF8_BYTES_V1))) {
      return unsupported("malformed_field", "$.execution");
    }
    const operational = cloneRecord(execution);
    if (!operational) return unsupported("malformed_field", "$.execution");
    delete operational["workingDirectory"];
    return {
      operational,
      ...(execution["workingDirectory"] === undefined
        ? {}
        : { protectedContent: { workingDirectory: execution["workingDirectory"] } }),
    };
  }
  if (harnessId === "claude-code") {
    const keys = ["version", "harnessId", "source", "profileRef", "catalogModelId", "selectedModel"];
    if (unknownKeys(execution, new Set(keys))) return unsupported("unknown_field", "$.execution");
    if (!exactKeys(execution, keys)
      || execution["version"] !== 1 || execution["source"] !== "genie"
      || !boundedUtf8(execution["profileRef"], PROTECTED_TASK_CLAUDE_EXECUTION_TEXT_MAX_UTF8_BYTES_V1)
      || !boundedUtf8(execution["catalogModelId"], PROTECTED_TASK_CLAUDE_EXECUTION_TEXT_MAX_UTF8_BYTES_V1)
      || !boundedUtf8(execution["selectedModel"], PROTECTED_TASK_CLAUDE_EXECUTION_TEXT_MAX_UTF8_BYTES_V1)) {
      return unsupported("malformed_field", "$.execution");
    }
    const operational = cloneRecord(execution);
    return operational ? { operational } : unsupported("malformed_field", "$.execution");
  }
  if (harnessId === "hermes-acp" || harnessId === "opencode-acp") {
    const keys = harnessId === "hermes-acp"
      ? ["version", "harnessId", "source", "readiness"]
      : ["version", "harnessId", "source", "executionProfile", "readiness"];
    if (unknownKeys(execution, new Set(keys))) return unsupported("unknown_field", "$.execution");
    if (!exactKeys(execution, keys)
      || execution["version"] !== 1 || execution["source"] !== "genie"
      || (harnessId === "opencode-acp"
        && !["interactive", "autonomous", "plan"].includes(String(execution["executionProfile"])))
      || !acpReadiness(execution["readiness"], harnessId === "hermes-acp" ? 14 : 15)) {
      return unsupported("malformed_field", "$.execution");
    }
    const operational = cloneRecord(execution);
    return operational ? { operational } : unsupported("malformed_field", "$.execution");
  }
  return unsupported("unsupported_shape", "$.execution");
}

function codexReadiness(value: unknown): boolean {
  if (!exactKeys(value, ["relayId", "pairingGenerationRef", "capabilityRevision"])) return false;
  return boundedUtf8(
    value["relayId"],
    PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
  )
    && boundedUtf8(
      value["pairingGenerationRef"],
      PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
    )
    && nonNegativeSafeInteger(value["capabilityRevision"]);
}

function codexOutputContract(value: unknown): boolean {
  if (!exactKeys(value, ["version", "capabilityModelId", "catalogVersion", "contextTokens", "outputTokens"])) return false;
  return value["version"] === 1
    && typeof value["capabilityModelId"] === "string"
    && /^openai:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value["capabilityModelId"])
    && boundedUtf8(value["catalogVersion"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)
    && positiveSafeInteger(value["contextTokens"])
    && positiveSafeInteger(value["outputTokens"])
    && value["outputTokens"] <= value["contextTokens"];
}

function acpReadiness(value: unknown, minimumProtocolVersion: 14 | 15): boolean {
  const keys = ["relayId", "relaySessionId", "pairingGenerationRef", "desktopSessionId", "selectedProtocolVersion", "capabilityRevision"];
  if (!exactKeys(value, keys)) return false;
  return keys.slice(0, 4).every((key) => boundedUtf8(value[key], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1))
    && nonNegativeSafeInteger(value["selectedProtocolVersion"])
    && value["selectedProtocolVersion"] >= minimumProtocolVersion
    && nonNegativeSafeInteger(value["capabilityRevision"]);
}

function classifyPreparation(
  value: unknown,
): { operational: MutableJsonRecord; protectedContent?: MutableJsonRecord } | Unsupported {
  const candidate = record(value);
  if (!candidate) return unsupported("malformed_field", "$.preparation");
  const allowed = new Set(["stage", "probe", "filesObserved", "directoriesObserved", "activity", "contextRecovery", "contextPage", "research", "researchWork", "taskRunId", "updatedAt"]);
  if (unknownKeys(candidate, allowed)) return unsupported("unknown_field", "$.preparation");
  for (const [key, nestedKeys] of [
    ["contextRecovery", ["pendingInputs", "phase", "recoveredInputBytes", "retainedUnconsolidatedPages"]],
    ["contextPage", ["startByte", "endByte", "totalBytes"]],
    ["research", ["unitsTotal", "unitsCompleted", "unitsPending", "filesTotal", "filesAssigned"]],
    ["researchWork", ["role", "subject", "reviewDecision"]],
  ] as const) {
    const nested = candidate[key];
    if (nested !== undefined) {
      const nestedRecord = record(nested);
      if (!nestedRecord) return unsupported("malformed_field", `$.preparation.${key}`);
      if (unknownKeys(nestedRecord, new Set(nestedKeys))) return unsupported("unknown_field", `$.preparation.${key}`);
    }
  }
  const parsed = readTaskPreparation(candidate);
  if (!parsed) return unsupported("malformed_field", "$.preparation");
  if (!boundedUtf8(
    parsed.taskRunId,
    PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
  ) || !isoTimestamp(parsed.updatedAt)) {
    return unsupported("malformed_field", "$.preparation");
  }
  const operational = cloneJson(parsed) as MutableJsonRecord;
  const subject = parsed.researchWork?.subject;
  if (subject === undefined) return { operational };
  const operationalWork = { ...operational["researchWork"] as MutableJsonRecord };
  delete operationalWork["subject"];
  operational["researchWork"] = operationalWork;
  return {
    operational,
    protectedContent: { researchWork: { subject } },
  };
}

function classifyDeepResearch(
  value: unknown,
): { operational: MutableJsonRecord; protectedContent: MutableJsonRecord } | Unsupported {
  const candidate = record(value);
  if (!candidate) return unsupported("malformed_field", "$.deepResearch");
  const keys = ["version", "reportLanguage", "modelPlan", "invokingModelId"];
  if (unknownKeys(candidate, new Set(keys))) return unsupported("unknown_field", "$.deepResearch");
  if (!exactKeys(candidate, keys) || candidate["version"] !== 1 || !nonEmptyString(candidate["reportLanguage"])
    || !(candidate["invokingModelId"] === null || boundedUtf8(candidate["invokingModelId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1))) {
    return unsupported("malformed_field", "$.deepResearch");
  }
  const plan = candidate["modelPlan"];
  const planKeys = ["version", "supervisorModel", "researchModel", "summarizationModel", "compressionModel", "finalReportModel"];
  if (!exactKeys(plan, planKeys)) {
    const planRecord = record(plan);
    return planRecord && unknownKeys(planRecord, new Set(planKeys))
      ? unsupported("unknown_field", "$.deepResearch.modelPlan")
      : unsupported("malformed_field", "$.deepResearch.modelPlan");
  }
  if (plan["version"] !== 1 || planKeys.slice(1).some((key) =>
    typeof plan[key] !== "string"
    || plan[key].trim().length === 0
    || !boundedUtf8(
      plan[key],
      PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
    )
  )) {
    return unsupported("malformed_field", "$.deepResearch.modelPlan");
  }
  return {
    operational: { version: 1, modelPlan: cloneRecord(plan), invokingModelId: candidate["invokingModelId"] },
    protectedContent: { reportLanguage: candidate["reportLanguage"] },
  };
}

function classifyLastInterruption(value: unknown): MutableJsonRecord | Unsupported {
  const candidate = record(value);
  if (!candidate) return unsupported("malformed_field", "$.lastInterruption");
  const common = ["code", "cause", "stoppedBy", "outcome", "observedAt", "taskRunId", "graphThreadId", "checkpointId"];
  const timeout = ["modelId", "attemptId", "timeoutMs", "elapsedMs", "abortRequested", "visibleOutput", "partialState", "safeToFallback"];
  const desktop = ["resumable", "desktopExitCause"];
  const noProgress = ["toolName", "operation", "resumeRequiresValidation"];
  const allowed = new Set([...common, ...timeout, ...desktop, ...noProgress]);
  if (unknownKeys(candidate, allowed)) return unsupported("unknown_field", "$.lastInterruption");
  if (!isoTimestamp(candidate["observedAt"])
    || !boundedUtf8(candidate["taskRunId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)
    || !boundedUtf8(candidate["graphThreadId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)
    || !(candidate["checkpointId"] === null || boundedUtf8(
      candidate["checkpointId"],
      PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
    ))) {
    return unsupported("malformed_field", "$.lastInterruption");
  }
  if (candidate["code"] === "relay_unavailable") {
    if (!exactKeys(candidate, [...common, "resumable", "desktopExitCause"])
      || !["desktop_disconnected", "desktop_authorization_changed"].includes(String(candidate["cause"]))
      || candidate["stoppedBy"] !== "task_runtime" || candidate["outcome"] !== "paused"
      || candidate["resumable"] !== true || candidate["desktopExitCause"] !== "unknown") {
      return unsupported("malformed_field", "$.lastInterruption");
    }
    return cloneRecord(candidate)!;
  }
  if (candidate["code"] === "NAUTILO_PROVIDER_TIMEOUT") {
    if (!exactKeys(candidate, [...common, "resumable", ...timeout])
      || !["first_progress_timeout", "progress_idle_timeout", "absolute_timeout"].includes(String(candidate["cause"]))
      || candidate["stoppedBy"] !== "task_runtime" || candidate["outcome"] !== "paused"
      || candidate["resumable"] !== true
      || !boundedUtf8(candidate["modelId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)
      || !boundedUtf8(candidate["attemptId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)
      || !nonNegativeSafeInteger(candidate["timeoutMs"])
      || !nonNegativeSafeInteger(candidate["elapsedMs"]) || candidate["abortRequested"] !== true
      || candidate["visibleOutput"] !== false || typeof candidate["partialState"] !== "boolean"
      || candidate["safeToFallback"] !== true) {
      return unsupported("malformed_field", "$.lastInterruption");
    }
    return cloneRecord(candidate)!;
  }
  if (candidate["code"] === "no_progress") {
    if (!exactKeys(candidate, [...common, ...noProgress])
      || candidate["cause"] !== "repeated_tool_failure" || candidate["stoppedBy"] !== "no_progress_guard"
      || candidate["outcome"] !== "errored" || candidate["resumeRequiresValidation"] !== true
      || typeof candidate["toolName"] !== "string" || !/^[a-z0-9_]{1,64}$/u.test(candidate["toolName"])
      || typeof candidate["operation"] !== "string"
      || !["", "start", "status", "results", "record", "finding", "cancel", "context",
        "list", "read", "grep", "stat", "write", "insert", "str_replace", "move", "copy", "delete",
        "undo", "undo_turn", "redo", "list_revisions", "pin_revision", "unpin_revision", "list_blocks",
        "read_block", "replace_block", "insert_block", "move_block", "rewrite_block", "create", "view",
        "get", "query", "set", "add", "remove", "swap", "validate", "dump", "merge", "batch", "raw",
        "raw_set", "add_part", "open", "save", "close", "refresh", "help"].includes(candidate["operation"])) {
      return unsupported("malformed_field", "$.lastInterruption");
    }
    return cloneRecord(candidate)!;
  }
  return unsupported("unsupported_shape", "$.lastInterruption");
}

function classifyArtifactRefs(value: unknown): ProtectedTaskMetadataJsonValueV1 | Unsupported {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROTECTED_TASK_ARTIFACT_REFS_MAX_ITEMS_V1) {
    return unsupported("malformed_field", "$.artifactRefs");
  }
  const items: readonly unknown[] = value;
  const output: MutableJsonRecord[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const keys = ["artifactId", "path", "mimeType", "size"];
    if (!exactKeys(item, ["artifactId", "path"], ["mimeType", "size"])) {
      const candidate = record(item);
      return candidate && unknownKeys(candidate, new Set(keys))
        ? unsupported("unknown_field", `$.artifactRefs[${index}]`)
        : unsupported("malformed_field", `$.artifactRefs[${index}]`);
    }
    if (!nonEmptyString(item["artifactId"]) || item["artifactId"].trim().length === 0
      || containsControl(item["artifactId"]) || item["artifactId"].length > PROTECTED_TASK_ARTIFACT_ID_MAX_CHARS_V1
      || typeof item["path"] !== "string" || item["path"].length > PROTECTED_TASK_ARTIFACT_PATH_MAX_CHARS_V1
      || (item["mimeType"] !== undefined && !nonEmptyString(item["mimeType"]))
      || (item["size"] !== undefined && (!nonNegativeSafeInteger(item["size"])))) {
      return unsupported("malformed_field", `$.artifactRefs[${index}]`);
    }
    output.push({ artifactId: item["artifactId"], path: item["path"],
      ...(item["mimeType"] === undefined ? {} : { mimeType: item["mimeType"] }),
      ...(item["size"] === undefined ? {} : { size: item["size"] }) });
  }
  return output;
}

function classifyWriterMarker(value: unknown, accepted: boolean): MutableJsonRecord | Unsupported {
  const candidate = record(value);
  const path = accepted ? "$.writerReviewAcceptedReceipt" : "$.writerReviewAwaiting";
  if (!candidate) return unsupported("malformed_field", path);
  const keys = ["version", "taskRunId", "proposalId", "acceptedResultRevision", "pendingWorkspaceOperationId", "pendingWorkspaceClientMutationId", "pendingWorkspaceArtifactId", "acceptedWorkspaceOperationId", "acceptedWorkspaceClientMutationId", "acceptedWorkspaceArtifactId", "verificationRunId"];
  if (unknownKeys(candidate, new Set(keys))) return unsupported("unknown_field", path);
  if (!exactKeys(candidate, ["version", "taskRunId", "proposalId"], keys.slice(3))
    || candidate["version"] !== 1
    || !boundedUtf8(candidate["taskRunId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)
    || !boundedUtf8(candidate["proposalId"], PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1)) {
    return unsupported("malformed_field", path);
  }
  const stringKeys = keys.slice(4);
  if (stringKeys.some((key) => candidate[key] !== undefined && !boundedUtf8(
    candidate[key],
    PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
  ))) {
    return unsupported("malformed_field", path);
  }
  const hasRevision = Object.hasOwn(candidate, "acceptedResultRevision");
  if (accepted && !hasRevision) return unsupported("malformed_field", path);
  if (hasRevision) {
    const revision = candidate["acceptedResultRevision"];
    const parsed = parseLiveDocumentVersion(revision);
    const expectedKeys = parsed?.kind === "artifact_revision" ? ["kind", "revision"] : ["kind", "sha256"];
    if (!parsed || !exactKeys(revision, expectedKeys)) return unsupported("unsupported_shape", `${path}.acceptedResultRevision`);
    candidate["acceptedResultRevision"] = parsed;
  }
  for (const prefix of ["pending", "accepted"] as const) {
    const triplet = [`${prefix}WorkspaceOperationId`, `${prefix}WorkspaceClientMutationId`, `${prefix}WorkspaceArtifactId`];
    const present = triplet.filter((key) => candidate[key] !== undefined).length;
    if (present !== 0 && present !== triplet.length) return unsupported("malformed_field", path);
  }
  if (accepted && ["pendingWorkspaceOperationId", "pendingWorkspaceClientMutationId", "pendingWorkspaceArtifactId"]
    .some((key) => candidate[key] !== undefined)) return unsupported("malformed_field", path);
  const cloned = cloneJson(candidate);
  return cloned && !Array.isArray(cloned) && typeof cloned === "object"
    ? cloned as MutableJsonRecord
    : unsupported("malformed_field", path);
}

/**
 * Classify only the recognized protected-Task metadata vocabulary. Empty
 * metadata is the canonical ordinary Task case; unrelated fields remain out.
 */
export function classifyProtectedTaskMetadataV1(
  input: unknown,
): ProtectedTaskMetadataClassificationV1 {
  const metadata = record(cloneJson(input));
  if (!metadata) return unsupported("unsupported_shape", "$");
  if (unknownKeys(metadata, TOP_LEVEL_KEYS)) return unsupported("unknown_field", "$");

  const intentCount = [
    Object.hasOwn(metadata, "execution"),
    Object.hasOwn(metadata, "deepResearch"),
    ["target", "mode", "publish", "instructions"].some((key) =>
      Object.hasOwn(metadata, key)
    ),
    Object.hasOwn(metadata, "bringBack"),
    [
      "ordinaryArtifactPeer",
      "expectedArtifactPeerActorId",
      "artifactAwareAskPeer",
      "artifactRefs",
      "artifactOperationId",
    ].some((key) => Object.hasOwn(metadata, key)),
    ["artifactId", "topic", "source"].some((key) =>
      Object.hasOwn(metadata, key)
    ),
  ].filter(Boolean).length;
  if (intentCount > 1) return unsupported("unsupported_shape", "$");

  const operational: MutableJsonRecord = {};
  const protectedContent: MutableJsonRecord = {};

  if (metadata["execution"] !== undefined) {
    const classified = classifyExecution(metadata["execution"]);
    if (isUnsupported(classified)) return classified;
    operational["execution"] = classified.operational;
    if (classified.protectedContent) protectedContent["execution"] = classified.protectedContent;
  }
  if (metadata["preparation"] !== undefined) {
    const classified = classifyPreparation(metadata["preparation"]);
    if (isUnsupported(classified)) return classified;
    operational["preparation"] = classified.operational;
    if (classified.protectedContent) protectedContent["preparation"] = classified.protectedContent;
  }
  if (metadata["lastInterruption"] !== undefined) {
    const classified = classifyLastInterruption(metadata["lastInterruption"]);
    if (isUnsupported(classified)) return classified;
    operational["lastInterruption"] = classified;
  }
  if (metadata["deepResearch"] !== undefined) {
    const classified = classifyDeepResearch(metadata["deepResearch"]);
    if (isUnsupported(classified)) return classified;
    operational["deepResearch"] = classified.operational;
    protectedContent["deepResearch"] = classified.protectedContent;
  }

  const repoKeys = ["target", "mode", "publish", "instructions"];
  if (repoKeys.some((key) => Object.hasOwn(metadata, key))) {
    if (!nonEmptyString(metadata["target"]) || !["init", "update", "auto"].includes(String(metadata["mode"]))
      || !["branch", "push", "pr"].includes(String(metadata["publish"]))
      || !(metadata["instructions"] === undefined || typeof metadata["instructions"] === "string")) {
      return unsupported("malformed_field", "$");
    }
    operational["mode"] = metadata["mode"] as string;
    operational["publish"] = metadata["publish"] as string;
    protectedContent["target"] = metadata["target"];
    if (metadata["instructions"] !== undefined) protectedContent["instructions"] = metadata["instructions"];
  }

  if (Object.hasOwn(metadata, "bringBack")) {
    if (typeof metadata["bringBack"] !== "boolean") return unsupported("malformed_field", "$.bringBack");
    operational["bringBack"] = metadata["bringBack"];
  }

  const peerKeys = ["ordinaryArtifactPeer", "expectedArtifactPeerActorId"];
  if (peerKeys.some((key) => Object.hasOwn(metadata, key))) {
    if (metadata["ordinaryArtifactPeer"] !== true || typeof metadata["expectedArtifactPeerActorId"] !== "string"
      || !UUID_RE.test(metadata["expectedArtifactPeerActorId"])) return unsupported("malformed_field", "$");
    operational["ordinaryArtifactPeer"] = true;
    operational["expectedArtifactPeerActorId"] = metadata["expectedArtifactPeerActorId"];
  }

  const artifactAskKeys = ["artifactAwareAskPeer", "artifactRefs", "artifactOperationId"];
  if (artifactAskKeys.some((key) => Object.hasOwn(metadata, key))) {
    if (metadata["artifactAwareAskPeer"] !== true || !nonEmptyString(metadata["artifactOperationId"])) {
      return unsupported("malformed_field", "$");
    }
    const refs = classifyArtifactRefs(metadata["artifactRefs"]);
    if (typeof refs === "object" && refs !== null && !Array.isArray(refs) && "status" in refs) return refs as Unsupported;
    operational["artifactAwareAskPeer"] = true;
    protectedContent["artifactRefs"] = refs as ProtectedTaskMetadataJsonValueV1;
    protectedContent["artifactOperationId"] = metadata["artifactOperationId"];
  }

  const pingKeys = ["artifactId", "topic", "source"];
  if (pingKeys.some((key) => Object.hasOwn(metadata, key))) {
    if (!nonEmptyString(metadata["artifactId"]) || containsControl(metadata["artifactId"])
      || metadata["artifactId"].length > PROTECTED_TASK_ARTIFACT_ID_MAX_CHARS_V1
      || !nonEmptyString(metadata["topic"]) || metadata["topic"].length > PROTECTED_TASK_ARTIFACT_TOPIC_MAX_CHARS_V1
      || containsControl(metadata["topic"], false) || metadata["source"] !== "artifact_ping") {
      return unsupported("malformed_field", "$");
    }
    operational["source"] = "artifact_ping";
    protectedContent["artifactId"] = metadata["artifactId"];
    protectedContent["topic"] = metadata["topic"];
  }

  if (metadata["liveMiniAppTaskDelegation"] !== undefined) {
    const value = metadata["liveMiniAppTaskDelegation"];
    if (!exactKeys(value, ["version", "appId"]) || value["version"] !== 1
      || !nonEmptyString(value["appId"]) || value["appId"].length > PROTECTED_TASK_LIVE_MINI_APP_ID_MAX_CHARS_V1) {
      const valueRecord = record(value);
      return valueRecord && unknownKeys(valueRecord, new Set(["version", "appId"]))
        ? unsupported("unknown_field", "$.liveMiniAppTaskDelegation")
        : unsupported("malformed_field", "$.liveMiniAppTaskDelegation");
    }
    operational["liveMiniAppTaskDelegation"] = cloneRecord(value)!;
  }

  if (metadata["writerReviewAwaiting"] !== undefined && metadata["writerReviewAcceptedReceipt"] !== undefined) {
    return unsupported("malformed_field", "$");
  }
  for (const [key, accepted] of [["writerReviewAwaiting", false], ["writerReviewAcceptedReceipt", true]] as const) {
    if (metadata[key] === undefined) continue;
    const marker = classifyWriterMarker(metadata[key], accepted);
    if (isUnsupported(marker)) return marker;
    operational[key] = marker;
  }

  const result = {
    status: "supported" as const,
    version: PROTECTED_TASK_METADATA_VERSION,
    operational: deepFreeze(operational),
    protectedContent: deepFreeze(protectedContent),
  };
  return Object.freeze(result);
}
