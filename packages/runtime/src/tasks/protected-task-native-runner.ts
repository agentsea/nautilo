import {
  runScopeSubagentUntilPause,
  type ProtectedTaskAdditionalAuthorityResumeBindingV1,
  type RunScopeSubagentOpts,
  type RunScopeSubagentResult,
} from "@nautilo/agent";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskSemanticAuthorityRequirementsDigest,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "@nautilo/db";
import type { TaskRunResultPayloadV1 } from "@nautilo/lattice-bridge";

type TaskRunCheckpointSaver = NonNullable<
  RunScopeSubagentOpts["taskRunCheckpointSaver"]
>;
type ProtectedTaskTranscriptPort = NonNullable<
  RunScopeSubagentOpts["protectedTaskTranscriptPort"]
>;
type ProtectedTaskMemoryHandoff = NonNullable<
  RunScopeSubagentOpts["protectedTaskMemoryHandoff"]
>;

/** Closed classification supplied by protected dispatch before graph work. */
export type ProtectedTaskNativeSegmentMode =
  | "native"
  | "external"
  | "repo_docs"
  | "deep_research"
  | "complex";

/** Safe graph inputs for one native protected Task segment. */
export type ProtectedTaskNativeExecution = Readonly<{
  parentThreadId: string;
  parentTurnId: string;
  parentOwnerId: string;
  causalHumanUserId: string;
  brief: string;
  expectedOutput?: string;
  toolWhitelist?: RunScopeSubagentOpts["toolWhitelist"];
  subEnvelope: RunScopeSubagentOpts["subEnvelope"];
  actorRole: string;
  assistantName: string;
  soulFile: string;
  modelId: string;
  currentFolder: string;
  workspacePath: string;
  subagentDepth: number;
  subagentMaxDepth: number;
  roomRoster: RunScopeSubagentOpts["roomRoster"];
  roomId: string;
  callingRoomId?: string;
  artifactRefs?: RunScopeSubagentOpts["artifactRefs"];
  focusedResources?: RunScopeSubagentOpts["focusedResources"];
  relayCapabilities?: RunScopeSubagentOpts["relayCapabilities"];
  resume?: unknown;
  continueFromCheckpoint?: boolean;
  awaitReply?: Readonly<{
    roomId: string;
    fromUserIds: readonly string[];
    ownerId: string;
  }>;
  modelFallbackMode?: RunScopeSubagentOpts["modelFallbackMode"];
}>;

export type RunProtectedTaskNativeSegmentInput = Readonly<{
  mode: ProtectedTaskNativeSegmentMode;
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  signal: AbortSignal;
  checkpointSaver: TaskRunCheckpointSaver;
  transcriptPort: ProtectedTaskTranscriptPort;
  /** Process-local Memory authority opened by this protected Task grant. */
  memoryHandoff: ProtectedTaskMemoryHandoff;
  /** One-shot input opened by ProtectedTaskExecutionCandidate.run. */
  transientInput: Record<string, unknown>;
  execution: ProtectedTaskNativeExecution;
}>;

export type ProtectedTaskNativeSegmentResult =
  | TaskRunResultPayloadV1
  | Readonly<{
      status: "interrupted";
      threadId: string;
      interrupt: Record<string, unknown>;
      interruptCoordinates: readonly ProtectedTaskNativeInterruptCoordinate[];
      additionalAuthority?: never;
    }>
  | Readonly<{
      status: "interrupted";
      threadId: string;
      interruptCoordinates: readonly ProtectedTaskNativeInterruptCoordinate[];
      additionalAuthority: ProtectedTaskNativeAdditionalAuthorityContinuation;
    }>
  | Readonly<{ status: "aborted" }>;

export type ProtectedTaskNativeInterruptCoordinate = Readonly<{
  id: string;
  kind: "approval" | "prove_it" | "identity" | "await_reply"
    | "additional_authority";
  requestId?: string;
}>;

