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
  type TaskRuntimeExecutionEvidenceInputV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "./task-runtime-execution-evidence-v1.ts";

type TaskRuntimeCurrentNamespaceAuthorityV1 = Readonly<{
  readonly ordinal: number;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly operations: readonly ("decrypt" | "encrypt")[];
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
}>;

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
    if (
      entry.attempt.recipientKeyId !== input.recipientKeyId
      || input.current.authorizationId !== input.requestId
      || input.current.recipientRuntimeGeneration !== input.recipientGeneration
      || input.current.recipientKeyId !== input.recipientKeyId
    ) return unavailable("recipient_key_mismatch");
    if (!resultAuthorityIsCurrent({
      workId: input.workId,
      result: input.result,
      namespaces: input.currentNamespaceRequirements,
      current: input.current,
    })) return unavailable("authority_stale");
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
        operation: async (domains) => {
          controller.signal.throwIfAborted();
          const authorizationDigest = this.crypto.hash(input.authorizationBytes);
          const value = await withTaskRuntimeExecutionEvidenceV1({
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
            },
            signal: controller.signal,
            now: this.#now,
            execute: (evidence) => input.operation(
              domains,
              controller.signal,
              evidence,
            ),
          }).finally(() => authorizationDigest.fill(0));
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
