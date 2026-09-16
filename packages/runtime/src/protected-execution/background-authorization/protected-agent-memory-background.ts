import { createHash } from "node:crypto";

import {
  createProtectedInvocationRecipient,
  destroyProtectedInvocationRecipient,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentBackgroundMemoryWorkPort,
  type ProtectedAgentBackgroundMemoryWorkResult,
  type ProtectedInvocationCapability,
  type ProtectedInvocationRecipient,
} from "@nautilo/lattice-bridge";
import { agentId, type LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeBackgroundAgentWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2,
  type BackgroundAgentWorkDescriptorV2,
} from "@nautilo/lattice-crypto/wire";
import { runProtectedBackgroundMemoryReview } from "@nautilo/agent";

import {
  BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationPublicationReconciliation,
  markBackgroundAuthorizationRunning,
  restartBackgroundAuthorizationAfterUncommittedPublication,
  scheduleBackgroundAuthorizationPublicationRetry,
  BackgroundAuthorizationTransitionError,
} from "./lifecycle";
import type {
  BackgroundAuthorizationVerifiedDeviceResponse,
  BackgroundAuthorizationRecord,
  BackgroundAuthorizationRepository,
} from "./repository";

const MAX_PROCESS_LOCAL_RECIPIENTS = 256;

export type ProtectedAgentMemoryBackgroundDescriptorFacts = Readonly<
  Omit<
    BackgroundAgentWorkDescriptorV2,
    "formatVersion" | "recipientKeyId" | "recipientPublicKey"
  >
>;

export type ProtectedAgentMemoryBackgroundDescriptorPlan = Readonly<{
  descriptorBytes: Uint8Array;
  descriptorHash: Uint8Array;
  descriptor: BackgroundAgentWorkDescriptorV2;
}>;

/**
 * Canonical descriptor planner. Callers provide product coordinates and
 * authorization revisions only; plaintext, prompts, candidate vectors and
 * model messages have no field through which they can enter durable state.
 */
export function planProtectedAgentMemoryBackgroundDescriptor(input: Readonly<{
  facts: ProtectedAgentMemoryBackgroundDescriptorFacts;
  recipientKeyId: string;
  recipientPublicKey: Uint8Array;
}>): ProtectedAgentMemoryBackgroundDescriptorPlan {
  const descriptorBytes = encodeBackgroundWorkDescriptorV2({
    ...input.facts,
    formatVersion: 2,
    recipientKeyId: input.recipientKeyId,
    recipientPublicKey: input.recipientPublicKey.slice(),
  });
  const descriptor = decodeBackgroundAgentWorkDescriptorV2(descriptorBytes);
  const descriptorHash = createHash("sha256").update(descriptorBytes).digest();
  return Object.freeze({ descriptorBytes, descriptorHash, descriptor });
}

function descriptorFactsMatchRecord(
  facts: ProtectedAgentMemoryBackgroundDescriptorFacts,
  record: BackgroundAuthorizationRecord,
): boolean {
  if (
    record.snapshot.formatVersion !== 2
    || record.snapshot.credentialSubject.kind !== "agent"
    || record.authoritySet === undefined
    || facts.requestId !== record.snapshot.requestId
    || facts.recipientGeneration !== record.snapshot.recipientGeneration
    || facts.workId !== record.snapshot.workId
    || facts.workKind !== record.workKind
    || facts.purpose !== record.purpose
    || facts.anchorNamespaceId !== record.snapshot.namespaceId
    || facts.anchorDomainId !== record.domainId
    || facts.subject.kind !== "agent"
    || facts.subject.agentId !== record.snapshot.credentialSubject.agentId
    || facts.subject.runtimeGeneration
      !== record.snapshot.credentialSubject.runtimeGeneration
    || facts.subject.authorizationRevision
      !== record.snapshot.credentialSubject.authorizationRevision
    || facts.namespaceRequirements.length
      !== record.authoritySet.namespaceRequirements.length
    || facts.domainRequirements.length
      !== record.authoritySet.domainRequirements.length
  ) return false;
  return facts.namespaceRequirements.every((actual, index) => {
    const expected = record.authoritySet!.namespaceRequirements[index];
    return expected !== undefined
      && expected.ordinal === index
      && actual.namespaceId === expected.namespaceId
      && actual.domainId === expected.domainId
      && actual.expectedAccessRevision === expected.expectedAccessRevision
      && actual.expectedPolicyRevision === expected.expectedPolicyRevision
      && actual.operations.length === expected.operations.length
      && actual.operations.every((operation, operationIndex) =>
        operation === expected.operations[operationIndex]
      );
  }) && facts.domainRequirements.every((actual, index) => {
    const expected = record.authoritySet!.domainRequirements[index];
    return expected !== undefined
      && expected.ordinal === index
      && actual.domainId === expected.domainId
      && actual.expectedEpoch === expected.expectedEpoch
      && actual.expectedAgentAuthorizationRevision
        === expected.expectedAgentAuthorizationRevision;
  });
}

