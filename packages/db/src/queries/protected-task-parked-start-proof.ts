import { parseProtectedTaskCheckpointAadBinding, sameProtectedTaskCheckpointAadBinding, type ProtectedTaskCheckpointAadBinding } from "./protected-task-checkpoint-aad-binding";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskAdditionalAuthorityContinuationFingerprint,
  protectedTaskSemanticAuthorityRequirementsDigest,
  sameProtectedTaskSemanticAuthorityRequirements,
  type ProtectedTaskExecutionContinuationProof,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "./protected-task-execution-receipts";
import { protectedTaskRunResultObjectId } from
  "./protected-task-output-binding-identities";
import type {
  ProtectedTaskDurableJobReference,
  ProtectedTaskRunInterruptCoordinate,
  StartParkedProtectedTaskHumanRunSegmentInput,
  StartParkedProtectedTaskCheckpointSegmentInput,
  StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "./tasks";

const OPAQUE_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CONTINUATION_FINGERPRINT = /^[A-Za-z0-9_-]{43}$/u;

export type ProtectedTaskRunParkReceiptV1 = Readonly<{
  checkpointAadBinding?: ProtectedTaskCheckpointAadBinding;
  version: 1;
  taskId: string;
  taskRunId: string;
  jobId: string;
  graphThreadId: string;
  generation: number;
  executionSegment: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: string;
  stableRoutingDigest?: string;
}>;

export type PreparedParkedProtectedTaskAdditionalAuthorityStart = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  priorJobId: string;
  jobId: string;
  generation: number;
  parkedAt: Date;
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  contentRevision: number;
  cryptoObjectId: string;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array;
  priorJobReference: ProtectedTaskDurableJobReference;
  jobReference: ProtectedTaskDurableJobReference;
  checkpointManifest:
    StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput[
      "checkpointManifest"
    ];
  continuation: Readonly<{
    interruptId: string;
    operationId: string;
    requestDigest: Uint8Array;
    requiredAuthorityDigest: Uint8Array;
    stableRoutingDigest: Uint8Array;
    semanticAuthorityRequirements:
      ProtectedTaskSemanticAuthorityRequirements;
  }>;
  receipt: ProtectedTaskRunParkReceiptV1;
}>;

export type PreparedParkedProtectedTaskHumanStart = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  priorJobId: string;
  jobId: string;
  generation: number;
  parkedAt: Date;
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  contentRevision: number;
  cryptoObjectId: string;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array;
  priorJobReference: ProtectedTaskDurableJobReference;
  jobReference: ProtectedTaskDurableJobReference;
  checkpointManifest:
    StartParkedProtectedTaskHumanRunSegmentInput["checkpointManifest"];
  stableRoutingDigest: Uint8Array;
  acceptance: StartParkedProtectedTaskHumanRunSegmentInput["acceptance"];
  receipt: ProtectedTaskRunParkReceiptV1;
}>;

export type PreparedParkedProtectedTaskCheckpointStart = Readonly<
  Omit<PreparedParkedProtectedTaskHumanStart, "acceptance"> & {
    continuationFingerprint: string;
  }
>;

