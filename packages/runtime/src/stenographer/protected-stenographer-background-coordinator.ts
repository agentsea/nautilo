import {ProcessorReconciliationIntegrityErrorV2, ProcessorOutputRepairIntegrityErrorV2} from "@nautilo/lattice-crypto/background";
import {ClassifiedDataOperationError} from "@nautilo/lattice-bridge";
import type {ProcessorOutputRepairBindingV2, ProcessorOutputRepairObjectPortV2, ResolveCurrentBackgroundAuthorizationIssuerV2, ProcessorTransformObjectPortV2, ProcessorReconciliationObjectPortV2, ProcessorPublicationReconciliationBindingV2} from "@nautilo/lattice-crypto/background";
import {
  ProcessorTransformRecipientRegistry,
  type ProcessorCredentialClaimPort,
  type ProcessorTransformCapability,
  type ProcessorTransformObjectPort,
  type HistoricalCommitterResolver,
} from "@nautilo/lattice-crypto";
import {
  decodeBackgroundAuthorizationResponseV1,
  type ResolveCurrentProcessorCredentialIssuerPublicKeyV1,
  type ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1,
} from "@nautilo/lattice-crypto/wire";
import type {
  VerifiedProcessorBackgroundAuthorizationDeviceResponse,
} from "@nautilo/lattice-bridge";

import {
  BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  BackgroundAuthorizationTransitionError,
  advanceBackgroundAuthorizationGeneration,
  cancelBackgroundAuthorizationRequest,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationPublicationReconciliation,
  restartBackgroundAuthorizationAfterUncommittedPublication,
  scheduleBackgroundAuthorizationPublicationRetry,
} from "../protected-execution/background-authorization/lifecycle";
import {
  prepareProcessorRecipient,
  type PrepareProcessorRecipientResult,
  type ProcessorRecipientDescriptorAttempt,
  type ProcessorRecipientDescriptorFactory,
} from "../protected-execution/background-authorization/prepare-processor-recipient";
import {
  ProcessorCredentialClaimError,
} from "../protected-execution/background-authorization/processor-credential-claim-port";
import {
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
} from "../protected-execution/background-authorization/repository";
import type {
  ProtectedStenographerCompactionResult,
} from "./protected-stenographer-compaction";
import type {
  ProtectedStenographerExtractionResult,
} from "./protected-stenographer-extraction";

export type ProtectedStenographerDescriptorAttempt =
  ProcessorRecipientDescriptorAttempt;

export interface ProtectedStenographerBackgroundDescriptorFactory {
  readonly create: ProcessorRecipientDescriptorFactory["create"];
}

export interface ProtectedStenographerBackgroundResponseVerifier {
  /**
   * Returns an owned verified DTO. The coordinator copies its durable facts
   * through the repository and wipes every byte buffer before returning.
   */
  readonly verify: (input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly responseBytes: Uint8Array;
    readonly signerAuthorizationBytes: Uint8Array;
    readonly now: number;
  }>) => Promise<VerifiedProcessorBackgroundAuthorizationDeviceResponse>;
}

export interface ProtectedStenographerBackgroundTransformMaterialV1 {
  readonly formatVersion?: 1;
  /** Owned buffer; the coordinator wipes it after the run attempt. */
  readonly signerAuthorizationBytes: Uint8Array;
  readonly resolveCurrentIssuerPublicKey:
    ResolveCurrentProcessorCredentialIssuerPublicKeyV1;
  readonly resolveHistoricalNamespaceCommitter:
    HistoricalCommitterResolver;
  readonly resolveCurrentSignerIssuingDevicePublicKey:
    ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
  readonly claims: ProcessorCredentialClaimPort;
  readonly objects: ProcessorTransformObjectPort;
}

export interface ProtectedStenographerBackgroundTransformMaterialV2 {
  readonly formatVersion: 2;
  readonly resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2;
  readonly claims: ProcessorCredentialClaimPort;
  readonly objects: ProcessorTransformObjectPortV2;
}

