import { bytesToHex } from "@noble/hashes/utils.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../agent-runtime/object-signer-v1.ts";
import {
  AGENT_RUNTIME_KEY_BYTES,
  type AgentRuntimeGenerationV2,
} from "../agent-runtime/types.ts";
import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
  parseDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  destroyDomainForegroundAuthorizationPlanV2,
  withOpenedDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  type DomainForegroundSecretEntryV2,
  type OpenDomainForegroundAuthorizationResultV2,
} from "../format/domain-foreground-authorization-v2.ts";
import {
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  assertU64Counter,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import {
  PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1,
} from "./one-run-processor-transform-v1.ts";
import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionDomainAuthorityV1,
  type TaskRuntimeExecutionEvidenceInputV1,
  type TaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionNamespaceAuthorityV1,
} from "./task-runtime-execution-evidence-v1.ts";
import type { BackgroundAuthorizationIssuerV2 } from
  "./processor-authorization-v2.ts";
import type { TaskRuntimeEphemeralSignerV2 } from
  "./task-runtime-request-v2.ts";
import {
  destroyVerifiedTaskRuntimeSignerAuthorization,
  destroyVerifiedTaskRuntimeSignerAuthorizationV1,
  verifyCurrentTaskRuntimeSignerAuthorization,
  verifyCurrentTaskRuntimeSignerAuthorizationV1,
  type VerifiedCurrentTaskRuntimeSignerAuthorization,
  type VerifiedCurrentTaskRuntimeSignerAuthorizationV1,
} from "./task-runtime-signer-authorization-v1.ts";
import {
  encodeTaskRuntimePublicationWorkBindingV3,
  type TaskRuntimePublicationWorkBindingV3,
} from "./task-runtime-request-v3.ts";
import {
  assertAuthenticTaskRuntimeTerminalMessageEvidenceV1,
  withTaskRuntimeTerminalMessageEvidenceV1,
  type TaskRuntimeTerminalMessageEvidenceV1,
  type TaskRuntimeTerminalMessageProofV1,
} from "./task-runtime-terminal-message-evidence-v1.ts";
export {
  assertAuthenticTaskRuntimeTerminalMessageEvidenceV1,
} from "./task-runtime-terminal-message-evidence-v1.ts";
export type {
  TaskRuntimeTerminalMessageEvidenceV1,
  TaskRuntimeTerminalMessageProofV1,
} from "./task-runtime-terminal-message-evidence-v1.ts";

import {
  assertAuthenticTaskRuntimeRunResultReadEvidenceV1,
  withTaskRuntimeRunResultReadEvidenceV1,
  snapshotTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadInvocationV1,
  type TaskRuntimeRunResultReadProofV1,
} from "./task-runtime-run-result-read-evidence-v1.ts";

import {
  assertAuthenticTaskRuntimeWakeForegroundEvidenceV1,
  withTaskRuntimeWakeForegroundEvidenceV1,
  type TaskRuntimeWakeForegroundEvidenceV1,
  type TaskRuntimeWakeMutationDestinationV1,
} from "./task-runtime-wake-foreground-evidence-v1.ts";

export type TaskRuntimeRunResultReadPartitionsV1 = Readonly<{
  resultDomains: readonly [DomainForegroundSecretEntryV2];
  foregroundDomains: readonly DomainForegroundSecretEntryV2[];
  additionalMutationDomains?: readonly DomainForegroundSecretEntryV2[];
  foregroundNamespaceRequirements: readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
}>;

function signedAuthorizationDeadline(bytes: Uint8Array): number | null {
  const authorization = parseDomainForegroundAuthorizationV2(bytes);
  if (authorization === null) return null;
  try {
    const plan = parseDomainForegroundAuthorizationPlanV2(authorization.planBytes);
    if (plan === null) return null;
    try { return plan.deadlineAt; }
    finally { destroyDomainForegroundAuthorizationPlanV2(plan); }
  } finally { destroyDomainForegroundAuthorizationV2(authorization); }
}

declare const taskRuntimeCancellationResultEvidenceBrand: unique symbol;

const TASK_RUN_RESULT_OBJECT_ID_DOMAIN =
  "nautilo/task-run-result-crypto-object/v1";
const encoder = new TextEncoder();

export type TaskRuntimeCancellationResultEvidenceV1 = Readonly<{
  readonly purpose: "task.runtime.cancellation_result";
  readonly requestId: string;
  readonly workId: string;
  readonly claimId: string;
  readonly claimExpiresAt: number;
  readonly recipientExpiresAt: number;
  readonly expiresAt: number;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly authorizationDigest: Uint8Array;
  readonly policyRevision: number;
  readonly episodeId: string;
  readonly sourceRoomId: string;
  readonly hostAuthorizationRevision: number;
  readonly recipientAuthorizationRevision: number;
  readonly operations: readonly ["encrypt"];
  readonly result: Readonly<{
    readonly taskId: string;
    readonly taskRunId: string;
    readonly contentRevision: 2;
    readonly objectId: string;
    readonly signerAgentId: string;
    readonly namespace: Readonly<{
      readonly namespaceId: string;
      readonly domainId: string;
      readonly operations: readonly ["encrypt"];
      readonly expectedAccessRevision: number;
      readonly expectedPolicyRevision: number;
    }>;
  }>;
  readonly domainRequirements: readonly [TaskRuntimeExecutionDomainAuthorityV1];
  readonly namespaceRequirements: readonly [Readonly<{
    readonly ordinal: 0;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly operations: readonly ["encrypt"];
    readonly expectedAccessRevision: number;
    readonly expectedPolicyRevision: number;
  }>];
  readonly [taskRuntimeCancellationResultEvidenceBrand]: true;
}>;

export type TaskRuntimeCancellationResultProofV1 =
  TaskRuntimeCancellationResultEvidenceV1["result"];

type CancellationEvidenceState = {
  active: boolean;
  readonly fingerprint: string;
  readonly signal: AbortSignal;
  readonly now: () => number;
};

const cancellationEvidenceStates = new WeakMap<object, CancellationEvidenceState>();

type TaskRuntimeCurrentNamespaceAuthorityV1 =
  TaskRuntimeExecutionNamespaceAuthorityV1;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cancellationResultObjectId(
  crypto: LatticeCrypto,
  result: Pick<TaskRuntimeCancellationResultProofV1, "taskId" | "taskRunId">,
): string {
  if (!UUID.test(result.taskId) || !UUID.test(result.taskRunId)) {
    throw new TypeError("Task Runtime cancellation result coordinate is invalid");
  }
  const digest = crypto.hash(encoder.encode(
    `${TASK_RUN_RESULT_OBJECT_ID_DOMAIN}\n${result.taskId}\n${result.taskRunId}\n2`,
  ));
  try {
    return `task-run-result:v1:${bytesToHex(digest)}`;
  } finally {
    digest.fill(0);
  }
}

function cancellationResultAuthorityIsCurrent(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly workId: string;
  readonly result: TaskRuntimeCancellationResultProofV1;
  readonly namespaces: readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
  readonly current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
}>): boolean {
  const resultNamespace = input.result.namespace;
  const namespace = input.namespaces[0];
  const domain = input.current.domains[0];
  return input.result.taskRunId === input.workId
    && input.result.contentRevision === 2
    && input.result.objectId === cancellationResultObjectId(input.crypto, input.result)
    && resultNamespace.operations.length === 1
    && resultNamespace.operations[0] === "encrypt"
    && resultNamespace.expectedPolicyRevision === input.current.policyRevision
    && input.namespaces.length === 1
    && namespace !== undefined
    && namespace.ordinal === 0
    && namespace.namespaceId === resultNamespace.namespaceId
    && namespace.domainId === resultNamespace.domainId
    && namespace.operations.length === 1
    && namespace.operations[0] === "encrypt"
    && namespace.expectedAccessRevision === resultNamespace.expectedAccessRevision
    && namespace.expectedPolicyRevision === resultNamespace.expectedPolicyRevision
    && input.current.domains.length === 1
    && domain !== undefined
    && domain.domainId === resultNamespace.domainId
    && domain.sourceNamespaceId === resultNamespace.namespaceId;
}

function resultAuthorityIsCurrent(input: Readonly<{
  readonly workId: string;
  readonly result: TaskRuntimeExecutionEvidenceInputV1["result"];
  readonly namespaces: readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
  readonly current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
}>): boolean {
  const resultNamespace = input.result.namespace;
  const matchingNamespaces = input.namespaces.filter((requirement) =>
    requirement.namespaceId === resultNamespace.namespaceId
  );
  const matchingDomains = input.current.domains.filter((domain) =>
    domain.domainId === resultNamespace.domainId
  );
  const currentNamespace = matchingNamespaces[0];
  return input.result.taskRunId === input.workId
    && input.result.contentRevision === 1
    && resultNamespace.operations.length === 1
    && resultNamespace.operations[0] === "encrypt"
    && resultNamespace.expectedPolicyRevision === input.current.policyRevision
    && matchingNamespaces.length === 1
    && currentNamespace !== undefined
    && currentNamespace.domainId === resultNamespace.domainId
    && currentNamespace.operations.length === 2
    && currentNamespace.operations[0] === "decrypt"
    && currentNamespace.operations[1] === "encrypt"
    && currentNamespace.expectedAccessRevision
      === resultNamespace.expectedAccessRevision
    && currentNamespace.expectedPolicyRevision
      === resultNamespace.expectedPolicyRevision
    && matchingDomains.length === 1;
}

