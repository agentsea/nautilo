import {executeReflectionAuthorityInternalV2, type ReflectionAuthorityRunInputV2, type ReflectionSemanticRunInputV2} from "./reflection-authority-reprojection-v2.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  createProcessorObjectAccessManifestV4,
} from "../format/object-access-manifest-v4.ts";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  serializeNamespaceKeyringEnvelope,
} from "../format/namespace-keyring-v2.ts";
import {
  openNamespaceKeyring,
} from "../namespace/keyrings.ts";
import type {
  HistoricalCommitterResolverV2,
} from "../namespace/authorization.ts";
import type {
  NamespaceKeyringEnvelopeV2,
  NamespaceKeyringPlaintextV2,
} from "../namespace/types.ts";
import {
  decryptObjectThroughNamespaceV2,
  wrapObjectDekForNamespaceV2,
  type NamespaceObjectEnvelopeV2,
} from "../object/namespace-envelope.ts";
import {
  encryptObjectPayloadV2,
  type EncryptedPayloadV2,
} from "../object/payload.ts";
import {
  accessRevision,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  objectId as canonicalObjectId,
  unixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import {
  openProcessorCredentialV1,
  type OpenedProcessorCredentialV1,
  type ResolveCurrentProcessorCredentialIssuerPublicKeyV1,
} from "./processor-credential-v1.ts";
import {
  decodeProcessorSignerAuthorizationV1,
  verifyCurrentProcessorSignerAuthorizationForCredentialV1,
  type ProcessorSignerAuthorizationV1,
  type ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1,
} from "./processor-signer-authorization-v1.ts";
import type {
  BackgroundWorkDescriptorV1,
} from "./work-descriptor-v1.ts";
import {
  executeOneRunProcessorTransformInternalV2,
  type ProcessorOutputRepairRunInputV2,
  type ProcessorTransformRunInputV2,
  type ProcessorReconciliationRunInputV2,
} from "./one-run-processor-transform-v2.ts";

declare const processorTransformCapabilityBrand: unique symbol;
const OBJECT_AEAD_OVERHEAD_BYTES = 40;
export type ProcessorTransformInputV1 = Readonly<{
  readonly objectId: string;
  /**
   * Owned, short-lived plaintext. The gate zeroes this exact buffer when the
   * worker callback exits; callers must not expect it to survive the run.
   */
  readonly plaintext: Uint8Array;
}>;

export type ProcessorTransformOutputV1 = Readonly<{
  readonly objectId: string;
  readonly plaintext: Uint8Array;
}>;

export type ProcessorTransformCapabilityV1 = Readonly<{
  readonly openInputs: () => Promise<readonly ProcessorTransformInputV1[]>;
  readonly publishOutputs: (
    outputs: readonly ProcessorTransformOutputV1[],
  ) => Promise<void>;
  /** Current-only: one callback borrows freshly reopened, verified committed outputs. */
  readonly withPublishedOutputs?: <Value>(
    use: (outputs: readonly ProcessorTransformInputV1[]) => Value | Promise<Value>,
  ) => Promise<Value>;
  readonly [processorTransformCapabilityBrand]: true;
}>;

export type ProcessorCredentialClaimV1 = Readonly<{
  readonly credentialId: string;
  readonly credentialHash: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly requestId: string;
  readonly claimId: string;
  readonly recipientGeneration: number;
  readonly idempotencyId: string;
  readonly claimedAt: number;
  readonly signal: AbortSignal;
}>;

export type ProcessorCredentialClaimPortV1 = Readonly<{
  /**
   * Atomically insert the exact credential hash. Implementations must return
   * `already_claimed` when that hash was inserted by any concurrent process,
   * and must recheck `signal` inside the transaction immediately before its
   * commit.
   */
  readonly claimExactCredential: (
    claim: ProcessorCredentialClaimV1,
  ) => Promise<"claimed" | "already_claimed">;
}>;

export type ProcessorTransformObjectPortV1 = Readonly<{
  readonly loadNamespaceKeyring: (input: Readonly<{
    readonly namespaceId: string;
    readonly signal: AbortSignal;
  }>) => Promise<Readonly<{
    readonly envelope: NamespaceKeyringEnvelopeV2;
  }>>;
  /**
   * Returns canonical encrypted object material only. The closed gate opens
   * the Namespace keyring and performs DEK unwrap and payload decryption.
   */
  readonly openInput: (input: Readonly<{
    readonly objectId: string;
    readonly signal: AbortSignal;
  }>) => Promise<Readonly<{
    readonly payload: EncryptedPayloadV2;
    readonly envelope: NamespaceObjectEnvelopeV2;
  }>>;
  /**
   * One atomic, idempotent publication boundary. `outputs` is the actual
   * ordered canonical prefix selected from the descriptor's authorized output
   * slots, and may be empty. Implementations must commit either that complete
   * prefix or nothing, keyed by `idempotencyId`, and a replay of the same
   * prefix must be a no-op success. Bytes are borrowed for this call and must
   * be copied before the Promise settles when persisted.
   * The adapter must recheck both `signal` and current authorization inside
   * the same transaction immediately before its commit; `authorityCheckedAt`
   * is an audit fact, not permission to skip `authorizeCommit`. The callback
   * is one-shot and must be awaited at the durable commit boundary.
   */
  readonly publishOutputs: (input: Readonly<{
    readonly idempotencyId: string;
    readonly claimId: string;
    readonly authorityCheckedAt: number;
    readonly authorizeCommit: () => Promise<number>;
    readonly outputs: readonly Readonly<{
      readonly objectId: string;
      readonly payloadBytes: Uint8Array;
      readonly envelopeBytes: Uint8Array;
      readonly manifestBytes: Uint8Array;
      /**
       * Pre-signed revision-1 access tombstone. It retains the immutable
       * payload and signer evidence while removing every Namespace envelope.
       * Storage persists it append-only beside the genesis manifest; a
       * separate cleanup port may later advance the access head to it.
       */
      readonly tombstoneManifestBytes: Uint8Array;
      readonly signerAuthorizationBytes: Uint8Array;
    }>[];
    readonly signal: AbortSignal;
  }>) => Promise<void>;
}>;

export type OneRunProcessorTransformResultV1 =
  | Readonly<{
    readonly status: "executed";
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: "credential_replayed";
  }>;

export interface ProcessorTransformRecipientAttemptV1 {
  readonly requestId: string;
  readonly workId: string;
  readonly namespaceId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly expiresAt: number;
}

export interface ProcessorTransformDeadlineHandleV1 {
  readonly cancel: () => void;
}

export interface ProcessorTransformDeadlineSchedulerV1 {
  readonly scheduleAt: (
    deadline: number,
    expire: () => void,
  ) => ProcessorTransformDeadlineHandleV1;
}

export type ProcessorTransformRecipientCreationResultV1 =
  | Readonly<{
    readonly status: "created";
    readonly attempt: ProcessorTransformRecipientAttemptV1;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "duplicate_attempt"
      | "duplicate_work"
      | "namespace_capacity"
      | "process_capacity"
      | "registry_closed";
  }>;

export type ProcessorTransformRegistryRunResultV1 =
  | OneRunProcessorTransformResultV1
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "recipient_expired"
      | "recipient_in_use"
      | "recipient_key_mismatch"
      | "recipient_unavailable"
      | "registry_closed";
  }>;