export interface ProtectedStenographerBackgroundReconciliationMaterialV2 {
  readonly formatVersion: 2;
  readonly binding: ProcessorPublicationReconciliationBindingV2;
  readonly resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2;
  readonly claims: ProcessorCredentialClaimPort;
  readonly objects: ProcessorReconciliationObjectPortV2;
}

export interface ProtectedStenographerBackgroundOutputRepairMaterialV2 {
  readonly formatVersion: 2;
  readonly repairBinding: ProcessorOutputRepairBindingV2;
  readonly resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2;
  readonly claims: ProcessorCredentialClaimPort;
  readonly objects: ProcessorOutputRepairObjectPortV2;
}

export type ProtectedStenographerBackgroundTransformMaterial =
  | ProtectedStenographerBackgroundTransformMaterialV1
  | ProtectedStenographerBackgroundTransformMaterialV2
  | ProtectedStenographerBackgroundReconciliationMaterialV2
  | ProtectedStenographerBackgroundOutputRepairMaterialV2;

export interface ProtectedStenographerBackgroundTransformMaterialPort {
  /**
   * Loads the signer evidence already accepted atomically with the response.
   * Implementations must re-read durable state; process-local response caches
   * are not an acceptable source after restart.
   */
  readonly loadAccepted: (
    record: BackgroundAuthorizationRecord,
  ) => Promise<
    | Readonly<{
      readonly status: "loaded";
      readonly material: ProtectedStenographerBackgroundTransformMaterial;
    }>
    | Readonly<{ readonly status: "integrity_failure" }>
  >;
}

export interface ProtectedStenographerBackgroundExecutionPort {
  readonly executeWork: (input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly capability: ProcessorTransformCapability;
    readonly signal: AbortSignal;
  }>) => Promise<
    | ProtectedStenographerExtractionResult
    | ProtectedStenographerCompactionResult
  >;
  readonly reconcilePublication: (
    record: BackgroundAuthorizationRecord,
  ) => Promise<"completed" | "pending" | "stale" | "not_started">;
}

export type ProtectedStenographerBackgroundPrepareResult =
  PrepareProcessorRecipientResult;

export type ProtectedStenographerBackgroundAcceptResult =
  Readonly<{ readonly status: "accepted" | "duplicate" | "lost" }>;

export type ProtectedStenographerBackgroundRunResult =
  | Readonly<{
    readonly status:
      | "missing"
      | "stale"
      | "not_ready";
  }>
  | Readonly<{ readonly status: "completed" }>
  | Readonly<{
    readonly status: "retry_scheduled";
    readonly recipientGeneration: number;
    readonly reason:
      | "attempt_expired"
      | "provider_transient_failure"
      | "recipient_lost"
      | "claim_expired";
  }>
  | Readonly<{
    readonly status: "reconciliation_pending";
  }>
  | Readonly<{
    readonly status: "terminal";
    readonly reason:
      | "retry_limit_exhausted"
      | "stale_work"
      | "transition_rejected"
      | "integrity_failure"
      | "provider_outcome_unknown";
  }>;

export interface ProtectedStenographerBackgroundCoordinatorOptions {
  readonly repository: BackgroundAuthorizationRepository;
  readonly recipients: ProcessorTransformRecipientRegistry;
  readonly descriptors: ProtectedStenographerBackgroundDescriptorFactory;
  readonly responses?: ProtectedStenographerBackgroundResponseVerifier;
  /** Content-free wake only after the awaiting-device CAS is durable. */
  readonly authorizationRequested?: (record: BackgroundAuthorizationRecord) => Promise<void>;
  readonly transformMaterial:
    ProtectedStenographerBackgroundTransformMaterialPort;
  readonly execution: ProtectedStenographerBackgroundExecutionPort;
  readonly now: () => number;
  readonly recipientKeyId: (
    record: BackgroundAuthorizationRecord,
  ) => string;
  readonly claimId: (record: BackgroundAuthorizationRecord) => string;
  readonly nextAttemptAt: (
    record: BackgroundAuthorizationRecord,
    reason:
      | "attempt_expired"
      | "provider_transient_failure"
      | "recipient_lost"
      | "claim_expired"
      | "publication_pending",
    now: number,
  ) => number;
}

