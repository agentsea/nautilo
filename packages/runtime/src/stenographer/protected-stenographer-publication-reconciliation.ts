import { createHash } from "node:crypto";
import { decodeBackgroundProcessorWorkDescriptorV2 } from "@nautilo/lattice-crypto/background";
import type {
  ProcessorTransformCommitVerifierPort,
  ProtectedJournalProcessorObjectVerifierPort,
  VerifiedProcessorTransformCommit,
  VerifiedProtectedJournalProcessorObject,
} from "@nautilo/lattice-bridge/server";

import type {
  BackgroundAuthorizationRepository,
  BackgroundAuthorizationRecord,
} from "../protected-execution/background-authorization/repository";
import {
  markBackgroundAuthorizationPublicationReconciliation,
} from "../protected-execution/background-authorization/lifecycle";
import {
  protectedJournalPublicationPlanMetadata,
} from "./protected-journal-output-planner";
import {
  type PostgresProtectedJournalPublicationRepository,
  type ProtectedJournalPublicationRecord,
} from "./protected-publication-repository";
import type {
  ProtectedStenographerBackgroundExecutionPort,
} from "./protected-stenographer-background-coordinator";
import {
  recoverProtectedStenographerExecutionWork,
  type ProtectedStenographerCryptoAuthority,
  type CurrentProtectedStenographerAuthority,
  type ProtectedStenographerDurableWorkRecoveryPort,
  type ProtectedStenographerRecoveredExecutionWork,
} from "./protected-stenographer-work-composition";

export type ProtectedStenographerPublicationReconciliationRepository = Pick<
  PostgresProtectedJournalPublicationRepository,
  | "get"
  | "listReconciliation"
  | "claim"
  | "markCryptoCommitted"
  | "attach"
  | "fail"
  | "abandonReserved"
  | "requestTombstone"
>;

type ReconciliationOutcome =
  Awaited<
    ReturnType<
      ProtectedStenographerBackgroundExecutionPort["reconcilePublication"]
    >
  >;

export interface ProtectedStenographerPublicationReconciler {
  readonly listPending: (input: Readonly<{
    readonly limit: number;
  }>) => Promise<readonly ProtectedJournalPublicationRecord[]>;
  readonly reconcilePublication:
    ProtectedStenographerBackgroundExecutionPort["reconcilePublication"];
}

export type ProtectedStenographerTransformCommitProof =
  VerifiedProcessorTransformCommit;

export type ProtectedStenographerTransformCommitVerifierPort =
  ProcessorTransformCommitVerifierPort;

export interface ProtectedStenographerPublicationFencePort {
  /**
   * Proves that the old crypto publisher can no longer race. The concrete
   * implementation must CAS an expired running request to
   * publication_reconciliation (or lock/prove it already fenced) through the
   * same durable authorization row locked by crypto publication.
   */
  readonly fence: (input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly now: Date;
  }>) => Promise<"fenced" | "pending" | "not_started">;
}

interface ReconciliationOptions {
  readonly reconcileCurrent?: (record: BackgroundAuthorizationRecord) => Promise<ReconciliationOutcome>;
  readonly repository:
    ProtectedStenographerPublicationReconciliationRepository;
  readonly recoverWork: (
    record: BackgroundAuthorizationRecord,
    now: Date,
  ) => Promise<ProtectedStenographerRecoveredExecutionWork>;
  readonly resolveCurrentAuthority: (
    record: BackgroundAuthorizationRecord,
  ) => Promise<ProtectedStenographerCryptoAuthority | CurrentProtectedStenographerAuthority | null>;
  readonly committedTransforms:
    ProtectedStenographerTransformCommitVerifierPort;
  readonly publicationFence: ProtectedStenographerPublicationFencePort;
  readonly verifiedObjects: ProtectedJournalProcessorObjectVerifierPort;
  readonly now: () => Date;
  readonly leaseToken: (
    record: BackgroundAuthorizationRecord,
  ) => string;
}

const TERMINAL_STATES = new Set<
  ProtectedJournalPublicationRecord["state"]
>([
  "quarantined",
  "superseded",
  "tombstone_pending",
  "tombstoned",
]);