/** Structural snapshot only; recovery additionally re-derives the immutable receipt proof. */
export function prepareParkedProtectedTaskCheckpointStart(
  supplied: StartParkedProtectedTaskCheckpointSegmentInput,
): PreparedParkedProtectedTaskCheckpointStart {
  const input = structuredClone(supplied);
  const prior = input.priorJobReference;
  const next = input.jobReference;
  const checkpoint = input.checkpointManifest;
  if (!input.taskId || !input.taskRunId || !input.graphThreadId
    || !input.priorJobId || !input.jobId || input.priorJobId === input.jobId
    || !Number.isSafeInteger(input.generation) || input.generation < 0
    || !(input.parkedAt instanceof Date) || !Number.isFinite(input.parkedAt.getTime())
    || !Array.isArray(input.interrupts) || input.interrupts.length !== 0
    || (input.contentRepresentation !== "protected" && input.contentRepresentation !== "dual")
    || !input.contentNamespaceId || !input.cryptoObjectId
    || !Number.isSafeInteger(input.contentRevision) || input.contentRevision < 1
    || !Number.isSafeInteger(input.cryptoAccessRevision) || input.cryptoAccessRevision < 0
    || ![input.stableRoutingDigest, input.cryptoRequiredNamespaceFingerprint,
      checkpoint.checkpointOrderedDigest, checkpoint.blobOrderedDigest,
      checkpoint.pendingWriteOrderedDigest].every(bytes => bytes instanceof Uint8Array && bytes.length === 32)
    || !CONTINUATION_FINGERPRINT.test(input.continuationFingerprint)
    || !exactParkedProtectedTaskJobReference(prior, prior)
    || !exactParkedProtectedTaskJobReference(next, next)
    || prior.taskId !== input.taskId || prior.taskRunId !== input.taskRunId
    || prior.inputObjectId !== input.cryptoObjectId
    || prior.resultObjectId !== protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    || !Number.isSafeInteger(prior.policyRevision) || prior.policyRevision < 1
    || !Number.isSafeInteger(prior.executionSegment) || prior.executionSegment < 1
    || prior.executionSegment >= Number.MAX_SAFE_INTEGER
    || next.taskId !== prior.taskId || next.taskRunId !== prior.taskRunId
    || next.inputObjectId !== prior.inputObjectId || next.resultObjectId !== prior.resultObjectId
    || next.executionSegment !== prior.executionSegment + 1
    || !Number.isSafeInteger(next.policyRevision) || next.policyRevision < prior.policyRevision
    || next.resumeContinuationFingerprint !== input.continuationFingerprint
    || next.authorizationRequestId !== `task-checkpoint-continuation:${input.taskRunId}:${next.executionSegment}:${input.continuationFingerprint}`
    || checkpoint.contract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(checkpoint.expectedCheckpointCount) || checkpoint.expectedCheckpointCount < 1
    || !Number.isSafeInteger(checkpoint.expectedBlobCount) || checkpoint.expectedBlobCount < 0
    || !Number.isSafeInteger(checkpoint.expectedPendingWriteCount) || checkpoint.expectedPendingWriteCount < 0) {
    throw new TypeError("Protected Task checkpoint recovery binding is malformed");
  }
  return Object.freeze({
    taskId: input.taskId, taskRunId: input.taskRunId, graphThreadId: input.graphThreadId,
    priorJobId: input.priorJobId, jobId: input.jobId, generation: input.generation,
    parkedAt: input.parkedAt, contentRepresentation: input.contentRepresentation,
    contentNamespaceId: input.contentNamespaceId, contentRevision: input.contentRevision,
    cryptoObjectId: input.cryptoObjectId, cryptoAccessRevision: input.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint: input.cryptoRequiredNamespaceFingerprint,
    priorJobReference: prior, jobReference: next, checkpointManifest: checkpoint,
    stableRoutingDigest: input.stableRoutingDigest, continuationFingerprint: input.continuationFingerprint,
    receipt: Object.freeze({
    version: 1, ...checkpointAadFields(input), taskId: input.taskId, taskRunId: input.taskRunId,
    jobId: input.priorJobId, graphThreadId: input.graphThreadId,
    generation: input.generation, executionSegment: prior.executionSegment,
    interrupts: Object.freeze([]), parkedAt: input.parkedAt.toISOString(),
    stableRoutingDigest: Buffer.from(input.stableRoutingDigest).toString("base64url"),
  }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function canonicalInterrupts(
  value: readonly ProtectedTaskRunInterruptCoordinate[],
): readonly ProtectedTaskRunInterruptCoordinate[] {
  const malformed = () => {
    throw new TypeError("Protected Task park binding is malformed");
  };
  if (!Array.isArray(value) || value.length === 0) return malformed();
  const interrupts = value.map(candidate => {
    if (!isRecord(candidate)) return malformed();
    const keys = Object.keys(candidate).sort().join(",");
    if ((keys !== "id,kind" && keys !== "id,kind,requestId"
        && keys !== "allowedVerbs,id,kind,requestId")
      || typeof candidate["id"] !== "string"
      || !OPAQUE_COORDINATE.test(candidate["id"])
      || ![
        "approval",
        "prove_it",
        "identity",
        "await_reply",
        "additional_authority",
      ].includes(candidate["kind"] as string)) return malformed();
    const common = {
      id: candidate["id"],
      kind: candidate["kind"] as ProtectedTaskRunInterruptCoordinate["kind"],
    };
    if (keys === "id,kind") return Object.freeze(common);
    if (typeof candidate["requestId"] !== "string"
      || !OPAQUE_COORDINATE.test(candidate["requestId"])) return malformed();
    if (keys === "id,kind,requestId") {
      return Object.freeze({ ...common, requestId: candidate["requestId"] });
    }
    const allowedVerbs = candidate["allowedVerbs"];
    const canonicalOrder = ["once", "room", "always", "deny"] as const;
    if (candidate["kind"] !== "approval" || !Array.isArray(allowedVerbs)
      || allowedVerbs.length === 0 || !allowedVerbs.includes("deny")
      || new Set(allowedVerbs).size !== allowedVerbs.length
      || allowedVerbs.some((verb, index) => verb !== canonicalOrder.filter(
        candidateVerb => allowedVerbs.includes(candidateVerb),
      )[index])) return malformed();
    const canonicalAllowedVerbs = canonicalOrder.filter(verb =>
      allowedVerbs.includes(verb));
    return Object.freeze({ ...common, requestId: candidate["requestId"],
      allowedVerbs: Object.freeze(canonicalAllowedVerbs) });
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (interrupts.some((interrupt, index) =>
    index > 0 && interrupts[index - 1]!.id === interrupt.id
  )) return malformed();
  return Object.freeze(interrupts);
}

function exactInterrupts(
  value: unknown,
  expected: readonly ProtectedTaskRunInterruptCoordinate[],
): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((candidate, index) => {
    if (!isRecord(candidate)) return false;
    const interrupt = expected[index]!;
    const keys = interrupt.allowedVerbs !== undefined
      ? "allowedVerbs,id,kind,requestId"
      : interrupt.requestId === undefined ? "id,kind" : "id,kind,requestId";
    return Object.keys(candidate).sort().join(",") === keys
      && candidate["id"] === interrupt.id
      && candidate["kind"] === interrupt.kind
      && candidate["requestId"] === interrupt.requestId
      && (interrupt.allowedVerbs === undefined
        ? candidate["allowedVerbs"] === undefined
        : Array.isArray(candidate["allowedVerbs"])
          && candidate["allowedVerbs"].length === interrupt.allowedVerbs.length
          && candidate["allowedVerbs"].every((verb, verbIndex) =>
            verb === interrupt.allowedVerbs![verbIndex]));
  });
}

export function exactParkedProtectedTaskJobReference(
  value: unknown,
  expected: ProtectedTaskDurableJobReference,
): boolean {
  if (!isRecord(value)) return false;
  const acceptance = expected.resumeAcceptanceId;
  const continuation = expected.resumeContinuationFingerprint;
  const expectedKeys = acceptance !== undefined
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId"
    : continuation !== undefined
      ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeContinuationFingerprint,taskId,taskRunId"
      : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId";
  return (expected.executionSegment === 1
      ? acceptance === undefined && continuation === undefined
      : (typeof acceptance === "string"
          && OPAQUE_COORDINATE.test(acceptance)
          && continuation === undefined)
        || (acceptance === undefined
          && typeof continuation === "string"
          && CONTINUATION_FINGERPRINT.test(continuation)))
    && Object.keys(value).sort().join(",") === expectedKeys
    && value["kind"] === "protected_task_run_v1"
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["inputObjectId"] === expected.inputObjectId
    && value["resultObjectId"] === expected.resultObjectId
    && value["authorizationRequestId"] === expected.authorizationRequestId
    && value["policyRevision"] === expected.policyRevision
    && value["executionSegment"] === expected.executionSegment
    && value["resumeAcceptanceId"] === acceptance
    && value["resumeContinuationFingerprint"] === continuation;
}

export function prepareParkedProtectedTaskHumanStart(
  input: StartParkedProtectedTaskHumanRunSegmentInput,
): PreparedParkedProtectedTaskHumanStart {
  const priorReference = Object.freeze({ ...input.priorJobReference });
  const nextReference = Object.freeze({ ...input.jobReference });
  const interrupts = canonicalInterrupts(input.interrupts);
  const checkpoint = input.checkpointManifest;
  if (!input.taskId
    || !input.taskRunId
    || !input.graphThreadId
    || !input.priorJobId
    || !input.jobId
    || input.priorJobId === input.jobId
    || !Number.isSafeInteger(input.generation)
    || input.generation < 0
    || !(input.parkedAt instanceof Date)
    || !Number.isFinite(input.parkedAt.getTime())
    || input.contentRepresentation !== "dual"
      && input.contentRepresentation !== "protected"
    || !input.contentNamespaceId
    || !Number.isSafeInteger(input.contentRevision)
    || input.contentRevision < 1
    || !input.cryptoObjectId
    || !Number.isSafeInteger(input.cryptoAccessRevision)
    || input.cryptoAccessRevision < 0
    || !(input.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || input.cryptoRequiredNamespaceFingerprint.length !== 32
    || !(input.stableRoutingDigest instanceof Uint8Array)
    || input.stableRoutingDigest.length !== 32
    || !isRecord(checkpoint)
    || checkpoint.contract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(checkpoint.expectedCheckpointCount)
    || checkpoint.expectedCheckpointCount < 1
    || !(checkpoint.checkpointOrderedDigest instanceof Uint8Array)
    || checkpoint.checkpointOrderedDigest.length !== 32
    || !Number.isSafeInteger(checkpoint.expectedBlobCount)
    || checkpoint.expectedBlobCount < 0
    || !(checkpoint.blobOrderedDigest instanceof Uint8Array)
    || checkpoint.blobOrderedDigest.length !== 32
    || !Number.isSafeInteger(checkpoint.expectedPendingWriteCount)
    || checkpoint.expectedPendingWriteCount < 0
    || !(checkpoint.pendingWriteOrderedDigest instanceof Uint8Array)
    || checkpoint.pendingWriteOrderedDigest.length !== 32
    || !exactParkedProtectedTaskJobReference(priorReference, priorReference)
    || !exactParkedProtectedTaskJobReference(nextReference, nextReference)
    || priorReference.taskId !== input.taskId
    || priorReference.taskRunId !== input.taskRunId
    || priorReference.inputObjectId !== input.cryptoObjectId
    || nextReference.taskId !== priorReference.taskId
    || nextReference.taskRunId !== priorReference.taskRunId
    || nextReference.inputObjectId !== priorReference.inputObjectId
    || nextReference.resultObjectId !== priorReference.resultObjectId
    || !Number.isSafeInteger(nextReference.policyRevision)
    || nextReference.policyRevision < priorReference.policyRevision
    || nextReference.executionSegment !== priorReference.executionSegment + 1
    || nextReference.authorizationRequestId
      === priorReference.authorizationRequestId
    || nextReference.resumeAcceptanceId !== input.acceptance.acceptanceId
    || nextReference.resumeAcceptanceId === priorReference.resumeAcceptanceId) {
    throw new TypeError("Protected Task Human segment binding is malformed");
  }
  return Object.freeze({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    graphThreadId: input.graphThreadId,
    priorJobId: input.priorJobId,
    jobId: input.jobId,
    generation: input.generation,
    parkedAt: new Date(input.parkedAt.getTime()),
    contentRepresentation: input.contentRepresentation,
    contentNamespaceId: input.contentNamespaceId,
    contentRevision: input.contentRevision,
    cryptoObjectId: input.cryptoObjectId,
    cryptoAccessRevision: input.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint:
      input.cryptoRequiredNamespaceFingerprint.slice(),
    priorJobReference: priorReference,
    jobReference: nextReference,
    checkpointManifest: Object.freeze({
      contract: checkpoint.contract,
      expectedCheckpointCount: checkpoint.expectedCheckpointCount,
      checkpointOrderedDigest: checkpoint.checkpointOrderedDigest.slice(),
      expectedBlobCount: checkpoint.expectedBlobCount,
      blobOrderedDigest: checkpoint.blobOrderedDigest.slice(),
      expectedPendingWriteCount: checkpoint.expectedPendingWriteCount,
      pendingWriteOrderedDigest: checkpoint.pendingWriteOrderedDigest.slice(),
    }),
    stableRoutingDigest: input.stableRoutingDigest.slice(),
    acceptance: input.acceptance,
    receipt: Object.freeze({
      version: 1 as const,
    ...checkpointAadFields(input),
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      jobId: input.priorJobId,
      graphThreadId: input.graphThreadId,
      generation: input.generation,
      executionSegment: priorReference.executionSegment,
      interrupts,
      parkedAt: input.parkedAt.toISOString(),
      stableRoutingDigest:
        Buffer.from(input.stableRoutingDigest).toString("base64url"),
    }),
  });
}

function checkpointAadFields(input: Readonly<{ checkpointAadBinding?: ProtectedTaskCheckpointAadBinding; contentNamespaceId: string; priorJobReference: ProtectedTaskDurableJobReference }>): Readonly<{ checkpointAadBinding?: ProtectedTaskCheckpointAadBinding }> {
  if (input.checkpointAadBinding === undefined) return {};
  const binding = parseProtectedTaskCheckpointAadBinding(input.checkpointAadBinding);
  if (binding === null || binding.namespaceId !== input.contentNamespaceId
    || binding.policyRevision > input.priorJobReference.policyRevision) throw new TypeError("Protected Task checkpoint binding is malformed");
  return { checkpointAadBinding: binding };
}

function exactParkReceipt(
  value: unknown,
  expected: ProtectedTaskRunParkReceiptV1,
): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = expected.stableRoutingDigest === undefined
    ? "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,taskId,taskRunId,version"
    : "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,stableRoutingDigest,taskId,taskRunId,version";
  return Object.keys(value).filter(key => key !== "checkpointAadBinding"
      || parseProtectedTaskCheckpointAadBinding(value[key]) === null).sort().join(",") === expectedKeys
    && sameProtectedTaskCheckpointAadBinding(
      value["checkpointAadBinding"] === undefined ? undefined : parseProtectedTaskCheckpointAadBinding(value["checkpointAadBinding"]) ?? undefined,
      expected.checkpointAadBinding)
    && value["version"] === expected.version
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["jobId"] === expected.jobId
    && value["graphThreadId"] === expected.graphThreadId
    && value["generation"] === expected.generation
    && value["executionSegment"] === expected.executionSegment
    && exactInterrupts(value["interrupts"], expected.interrupts)
    && value["parkedAt"] === expected.parkedAt
    && value["stableRoutingDigest"] === expected.stableRoutingDigest;
}

export function prepareParkedProtectedTaskAdditionalAuthorityStart(
  input: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
): PreparedParkedProtectedTaskAdditionalAuthorityStart {
  const priorReference = Object.freeze({ ...input.priorJobReference });
  const nextReference = Object.freeze({ ...input.jobReference });
  let semanticAuthorityRequirements:
    | ProtectedTaskSemanticAuthorityRequirements
    | null = null;
  let semanticDigestMatches = false;
  try {
    semanticAuthorityRequirements =
      canonicalProtectedTaskSemanticAuthorityRequirements(
        input.continuation.semanticAuthorityRequirements,
      );
    const semanticDigest = protectedTaskSemanticAuthorityRequirementsDigest(
      semanticAuthorityRequirements,
    );
    semanticDigestMatches = sameBytes(
      semanticDigest,
      input.continuation.requiredAuthorityDigest,
    );
    semanticDigest.fill(0);
  } catch {
    semanticAuthorityRequirements = null;
  }
  const interrupts = canonicalInterrupts(input.interrupts);
  const checkpoint = input.checkpointManifest;
  const continuation = input.continuation;
  if (!input.taskId
    || !input.taskRunId
    || !input.graphThreadId
    || !input.priorJobId
    || !input.jobId
    || input.priorJobId === input.jobId
    || !Number.isSafeInteger(input.generation)
    || input.generation < 0
    || !(input.parkedAt instanceof Date)
    || !Number.isFinite(input.parkedAt.getTime())
    || input.contentRepresentation !== "dual"
      && input.contentRepresentation !== "protected"
    || !input.contentNamespaceId
    || !Number.isSafeInteger(input.contentRevision)
    || input.contentRevision < 1
    || !input.cryptoObjectId
    || !Number.isSafeInteger(input.cryptoAccessRevision)
    || input.cryptoAccessRevision < 0
    || !(input.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || input.cryptoRequiredNamespaceFingerprint.length !== 32
    || !isRecord(continuation)
    || !(continuation.requestDigest instanceof Uint8Array)
    || continuation.requestDigest.length !== 32
    || !(continuation.requiredAuthorityDigest instanceof Uint8Array)
    || continuation.requiredAuthorityDigest.length !== 32
    || !(continuation.stableRoutingDigest instanceof Uint8Array)
    || continuation.stableRoutingDigest.length !== 32
    || semanticAuthorityRequirements === null
    || !semanticDigestMatches
    || !isRecord(checkpoint)
    || checkpoint.contract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(checkpoint.expectedCheckpointCount)
    || checkpoint.expectedCheckpointCount < 1
    || !(checkpoint.checkpointOrderedDigest instanceof Uint8Array)
    || checkpoint.checkpointOrderedDigest.length !== 32
    || !Number.isSafeInteger(checkpoint.expectedBlobCount)
    || checkpoint.expectedBlobCount < 0
    || !(checkpoint.blobOrderedDigest instanceof Uint8Array)
    || checkpoint.blobOrderedDigest.length !== 32
    || !Number.isSafeInteger(checkpoint.expectedPendingWriteCount)
    || checkpoint.expectedPendingWriteCount < 0
    || !(checkpoint.pendingWriteOrderedDigest instanceof Uint8Array)
    || checkpoint.pendingWriteOrderedDigest.length !== 32
    || !exactParkedProtectedTaskJobReference(priorReference, priorReference)
    || !exactParkedProtectedTaskJobReference(nextReference, nextReference)
    || priorReference.taskId !== input.taskId
    || priorReference.taskRunId !== input.taskRunId
    || priorReference.inputObjectId !== input.cryptoObjectId
    || priorReference.resultObjectId
      !== protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    || !priorReference.authorizationRequestId
    || !Number.isSafeInteger(priorReference.policyRevision)
    || priorReference.policyRevision < 1
    || !Number.isSafeInteger(priorReference.executionSegment)
    || priorReference.executionSegment < 1
    || priorReference.executionSegment === Number.MAX_SAFE_INTEGER
    || nextReference.taskId !== priorReference.taskId
    || nextReference.taskRunId !== priorReference.taskRunId
    || nextReference.inputObjectId !== priorReference.inputObjectId
    || nextReference.resultObjectId !== priorReference.resultObjectId
    || !Number.isSafeInteger(nextReference.executionSegment)
    || nextReference.executionSegment !== priorReference.executionSegment + 1
    || !nextReference.authorizationRequestId
    || nextReference.authorizationRequestId
      === priorReference.authorizationRequestId
    || nextReference.resumeContinuationFingerprint
      === priorReference.resumeContinuationFingerprint
    || interrupts.length === 0) {
    throw new TypeError(
      "Protected Task additional-authority segment binding is malformed",
    );
  }
  const copiedContinuation = Object.freeze({
    interruptId: continuation.interruptId,
    operationId: continuation.operationId,
    requestDigest: continuation.requestDigest.slice(),
    requiredAuthorityDigest: continuation.requiredAuthorityDigest.slice(),
    stableRoutingDigest: continuation.stableRoutingDigest.slice(),
    semanticAuthorityRequirements,
  });
  const selected = interrupts.filter(candidate =>
    candidate.id === copiedContinuation.interruptId
      && candidate.kind === "additional_authority"
      && candidate.requestId === nextReference.authorizationRequestId
  );
  const continuationFingerprint =
    protectedTaskAdditionalAuthorityContinuationFingerprint({
      taskRunId: input.taskRunId,
      executionSegment: priorReference.executionSegment,
      jobId: input.priorJobId,
      kind: "pre_effect_interrupt_v1",
      reason: "additional_authority",
      effectDisposition: "not_started_v1",
      interruptId: copiedContinuation.interruptId,
      operationId: copiedContinuation.operationId,
      requestDigest: copiedContinuation.requestDigest,
      requiredAuthorityDigest: copiedContinuation.requiredAuthorityDigest,
      stableRoutingDigest: copiedContinuation.stableRoutingDigest,
    });
  if (selected.length !== 1
    || nextReference.resumeContinuationFingerprint
      !== continuationFingerprint) {
    throw new TypeError(
      "Protected Task additional-authority segment binding is malformed",
    );
  }
  const parkedAt = new Date(input.parkedAt.getTime());
  const receipt = Object.freeze({
    version: 1 as const,
    ...checkpointAadFields(input),
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    jobId: input.priorJobId,
    graphThreadId: input.graphThreadId,
    generation: input.generation,
    executionSegment: priorReference.executionSegment,
    interrupts,
    parkedAt: parkedAt.toISOString(),
  });
  return Object.freeze({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    graphThreadId: input.graphThreadId,
    priorJobId: input.priorJobId,
    jobId: input.jobId,
    generation: input.generation,
    parkedAt,
    contentRepresentation: input.contentRepresentation,
    contentNamespaceId: input.contentNamespaceId,
    contentRevision: input.contentRevision,
    cryptoObjectId: input.cryptoObjectId,
    cryptoAccessRevision: input.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint:
      input.cryptoRequiredNamespaceFingerprint.slice(),
    priorJobReference: priorReference,
    jobReference: nextReference,
    checkpointManifest: Object.freeze({
      contract: checkpoint.contract,
      expectedCheckpointCount: checkpoint.expectedCheckpointCount,
      checkpointOrderedDigest: checkpoint.checkpointOrderedDigest.slice(),
      expectedBlobCount: checkpoint.expectedBlobCount,
      blobOrderedDigest: checkpoint.blobOrderedDigest.slice(),
      expectedPendingWriteCount: checkpoint.expectedPendingWriteCount,
      pendingWriteOrderedDigest: checkpoint.pendingWriteOrderedDigest.slice(),
    }),
    continuation: copiedContinuation,
    receipt,
  });
}

export function exactParkedProtectedTaskAdditionalAuthorityProof(
  proof: ProtectedTaskExecutionContinuationProof | null,
  parkReceipt: unknown,
  input: PreparedParkedProtectedTaskAdditionalAuthorityStart,
  compareCheckpointManifest: boolean,
): boolean {
  const segment = proof?.segment;
  const continuation = proof?.continuation;
  return segment !== undefined
    && continuation !== undefined
    && exactParkedProtectedTaskPhysicalSegment(
      segment,
      input,
      compareCheckpointManifest,
    )
    && continuation.taskRunId === input.taskRunId
    && continuation.executionSegment
      === input.priorJobReference.executionSegment
    && continuation.jobId === input.priorJobId
    && continuation.sealedAt.getTime() === input.parkedAt.getTime()
    && continuation.kind === "pre_effect_interrupt_v1"
    && continuation.reason === "additional_authority"
    && continuation.effectDisposition === "not_started_v1"
    && continuation.interruptId === input.continuation.interruptId
    && continuation.operationId === input.continuation.operationId
    && sameBytes(
      continuation.requestDigest,
      input.continuation.requestDigest,
    )
    && sameBytes(
      continuation.requiredAuthorityDigest,
      input.continuation.requiredAuthorityDigest,
    )
    && sameBytes(
      continuation.stableRoutingDigest,
      input.continuation.stableRoutingDigest,
    )
    && continuation.semanticAuthorityRequirements !== null
    && sameProtectedTaskSemanticAuthorityRequirements(
      continuation.semanticAuthorityRequirements,
      input.continuation.semanticAuthorityRequirements,
    )
    && exactParkReceipt(parkReceipt, input.receipt);
}

export function exactParkedProtectedTaskPhysicalSegment(
  segment: ProtectedTaskExecutionContinuationProof["segment"],
  input: Readonly<{
    taskRunId: string;
    priorJobId: string;
    parkedAt: Date;
    priorJobReference: ProtectedTaskDurableJobReference;
    checkpointManifest:
      StartParkedProtectedTaskHumanRunSegmentInput["checkpointManifest"];
  }>,
  compareCheckpointManifest: boolean,
): boolean {
  return segment.taskRunId === input.taskRunId
    && segment.executionSegment === input.priorJobReference.executionSegment
    && segment.jobId === input.priorJobId
    && segment.route === "native_langgraph_v1"
    && segment.transcriptContract === "protected_message_associations_v1"
    && segment.checkpointContract === "encrypted_langgraph_v1"
    && segment.expectedCheckpointCount >= 1
    && segment.sealedAt.getTime() === input.parkedAt.getTime()
    && (!compareCheckpointManifest || (
      segment.checkpointContract === input.checkpointManifest.contract
      && segment.expectedCheckpointCount
        === input.checkpointManifest.expectedCheckpointCount
      && sameBytes(
        segment.checkpointDigest,
        input.checkpointManifest.checkpointOrderedDigest,
      )
      && segment.expectedCheckpointBlobCount
        === input.checkpointManifest.expectedBlobCount
      && sameBytes(
        segment.checkpointBlobDigest,
        input.checkpointManifest.blobOrderedDigest,
      )
      && segment.expectedPendingWriteCount
        === input.checkpointManifest.expectedPendingWriteCount
      && sameBytes(
        segment.pendingWriteDigest,
        input.checkpointManifest.pendingWriteOrderedDigest,
      )
    ));
}

export function exactParkedProtectedTaskHumanProof(
  segment: ProtectedTaskExecutionContinuationProof["segment"] | null,
  parkReceipt: unknown,
  input: PreparedParkedProtectedTaskHumanStart,
  compareCheckpointManifest: boolean,
): boolean {
  return segment !== null
    && exactParkedProtectedTaskPhysicalSegment(
      segment,
      input,
      compareCheckpointManifest,
    )
    && exactParkReceipt(parkReceipt, input.receipt);
}
