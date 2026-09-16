import {
  ProtectedJournalPublicationConflictError,
  type PostgresProtectedJournalPublicationRepository,
} from "./protected-publication-repository";
import type {
  ProtectedStenographerCompactionPublicationPort,
} from "./protected-stenographer-compaction";
import type {
  ProtectedStenographerExtractionPublicationPort,
} from "./protected-stenographer-extraction";
import type {
  ProtectedStenographerCompactionWorkClaim,
  ProtectedStenographerExtractionWorkClaim,
} from "./protected-stenographer-work-repository";

type PublicationRepository = Pick<
  PostgresProtectedJournalPublicationRepository,
  "reserveCurrentSourceAndClaim" | "markCryptoCommitted" | "attach"
>;

type ReservedIdentity = Readonly<{
  publicationId: string;
  requestId: string;
  workId: string;
}>;

function currentTime(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("protected publication adapter clock is invalid");
  }
  return new Date(value);
}

function sameIdentity(
  expected: ReservedIdentity | null,
  value: ReservedIdentity,
): boolean {
  return expected !== null
    && expected.publicationId === value.publicationId
    && expected.requestId === value.requestId
    && expected.workId === value.workId;
}

function reserveFailure(error: unknown): "conflict" {
  if (error instanceof ProtectedJournalPublicationConflictError) {
    return "conflict";
  }
  throw error;
}

function attachmentResult(
  status:
    | "attached"
    | "duplicate"
    | "crypto_not_committed"
    | "lease_lost"
    | "stale_reconcile"
    | "quarantined"
    | "retry"
    | "terminal"
    | "missing",
): "attached" | "duplicate" | "reconcile" | "stale" | "conflict" {
  if (status === "attached" || status === "duplicate") return status;
  if (
    status === "crypto_not_committed"
    || status === "lease_lost"
    || status === "retry"
  ) return "reconcile";
  if (status === "missing" || status === "stale_reconcile") return "stale";
  return "conflict";
}

function commitResult(
  status: "committed" | "duplicate" | "missing" | "lease_lost",
): "marked" | "duplicate" | "lost" {
  return status === "committed"
    ? "marked"
    : status === "duplicate"
    ? "duplicate"
    : "lost";
}

export function createProtectedStenographerExtractionPublicationAdapter(
  options: Readonly<{
    readonly repository: PublicationRepository;
    readonly work: ProtectedStenographerExtractionWorkClaim;
    readonly publicationLeaseToken: string;
    readonly now: () => Date;
  }>,
): ProtectedStenographerExtractionPublicationPort {
  let reserved: ReservedIdentity | null = null;
  const port: ProtectedStenographerExtractionPublicationPort = {
    reserve: async (reservation) => {
      if (
        reservation.workId !== options.work.workId
        || reservation.roomId !== options.work.roomId
        || reservation.namespaceId !== options.work.namespaceId
        || reservation.sourceBatchId !== options.work.sourceBatchId
        || reservation.rebuildGeneration !== options.work.rebuildGeneration
      ) return "conflict";
      try {
        const result =
          await options.repository.reserveCurrentSourceAndClaim({
            publicationId: reservation.publicationId,
            requestId: reservation.requestId,
            workId: reservation.workId,
            workIdentityHash: reservation.workIdentityHash,
            descriptorHash: reservation.descriptorHash,
            attachmentPlanHash: reservation.attachmentPlanHash,
            attachmentPlanBytes: reservation.attachmentPlanBytes,
            publicationLeaseToken: options.publicationLeaseToken,
            sourceLeaseToken: options.work.leaseToken,
            sourceBindingFingerprint:
              options.work.sourceBindingFingerprint,
            sourceBindings: options.work.bindings,
            source: {
              kind: "extraction",
              lane: options.work.lane,
              ...(options.work.rebuildTargetMessageId === undefined ? {} : {rebuildTargetMessageId: options.work.rebuildTargetMessageId}),
              fromMessageIdExclusive:
                options.work.fromMessageIdExclusive,
              throughMessageIdInclusive:
                options.work.throughMessageIdInclusive,
              extractorVersion: options.work.extractorVersion,
              coveredRangeFingerprint:
                options.work.coveredRangeFingerprint,
            },
            now: currentTime(options.now),
          });
        if (result.status === "stale" || result.status === "busy") {
          return "stale";
        }
        reserved = Object.freeze({
          publicationId: reservation.publicationId,
          requestId: reservation.requestId,
          workId: reservation.workId,
        });
        return result.status === "existing" ? "duplicate" : "reserved";
      } catch (error) {
        return reserveFailure(error);
      }
    },
    markCryptoCommitted: async (commit) => {
      if (!sameIdentity(reserved, commit)) return "conflict";
      const result = await options.repository.markCryptoCommitted({
        publicationId: commit.publicationId,
        leaseToken: options.publicationLeaseToken,
        descriptorHash: commit.descriptorHash,
        attachmentPlanHash: commit.attachmentPlanHash,
        outputObjectIds: commit.outputObjectIds,
        now: currentTime(options.now),
      });
      return commitResult(result.status);
    },
    attach: async (attachment) => {
      if (
        !sameIdentity(reserved, attachment)
        || attachment.roomId !== options.work.roomId
        || attachment.namespaceId !== options.work.namespaceId
        || attachment.sourceBatchId !== options.work.sourceBatchId
        || attachment.rebuildGeneration !== options.work.rebuildGeneration
      ) return "conflict";
      const result = await options.repository.attach({
        publicationId: attachment.publicationId,
        leaseToken: options.publicationLeaseToken,
        sourceLeaseToken: options.work.leaseToken,
        sourceBindingFingerprint:
          options.work.sourceBindingFingerprint,
        sourceBindings: options.work.bindings,
        source: {
          kind: "extraction",
          lane: options.work.lane,
              ...(options.work.rebuildTargetMessageId === undefined ? {} : {rebuildTargetMessageId: options.work.rebuildTargetMessageId}),
          fromMessageIdExclusive:
            options.work.fromMessageIdExclusive,
          throughMessageIdInclusive:
            options.work.throughMessageIdInclusive,
          extractorVersion: options.work.extractorVersion,
          coveredRangeFingerprint:
            options.work.coveredRangeFingerprint,
        },
        now: currentTime(options.now),
      });
      return attachmentResult(result.status);
    },
  };
  return Object.freeze(port);
}

