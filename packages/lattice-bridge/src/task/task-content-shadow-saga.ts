import { assertProtectedTaskOperationalMetadataProjectionV1 } from "@nautilo/types";

import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  TASK_CONTENT_RECONCILE_MAX_BATCH,
  assertTaskContentRevisionLifecycleV1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityIdentityV1,
  fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1,
  sameTaskContentCoordinateV1,
  taskContentObjectTypeV1,
  type AtomicTaskContentCryptoCompletionPort,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCompletionResult,
  type TaskContentCryptoRevisionReferenceV1,
  type TaskContentFailureCode,
  type TaskContentProductStorePort,
  type TaskContentReconciliationOutcome,
  type TaskContentRepository,
  type TaskContentRevisionLifecycleV1,
  type TaskContentRevisionStateV1,
  type VerifiedTaskContentCryptoRevisionV1,
} from "./task-content-repository.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameJson(leftRecord[key], rightRecord[key]));
}

function orphanReason(
  lifecycle: TaskContentRevisionLifecycleV1,
): "stale_mapping" | null {
  return lifecycle.disposition === "stale_mapping" ? "stale_mapping" : null;
}

function assertState(state: TaskContentRevisionStateV1): void {
  assertTaskContentRevisionLifecycleV1(state.lifecycle);
  if (state.lifecycle.namespaceId.length === 0) {
    throw new Error("Task content Namespace state is inconsistent");
  }
  if (state.product !== null) {
    if (!sameTaskContentCoordinateV1(
      state.product.coordinate,
      state.lifecycle.coordinate,
    )) throw new Error("Task content product coordinates are inconsistent");
    if (state.product.cryptoAccessRevision < 0) {
      throw new Error("Task content product access revision is invalid");
    }
  }
}

function assertPrepared(
  state: TaskContentRevisionStateV1,
  prepared: PreparedTaskContentCryptoRevisionV1,
): void {
  const lifecycle = state.lifecycle;
  if (
    !sameTaskContentCoordinateV1(prepared.coordinate, lifecycle.coordinate)
    || prepared.objectId !== lifecycle.cryptoObjectId
    || prepared.objectType !== lifecycle.objectType
    || prepared.payloadVersion !== TASK_CONTENT_PAYLOAD_VERSION_V1
    || prepared.namespaceId !== state.authority.namespaceId
    || !sameBytes(
      prepared.authorityFingerprint,
      lifecycle.authorityFingerprint,
    )
  ) throw new Error("Prepared Task content crypto coordinates disagree");
}

function assertMappedState(state: TaskContentRevisionStateV1): void {
  const product = state.product;
  if (
    product === null
    || product.namespaceId !== state.lifecycle.namespaceId
    || product.representation !== state.lifecycle.representation
    || product.cryptoMappingState !== "verified"
    || product.cryptoObjectId !== state.lifecycle.cryptoObjectId
    || product.cryptoRequiredNamespaceFingerprint === null
    || !sameBytes(
      product.cryptoRequiredNamespaceFingerprint,
      state.lifecycle.requiredNamespaceFingerprint,
    )
  ) throw new Error("Mapped Task content product state is inconsistent");
}

function authorityMatches(state: TaskContentRevisionStateV1): boolean {
  try {
    return state.authority.requesterHumanId === state.lifecycle.requesterHumanId
      && state.authority.namespaceId === state.lifecycle.namespaceId
      && sameBytes(
        fingerprintTaskContentAuthorityIdentityV1(state.authority),
        fingerprintTaskContentAuthorityIdentityV1({
          requesterHumanId: state.lifecycle.requesterHumanId,
          namespaceId: state.lifecycle.namespaceId,
          keyClass: "ai",
        }),
      );
  } catch {
    return false;
  }
}

function cryptoReference(
  state: TaskContentRevisionStateV1,
): TaskContentCryptoRevisionReferenceV1 {
  return Object.freeze({
    coordinate: Object.freeze({ ...state.lifecycle.coordinate }),
    objectId: state.lifecycle.cryptoObjectId,
    objectType: state.lifecycle.objectType,
    expectedAccessRevision: state.product?.cryptoAccessRevision ?? 0,
    expectedAuthorityFingerprint: state.lifecycle.authorityFingerprint.slice(),
    expectedAuthorityIdentityFingerprint:
      fingerprintTaskContentAuthorityIdentityV1(state.authority),
  });
}