function currentTime(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(
      "protected Stenographer publication reconciliation clock is invalid",
    );
  }
  return new Date(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function authorityMatches(
  record: BackgroundAuthorizationRecord,
  authority: ProtectedStenographerCryptoAuthority | CurrentProtectedStenographerAuthority,
): boolean {
  if (record.snapshot.formatVersion === 2
    && record.snapshot.credentialSubject.kind === "processor") {
    if (!("namespace" in authority) || record.descriptorBytes === null) return false;
    const descriptor = decodeBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);
    try {
      return authority.policyRevision === record.expectedPolicyRevision
        && descriptor.policyRevision === authority.policyRevision
        && Object.entries(descriptor.authority).every(([field, expected]) => {
          const actual = authority.namespace[field as keyof typeof authority.namespace];
          return expected instanceof Uint8Array
            ? actual instanceof Uint8Array && equalBytes(expected, actual)
            : actual === expected;
        });
    } finally {
      descriptor.authority.namespaceHeadDigest.fill(0);
      descriptor.authority.domainHeadDigest.fill(0);
      descriptor.authority.bundleDigest.fill(0);
      descriptor.source.fingerprint.fill(0);
      descriptor.recipientPublicKey.fill(0);
    }
  }
  if ("namespace" in authority) return false;
  return authority.domainId === record.domainId
    && authority.processorAuthorizationRevision
      === record.processorAuthorizationRevision
    && authority.expectedDomainEpoch === record.expectedDomainEpoch
    && authority.expectedNamespaceAccessRevision
      === record.expectedNamespaceAccessRevision
    && authority.expectedPolicyRevision === record.expectedPolicyRevision;
}

export function receiptMatches(
  record: BackgroundAuthorizationRecord,
  receipt: ProtectedJournalPublicationRecord,
): boolean {
  const planHash = Uint8Array.from(
    createHash("sha256").update(receipt.attachmentPlanBytes).digest(),
  );
  try {
    return receipt.publicationId === record.snapshot.requestId
      && receipt.requestId === record.snapshot.requestId
      && receipt.workId === record.snapshot.workId
      && receipt.namespaceIdAtAllocation === record.snapshot.namespaceId
      && equalBytes(receipt.workIdentityHash, record.workIdentityHash)
      && receipt.descriptorHash.length === 32
      && record.snapshot.descriptorDigest
        === Buffer.from(receipt.descriptorHash).toString("hex")
      && equalBytes(planHash, receipt.attachmentPlanHash);
  } finally {
    planHash.fill(0);
  }
}

export function expectedOutputObjectIds(
  receipt: ProtectedJournalPublicationRecord,
): readonly string[] {
  const ids = protectedJournalPublicationPlanMetadata(receipt.attachmentPlanBytes).outputObjectIds;
  if (
    ids.length !== receipt.outputObjectCount
    || ids.length > 5
    || new Set(ids).size !== ids.length
  ) {
    throw new TypeError(
      "protected Stenographer receipt output inventory is invalid",
    );
  }
  return Object.freeze(ids);
}

export function recoveredOutputObjectIds(
  recovered: Extract<
    ProtectedStenographerRecoveredExecutionWork,
    Readonly<{ readonly status: "recovered" }>
  >,
): readonly string[] {
  return recovered.claim.kind === "extraction"
    ? Object.freeze(
      recovered.claim.outputSlots.map((slot) => slot.objectId),
    )
    : Object.freeze([recovered.claim.outputSlot.objectId]);
}

export function exactVerifiedObject(
  verified: VerifiedProtectedJournalProcessorObject,
  expected: Readonly<{
    readonly objectId: string;
    readonly outputOrdinal: number;
    readonly authorizedOutputObjectIds: readonly string[];
    readonly record: BackgroundAuthorizationRecord;
    readonly receipt: ProtectedJournalPublicationRecord;
  }>,
): boolean {
  return verified.objectId === expected.objectId
    && verified.outputOrdinal === expected.outputOrdinal
    && equalStrings(
      verified.authorizedOutputObjectIds,
      expected.authorizedOutputObjectIds,
    )
    && verified.workId === expected.record.snapshot.workId
    && verified.namespaceId === expected.record.snapshot.namespaceId
    && verified.domainId === expected.record.domainId
    && verified.rebuildGeneration === expected.receipt.rebuildGeneration
    && verified.publisherNamespaceAccessRevision
      === expected.record.expectedNamespaceAccessRevision;
}