export type ProtectedTaskNativeAdditionalAuthorityContinuation = Readonly<{
  kind: "pre_effect_interrupt_v1";
  reason: "additional_authority";
  effectDisposition: "not_started_v1";
  interruptId: string;
  operationId: string;
  requestDigest: Uint8Array;
  requiredAuthorityDigest: Uint8Array;
  semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
}>;

/** Immutable parked proof used to build one exact interrupt-keyed resume. */
export type ProtectedTaskNativeAdditionalAuthorityResume =
  ProtectedTaskAdditionalAuthorityResumeBindingV1;

export interface ProtectedTaskNativeRunnerDependencies {
  runScopeSubagent(
    options: RunScopeSubagentOpts,
  ): Promise<RunScopeSubagentResult>;
}

const productionDependencies: ProtectedTaskNativeRunnerDependencies =
  Object.freeze({
    runScopeSubagent: runScopeSubagentUntilPause,
  });

function exactIdentity(input: RunProtectedTaskNativeSegmentInput): void {
  if (
    input.mode !== "native"
    || typeof input.taskId !== "string"
    || input.taskId.length === 0
    || typeof input.taskRunId !== "string"
    || input.taskRunId.length === 0
    || typeof input.graphThreadId !== "string"
    || input.graphThreadId.length === 0
    || !(input.signal instanceof AbortSignal)
    || input.checkpointSaver === undefined
    || typeof input.transcriptPort?.publishBatch !== "function"
    || typeof input.memoryHandoff !== "object"
    || input.memoryHandoff === null
    || input.execution.toolWhitelist?.includes("security_scan") === true
    || input.transientInput["taskId"] !== input.taskId
    || input.transientInput["currentTaskId"] !== input.taskId
    || input.transientInput["taskRunId"] !== input.taskRunId
    || input.transientInput["turnId"] !== input.taskRunId
    || input.transientInput["graphThreadId"] !== input.graphThreadId
    || (
      input.execution.continueFromCheckpoint === true
      && input.execution.resume !== undefined
    )
  ) {
    throw new TypeError(
      "Protected native Task execution requires one exact supported segment",
    );
  }
}

export function createProtectedTaskFailurePayload(): TaskRunResultPayloadV1 {
  return Object.freeze({
    formatVersion: 1,
    resultText: null,
    lastError: "Protected Task execution failed",
  });
}

function completedPayload(resultText: string): TaskRunResultPayloadV1 {
  return Object.freeze({
    formatVersion: 1,
    resultText,
    lastError: null,
  });
}

type ExactInterruptCoordinates = Readonly<{
  coordinates: readonly ProtectedTaskNativeInterruptCoordinate[];
  additionalAuthority?: ProtectedTaskNativeAdditionalAuthorityContinuation;
}>;

function exactAdditionalAuthority(
  coordinate: Record<string, unknown>,
  id: string,
): ProtectedTaskNativeAdditionalAuthorityContinuation {
  if (Object.keys(coordinate).sort().join(",") !== [
    "id",
    "kind",
    "effectDisposition",
    "operationId",
    "requestDigest",
    "requestId",
    "requiredAuthorityDigest",
    "semanticAuthorityRequirements",
  ].sort().join(",")) {
    throw new TypeError("Protected native Task interruption has invalid coordinates");
  }
  const operationId = coordinate["operationId"];
  const effectDisposition = coordinate["effectDisposition"];
  const requestDigest = coordinate["requestDigest"];
  const requiredAuthorityDigest = coordinate["requiredAuthorityDigest"];
  const requirements = coordinate["semanticAuthorityRequirements"];
  if (effectDisposition !== "not_started_v1"
    || typeof operationId !== "string" || operationId.trim().length === 0
    || !(requestDigest instanceof Uint8Array) || requestDigest.length !== 32
    || !(requiredAuthorityDigest instanceof Uint8Array)
    || requiredAuthorityDigest.length !== 32) {
    throw new TypeError("Protected native Task interruption has invalid coordinates");
  }
  let semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  try {
    semanticAuthorityRequirements =
      canonicalProtectedTaskSemanticAuthorityRequirements(requirements);
    const digest = protectedTaskSemanticAuthorityRequirementsDigest(
      semanticAuthorityRequirements,
    );
    const matches = digest.length === requiredAuthorityDigest.length
      && digest.every((byte, index) => byte === requiredAuthorityDigest[index]);
    digest.fill(0);
    if (!matches) throw new TypeError("authority digest mismatch");
  } catch {
    throw new TypeError("Protected native Task interruption has invalid coordinates");
  }
  return Object.freeze({
    kind: "pre_effect_interrupt_v1" as const,
    reason: "additional_authority" as const,
    effectDisposition,
    interruptId: id,
    operationId,
    requestDigest: requestDigest.slice(),
    requiredAuthorityDigest: requiredAuthorityDigest.slice(),
    semanticAuthorityRequirements,
  });
}