function verifiedMatches(
  state: TaskContentRevisionStateV1,
  verified: VerifiedTaskContentCryptoRevisionV1,
): boolean {
  try {
    return sameTaskContentCoordinateV1(
      verified.coordinate,
      state.lifecycle.coordinate,
    )
      && verified.objectId
        === deriveTaskContentCryptoObjectIdV1(state.lifecycle.coordinate)
      && verified.objectId === state.lifecycle.cryptoObjectId
      && verified.objectType
        === taskContentObjectTypeV1(state.lifecycle.coordinate)
      && verified.payloadVersion === TASK_CONTENT_PAYLOAD_VERSION_V1
      && verified.namespaceId === state.authority.namespaceId
      && sameBytes(
        verified.authorityFingerprint,
        state.lifecycle.authorityFingerprint,
      );
  } catch {
    return false;
  }
}

export function createDormantTaskContentShadowRepository(input: Readonly<{
  product: TaskContentProductStorePort;
  crypto: AtomicTaskContentCryptoCompletionPort;
}>): TaskContentRepository {
  async function quarantine(
    lifecycle: TaskContentRevisionLifecycleV1,
    failureCode: TaskContentFailureCode,
    leaseToken: string | null,
  ): Promise<void> {
    const result = await input.product.quarantineRevision({
      coordinate: lifecycle.coordinate,
      leaseToken,
      failureCode,
    });
    if (result === "conflict" || result === "missing") {
      throw new Error("Task content quarantine idempotency conflict");
    }
  }

  async function markAuthorityStale(
    lifecycle: TaskContentRevisionLifecycleV1,
    leaseToken: string | null,
  ): Promise<TaskContentRevisionLifecycleV1> {
    const stale = await input.product.markAuthorityStale({
      coordinate: lifecycle.coordinate,
      leaseToken,
    });
    if (stale === null) {
      throw new Error("Task content stale-authority receipt failed");
    }
    assertTaskContentRevisionLifecycleV1(stale);
    if (
      stale.failureCode !== "authority_stale"
      || (stale.disposition !== "quarantined"
        && stale.disposition !== "stale_mapping")
    ) throw new Error("Task content stale-authority receipt is invalid");
    return stale;
  }

  async function verifyComplete(
    state: TaskContentRevisionStateV1,
    leaseToken: string | null,
  ): Promise<VerifiedTaskContentCryptoRevisionV1> {
    let verified: VerifiedTaskContentCryptoRevisionV1 | null;
    try {
      verified = await input.crypto.verify(cryptoReference(state));
    } catch (cause) {
      throw new Error("Task content crypto verification is unavailable", {
        cause,
      });
    }
    if (verified === null) {
      throw new Error("Complete Task content crypto revision is not verified");
    }
    if (!verifiedMatches(state, verified)) {
      await quarantine(state.lifecycle, "crypto_mismatch", leaseToken);
      throw new Error("Complete Task content crypto revision is not verified");
    }
    return verified;
  }

  async function publishVerified(
    state: TaskContentRevisionStateV1,
    leaseToken: string | null,
  ): Promise<TaskContentCompletionResult> {
    const lifecycle = state.lifecycle;
    const marked = await input.product.markCryptoComplete({
      coordinate: lifecycle.coordinate,
      cryptoObjectId: lifecycle.cryptoObjectId,
      leaseToken,
    });
    if (marked === "missing" || marked === "conflict") {
      throw new Error(`Task content crypto completion receipt failed: ${marked}`);
    }
    const existingOrphan = orphanReason(lifecycle);
    if (existingOrphan !== null) {
      return Object.freeze({
        status: "orphaned" as const,
        reason: existingOrphan,
        coordinate: lifecycle.coordinate,
        cryptoObjectId: lifecycle.cryptoObjectId,
      });
    }
    if (lifecycle.disposition === "quarantined") {
      throw new Error("Unavailable Task content revision cannot be published");
    }

    const mapped = await input.product.compareAndSwapCryptoMapping({
      coordinate: lifecycle.coordinate,
      cryptoObjectId: lifecycle.cryptoObjectId,
      expectedAuthorityFingerprint: lifecycle.authorityFingerprint,
      expectedRepresentation: lifecycle.representation,
      leaseToken,
    });
    if (mapped === "lease_lost") {
      throw new Error("Task content publication lease was lost");
    }
    if (
      mapped === "stale"
      || mapped === "missing"
      || mapped === "wrong_authority"
    ) {
      return Object.freeze({
        status: "orphaned" as const,
        reason: "stale_mapping" as const,
        coordinate: lifecycle.coordinate,
        cryptoObjectId: lifecycle.cryptoObjectId,
      });
    }
    return Object.freeze({
      status: mapped === "duplicate" ? "replayed" as const : "mapped" as const,
      coordinate: lifecycle.coordinate,
      cryptoObjectId: lifecycle.cryptoObjectId,
    });
  }

  async function failClaim(
    lifecycle: TaskContentRevisionLifecycleV1,
    leaseToken: string,
    failureCode: TaskContentFailureCode,
  ): Promise<TaskContentReconciliationOutcome> {
    const failed = await input.product.failReconciliationClaim({
      coordinate: lifecycle.coordinate,
      leaseToken,
      failureCode,
    });
    if (failed === null) return "pending";
    if (failed.disposition === "quarantined") return "quarantined";
    if (failed.disposition === "mapped") return "mapped";
    if (orphanReason(failed) !== null) return "orphaned";
    return "pending";
  }

  async function reconcileOne(
    state: TaskContentRevisionStateV1,
    leaseToken: string,
  ): Promise<TaskContentReconciliationOutcome> {
    const lifecycle = state.lifecycle;
    if (lifecycle.disposition === "quarantined") return "quarantined";
    if (orphanReason(lifecycle) !== null) return "orphaned";
    if (!authorityMatches(state)) {
      const stale = await markAuthorityStale(lifecycle, leaseToken);
      return stale.disposition === "quarantined"
        ? "quarantined"
        : "orphaned";
    }
    let verified: VerifiedTaskContentCryptoRevisionV1 | null;
    try {
      verified = await input.crypto.verify(cryptoReference(state));
    } catch {
      return failClaim(lifecycle, leaseToken, "storage_transient");
    }
    if (verified === null) {
      return failClaim(
        lifecycle,
        leaseToken,
        lifecycle.completion === "complete"
          ? "crypto_incomplete"
          : "crypto_absent",
      );
    }
    if (!verifiedMatches(state, verified)) {
      await quarantine(lifecycle, "crypto_mismatch", leaseToken);
      return "quarantined";
    }
    try {
      const result = await publishVerified(state, leaseToken);
      return result.status === "orphaned" ? "orphaned" : "mapped";
    } catch {
      return failClaim(lifecycle, leaseToken, "storage_transient");
    }
  }

  return Object.freeze({
    async reserveRevision(
      request: Parameters<TaskContentRepository["reserveRevision"]>[0],
    ) {
      if (
        request.prepared.objectId
          !== deriveTaskContentCryptoObjectIdV1(request.prepared.coordinate)
        || request.prepared.objectType
          !== taskContentObjectTypeV1(request.prepared.coordinate)
        || request.prepared.namespaceId !== request.authority.namespaceId
      ) throw new Error("Prepared Task content reservation disagrees");
      if (
        typeof request.operationId !== "string"
        || !PORTABLE_ID.test(request.operationId)
        || new TextEncoder().encode(request.operationId).length > 128
      ) throw new TypeError("Task content operation ID is invalid");
      const authorityFingerprint = fingerprintTaskContentAuthorityV1(
        request.authority,
      );
      if (!sameBytes(
        authorityFingerprint,
        request.prepared.authorityFingerprint,
      )) throw new Error("Prepared Task content reservation authority disagrees");
      if (!(request.requestDigest instanceof Uint8Array)
        || request.requestDigest.length !== 32) {
        throw new TypeError("Task content request digest must contain 32 bytes");
      }
      if (request.prepared.coordinate.kind === "definition") {
        assertProtectedTaskOperationalMetadataProjectionV1(
          request.operationalMetadata,
        );
      } else if (request.operationalMetadata !== null) {
        throw new TypeError("Task content operational metadata is invalid");
      }
      const reserved = await input.product.reserveRevision({
        operationId: request.operationId,
        coordinate: request.prepared.coordinate,
        requesterHumanId: request.authority.requesterHumanId,
        namespaceId: request.authority.namespaceId,
        authorityFingerprint,
        requiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(
          request.authority.namespaceId,
        ),
        representation: request.representation,
        requestDigest: request.requestDigest.slice(),
        cryptoObjectId: request.prepared.objectId,
        objectType: request.prepared.objectType,
        payloadVersion: request.prepared.payloadVersion,
        operationalMetadata: request.operationalMetadata,
      });
      if (!("state" in reserved)) {
        return reserved;
      }
      assertState(reserved.state);
      if (
        !sameTaskContentCoordinateV1(
          reserved.state.lifecycle.coordinate,
          request.prepared.coordinate,
        )
        || reserved.state.lifecycle.operationId !== request.operationId
        || reserved.state.lifecycle.representation !== request.representation
        || !sameJson(
          reserved.state.lifecycle.operationalMetadata,
          request.operationalMetadata,
        )
        || !sameBytes(
          reserved.state.lifecycle.requestDigest,
          request.requestDigest,
        )
        || !sameBytes(
          reserved.state.lifecycle.authorityFingerprint,
          authorityFingerprint,
        )
        || !authorityMatches(reserved.state)
      ) throw new Error("Reserved Task content revision is not an exact replay");
      return Object.freeze({
        status: reserved.status,
        coordinate: reserved.state.lifecycle.coordinate,
        cryptoObjectId: reserved.state.lifecycle.cryptoObjectId,
      });
    },

    async completeRevision(
      request: Parameters<TaskContentRepository["completeRevision"]>[0],
    ) {
      const state = await input.product.getRevision(request.coordinate);
      if (state === null) throw new Error("Task content revision is missing");
      assertState(state);
      if (!sameTaskContentCoordinateV1(
        state.lifecycle.coordinate,
        request.coordinate,
      )) throw new Error("Task content product revision coordinates disagree");
      if (!authorityMatches(state)) {
        const stale = await markAuthorityStale(state.lifecycle, null);
        if (stale.disposition === "quarantined") {
          throw new Error("Task content authority is stale");
        }
        return Object.freeze({
          status: "orphaned" as const,
          reason: "stale_mapping" as const,
          coordinate: state.lifecycle.coordinate,
          cryptoObjectId: state.lifecycle.cryptoObjectId,
        });
      }
      assertPrepared(state, request.prepared);

      if (state.lifecycle.disposition === "mapped") {
        assertMappedState(state);
        await verifyComplete(state, null);
        return Object.freeze({
          status: "replayed" as const,
          coordinate: state.lifecycle.coordinate,
          cryptoObjectId: state.lifecycle.cryptoObjectId,
        });
      }
      const existingOrphan = orphanReason(state.lifecycle);
      if (existingOrphan !== null) {
        if (state.lifecycle.completion === "complete") {
          await verifyComplete(state, null);
        }
        return Object.freeze({
          status: "orphaned" as const,
          reason: existingOrphan,
          coordinate: state.lifecycle.coordinate,
          cryptoObjectId: state.lifecycle.cryptoObjectId,
        });
      }
      if (state.lifecycle.disposition === "quarantined") {
        throw new Error("Unavailable Task content revision cannot be completed");
      }

      await input.crypto.complete(request.prepared);
      await verifyComplete(state, null);
      return publishVerified(state, null);
    },

    async reconcilePending(
      request: Parameters<TaskContentRepository["reconcilePending"]>[0],
    ) {
      if (!UUID.test(request.leaseToken)) {
        throw new TypeError("Task content reconciliation lease must be a UUID");
      }
      if (
        !Number.isSafeInteger(request.limit)
        || request.limit < 1
        || request.limit > TASK_CONTENT_RECONCILE_MAX_BATCH
      ) throw new RangeError("Task content reconciliation limit is invalid");
      const candidates = await input.product.claimReconciliationCandidates(
        request,
      );
      if (candidates.length > request.limit) {
        throw new Error("Task content product adapter returned too many candidates");
      }
      const outcomes = [];
      let previousDue = Number.NEGATIVE_INFINITY;
      let previousKind = "";
      let previousSequence = 0;
      for (const state of candidates) {
        try {
          assertState(state);
          if (state.lifecycle.leaseToken !== request.leaseToken) {
            throw new Error("Claimed Task content lifecycle has the wrong lease");
          }
          const due = state.lifecycle.nextAttemptAt?.getTime()
            ?? Number.NEGATIVE_INFINITY;
          if (
            due < previousDue
            || (due === previousDue
              && (state.lifecycle.coordinate.kind.localeCompare(previousKind) < 0
                || (state.lifecycle.coordinate.kind === previousKind
                  && state.lifecycle.sequence <= previousSequence)))
          ) throw new Error("Claimed Task content lifecycles are not stably ordered");
          previousDue = due;
          previousKind = state.lifecycle.coordinate.kind;
          previousSequence = state.lifecycle.sequence;
        } catch {
          await quarantine(
            state.lifecycle,
            "crypto_mismatch",
            request.leaseToken,
          );
          outcomes.push(Object.freeze({
            sequence: state.lifecycle.sequence,
            coordinate: state.lifecycle.coordinate,
            outcome: "quarantined" as const,
          }));
          continue;
        }
        outcomes.push(Object.freeze({
          sequence: state.lifecycle.sequence,
          coordinate: state.lifecycle.coordinate,
          outcome: await reconcileOne(state, request.leaseToken),
        }));
      }
      return Object.freeze({ outcomes: Object.freeze(outcomes) });
    },
  });
}