export interface ProcessorTransformRunInputV1 {
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly claimId: string;
  readonly credentialBytes: Uint8Array;
  readonly resolveCurrentIssuerPublicKey:
    ResolveCurrentProcessorCredentialIssuerPublicKeyV1;
  readonly signerAuthorizationBytes: Uint8Array;
  readonly resolveHistoricalNamespaceCommitter:
    HistoricalCommitterResolverV2;
  readonly resolveCurrentSignerIssuingDevicePublicKey:
    ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
  readonly claims: ProcessorCredentialClaimPortV1;
  readonly objects: ProcessorTransformObjectPortV1;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Absolute caller-owned lease deadline, also bounded by recipient expiry. */
  readonly deadlineAt?: number;
  readonly execute: (
    capability: ProcessorTransformCapabilityV1,
    signal: AbortSignal,
  ) => void | PromiseLike<void>;
}

type RecipientEntry = {
  readonly attempt: ProcessorTransformRecipientAttemptV1;
  readonly privateKey: Uint8Array;
  status: "ready" | "running";
  controller: AbortController | null;
};

export const PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1 = 256;
export const PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE_V1 = 32;
export const PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1 = 10 * 60 * 1_000;

function attemptKey(requestId: string, generation: number): string {
  return JSON.stringify([requestId, generation]);
}

function workKey(namespaceId: string, workId: string): string {
  return JSON.stringify([namespaceId, workId]);
}

function publicAttempt(
  entry: RecipientEntry,
): ProcessorTransformRecipientAttemptV1 {
  return Object.freeze({
    ...entry.attempt,
    recipientPublicKey: entry.attempt.recipientPublicKey.slice(),
  });
}

export class ProcessorTransformRecipientRegistryV1 {
  readonly #crypto: LatticeCrypto;
  readonly #now: () => number;
  readonly #scheduler: ProcessorTransformDeadlineSchedulerV1;
  readonly #maxLive: number;
  readonly #maxPerNamespace: number;
  readonly #entries = new Map<string, RecipientEntry>();
  readonly #works = new Map<string, RecipientEntry>();
  #closed = false;