function processorRecord(
  record: BackgroundAuthorizationRecord,
): boolean {
  return record.snapshot.credentialSubject.kind === "processor"
    && record.snapshot.credentialSubject.processorKind === "stenographer"
    && record.workKind.startsWith("stenographer.");
}

function hasProcessLocalRecipient(
  recipients: ProcessorTransformRecipientRegistry,
  record: BackgroundAuthorizationRecord,
): boolean {
  const recipient = record.snapshot.recipient;
  return recipient !== null
    && recipients.hasAttempt({
      requestId: record.snapshot.requestId,
      recipientGeneration: record.snapshot.recipientGeneration,
      recipientKeyId: recipient.recipientKeyId,
    });
}

function terminalRecord(
  record: BackgroundAuthorizationRecord,
  snapshot: BackgroundAuthorizationRecord["snapshot"],
  now: number,
): BackgroundAuthorizationRecord {
  return Object.freeze({ ...record, snapshot, finishedAt: now });
}

function wipeDecodedResponse(
  response: ReturnType<typeof decodeBackgroundAuthorizationResponseV1>,
): void {
  response.workDescriptorHash.fill(0);
  response.recipientPublicKey.fill(0);
  response.credentialBytes.fill(0);
  response.credentialHash.fill(0);
  response.issuerSigningPublicKeyHash.fill(0);
  response.signature.fill(0);
}

function wipeOwnedBytes(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    wipeOwnedBytes(Reflect.get(value, key), seen);
  }
}

/**
 * Dormant Wave-10 coordinator. It contains no transport, scheduler, ambient
 * configuration, or product registration; callers must inject every durable,
 * cryptographic, timing, and execution boundary explicitly.
 */
export class ProtectedStenographerBackgroundCoordinator {
  constructor(
    private readonly options:
      ProtectedStenographerBackgroundCoordinatorOptions,
  ) {}

  async prepareRecipient(
    requestId: string,
  ): Promise<ProtectedStenographerBackgroundPrepareResult> {
    return prepareProcessorRecipient(requestId, {
      repository: this.options.repository,
      recipients: this.options.recipients,
      descriptors: this.options.descriptors,
      now: this.options.now,
      recipientKeyId: this.options.recipientKeyId,
      ...(this.options.authorizationRequested === undefined
        ? {}
        : { authorizationRequested: this.options.authorizationRequested }),
      retryExpired: async (record) => {
        const result = await this.retry(record, "attempt_expired");
        if (result.status === "retry_scheduled") {
          return Object.freeze({ status: "retry_scheduled" as const });
        }
        if (result.status === "stale") {
          return Object.freeze({ status: "stale" as const });
        }
        if (
          result.status === "terminal"
          && result.reason === "retry_limit_exhausted"
        ) {
          return Object.freeze({
            status: "terminal" as const,
            reason: "retry_limit_exhausted" as const,
          });
        }
        throw new TypeError("unexpected expired-recipient retry result");
      },
    });
  }

  async acceptDeviceResponse(input: Readonly<{
    readonly requestId: string;
    readonly responseBytes: Uint8Array;
    readonly signerAuthorizationBytes: Uint8Array;
  }>): Promise<ProtectedStenographerBackgroundAcceptResult> {
    const current = await this.options.repository.get(input.requestId);
    if (
      current === null
      || this.options.responses === undefined
      || !processorRecord(current)
      || current.snapshot.state !== "awaiting_device"
    ) {
      return Object.freeze({ status: "lost" as const });
    }
    const now = this.options.now();
    const responseBytes = input.responseBytes.slice();
    const signerAuthorizationBytes =
      input.signerAuthorizationBytes.slice();
    let verified:
      VerifiedProcessorBackgroundAuthorizationDeviceResponse | undefined;
    try {
      verified = await this.options.responses.verify({
        record: current,
        responseBytes,
        signerAuthorizationBytes,
        now,
      });
      const accepted = await this.options.repository.acceptVerifiedResponse({
        response: verified,
        acceptedAt: now,
      });
      return Object.freeze({ status: accepted.status });
    } finally {
      wipeOwnedBytes(verified);
      responseBytes.fill(0);
      signerAuthorizationBytes.fill(0);
    }
  }