function terminalMessageAuthorityIsCurrent(input: Readonly<{
  readonly workId: string;
  readonly message: TaskRuntimeTerminalMessageProofV1;
  readonly namespaces: readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
  readonly current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
}>): boolean {
  const namespace = input.namespaces[0];
  const domain = input.current.domains[0];
  return input.message.taskRunId === input.workId
    && input.message.roomId === input.current.roomId
    && input.message.publicationPolicyRevision === input.current.policyRevision
    && input.message.acceptedPolicyRevision <= input.current.policyRevision
    && input.namespaces.length === 1
    && namespace !== undefined
    && namespace.ordinal === 0
    && namespace.namespaceId === input.message.namespaceId
    && namespace.domainId === input.message.domainId
    && namespace.operations.length === 1
    && namespace.operations[0] === "encrypt"
    && namespace.expectedPolicyRevision === input.current.policyRevision
    && input.current.domains.length === 1
    && domain !== undefined
    && domain.domainId === input.message.domainId
    && domain.sourceNamespaceId === input.message.namespaceId;
}

function cloneCancellationEvidence(
  value: Omit<TaskRuntimeCancellationResultEvidenceV1,
    typeof taskRuntimeCancellationResultEvidenceBrand>,
): TaskRuntimeCancellationResultEvidenceV1 {
  const result = value.result;
  const namespace = result.namespace;
  const requirement = value.namespaceRequirements[0];
  const domain = value.domainRequirements[0];
  assertPortableId("Task Runtime cancellation request ID", value.requestId);
  assertPortableId("Task Runtime cancellation work ID", value.workId);
  assertPortableId("Task Runtime cancellation claim ID", value.claimId);
  assertPortableId("Task Runtime cancellation recipient key ID", value.recipientKeyId);
  assertPortableId("Task Runtime cancellation episode ID", value.episodeId);
  assertPortableId("Task Runtime cancellation source Room ID", value.sourceRoomId);
  assertPortableId("Task Runtime cancellation result object ID", result.objectId);
  assertPortableId("Task Runtime cancellation signer Agent ID", result.signerAgentId);
  assertPortableId("Task Runtime cancellation result Namespace ID", namespace.namespaceId);
  assertPortableId("Task Runtime cancellation result Domain ID", namespace.domainId);
  for (const [label, counter] of [
    ["claim expiry", value.claimExpiresAt],
    ["recipient expiry", value.recipientExpiresAt],
    ["expiry", value.expiresAt],
    ["recipient generation", value.recipientGeneration],
    ["policy revision", value.policyRevision],
    ["host authorization revision", value.hostAuthorizationRevision],
    ["recipient authorization revision", value.recipientAuthorizationRevision],
    ["result access revision", namespace.expectedAccessRevision],
    ["result policy revision", namespace.expectedPolicyRevision],
    ["Domain participant count", domain.participantCount],
    ["Domain key generation", domain.domainKeyGeneration],
    ["Domain authorization revision", domain.authorizationRevision],
    ["Domain active Namespace binding count", domain.activeNamespaceBindingCount],
  ] as const) assertU64Counter(`Task Runtime cancellation ${label}`, counter);
  if (value.expiresAt !== Math.min(value.claimExpiresAt, value.recipientExpiresAt)
    || value.operations.length !== 1
    || value.operations[0] !== "encrypt"
    || result.contentRevision !== 2
    || result.taskRunId !== value.workId
    || namespace.operations.length !== 1
    || namespace.operations[0] !== "encrypt"
    || namespace.expectedPolicyRevision !== value.policyRevision
    || requirement.ordinal !== 0
    || requirement.namespaceId !== namespace.namespaceId
    || requirement.domainId !== namespace.domainId
    || requirement.operations.length !== 1
    || requirement.operations[0] !== "encrypt"
    || requirement.expectedAccessRevision !== namespace.expectedAccessRevision
    || requirement.expectedPolicyRevision !== namespace.expectedPolicyRevision
    || value.domainRequirements.length !== 1
    || value.namespaceRequirements.length !== 1
    || domain.keyClass !== "ai"
    || domain.domainId !== namespace.domainId
    || domain.sourceNamespaceId !== namespace.namespaceId) {
    throw new TypeError("Task Runtime cancellation evidence is invalid");
  }
  if (value.authorizationDigest.length !== 32
    || domain.participantDigest.length !== 32
    || domain.headDigest.length !== 32
    || domain.activeNamespaceBindingSetDigest.length !== 32) {
    throw new RangeError("Task Runtime cancellation evidence digest is invalid");
  }
  return Object.freeze({
    purpose: "task.runtime.cancellation_result",
    requestId: value.requestId,
    workId: value.workId,
    claimId: value.claimId,
    claimExpiresAt: value.claimExpiresAt,
    recipientExpiresAt: value.recipientExpiresAt,
    expiresAt: value.expiresAt,
    recipientGeneration: value.recipientGeneration,
    recipientKeyId: value.recipientKeyId,
    authorizationDigest: value.authorizationDigest.slice(),
    policyRevision: value.policyRevision,
    episodeId: value.episodeId,
    sourceRoomId: value.sourceRoomId,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
    recipientAuthorizationRevision: value.recipientAuthorizationRevision,
    operations: Object.freeze(["encrypt"] as const),
    result: Object.freeze({
      taskId: result.taskId,
      taskRunId: result.taskRunId,
      contentRevision: 2 as const,
      objectId: result.objectId,
      signerAgentId: result.signerAgentId,
      namespace: Object.freeze({
        namespaceId: namespace.namespaceId,
        domainId: namespace.domainId,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: namespace.expectedAccessRevision,
        expectedPolicyRevision: namespace.expectedPolicyRevision,
      }),
    }),
    domainRequirements: Object.freeze([Object.freeze({
      domainId: domain.domainId,
      sourceNamespaceId: domain.sourceNamespaceId,
      participantDigest: domain.participantDigest.slice(),
      participantCount: domain.participantCount,
      keyClass: "ai",
      domainKeyGeneration: domain.domainKeyGeneration,
      authorizationRevision: domain.authorizationRevision,
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest:
        domain.activeNamespaceBindingSetDigest.slice(),
      activeNamespaceBindingCount: domain.activeNamespaceBindingCount,
    })] as const),
    namespaceRequirements: Object.freeze([Object.freeze({
      ordinal: 0 as const,
      namespaceId: requirement.namespaceId,
      domainId: requirement.domainId,
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: requirement.expectedAccessRevision,
      expectedPolicyRevision: requirement.expectedPolicyRevision,
    })] as const),
  }) as TaskRuntimeCancellationResultEvidenceV1;
}

function cancellationEvidenceFingerprint(
  value: TaskRuntimeCancellationResultEvidenceV1,
): string {
  return JSON.stringify({
    purpose: value.purpose,
    requestId: value.requestId,
    workId: value.workId,
    claimId: value.claimId,
    claimExpiresAt: value.claimExpiresAt,
    recipientExpiresAt: value.recipientExpiresAt,
    expiresAt: value.expiresAt,
    recipientGeneration: value.recipientGeneration,
    recipientKeyId: value.recipientKeyId,
    authorizationDigest: bytesToHex(value.authorizationDigest),
    policyRevision: value.policyRevision,
    episodeId: value.episodeId,
    sourceRoomId: value.sourceRoomId,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
    recipientAuthorizationRevision: value.recipientAuthorizationRevision,
    operations: value.operations,
    result: value.result,
    domainRequirements: value.domainRequirements.map((entry) => ({
      ...entry,
      participantDigest: bytesToHex(entry.participantDigest),
      headDigest: bytesToHex(entry.headDigest),
      activeNamespaceBindingSetDigest: bytesToHex(
        entry.activeNamespaceBindingSetDigest,
      ),
    })),
    namespaceRequirements: value.namespaceRequirements,
  });
}

export function assertAuthenticTaskRuntimeCancellationResultEvidenceV1(
  evidence: TaskRuntimeCancellationResultEvidenceV1,
): void {
  const state = cancellationEvidenceStates.get(evidence as object);
  const currentTime = state?.now();
  if (state === undefined
    || !state.active
    || state.signal.aborted
    || currentTime === undefined
    || !Number.isSafeInteger(currentTime)
    || currentTime >= evidence.expiresAt
    || state.fingerprint !== cancellationEvidenceFingerprint(evidence)) {
    if (state !== undefined) state.active = false;
    throw new TypeError("Task Runtime cancellation result evidence is not active");
  }
}

async function withCancellationResultEvidence<Value>(input: Readonly<{
  readonly evidence: Omit<TaskRuntimeCancellationResultEvidenceV1,
    typeof taskRuntimeCancellationResultEvidenceBrand>;
  readonly signal: AbortSignal;
  readonly now: () => number;
  execute(
    evidence: TaskRuntimeCancellationResultEvidenceV1,
  ): Value | PromiseLike<Value>;
}>): Promise<Value> {
  const evidence = cloneCancellationEvidence(input.evidence);
  const state: CancellationEvidenceState = {
    active: true,
    fingerprint: cancellationEvidenceFingerprint(evidence),
    signal: input.signal,
    now: input.now,
  };
  cancellationEvidenceStates.set(evidence, state);
  try {
    assertAuthenticTaskRuntimeCancellationResultEvidenceV1(evidence);
    return await input.execute(evidence);
  } finally {
    state.active = false;
    cancellationEvidenceStates.delete(evidence);
  }
}

export type TaskRuntimeRecipientAttemptV1 = Readonly<{
  requestId: string;
  workId: string;
  recipientGeneration: number;
  recipientKeyId: string;
  recipientPublicKey: Uint8Array;
  expiresAt: number;
  signer?: TaskRuntimeEphemeralSignerV2;
}>;