type RecipientEntry = Readonly<{
  recipient: ProtectedInvocationRecipient;
  publicKey: Uint8Array;
  expiresAt: number;
}>;

/** Process-local custody only. Recipient private keys live in Bridge WeakMaps. */
export class ProtectedAgentMemoryBackgroundRecipientRegistry {
  readonly #entries = new Map<string, RecipientEntry>();

  constructor(
    private readonly crypto: LatticeCrypto,
  ) {}

  async create(input: Readonly<{
    requestId: string;
    recipientGeneration: number;
    agentId: string;
    recipientKeyId: string;
    expiresAt: number;
    now: number;
  }>): Promise<Readonly<{ recipient: ProtectedInvocationRecipient; publicKey: Uint8Array }>> {
    this.pruneExpired(input.now);
    if (this.#entries.size >= MAX_PROCESS_LOCAL_RECIPIENTS) {
      throw new TypeError("Recipient registry capacity exceeded");
    }
    const key = this.#key(input.requestId, input.recipientGeneration);
    if (this.#entries.has(key)) throw new TypeError("Recipient attempt exists");
    const created = await createProtectedInvocationRecipient({
      crypto: this.crypto,
      recipientAgentId: agentId(input.agentId),
      recipientKeyId: input.recipientKeyId,
    });
    const entry = Object.freeze({
      recipient: created.recipient,
      publicKey: created.publicKey.slice(),
      expiresAt: input.expiresAt,
    });
    this.#entries.set(key, entry);
    return Object.freeze({
      recipient: entry.recipient,
      publicKey: entry.publicKey.slice(),
    });
  }

  get(requestId: string, recipientGeneration: number, now: number): RecipientEntry | null {
    const entry = this.#entries.get(this.#key(requestId, recipientGeneration));
    if (entry !== undefined && now >= entry.expiresAt) {
      this.delete(requestId, recipientGeneration);
      return null;
    }
    return entry === undefined ? null : Object.freeze({
      recipient: entry.recipient,
      publicKey: entry.publicKey.slice(),
      expiresAt: entry.expiresAt,
    });
  }

  delete(requestId: string, recipientGeneration: number): void {
    const key = this.#key(requestId, recipientGeneration);
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    entry.publicKey.fill(0);
    destroyProtectedInvocationRecipient(entry.recipient);
    this.#entries.delete(key);
  }

  clear(): void {
    for (const key of [...this.#entries.keys()]) {
      const separator = key.lastIndexOf("\u0000");
      this.delete(key.slice(0, separator), Number(key.slice(separator + 1)));
    }
  }

  pruneExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now < entry.expiresAt) continue;
      const separator = key.lastIndexOf("\u0000");
      this.delete(key.slice(0, separator), Number(key.slice(separator + 1)));
    }
  }

  #key(requestId: string, generation: number): string {
    return `${requestId}\u0000${generation}`;
  }
}

