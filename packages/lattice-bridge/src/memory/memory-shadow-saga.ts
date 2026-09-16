import {
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  MEMORY_RECONCILE_MAX_BATCH,
  assertMemoryRevisionLifecycle,
  fingerprintRequiredMemoryNamespaces,
  type AtomicMemoryCryptoCompletionPort,
  type MemoryCompletionResult,
  type MemoryCryptoRevisionReference,
  type MemoryFailureCode,
  type MemoryProductStorePort,
  type MemoryReconciliationOutcome,
  type MemoryRepository,
  type MemoryRevisionLifecycle,
  type MemoryRevisionState,
  type PreparedMemoryCryptoRevision,
  type VerifiedMemoryCryptoRevision,
} from "./memory-repository.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function orphanReason(
  lifecycle: MemoryRevisionLifecycle,
): "stale_mapping" | "superseded" | "hard_delete" | null {
  return lifecycle.disposition === "stale_mapping"
      || lifecycle.disposition === "superseded"
      || lifecycle.disposition === "hard_delete"
    ? lifecycle.disposition
    : null;
}

function assertCurrentRequiredSet(state: MemoryRevisionState): void {
  fingerprintRequiredMemoryNamespaces(state.requiredNamespaceIds);
}

function assertPrepared(
  state: MemoryRevisionState,
  prepared: PreparedMemoryCryptoRevision,
): void {
  const lifecycle = state.lifecycle;
  if (
    prepared.memoryId !== lifecycle.memoryId
    || prepared.contentRevision !== lifecycle.contentRevision
    || prepared.objectId !== lifecycle.cryptoObjectId
    || prepared.objectType !== MEMORY_OBJECT_TYPE
    || prepared.payloadVersion !== MEMORY_PAYLOAD_VERSION
  ) throw new Error("Prepared Memory crypto coordinates disagree");
  const preparedFingerprint = fingerprintRequiredMemoryNamespaces(
    prepared.requiredNamespaceIds,
  );
  if (
    !sameBytes(
      preparedFingerprint,
      state.lifecycle.requiredNamespaceFingerprint,
    )
  ) {
    throw new Error("Prepared Memory required Namespace set mismatch");
  }
  if (!prepared.requiredNamespaceIds.includes(lifecycle.anchorNamespaceId)) {
    throw new Error("Prepared Memory omits its allocation anchor Namespace");
  }
}

function assertMappedState(state: MemoryRevisionState): void {
  const product = state.product;
  if (
    product === null
    || product.memoryId !== state.lifecycle.memoryId
    || product.contentRevision !== state.lifecycle.contentRevision
    || product.cryptoObjectId !== state.lifecycle.cryptoObjectId
    || product.cryptoRequiredNamespaceFingerprint === null
    || !sameBytes(
      product.cryptoRequiredNamespaceFingerprint,
      fingerprintRequiredMemoryNamespaces(state.requiredNamespaceIds),
    )
  ) throw new Error("Mapped Memory product state is inconsistent");
}

function cryptoReference(
  state: MemoryRevisionState,
): MemoryCryptoRevisionReference {
  return Object.freeze({
    memoryId: state.lifecycle.memoryId,
    contentRevision: state.lifecycle.contentRevision,
    objectId: state.lifecycle.cryptoObjectId,
    expectedAccessRevision: state.product?.cryptoAccessRevision ?? 0,
    expectedActiveNamespaceFingerprint:
      state.lifecycle.requiredNamespaceFingerprint.slice(),
  });
}

function verifiedMatches(
  state: MemoryRevisionState,
  verified: VerifiedMemoryCryptoRevision,
): boolean {
  try {
    const lifecycle = state.lifecycle;
    if (
      verified.memoryId !== lifecycle.memoryId
      || verified.contentRevision !== lifecycle.contentRevision
      || verified.objectId !== lifecycle.cryptoObjectId
      || verified.objectType !== MEMORY_OBJECT_TYPE
      || verified.payloadVersion !== MEMORY_PAYLOAD_VERSION
      || !sameBytes(
        fingerprintRequiredMemoryNamespaces(verified.requiredNamespaceIds),
        lifecycle.requiredNamespaceFingerprint,
      )
    ) return false;
    return true;
  } catch {
    return false;
  }
}

