import {
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
  destroyDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
  TaskRuntimeRecipientRequestPlan,
} from "@nautilo/runtime";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ProtectedTaskRuntimeRecipientCanonicalAuthority = Readonly<{
  policyRevision: number;
  namespaces:
    BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["namespaceRequirements"];
  domains:
    BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["domainRequirements"];
}>;

export type ProtectedTaskRuntimeRecipientRequestPlanInput = Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  occurrence: ProtectedTaskOccurrence;
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  sourceRoomId: string;
  authority: ProtectedTaskRuntimeRecipientCanonicalAuthority;
  createdAt: number;
  recipientTtlMs: number;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameRequirements(
  current: readonly Readonly<{
    ordinal: number;
    namespaceId: string;
    domainId: string;
    operations: readonly ("decrypt" | "encrypt")[];
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
  }>[],
  expected: BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["namespaceRequirements"],
): boolean {
  return current.length === expected.length && current.every((value, index) => {
    const other = expected[index];
    return other !== undefined
      && value.ordinal === other.ordinal
      && value.namespaceId === other.namespaceId
      && value.domainId === other.domainId
      && value.expectedAccessRevision === other.expectedAccessRevision
      && value.expectedPolicyRevision === other.expectedPolicyRevision
      && value.operations.join(",") === other.operations.join(",");
  });
}

function sameDomains(
  current: ProtectedTaskRuntimeRecipientCanonicalAuthority["domains"],
  expected: BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["domainRequirements"],
): boolean {
  return current.length === expected.length && current.every((value, index) => {
    const other = expected[index];
    return other !== undefined
      && value.ordinal === other.ordinal
      && value.domainId === other.domainId
      && value.expectedEpoch === other.expectedEpoch
      && value.expectedAuthorizationRevision
        === other.expectedAuthorizationRevision;
  });
}