export function exactCommitProof(
  proof: ProtectedStenographerTransformCommitProof,
  record: BackgroundAuthorizationRecord,
  receipt: ProtectedJournalPublicationRecord,
  outputObjectIds: readonly string[],
  authorizedOutputObjectIds: readonly string[],
): boolean {
  return proof.requestId === record.snapshot.requestId
    && proof.workId === record.snapshot.workId
    && proof.namespaceId === record.snapshot.namespaceId
    && equalBytes(proof.descriptorHash, receipt.descriptorHash)
    && proof.recipientGeneration === record.snapshot.recipientGeneration
    && typeof proof.claimId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(proof.claimId)
    && proof.outputObjectCount === outputObjectIds.length
    && equalStrings(proof.outputObjectIds, outputObjectIds)
    && equalStrings(
      proof.authorizedOutputObjectIds,
      authorizedOutputObjectIds,
    );
}

export function wipeVerified(
  verified: VerifiedProtectedJournalProcessorObject | null,
): void {
  verified?.payloadBytes.fill(0);
  verified?.namespaceEnvelopeBytes.fill(0);
}

export function attachmentInput(
  receipt: ProtectedJournalPublicationRecord,
  recovered: Extract<
    ProtectedStenographerRecoveredExecutionWork,
    Readonly<{ readonly status: "recovered" }>
  >,
  leaseToken: string,
  now: Date,
) {
  const claim = recovered.claim;
  return {
    publicationId: receipt.publicationId,
    leaseToken,
    sourceLeaseToken: claim.leaseToken,
    sourceBindingFingerprint: claim.sourceBindingFingerprint,
    sourceBindings: claim.bindings,
    source: claim.kind === "extraction"
      ? {
        kind: "extraction" as const,
        lane: claim.lane,
        ...(claim.rebuildTargetMessageId === undefined ? {} : {rebuildTargetMessageId: claim.rebuildTargetMessageId}),
        fromMessageIdExclusive: claim.fromMessageIdExclusive,
        throughMessageIdInclusive: claim.throughMessageIdInclusive,
        extractorVersion: claim.extractorVersion,
        coveredRangeFingerprint: claim.coveredRangeFingerprint,
      }
      : {
        kind: "compaction" as const,
        activeEventCount: claim.activeEventCount,
        selectedEventCount: claim.selectedEventCount,
        hasDeferredMiddle: claim.hasDeferredMiddle,
      },
    now,
  };
}

class Reconciler implements ProtectedStenographerPublicationReconciler {
  constructor(private readonly options: ReconciliationOptions) {}

  listPending(input: Readonly<{
    readonly limit: number;
  }>): Promise<readonly ProtectedJournalPublicationRecord[]> {
    return this.options.repository.listReconciliation({
      now: currentTime(this.options.now),
      limit: input.limit,
    });
  }