export function createDormantMemoryShadowRepository(input: Readonly<{
  product: MemoryProductStorePort;
  crypto: AtomicMemoryCryptoCompletionPort;
}>): MemoryRepository {
  async function quarantine(
    lifecycle: MemoryRevisionLifecycle,
    failureCode: MemoryFailureCode,
    leaseToken: string | null,
  ): Promise<void> {
    const result = await input.product.quarantineRevision({
      memoryId: lifecycle.memoryId,
      contentRevision: lifecycle.contentRevision,
      leaseToken,
      failureCode,
    });
    if (result === "conflict" || result === "missing") {
      throw new Error("Memory quarantine idempotency conflict");
    }
  }

  async function verifyComplete(
    state: MemoryRevisionState,
    leaseToken: string | null,
  ): Promise<VerifiedMemoryCryptoRevision> {
    let verified: VerifiedMemoryCryptoRevision | null;
    try {
      verified = await input.crypto.verify(cryptoReference(state));
    } catch (cause) {
      throw new Error("Memory crypto verification is unavailable", { cause });
    }
    if (verified === null) {
      throw new Error("Complete Memory crypto revision is not verified");
    }
    if (!verifiedMatches(state, verified)) {
      await quarantine(state.lifecycle, "crypto_mismatch", leaseToken);
      throw new Error("Complete Memory crypto revision is not verified");
    }
    return verified;
  }

  async function publishVerified(
    state: MemoryRevisionState,
    leaseToken: string | null,
  ): Promise<MemoryCompletionResult> {
    const lifecycle = state.lifecycle;
    const marked = await input.product.markCryptoComplete({
      memoryId: lifecycle.memoryId,
      contentRevision: lifecycle.contentRevision,
      cryptoObjectId: lifecycle.cryptoObjectId,
      leaseToken,
    });
    if (marked === "missing" || marked === "conflict") {
      throw new Error(`Memory crypto completion receipt failed: ${marked}`);
    }
    const existingOrphan = orphanReason(lifecycle);
    if (existingOrphan !== null) {
      return Object.freeze({
        status: "orphaned",
        reason: existingOrphan,
        memoryId: lifecycle.memoryId,
        contentRevision: lifecycle.contentRevision,
        cryptoObjectId: lifecycle.cryptoObjectId,
      });
    }
    if (
      lifecycle.disposition === "blocked"
      || lifecycle.disposition === "quarantined"
    ) throw new Error("Unavailable Memory revision cannot be published");

    const mapped = await input.product.compareAndSwapCryptoMapping({
      memoryId: lifecycle.memoryId,
      contentRevision: lifecycle.contentRevision,
      cryptoObjectId: lifecycle.cryptoObjectId,
      expectedRequiredNamespaceFingerprint:
        lifecycle.requiredNamespaceFingerprint,
      leaseToken,
    });
    if (mapped === "lease_lost") {
      throw new Error("Memory publication lease was lost");
    }
    if (
      mapped === "stale"
      || mapped === "missing"
      || mapped === "wrong_authority"
    ) {
      return Object.freeze({
        status: "orphaned",
        reason: "stale_mapping",
        memoryId: lifecycle.memoryId,
        contentRevision: lifecycle.contentRevision,
        cryptoObjectId: lifecycle.cryptoObjectId,
      });
    }
    return Object.freeze({
      status: mapped === "duplicate" ? "replayed" : "mapped",
      memoryId: lifecycle.memoryId,
      contentRevision: lifecycle.contentRevision,
      cryptoObjectId: lifecycle.cryptoObjectId,
    });
  }

  async function failClaim(
    lifecycle: MemoryRevisionLifecycle,
    leaseToken: string,
    failureCode: MemoryFailureCode,
  ): Promise<MemoryReconciliationOutcome> {
    const failed = await input.product.failReconciliationClaim({
      memoryId: lifecycle.memoryId,
      contentRevision: lifecycle.contentRevision,
      leaseToken,
      failureCode,
    });
    if (failed === null) return "pending";
    if (failed.disposition === "blocked") return "blocked";
    if (failed.disposition === "quarantined") return "quarantined";
    if (failed.disposition === "mapped") return "mapped";
    if (orphanReason(failed) !== null) return "orphaned";
    return "pending";
  }

  async function reconcileOne(
    state: MemoryRevisionState,
    leaseToken: string,
  ): Promise<MemoryReconciliationOutcome> {
    const lifecycle = state.lifecycle;
    if (lifecycle.disposition === "blocked") return "blocked";
    if (lifecycle.disposition === "quarantined") return "quarantined";
    if (orphanReason(lifecycle) !== null) {
      return "orphaned";
    }
    let verified: VerifiedMemoryCryptoRevision | null;
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
    async completeRevision(
      request: Parameters<MemoryRepository["completeRevision"]>[0],
    ) {
      const state = await input.product.getRevision({
        memoryId: request.memoryId,
        contentRevision: request.expectedRevision,
      });
      if (state === null) throw new Error("Memory revision is missing");
      assertMemoryRevisionLifecycle(state.lifecycle);
      assertCurrentRequiredSet(state);
      if (
        state.lifecycle.memoryId !== request.memoryId
        || state.lifecycle.contentRevision !== request.expectedRevision
      ) throw new Error("Memory product revision coordinates disagree");
      assertPrepared(state, request.prepared);

      if (state.lifecycle.disposition === "mapped") {
        assertMappedState(state);
        await verifyComplete(state, null);
        return Object.freeze({
          status: "replayed" as const,
          memoryId: state.lifecycle.memoryId,
          contentRevision: state.lifecycle.contentRevision,
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
          memoryId: state.lifecycle.memoryId,
          contentRevision: state.lifecycle.contentRevision,
          cryptoObjectId: state.lifecycle.cryptoObjectId,
        });
      }
      if (
        state.lifecycle.disposition === "blocked"
        || state.lifecycle.disposition === "quarantined"
      ) throw new Error("Unavailable Memory revision cannot be completed");

      await input.crypto.complete(request.prepared);
      await verifyComplete(state, null);
      return publishVerified(state, null);
    },

    async reconcilePending(
      request: Parameters<MemoryRepository["reconcilePending"]>[0],
    ) {
      if (!UUID.test(request.leaseToken)) {
        throw new TypeError("Memory reconciliation lease must be a UUID");
      }
      if (
        !Number.isSafeInteger(request.limit)
        || request.limit < 1
        || request.limit > MEMORY_RECONCILE_MAX_BATCH
      ) throw new RangeError("Memory reconciliation limit is invalid");
      const candidates = await input.product.claimReconciliationCandidates(
        request,
      );
      if (candidates.length > request.limit) {
        throw new Error("Memory product adapter returned too many candidates");
      }
      const outcomes = [];
      let previousDue = Number.NEGATIVE_INFINITY;
      let previousSequence = 0;
      for (const state of candidates) {
        try {
          assertMemoryRevisionLifecycle(state.lifecycle);
          assertCurrentRequiredSet(state);
          if (state.lifecycle.leaseToken !== request.leaseToken) {
            throw new Error("Claimed Memory lifecycle has the wrong lease");
          }
          const due = state.lifecycle.nextAttemptAt?.getTime()
            ?? Number.NEGATIVE_INFINITY;
          if (
            due < previousDue
            || (due === previousDue
              && state.lifecycle.sequence <= previousSequence)
          ) {
            throw new Error(
              "Claimed Memory lifecycles are not stably ordered",
            );
          }
          previousDue = due;
          previousSequence = state.lifecycle.sequence;
        } catch {
          await quarantine(
            state.lifecycle,
            "crypto_mismatch",
            request.leaseToken,
          );
          outcomes.push(Object.freeze({
            sequence: state.lifecycle.sequence,
            memoryId: state.lifecycle.memoryId,
            contentRevision: state.lifecycle.contentRevision,
            outcome: "quarantined" as const,
          }));
          continue;
        }
        outcomes.push(Object.freeze({
          sequence: state.lifecycle.sequence,
          memoryId: state.lifecycle.memoryId,
          contentRevision: state.lifecycle.contentRevision,
          outcome: await reconcileOne(state, request.leaseToken),
        }));
      }
      return Object.freeze({ outcomes: Object.freeze(outcomes) });
    },
  });
}
