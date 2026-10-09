import { bytesToHex } from "@noble/hashes/utils.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
  withOpenedDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  type DomainForegroundSecretEntryV2,
  type OpenDomainForegroundAuthorizationResultV2,
} from "../format/domain-foreground-authorization-v2.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import {
  PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1,
} from "./one-run-processor-transform-v1.ts";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionDomainAuthorityV1,
  type TaskRuntimeExecutionEvidenceInputV1,
  type TaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionNamespaceAuthorityV1,
} from "./task-runtime-execution-evidence-v1.ts";

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
  state: "ready" | "running";
  controller: AbortController | null;
};

function attemptKey(requestId: string, generation: number): string {
  return JSON.stringify([requestId, generation]);
}

function publicAttempt(entry: RecipientEntry): TaskRuntimeRecipientAttemptV1 {
  return Object.freeze({
    ...entry.attempt,
    recipientPublicKey: entry.attempt.recipientPublicKey.slice(),
  });
}

function copyPublicCurrentAuthority(
  value: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): DomainForegroundAuthorizationPublicCurrentAuthorityV2 {
  return Object.freeze({
    ...value,
    committerDeviceSigningPublicKey:
      value.committerDeviceSigningPublicKey.slice(),
    domains: Object.freeze(value.domains.map((domain) => Object.freeze({
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest:
        domain.activeNamespaceBindingSetDigest.slice(),
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
    let stored = false;
    try {
      if (
        pair.privateKey.length !== V2_LIMITS.hpkePrivateKeyBytes
        || pair.publicKey.length !== V2_LIMITS.hpkePublicKeyBytes
      ) throw new TypeError("Task Runtime recipient keypair is malformed");
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
          ...input,
          recipientPublicKey: pair.publicKey.slice(),
        }),
        privateKey: pair.privateKey,
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
        const authorizationDigest = this.crypto.hash(input.authorizationBytes);
        try {
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
            execute: (evidence) => input.operation(domains, signal, evidence),
          });
        } finally {
          authorizationDigest.fill(0);
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
          const domainRequirement = current.domains[0];
          const namespaceRequirement = currentNamespaceRequirements[0];
          if (domainRequirement === undefined || namespaceRequirement === undefined) {
            throw new TypeError("Task Runtime cancellation authority is incomplete");
          }
          const authorizationDigest = this.crypto.hash(authorizationBytes);
          try {
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
              execute: (evidence) => input.operation(domains, signal, evidence),
            });
          } finally {
            authorizationDigest.fill(0);
          }
        },
      });
    } finally {
      authorizationBytes.fill(0);
    }
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
    const deadline = Math.min(entry.attempt.expiresAt, input.claimExpiresAt);
    if (deadline <= now) {
      this.#remove(key, entry, true);
      return unavailable("recipient_expired");
    }
    if (entry.state === "running") return unavailable("recipient_in_use");
    if (input.signal?.aborted) throw abortError(input.signal);

    entry.state = "running";
    const controller = new AbortController();
    entry.controller = controller;
    const forwardAbort = () => controller.abort(abortError(input.signal!));
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    const deadlineHandle = this.#scheduler.scheduleAt(deadline, () => {
      controller.abort(new Error("Task Runtime authorization expired"));
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
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    if (this.#workIds.get(entry.attempt.workId) === entry) {
      this.#workIds.delete(entry.attempt.workId);
    }
  }
}