  async reconcilePublication(
    record: BackgroundAuthorizationRecord,
  ): Promise<ReconciliationOutcome> {
    if (record.snapshot.state === "running") {
      const fence = await this.options.publicationFence.fence({
        record,
        now: currentTime(this.options.now),
      });
      if (fence !== "fenced") return fence;
    }
    const initial = await this.options.repository.get(
      record.snapshot.requestId,
    );
    if (initial === null) return "not_started";
    if (record.snapshot.formatVersion === 2
      && record.snapshot.credentialSubject.kind === "processor"
      && this.options.reconcileCurrent !== undefined) return this.options.reconcileCurrent(record);
    if (initial.state === "attached") {
      return receiptMatches(record, initial) ? "completed" : "stale";
    }
    if (TERMINAL_STATES.has(initial.state)) return "stale";
    // Retained current certificates prove ciphertext publication, not that its
    // plaintext passed the one-run parity check. After losing that attempt,
    // keep its receipt pending until current output-repair authority can reopen
    // the committed result. Never attach it through the legacy signature-only
    // reconciliation path or rerun the model to manufacture another result.
    if (record.snapshot.formatVersion === 2
      && record.snapshot.credentialSubject.kind === "processor") return this.options.reconcileCurrent?.(record) ?? "pending";

    const leaseToken = this.options.leaseToken(record);
    const claim = await this.options.repository.claim({
      publicationId: initial.publicationId,
      leaseToken,
      now: currentTime(this.options.now),
    });
    if (claim.status === "missing") return "not_started";
    if (claim.status === "busy") return "pending";
    if (claim.status === "terminal" || claim.record === undefined) {
      return "stale";
    }
    let receipt = claim.record;
    if (!receiptMatches(record, receipt)) {
      return this.failIntegrity(receipt, leaseToken);
    }

    const authority = await this.options.resolveCurrentAuthority(record);
    if (authority === null || !authorityMatches(record, authority)) {
      await this.stale(receipt, leaseToken);
      return "stale";
    }
    const recovered = await this.options.recoverWork(
      record,
      currentTime(this.options.now),
    );
    if (recovered.status === "leased") return "pending";
    if (recovered.status !== "recovered") {
      await this.stale(receipt, leaseToken);
      return "stale";
    }
    if (
      recovered.work.roomId !== receipt.roomId
      || recovered.work.namespaceId !== receipt.namespaceIdAtAllocation
      || recovered.work.workId !== receipt.workId
      || recovered.work.rebuildGeneration !== receipt.rebuildGeneration
      || !equalBytes(
        recovered.work.workIdentityHash,
        receipt.workIdentityHash,
      )
      || !equalBytes(
        recovered.work.descriptorHash,
        receipt.descriptorHash,
      )
    ) {
      await this.stale(receipt, leaseToken);
      return "stale";
    }

    let outputObjectIds: readonly string[];
    try {
      outputObjectIds = expectedOutputObjectIds(receipt);
    } catch {
      return this.failIntegrity(receipt, leaseToken);
    }
    const authorizedOutputObjectIds = recoveredOutputObjectIds(recovered);
    if (
      outputObjectIds.some(
        (objectId, ordinal) =>
          authorizedOutputObjectIds[ordinal] !== objectId,
      )
    ) {
      return this.failIntegrity(receipt, leaseToken);
    }
    const controller = new AbortController();
    let commitProof: ProtectedStenographerTransformCommitProof | null = null;
    try {
      commitProof = await this.options.committedTransforms.verifyCommit({
        requestId: record.snapshot.requestId,
        workId: record.snapshot.workId,
        namespaceId: record.snapshot.namespaceId,
        descriptorHash: receipt.descriptorHash,
        recipientGeneration: record.snapshot.recipientGeneration,
        signal: controller.signal,
      });
      if (commitProof === null) {
        if (receipt.state !== "reserved") {
          return this.failIntegrity(receipt, leaseToken);
        }
        const abandoned = await this.options.repository.abandonReserved({
          publicationId: receipt.publicationId,
          leaseToken,
          descriptorHash: receipt.descriptorHash,
          now: currentTime(this.options.now),
        });
        return abandoned.status === "abandoned"
            || abandoned.status === "duplicate"
          ? "not_started"
          : "pending";
      }
      if (
        !exactCommitProof(
          commitProof,
          record,
          receipt,
          outputObjectIds,
          authorizedOutputObjectIds,
        )
      ) return this.failIntegrity(receipt, leaseToken);
      for (let ordinal = 0; ordinal < outputObjectIds.length; ordinal += 1) {
        const objectId = outputObjectIds[ordinal]!;
        let verified: VerifiedProtectedJournalProcessorObject | null = null;
        try {
          verified = await this.options.verifiedObjects.verify({
            objectId,
            signal: controller.signal,
          });
          if (verified === null) return this.failIntegrity(receipt, leaseToken);
          if (!exactVerifiedObject(verified, {
              objectId,
              outputOrdinal: ordinal,
              authorizedOutputObjectIds,
              record,
              receipt,
            })) {
            return this.failIntegrity(receipt, leaseToken);
          }
        } catch {
          return this.failIntegrity(receipt, leaseToken);
        } finally {
          wipeVerified(verified);
        }
      }
    } finally {
      commitProof?.descriptorHash.fill(0);
      controller.abort();
    }

    if (receipt.state === "reserved") {
      const marked = await this.options.repository.markCryptoCommitted({
        publicationId: receipt.publicationId,
        leaseToken,
        descriptorHash: receipt.descriptorHash,
        attachmentPlanHash: receipt.attachmentPlanHash,
        outputObjectIds,
        now: currentTime(this.options.now),
      });
      if (marked.status === "missing") return "not_started";
      if (marked.status === "lease_lost") return "pending";
      if (marked.record === undefined) return "pending";
      receipt = marked.record;
    }
    if (receipt.state !== "crypto_committed") {
      return receipt.state === "attached" ? "completed" : "stale";
    }
    const attached = await this.options.repository.attach(
      attachmentInput(
        receipt,
        recovered,
        leaseToken,
        currentTime(this.options.now),
      ),
    );
    if (attached.status === "attached" || attached.status === "duplicate") {
      return "completed";
    }
    if (
      attached.status === "stale_reconcile"
      || attached.status === "quarantined"
      || attached.status === "terminal"
    ) return "stale";
    return attached.status === "missing" ? "not_started" : "pending";
  }