  constructor(input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly now?: () => number;
    readonly scheduler?: ProcessorTransformDeadlineSchedulerV1;
    readonly maxLive?: number;
    readonly maxPerNamespace?: number;
  }>) {
    this.#crypto = input.crypto;
    this.#now = input.now ?? Date.now;
    this.#scheduler = input.scheduler ?? {
      scheduleAt: (deadline, expire) => {
        const timer = setTimeout(
          expire,
          Math.max(0, deadline - this.#now()),
        );
        return Object.freeze({ cancel: () => clearTimeout(timer) });
      },
    };
    this.#maxLive = input.maxLive
      ?? PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1;
    this.#maxPerNamespace = input.maxPerNamespace
      ?? Math.min(
        PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE_V1,
        this.#maxLive,
      );
    if (
      !Number.isSafeInteger(this.#maxLive)
      || this.#maxLive < 1
      || this.#maxLive > PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1
      || !Number.isSafeInteger(this.#maxPerNamespace)
      || this.#maxPerNamespace < 1
      || this.#maxPerNamespace
        > PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE_V1
      || this.#maxPerNamespace > this.#maxLive
    ) {
      throw new TypeError("Processor transform recipient bounds are invalid");
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  hasAttempt(input: Readonly<{
    readonly requestId: string;
    readonly recipientGeneration: number;
    readonly recipientKeyId: string;
  }>): boolean {
    assertPortableId("Processor recipient request id", input.requestId);
    assertU64Counter(
      "Processor recipient generation",
      input.recipientGeneration,
    );
    assertPortableId("Processor recipient key id", input.recipientKeyId);
    if (this.#closed) return false;
    const key = attemptKey(input.requestId, input.recipientGeneration);
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    if (entry.attempt.expiresAt <= this.#now()) {
      this.#remove(key, entry, true);
      return false;
    }
    return entry.attempt.recipientKeyId === input.recipientKeyId;
  }

  async createAttempt(input: Readonly<{
    readonly requestId: string;
    readonly workId: string;
    readonly namespaceId: string;
    readonly recipientGeneration: number;
    readonly recipientKeyId: string;
    readonly expiresAt: number;
  }>): Promise<ProcessorTransformRecipientCreationResultV1> {
    if (this.#closed) {
      return Object.freeze({
        status: "unavailable",
        reason: "registry_closed",
      });
    }
    assertPortableId("Processor recipient request id", input.requestId);
    assertPortableId("Processor recipient work id", input.workId);
    assertPortableId("Processor recipient Namespace id", input.namespaceId);
    assertPortableId("Processor recipient key id", input.recipientKeyId);
    assertU64Counter(
      "Processor recipient generation",
      input.recipientGeneration,
    );
    assertU64Counter("Processor recipient expiry", input.expiresAt);
    const now = this.#now();
    if (
      input.expiresAt <= now
      || input.expiresAt - now
        > PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1
    ) {
      throw new RangeError("Processor recipient expiry is invalid");
    }
    const exactAttempt = attemptKey(
      input.requestId,
      input.recipientGeneration,
    );
    const exactWork = workKey(input.namespaceId, input.workId);

    const pair = await this.#crypto.generateEncryptionKeyPair();
    let stored = false;
    try {
      if (
        pair.privateKey.length !== V2_LIMITS.hpkePrivateKeyBytes
        || pair.publicKey.length !== V2_LIMITS.hpkePublicKeyBytes
      ) {
        throw new Error("Processor recipient HPKE keypair is malformed");
      }
      // Key generation is asynchronous. All mutable registry checks happen at
      // this synchronous commit boundary so concurrent creators cannot both
      // pass a stale capacity or duplicate check.
      if (this.#closed) {
        return Object.freeze({
          status: "unavailable",
          reason: "registry_closed",
        });
      }
      const commitTime = this.#now();
      if (
        input.expiresAt <= commitTime
        || input.expiresAt - commitTime
          > PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1
      ) {
        throw new RangeError("Processor recipient expiry is invalid");
      }
      this.sweep();
      if (this.#entries.has(exactAttempt)) {
        return Object.freeze({
          status: "unavailable",
          reason: "duplicate_attempt",
        });
      }
      if (this.#works.has(exactWork)) {
        return Object.freeze({
          status: "unavailable",
          reason: "duplicate_work",
        });
      }
      if (this.#entries.size >= this.#maxLive) {
        return Object.freeze({
          status: "unavailable",
          reason: "process_capacity",
        });
      }
      const namespaceCount = [...this.#entries.values()].filter(
        (entry) => entry.attempt.namespaceId === input.namespaceId,
      ).length;
      if (namespaceCount >= this.#maxPerNamespace) {
        return Object.freeze({
          status: "unavailable",
          reason: "namespace_capacity",
        });
      }
      const attempt = Object.freeze({
        requestId: input.requestId,
        workId: input.workId,
        namespaceId: input.namespaceId,
        recipientGeneration: input.recipientGeneration,
        recipientKeyId: input.recipientKeyId,
        recipientPublicKey: pair.publicKey.slice(),
        expiresAt: input.expiresAt,
      });
      const entry: RecipientEntry = {
        attempt,
        privateKey: pair.privateKey,
        status: "ready",
        controller: null,
      };
      this.#entries.set(exactAttempt, entry);
      this.#works.set(exactWork, entry);
      stored = true;
      return Object.freeze({
        status: "created",
        attempt: publicAttempt(entry),
      });
    } finally {
      pair.publicKey.fill(0);
      if (!stored) pair.privateKey.fill(0);
    }
  }

  async run(
    input: ProcessorTransformRunInputV1,
  ): Promise<ProcessorTransformRegistryRunResultV1> {
    if ("semanticObjects" in input || "reflectionObjects" in input) throw new TypeError("Reflection authority requires its named deterministic gate");
    return this.#run(input);
  }

  /** Current Domain-key execution shares the same one-use recipient custody. */
  async runCurrent(
    input: ProcessorTransformRunInputV2,
  ): Promise<ProcessorTransformRegistryRunResultV1> {
    if ("semanticObjects" in input || "reflectionObjects" in input || "binding" in input || "repairBinding" in input) throw new TypeError("Current execution requires its own gate");
    return this.#run(input);
  }

  /** Deterministic Reflection reprojection or exact saved-publication recovery. */
  async runCurrentReflectionAuthority(input: ReflectionAuthorityRunInputV2): Promise<ProcessorTransformRegistryRunResultV1> {
    if ("semanticObjects" in input || "execute" in input || "binding" in input || "repairBinding" in input) throw new TypeError("Reflection authority requires its named deterministic gate");
    return this.#run(input);
  }

  /** Named bounded semantic execution; maintenance authority is never admitted here. */
  async runCurrentReflectionSemantic(input: ReflectionSemanticRunInputV2): Promise<ProcessorTransformRegistryRunResultV1> {
    if ("reflectionObjects" in input || "reconciliationBinding" in input || "binding" in input || "repairBinding" in input) throw new TypeError("Reflection semantics requires its own gate");
    return this.#run(input);
  }

  /** Fresh read-only authority for one committed Stenographer result. */
  async runCurrentReconciliation(input: ProcessorReconciliationRunInputV2): Promise<ProcessorTransformRegistryRunResultV1> {
    if ("semanticObjects" in input || "reflectionObjects" in input || "execute" in input || "repairBinding" in input) throw new TypeError("Reconciliation requires its own gate");
    return this.#run(input);
  }

  /** Protect the exact completed ordinary result, without any model callback. */
  async runCurrentOutputRepair(input: ProcessorOutputRepairRunInputV2): Promise<ProcessorTransformRegistryRunResultV1> {
    if ("semanticObjects" in input || "reflectionObjects" in input || "execute" in input || "binding" in input) throw new TypeError("Output repair requires its own gate");
    return this.#run(input);
  }

  async #run(
    input: ProcessorTransformRunInputV1 | ProcessorTransformRunInputV2 | ProcessorReconciliationRunInputV2 | ProcessorOutputRepairRunInputV2 | ReflectionAuthorityRunInputV2 | ReflectionSemanticRunInputV2,
  ): Promise<ProcessorTransformRegistryRunResultV1> {
    if (this.#closed) return registryUnavailable("registry_closed");
    assertPortableId("Processor transform claim id", input.claimId);
    const key = attemptKey(
      input.requestId,
      input.recipientGeneration,
    );
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return registryUnavailable("recipient_unavailable");
    }
    if (entry.attempt.recipientKeyId !== input.recipientKeyId) {
      return registryUnavailable("recipient_key_mismatch");
    }
    const startedAt = this.#now();
    if (entry.attempt.expiresAt <= startedAt) {
      this.#remove(key, entry, true);
      return registryUnavailable("recipient_expired");
    }
    if (entry.status === "running") {
      return registryUnavailable("recipient_in_use");
    }
    const timeoutMs = input.timeoutMs
      ?? entry.attempt.expiresAt - startedAt;
    if (
      !Number.isSafeInteger(timeoutMs)
      || timeoutMs <= 0
      || timeoutMs > entry.attempt.expiresAt - startedAt
    ) {
      throw new RangeError(
        "Processor transform timeout must fit recipient validity",
      );
    }

    if (input.deadlineAt !== undefined) {
      if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0) {
        throw new RangeError("Processor transform deadline must be a positive timestamp");
      }
      if (input.deadlineAt <= startedAt) {
        this.#remove(key, entry, true);
        throw new Error("Processor transform timed out");
      }
    }
    entry.status = "running";
    const controller = new AbortController();
    entry.controller = controller;
    const wipeRecipientKey = () => entry.privateKey.fill(0);
    controller.signal.addEventListener("abort", wipeRecipientKey, {
      once: true,
    });
    let unlink = () => {};
    let scheduled: ProcessorTransformDeadlineHandleV1 | undefined;
    try {
      unlink = linkAbortSignal(input.signal, controller);
      const deadline = Math.min(
        entry.attempt.expiresAt,
        startedAt + timeoutMs,
        input.deadlineAt ?? entry.attempt.expiresAt,
      );
      scheduled = this.#scheduler.scheduleAt(deadline, () => {
        controller.abort(new Error("Processor transform timed out"));
      });
      const owned = {
        crypto: this.#crypto,
        recipientPrivateKey: entry.privateKey,
        now: this.#now,
        signal: controller.signal,
        expectedAttempt: entry.attempt,
        abort: (reason: Error) => controller.abort(reason),
      };
      return "semanticObjects" in input || "reflectionObjects" in input
        ? await executeReflectionAuthorityInternalV2({...input, ...owned})
        : "responseBytes" in input
        ? await executeOneRunProcessorTransformInternalV2({...input, ...owned})
        : await executeOneRunProcessorTransformInternalV1({...input, ...owned});
    } finally {
      try {
        scheduled?.cancel();
      } finally {
        try {
          unlink();
        } finally {
          controller.signal.removeEventListener(
            "abort",
            wipeRecipientKey,
          );
          this.#remove(key, entry, false);
        }
      }
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
    for (const [key, entry] of this.#entries) {
      this.#remove(key, entry, true);
    }
  }

  #remove(
    key: string,
    entry: RecipientEntry,
    abort: boolean,
  ): void {
    if (abort) {
      entry.controller?.abort(
        new Error("Processor transform recipient was removed"),
      );
    }
    entry.privateKey.fill(0);
    entry.attempt.recipientPublicKey.fill(0);
    if (this.#entries.get(key) === entry) {
      this.#entries.delete(key);
    }
    const exactWork = workKey(
      entry.attempt.namespaceId,
      entry.attempt.workId,
    );
    if (this.#works.get(exactWork) === entry) {
      this.#works.delete(exactWork);
    }
  }
}

