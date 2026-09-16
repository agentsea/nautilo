import type {BackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {
  assertVerifiedConversationProductPostgresHandle,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";

import type {
  BackgroundAuthorizationRecord,
} from "../protected-execution/background-authorization/repository";
import type {
  ProtectedStenographerDurableWorkRecoveryPort,
  ProtectedStenographerDurableWorkRecoveryResult,
} from "./protected-stenographer-work-composition";
import {
  PostgresProtectedStenographerWorkRepository,
  type ProtectedStenographerCompactionClaimResult,
  type ProtectedStenographerCompactionWorkClaim,
  type ProtectedStenographerExtractionClaimResult,
  type ProtectedStenographerExtractionWorkClaim,
} from "./protected-stenographer-work-repository";

export interface ProtectedStenographerRecoveryWorkRepository {
  readonly recoverExtraction: (input: Readonly<{
    readonly workId: string;
    readonly now: Date;
  }>) => Promise<ProtectedStenographerExtractionClaimResult>;
  readonly recoverCompaction: (input: Readonly<{
    readonly workId: string;
    readonly createdAt: string;
    readonly now: Date;
  }>) => Promise<ProtectedStenographerCompactionClaimResult>;
}

export interface PostgresProtectedStenographerWorkRecoveryOptions {
  readonly repository?: ProtectedStenographerRecoveryWorkRepository;
  readonly resolveCompactionModelId: (input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly claim: ProtectedStenographerCompactionWorkClaim;
  }>) => Promise<string | null>;
  readonly leaseToken?: () => string;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function sameOrderedIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function recordCoordinatesMatch(
  record: BackgroundAuthorizationRecord,
  descriptor: BackgroundWorkDescriptorV1 | BackgroundProcessorWorkDescriptorV2 | null,
): boolean {
  return descriptor === null
    || (
      descriptor.requestId === record.snapshot.requestId
      && descriptor.workId === record.snapshot.workId
      && descriptor.workKind === record.workKind
      && (descriptor.formatVersion === 2 ? descriptor.authority.namespaceId : descriptor.namespaceId) === record.snapshot.namespaceId
    );
}

function rangeFromCompaction(
  claim: ProtectedStenographerCompactionWorkClaim,
): Readonly<{ start: number; end: number }> | null {
  const sequences = claim.bindings.flatMap((binding) =>
    binding.kind === "event"
      ? [binding.binding.sequence]
      : binding.kind === "rollup"
      ? [binding.binding.throughEventSequence]
      : []
  );
  if (sequences.length === 0) return null;
  return Object.freeze({
    start: Math.min(...sequences),
    end: Math.max(...sequences),
  });
}

function extractionMatches(
  record: BackgroundAuthorizationRecord,
  descriptor: BackgroundWorkDescriptorV1 | BackgroundProcessorWorkDescriptorV2 | null,
  claim: ProtectedStenographerExtractionWorkClaim,
): boolean {
  if (
    claim.workId !== record.snapshot.workId
    || claim.namespaceId !== record.snapshot.namespaceId
    || claim.workKind !== record.workKind
    || (claim.workKind === "stenographer.rebuild" ? claim.rebuildTargetMessageId === undefined : claim.rebuildTargetMessageId !== undefined)
  ) return false;
  if (descriptor === null) return true;
  const source = descriptor.source;
  if (source.kind !== (descriptor.formatVersion === 2 ? "stenographer_work" : "journal_range")) return false;
  return source.startSequence
      === claim.fromMessageIdExclusive + 1
    && source.endSequence === claim.throughMessageIdInclusive
    && source.rebuildGeneration === claim.rebuildGeneration
    && equalBytes(
      source.fingerprint,
      claim.coveredRangeFingerprint,
    )
    && sameOrderedIds(
      descriptor.formatVersion === 2
        ? descriptor.inputBindings.map(binding => binding.objectId)
        : descriptor.inputObjectIds,
      claim.inputObjectIds,
    )
    && sameOrderedIds(
      (descriptor.formatVersion === 2 ? descriptor.outputSlots.map(slot => slot.objectId) : descriptor.outputObjectIds),
      claim.outputSlots.map((slot) => slot.objectId),
    );
}

function compactionMatches(
  record: BackgroundAuthorizationRecord,
  descriptor: BackgroundWorkDescriptorV1 | BackgroundProcessorWorkDescriptorV2 | null,
  claim: ProtectedStenographerCompactionWorkClaim,
): boolean {
  if (
    claim.workId !== record.snapshot.workId
    || claim.namespaceId !== record.snapshot.namespaceId
    || claim.workKind !== record.workKind
    || claim.createdAt !== new Date(record.snapshot.createdAt).toISOString()
  ) return false;
  if (descriptor === null) return true;
  const range = rangeFromCompaction(claim);
  const source = descriptor.source;
  if (source.kind !== (descriptor.formatVersion === 2 ? "stenographer_work" : "journal_range")) return false;
  return range !== null
    && source.startSequence === range.start
    && source.endSequence === range.end
    && source.rebuildGeneration === claim.rebuildGeneration
    && equalBytes(
      source.fingerprint,
      claim.sourceBindingFingerprint,
    )
    && sameOrderedIds(
      descriptor.formatVersion === 2
        ? descriptor.inputBindings.map(binding => binding.objectId)
        : descriptor.inputObjectIds,
      claim.inputObjectIds,
    )
    && sameOrderedIds((descriptor.formatVersion === 2 ? descriptor.outputSlots.map(slot => slot.objectId) : descriptor.outputObjectIds), [
      claim.outputSlot.objectId,
    ]);
}

function unavailable(
  result:
    | ProtectedStenographerExtractionClaimResult
    | ProtectedStenographerCompactionClaimResult,
): ProtectedStenographerDurableWorkRecoveryResult | null {
  if (result.status === "claimed") return null;
  if (result.status !== "unavailable") {
    return Object.freeze({ status: "stale" as const });
  }
  if (result.reason === "missing" || result.reason === "leased") {
    return Object.freeze({ status: result.reason });
  }
  return Object.freeze({ status: "stale" as const });
}

/**
 * Dormant direct-product-role adapter for restart-safe Stenographer work.
 * It never queries product plaintext itself; the repository is responsible
 * for serializable metadata-only replanning and exact lease recovery.
 */
export class PostgresProtectedStenographerWorkRecovery
implements ProtectedStenographerDurableWorkRecoveryPort {
  readonly #repository: ProtectedStenographerRecoveryWorkRepository;

  constructor(
    handle: ConversationProductPostgresHandle,
    private readonly options:
      PostgresProtectedStenographerWorkRecoveryOptions,
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo") {
      throw new TypeError(
        "protected Stenographer recovery requires the nautilo product role",
      );
    }
    this.#repository = options.repository
      ?? new PostgresProtectedStenographerWorkRepository(handle, {
        ...(options.leaseToken === undefined
          ? {}
          : { leaseToken: options.leaseToken }),
      });
  }

  async recoverExact(input: Readonly<{
    readonly record: BackgroundAuthorizationRecord;
    readonly descriptor: BackgroundWorkDescriptorV1 | BackgroundProcessorWorkDescriptorV2 | null;
    readonly now: Date;
  }>): Promise<ProtectedStenographerDurableWorkRecoveryResult> {
    if (!recordCoordinatesMatch(input.record, input.descriptor)) {
      return Object.freeze({ status: "stale" as const });
    }
    if (
      input.record.workKind === "stenographer.extraction"
      || input.record.workKind === "stenographer.historical"
      || input.record.workKind === "stenographer.rebuild"
    ) {
      const result = await this.#repository.recoverExtraction({
        workId: input.record.snapshot.workId,
        now: new Date(input.now),
      });
      const notRecovered = unavailable(result);
      if (notRecovered !== null) return notRecovered;
      if (
        result.status !== "claimed"
        || !extractionMatches(
          input.record,
          input.descriptor,
          result.claim,
        )
      ) return Object.freeze({ status: "stale" as const });
      return Object.freeze({
        status: "recovered" as const,
        work: Object.freeze({
          claim: result.claim,
          compactionModelId: null,
        }),
      });
    }
    if (input.record.workKind !== "stenographer.compaction") {
      return Object.freeze({ status: "stale" as const });
    }
    const result = await this.#repository.recoverCompaction({
      workId: input.record.snapshot.workId,
      createdAt: new Date(input.record.snapshot.createdAt).toISOString(),
      now: new Date(input.now),
    });
    const notRecovered = unavailable(result);
    if (notRecovered !== null) return notRecovered;
    if (
      result.status !== "claimed"
      || !compactionMatches(
        input.record,
        input.descriptor,
        result.claim,
      )
    ) return Object.freeze({ status: "stale" as const });
    const modelId = await this.options.resolveCompactionModelId({
      record: input.record,
      claim: result.claim,
    });
    if (
      typeof modelId !== "string"
      || modelId.length < 1
      || modelId.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(modelId)
    ) return Object.freeze({ status: "stale" as const });
    return Object.freeze({
      status: "recovered" as const,
      work: Object.freeze({
        claim: result.claim,
        compactionModelId: modelId,
      }),
    });
  }
}