  private async failIntegrity(
    receipt: ProtectedJournalPublicationRecord,
    leaseToken: string,
  ): Promise<ReconciliationOutcome> {
    const failed = await this.options.repository.fail({
      publicationId: receipt.publicationId,
      leaseToken,
      failureCode: "integrity_failure",
      now: currentTime(this.options.now),
    });
    return failed.status === "terminal" ? "stale" : "pending";
  }

  private async stale(
    receipt: ProtectedJournalPublicationRecord,
    leaseToken: string,
  ): Promise<void> {
    if (receipt.state === "crypto_committed") {
      await this.options.repository.requestTombstone({
        publicationId: receipt.publicationId,
        now: currentTime(this.options.now),
      });
      return;
    }
    await this.options.repository.fail({
      publicationId: receipt.publicationId,
      leaseToken,
      failureCode: "rebuild_superseded",
      now: currentTime(this.options.now),
    });
  }
}

/**
 * Low-level dormant composition. It is intentionally injected and has no
 * scheduler, route, feature flag, or startup registration.
 */
export function createProtectedStenographerPublicationReconciler(
  options: ReconciliationOptions,
): ProtectedStenographerPublicationReconciler {
  return Object.freeze(new Reconciler(options));
}

export function createProtectedStenographerPublicationFence(
  repository: Pick<
    BackgroundAuthorizationRepository,
    "compareAndSwap" | "get"
  >,
): ProtectedStenographerPublicationFencePort {
  return Object.freeze({
    fence: async (
      { record, now }: Parameters<
        ProtectedStenographerPublicationFencePort["fence"]
      >[0],
    ) => {
      if (record.snapshot.state === "publication_reconciliation") {
        return "fenced";
      }
      if (
        record.snapshot.state !== "running"
        || record.snapshot.claimExpiresAt === null
        || now.getTime() < record.snapshot.claimExpiresAt
      ) return "pending";
      const result = await repository.compareAndSwap({
        expectedRequestRevision: record.snapshot.requestRevision,
        next: {
          ...record,
          snapshot: markBackgroundAuthorizationPublicationReconciliation(
            record.snapshot,
            now.getTime(),
          ),
        },
      });
      if (result.status === "updated") return "fenced";
      const current = result.current
        ?? await repository.get(record.snapshot.requestId);
      if (
        current?.snapshot.state === "publication_reconciliation"
        || current?.snapshot.state === "completed"
      ) return "fenced";
      return current === null ? "not_started" : "pending";
    },
  });
}

/**
 * Concrete restart-safe composition over the PostgreSQL product repository
 * and the crypto-role object verifier.
 */
export function createPostgresProtectedStenographerPublicationReconciler(
  options: Readonly<{
    readonly reconcileCurrent?: (record: BackgroundAuthorizationRecord) => Promise<ReconciliationOutcome>;
    readonly repository:
      ProtectedStenographerPublicationReconciliationRepository;
    readonly recovery: ProtectedStenographerDurableWorkRecoveryPort;
    readonly resolveCurrentAuthority: (
      record: BackgroundAuthorizationRecord,
    ) => Promise<ProtectedStenographerCryptoAuthority | CurrentProtectedStenographerAuthority | null>;
    readonly committedTransforms:
      ProtectedStenographerTransformCommitVerifierPort;
    readonly publicationFence: ProtectedStenographerPublicationFencePort;
    readonly verifiedObjects: ProtectedJournalProcessorObjectVerifierPort;
    readonly now: () => Date;
    readonly leaseToken: (
      record: BackgroundAuthorizationRecord,
    ) => string;
  }>,
): ProtectedStenographerPublicationReconciler {
  return createProtectedStenographerPublicationReconciler({
    ...options,
    recoverWork: (record, now) =>
      recoverProtectedStenographerExecutionWork({
        record,
        recovery: options.recovery,
        now,
      }),
  });
}

export function createProtectedStenographerBackgroundExecutionPort(
  options: Readonly<{
    readonly executeWork:
      ProtectedStenographerBackgroundExecutionPort["executeWork"];
    readonly reconciliation: ProtectedStenographerPublicationReconciler;
  }>,
): ProtectedStenographerBackgroundExecutionPort {
  return Object.freeze({
    executeWork: options.executeWork,
    reconcilePublication: (record: BackgroundAuthorizationRecord) =>
      options.reconciliation.reconcilePublication(record),
  });
}