export interface ProtectedAgentMemoryBackgroundCapabilityPort {
  open(input: Readonly<{
    record: BackgroundAuthorizationRecord;
    recipient: ProtectedInvocationRecipient;
  }>): Promise<ProtectedInvocationCapability | null>;
}

export interface ProtectedAgentMemoryBackgroundReviewOptions {
  readonly embedding: ProtectedAgentMemoryEmbeddingPort;
  readonly modelId: string;
  readonly roomId: string;
  readonly maximumIterations: number;
  readonly assistantName?: string;
  readonly soulFile?: string;
}

export type ProtectedAgentMemoryBackgroundRunResult =
  | Readonly<{ status: "completed" | "publication_pending" }>
  | Readonly<{ status: "pending"; reason: "offline" | "recipient_lost" | "expired" | "provider_failure" }>
  | Readonly<{ status: "failed"; reason: "authorization" | "content" | "integrity" | "execution" }>
  | Readonly<{ status: "stale" | "missing" }>;

/**
 * Explicit dormant lifecycle composition. It is intentionally not registered
 * with a production scheduler in Wave 12: foreground turn completion remains
 * non-failing while this coordinator advances its durable request separately.
 */
export class ProtectedAgentMemoryBackgroundCoordinator {
  constructor(private readonly options: Readonly<{
    repository: BackgroundAuthorizationRepository;
    recipients: ProtectedAgentMemoryBackgroundRecipientRegistry;
    capability: ProtectedAgentMemoryBackgroundCapabilityPort;
    terminal: ProtectedAgentBackgroundMemoryWorkPort;
    reconcilePublication(record: BackgroundAuthorizationRecord): Promise<
      "completed" | "pending" | "stale" | "not_started"
    >;
    nextAttemptAt(record: BackgroundAuthorizationRecord, now: number): number;
    descriptorFacts(record: BackgroundAuthorizationRecord): Promise<ProtectedAgentMemoryBackgroundDescriptorFacts | null>;
    review(record: BackgroundAuthorizationRecord): ProtectedAgentMemoryBackgroundReviewOptions;
    now(): number;
    recipientKeyId(record: BackgroundAuthorizationRecord): string;
    claimId(record: BackgroundAuthorizationRecord): string;
  }>) {}

  async acceptVerifiedResponse(
    response: BackgroundAuthorizationVerifiedDeviceResponse,
  ): Promise<"accepted" | "duplicate" | "lost"> {
    const accepted = await this.options.repository.acceptVerifiedResponse({
      response,
      acceptedAt: this.options.now(),
    });
    return accepted.status;
  }