function exactInterruptCoordinates(
  value: unknown,
): ExactInterruptCoordinates {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      "Protected native Task interruption requires durable coordinates",
    );
  }
  const seenIds = new Set<string>();
  const coordinates: ProtectedTaskNativeInterruptCoordinate[] = [];
  let additionalAuthority:
    | ProtectedTaskNativeAdditionalAuthorityContinuation
    | undefined;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("Protected native Task interruption has invalid coordinates");
    }
    const coordinate = candidate as Record<string, unknown>;
    const id = coordinate["id"];
    const kind = coordinate["kind"];
    const requestId = coordinate["requestId"];
    if (
      typeof id !== "string"
      || id.trim().length === 0
      || seenIds.has(id)
      || (
        kind !== "approval"
        && kind !== "prove_it"
        && kind !== "identity"
        && kind !== "await_reply"
        && kind !== "additional_authority"
      )
      || (
        requestId !== undefined
        && (typeof requestId !== "string" || requestId.trim().length === 0)
      )
      || (kind === "approval" && requestId === undefined)
      || ((kind === "prove_it" || kind === "await_reply") && requestId !== undefined)
      || (kind === "additional_authority" && requestId === undefined)
    ) {
      throw new TypeError("Protected native Task interruption has invalid coordinates");
    }
    if (kind === "additional_authority") {
      if (additionalAuthority !== undefined) {
        throw new TypeError("Protected native Task interruption has invalid coordinates");
      }
      additionalAuthority = exactAdditionalAuthority(coordinate, id);
    } else if (Object.keys(coordinate).some((key) =>
      key !== "id" && key !== "kind" && key !== "requestId"
    )) {
      throw new TypeError("Protected native Task interruption has invalid coordinates");
    }
    seenIds.add(id);
    coordinates.push(Object.freeze({
      id,
      kind,
      ...(requestId === undefined ? {} : { requestId }),
    }));
  }
  coordinates.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return Object.freeze({
    coordinates: Object.freeze(coordinates),
    ...(additionalAuthority === undefined ? {} : { additionalAuthority }),
  });
}