export function createProtectedStenographerCompactionPublicationAdapter(
  options: Readonly<{
    readonly repository: PublicationRepository;
    readonly work: ProtectedStenographerCompactionWorkClaim;
    readonly publicationLeaseToken: string;
    readonly now: () => Date;
  }>,
): ProtectedStenographerCompactionPublicationPort {
  let reserved: ReservedIdentity | null = null;
  const port: ProtectedStenographerCompactionPublicationPort = {
    reserve: async (reservation) => {
      if (
        reservation.workId !== options.work.workId
        || reservation.roomId !== options.work.roomId
        || reservation.namespaceId !== options.work.namespaceId
        || reservation.sourceBatchId !== null
        || reservation.rebuildGeneration !== options.work.rebuildGeneration
      ) return "conflict";
      try {
        const result =
          await options.repository.reserveCurrentSourceAndClaim({
            publicationId: reservation.publicationId,
            requestId: reservation.requestId,
            workId: reservation.workId,
            workIdentityHash: reservation.workIdentityHash,
            descriptorHash: reservation.descriptorHash,
            attachmentPlanHash: reservation.attachmentPlanHash,
            attachmentPlanBytes: reservation.attachmentPlanBytes,
            publicationLeaseToken: options.publicationLeaseToken,
            sourceLeaseToken: options.work.leaseToken,
            sourceBindingFingerprint:
              options.work.sourceBindingFingerprint,
            sourceBindings: options.work.bindings,
            source: {
              kind: "compaction",
              activeEventCount: options.work.activeEventCount,
              selectedEventCount: options.work.selectedEventCount,
              hasDeferredMiddle: options.work.hasDeferredMiddle,
            },
            now: currentTime(options.now),
          });
        if (result.status === "stale" || result.status === "busy") {
          return "stale";
        }
        reserved = Object.freeze({
          publicationId: reservation.publicationId,
          requestId: reservation.requestId,
          workId: reservation.workId,
        });
        return result.status === "existing" ? "duplicate" : "reserved";
      } catch (error) {
        return reserveFailure(error);
      }
    },
    markCryptoCommitted: async (commit) => {
      if (!sameIdentity(reserved, commit)) return "conflict";
      const result = await options.repository.markCryptoCommitted({
        publicationId: commit.publicationId,
        leaseToken: options.publicationLeaseToken,
        descriptorHash: commit.descriptorHash,
        attachmentPlanHash: commit.attachmentPlanHash,
        outputObjectIds: commit.outputObjectIds,
        now: currentTime(options.now),
      });
      return commitResult(result.status);
    },
    attach: async (attachment) => {
      if (
        !sameIdentity(reserved, attachment)
        || attachment.roomId !== options.work.roomId
        || attachment.namespaceId !== options.work.namespaceId
        || attachment.rebuildGeneration !== options.work.rebuildGeneration
      ) return "conflict";
      const result = await options.repository.attach({
        publicationId: attachment.publicationId,
        leaseToken: options.publicationLeaseToken,
        sourceLeaseToken: options.work.leaseToken,
        sourceBindingFingerprint:
          options.work.sourceBindingFingerprint,
        sourceBindings: options.work.bindings,
        source: {
          kind: "compaction",
          activeEventCount: options.work.activeEventCount,
          selectedEventCount: options.work.selectedEventCount,
          hasDeferredMiddle: options.work.hasDeferredMiddle,
        },
        now: currentTime(options.now),
      });
      return attachmentResult(result.status);
    },
  };
  return Object.freeze(port);
}
