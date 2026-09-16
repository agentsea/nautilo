import {
  backgroundCryptoAuthorizationRequests,
  eq,
} from "@nautilo/db";
import {
  assertPortableId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {decodeBackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {
  decodeBackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";

import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
} from "../storage/postgres-record-codecs.ts";

const HASH_BYTES = 32;
const ACCEPTED_STATES = new Set([
  "publication_reconciliation",
  "completed",
  "cancelled",
  "terminal_failure",
]);

export type VerifiedProcessorTransformCommit = Readonly<{
  readonly requestId: string;
  readonly workId: string;
  readonly namespaceId: string;
  readonly descriptorHash: Uint8Array;
  readonly recipientGeneration: number;
  readonly claimId: string;
  readonly outputObjectCount: number;
  readonly outputObjectIds: readonly string[];
  readonly authorizedOutputObjectIds: readonly string[];
}>;

export interface ProcessorTransformCommitVerifierPort {
  readonly verifyCommit: (input: Readonly<{
    readonly requestId: string;
    readonly workId: string;
    readonly namespaceId: string;
    readonly descriptorHash: Uint8Array;
    readonly recipientGeneration: number;
    readonly signal: AbortSignal;
  }>) => Promise<VerifiedProcessorTransformCommit | null>;
}

function text(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Processor transform commit ${name} must be text`);
  }
  return value;
}

function counter(row: DatabaseRow, name: string): number {
  const value = row[name];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError(
      `Processor transform commit ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function bytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Processor transform commit ${name} must be bytea`);
  }
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`Processor transform commit ${message}`);
}

export class PostgresProcessorTransformCommitVerifier
  implements ProcessorTransformCommitVerifierPort {
  readonly #handle: CryptoPostgresHandle;

  constructor(
    handle: CryptoPostgresHandle,
    private readonly crypto: LatticeCrypto,
  ) {
    assertVerifiedCryptoPostgresHandle(handle);
    this.#handle = handle;
  }

  async verifyCommit(
    input: Parameters<ProcessorTransformCommitVerifierPort["verifyCommit"]>[0],
  ): Promise<VerifiedProcessorTransformCommit | null> {
    assertPortableId("Processor transform commit request id", input.requestId);
    assertPortableId("Processor transform commit work id", input.workId);
    assertPortableId(
      "Processor transform commit Namespace id",
      input.namespaceId,
    );
    if (
      !(input.descriptorHash instanceof Uint8Array)
      || input.descriptorHash.length !== HASH_BYTES
      || !Number.isSafeInteger(input.recipientGeneration)
      || input.recipientGeneration < 0
    ) {
      throw new TypeError("Processor transform commit lookup is invalid");
    }
    input.signal.throwIfAborted();
    const rows = await executeTypedCryptoQuery(
      this.#handle,
      cryptoTypedDb.select({
        request_id: backgroundCryptoAuthorizationRequests.requestId,
        format_version: backgroundCryptoAuthorizationRequests.formatVersion,
        work_id: backgroundCryptoAuthorizationRequests.workId,
        namespace_id: backgroundCryptoAuthorizationRequests.namespaceId,
        descriptor_hash:
          backgroundCryptoAuthorizationRequests.descriptorHash,
        descriptor_bytes:
          backgroundCryptoAuthorizationRequests.descriptorBytes,
        recipient_generation:
          backgroundCryptoAuthorizationRequests.recipientGeneration,
        state: backgroundCryptoAuthorizationRequests.state,
        transform_commit_claim_id:
          backgroundCryptoAuthorizationRequests.transformCommitClaimId,
        transform_commit_descriptor_hash:
          backgroundCryptoAuthorizationRequests.transformCommitDescriptorHash,
        transform_commit_recipient_generation:
          backgroundCryptoAuthorizationRequests
            .transformCommitRecipientGeneration,
        transform_commit_output_count:
          backgroundCryptoAuthorizationRequests.transformCommitOutputCount,
        transform_committed_at:
          backgroundCryptoAuthorizationRequests.transformCommittedAt,
      }).from(backgroundCryptoAuthorizationRequests).where(eq(
        backgroundCryptoAuthorizationRequests.requestId,
        input.requestId,
      )).limit(2),
    );
    input.signal.throwIfAborted();
    if (rows.length === 0) return null;
    invariant(rows.length === 1, "lookup is ambiguous");
    const row = rows[0]!;
    const markerFields = [
      row["transform_commit_claim_id"],
      row["transform_commit_descriptor_hash"],
      row["transform_commit_recipient_generation"],
      row["transform_commit_output_count"],
      row["transform_committed_at"],
    ];
    if (markerFields.every((value) => value === null)) return null;
    invariant(
      markerFields.every((value) => value !== null),
      "marker is partial",
    );

    const descriptorBytes = bytes(row, "descriptor_bytes");
    const rowDescriptorHash = bytes(row, "descriptor_hash");
    const markerDescriptorHash = bytes(
      row,
      "transform_commit_descriptor_hash",
    );
    const calculatedDescriptorHash = this.crypto.hash(descriptorBytes);
    const formatVersion = counter(row, "format_version");
    invariant(
      formatVersion === 1 || formatVersion === 2,
      "descriptor format is unsupported",
    );
    const descriptor = formatVersion === 2
      ? decodeBackgroundProcessorWorkDescriptorV2(descriptorBytes)
      : decodeBackgroundWorkDescriptorV1(descriptorBytes);
    const namespaceId = descriptor.formatVersion === 2
      ? descriptor.anchorNamespaceId
      : descriptor.namespaceId;
    const outputObjectIds = descriptor.formatVersion === 2
      ? descriptor.outputSlots.map((slot) => slot.objectId)
      : descriptor.outputObjectIds;
    try {
      const outputObjectCount = counter(
        row,
        "transform_commit_output_count",
      );
      invariant(
        ACCEPTED_STATES.has(text(row, "state")),
        "request is not durably fenced",
      );
      invariant(
        text(row, "request_id") === input.requestId
          && descriptor.requestId === input.requestId
          && text(row, "work_id") === input.workId
          && descriptor.workId === input.workId
          && text(row, "namespace_id") === input.namespaceId
          && namespaceId === input.namespaceId,
        "coordinates were substituted",
      );
      invariant(
        sameBytes(rowDescriptorHash, input.descriptorHash)
          && sameBytes(rowDescriptorHash, markerDescriptorHash)
          && sameBytes(rowDescriptorHash, calculatedDescriptorHash),
        "descriptor evidence was substituted",
      );
      invariant(
        counter(row, "recipient_generation") === input.recipientGeneration
          && counter(row, "transform_commit_recipient_generation")
            === input.recipientGeneration
          && descriptor.recipientGeneration === input.recipientGeneration,
        "recipient generation was substituted",
      );
      invariant(
        outputObjectCount <= outputObjectIds.length,
        "output prefix exceeds its descriptor",
      );
      const claimId = text(row, "transform_commit_claim_id");
      assertPortableId("Processor transform commit claim id", claimId);
      return Object.freeze({
        requestId: input.requestId,
        workId: input.workId,
        namespaceId: input.namespaceId,
        descriptorHash: Uint8Array.from(rowDescriptorHash),
        recipientGeneration: input.recipientGeneration,
        claimId,
        outputObjectCount,
        outputObjectIds: Object.freeze(
          outputObjectIds.slice(0, outputObjectCount),
        ),
        authorizedOutputObjectIds: Object.freeze([
          ...outputObjectIds,
        ]),
      });
    } finally {
      if (descriptor.formatVersion === 2) {
        descriptor.authority.namespaceHeadDigest.fill(0);
        descriptor.authority.domainHeadDigest.fill(0);
        descriptor.authority.bundleDigest.fill(0);
      }
      descriptor.source.fingerprint.fill(0);
      descriptor.recipientPublicKey.fill(0);
      descriptorBytes.fill(0);
      rowDescriptorHash.fill(0);
      markerDescriptorHash.fill(0);
      calculatedDescriptorHash.fill(0);
    }
  }
}