  async prepare(requestId: string): Promise<Readonly<{
    status: "authorization_required";
    descriptorBytes: Uint8Array;
    descriptorHash: Uint8Array;
  }> | Readonly<{ status: "missing" | "stale" | "pending" }>> {
    const current = await this.options.repository.get(requestId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    if (current.snapshot.credentialSubject.kind !== "agent") {
      return Object.freeze({ status: "stale" as const });
    }
    if (current.snapshot.state === "awaiting_device") {
      if (
        current.snapshot.recipient !== null
        && this.options.now() >= current.snapshot.recipient.expiresAt
      ) {
        await this.retryRecipient(current, "attempt_expired");
        return Object.freeze({ status: "pending" as const });
      }
      const entry = this.options.recipients.get(
        requestId,
        current.snapshot.recipientGeneration,
        this.options.now(),
      );
      if (entry === null || current.descriptorBytes === null) {
        await this.retryRecipient(current, "recipient_lost");
        return Object.freeze({ status: "pending" as const });
      }
      return Object.freeze({
        status: "authorization_required" as const,
        descriptorBytes: current.descriptorBytes.slice(),
        descriptorHash: Uint8Array.from(Buffer.from(
          current.snapshot.descriptorDigest!,
          "hex",
        )),
      });
    }
    if (current.snapshot.state !== "awaiting_recipient") {
      return Object.freeze({ status: "stale" as const });
    }
    const now = this.options.now();
    if (current.snapshot.nextAttemptAt !== null && now < current.snapshot.nextAttemptAt) {
      return Object.freeze({ status: "pending" as const });
    }
    const facts = await this.options.descriptorFacts(current);
    if (
      facts === null
      || !descriptorFactsMatchRecord(facts, current)
      || facts.expiresAt <= now
    ) {
      return Object.freeze({ status: "stale" as const });
    }
    const created = await this.options.recipients.create({
      requestId,
      recipientGeneration: current.snapshot.recipientGeneration,
      agentId: current.snapshot.credentialSubject.agentId,
      recipientKeyId: this.options.recipientKeyId(current),
      expiresAt: facts.expiresAt,
      now,
    });
    let committed = false;
    try {
      const plan = planProtectedAgentMemoryBackgroundDescriptor({
        facts,
        recipientKeyId: this.options.recipientKeyId(current),
        recipientPublicKey: created.publicKey,
      });
      const next: BackgroundAuthorizationRecord = {
        ...current,
        descriptorBytes: plan.descriptorBytes.slice(),
        snapshot: attachBackgroundAuthorizationRecipient(current.snapshot, {
          recipientGeneration: current.snapshot.recipientGeneration,
          descriptorDigest: Buffer.from(plan.descriptorHash).toString("hex"),
          recipientKeyId: this.options.recipientKeyId(current),
          recipientPublicKey: Buffer.from(created.publicKey).toString("base64url"),
          expiresAt: facts.expiresAt,
          now,
        }),
      };
      const stored = await this.options.repository.compareAndSwap({
        expectedRequestRevision: current.snapshot.requestRevision,
        next,
      });
      if (stored.status !== "updated") return Object.freeze({ status: "stale" as const });
      committed = true;
      return Object.freeze({
        status: "authorization_required" as const,
        descriptorBytes: plan.descriptorBytes.slice(),
        descriptorHash: plan.descriptorHash.slice(),
      });
    } finally {
      created.publicKey.fill(0);
      if (!committed) {
        this.options.recipients.delete(
          requestId,
          current.snapshot.recipientGeneration,
        );
      }
    }
  }

  async run(requestId: string): Promise<ProtectedAgentMemoryBackgroundRunResult> {
    let current = await this.options.repository.get(requestId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    if (current.snapshot.state === "publication_reconciliation") {
      if (
        current.snapshot.nextAttemptAt !== null
        && this.options.now() < current.snapshot.nextAttemptAt
      ) {
        return Object.freeze({ status: "publication_pending" as const });
      }
      return this.reconcile(current);
    }
    if (current.snapshot.state === "running") {
      const resolved = await this.resolveRunningPublication(current);
      if (resolved !== null) return resolved;
      if (
        current.snapshot.claimExpiresAt !== null
        && this.options.now() >= current.snapshot.claimExpiresAt
      ) {
        await this.retryRecipient(current, "claim_expired");
        return Object.freeze({
          status: "pending" as const,
          reason: "recipient_lost" as const,
        });
      }
      return Object.freeze({ status: "publication_pending" as const });
    }
    if (current.snapshot.state !== "grant_ready" || current.acceptedMaterial === null) {
      return Object.freeze({ status: "pending" as const, reason: "offline" as const });
    }
    const entry = this.options.recipients.get(
      requestId,
      current.snapshot.recipientGeneration,
      this.options.now(),
    );
    if (entry === null) {
      await this.retryRecipient(current, "recipient_lost");
      return Object.freeze({ status: "pending" as const, reason: "recipient_lost" as const });
    }
    const now = this.options.now();
    if (current.acceptedMaterial.authorizationExpiresAt <= now) {
      await this.retryRecipient(current, "stale_authority");
      return Object.freeze({ status: "pending" as const, reason: "expired" as const });
    }
    const claimed = await this.options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: {
        ...current,
        snapshot: claimBackgroundAuthorizationRequest(
          current.snapshot,
          this.options.claimId(current),
          now,
          now + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
        ),
      },
    });
    if (claimed.status !== "updated") {
      this.options.recipients.delete(requestId, current.snapshot.recipientGeneration);
      return Object.freeze({ status: "stale" as const });
    }
    current = claimed.record;
    let capability: ProtectedInvocationCapability | null;
    try {
      capability = await this.options.capability.open({
        record: current,
        recipient: entry.recipient,
      });
    } catch {
      await this.retryRecipient(current, "recipient_lost");
      return Object.freeze({
        status: "pending" as const,
        reason: "recipient_lost" as const,
      });
    }
    if (capability === null || current.descriptorBytes === null || current.snapshot.descriptorDigest === null) {
      await this.retryRecipient(current, "recipient_lost");
      return Object.freeze({ status: "pending" as const, reason: "recipient_lost" as const });
    }
    const runningSnapshot = markBackgroundAuthorizationRunning(current.snapshot, now);
    const running = await this.options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: { ...current, snapshot: runningSnapshot },
    });
    if (running.status !== "updated") {
      this.options.recipients.delete(requestId, current.snapshot.recipientGeneration);
      return Object.freeze({ status: "stale" as const });
    }
    let result: ProtectedAgentBackgroundMemoryWorkResult;
    try {
      const review = this.options.review(running.record);
      const terminal = await this.options.terminal.execute({
        capability,
        descriptorBytes: running.record.descriptorBytes!,
        descriptorHash: Uint8Array.from(Buffer.from(running.record.snapshot.descriptorDigest!, "hex")),
        transform: (inputs) => runProtectedBackgroundMemoryReview({
          kind: running.record.workKind as "memory.review" | "memory.exit_flush",
          authority: decodeBackgroundAgentWorkDescriptorV2(running.record.descriptorBytes!).source.kind === "protected_memory_work"
            ? this.authority(running.record)
            : this.authority(running.record),
          inputs,
          outputSlots: this.outputSlots(running.record),
          tierSlots: this.tierSlots(running.record),
          ...review,
          mutationRequestId: running.record.idempotencyKey,
        }),
      });
      if (terminal.status === "unavailable") {
        const latest = await this.options.repository.get(requestId);
        if (latest !== null) await this.retryRecipient(latest, "stale_authority");
        return Object.freeze({ status: "failed" as const, reason: "authorization" as const });
      }
      result = terminal.value;
    } catch {
      const latest = await this.options.repository.get(requestId);
      if (latest === null) return Object.freeze({ status: "stale" as const });
      const resolved = latest.snapshot.state === "running"
        ? await this.resolveRunningPublication(latest)
        : null;
      if (resolved !== null) return resolved;
      return this.terminal(latest, "integrity_failure", "execution");
    } finally {
      this.options.recipients.delete(requestId, running.record.snapshot.recipientGeneration);
    }
    const latest = await this.options.repository.get(requestId);
    if (latest === null) return Object.freeze({ status: "stale" as const });
    if (result.status === "completed") {
      return this.complete(latest);
    }
    if (result.status === "publication_pending") {
      return this.enterReconciliation(latest);
    }
    if (result.status === "publication_failed") {
      return this.terminal(latest, "policy_rejected", "content");
    }
    if (result.status === "unavailable") {
      if (result.reason === "transform_unavailable") {
        await this.retryRecipient(latest, "provider_transient_failure");
        return Object.freeze({
          status: "pending" as const,
          reason: "provider_failure" as const,
        });
      }
      if (
        result.reason === "content_unavailable"
        || result.reason === "target_encryption_not_ready"
        || result.reason === "output_plan_unavailable"
      ) {
        return this.terminal(latest, "policy_rejected", "content");
      }
      if (result.reason === "authorization_unavailable") {
        await this.retryRecipient(latest, "stale_authority");
        return Object.freeze({
          status: "failed" as const,
          reason: "authorization" as const,
        });
      }
      return this.terminal(latest, "integrity_failure", "integrity");
    }
    return this.terminal(latest, "integrity_failure", "integrity");
  }

  private async complete(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedAgentMemoryBackgroundRunResult> {
    const now = this.options.now();
    const stored = await this.options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: {
        ...current,
        snapshot: completeBackgroundAuthorizationRequest(current.snapshot, now),
        finishedAt: now,
      },
    });
    return Object.freeze({
      status: stored.status === "updated" ? "completed" as const : "stale" as const,
    });
  }

  private async terminal(
    current: BackgroundAuthorizationRecord,
    terminalReason: "integrity_failure" | "policy_rejected" | "retry_limit_exhausted",
    resultReason: "authorization" | "content" | "integrity" | "execution",
  ): Promise<ProtectedAgentMemoryBackgroundRunResult> {
    const now = this.options.now();
    const stored = await this.options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: {
        ...current,
        snapshot: failBackgroundAuthorizationRequest(
          current.snapshot,
          terminalReason,
          now,
        ),
        finishedAt: now,
      },
    });
    return stored.status === "updated"
      ? Object.freeze({ status: "failed" as const, reason: resultReason })
      : Object.freeze({ status: "stale" as const });
  }

  private async enterReconciliation(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedAgentMemoryBackgroundRunResult> {
    const stored = await this.options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: {
        ...current,
        snapshot: markBackgroundAuthorizationPublicationReconciliation(
          current.snapshot,
          this.options.now(),
        ),
      },
    });
    return Object.freeze({
      status: stored.status === "updated"
        ? "publication_pending" as const
        : "stale" as const,
    });
  }

  private async reconcile(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedAgentMemoryBackgroundRunResult> {
    let outcome: "completed" | "pending" | "stale" | "not_started";
    try {
      outcome = await this.options.reconcilePublication(current);
    } catch {
      outcome = "pending";
    }
    const latest = await this.options.repository.get(current.snapshot.requestId);
    if (latest === null) return Object.freeze({ status: "stale" as const });
    if (outcome === "completed") return this.complete(latest);
    if (outcome === "stale") {
      return this.terminal(latest, "policy_rejected", "content");
    }
    const now = this.options.now();
    if (outcome === "not_started") {
      try {
        const stored = await this.options.repository.compareAndSwap({
          expectedRequestRevision: latest.snapshot.requestRevision,
          next: {
            ...latest,
            snapshot: restartBackgroundAuthorizationAfterUncommittedPublication(
              latest.snapshot,
              {
                now,
                nextAttemptAt: this.options.nextAttemptAt(latest, now),
              },
            ),
            descriptorBytes: null,
            acceptedMaterial: null,
          },
        });
        return stored.status === "updated"
          ? Object.freeze({
              status: "pending" as const,
              reason: "recipient_lost" as const,
            })
          : Object.freeze({ status: "stale" as const });
      } catch (cause) {
        if (
          cause instanceof BackgroundAuthorizationTransitionError
          && cause.reason === "counter_exhausted"
        ) {
          return this.terminal(
            latest,
            "retry_limit_exhausted",
            "execution",
          );
        }
        throw cause;
      }
    }
    try {
      const stored = await this.options.repository.compareAndSwap({
        expectedRequestRevision: latest.snapshot.requestRevision,
        next: {
          ...latest,
          snapshot: scheduleBackgroundAuthorizationPublicationRetry(
            latest.snapshot,
            {
              now,
              nextAttemptAt: this.options.nextAttemptAt(latest, now),
            },
          ),
        },
      });
      return Object.freeze({
        status: stored.status === "updated"
          ? "publication_pending" as const
          : "stale" as const,
      });
    } catch (cause) {
      if (
        cause instanceof BackgroundAuthorizationTransitionError
        && cause.reason === "counter_exhausted"
      ) {
        return this.terminal(latest, "retry_limit_exhausted", "execution");
      }
      throw cause;
    }
  }

  private async resolveRunningPublication(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedAgentMemoryBackgroundRunResult | null> {
    let outcome: "completed" | "pending" | "stale" | "not_started";
    try {
      outcome = await this.options.reconcilePublication(current);
    } catch {
      return null;
    }
    const latest = await this.options.repository.get(current.snapshot.requestId);
    if (latest === null) return Object.freeze({ status: "stale" as const });
    if (outcome === "completed") return this.complete(latest);
    if (outcome === "stale") {
      return this.terminal(latest, "policy_rejected", "content");
    }
    if (outcome === "pending") {
      return latest.snapshot.state === "publication_reconciliation"
        ? Object.freeze({ status: "publication_pending" as const })
        : this.enterReconciliation(latest);
    }
    return null;
  }

  private descriptor(record: BackgroundAuthorizationRecord): BackgroundAgentWorkDescriptorV2 {
    if (record.descriptorBytes === null) throw new TypeError("Descriptor unavailable");
    return decodeBackgroundAgentWorkDescriptorV2(record.descriptorBytes);
  }

  private authority(record: BackgroundAuthorizationRecord) {
    const descriptor = this.descriptor(record);
    const source = descriptor.source;
    if (source.kind !== "protected_memory_work") throw new TypeError("Wrong descriptor source");
    const subjectUserId = record.snapshot.acceptedResponse?.issuingHumanId;
    if (subjectUserId === undefined) throw new TypeError("Issuing Human unavailable");
    const writableNamespaceIds = [...new Set(
      descriptor.outputSlots.flatMap((slot) => slot.namespaceIds),
    )];
    return source.productAuthority.mode === "scope"
      ? { mode: "scope" as const, subjectUserId, agentId: descriptor.subject.agentId, scopeId: source.productAuthority.scopeId, originWritableNamespaceId: source.productAuthority.originWritableNamespaceId }
      : { mode: "namespace" as const, subjectUserId, agentId: descriptor.subject.agentId, readableNamespaceIds: descriptor.namespaceRequirements.filter((entry) => entry.operations.includes("decrypt")).map((entry) => entry.namespaceId), mutableNamespaceIds: descriptor.namespaceRequirements.filter((entry) => entry.operations.includes("encrypt")).map((entry) => entry.namespaceId), writableNamespaceId: writableNamespaceIds.length === 1 ? writableNamespaceIds[0]! : null };
  }

  private outputSlots(record: BackgroundAuthorizationRecord) {
    const descriptor = this.descriptor(record);
    if (descriptor.source.kind !== "protected_memory_work") return [];
    return descriptor.source.outputRevisions.map((entry, index) => Object.freeze({
      action: entry.action,
      publicationIdempotencyId: entry.publicationIdempotencyId,
      memoryId: entry.memoryId,
      expectedContentRevision: entry.expectedContentRevision,
      expectedCryptoAccessRevision: entry.expectedCryptoAccessRevision,
      nextContentRevision: entry.nextContentRevision,
      requiredNamespaceIds: descriptor.outputSlots[index]!.namespaceIds,
      createdAt: descriptor.outputSlots[index]!.createdAt,
    }));
  }

  private tierSlots(record: BackgroundAuthorizationRecord) {
    const descriptor = this.descriptor(record);
    return descriptor.source.kind === "protected_memory_work" ? descriptor.source.tierMutations : [];
  }

  private async retryRecipient(record: BackgroundAuthorizationRecord, reason: "recipient_lost" | "attempt_expired" | "stale_authority" | "provider_transient_failure" | "claim_expired"): Promise<void> {
    this.options.recipients.delete(record.snapshot.requestId, record.snapshot.recipientGeneration);
    const now = this.options.now();
    const snapshot = advanceBackgroundAuthorizationGeneration(record.snapshot, { reason, now, nextAttemptAt: now });
    await this.options.repository.compareAndSwap({
      expectedRequestRevision: record.snapshot.requestRevision,
      next: { ...record, snapshot, descriptorBytes: null, acceptedMaterial: null },
    });
  }
}

export function protectedAgentMemoryBackgroundWorkIdentity(bytes: Uint8Array): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}