function runnerOptions(
  input: RunProtectedTaskNativeSegmentInput,
): RunScopeSubagentOpts {
  const execution = input.execution;
  return {
    parentThreadId: execution.parentThreadId,
    parentTurnId: execution.parentTurnId,
    parentOwnerId: execution.parentOwnerId,
    causalHumanUserId: execution.causalHumanUserId,
    brief: execution.brief,
    ...(execution.expectedOutput === undefined
      ? {}
      : { expectedOutput: execution.expectedOutput }),
    ...(execution.toolWhitelist === undefined
      ? {}
      : { toolWhitelist: [...execution.toolWhitelist] }),
    subEnvelope: execution.subEnvelope,
    actorRole: execution.actorRole,
    assistantName: execution.assistantName,
    soulFile: execution.soulFile,
    modelId: execution.modelId,
    currentFolder: execution.currentFolder,
    workspacePath: execution.workspacePath,
    subagentDepth: execution.subagentDepth,
    subagentMaxDepth: execution.subagentMaxDepth,
    securityAuditClientMeta: null,
    roomRoster: [...execution.roomRoster],
    roomId: execution.roomId,
    ...(execution.callingRoomId === undefined
      ? {}
      : { callingRoomId: execution.callingRoomId }),
    ...(execution.artifactRefs === undefined
      ? {}
      : { artifactRefs: [...execution.artifactRefs] }),
    ...(execution.focusedResources === undefined
      ? {}
      : { focusedResources: [...execution.focusedResources] }),
    ...(execution.relayCapabilities === undefined
      ? {}
      : { relayCapabilities: execution.relayCapabilities }),
    ...(execution.resume === undefined ? {} : { resume: execution.resume }),
    ...(execution.continueFromCheckpoint === true
      ? { continueFromCheckpoint: true }
      : {}),
    ...(execution.awaitReply === undefined
      ? {}
      : {
          awaitResponse: true,
          awaitRoomId: execution.awaitReply.roomId,
          awaitFromUserIds: [...execution.awaitReply.fromUserIds],
          awaitTaskId: input.taskId,
          awaitTaskRunId: input.taskRunId,
          awaitOwnerId: execution.awaitReply.ownerId,
        }),
    ...(execution.modelFallbackMode === undefined
      ? {}
      : { modelFallbackMode: execution.modelFallbackMode }),
    taskRun: true,
    trustedExecutionEntrypoint: "background.task",
    currentTaskId: input.taskId,
    currentTaskRunId: input.taskRunId,
    subagentThreadId: input.graphThreadId,
    approvalLaneKey: `task:${input.taskId}`,
    taskRunCheckpointSaver: input.checkpointSaver,
    protectedTaskTranscriptPort: input.transcriptPort,
    protectedTaskMemoryHandoff: input.memoryHandoff,
    signal: input.signal,
  };
}

/**
 * Runs one protected native graph segment without ordinary Task completion,
 * checkpoint, transcript, Room-event, or artifact-card publication paths.
 * Return the terminal payload to the grant owner: it must first close the
 * running-Task repository/definition/checkpoint owners, then await protected
 * result publication before releasing the grant. Publishing inside these
 * callbacks would invalidate their mandatory running-Task closure checks.
 */
export async function runProtectedTaskNativeSegment(
  input: RunProtectedTaskNativeSegmentInput,
  dependencies: ProtectedTaskNativeRunnerDependencies = productionDependencies,
): Promise<ProtectedTaskNativeSegmentResult> {
  exactIdentity(input);
  if (input.signal.aborted) return Object.freeze({ status: "aborted" });

  let result: RunScopeSubagentResult;
  try {
    result = await dependencies.runScopeSubagent(runnerOptions(input));
  } catch {
    if (input.signal.aborted) return Object.freeze({ status: "aborted" });
    return createProtectedTaskFailurePayload();
  }

  if (input.signal.aborted) return Object.freeze({ status: "aborted" });
  if (result.threadId !== input.graphThreadId) {
    return createProtectedTaskFailurePayload();
  }
  if (result.status === "interrupted") {
    const interruption = exactInterruptCoordinates(
      result.interruptCoordinates,
    );
    return interruption.additionalAuthority === undefined
      ? Object.freeze({
          status: "interrupted" as const,
          threadId: result.threadId,
          interrupt: result.interrupt,
          interruptCoordinates: interruption.coordinates,
        })
      : Object.freeze({
          status: "interrupted" as const,
          threadId: result.threadId,
          interruptCoordinates: interruption.coordinates,
          additionalAuthority: interruption.additionalAuthority,
        });
  }

  return completedPayload(result.finalResponseText);
}