export type TaskRuntimeRecipientCreationResultV1 =
  | Readonly<{
    status: "created";
    attempt: TaskRuntimeRecipientAttemptV1;
  }>
  | Readonly<{
    status: "unavailable";
    reason: "duplicate_attempt" | "duplicate_work" | "process_capacity" | "registry_closed";
  }>;

export type TaskRuntimeRecipientOpenResultV1<Value> =
  | OpenDomainForegroundAuthorizationResultV2<Value>
  | Readonly<{
    status: "unavailable";
    reason:
      | "recipient_expired"
      | "recipient_in_use"
      | "recipient_key_mismatch"
      | "recipient_unavailable"
      | "registry_closed";
  }>;

export interface TaskRuntimeRecipientDeadlineHandleV1 {
  cancel(): void;
}

export interface TaskRuntimeRecipientDeadlineSchedulerV1 {
  scheduleAt(
    deadline: number,
    expire: () => void,
  ): TaskRuntimeRecipientDeadlineHandleV1;
}

type RecipientEntry = {
  readonly attempt: TaskRuntimeRecipientAttemptV1;
  readonly privateKey: Uint8Array;
  readonly temporaryRuntime: AgentRuntimeGenerationV2 | null;
  state: "ready" | "running";
  controller: AbortController | null;
};

export type TaskRuntimeTemporarySignerV1 = Readonly<{
  runtime: AgentRuntimeGenerationV2;
  certificateBytes: Uint8Array;
  issuer: BackgroundAuthorizationIssuerV2;
  issuerSigningPublicKey: Uint8Array;
  requestHash: Uint8Array;
  authorizationHash: Uint8Array;
  signerPublicKey: Uint8Array;
}>;

export type TaskRuntimeCertifiedSigningInputV1 = Readonly<{
  requestBytes: Uint8Array;
  certificateBytes: Uint8Array;
  currentIssuer: BackgroundAuthorizationIssuerV2;
  expectedExecutionSegment: number;
}>;

export type TaskRuntimeCertifiedPublicationSigningInputV1 = Readonly<{
  requestBytes: Uint8Array;
  certificateBytes: Uint8Array;
  currentIssuer: BackgroundAuthorizationIssuerV2;
  expectedPublication: TaskRuntimePublicationWorkBindingV3;
}>;

type TaskRuntimeTemporarySignerStateV1 = Readonly<{
  runtime: AgentRuntimeGenerationV2;
  certificateBytes: Uint8Array;
  issuer: BackgroundAuthorizationIssuerV2;
  issuerSigningPublicKey: Uint8Array;
  requestHash: Uint8Array;
  authorizationHash: Uint8Array;
  signerPublicKey: Uint8Array;
  signal: AbortSignal;
}> & { active: boolean };

const temporarySignerStates = new WeakMap<
  object,
  TaskRuntimeTemporarySignerStateV1
>();

export type TaskRuntimeTemporarySignerEvidenceV1 =
  | TaskRuntimeExecutionEvidenceV1
  | TaskRuntimeCancellationResultEvidenceV1
  | TaskRuntimeTerminalMessageEvidenceV1
  | TaskRuntimeRunResultReadEvidenceV1
  | TaskRuntimeWakeForegroundEvidenceV1;

function attemptKey(requestId: string, generation: number): string {
  return JSON.stringify([requestId, generation]);
}