function registryUnavailable(
  reason: Extract<
    ProcessorTransformRegistryRunResultV1,
    { readonly status: "unavailable" }
  >["reason"],
): ProcessorTransformRegistryRunResultV1 {
  return Object.freeze({ status: "unavailable", reason });
}

type TransformState = {
  active: boolean;
  inputPhase: "idle" | "opening" | "opened" | "failed";
  outputPhase: "idle" | "publishing" | "published" | "failed";
  plaintextBytes: number;
  ciphertextBytes: number;
  readonly crypto: LatticeCrypto;
  readonly descriptor: BackgroundWorkDescriptorV1;
  readonly claimId: string;
  readonly namespaceKeyring: NamespaceKeyringPlaintextV2;
  readonly signerPrivateKey: Uint8Array;
  readonly signerAuthorizationBytes: Uint8Array;
  readonly resolveCurrentSignerIssuingDevicePublicKey:
    ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
  readonly now: () => number;
  readonly credentialBytes: Uint8Array;
  readonly resolveCurrentIssuerPublicKey:
    ResolveCurrentProcessorCredentialIssuerPublicKeyV1;
  readonly objects: ProcessorTransformObjectPortV1;
  readonly signal: AbortSignal;
  readonly openedPlaintexts: Uint8Array[];
  readonly transferredOutputPlaintexts: Set<Uint8Array>;
  readonly operations: Set<Promise<unknown>>;
  readonly operationErrors: Error[];
  secretsDestroyed: boolean;
};

const capabilityStates = new WeakMap<object, TransformState>();