  async run(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ProtectedStenographerBackgroundRunResult> {
    let current = await this.options.repository.get(requestId);
    if (current === null) return Object.freeze({ status: "missing" as const });
    if (!processorRecord(current)) {
      return Object.freeze({ status: "stale" as const });
    }
    const now = this.options.now();
    if (current.snapshot.state === "grant_ready") {
      if (!hasProcessLocalRecipient(this.options.recipients, current)) {
        if (current.snapshot.recipient !== null
          && now < current.snapshot.recipient.expiresAt) {
          return Object.freeze({ status: "not_ready" as const });
        }
        return this.retry(current, "recipient_lost");
      }
      const claimed = await this.options.repository.compareAndSwap({
        expectedRequestRevision: current.snapshot.requestRevision,
        next: {
          ...current,
          snapshot: claimBackgroundAuthorizationRequest(
            current.snapshot,
            this.options.claimId(current),
            now,
            Math.min(now + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
              current.snapshot.recipient!.expiresAt),
          ),
        },
      });
      if (claimed.status !== "updated") {
        return Object.freeze({ status: "stale" as const });
      }
      current = claimed.record;
    }
    if (current.snapshot.state === "claimed") {
      if (
        current.snapshot.claimExpiresAt === null
        || this.options.now() >= current.snapshot.claimExpiresAt
      ) {
        return this.retry(current, "claim_expired");
      }
    }
    if (
      current.snapshot.state === "publication_reconciliation"
    ) {
      if (
        current.snapshot.nextAttemptAt !== null
        && this.options.now() < current.snapshot.nextAttemptAt
      ) {
        return Object.freeze({ status: "not_ready" as const });
      }
      return this.reconcile(current);
    }
    if (current.snapshot.state === "running") {
      if (
        current.snapshot.claimExpiresAt === null
        || this.options.now() >= current.snapshot.claimExpiresAt
      ) {
        const reconciled = await this.resolveRunningPublication(current);
        if (reconciled !== null) return reconciled;
        return this.retry(current, "claim_expired");
      }
    }
    if (
      (
        current.snapshot.state !== "claimed"
        && current.snapshot.state !== "running"
      )
      || current.snapshot.recipient === null
      || current.acceptedMaterial === null
      || current.snapshot.claimId === null
      || current.snapshot.claimExpiresAt === null
    ) {
      return Object.freeze({ status: "not_ready" as const });
    }
    const runStartedAt = this.options.now();
    if (runStartedAt >= current.snapshot.claimExpiresAt) {
      return this.retry(current, "claim_expired");
    }
    // A publish closure can have been prepared before another server claimed
    // the grant. Preserve that live claim too; only its expiry allows recovery.
    if (!hasProcessLocalRecipient(this.options.recipients, current)) {
      return Object.freeze({ status: "not_ready" as const });
    }
    const loaded =
      await this.options.transformMaterial.loadAccepted(current);
    if (loaded.status === "integrity_failure") {
      return this.terminal(current, "integrity_failure");
    }
    const material = loaded.material;
    const response = material.formatVersion === 2 ? null : decodeBackgroundAuthorizationResponseV1(
      current.acceptedMaterial.responseBytes,
    );
    let execution:
      | ProtectedStenographerExtractionResult
      | ProtectedStenographerCompactionResult
      | undefined;
    let executionRecord: BackgroundAuthorizationRecord | undefined;
    try {
      const common = {
        requestId,
        recipientGeneration: current.snapshot.recipientGeneration,
        recipientKeyId: current.snapshot.recipient.recipientKeyId,
        claimId: current.snapshot.claimId,
        deadlineAt: current.snapshot.claimExpiresAt,
        claims: material.claims,
        ...(signal === undefined ? {} : {signal}),
        execute: async (capability: ProcessorTransformCapability, signal: AbortSignal) => {
          const running = await this.options.repository.get(requestId);
          const runningClaimExpiresAt =
            running?.snapshot.claimExpiresAt ?? null;
          if (
            running === null
            || running.snapshot.state !== "running"
            || running.snapshot.claimId !== current.snapshot.claimId
            || running.snapshot.recipientGeneration
              !== current.snapshot.recipientGeneration
            || running.snapshot.claimExpiresAt
              !== current.snapshot.claimExpiresAt
            || runningClaimExpiresAt === null
            || this.options.now() >= runningClaimExpiresAt
          ) {
            throw new ProcessorCredentialClaimError("claim_mismatch");
          }
          executionRecord = running;
          execution = await this.options.execution.executeWork({
            record: running,
            capability,
            signal,
          });
        },
      };
      const currentProcessorV2 = current.snapshot.formatVersion === 2
        && current.snapshot.credentialSubject.kind === "processor";
      if (currentProcessorV2 !== (material.formatVersion === 2)) {
        throw new ProcessorCredentialClaimError("claim_mismatch");
      }
      if ((current.workKind === "stenographer.publication_reconcile") !== ("binding" in material)) {
        throw new ProcessorCredentialClaimError("claim_mismatch");
      }
      if ((current.workKind === "stenographer.output_repair") !== ("repairBinding" in material)) {
        throw new ProcessorCredentialClaimError("claim_mismatch");
      }
      const {execute: executeWork, ...withoutModel} = common;
      const result = "repairBinding" in material
        ? await this.options.recipients.runCurrentOutputRepair({...withoutModel,
          repairBinding: material.repairBinding, responseBytes: current.acceptedMaterial.responseBytes,
          resolveCurrentIssuer: material.resolveCurrentIssuer, objects: material.objects})
        : "binding" in material
        ? await this.options.recipients.runCurrentReconciliation({...withoutModel,
          binding: material.binding, responseBytes: current.acceptedMaterial.responseBytes,
          resolveCurrentIssuer: material.resolveCurrentIssuer, objects: material.objects})
        : material.formatVersion === 2
        ? await this.options.recipients.runCurrent({...withoutModel, execute: executeWork,
          responseBytes: current.acceptedMaterial.responseBytes,
          resolveCurrentIssuer: material.resolveCurrentIssuer, objects: material.objects})
        : await this.options.recipients.run({...withoutModel, execute: executeWork,
          credentialBytes: response!.credentialBytes, signerAuthorizationBytes: material.signerAuthorizationBytes,
          resolveCurrentIssuerPublicKey: material.resolveCurrentIssuerPublicKey,
          resolveHistoricalNamespaceCommitter: material.resolveHistoricalNamespaceCommitter,
          resolveCurrentSignerIssuingDevicePublicKey: material.resolveCurrentSignerIssuingDevicePublicKey,
          objects: material.objects});
      if (result.status === "unavailable") {
        if (result.reason === "credential_replayed") {
          const replayed = await this.options.repository.get(requestId);
          return replayed === null || !processorRecord(replayed)
            ? Object.freeze({ status: "stale" as const })
            : this.resolveCredentialReplay(replayed);
        }
        return this.retry(current, "recipient_lost");
      }
      if ("binding" in material || "repairBinding" in material) {
        const running = await this.options.repository.get(requestId);
        if (running === null || running.snapshot.state !== "running"
          || running.snapshot.claimId !== current.snapshot.claimId) throw new ProcessorCredentialClaimError("claim_mismatch");
        return this.complete(running);
      }
      if (execution === undefined || executionRecord === undefined) {
        throw new Error(
          "protected Stenographer transform did not execute its worker",
        );
      }
      if (execution.status === "completed") {
        return this.complete(executionRecord);
      }
      if (execution.status === "reconciliation_pending") {
        return this.enterReconciliation(executionRecord);
      }
      return this.finishRejectedExecution(executionRecord, execution);
    } catch (cause) {
      if (cause instanceof ProcessorReconciliationIntegrityErrorV2 || cause instanceof ProcessorOutputRepairIntegrityErrorV2) throw cause;
      const corruptStoredEvidence = cause instanceof ClassifiedDataOperationError && cause.failureClass === "integrity";
      if (corruptStoredEvidence && (current.workKind === "stenographer.publication_reconcile" || current.workKind === "stenographer.output_repair")) throw cause;
      const latest = await this.options.repository.get(requestId);
      if (latest === null || !processorRecord(latest)) {
        return Object.freeze({ status: "stale" as const });
      }
      if (corruptStoredEvidence || cause instanceof ProcessorCredentialClaimError) {
        return this.terminal(latest, "integrity_failure");
      }
      if (
        latest.snapshot.state === "running"
        && (
          latest.snapshot.claimExpiresAt === null
          || this.options.now() >= latest.snapshot.claimExpiresAt
        )
      ) {
        const reconciled = await this.resolveRunningPublication(latest);
        if (reconciled !== null) return reconciled;
      }
      if (
        latest.snapshot.claimExpiresAt !== null
        && this.options.now() >= latest.snapshot.claimExpiresAt
      ) {
        return this.retry(latest, "claim_expired");
      }
      throw cause;
    } finally {
      if (response !== null) wipeDecodedResponse(response);
      if (material.formatVersion !== 2) material.signerAuthorizationBytes.fill(0);
    }
  }

  private finishRejectedExecution(
    current: BackgroundAuthorizationRecord,
    execution: Extract<
      | ProtectedStenographerExtractionResult
      | ProtectedStenographerCompactionResult,
      Readonly<{ readonly status: "rejected" }>
    >,
  ): Promise<ProtectedStenographerBackgroundRunResult> {
    if (execution.reason === "provider_failure") {
      return this.retry(current, "provider_transient_failure");
    }
    if (execution.reason === "provider_outcome_unknown") {
      return this.terminal(current, "provider_outcome_unknown");
    }
    if (execution.reason === "stale_work") {
      return this.terminal(current, "stale_work");
    }
    return this.terminal(current, "transition_rejected");
  }

  private async complete(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedStenographerBackgroundRunResult> {
    const now = this.options.now();
    const stored = await this.options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: terminalRecord(
        current,
        completeBackgroundAuthorizationRequest(current.snapshot, now),
        now,
      ),
    });
    return Object.freeze({
      status: stored.status === "updated" ? "completed" : "stale",
    });
  }