/** Build the exact recipient attempt and wire request for one Task segment. */
export function createProtectedTaskRuntimeRecipientRequestPlan(
  input: ProtectedTaskRuntimeRecipientRequestPlanInput,
): Pick<TaskRuntimeRecipientRequestPlan, "recipientAttempt" | "buildRequest"> {
  const { occurrence, initialRecord } = input;
  const crypto = input.crypto;
  const requestId = initialRecord.snapshot.requestId;
  const workId = occurrence.run.id;
  const requesterUserId = occurrence.task.requestorId;
  const sourceRoomId = input.sourceRoomId;
  const policyRevision = input.authority.policyRevision;
  const createdAt = input.createdAt;
  const recipientTtlMs = input.recipientTtlMs;
  const idempotencyKey = initialRecord.idempotencyKey;
  const workIdentityHash = initialRecord.workIdentityHash.slice();
  const namespaces = Object.freeze(input.authority.namespaces.map(value =>
    Object.freeze({ ...value, operations: Object.freeze([...value.operations]) })));
  const domains = Object.freeze(input.authority.domains.map(value =>
    Object.freeze({ ...value })));

  if (typeof crypto.hash !== "function"
    || !UUID.test(sourceRoomId)
    || !Number.isSafeInteger(createdAt) || createdAt < 0
    || !Number.isSafeInteger(recipientTtlMs) || recipientTtlMs < 1
    || recipientTtlMs > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2
    || initialRecord.snapshot.workId !== workId
    || occurrence.run.taskId !== occurrence.task.id
    || initialRecord.expectedPolicyRevision !== policyRevision
    || !Number.isSafeInteger(policyRevision) || policyRevision < 1
    || idempotencyKey.length === 0
    || workIdentityHash.length !== 32
    || !sameRequirements(
      namespaces,
      initialRecord.authoritySet.namespaceRequirements,
    )
    || !sameDomains(domains, initialRecord.authoritySet.domainRequirements)) {
    workIdentityHash.fill(0);
    throw new TypeError("Protected Task recipient plan is not exact");
  }

  return Object.freeze({
    recipientAttempt: ({ record, now: attemptAt }) => {
      if (record.snapshot.requestId !== requestId
        || record.snapshot.workId !== workId
        || record.expectedPolicyRevision !== policyRevision
        || record.idempotencyKey !== idempotencyKey
        || !sameBytes(record.workIdentityHash, workIdentityHash)) {
        throw new TypeError("Protected Task recipient record is not exact");
      }
      const expiresAt = attemptAt + recipientTtlMs;
      if (!Number.isSafeInteger(attemptAt) || attemptAt < createdAt
        || !Number.isSafeInteger(expiresAt)) {
        throw new TypeError("Protected Task recipient deadline is invalid");
      }
      return Object.freeze({
        recipientKeyId:
          `task-runtime:${workId}:${record.snapshot.recipientGeneration}`,
        expiresAt,
      });
    },
    buildRequest: ({ record, attempt, binding, authority: current }) => {
      const issuedAt = attempt.expiresAt - recipientTtlMs;
      const currentDomains = [...current.domains]
        .sort((left, right) => left.domainId.localeCompare(right.domainId));
      if (record.snapshot.requestId !== requestId
        || record.snapshot.workId !== workId
        || record.idempotencyKey !== idempotencyKey
        || !sameBytes(record.workIdentityHash, workIdentityHash)
        || attempt.requestId !== requestId
        || attempt.workId !== workId
        || attempt.recipientGeneration !== record.snapshot.recipientGeneration
        || attempt.recipientKeyId
          !== `task-runtime:${workId}:${attempt.recipientGeneration}`
        || binding.userId !== requesterUserId
        || current.device.userId !== binding.userId
        || current.device.humanActorId !== binding.humanActorId
        || current.device.deviceId !== binding.deviceId
        || current.sourceRoomId !== sourceRoomId
        || current.policyRevision !== policyRevision
        || !sameRequirements(current.namespaceRequirements, namespaces)
        || currentDomains.length !== domains.length
        || currentDomains.some((domain, index) => {
          const expected = domains[index];
          return expected === undefined
            || domain.domainId !== expected.domainId
            || domain.domainKeyGeneration !== expected.expectedEpoch
            || domain.authorizationRevision
              !== expected.expectedAuthorizationRevision;
        })
        || !Number.isSafeInteger(issuedAt)
        || issuedAt < createdAt
        || issuedAt >= attempt.expiresAt) {
        throw new TypeError("Protected Task request authority is not exact");
      }
      const grant = createDomainForegroundAuthorizationPlan(crypto, {
        authorizationId: requestId,
        policyRevision,
        sessionId: `task-run:${workId}`,
        roomId: current.sourceRoomId,
        subjectHumanId: humanId(binding.humanActorId),
        committerDeviceId: cryptoDeviceId(binding.deviceId),
        committerDeviceSigningGeneration: current.device.deviceGeneration,
        hostAuthorizationRevision:
          authorizationRevision(current.device.securityRevision),
        recipientKind: "runtime",
        recipientPrincipalId: "nautilo_task_runtime",
        recipientAuthorizationRevision: authorizationRevision(0),
        recipientRuntimeGeneration: attempt.recipientGeneration,
        recipientKeyId: attempt.recipientKeyId,
        operations: ["decrypt", "encrypt"],
        issuedAt,
        deadlineAt: attempt.expiresAt,
        maximumSecretBytes: DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
        domains: currentDomains,
      });
      try {
        return createTaskRuntimeBackgroundAuthorizationRequestV1({
          requestId,
          workId,
          workKind: "task.execute",
          workPurpose: "task.execute",
          recipientGeneration: attempt.recipientGeneration,
          episodeId: grant.sessionId,
          sourceRoomId: current.sourceRoomId,
          recipientKeyId: attempt.recipientKeyId,
          recipientPublicKey: attempt.recipientPublicKey,
          authorizationPlan: grant,
          issuedAt,
          deadlineAt: attempt.expiresAt,
        });
      } finally {
        destroyDomainForegroundAuthorizationPlanV2(grant);
      }
    },
  });
}