function copyBytes(label: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be Uint8Array`);
  }
  return value.slice();
}

function wipeBytesDeep(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) {
    wipeBytesDeep(nested, seen);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

async function reverifyCurrentTransformAuthority(
  state: TransformState,
): Promise<number> {
  const checkedAt = state.now();
  let verified:
    Awaited<
      ReturnType<
        typeof verifyCurrentProcessorSignerAuthorizationForCredentialV1
      >
    >
    | undefined;
  try {
    verified = await raceWithAbort(
      verifyCurrentProcessorSignerAuthorizationForCredentialV1(
        state.crypto,
        {
          authorizationBytes: state.signerAuthorizationBytes,
          credentialBytes: state.credentialBytes,
          now: checkedAt,
          resolveCurrentCredentialIssuerPublicKey:
            abortRacedIssuerResolver(
              state.resolveCurrentIssuerPublicKey,
              state.signal,
            ),
          resolveCurrentSignerIssuingDevicePublicKey:
            state.resolveCurrentSignerIssuingDevicePublicKey,
        },
      ),
      state.signal,
    );
    return checkedAt;
  } finally {
    if (verified !== undefined) wipeBytesDeep(verified);
  }
}

function destroyOpenedCredential(opened: OpenedProcessorCredentialV1): void {
  wipeBytesDeep(opened);
}

function destroyTransformSecrets(state: TransformState): void {
  if (state.secretsDestroyed) return;
  state.secretsDestroyed = true;
  state.active = false;
  for (const plaintext of state.openedPlaintexts) plaintext.fill(0);
  for (const plaintext of state.transferredOutputPlaintexts) {
    plaintext.fill(0);
  }
  wipeBytesDeep(state.namespaceKeyring);
  state.signerPrivateKey.fill(0);
}

function activeState(
  capability: ProcessorTransformCapabilityV1,
): TransformState {
  const state = capabilityStates.get(capability);
  if (
    state === undefined
    || !state.active
    || state.signal.aborted
  ) {
    throw new Error("Processor transform capability is unavailable");
  }
  return state;
}

function addBudget(
  state: TransformState,
  plaintextBytes: number,
  ciphertextBytes: number,
): void {
  const nextPlaintext = state.plaintextBytes + plaintextBytes;
  if (nextPlaintext > state.descriptor.maximumPlaintextBytes) {
    throw new RangeError("Processor transform plaintext budget exceeded");
  }
  const nextCiphertext = state.ciphertextBytes + ciphertextBytes;
  if (nextCiphertext > state.descriptor.maximumCiphertextBytes) {
    throw new RangeError("Processor transform ciphertext budget exceeded");
  }
  state.plaintextBytes = nextPlaintext;
  state.ciphertextBytes = nextCiphertext;
}

async function openExactInputs(
  capability: ProcessorTransformCapabilityV1,
): Promise<readonly ProcessorTransformInputV1[]> {
  const state = activeState(capability);
  if (state.inputPhase !== "idle") {
    throw new Error("Processor transform inputs are already opened");
  }
  if (!state.descriptor.operations.includes("decrypt")) {
    throw new Error("Processor transform does not authorize input decryption");
  }
  if (
    state.descriptor.inputObjectIds.length
      > state.descriptor.maximumInputObjectCount
  ) {
    throw new RangeError("Processor transform input object budget exceeded");
  }
  state.inputPhase = "opening";

  const opened: ProcessorTransformInputV1[] = [];
  try {
    for (const objectId of state.descriptor.inputObjectIds) {
      activeState(capability);
      const result = await raceWithAbort(
        state.objects.openInput({
          objectId,
          signal: state.signal,
        }),
        state.signal,
      );
      let transferred: Uint8Array | undefined;
      let payloadBytes: Uint8Array | undefined;
      let envelopeBytes: Uint8Array | undefined;
      try {
        activeState(capability);
        if (
          result.payload.context.objectId !== objectId
          || result.payload.context.keyClass !== "ai"
          || result.envelope.context.objectId !== objectId
          || result.envelope.context.namespaceId
            !== state.descriptor.namespaceId
          || result.envelope.context.keyClass !== "ai"
          || result.envelope.context.bindingRevisionAtWrap
            !== state.descriptor.expectedNamespaceAccessRevision
        ) {
          throw new Error(
            "Processor transform input object does not match its descriptor",
          );
        }
        const generation = state.namespaceKeyring.generations.find(
          (entry) =>
            entry.generation === result.envelope.context.keyGeneration,
        );
        if (generation === undefined) {
          throw new Error(
            "Processor transform input Namespace generation is unavailable",
          );
        }
        payloadBytes = encodeEncryptedPayloadV2(result.payload);
        envelopeBytes = encodeNamespaceObjectEnvelopeV2(result.envelope);
        addBudget(
          state,
          0,
          payloadBytes.length + envelopeBytes.length,
        );
        const authenticatedPlaintextBytes =
          result.payload.ciphertext.length - OBJECT_AEAD_OVERHEAD_BYTES;
        if (
          authenticatedPlaintextBytes < 0
          || authenticatedPlaintextBytes
            > state.descriptor.maximumPlaintextBytes - state.plaintextBytes
        ) {
          throw new RangeError(
            "Processor transform input exceeds remaining plaintext budget",
          );
        }
        transferred = decryptObjectThroughNamespaceV2(
          state.crypto,
          generation.key,
          result.envelope,
          result.payload,
        ) ?? undefined;
        if (transferred === undefined) {
          throw new Error(
            "Processor transform input ciphertext failed to open",
          );
        }
        addBudget(state, transferred.length, 0);
        state.openedPlaintexts.push(transferred);
        opened.push(Object.freeze({ objectId, plaintext: transferred }));
        transferred = undefined;
      } finally {
        payloadBytes?.fill(0);
        envelopeBytes?.fill(0);
        transferred?.fill(0);
      }
    }
    state.inputPhase = "opened";
    return Object.freeze(opened);
  } catch (error) {
    state.inputPhase = "failed";
    throw error;
  }
}

function outputsAreCanonicalSlotPrefix(
  outputs: readonly ProcessorTransformOutputV1[],
  slots: readonly string[],
): boolean {
  if (outputs.length > slots.length) return false;
  return outputs.every(
    (output, index) => output.objectId === slots[index],
  );
}

async function publishExactOutputsOwned(
  capability: ProcessorTransformCapabilityV1,
  outputs: readonly ProcessorTransformOutputV1[],
): Promise<void> {
  const state = activeState(capability);
  if (state.inputPhase !== "opened") {
    throw new Error("Processor transform inputs must be opened first");
  }
  if (state.outputPhase !== "idle") {
    throw new Error("Processor transform outputs are already published");
  }
  if (!state.descriptor.operations.includes("encrypt")) {
    throw new Error("Processor transform does not authorize output encryption");
  }
  if (!Array.isArray(outputs)) {
    throw new TypeError("Processor transform outputs must be an array");
  }
  if (
    outputs.length > state.descriptor.maximumOutputObjectCount
    || !outputsAreCanonicalSlotPrefix(
      outputs,
      state.descriptor.outputObjectIds,
    )
  ) {
    throw new Error(
      "Processor transform outputs must be an ordered prefix of authorized output slots",
    );
  }
  // Re-resolve authority immediately before accepting worker plaintext. The
  // later checks protect publication and its transaction commit separately.
  await reverifyCurrentTransformAuthority(state);
  activeState(capability);
  state.outputPhase = "publishing";
  const checkedOutputs: readonly ProcessorTransformOutputV1[] = outputs;

  const prepared: Array<{
    readonly objectId: string;
    readonly payloadBytes: Uint8Array;
    readonly envelopeBytes: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly tombstoneManifestBytes: Uint8Array;
    readonly signerAuthorizationBytes: Uint8Array;
  }> = [];
  try {
    for (const [index, output] of checkedOutputs.entries()) {
      activeState(capability);
      const objectId = state.descriptor.outputObjectIds[index]!;
      const metadata = state.descriptor.outputObjectMetadata[index];
      if (metadata === undefined || metadata.objectId !== objectId) {
        throw new Error(
          "Processor transform output metadata is unavailable",
        );
      }
      if (
        output.plaintext instanceof Uint8Array
        && state.plaintextBytes + output.plaintext.length
          > state.descriptor.maximumPlaintextBytes
      ) {
        throw new RangeError(
          "Processor transform plaintext budget exceeded",
        );
      }
      if (!(output.plaintext instanceof Uint8Array)) {
        throw new TypeError(
          "Processor transform output plaintext must be Uint8Array",
        );
      }
      const plaintext = output.plaintext;
      let dek: Uint8Array | undefined;
      let payloadBytes: Uint8Array | undefined;
      let envelopeBytes: Uint8Array | undefined;
      let authorization: ProcessorSignerAuthorizationV1 | undefined;
      let manifest: ReturnType<
        typeof createProcessorObjectAccessManifestV4
      > | undefined;
      let tombstoneManifest: ReturnType<
        typeof createProcessorObjectAccessManifestV4
      > | undefined;
      try {
        addBudget(state, plaintext.length, 0);
        const currentGeneration =
          state.namespaceKeyring.generations.find(
            (entry) =>
              entry.generation
                === state.namespaceKeyring.currentGeneration,
          );
        if (currentGeneration === undefined) {
          throw new Error(
            "Processor transform current Namespace generation is unavailable",
          );
        }
        const encrypted = encryptObjectPayloadV2(
          state.crypto,
          {
            objectId: canonicalObjectId(objectId),
            keyClass: "ai",
            objectType: metadata.objectType,
            createdAt: unixTimestamp(metadata.createdAt),
          },
          plaintext,
        );
        dek = encrypted.dek;
        payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
        envelopeBytes = encodeNamespaceObjectEnvelopeV2(
          wrapObjectDekForNamespaceV2(
            state.crypto,
            currentGeneration.key,
            {
              objectId: canonicalObjectId(objectId),
              namespaceId: state.descriptor.namespaceId,
              keyClass: "ai",
              keyGeneration: currentGeneration.generation,
              bindingRevisionAtWrap:
                state.descriptor.expectedNamespaceAccessRevision,
            },
            dek,
          ),
        );
        authorization = decodeProcessorSignerAuthorizationV1(
          state.signerAuthorizationBytes,
        );
        manifest = createProcessorObjectAccessManifestV4(
          state.crypto,
          {
            objectId: canonicalObjectId(objectId),
            payloadHash: state.crypto.hash(payloadBytes),
            accessRevision: accessRevision(0),
            previousManifestHash: null,
            envelopeHashes: [state.crypto.hash(envelopeBytes)],
            signer: authorization.signer,
            signerAuthorizationHash:
              state.crypto.hash(state.signerAuthorizationBytes),
            hostAuthorizationRevision: authorizationRevision(
              authorization.processorAuthorizationRevision,
            ),
          },
          {
            signerPrivateKey: state.signerPrivateKey,
            signerAuthorizationBytes: state.signerAuthorizationBytes,
            now: state.now(),
            resolveCurrentIssuingDevicePublicKey:
              state.resolveCurrentSignerIssuingDevicePublicKey,
          },
        );
        tombstoneManifest = createProcessorObjectAccessManifestV4(
          state.crypto,
          {
            objectId: canonicalObjectId(objectId),
            payloadHash: manifest.manifest.payloadHash,
            accessRevision: accessRevision(1),
            previousManifestHash: manifest.hash,
            envelopeHashes: [],
            signer: authorization.signer,
            signerAuthorizationHash:
              state.crypto.hash(state.signerAuthorizationBytes),
            hostAuthorizationRevision:
              authorization.processorAuthorizationRevision,
          },
          {
            signerPrivateKey: state.signerPrivateKey,
            signerAuthorizationBytes: state.signerAuthorizationBytes,
            now: state.now(),
            resolveCurrentIssuingDevicePublicKey:
              state.resolveCurrentSignerIssuingDevicePublicKey,
          },
        );
        addBudget(
          state,
          0,
          payloadBytes.length
            + envelopeBytes.length
            + manifest.bytes.length
            + tombstoneManifest.bytes.length
            + state.signerAuthorizationBytes.length,
        );
        prepared.push(Object.freeze({
          objectId,
          payloadBytes,
          envelopeBytes,
          manifestBytes: manifest.bytes,
          tombstoneManifestBytes: tombstoneManifest.bytes,
          signerAuthorizationBytes:
            state.signerAuthorizationBytes.slice(),
        }));
        payloadBytes = undefined;
        envelopeBytes = undefined;
        manifest = undefined;
        tombstoneManifest = undefined;
      } finally {
        dek?.fill(0);
        payloadBytes?.fill(0);
        envelopeBytes?.fill(0);
        if (authorization !== undefined) wipeBytesDeep(authorization);
        if (manifest !== undefined) wipeBytesDeep(manifest);
        if (tombstoneManifest !== undefined) {
          wipeBytesDeep(tombstoneManifest);
        }
      }
    }
    activeState(capability);
    const authorityCheckedAt =
      await reverifyCurrentTransformAuthority(state);
    activeState(capability);
    const commitAuthorization = {
      state: "idle" as "idle" | "checking" | "checked",
    };
    const authorizeCommit = async (): Promise<number> => {
      if (commitAuthorization.state !== "idle") {
        throw new Error(
          "Processor transform commit authority was already checked",
        );
      }
      commitAuthorization.state = "checking";
      activeState(capability);
      const committedAt = await reverifyCurrentTransformAuthority(state);
      activeState(capability);
      commitAuthorization.state = "checked";
      return committedAt;
    };
    await state.objects.publishOutputs({
      idempotencyId: state.descriptor.idempotencyId,
      claimId: state.claimId,
      authorityCheckedAt,
      authorizeCommit,
      outputs: Object.freeze(prepared),
      signal: state.signal,
    });
    activeState(capability);
    if (commitAuthorization.state !== "checked") {
      throw new Error(
        "Processor transform output port skipped commit authorization",
      );
    }
    state.outputPhase = "published";
  } catch (error) {
    state.outputPhase = "failed";
    throw error;
  } finally {
    wipeBytesDeep(prepared);
  }
}

async function publishExactOutputs(
  capability: ProcessorTransformCapabilityV1,
  outputs: readonly ProcessorTransformOutputV1[],
): Promise<void> {
  const state = activeState(capability);
  const transferred = Array.isArray(outputs as unknown)
    ? (outputs as readonly unknown[]).flatMap((output) => {
      if (
        typeof output === "object"
        && output !== null
        && "plaintext" in output
        && output.plaintext instanceof Uint8Array
      ) {
        return [output.plaintext];
      }
      return [];
    })
    : [];
  for (const plaintext of transferred) {
    state.transferredOutputPlaintexts.add(plaintext);
  }
  try {
    await publishExactOutputsOwned(capability, outputs);
  } finally {
    for (const plaintext of transferred) {
      plaintext.fill(0);
      state.transferredOutputPlaintexts.delete(plaintext);
    }
  }
}

function createCapability(
  state: TransformState,
): ProcessorTransformCapabilityV1 {
  const capability = Object.freeze({
    openInputs: () =>
      trackOperation(state, openExactInputs(capability)),
    publishOutputs: (outputs: readonly ProcessorTransformOutputV1[]) =>
      trackOperation(state, publishExactOutputs(capability, outputs)),
  }) as ProcessorTransformCapabilityV1;
  capabilityStates.set(capability, state);
  return capability;
}

function trackOperation<Value>(
  state: TransformState,
  operation: Promise<Value>,
): Promise<Value> {
  const tracked = operation
    .catch((error: unknown) => {
      const normalized = error instanceof Error
        ? error
        : new Error("Processor transform operation failed");
      state.operationErrors.push(normalized);
      throw normalized;
    })
    .finally(() => {
      state.operations.delete(tracked);
    });
  state.operations.add(tracked);
  void tracked.catch(() => {});
  return tracked;
}

async function drainOperations(state: TransformState): Promise<void> {
  while (state.operations.size > 0) {
    await Promise.allSettled([...state.operations]);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Processor transform aborted");
}

function raceWithAbort<Value>(
  work: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

function abortRacedIssuerResolver(
  resolver: ResolveCurrentProcessorCredentialIssuerPublicKeyV1,
  signal: AbortSignal,
): ResolveCurrentProcessorCredentialIssuerPublicKeyV1 {
  return (context) =>
    raceWithAbort(
      Promise.resolve().then(() => resolver(context)),
      signal,
    );
}

function abortRacedCrypto(
  crypto: LatticeCrypto,
  signal: AbortSignal,
): LatticeCrypto {
  return new Proxy(crypto, {
    get(target, property, receiver) {
      if (property === "openSealed") {
        return (
          recipientPrivateKey: Uint8Array,
          sealed: Uint8Array,
        ) =>
          raceWithAbort(
            target.openSealed(recipientPrivateKey, sealed),
            signal,
          );
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...arguments_: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) return () => {};
  const abort = () => {
    target.abort(source.reason);
  };
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function executeOpenedTransform(
  opened: OpenedProcessorCredentialV1,
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly now: () => number;
    readonly claimId: string;
    readonly credentialBytes: Uint8Array;
    readonly resolveCurrentIssuerPublicKey:
      ResolveCurrentProcessorCredentialIssuerPublicKeyV1;
    readonly objects: ProcessorTransformObjectPortV1;
    readonly signerAuthorizationBytes: Uint8Array;
    readonly resolveHistoricalNamespaceCommitter:
      HistoricalCommitterResolverV2;
    readonly resolveCurrentSignerIssuingDevicePublicKey:
      ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
    readonly signal: AbortSignal;
    readonly abort: (reason: Error) => void;
    readonly execute: (
      capability: ProcessorTransformCapabilityV1,
      signal: AbortSignal,
    ) => void | PromiseLike<void>;
  }>,
): Promise<OneRunProcessorTransformResultV1> {
  let keyring: NamespaceKeyringPlaintextV2 | undefined;
  let state: TransformState | undefined;
  let capability: ProcessorTransformCapabilityV1 | undefined;
  let destroyOnAbort: (() => void) | undefined;
  try {
    if (input.signal.aborted) throw abortReason(input.signal);
    const namespace = await raceWithAbort(
      input.objects.loadNamespaceKeyring({
        namespaceId: opened.workDescriptor.namespaceId,
        signal: input.signal,
      }),
      input.signal,
    );
    if (
      namespace.envelope.namespaceId
        !== opened.workDescriptor.namespaceId
      || namespace.envelope.domainId !== opened.workDescriptor.domainId
      || namespace.envelope.domainEpoch
        !== opened.workDescriptor.expectedDomainEpoch
      || namespace.envelope.accessRevision
        !== opened.workDescriptor.expectedNamespaceAccessRevision
      || namespace.envelope.keyClass !== "ai"
    ) {
      throw new Error(
        "Processor transform Namespace keyring does not match its descriptor",
      );
    }
    try {
      keyring = openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot: opened.aiRoot,
        envelope: namespace.envelope,
        resolveHistoricalCommitter:
          input.resolveHistoricalNamespaceCommitter,
      });
    } finally {
      opened.aiRoot.fill(0);
    }
    state = {
      active: true,
      inputPhase: "idle",
      outputPhase: "idle",
      plaintextBytes: 0,
      ciphertextBytes: 0,
      crypto: input.crypto,
      descriptor: opened.workDescriptor,
      claimId: input.claimId,
      namespaceKeyring: keyring,
      signerPrivateKey: opened.processorSignerPrivateKey,
      signerAuthorizationBytes: input.signerAuthorizationBytes,
      resolveCurrentSignerIssuingDevicePublicKey:
        input.resolveCurrentSignerIssuingDevicePublicKey,
      now: input.now,
      credentialBytes: input.credentialBytes,
      resolveCurrentIssuerPublicKey:
        input.resolveCurrentIssuerPublicKey,
      objects: input.objects,
      signal: input.signal,
      openedPlaintexts: [],
      transferredOutputPlaintexts: new Set(),
      operations: new Set(),
      operationErrors: [],
      secretsDestroyed: false,
    };
    const activeStateForCleanup = state;
    destroyOnAbort = () =>
      destroyTransformSecrets(activeStateForCleanup);
    input.signal.addEventListener("abort", destroyOnAbort, {
      once: true,
    });
    if (input.signal.aborted) destroyOnAbort();
    const keyringEnvelopeBytes =
      serializeNamespaceKeyringEnvelope(namespace.envelope);
    try {
      addBudget(state, 0, keyringEnvelopeBytes.length);
    } finally {
      keyringEnvelopeBytes.fill(0);
    }
    const activeCapability = createCapability(state);
    capability = activeCapability;
    const work = Promise.resolve().then(
      () => input.execute(activeCapability, input.signal),
    );
    void work.catch(() => {});

    let workerError: Error | undefined;
    try {
      await raceWithAbort(work, input.signal);
    } catch (error) {
      workerError = error instanceof Error
        ? error
        : new Error("Processor transform worker failed");
      input.abort(workerError);
    }
    await raceWithAbort(drainOperations(state), input.signal);
    if (workerError !== undefined) throw workerError;
    if (input.signal.aborted) {
      throw abortReason(input.signal);
    }
    const operationError = state.operationErrors[0];
    if (operationError !== undefined) throw operationError;
    if (
      state.inputPhase !== "opened"
      || state.outputPhase !== "published"
    ) {
      throw new Error(
        "Processor transform must open its inputs and publish its outputs",
      );
    }
    return Object.freeze({ status: "executed" });
  } finally {
    if (destroyOnAbort !== undefined) {
      input.signal.removeEventListener("abort", destroyOnAbort);
    }
    if (state !== undefined) {
      destroyTransformSecrets(state);
    }
    if (capability !== undefined) {
      capabilityStates.delete(capability);
    }
    if (keyring !== undefined) {
      wipeBytesDeep(keyring);
    }
    destroyOpenedCredential(opened);
  }
}

/**
 * Claim and execute one Stenographer processor credential.
 *
 * Authority is resolved once before the exact-hash CAS and again while opening
 * the sealed secret. The durable claim therefore precedes all secret-bearing
 * crypto. A failed second authority check burns the already claimed
 * credential instead of lending stale authority.
 */
async function executeOneRunProcessorTransformInternalV1(
  input: ProcessorTransformRunInputV1 & Readonly<{
    readonly crypto: LatticeCrypto;
    readonly recipientPrivateKey: Uint8Array;
    readonly now: () => number;
    readonly signal: AbortSignal;
    readonly expectedAttempt: ProcessorTransformRecipientAttemptV1;
    readonly abort: (reason: Error) => void;
  }>,
): Promise<OneRunProcessorTransformResultV1> {
  if (input.signal.aborted) throw abortReason(input.signal);
  let verified:
    Awaited<
      ReturnType<
        typeof verifyCurrentProcessorSignerAuthorizationForCredentialV1
      >
    >
    | undefined;
  try {
    const verificationTime = input.now();
    verified = await raceWithAbort(
      verifyCurrentProcessorSignerAuthorizationForCredentialV1(
        input.crypto,
        {
          authorizationBytes: input.signerAuthorizationBytes,
          credentialBytes: input.credentialBytes,
          now: verificationTime,
          resolveCurrentCredentialIssuerPublicKey:
            abortRacedIssuerResolver(
              input.resolveCurrentIssuerPublicKey,
              input.signal,
            ),
          resolveCurrentSignerIssuingDevicePublicKey:
            input.resolveCurrentSignerIssuingDevicePublicKey,
        },
      ),
      input.signal,
    );
    const credential = verified.credential;
    const descriptor = credential.workDescriptor;
    if (
      descriptor.requestId !== input.expectedAttempt.requestId
      || descriptor.workId !== input.expectedAttempt.workId
      || descriptor.namespaceId !== input.expectedAttempt.namespaceId
      || descriptor.recipientGeneration
        !== input.expectedAttempt.recipientGeneration
      || descriptor.recipientKeyId
        !== input.expectedAttempt.recipientKeyId
      || descriptor.expiresAt !== input.expectedAttempt.expiresAt
      || !equalBytes(
        descriptor.recipientPublicKey,
        input.expectedAttempt.recipientPublicKey,
      )
    ) {
      throw new Error(
        "Processor credential does not match its process-local recipient",
      );
    }
    if (input.signal.aborted) throw abortReason(input.signal);
    const claimHash = credential.credentialHash.slice();
    const descriptorHash =
      credential.credential.workDescriptorHash.slice();
    try {
      const claim = await raceWithAbort(
        input.claims.claimExactCredential(Object.freeze({
        credentialId: credential.credential.id,
        credentialHash: claimHash,
        workDescriptorHash: descriptorHash,
        requestId: credential.workDescriptor.requestId,
        claimId: input.claimId,
        recipientGeneration:
          credential.workDescriptor.recipientGeneration,
        idempotencyId: credential.workDescriptor.idempotencyId,
        claimedAt: input.now(),
        signal: input.signal,
      })),
        input.signal,
      );
      if (input.signal.aborted) throw abortReason(input.signal);
      if (claim !== "claimed" && claim !== "already_claimed") {
        throw new TypeError(
          "Processor credential claim port returned an invalid result",
        );
      }
      if (claim === "already_claimed") {
        return Object.freeze({
          status: "unavailable",
          reason: "credential_replayed",
        });
      }
    } finally {
      claimHash.fill(0);
      descriptorHash.fill(0);
    }
  } finally {
    if (verified !== undefined) wipeBytesDeep(verified);
  }

  if (input.signal.aborted) throw abortReason(input.signal);
  const recipientPrivateKey = copyBytes(
    "Processor transform recipient private key",
    input.recipientPrivateKey,
  );
  let opened: OpenedProcessorCredentialV1 | null = null;
  try {
    opened = await raceWithAbort(
      openProcessorCredentialV1(abortRacedCrypto(input.crypto, input.signal), {
        credentialBytes: input.credentialBytes,
        recipientPrivateKey,
        now: input.now(),
        resolveCurrentIssuerPublicKey:
          abortRacedIssuerResolver(
            input.resolveCurrentIssuerPublicKey,
            input.signal,
          ),
      }),
      input.signal,
    );
  } finally {
    recipientPrivateKey.fill(0);
  }
  if (opened === null) {
    throw new Error("Processor credential could not be opened");
  }
  if (input.signal.aborted) {
    destroyOpenedCredential(opened);
    throw abortReason(input.signal);
  }
  return executeOpenedTransform(opened, input);
}