function publicAttempt(entry: RecipientEntry): TaskRuntimeRecipientAttemptV1 {
  return Object.freeze({
    ...entry.attempt,
    recipientPublicKey: entry.attempt.recipientPublicKey.slice(),
    ...(entry.attempt.signer === undefined ? {} : {
      signer: Object.freeze({
        ...entry.attempt.signer,
        signerPublicKey: entry.attempt.signer.signerPublicKey.slice(),
      }),
    }),
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameIssuer(
  left: BackgroundAuthorizationIssuerV2,
  right: BackgroundAuthorizationIssuerV2,
): boolean {
  return left.humanId === right.humanId
    && left.deviceId === right.deviceId
    && left.deviceGeneration === right.deviceGeneration
    && left.serverInstanceId === right.serverInstanceId
    && left.lineageGeneration === right.lineageGeneration
    && left.epoch === right.epoch
    && left.securityRevision === right.securityRevision
    && sameBytes(left.headDigest, right.headDigest)
    && sameBytes(left.signingPublicKeyHash, right.signingPublicKeyHash);
}

function copyIssuer(
  value: BackgroundAuthorizationIssuerV2,
): BackgroundAuthorizationIssuerV2 {
  return Object.freeze({
    ...value,
    headDigest: value.headDigest.slice(),
    signingPublicKeyHash: value.signingPublicKeyHash.slice(),
  });
}

function destroyIssuer(value: BackgroundAuthorizationIssuerV2): void {
  value.headDigest.fill(0);
  value.signingPublicKeyHash.fill(0);
}

function sameNamespaceRequirements(
  left: readonly TaskRuntimeExecutionNamespaceAuthorityV1[],
  right: readonly TaskRuntimeExecutionNamespaceAuthorityV1[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return other !== undefined
      && value.ordinal === other.ordinal
      && value.namespaceId === other.namespaceId
      && value.domainId === other.domainId
      && value.operations.length === other.operations.length
      && value.operations.every((operation, operationIndex) =>
        operation === other.operations[operationIndex])
      && value.expectedAccessRevision === other.expectedAccessRevision
      && value.expectedPolicyRevision === other.expectedPolicyRevision;
  });
}

async function verifyTemporarySignerAuthorization(input: Readonly<{
  crypto: LatticeCrypto;
  now: number;
  entry: RecipientEntry;
  requestId: string;
  workId: string;
  recipientGeneration: number;
  recipientKeyId: string;
  authorizationBytes: Uint8Array;
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
  currentNamespaceRequirements:
    readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
  result: TaskRuntimeExecutionEvidenceInputV1["result"];
  certifiedSigning: TaskRuntimeCertifiedSigningInputV1;
}>): Promise<VerifiedCurrentTaskRuntimeSignerAuthorizationV1> {
  const requestHash = input.crypto.hash(input.certifiedSigning.requestBytes);
  const authorizationHash = input.crypto.hash(input.authorizationBytes);
  const currentSigningPublicKeyHash = input.crypto.hash(
    input.current.committerDeviceSigningPublicKey,
  );
  let verified: VerifiedCurrentTaskRuntimeSignerAuthorizationV1 | undefined;
  try {
    verified = await verifyCurrentTaskRuntimeSignerAuthorizationV1(
      input.crypto,
      {
        certificateBytes: input.certifiedSigning.certificateBytes,
        requestBytes: input.certifiedSigning.requestBytes,
        expectedRequestHash: requestHash,
        expectedAuthorizationHash: authorizationHash,
        now: input.now,
        resolveCurrentIssuer: context =>
          sameIssuer(context.issuer, input.certifiedSigning.currentIssuer)
            && context.issuer.humanId === input.current.subjectHumanId
            && context.issuer.deviceId === input.current.committerDeviceId
            && context.issuer.deviceGeneration
              === input.current.committerDeviceSigningGeneration
            && context.issuer.securityRevision
              === input.current.hostAuthorizationRevision
            && sameBytes(
              context.issuer.signingPublicKeyHash,
              currentSigningPublicKeyHash,
            )
            ? input.current.committerDeviceSigningPublicKey
            : null,
      },
    );
    const request = verified.request;
    const signer = input.entry.attempt.signer;
    if (input.entry.temporaryRuntime === null || signer === undefined
      || request.baseRequest.requestId !== input.requestId
      || request.baseRequest.workId !== input.workId
      || request.baseRequest.recipientGeneration !== input.recipientGeneration
      || request.baseRequest.recipientKeyId !== input.recipientKeyId
      || !sameBytes(request.baseRequest.recipientPublicKey,
        input.entry.attempt.recipientPublicKey)
      || request.baseRequest.deadlineAt !== input.entry.attempt.expiresAt
      || request.work.taskId !== input.result.taskId
      || request.work.taskRunId !== input.result.taskRunId
      || request.work.resultObjectId !== input.result.objectId
      || !Number.isSafeInteger(
        input.certifiedSigning.expectedExecutionSegment,
      )
      || input.certifiedSigning.expectedExecutionSegment < 1
      || request.work.executionSegment
        !== input.certifiedSigning.expectedExecutionSegment
      || request.signer.agentId !== input.result.signerAgentId
      || request.signer.agentId !== signer.agentId
      || request.signer.runtimeGeneration !== signer.runtimeGeneration
      || request.signer.signerKeyId !== signer.signerKeyId
      || !sameBytes(request.signer.signerPublicKey, signer.signerPublicKey)
      || !sameNamespaceRequirements(
        request.namespaceRequirements,
        input.currentNamespaceRequirements,
      )) {
      throw new TypeError("Task Runtime certified signer scope is not exact");
    }
    const result = verified;
    verified = undefined;
    return result;
  } finally {
    requestHash.fill(0);
    authorizationHash.fill(0);
    currentSigningPublicKeyHash.fill(0);
    if (verified !== undefined) {
      destroyVerifiedTaskRuntimeSignerAuthorizationV1(verified);
    }
  }
}

function samePublicationWork(
  left: TaskRuntimePublicationWorkBindingV3,
  right: TaskRuntimePublicationWorkBindingV3,
): boolean {
  const leftBytes = encodeTaskRuntimePublicationWorkBindingV3(left);
  const rightBytes = encodeTaskRuntimePublicationWorkBindingV3(right);
  try {
    return sameBytes(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function assertPublicationProofBinding(input: Readonly<{
  expected: TaskRuntimePublicationWorkBindingV3;
  kind: TaskRuntimePublicationWorkBindingV3["kind"];
  taskId: string;
  taskRunId: string;
  contentRevision: 1 | 2;
  selectedId?: string;
}>): void {
  const selectedMatches = input.kind === "task.deliver_message"
    ? input.expected.kind === input.kind
      && input.expected.messageObjectId === input.selectedId
    : input.kind === "task.delivery_wake"
      ? input.expected.kind === input.kind
        && input.expected.jobId === input.selectedId
      : input.expected.kind === input.kind;
  if (!selectedMatches
    || input.expected.taskId !== input.taskId
    || input.expected.taskRunId !== input.taskRunId
    || input.expected.contentRevision !== input.contentRevision) {
    throw new TypeError("Task Runtime certified publication proof is not exact");
  }
}

async function verifyTemporaryPublicationSignerAuthorization(input: Readonly<{
  crypto: LatticeCrypto;
  now: number;
  entry: RecipientEntry;
  requestId: string;
  workId: string;
  recipientGeneration: number;
  recipientKeyId: string;
  authorizationBytes: Uint8Array;
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
  currentNamespaceRequirements:
    readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
  certifiedSigning: TaskRuntimeCertifiedPublicationSigningInputV1;
}>): Promise<VerifiedCurrentTaskRuntimeSignerAuthorization> {
  const requestHash = input.crypto.hash(input.certifiedSigning.requestBytes);
  const authorizationHash = input.crypto.hash(input.authorizationBytes);
  const currentSigningPublicKeyHash = input.crypto.hash(
    input.current.committerDeviceSigningPublicKey,
  );
  let verified: VerifiedCurrentTaskRuntimeSignerAuthorization | undefined;
  try {
    verified = await verifyCurrentTaskRuntimeSignerAuthorization(
      input.crypto,
      {
        certificateBytes: input.certifiedSigning.certificateBytes,
        requestBytes: input.certifiedSigning.requestBytes,
        expectedRequestHash: requestHash,
        expectedAuthorizationHash: authorizationHash,
        now: input.now,
        resolveCurrentIssuer: context =>
          sameIssuer(context.issuer, input.certifiedSigning.currentIssuer)
            && context.issuer.humanId === input.current.subjectHumanId
            && context.issuer.deviceId === input.current.committerDeviceId
            && context.issuer.deviceGeneration
              === input.current.committerDeviceSigningGeneration
            && context.issuer.securityRevision
              === input.current.hostAuthorizationRevision
            && sameBytes(
              context.issuer.signingPublicKeyHash,
              currentSigningPublicKeyHash,
            )
            ? input.current.committerDeviceSigningPublicKey
            : null,
      },
      2,
    );
    const request = verified.request;
    const signer = input.entry.attempt.signer;
    if (request.formatVersion !== 3
      || verified.projection.formatVersion !== 2
      || input.entry.temporaryRuntime === null
      || signer === undefined
      || request.baseRequest.requestId !== input.requestId
      || request.baseRequest.workId !== input.workId
      || request.baseRequest.recipientGeneration !== input.recipientGeneration
      || request.baseRequest.recipientKeyId !== input.recipientKeyId
      || !sameBytes(
        request.baseRequest.recipientPublicKey,
        input.entry.attempt.recipientPublicKey,
      )
      || request.baseRequest.deadlineAt !== input.entry.attempt.expiresAt
      || !samePublicationWork(
        request.work,
        input.certifiedSigning.expectedPublication,
      )
      || request.signer.agentId !== signer.agentId
      || request.signer.runtimeGeneration !== signer.runtimeGeneration
      || request.signer.signerKeyId !== signer.signerKeyId
      || !sameBytes(request.signer.signerPublicKey, signer.signerPublicKey)
      || !sameNamespaceRequirements(
        request.namespaceRequirements,
        input.currentNamespaceRequirements,
      )) {
      throw new TypeError("Task Runtime certified publication scope is not exact");
    }
    const result = verified;
    verified = undefined;
    return result;
  } finally {
    requestHash.fill(0);
    authorizationHash.fill(0);
    currentSigningPublicKeyHash.fill(0);
    if (verified !== undefined) {
      destroyVerifiedTaskRuntimeSignerAuthorization(verified);
    }
  }
}

function destroyTemporarySigner(value: TaskRuntimeTemporarySignerV1): void {
  value.runtime.key.fill(0);
  value.certificateBytes.fill(0);
  destroyIssuer(value.issuer);
  value.issuerSigningPublicKey.fill(0);
  value.requestHash.fill(0);
  value.authorizationHash.fill(0);
  value.signerPublicKey.fill(0);
}

function temporarySignerCopy(
  state: TaskRuntimeTemporarySignerStateV1,
): TaskRuntimeTemporarySignerV1 {
  return Object.freeze({
    runtime: Object.freeze({
      ...state.runtime,
      key: state.runtime.key.slice(),
    }),
    certificateBytes: state.certificateBytes.slice(),
    issuer: copyIssuer(state.issuer),
    issuerSigningPublicKey: state.issuerSigningPublicKey.slice(),
    requestHash: state.requestHash.slice(),
    authorizationHash: state.authorizationHash.slice(),
    signerPublicKey: state.signerPublicKey.slice(),
  });
}

function assertAuthenticTaskRuntimeTemporarySignerEvidenceV1(
  evidence: TaskRuntimeTemporarySignerEvidenceV1,
): void {
  switch (evidence.purpose) {
    case "task.runtime.execution":
      assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
      break;
    case "task.runtime.cancellation_result":
      assertAuthenticTaskRuntimeCancellationResultEvidenceV1(evidence);
      break;
    case "task.runtime.terminal_message":
      assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence);
      break;
    case "task.runtime.run_result_read":
      assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence);
      break;
    case "task.runtime.wake_foreground":
      assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence);
      break;
  }
}

/** True only for active certified Task Runtime evidence; stale evidence throws. */
export function hasTaskRuntimeTemporarySignerV1(
  evidence: TaskRuntimeTemporarySignerEvidenceV1,
): boolean {
  assertAuthenticTaskRuntimeTemporarySignerEvidenceV1(evidence);
  const state = temporarySignerStates.get(evidence as object);
  if (state === undefined) return false;
  if (!state.active || state.signal.aborted) {
    throw new TypeError("Task Runtime temporary signer is not active");
  }
  return true;
}

/** Loan detached signer copies only while certified evidence is active. */
export async function withTaskRuntimeTemporarySignerV1<Value>(
  evidence: TaskRuntimeTemporarySignerEvidenceV1,
  use: (
    signer: TaskRuntimeTemporarySignerV1,
  ) => Value | PromiseLike<Value>,
): Promise<Value> {
  if (typeof use !== "function") {
    throw new TypeError("Task Runtime temporary signer callback is required");
  }
  assertAuthenticTaskRuntimeTemporarySignerEvidenceV1(evidence);
  const state = temporarySignerStates.get(evidence as object);
  if (state === undefined || !state.active || state.signal.aborted) {
    throw new TypeError("Task Runtime temporary signer is not active");
  }
  const signer = temporarySignerCopy(state);
  const wipeSigner = () => destroyTemporarySigner(signer);
  state.signal.addEventListener("abort", wipeSigner, { once: true });
  try {
    if (state.signal.aborted) {
      wipeSigner();
      throw new TypeError("Task Runtime temporary signer is not active");
    }
    const value = await use(signer);
    assertAuthenticTaskRuntimeTemporarySignerEvidenceV1(evidence);
    if (!state.active || state.signal.aborted
      || temporarySignerStates.get(evidence as object) !== state) {
      throw new TypeError("Task Runtime temporary signer is not active");
    }
    return value;
  } finally {
    state.signal.removeEventListener("abort", wipeSigner);
    wipeSigner();
  }
}

async function withInstalledTaskRuntimeTemporarySignerV1<Value>(input: Readonly<{
  evidence: TaskRuntimeTemporarySignerEvidenceV1;
  signal: AbortSignal;
  entry: RecipientEntry;
  verified: VerifiedCurrentTaskRuntimeSignerAuthorization;
  issuerSigningPublicKey: Uint8Array;
  operation(): Value | PromiseLike<Value>;
}>): Promise<Value> {
  assertAuthenticTaskRuntimeTemporarySignerEvidenceV1(input.evidence);
  const runtime = input.entry.temporaryRuntime;
  const signer = input.entry.attempt.signer;
  if (runtime === null || signer === undefined) {
    throw new TypeError("Task Runtime certified signer custody is unavailable");
  }
  const state: TaskRuntimeTemporarySignerStateV1 = {
    active: true,
    runtime,
    certificateBytes: input.verified.certificateBytes,
    issuer: input.verified.issuer,
    issuerSigningPublicKey: input.issuerSigningPublicKey.slice(),
    requestHash: input.verified.requestHash,
    authorizationHash: input.verified.projection.request.authorizationHash,
    signerPublicKey: signer.signerPublicKey,
    signal: input.signal,
  };
  temporarySignerStates.set(input.evidence as object, state);
  try {
    return await input.operation();
  } finally {
    state.active = false;
    temporarySignerStates.delete(input.evidence as object);
    state.issuerSigningPublicKey.fill(0);
  }
}

function copyPublicCurrentAuthority(
  value: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): DomainForegroundAuthorizationPublicCurrentAuthorityV2 {
  return Object.freeze({
    ...value,
    committerDeviceSigningPublicKey:
      Uint8Array.from(value.committerDeviceSigningPublicKey),
    domains: Object.freeze(value.domains.map((domain) => Object.freeze({
      ...domain,
      participantDigest: Uint8Array.from(domain.participantDigest),
      headDigest: Uint8Array.from(domain.headDigest),
      activeNamespaceBindingSetDigest:
        Uint8Array.from(domain.activeNamespaceBindingSetDigest),
    }))),
  });
}

function unavailable(
  reason: Extract<
    TaskRuntimeRecipientOpenResultV1<never>,
    { status: "unavailable" }
  >["reason"],
): TaskRuntimeRecipientOpenResultV1<never> {
  return Object.freeze({ status: "unavailable", reason });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string"
      ? signal.reason
      : "Task Runtime recipient was cancelled",
  );
  error.name = "AbortError";
  return error;
}

/**
 * Bounded process-local custody for one Task Runtime HPKE recipient attempt.
 * Private keys are never serialised and are wiped on use, expiry, deletion,
 * cancellation, or shutdown.
 */
export class TaskRuntimeRecipientRegistryV1 {
  readonly #entries = new Map<string, RecipientEntry>();
  readonly #workIds = new Map<string, RecipientEntry>();
  readonly #maxLive: number;
  readonly #now: () => number;
  readonly #scheduler: TaskRuntimeRecipientDeadlineSchedulerV1;
  #closed = false;

  constructor(private readonly crypto: LatticeCrypto, input: Readonly<{
    now?: () => number;
    scheduler?: TaskRuntimeRecipientDeadlineSchedulerV1;
    maxLive?: number;
  }> = {}) {
    this.#now = input.now ?? Date.now;
    this.#scheduler = input.scheduler ?? {
      scheduleAt: (deadline, expire) => {
        const timer = setTimeout(expire, Math.max(0, deadline - this.#now()));
        return Object.freeze({ cancel: () => clearTimeout(timer) });
      },
    };
    this.#maxLive = input.maxLive
      ?? PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1;
    if (
      !Number.isSafeInteger(this.#maxLive)
      || this.#maxLive < 1
      || this.#maxLive > PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1
    ) throw new TypeError("Task Runtime recipient bound is invalid");
  }

  get size(): number {
    return this.#entries.size;
  }

  hasAttempt(input: Readonly<{
    requestId: string;
    workId: string;
    recipientGeneration: number;
    recipientKeyId: string;
  }>): boolean {
    assertPortableId("Task Runtime recipient request id", input.requestId);
    assertPortableId("Task Runtime recipient work id", input.workId);
    assertU64Counter(
      "Task Runtime recipient generation",
      input.recipientGeneration,
    );
    assertPortableId("Task Runtime recipient key id", input.recipientKeyId);
    if (this.#closed) return false;
    this.sweep();
    const entry = this.#entries.get(attemptKey(
      input.requestId,
      input.recipientGeneration,
    ));
    return entry !== undefined
      && entry.attempt.workId === input.workId
      && entry.attempt.recipientKeyId === input.recipientKeyId;
  }

  async createAttempt(input: Readonly<{
    requestId: string;
    workId: string;
    recipientGeneration: number;
    recipientKeyId: string;
    expiresAt: number;
    signerAgentId?: string;
  }>): Promise<TaskRuntimeRecipientCreationResultV1> {
    if (this.#closed) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "registry_closed" as const,
      });
    }
    assertPortableId("Task Runtime recipient request id", input.requestId);
    assertPortableId("Task Runtime recipient work id", input.workId);
    assertPortableId("Task Runtime recipient key id", input.recipientKeyId);
    if (input.signerAgentId !== undefined) {
      assertPortableId("Task Runtime temporary signer Agent id", input.signerAgentId);
    }
    assertU64Counter(
      "Task Runtime recipient generation",
      input.recipientGeneration,
    );
    assertU64Counter("Task Runtime recipient expiry", input.expiresAt);
    const startedAt = this.#now();
    if (
      input.expiresAt <= startedAt
      || input.expiresAt - startedAt
        > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2
    ) throw new RangeError("Task Runtime recipient expiry is invalid");

    const pair = await this.crypto.generateEncryptionKeyPair();
    let temporaryRuntime: AgentRuntimeGenerationV2 | undefined;
    let signerPublicKey: Uint8Array | undefined;
    let signer: TaskRuntimeEphemeralSignerV2 | undefined;
    let stored = false;
    try {
      if (
        pair.privateKey.length !== V2_LIMITS.hpkePrivateKeyBytes
        || pair.publicKey.length !== V2_LIMITS.hpkePublicKeyBytes
      ) throw new TypeError("Task Runtime recipient keypair is malformed");
      if (input.signerAgentId !== undefined) {
        const runtimeKey = this.crypto.randomBytes(AGENT_RUNTIME_KEY_BYTES);
        if (!(runtimeKey instanceof Uint8Array)
          || runtimeKey.length !== AGENT_RUNTIME_KEY_BYTES) {
          if (runtimeKey instanceof Uint8Array) runtimeKey.fill(0);
          throw new TypeError("Task Runtime temporary signer key is malformed");
        }
        temporaryRuntime = Object.freeze({
          agentId: agentId(input.signerAgentId),
          keyClass: "runtime" as const,
          generation: agentRuntimeGeneration(0),
          key: runtimeKey,
        });
        const derived = deriveAgentRuntimeObjectSignerPublicV1(
          this.crypto,
          temporaryRuntime,
        );
        signerPublicKey = derived.publicKey;
        signer = Object.freeze({
          agentId: derived.principal.agentId,
          runtimeGeneration: 0,
          signerKeyId: derived.principal.signerKeyId,
          signerPublicKey: derived.publicKey.slice(),
        });
      }
      if (this.#closed) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "registry_closed" as const,
        });
      }
      const committedAt = this.#now();
      if (
        input.expiresAt <= committedAt
        || input.expiresAt - committedAt
          > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2
      ) throw new RangeError("Task Runtime recipient expiry is invalid");
      this.sweep();
      const key = attemptKey(input.requestId, input.recipientGeneration);
      if (this.#entries.has(key)) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "duplicate_attempt" as const,
        });
      }
      if (this.#workIds.has(input.workId)) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "duplicate_work" as const,
        });
      }
      if (this.#entries.size >= this.#maxLive) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "process_capacity" as const,
        });
      }
      const entry: RecipientEntry = {
        attempt: Object.freeze({
          requestId: input.requestId,
          workId: input.workId,
          recipientGeneration: input.recipientGeneration,
          recipientKeyId: input.recipientKeyId,
          expiresAt: input.expiresAt,
          recipientPublicKey: pair.publicKey.slice(),
          ...(signer === undefined ? {} : { signer }),
        }),
        privateKey: pair.privateKey,
        temporaryRuntime: temporaryRuntime ?? null,
        state: "ready",
        controller: null,
      };
      this.#entries.set(key, entry);
      this.#workIds.set(input.workId, entry);
      stored = true;
      return Object.freeze({ status: "created", attempt: publicAttempt(entry) });
    } finally {
      pair.publicKey.fill(0);
      if (!stored) pair.privateKey.fill(0);
      signerPublicKey?.fill(0);
      if (!stored) {
        temporaryRuntime?.key.fill(0);
        signer?.signerPublicKey.fill(0);
      }
    }
  }

  async withOpenedGrant<Value>(input: Readonly<{
    requestId: string;
    workId: string;
    recipientGeneration: number;
    recipientKeyId: string;
    claimId: string;
    claimExpiresAt: number;
    authorizationBytes: Uint8Array;
    current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    currentNamespaceRequirements:
      readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
    result: TaskRuntimeExecutionEvidenceInputV1["result"];
    certifiedSigning?: TaskRuntimeCertifiedSigningInputV1;
    signal?: AbortSignal;
    operation(
      domains: readonly DomainForegroundSecretEntryV2[],
      signal: AbortSignal,
      evidence: TaskRuntimeExecutionEvidenceV1,
    ): Value | PromiseLike<Value>;
  }>): Promise<TaskRuntimeRecipientOpenResultV1<Value>> {
    return this.#withOpenedAuthorization({
      ...input,
      expectedOperations: ["decrypt", "encrypt"],
      authorityIsCurrent: () => resultAuthorityIsCurrent({
        workId: input.workId,
        result: input.result,
        namespaces: input.currentNamespaceRequirements,
        current: input.current,
      }),
      operation: async (domains, signal, entry, deadline) => {
        const hasTemporarySigner = entry.temporaryRuntime !== null
          && entry.attempt.signer !== undefined;
        if (hasTemporarySigner !== (input.certifiedSigning !== undefined)) {
          throw new TypeError(
            "Task Runtime certified signer custody is not exact",
          );
        }
        let verifiedSigner: VerifiedCurrentTaskRuntimeSignerAuthorizationV1
          | undefined;
        const authorizationDigest = this.crypto.hash(input.authorizationBytes);
        try {
          if (input.certifiedSigning !== undefined) {
            verifiedSigner = await verifyTemporarySignerAuthorization({
              crypto: this.crypto,
              now: this.#now(),
              entry,
              requestId: input.requestId,
              workId: input.workId,
              recipientGeneration: input.recipientGeneration,
              recipientKeyId: input.recipientKeyId,
              authorizationBytes: input.authorizationBytes,
              current: input.current,
              currentNamespaceRequirements: input.currentNamespaceRequirements,
              result: input.result,
              certifiedSigning: input.certifiedSigning,
            });
          }
          return await withTaskRuntimeExecutionEvidenceV1({
            evidence: {
              requestId: input.requestId,
              workId: input.workId,
              claimId: input.claimId,
              claimExpiresAt: input.claimExpiresAt,
              recipientExpiresAt: entry.attempt.expiresAt,
              expiresAt: deadline,
              recipientGeneration: input.recipientGeneration,
              recipientKeyId: input.recipientKeyId,
              authorizationDigest,
              policyRevision: input.current.policyRevision,
              episodeId: input.current.sessionId,
              sourceRoomId: input.current.roomId,
              hostAuthorizationRevision: input.current.hostAuthorizationRevision,
              recipientAuthorizationRevision:
                input.current.recipientAuthorizationRevision,
              result: input.result,
              domainRequirements: input.current.domains,
              namespaceRequirements: input.currentNamespaceRequirements,
            },
            signal,
            now: this.#now,
            execute: async (evidence) => {
              if (verifiedSigner === undefined) {
                return await input.operation(domains, signal, evidence);
              }
              return await withInstalledTaskRuntimeTemporarySignerV1({
                evidence,
                signal,
                entry,
                verified: verifiedSigner,
                issuerSigningPublicKey:
                  input.current.committerDeviceSigningPublicKey,
                operation: () => input.operation(domains, signal, evidence),
              });
            },
          });
        } finally {
          authorizationDigest.fill(0);
          if (verifiedSigner !== undefined) {
            destroyVerifiedTaskRuntimeSignerAuthorizationV1(verifiedSigner);
          }
        }
      },
    });
  }

  async withOpenedCancellationResultGrant<Value>(input: Readonly<{
    requestId: string;
    workId: string;
    recipientGeneration: number;
    recipientKeyId: string;
    claimId: string;
    claimExpiresAt: number;
    authorizationBytes: Uint8Array;
    current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    currentNamespaceRequirements:
      readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
    result: TaskRuntimeCancellationResultProofV1;
    certifiedSigning?: TaskRuntimeCertifiedPublicationSigningInputV1;
    signal?: AbortSignal;
    operation(
      domains: readonly DomainForegroundSecretEntryV2[],
      signal: AbortSignal,
      evidence: TaskRuntimeCancellationResultEvidenceV1,
    ): Value | PromiseLike<Value>;
  }>): Promise<TaskRuntimeRecipientOpenResultV1<Value>> {
    const authorizationBytes = input.authorizationBytes.slice();
    const current = copyPublicCurrentAuthority(input.current);
    const currentNamespaceRequirements = Object.freeze(
      input.currentNamespaceRequirements.map((requirement) => Object.freeze({
        ...requirement,
        operations: Object.freeze([...requirement.operations]),
      })),
    );
    const result = Object.freeze({
      ...input.result,
      namespace: Object.freeze({
        ...input.result.namespace,
        operations: Object.freeze([...input.result.namespace.operations]),
      }),
    }) as TaskRuntimeCancellationResultProofV1;
    try {
      return await this.#withOpenedAuthorization({
        ...input,
        authorizationBytes,
        current,
        expectedOperations: ["encrypt"],
        authorityIsCurrent: () => cancellationResultAuthorityIsCurrent({
          crypto: this.crypto,
          workId: input.workId,
          result,
          namespaces: currentNamespaceRequirements,
          current,
        }),
        operation: async (domains, signal, entry, deadline) => {
          const hasTemporarySigner = entry.temporaryRuntime !== null
            && entry.attempt.signer !== undefined;
          if (hasTemporarySigner !== (input.certifiedSigning !== undefined)) {
            throw new TypeError(
              "Task Runtime certified signer custody is not exact",
            );
          }
          const domainRequirement = current.domains[0];
          const namespaceRequirement = currentNamespaceRequirements[0];
          if (domainRequirement === undefined || namespaceRequirement === undefined) {
            throw new TypeError("Task Runtime cancellation authority is incomplete");
          }
          let verifiedSigner: VerifiedCurrentTaskRuntimeSignerAuthorization
            | undefined;
          const authorizationDigest = this.crypto.hash(authorizationBytes);
          try {
            if (input.certifiedSigning !== undefined) {
              assertPublicationProofBinding({
                expected: input.certifiedSigning.expectedPublication,
                kind: "task.cancel_result",
                taskId: result.taskId,
                taskRunId: result.taskRunId,
                contentRevision: result.contentRevision,
              });
              verifiedSigner = await verifyTemporaryPublicationSignerAuthorization({
                crypto: this.crypto,
                now: this.#now(),
                entry,
                requestId: input.requestId,
                workId: input.workId,
                recipientGeneration: input.recipientGeneration,
                recipientKeyId: input.recipientKeyId,
                authorizationBytes,
                current,
                currentNamespaceRequirements,
                certifiedSigning: input.certifiedSigning,
              });
            }
            return await withCancellationResultEvidence({
              evidence: {
                purpose: "task.runtime.cancellation_result",
                requestId: input.requestId,
                workId: input.workId,
                claimId: input.claimId,
                claimExpiresAt: input.claimExpiresAt,
                recipientExpiresAt: entry.attempt.expiresAt,
                expiresAt: deadline,
                recipientGeneration: input.recipientGeneration,
                recipientKeyId: input.recipientKeyId,
                authorizationDigest,
                policyRevision: current.policyRevision,
                episodeId: current.sessionId,
                sourceRoomId: current.roomId,
                hostAuthorizationRevision: current.hostAuthorizationRevision,
                recipientAuthorizationRevision:
                  current.recipientAuthorizationRevision,
                operations: ["encrypt"],
                result,
                domainRequirements: [domainRequirement],
                namespaceRequirements: [{
                  ...namespaceRequirement,
                  ordinal: 0,
                  operations: ["encrypt"],
                }],
              },
              signal,
              now: this.#now,
              execute: async (evidence) => verifiedSigner === undefined
                ? await input.operation(domains, signal, evidence)
                : await withInstalledTaskRuntimeTemporarySignerV1({
                    evidence,
                    signal,
                    entry,
                    verified: verifiedSigner,
                    issuerSigningPublicKey:
                      current.committerDeviceSigningPublicKey,
                    operation: () => input.operation(domains, signal, evidence),
                  }),
            });
          } finally {
            authorizationDigest.fill(0);
            if (verifiedSigner !== undefined) {
              destroyVerifiedTaskRuntimeSignerAuthorization(verifiedSigner);
            }
          }
        },
      });
    } finally {
      authorizationBytes.fill(0);
    }
  }

  /**
   * Opens one accepted encrypt-only terminal Message grant. The callback-only
   * evidence is deliberately disjoint from running execution and cancellation
   * result evidence, and is invalidated before this method returns.
   */
  async withOpenedTerminalMessageGrant<Value>(input: Readonly<{
    requestId: string;
    workId: string;
    recipientGeneration: number;
    recipientKeyId: string;
    claimId: string;
    claimExpiresAt: number;
    authorizationBytes: Uint8Array;
    current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    currentNamespaceRequirements:
      readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
    message: TaskRuntimeTerminalMessageProofV1;
    certifiedSigning?: TaskRuntimeCertifiedPublicationSigningInputV1;
    signal?: AbortSignal;
    operation(
      domains: readonly DomainForegroundSecretEntryV2[],
      signal: AbortSignal,
      evidence: TaskRuntimeTerminalMessageEvidenceV1,
    ): Value | PromiseLike<Value>;
  }>): Promise<TaskRuntimeRecipientOpenResultV1<Value>> {
    const authorizationBytes = input.authorizationBytes.slice();
    const current = copyPublicCurrentAuthority(input.current);
    const currentNamespaceRequirements = Object.freeze(
      input.currentNamespaceRequirements.map(requirement => Object.freeze({
        ...requirement,
        operations: Object.freeze([...requirement.operations]),
      })),
    );
    const message = Object.freeze({
      ...input.message,
      payloadDigest: input.message.payloadDigest.slice(),
    });
    try {
      return await this.#withOpenedAuthorization({
        ...input,
        authorizationBytes,
        current,
        expectedOperations: ["encrypt"],
        authorityIsCurrent: () => terminalMessageAuthorityIsCurrent({
          workId: input.workId,
          message,
          namespaces: currentNamespaceRequirements,
          current,
        }),
        operation: async (domains, signal, entry, deadline) => {
          const hasTemporarySigner = entry.temporaryRuntime !== null
            && entry.attempt.signer !== undefined;
          if (hasTemporarySigner !== (input.certifiedSigning !== undefined)) {
            throw new TypeError(
              "Task Runtime certified signer custody is not exact",
            );
          }
          const domainRequirement = current.domains[0];
          const namespaceRequirement = currentNamespaceRequirements[0];
          if (domainRequirement === undefined || namespaceRequirement === undefined) {
            throw new TypeError("Task Runtime terminal Message authority is incomplete");
          }
          let verifiedSigner: VerifiedCurrentTaskRuntimeSignerAuthorization
            | undefined;
          const authorizationDigest = this.crypto.hash(authorizationBytes);
          try {
            if (input.certifiedSigning !== undefined) {
              assertPublicationProofBinding({
                expected: input.certifiedSigning.expectedPublication,
                kind: "task.deliver_message",
                taskId: message.taskId,
                taskRunId: message.taskRunId,
                contentRevision: 2,
                selectedId: message.objectId,
              });
              verifiedSigner = await verifyTemporaryPublicationSignerAuthorization({
                crypto: this.crypto,
                now: this.#now(),
                entry,
                requestId: input.requestId,
                workId: input.workId,
                recipientGeneration: input.recipientGeneration,
                recipientKeyId: input.recipientKeyId,
                authorizationBytes,
                current,
                currentNamespaceRequirements,
                certifiedSigning: input.certifiedSigning,
              });
            }
            return await withTaskRuntimeTerminalMessageEvidenceV1({
              evidence: {
                purpose: "task.runtime.terminal_message",
                workKind: "task.deliver_message",
                requestId: input.requestId,
                workId: input.workId,
                claimId: input.claimId,
                claimExpiresAt: input.claimExpiresAt,
                recipientExpiresAt: entry.attempt.expiresAt,
                expiresAt: deadline,
                recipientGeneration: input.recipientGeneration,
                recipientKeyId: input.recipientKeyId,
                authorizationDigest,
                policyRevision: current.policyRevision,
                episodeId: current.sessionId,
                sourceRoomId: current.roomId,
                hostAuthorizationRevision: current.hostAuthorizationRevision,
                recipientAuthorizationRevision:
                  current.recipientAuthorizationRevision,
                operations: ["encrypt"],
                message,
                domainRequirements: [domainRequirement],
                namespaceRequirements: [{
                  ...namespaceRequirement,
                  ordinal: 0,
                  operations: ["encrypt"],
                }],
              },
              signal,
              now: this.#now,
              execute: async evidence => verifiedSigner === undefined
                ? await input.operation(domains, signal, evidence)
                : await withInstalledTaskRuntimeTemporarySignerV1({
                    evidence,
                    signal,
                    entry,
                    verified: verifiedSigner,
                    issuerSigningPublicKey:
                      current.committerDeviceSigningPublicKey,
                    operation: () => input.operation(domains, signal, evidence),
                  }),
            });
          } finally {
            authorizationDigest.fill(0);
            if (verifiedSigner !== undefined) {
              destroyVerifiedTaskRuntimeSignerAuthorization(verifiedSigner);
            }
          }
        },
      });
    } finally {
      authorizationBytes.fill(0);
      message.payloadDigest.fill(0);
    }
  }

  /** Source result custody is separate from independently admitted foreground facts. */
  async withOpenedRunResultReadGrant<Value>(input: Readonly<{
    requestId: string;
    workId: string;
    workKind: "task.deliver_result" | "task.delivery_wake";
    recipientGeneration: number;
    recipientKeyId: string;
    claimId: string;
    claimExpiresAt: number;
    authorizationBytes: Uint8Array;
    current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    requesterHumanId: string;
    result: TaskRuntimeRunResultReadProofV1;
    invocation: TaskRuntimeRunResultReadInvocationV1;
    currentNamespaceRequirements: readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
    currentForegroundNamespaceRequirements: readonly TaskRuntimeCurrentNamespaceAuthorityV1[];
    currentAdditionalMutationDestination?: TaskRuntimeWakeMutationDestinationV1;
    certifiedSigning?: TaskRuntimeCertifiedPublicationSigningInputV1;
    signal?: AbortSignal;
    operation(
      partitions: TaskRuntimeRunResultReadPartitionsV1,
      signal: AbortSignal,
      evidence: TaskRuntimeRunResultReadEvidenceV1,
      wakeEvidence?: TaskRuntimeWakeForegroundEvidenceV1 | null,
    ): Value | PromiseLike<Value>;
  }>): Promise<TaskRuntimeRecipientOpenResultV1<Value>> {
    const authorizationBytes = Uint8Array.from(input.authorizationBytes);
    const authorizationExpiresAt = signedAuthorizationDeadline(authorizationBytes);
    if (authorizationExpiresAt === null) {
      authorizationBytes.fill(0);
      return unavailable("invalid");
    }
    const current = copyPublicCurrentAuthority(input.current);
    const combined = Object.freeze(input.currentNamespaceRequirements.map(n =>
      Object.freeze({ ...n, operations: Object.freeze([...n.operations]) })));
    const foreground = Object.freeze(input.currentForegroundNamespaceRequirements.map(n =>
      Object.freeze({ ...n, operations: Object.freeze([...n.operations]) })));
    const suppliedMutation = input.currentAdditionalMutationDestination;
    const mutation = suppliedMutation === undefined ? undefined : Object.freeze({
      roomId: suppliedMutation.roomId, semanticDigest: suppliedMutation.semanticDigest,
      namespace: Object.freeze({ ...suppliedMutation.namespace,
        operations: Object.freeze([...suppliedMutation.namespace.operations]) }),
    });
    const resultDomain = current.domains.find(d => d.domainId === input.result.namespace.domainId);
    if (resultDomain === undefined) {
      authorizationBytes.fill(0);
      return unavailable("authority_stale");
    }
    const messageWriteNamespace = input.workKind === "task.deliver_result"
      && input.result.contentRevision === 1 ? foreground[0] : undefined;
    const messageWriteDomains = messageWriteNamespace === undefined ? []
      : current.domains.filter(d => d.domainId === messageWriteNamespace.domainId);
    const messageWriteDomain = messageWriteDomains[0];
    // Snapshot before the first await; even internal callers cannot change the
    // selected object, purpose, destination or public Domain facts during open.
    const evidence = snapshotTaskRuntimeRunResultReadEvidenceV1({
      purpose: "task.runtime.run_result_read", workKind: input.workKind,
      requestId: input.requestId, workId: input.workId, claimId: input.claimId,
      claimExpiresAt: input.claimExpiresAt, recipientExpiresAt: input.claimExpiresAt,
      expiresAt: Math.min(input.claimExpiresAt, authorizationExpiresAt), authorizationExpiresAt, recipientGeneration: input.recipientGeneration,
      recipientKeyId: input.recipientKeyId, authorizationDigest: this.crypto.hash(authorizationBytes),
      requesterHumanId: input.requesterHumanId, policyRevision: current.policyRevision,
      episodeId: current.sessionId, sourceRoomId: current.roomId,
      hostAuthorizationRevision: current.hostAuthorizationRevision,
      recipientAuthorizationRevision: current.recipientAuthorizationRevision,
      operations: ["decrypt"], result: input.result, invocation: input.invocation, resultDomain,
      messageWrite: messageWriteNamespace === undefined || messageWriteDomain === undefined
        || input.invocation.kind !== "raw" ? null : {
          taskId: input.result.taskId,
          taskRunId: input.result.taskRunId,
          bindingId: input.invocation.bindingId,
          messageOperationId: input.invocation.operationId,
          roomId: input.invocation.roomId,
          sessionId: input.invocation.sessionId,
          signerAgentId: input.result.signerAgentId,
          namespace: {
            namespaceId: messageWriteNamespace.namespaceId,
            domainId: messageWriteNamespace.domainId,
            operations: ["encrypt"],
            expectedAccessRevision: messageWriteNamespace.expectedAccessRevision,
            expectedPolicyRevision: messageWriteNamespace.expectedPolicyRevision,
          },
          domain: messageWriteDomain,
        },
    });
    const foregroundDomains = new Set(foreground.map(n => n.domainId));
    const expectedForegroundOperations = input.workKind === "task.deliver_result"
      ? ["encrypt"] : ["decrypt", "encrypt"];
    const sourceNamespace = evidence.result.namespace;
    const expectedNamespaceIds = new Set([sourceNamespace.namespaceId, ...foreground.map(n => n.namespaceId),
      ...(mutation === undefined ? [] : [mutation.namespace.namespaceId])]);
    const combinedMatches = (): boolean => combined.length === expectedNamespaceIds.size
      && new Set(combined.map(n => n.namespaceId)).size === combined.length
      && combined.every(n => {
        const roles = [
          ...(n.namespaceId === sourceNamespace.namespaceId ? [sourceNamespace] : []),
          ...foreground.filter(f => f.namespaceId === n.namespaceId),
          ...(mutation?.namespace.namespaceId === n.namespaceId ? [mutation.namespace] : []),
        ];
        const operations = ["decrypt", "encrypt"].filter(op => roles.some(role =>
          (role.operations as readonly string[]).includes(op)));
        return roles.length > 0 && roles.every(role => role.domainId === n.domainId
          && role.expectedAccessRevision === n.expectedAccessRevision
          && role.expectedPolicyRevision === n.expectedPolicyRevision)
          && operations.length === n.operations.length
          && operations.every((op, i) => op === n.operations[i]);
      });
    const authorityIsCurrent = (): boolean => current.subjectHumanId === evidence.requesterHumanId
      && current.recipientKind === "runtime"
      && current.recipientPrincipalId === "nautilo_task_runtime"
      && combinedMatches()
      && (mutation === undefined || input.workKind === "task.delivery_wake"
        && /^[0-9a-f]{64}$/u.test(mutation.semanticDigest)
        && mutation.roomId.length > 0
        && mutation.namespace.namespaceId !== sourceNamespace.namespaceId
        && !foreground.some(n => n.namespaceId === mutation.namespace.namespaceId)
        && mutation.namespace.operations.length === 1 && mutation.namespace.operations[0] === "encrypt"
        && mutation.namespace.expectedPolicyRevision === current.policyRevision
        && Number.isSafeInteger(mutation.namespace.ordinal) && mutation.namespace.ordinal >= 0
        && Number.isSafeInteger(mutation.namespace.expectedAccessRevision) && mutation.namespace.expectedAccessRevision >= 0
        && current.domains.some(d => d.domainId === mutation.namespace.domainId))
      && foreground.length > 0
      && (input.workKind !== "task.deliver_result" || foreground.length === 1)
      && (input.workKind !== "task.deliver_result" || input.result.contentRevision !== 1
        || messageWriteDomains.length === 1)
      && new Set(foreground.map(n => n.namespaceId)).size === foreground.length
      && foreground.every(n => Number.isSafeInteger(n.ordinal) && n.ordinal >= 0
        && Number.isSafeInteger(n.expectedAccessRevision) && n.expectedAccessRevision >= 0
        && n.expectedPolicyRevision === current.policyRevision
        && (n.namespaceId !== evidence.result.namespace.namespaceId
          || (n.domainId === evidence.result.namespace.domainId
            && n.expectedAccessRevision === evidence.result.namespace.expectedAccessRevision))
        && n.operations.length === expectedForegroundOperations.length
        && n.operations.every((op, i) => op === expectedForegroundOperations[i])
        && current.domains.some(d => d.domainId === n.domainId))
      && current.domains.every(d => d.domainId === evidence.resultDomain.domainId
        || foregroundDomains.has(d.domainId) || mutation?.namespace.domainId === d.domainId);
    try {
      return await this.#withOpenedAuthorization({
        ...input, authorizationBytes, current, authorizationExpiresAt,
        expectedOperations: ["decrypt", "encrypt"], authorityIsCurrent,
        operation: async (domains, signal, entry, deadline) => {
          const hasTemporarySigner = entry.temporaryRuntime !== null
            && entry.attempt.signer !== undefined;
          if (hasTemporarySigner !== (input.certifiedSigning !== undefined)) {
            throw new TypeError(
              "Task Runtime certified signer custody is not exact",
            );
          }
          const source = domains.find(d => d.domainId === evidence.resultDomain.domainId);
          if (source === undefined) throw new TypeError("Task result read Domain is missing");
          let verifiedSigner: VerifiedCurrentTaskRuntimeSignerAuthorization
            | undefined;
          try {
            if (input.certifiedSigning !== undefined) {
              assertPublicationProofBinding({
                expected: input.certifiedSigning.expectedPublication,
                kind: input.workKind,
                taskId: evidence.result.taskId,
                taskRunId: evidence.result.taskRunId,
                contentRevision: evidence.result.contentRevision,
                ...(evidence.invocation.kind === "wake"
                  ? { selectedId: evidence.invocation.jobId }
                  : {}),
              });
              verifiedSigner = await verifyTemporaryPublicationSignerAuthorization({
                crypto: this.crypto,
                now: this.#now(),
                entry,
                requestId: input.requestId,
                workId: input.workId,
                recipientGeneration: input.recipientGeneration,
                recipientKeyId: input.recipientKeyId,
                authorizationBytes,
                current,
                currentNamespaceRequirements: combined,
                certifiedSigning: input.certifiedSigning,
              });
            }
            return await withTaskRuntimeRunResultReadEvidenceV1({
              evidence: { ...evidence, recipientExpiresAt: entry.attempt.expiresAt, expiresAt: deadline },
              signal, now: this.#now,
              execute: async proof => {
                const partitions = Object.freeze({
                  resultDomains: Object.freeze([source] as const),
                  foregroundDomains: Object.freeze(domains.filter(d => foregroundDomains.has(d.domainId))),
                  foregroundNamespaceRequirements: foreground,
                  ...(mutation === undefined ? {} : { additionalMutationDomains: Object.freeze(
                    domains.filter(d => d.domainId === mutation.namespace.domainId)) }),
                });
                if (proof.workKind !== "task.delivery_wake") {
                  return verifiedSigner === undefined
                    ? await input.operation(partitions, signal, proof, null)
                    : await withInstalledTaskRuntimeTemporarySignerV1({
                        evidence: proof,
                        signal,
                        entry,
                        verified: verifiedSigner,
                        issuerSigningPublicKey:
                          current.committerDeviceSigningPublicKey,
                        operation: () => input.operation(
                          partitions, signal, proof, null,
                        ),
                      });
                }
                return await withTaskRuntimeWakeForegroundEvidenceV1({
                  readEvidence: proof,
                  committerDeviceId: current.committerDeviceId,
                  committerDeviceSigningGeneration:
                    current.committerDeviceSigningGeneration,
                  committerDeviceSigningPublicKeyHash: this.crypto.hash(
                    current.committerDeviceSigningPublicKey,
                  ),
                  namespaceRequirements: foreground,
                  domainRequirements: current.domains.filter(d =>
                    foregroundDomains.has(d.domainId)
                    || mutation?.namespace.domainId === d.domainId),
                  ...(mutation === undefined
                    ? {}
                    : { additionalMutationDestination: mutation }),
                  execute: async wake => verifiedSigner === undefined
                    ? await input.operation(partitions, signal, proof, wake)
                    : await withInstalledTaskRuntimeTemporarySignerV1({
                        evidence: wake,
                        signal,
                        entry,
                        verified: verifiedSigner,
                        issuerSigningPublicKey:
                          current.committerDeviceSigningPublicKey,
                        operation: () => input.operation(
                          partitions, signal, proof, wake,
                        ),
                      }),
                });
              },
            });
          } finally {
            if (verifiedSigner !== undefined) {
              destroyVerifiedTaskRuntimeSignerAuthorization(verifiedSigner);
            }
          }
        },
      });
    } finally { authorizationBytes.fill(0); }
  }

  async #withOpenedAuthorization<Value>(input: Readonly<{
    requestId: string;
    workId: string;
    recipientGeneration: number;
    recipientKeyId: string;
    claimId: string;
    claimExpiresAt: number;
    authorizationBytes: Uint8Array;
    current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
    signal?: AbortSignal;
    authorizationExpiresAt?: number;
    expectedOperations: readonly ["encrypt"] | readonly ["decrypt", "encrypt"];
    authorityIsCurrent(): boolean;
    operation(
      domains: readonly DomainForegroundSecretEntryV2[],
      signal: AbortSignal,
      entry: RecipientEntry,
      deadline: number,
    ): Value | PromiseLike<Value>;
  }>): Promise<TaskRuntimeRecipientOpenResultV1<Value>> {
    assertPortableId("Task Runtime recipient request id", input.requestId);
    assertPortableId("Task Runtime recipient work id", input.workId);
    assertPortableId("Task Runtime recipient key id", input.recipientKeyId);
    assertPortableId("Task Runtime recipient claim id", input.claimId);
    assertU64Counter(
      "Task Runtime recipient generation",
      input.recipientGeneration,
    );
    assertU64Counter("Task Runtime claim expiry", input.claimExpiresAt);
    if (this.#closed) return unavailable("registry_closed");
    const key = attemptKey(input.requestId, input.recipientGeneration);
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.attempt.workId !== input.workId) {
      return unavailable("recipient_unavailable");
    }
    if (entry.attempt.recipientKeyId !== input.recipientKeyId
      || input.current.authorizationId !== input.requestId
      || input.current.recipientRuntimeGeneration !== input.recipientGeneration
      || input.current.recipientKeyId !== input.recipientKeyId) {
      return unavailable("recipient_key_mismatch");
    }
    if (!input.authorityIsCurrent()) return unavailable("authority_stale");
    const now = this.#now();
    const deadline = Math.min(entry.attempt.expiresAt, input.claimExpiresAt,
      input.authorizationExpiresAt ?? Number.POSITIVE_INFINITY);
    if (deadline <= now) {
      this.#remove(key, entry, true);
      return unavailable("recipient_expired");
    }
    if (entry.state === "running") return unavailable("recipient_in_use");
    if (input.signal?.aborted) throw abortError(input.signal);

    entry.state = "running";
    const controller = new AbortController();
    entry.controller = controller;
    const forwardAbort = () => {
      controller.abort(abortError(input.signal!));
      this.#remove(key, entry, true);
    };
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();
    const deadlineHandle = this.#scheduler.scheduleAt(deadline, () => {
      controller.abort(new Error("Task Runtime authorization expired"));
      this.#remove(key, entry, true);
    });
    try {
      return await withOpenedDomainForegroundAuthorizationV2(this.crypto, {
        authorizationBytes: input.authorizationBytes,
        now,
        current: {
          ...input.current,
          recipientEncryptionPrivateKey: entry.privateKey,
        },
        expectedOperations: input.expectedOperations,
        operation: async (domains) => {
          controller.signal.throwIfAborted();
          const value = await input.operation(
            domains,
            controller.signal,
            entry,
            deadline,
          );
          controller.signal.throwIfAborted();
          return value;
        },
      });
    } finally {
      deadlineHandle.cancel();
      input.signal?.removeEventListener("abort", forwardAbort);
      this.#remove(key, entry, false);
    }
  }

  delete(requestId: string, recipientGeneration: number): boolean {
    const key = attemptKey(requestId, recipientGeneration);
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#remove(key, entry, true);
    return true;
  }

  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.attempt.expiresAt <= now) {
        this.#remove(key, entry, true);
        removed += 1;
      }
    }
    return removed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [key, entry] of this.#entries) this.#remove(key, entry, true);
  }

  #remove(key: string, entry: RecipientEntry, abort: boolean): void {
    if (abort) {
      entry.controller?.abort(
        new Error("Task Runtime recipient was removed"),
      );
    }
    entry.privateKey.fill(0);
    entry.attempt.recipientPublicKey.fill(0);
    entry.temporaryRuntime?.key.fill(0);
    entry.attempt.signer?.signerPublicKey.fill(0);
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    if (this.#workIds.get(entry.attempt.workId) === entry) {
      this.#workIds.delete(entry.attempt.workId);
    }
  }
}