  private async enterReconciliation(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedStenographerBackgroundRunResult> {
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
        ? "reconciliation_pending"
        : "stale",
    });
  }

  private async retry(
    current: BackgroundAuthorizationRecord,
    reason:
      | "attempt_expired"
      | "provider_transient_failure"
      | "recipient_lost"
      | "claim_expired",
  ): Promise<ProtectedStenographerBackgroundRunResult> {
    const now = this.options.now();
    try {
      const nextAttemptAt =
        this.options.nextAttemptAt(current, reason, now);
      const snapshot =
        current.snapshot.state === "publication_reconciliation"
          ? restartBackgroundAuthorizationAfterUncommittedPublication(
            current.snapshot,
            { now, nextAttemptAt },
          )
          : advanceBackgroundAuthorizationGeneration(
            current.snapshot,
            {
              reason,
              now,
              nextAttemptAt,
            },
          );
      const stored = await this.options.repository.compareAndSwap({
        expectedRequestRevision: current.snapshot.requestRevision,
        next: {
          ...current,
          snapshot,
          descriptorBytes: null,
          acceptedMaterial: null,
        },
      });
      return stored.status === "updated"
        ? Object.freeze({
          status: "retry_scheduled" as const,
          recipientGeneration: snapshot.recipientGeneration,
          reason,
        })
        : Object.freeze({ status: "stale" as const });
    } catch (cause) {
      if (
        cause instanceof BackgroundAuthorizationTransitionError
        && cause.reason === "counter_exhausted"
      ) {
        return this.terminal(current, "retry_limit_exhausted");
      }
      throw cause;
    }
  }

  private async terminal(
    current: BackgroundAuthorizationRecord,
    reason:
      | "retry_limit_exhausted"
      | "stale_work"
      | "transition_rejected"
      | "integrity_failure"
      | "provider_outcome_unknown",
  ): Promise<ProtectedStenographerBackgroundRunResult> {
    const now = this.options.now();
    const snapshot = reason === "stale_work"
      ? cancelBackgroundAuthorizationRequest(
        current.snapshot,
        "superseded",
        now,
      )
      : failBackgroundAuthorizationRequest(
        current.snapshot,
        reason === "retry_limit_exhausted"
          || reason === "integrity_failure"
          || reason === "provider_outcome_unknown"
          ? reason
          : "policy_rejected",
        now,
      );
    const stored = await this.options.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: terminalRecord(current, snapshot, now),
    });
    return stored.status === "updated"
      ? Object.freeze({ status: "terminal" as const, reason })
      : Object.freeze({ status: "stale" as const });
  }

  private async reconcile(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedStenographerBackgroundRunResult> {
    const reconciled =
      await this.options.execution.reconcilePublication(current);
    if (reconciled === "completed") return this.complete(current);
    if (reconciled === "stale") {
      return this.terminal(current, "stale_work");
    }
    if (reconciled === "not_started") {
      return this.retry(current, "claim_expired");
    }
    const now = this.options.now();
    try {
      const stored = await this.options.repository.compareAndSwap({
        expectedRequestRevision: current.snapshot.requestRevision,
        next: {
          ...current,
          snapshot: scheduleBackgroundAuthorizationPublicationRetry(
            current.snapshot,
            {
              now,
              nextAttemptAt:
                this.options.nextAttemptAt(
                  current,
                  "publication_pending",
                  now,
                ),
            },
          ),
        },
      });
      return Object.freeze({
        status: stored.status === "updated"
          ? "reconciliation_pending"
          : "stale",
      });
    } catch (cause) {
      if (
        cause instanceof BackgroundAuthorizationTransitionError
        && cause.reason === "counter_exhausted"
      ) {
        return this.terminal(current, "retry_limit_exhausted");
      }
      throw cause;
    }
  }

  private async resolveCredentialReplay(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedStenographerBackgroundRunResult> {
    if (
      current.snapshot.state === "running"
      && current.snapshot.claimExpiresAt !== null
      && this.options.now() < current.snapshot.claimExpiresAt
    ) {
      return Object.freeze({ status: "not_ready" as const });
    }
    const resolved = await this.resolveRunningPublication(current);
    if (resolved === null) {
      return this.retry(current, "recipient_lost");
    }
    return resolved;
  }

  private async resolveRunningPublication(
    current: BackgroundAuthorizationRecord,
  ): Promise<ProtectedStenographerBackgroundRunResult | null> {
    const reconciled =
      await this.options.execution.reconcilePublication(current);
    const latest =
      await this.options.repository.get(current.snapshot.requestId);
    if (latest === null || !processorRecord(latest)) {
      return Object.freeze({ status: "stale" as const });
    }
    if (reconciled === "completed") return this.complete(latest);
    if (reconciled === "stale") {
      return this.terminal(latest, "stale_work");
    }
    if (reconciled === "pending") {
      return latest.snapshot.state === "publication_reconciliation"
        ? Object.freeze({ status: "reconciliation_pending" as const })
        : this.enterReconciliation(latest);
    }
    if (
      reconciled === "not_started"
      && latest.snapshot.state === "publication_reconciliation"
    ) {
      return this.retry(latest, "claim_expired");
    }
    return null;
  }
}
