import {
  protectedJournalPublicationPlanMetadata,
} from "./protected-journal-output-planner";

export const PROTECTED_JOURNAL_REBUILD_COORDINATOR_MAX_PUBLICATIONS = 256;

type RebuildPreparationResult = Readonly<{
  readonly status:
    | "missing"
    | "stale"
    | "cleanup_pending"
    | "ready_to_finalize";
  readonly publicationIdsNeedingTombstone?: readonly string[];
  readonly hasMoreInvalidationWork?: boolean;
}>;

type RebuildFinalizationResult = Readonly<{
  readonly status:
    | "missing"
    | "stale"
    | "cleanup_pending"
    | "prepared"
    | "completed";
  readonly startCursor?: number;
  readonly targetCursor?: number;
}>;

type PublicationClaimResult = Readonly<{
  readonly status: "claimed" | "missing" | "busy" | "terminal";
  readonly record?: Readonly<{
    readonly state: string;
    readonly attachmentPlanBytes: Uint8Array;
    readonly outputObjectCount: number;
  }>;
}>;

type PublicationCompletionResult = Readonly<{
  readonly status:
    | "tombstoned"
    | "duplicate"
    | "missing"
    | "lease_lost"
    | "unavailable";
}>;

type PublicationFailureResult = Readonly<{
  readonly status: "retry" | "terminal" | "missing" | "lease_lost";
}>;

export interface ProtectedJournalRebuildCoordinatorPorts {
  readonly rebuilds: Readonly<{
    readonly prepare: (input: Readonly<{
      readonly roomId: string;
      readonly rebuildGeneration: number;
      readonly now: Date;
    }>) => Promise<RebuildPreparationResult>;
    readonly finalize: (input: Readonly<{
      readonly roomId: string;
      readonly rebuildGeneration: number;
      readonly now: Date;
    }>) => Promise<RebuildFinalizationResult>;
  }>;
  readonly publications: Readonly<{
    readonly claim: (input: Readonly<{
      readonly publicationId: string;
      readonly leaseToken: string;
      readonly now: Date;
    }>) => Promise<PublicationClaimResult>;
    readonly markTombstoned: (input: Readonly<{
      readonly publicationId: string;
      readonly leaseToken: string;
      readonly now: Date;
    }>) => Promise<PublicationCompletionResult>;
    readonly fail: (input: Readonly<{
      readonly publicationId: string;
      readonly leaseToken: string;
      readonly failureCode: "tombstone_failed";
      readonly now: Date;
    }>) => Promise<PublicationFailureResult>;
  }>;
  readonly crypto: Readonly<{
    readonly tombstoneObjects: (input: Readonly<{
      readonly objectIds: readonly string[];
      readonly signal: AbortSignal;
    }>) => Promise<Readonly<{
      readonly status: "tombstoned";
      readonly advancedCount: number;
      readonly alreadyTombstonedCount: number;
    }>>;
  }>;
  readonly now: () => Date;
  readonly leaseToken: (publicationId: string) => string;
}

export type ProtectedJournalRebuildCoordinatorResult =
  | Readonly<{ readonly status: "missing" | "stale" }>
  | Readonly<{
    readonly status: "cleanup_progress";
    readonly processedPublications: number;
    readonly hasMoreInvalidationWork: boolean;
  }>
  | Readonly<{
    readonly status: "prepared" | "completed";
    readonly startCursor: number;
    readonly targetCursor: number;
  }>
  | Readonly<{
    readonly status: "retry";
    readonly reason:
      | "publication_busy"
      | "crypto_tombstone_failed"
      | "product_acknowledgement_lost";
  }>
  | Readonly<{
    readonly status: "terminal";
    readonly reason: "publication_cleanup_exhausted";
  }>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function outputObjectIds(bytes: Uint8Array): readonly string[] {
  return protectedJournalPublicationPlanMetadata(bytes).outputObjectIds;
}

function currentTime(
  ports: ProtectedJournalRebuildCoordinatorPorts,
): Date {
  const now = ports.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("protected journal rebuild clock is invalid");
  }
  return new Date(now);
}

/**
 * Executes at most one bounded cleanup page. Crypto access is tombstoned
 * before the product receipt is acknowledged; replay after either commit is
 * therefore safe and cannot resurrect the old journal projection.
 */
