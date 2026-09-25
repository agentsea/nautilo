import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  DomainForegroundAuthorityEntryV2,
} from "../format/domain-foreground-authorization-v2.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

declare const taskRuntimeExecutionEvidenceBrand: unique symbol;

const DIGEST_BYTES = 32;

export type TaskRuntimeExecutionDomainAuthorityV1 = Readonly<{
  readonly domainId: string;
  readonly sourceNamespaceId: string;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: "ai";
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: number;
  readonly headDigest: Uint8Array;
  readonly activeNamespaceBindingSetDigest: Uint8Array;
  readonly activeNamespaceBindingCount: number;
}>;

export type TaskRuntimeExecutionEvidenceV1 = Readonly<{
  readonly purpose: "task.runtime.execution";
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
  readonly operations: readonly ["decrypt", "encrypt"];
  readonly result: Readonly<{
    readonly taskId: string;
    readonly taskRunId: string;
    readonly contentRevision: 1;
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
  readonly domainRequirements:
    readonly TaskRuntimeExecutionDomainAuthorityV1[];
  readonly [taskRuntimeExecutionEvidenceBrand]: true;
}>;

export type TaskRuntimeExecutionEvidenceInputV1 = Readonly<{
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
  readonly result: TaskRuntimeExecutionEvidenceV1["result"];
  readonly domainRequirements: readonly DomainForegroundAuthorityEntryV2[];
}>;

type EvidenceState = {
  active: boolean;
  readonly snapshot: TaskRuntimeExecutionEvidenceV1;
  readonly signal: AbortSignal;
  readonly now: () => number;
};

const evidenceSnapshots = new WeakMap<object, EvidenceState>();

function counter(label: string, value: number): number {
  assertU64Counter(label, value);
  return value;
}

function portable(label: string, value: string): string {
  assertPortableId(label, value);
  return value;
}

function digest(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== DIGEST_BYTES) {
    throw new RangeError(`${label} must be exactly ${DIGEST_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function domainRequirement(
  value: DomainForegroundAuthorityEntryV2 | TaskRuntimeExecutionDomainAuthorityV1,
): TaskRuntimeExecutionDomainAuthorityV1 {
  if (value.keyClass !== "ai") {
    throw new TypeError("Task Runtime Domain key class must be ai");
  }
  return Object.freeze({
    domainId: portable("Task Runtime Domain ID", value.domainId),
    sourceNamespaceId: portable(
      "Task Runtime source Namespace ID",
      value.sourceNamespaceId,
    ),
    participantDigest: digest(
      "Task Runtime participant digest",
      value.participantDigest,
    ),
    participantCount: counter(
      "Task Runtime participant count",
      value.participantCount,
    ),
    keyClass: "ai",
    domainKeyGeneration: counter(
      "Task Runtime Domain key generation",
      value.domainKeyGeneration,
    ),
    authorizationRevision: counter(
      "Task Runtime Domain authorization revision",
      value.authorizationRevision,
    ),
    headDigest: digest("Task Runtime Domain head digest", value.headDigest),
    activeNamespaceBindingSetDigest: digest(
      "Task Runtime active Namespace binding-set digest",
      value.activeNamespaceBindingSetDigest,
    ),
    activeNamespaceBindingCount: counter(
      "Task Runtime active Namespace binding count",
      value.activeNamespaceBindingCount,
    ),
  });
}

function cloneEvidence(
  value: TaskRuntimeExecutionEvidenceInputV1 | TaskRuntimeExecutionEvidenceV1,
): TaskRuntimeExecutionEvidenceV1 {
  const domainRequirements = value.domainRequirements.map(domainRequirement);
  if (domainRequirements.length < 1) {
    throw new RangeError("Task Runtime execution requires a Domain authority");
  }
  const expiresAt = counter("Task Runtime execution expiry", value.expiresAt);
  const claimExpiresAt = counter(
    "Task Runtime claim expiry",
    value.claimExpiresAt,
  );
  const recipientExpiresAt = counter(
    "Task Runtime recipient expiry",
    value.recipientExpiresAt,
  );
  if (expiresAt !== Math.min(claimExpiresAt, recipientExpiresAt)) {
    throw new TypeError("Task Runtime execution expiry is not exact");
  }
  if (
    value.result.contentRevision !== 1
    || value.result.taskRunId !== value.workId
    || value.result.namespace.operations.length !== 1
    || value.result.namespace.operations[0] !== "encrypt"
  ) throw new TypeError("Task Runtime result binding is invalid");
  const result = Object.freeze({
    taskId: portable("Task Runtime result Task ID", value.result.taskId),
    taskRunId: portable(
      "Task Runtime result Task Run ID",
      value.result.taskRunId,
    ),
    contentRevision: 1 as const,
    objectId: portable(
      "Task Runtime result object ID",
      value.result.objectId,
    ),
    signerAgentId: portable(
      "Task Runtime result signer Agent ID",
      value.result.signerAgentId,
    ),
    namespace: Object.freeze({
      namespaceId: portable(
        "Task Runtime result Namespace ID",
        value.result.namespace.namespaceId,
      ),
      domainId: portable(
        "Task Runtime result Domain ID",
        value.result.namespace.domainId,
      ),
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: counter(
        "Task Runtime result access revision",
        value.result.namespace.expectedAccessRevision,
      ),
      expectedPolicyRevision: counter(
        "Task Runtime result policy revision",
        value.result.namespace.expectedPolicyRevision,
      ),
    }),
  });
  return Object.freeze({
    purpose: "task.runtime.execution",
    requestId: portable("Task Runtime request ID", value.requestId),
    workId: portable("Task Runtime work ID", value.workId),
    claimId: portable("Task Runtime claim ID", value.claimId),
    claimExpiresAt,
    recipientExpiresAt,
    expiresAt,
    recipientGeneration: counter(
      "Task Runtime recipient generation",
      value.recipientGeneration,
    ),
    recipientKeyId: portable(
      "Task Runtime recipient key ID",
      value.recipientKeyId,
    ),
    authorizationDigest: digest(
      "Task Runtime authorization digest",
      value.authorizationDigest,
    ),
    policyRevision: counter(
      "Task Runtime policy revision",
      value.policyRevision,
    ),
    episodeId: portable("Task Runtime episode ID", value.episodeId),
    sourceRoomId: portable("Task Runtime source Room ID", value.sourceRoomId),
    hostAuthorizationRevision: counter(
      "Task Runtime host authorization revision",
      value.hostAuthorizationRevision,
    ),
    recipientAuthorizationRevision: counter(
      "Task Runtime recipient authorization revision",
      value.recipientAuthorizationRevision,
    ),
    operations: Object.freeze(["decrypt", "encrypt"]),
    result,
    domainRequirements: Object.freeze(domainRequirements),
  }) as TaskRuntimeExecutionEvidenceV1;
}

function fingerprint(value: TaskRuntimeExecutionEvidenceV1): string {
  return JSON.stringify({
    ...value,
    authorizationDigest: bytesToHex(value.authorizationDigest),
    domainRequirements: value.domainRequirements.map((entry) => ({
      ...entry,
      participantDigest: bytesToHex(entry.participantDigest),
      headDigest: bytesToHex(entry.headDigest),
      activeNamespaceBindingSetDigest:
        bytesToHex(entry.activeNamespaceBindingSetDigest),
    })),
  });
}

export function assertAuthenticTaskRuntimeExecutionEvidenceV1(
  evidence: TaskRuntimeExecutionEvidenceV1,
): void {
  const state = evidenceSnapshots.get(evidence as object);
  const currentTime = state?.now();
  const expired = currentTime === undefined
    || !Number.isSafeInteger(currentTime)
    || currentTime >= evidence.expiresAt;
  if (
    state === undefined
    || !state.active
    || state.signal.aborted
    || expired
    || fingerprint(state.snapshot) !== fingerprint(evidence)
  ) {
    if (state !== undefined) state.active = false;
    throw new TypeError("Task Runtime execution evidence is not active");
  }
}

/** @internal Mint only after the registry has opened an authenticated grant. */
export async function withTaskRuntimeExecutionEvidenceV1<Value>(input: Readonly<{
  readonly evidence: TaskRuntimeExecutionEvidenceInputV1;
  readonly signal: AbortSignal;
  readonly now: () => number;
  execute(
    evidence: TaskRuntimeExecutionEvidenceV1,
  ): Value | PromiseLike<Value>;
}>): Promise<Value> {
  if (typeof input.execute !== "function") {
    throw new TypeError("Task Runtime execution evidence callback is required");
  }
  if (!(input.signal instanceof AbortSignal) || typeof input.now !== "function") {
    throw new TypeError("Task Runtime execution liveness is required");
  }
  const evidence = cloneEvidence(input.evidence);
  const snapshot = cloneEvidence(evidence);
  const state: EvidenceState = {
    active: true,
    snapshot,
    signal: input.signal,
    now: input.now,
  };
  evidenceSnapshots.set(evidence, state);
  try {
    assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
    return await input.execute(evidence);
  } finally {
    state.active = false;
    evidenceSnapshots.delete(evidence);
  }
}
