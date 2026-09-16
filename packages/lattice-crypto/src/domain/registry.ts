import type {
  CryptoDomainPublicRecordV2,
  CreateDomainResultV2,
} from "../storage/v2-records.ts";
import type { V2Storage } from "../storage/v2-storage-contract.ts";
import {
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  humanId,
  type CryptoDomainId,
  type HumanId,
} from "../v2-types/ids.ts";
import {
  assertV2Limit,
  V2_LIMITS,
} from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  canonicalizeParticipants,
  participantDigest,
} from "./participants.ts";

export interface FindOrCreateCryptoDomainInput {
  readonly participants: readonly HumanId[];
  readonly createDomainId: () => CryptoDomainId;
  readonly rosterBytes: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function assertExactFields(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Crypto Domain storage returned a non-object record");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== expected.length
    || fields.some((field) => !expected.includes(field))
  ) {
    throw new TypeError(
      "Crypto Domain storage returned a record with an invalid field set",
    );
  }
}

function assertMatchingDomain(
  domain: CryptoDomainPublicRecordV2,
  expectedDigest: Uint8Array,
  expectedParticipants: readonly HumanId[],
): CryptoDomainPublicRecordV2 {
  assertExactFields(domain, [
    "id",
    "participantDigest",
    "participants",
    "epoch",
    "authorizationRevision",
    "rosterBytes",
  ]);
  cryptoDomainId(domain.id);
  domainEpoch(domain.epoch);
  authorizationRevision(domain.authorizationRevision);
  if (!(domain.rosterBytes instanceof Uint8Array)) {
    throw new TypeError(
      "Crypto Domain storage returned a record with a non-byte roster",
    );
  }
  assertV2Limit(
    "Crypto Domain storage roster bytes",
    domain.rosterBytes.length,
    V2_LIMITS.ciphertextBytes,
  );
  if (
    !(domain.participantDigest instanceof Uint8Array)
    || !Array.isArray(domain.participants)
  ) {
    throw new TypeError(
      "Crypto Domain storage returned invalid participant coordinates",
    );
  }
  const canonical = canonicalizeParticipants(
    domain.participants.map(humanId),
  );
  if (
    canonical.length !== expectedParticipants.length
    || canonical.some(
      (participant, index) => participant !== expectedParticipants[index],
    )
    || domain.participants.some(
      (participant, index) => participant !== canonical[index],
    )
    || !equalBytes(domain.participantDigest, expectedDigest)
  ) {
    throw new Error(
      "Crypto Domain storage returned a record for different participants",
    );
  }
  return {
    id: domain.id,
    participantDigest: copyOwnedBytesV2(domain.participantDigest),
    participants: [...canonical],
    epoch: domain.epoch,
    authorizationRevision: domain.authorizationRevision,
    rosterBytes: copyOwnedBytesV2(domain.rosterBytes),
  };
}

/**
 * Resolve the one active Crypto Domain for an exact canonical Human set.
 *
 * The digest is only an index. The storage create-if-absent operation compares
 * exact participants within that digest bucket, so concurrent callers and a
 * digest collision cannot create an alias.
 */
export async function findOrCreateCryptoDomain(
  storage: Pick<
    V2Storage,
    "findDomain" | "createDomainIfAbsent"
  >,
  input: FindOrCreateCryptoDomainInput,
): Promise<CreateDomainResultV2> {
  const participants = canonicalizeParticipants(input.participants);
  if (!(input.rosterBytes instanceof Uint8Array)) {
    throw new TypeError("Crypto Domain roster must be encoded bytes");
  }
  const rosterBytes = copyOwnedBytesV2(input.rosterBytes);
  assertV2Limit(
    "Crypto Domain roster bytes",
    rosterBytes.length,
    V2_LIMITS.ciphertextBytes,
  );
  const digest = participantDigest(participants);
  const existing = await storage.findDomain(digest, participants);
  if (existing) {
    return {
      status: "existing",
      domain: assertMatchingDomain(existing, digest, participants),
    };
  }

  const proposed: CryptoDomainPublicRecordV2 = {
    id: input.createDomainId(),
    participantDigest: digest,
    participants,
    epoch: 0,
    authorizationRevision: 0,
    rosterBytes,
  };
  const result = await storage.createDomainIfAbsent(proposed);
  assertExactFields(result, ["status", "domain"]);
  if (result.status !== "created" && result.status !== "existing") {
    throw new TypeError(
      "Crypto Domain storage returned an invalid creation status",
    );
  }
  const normalized = assertMatchingDomain(
    result.domain,
    digest,
    participants,
  );
  if (
    result.status === "created"
    && (
      normalized.id !== proposed.id
      || normalized.epoch !== 0
      || normalized.authorizationRevision !== 0
      || !equalBytes(normalized.rosterBytes, proposed.rosterBytes)
    )
  ) {
    throw new Error(
      "Crypto Domain created response does not match the proposed initial record",
    );
  }
  return { status: result.status, domain: normalized };
}