export async function coordinateProtectedJournalRebuild(input: Readonly<{
  readonly roomId: string;
  readonly rebuildGeneration: number;
  readonly ports: ProtectedJournalRebuildCoordinatorPorts;
}>): Promise<ProtectedJournalRebuildCoordinatorResult> {
  if (
    !UUID.test(input.roomId)
    || !Number.isSafeInteger(input.rebuildGeneration)
    || input.rebuildGeneration < 1
  ) {
    throw new TypeError("protected journal rebuild coordinates are invalid");
  }
  const now = currentTime(input.ports);
  const coordinates = Object.freeze({
    roomId: input.roomId,
    rebuildGeneration: input.rebuildGeneration,
    now: new Date(now),
  });
  const prepared = await input.ports.rebuilds.prepare(coordinates);
  if (prepared.status === "missing" || prepared.status === "stale") {
    return Object.freeze({ status: prepared.status });
  }
  if (prepared.status === "ready_to_finalize") {
    const finalized = await input.ports.rebuilds.finalize({
      ...coordinates,
      now: currentTime(input.ports),
    });
    if (
      finalized.status === "missing"
      || finalized.status === "stale"
    ) {
      return Object.freeze({ status: finalized.status });
    }
    if (finalized.status === "cleanup_pending") {
      return Object.freeze({
        status: "retry",
        reason: "publication_busy",
      });
    }
    if (
      !Number.isSafeInteger(finalized.startCursor)
      || !Number.isSafeInteger(finalized.targetCursor)
    ) {
      throw new Error(
        "protected journal rebuild finalization bounds are invalid",
      );
    }
    return Object.freeze({
      status: finalized.status,
      startCursor: finalized.startCursor!,
      targetCursor: finalized.targetCursor!,
    });
  }
  const rawPublicationIds: unknown =
    prepared.publicationIdsNeedingTombstone;
  if (
    !Array.isArray(rawPublicationIds)
    || rawPublicationIds.length
      > PROTECTED_JOURNAL_REBUILD_COORDINATOR_MAX_PUBLICATIONS
    || typeof prepared.hasMoreInvalidationWork !== "boolean"
  ) {
    throw new RangeError(
      "protected journal rebuild cleanup page is out of bounds",
    );
  }
  const publicationIds = rawPublicationIds.map((value: unknown) => {
    if (typeof value !== "string") {
      throw new TypeError(
        "protected journal rebuild publication id must be text",
      );
    }
    return value;
  });

  let processedPublications = 0;
  for (const publicationId of publicationIds) {
    const leaseToken = input.ports.leaseToken(publicationId);
    const claimTime = currentTime(input.ports);
    const claimed = await input.ports.publications.claim({
      publicationId,
      leaseToken,
      now: claimTime,
    });
    if (claimed.status === "busy" || claimed.status === "missing") {
      return Object.freeze({
        status: "retry",
        reason: "publication_busy",
      });
    }
    if (claimed.status === "terminal") {
      return Object.freeze({
        status: "terminal",
        reason: "publication_cleanup_exhausted",
      });
    }
    if (
      claimed.record === undefined
      || claimed.record.state !== "tombstone_pending"
    ) {
      throw new Error(
        "protected journal rebuild claimed a non-tombstone publication",
      );
    }
    const objectIds = outputObjectIds(claimed.record.attachmentPlanBytes);
    if (objectIds.length !== claimed.record.outputObjectCount) {
      throw new Error(
        "protected journal rebuild receipt output inventory conflicts",
      );
    }
    const controller = new AbortController();
    try {
      await input.ports.crypto.tombstoneObjects({
        objectIds,
        signal: controller.signal,
      });
    } catch {
      const failure = await input.ports.publications.fail({
        publicationId,
        leaseToken,
        failureCode: "tombstone_failed",
        now: currentTime(input.ports),
      });
      return failure.status === "terminal"
        ? Object.freeze({
          status: "terminal" as const,
          reason: "publication_cleanup_exhausted" as const,
        })
        : Object.freeze({
          status: "retry" as const,
          reason: "crypto_tombstone_failed" as const,
        });
    } finally {
      controller.abort();
    }
    const acknowledged = await input.ports.publications.markTombstoned({
      publicationId,
      leaseToken,
      now: currentTime(input.ports),
    });
    if (
      acknowledged.status !== "tombstoned"
      && acknowledged.status !== "duplicate"
    ) {
      return Object.freeze({
        status: "retry",
        reason: "product_acknowledgement_lost",
      });
    }
    processedPublications += 1;
  }
  return Object.freeze({
    status: "cleanup_progress",
    processedPublications,
    hasMoreInvalidationWork: prepared.hasMoreInvalidationWork,
  });
}
