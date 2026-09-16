import {
  deriveHumanMessageEditCryptoObjectIdV1,
  parseHumanMessageEditCryptoObjectIdV1,
} from "@nautilo/lattice-crypto/wire";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
  CONVERSATION_RECONCILE_MAX_ATTEMPTS,
  CONVERSATION_RECONCILE_MAX_BATCH,
  IMMUTABLE_ROOM_NAMESPACE_INVARIANT,
  assertConversationAuthorRole,
  assertConversationDurableKey,
  assertConversationMessageId,
  assertConversationMessageKeyClass,
  assertConversationNotificationEligibility,
  assertConversationRevision,
  assertConversationSessionId,
  assertConversationSubthreadReplyClassification,
  conversationAppendRequestDigest,
  conversationDeleteRequestDigest,
  conversationEditRequestDigest,
  conversationVerificationMatchesRepresentation,
  deriveLiveShadowMessageCryptoObjectIdV1,
  deriveMessageCryptoObjectIdV2,
  type AtomicConversationCryptoCompletionPort,
  type ConversationAllocatedRevision,
  type ConversationCompletionResult,
  type ConversationFailureCode,
  type ConversationParityStatus,
  type ConversationProductStorePort,
  type ConversationReconciliationOutcome,
  type ConversationRepository,
  type ConversationRevisionLifecycle,
  type ConversationRevisionState,
  type PreparedConversationCryptoRevision,
  type VerifiedConversationCryptoRevision,
} from "./conversation-repository.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkedLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > CONVERSATION_RECONCILE_MAX_BATCH
  ) {
    throw new RangeError("Conversation reconciliation limit is out of bounds");
  }
  return limit;
}

function checkedLease(input: {
  readonly leaseToken: string;
}) {
  if (!UUID.test(input.leaseToken)) {
    throw new TypeError("Conversation reconciliation lease token is invalid");
  }
  return Object.freeze({
    leaseToken: input.leaseToken,
  });
}

function allocated(
  status: "allocated" | "replayed",
  lifecycle: ConversationRevisionLifecycle,
): ConversationAllocatedRevision {
  return Object.freeze({
    status,
    sessionId: lifecycle.sessionId,
    messageId: lifecycle.messageId,
    revision: lifecycle.revision,
    roomId: lifecycle.roomId,
    namespaceId: lifecycle.namespaceIdAtAllocation,
    keyClass: lifecycle.keyClass,
    authorRole: lifecycle.authorRole,
    cryptoObjectId: lifecycle.cryptoObjectId,
  });
}

function expectedObjectId(
  lifecycle: ConversationRevisionLifecycle,
): string {
  if (lifecycle.objectIdScheme === "message_v2") {
    if (
      lifecycle.shadowOperationId !== null
      || lifecycle.humanPeerShadowOperationId !== null
      || lifecycle.sharedAgentShadowOperationId !== null
      || lifecycle.sharedAgentShadowExecutionId !== null
      || lifecycle.shadowTranscriptOrdinal !== null
    ) throw new Error("Legacy Message lifecycle carries live coordinates");
    return deriveMessageCryptoObjectIdV2(lifecycle);
  }
  if (lifecycle.objectIdScheme === "human_message_edit_v1") {
    const parsed = parseHumanMessageEditCryptoObjectIdV1(
      lifecycle.cryptoObjectId,
      {
        sessionId: lifecycle.sessionId,
        messageId: lifecycle.messageId,
        revision: lifecycle.revision,
      },
    );
    return deriveHumanMessageEditCryptoObjectIdV1({
      operationId: parsed.operationId,
      sessionId: lifecycle.sessionId,
      messageId: lifecycle.messageId,
      revision: lifecycle.revision,
    });
  }
  const operationId = lifecycle.shadowOperationId
    ?? lifecycle.humanPeerShadowOperationId
    ?? lifecycle.sharedAgentShadowOperationId
    ?? lifecycle.sharedAgentShadowExecutionId;
  const parentCount = [
    lifecycle.shadowOperationId,
    lifecycle.humanPeerShadowOperationId,
    lifecycle.sharedAgentShadowOperationId,
    lifecycle.sharedAgentShadowExecutionId,
  ].filter((value) => value !== null).length;
  if (
    lifecycle.objectIdScheme !== "live_shadow_v1"
    || operationId === null
    || parentCount !== 1
    || lifecycle.shadowTranscriptOrdinal === null
  ) throw new Error("Live Message lifecycle lacks its exact turn coordinates");
  return deriveLiveShadowMessageCryptoObjectIdV1({
    operationId,
    sessionId: lifecycle.sessionId,
    messageId: lifecycle.messageId,
    revision: lifecycle.revision,
    transcriptOrdinal: lifecycle.shadowTranscriptOrdinal,
    authorRole: lifecycle.authorRole,
  });
}

function validDigest(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length === 32;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function assertCanonicalLifecycle(
  lifecycle: ConversationRevisionLifecycle,
): void {
  assertConversationSessionId(lifecycle.sessionId);
  assertConversationMessageId(lifecycle.messageId);
  assertConversationRevision(lifecycle.revision);
  assertConversationMessageKeyClass(lifecycle.keyClass);
  assertConversationAuthorRole(lifecycle.authorRole);
  if (lifecycle.appendIdempotencyKey !== null) {
    assertConversationDurableKey(
      "message append idempotency key",
      lifecycle.appendIdempotencyKey,
    );
  }
  if (lifecycle.terminalOperationId !== null) {
    assertConversationDurableKey(
      "message terminal operation id",
      lifecycle.terminalOperationId,
    );
  }
  if (lifecycle.cryptoObjectId !== expectedObjectId(lifecycle)) {
    throw new Error("Product message crypto object identity is not canonical");
  }
  if (!Number.isSafeInteger(lifecycle.sequence) || lifecycle.sequence < 1) {
    throw new Error("Product message lifecycle sequence is not canonical");
  }
  if (
    !oneOf(lifecycle.completion, ["pending", "complete"])
    || !oneOf(lifecycle.disposition, [
      "active",
      "mapped",
      "blocked",
      "quarantined",
      "superseded",
      "hard_delete",
      "stale_mapping",
    ])
    || !oneOf(lifecycle.parityStatus, [
      "pending",
      "server_verified",
      "server_authenticated",
      "client_verified",
      "client_authenticated",
    ])
    || (
      lifecycle.failureCode !== null
      && !oneOf(lifecycle.failureCode, [
        "namespace_unresolved",
        "namespace_mismatch",
        "crypto_absent",
        "crypto_incomplete",
        "crypto_mismatch",
        "authorization_unavailable",
        "recipient_unavailable",
        "storage_transient",
        "mapping_conflict",
        "retry_exhausted",
      ])
    )
    || !Number.isSafeInteger(lifecycle.attemptCount)
    || lifecycle.attemptCount < 0
    || lifecycle.attemptCount > CONVERSATION_RECONCILE_MAX_ATTEMPTS
  ) throw new Error("Product message lifecycle attempt count is invalid");
  if (
    (lifecycle.nextAttemptAt !== null
      && !Number.isFinite(lifecycle.nextAttemptAt.getTime()))
    || (lifecycle.leaseExpiresAt !== null
      && !Number.isFinite(lifecycle.leaseExpiresAt.getTime()))
    || ((lifecycle.leaseToken === null)
      !== (lifecycle.leaseExpiresAt === null))
    || (lifecycle.leaseToken !== null && !UUID.test(lifecycle.leaseToken))
    || !validDigest(lifecycle.allocationRequestDigest)
    || (
      lifecycle.terminalRequestDigest !== null
      && !validDigest(lifecycle.terminalRequestDigest)
    )
  ) throw new Error("Product message lifecycle retry metadata is invalid");
  const active = lifecycle.disposition === "active";
  const terminal = lifecycle.disposition === "superseded"
    ? "edit"
    : lifecycle.disposition === "hard_delete"
    ? "delete"
    : null;
  if (
    active !== (lifecycle.nextAttemptAt !== null)
    || (lifecycle.leaseToken !== null && !active)
    || (active
      && lifecycle.attemptCount >= CONVERSATION_RECONCILE_MAX_ATTEMPTS)
    || (
      lifecycle.parityStatus !== "pending"
      && lifecycle.completion !== "complete"
    )
    || (
      lifecycle.completion === "pending"
      && (
        lifecycle.disposition === "mapped"
        || lifecycle.disposition === "stale_mapping"
      )
    )
    || (
      lifecycle.parityStatus !== "pending"
      && (() => {
        try {
          assertParityAllowed(lifecycle, lifecycle.parityStatus);
          return false;
        } catch {
          return true;
        }
      })()
    )
    || (
      lifecycle.revision === 0
        ? lifecycle.appendIdempotencyKey === null
        : lifecycle.appendIdempotencyKey !== null
    )
    || (
      terminal === null
        ? lifecycle.terminalOperationId !== null
          || lifecycle.terminalOperationType !== null
          || lifecycle.terminalExpectedRevision !== null
          || lifecycle.terminalRequestDigest !== null
        : lifecycle.terminalOperationId === null
          || lifecycle.terminalOperationType !== terminal
          || lifecycle.terminalExpectedRevision !== lifecycle.revision
          || !validDigest(lifecycle.terminalRequestDigest)
    )
    || (
      (
        lifecycle.disposition === "blocked"
        || lifecycle.disposition === "quarantined"
      ) && lifecycle.failureCode === null
    )
    || (
      (
        lifecycle.disposition === "mapped"
        || lifecycle.disposition === "superseded"
        || lifecycle.disposition === "hard_delete"
      ) && lifecycle.failureCode !== null
    )
    || (
      lifecycle.failureCode === "retry_exhausted"
      && (
        lifecycle.disposition !== "quarantined"
        || lifecycle.attemptCount !== CONVERSATION_RECONCILE_MAX_ATTEMPTS
      )
    )
  ) throw new Error("Product message lifecycle state is incoherent");
}

function coordinatesSufficient(
  lifecycle: ConversationRevisionLifecycle,
): boolean {
  try {
    assertConversationSessionId(lifecycle.sessionId);
    assertConversationMessageId(lifecycle.messageId);
    assertConversationRevision(lifecycle.revision);
    return true;
  } catch {
    return false;
  }
}

function verifiedMatches(
  verified: VerifiedConversationCryptoRevision,
  lifecycle: ConversationRevisionLifecycle,
): boolean {
  return verified.objectId === lifecycle.cryptoObjectId
    && verified.namespaceId === lifecycle.namespaceIdAtAllocation
    && verified.objectType === CONVERSATION_MESSAGE_OBJECT_TYPE
    && verified.payloadVersion === CONVERSATION_MESSAGE_PAYLOAD_VERSION
    && verified.keyClass === lifecycle.keyClass;
}

function orphanReason(
  disposition: ConversationRevisionLifecycle["disposition"],
): "stale_mapping" | "superseded" | "hard_delete" | null {
  if (disposition === "superseded") return "superseded";
  if (disposition === "hard_delete") return "hard_delete";
  if (disposition === "stale_mapping") return "stale_mapping";
  return null;
}

function assertParityAllowed(
  lifecycle: ConversationRevisionLifecycle,
  parityStatus: Exclude<ConversationParityStatus, "pending">,
  repairPublication?: Parameters<
    ConversationRepository["completeRevision"]
  >[0]["repairPublication"],
): void {
  const allowed = parityStatus === "server_verified" || parityStatus === "server_authenticated"
    ? lifecycle.keyClass === "ai" && (
      lifecycle.authorRole !== "user"
      || (
        lifecycle.repairIdentityDigest !== null
        && repairPublication?.publisherKind === "foreground_runtime"
      )
    )
    : true;
  if (!allowed || !conversationVerificationMatchesRepresentation(
    lifecycle.representationMode, parityStatus,
  )) {
    throw new Error(
      "Conversation parity status is not allowed for author role and key class",
    );
  }
}

export function createDormantConversationShadowRepository(input: {
  readonly product: ConversationProductStorePort;
  readonly crypto: AtomicConversationCryptoCompletionPort;
}): ConversationRepository {
  if (
    input.product.roomNamespaceInvariant
      !== IMMUTABLE_ROOM_NAMESPACE_INVARIANT
  ) {
    throw new Error(
      "Conversation product store lacks immutable Room Namespace capability",
    );
  }

  async function quarantine(
    lifecycle: ConversationRevisionLifecycle,
    failureCode: ConversationFailureCode,
    leaseToken: string | null,
  ): Promise<void> {
    const result = await input.product.quarantineRevision({
      sessionId: lifecycle.sessionId,
      messageId: lifecycle.messageId,
      revision: lifecycle.revision,
      failureCode,
      leaseToken,
    });
    if (result === "conflict") {
      throw new Error("Conversation quarantine idempotency conflict");
    }
  }

  async function currentNamespace(
    lifecycle: ConversationRevisionLifecycle,
    leaseToken: string | null,
  ): Promise<string> {
    const namespaceId = await input.product.resolveCurrentNamespace(
      lifecycle.sessionId,
    );
    if (namespaceId === null) {
      await quarantine(lifecycle, "namespace_unresolved", leaseToken);
      throw new Error("Conversation Room Namespace is unresolved");
    }
    if (namespaceId !== lifecycle.namespaceIdAtAllocation) {
      await quarantine(lifecycle, "namespace_mismatch", leaseToken);
      throw new Error("Conversation Room Namespace invariant was violated");
    }
    return namespaceId;
  }

  function assertPrepared(
    lifecycle: ConversationRevisionLifecycle,
    prepared: PreparedConversationCryptoRevision,
  ): void {
    assertCanonicalLifecycle(lifecycle);
    if (prepared.objectId !== lifecycle.cryptoObjectId) {
      throw new Error(
        "Prepared message crypto object identity is not canonical",
      );
    }
    if (prepared.namespaceId !== lifecycle.namespaceIdAtAllocation) {
      throw new Error("Prepared message crypto Namespace mismatch");
    }
    if (
      prepared.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
      || prepared.payloadVersion !== CONVERSATION_MESSAGE_PAYLOAD_VERSION
    ) throw new Error("Prepared message crypto payload version is invalid");
    if (prepared.keyClass !== lifecycle.keyClass) {
      throw new Error("Prepared message crypto key class mismatch");
    }
  }

  async function verifyComplete(
    lifecycle: ConversationRevisionLifecycle,
    leaseToken: string | null,
  ): Promise<VerifiedConversationCryptoRevision> {
    let verified: VerifiedConversationCryptoRevision | null;
    try {
      verified = await input.crypto.verify(lifecycle.cryptoObjectId);
    } catch {
      await quarantine(lifecycle, "crypto_incomplete", leaseToken);
      throw new Error("Complete crypto revision is not verified");
    }
    if (verified === null || !verifiedMatches(verified, lifecycle)) {
      await quarantine(lifecycle, "crypto_mismatch", leaseToken);
      throw new Error("Complete crypto revision is not verified");
    }
    return verified;
  }

  async function classifiedMappingRace(
    lifecycle: ConversationRevisionLifecycle,
  ): Promise<"stale_mapping" | "superseded" | "hard_delete"> {
    const current = await input.product.getRevision(
      lifecycle.messageId,
      lifecycle.revision,
    );
    const reason = current === null
      ? null
      : orphanReason(current.lifecycle.disposition);
    return reason ?? "stale_mapping";
  }

  function publicationPolicyFor(lifecycle: ConversationRevisionLifecycle) {
    return lifecycle.publicationPolicyRevision === null ? undefined : {
      expectedRevision: lifecycle.publicationPolicyRevision,
      representation: lifecycle.representationMode === "full_encryption"
        ? "protected_only" as const : "ordinary_and_protected" as const,
    };
  }

  async function publishVerified(
    lifecycle: ConversationRevisionLifecycle,
    parityStatus: ConversationParityStatus,
    leaseToken: string | null,
    repairPublication?: Parameters<
      ConversationRepository["completeRevision"]
    >[0]["repairPublication"],
    preparedPublicationPolicy?: Parameters<
      ConversationRepository["completeRevision"]
    >[0]["publicationPolicy"],
  ): Promise<ConversationCompletionResult> {
    const publicationPolicy = preparedPublicationPolicy
      ?? publicationPolicyFor(lifecycle);
    const marked = await input.product.markCryptoComplete({
      sessionId: lifecycle.sessionId,
      messageId: lifecycle.messageId,
      revision: lifecycle.revision,
      cryptoObjectId: lifecycle.cryptoObjectId,
      parityStatus,
      leaseToken,
      ...(publicationPolicy === undefined ? {} : { publicationPolicy }),
      ...(repairPublication === undefined ? {} : { repairPublication }),
    });
    if (marked === "missing" || marked === "conflict") {
      throw new Error(`Message crypto completion receipt failed: ${marked}`);
    }
    const dispositionReason = orphanReason(lifecycle.disposition);
    if (dispositionReason !== null) {
      return Object.freeze({
        status: "orphaned",
        reason: dispositionReason,
        messageId: lifecycle.messageId,
        revision: lifecycle.revision,
        cryptoObjectId: lifecycle.cryptoObjectId,
      });
    }
    if (
      lifecycle.disposition === "quarantined"
      || lifecycle.disposition === "blocked"
    ) {
      throw new Error(
        "Unavailable message revision cannot publish a crypto mapping",
      );
    }
    const mapped = await input.product.compareAndSwapCryptoMapping({
      sessionId: lifecycle.sessionId,
      messageId: lifecycle.messageId,
      revision: lifecycle.revision,
      expectedNamespaceId: lifecycle.namespaceIdAtAllocation,
      cryptoObjectId: lifecycle.cryptoObjectId,
      leaseToken,
      ...(publicationPolicy === undefined ? {} : { publicationPolicy }),
    });
    if (mapped === "lease_lost") {
      throw new Error("Conversation mapping lease was lost");
    }
    if (
      mapped === "stale"
      || mapped === "missing"
      || mapped === "wrong_namespace"
    ) {
      return Object.freeze({
        status: "orphaned",
        reason: await classifiedMappingRace(lifecycle),
        messageId: lifecycle.messageId,
        revision: lifecycle.revision,
        cryptoObjectId: lifecycle.cryptoObjectId,
      });
    }
    return Object.freeze({
      status: mapped === "duplicate" ? "replayed" : "mapped",
      messageId: lifecycle.messageId,
      revision: lifecycle.revision,
      cryptoObjectId: lifecycle.cryptoObjectId,
    });
  }

  async function failClaim(
    lifecycle: ConversationRevisionLifecycle,
    leaseToken: string,
    failureCode: ConversationFailureCode,
  ): Promise<ConversationReconciliationOutcome> {
    const failed = await input.product.failReconciliationClaim({
      sessionId: lifecycle.sessionId,
      messageId: lifecycle.messageId,
      revision: lifecycle.revision,
      leaseToken,
      failureCode,
    });
    if (failed === null) {
      const refreshed = await input.product.getRevision(
        lifecycle.messageId,
        lifecycle.revision,
      );
      if (refreshed === null) return "orphaned";
      if (refreshed.lifecycle.disposition === "mapped") return "mapped";
      if (refreshed.lifecycle.disposition === "blocked") return "blocked";
      if (refreshed.lifecycle.disposition === "quarantined") {
        return "quarantined";
      }
      if (orphanReason(refreshed.lifecycle.disposition) !== null) {
        return "orphaned";
      }
      return "pending";
    }
    if (failed.disposition === "blocked") return "blocked";
    if (failed.disposition === "quarantined") return "quarantined";
    if (failed.disposition === "mapped") return "mapped";
    if (orphanReason(failed.disposition) !== null) return "orphaned";
    return "pending";
  }

  async function reconcileOne(
    state: ConversationRevisionState,
    leaseToken: string,
  ): Promise<ConversationReconciliationOutcome> {
    const lifecycle = state.lifecycle;
    if (lifecycle.disposition === "quarantined") return "quarantined";
    if (lifecycle.disposition === "blocked") return "blocked";
    if (orphanReason(lifecycle.disposition) !== null) return "orphaned";
    let namespaceId: string | null;
    try {
      namespaceId = await input.product.resolveCurrentNamespace(
        lifecycle.sessionId,
      );
    } catch {
      return failClaim(
        lifecycle,
        leaseToken,
        "storage_transient",
      );
    }
    if (namespaceId === null) {
      return failClaim(
        lifecycle,
        leaseToken,
        "namespace_unresolved",
      );
    }
    if (namespaceId !== lifecycle.namespaceIdAtAllocation) {
      await quarantine(lifecycle, "namespace_mismatch", leaseToken);
      return "quarantined";
    }
    let verified: VerifiedConversationCryptoRevision | null;
    try {
      verified = await input.crypto.verify(lifecycle.cryptoObjectId);
    } catch {
      return failClaim(
        lifecycle,
        leaseToken,
        "storage_transient",
      );
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
    if (!verifiedMatches(verified, lifecycle)) {
      await quarantine(lifecycle, "crypto_mismatch", leaseToken);
      return "quarantined";
    }
    try {
      const result = await publishVerified(
        lifecycle,
        lifecycle.parityStatus,
        leaseToken,
      );
      return result.status === "orphaned" ? "orphaned" : "mapped";
    } catch {
      return failClaim(
        lifecycle,
        leaseToken,
        "storage_transient",
      );
    }
  }

  async function reconcileBeforeMutation(
    state: ConversationRevisionState,
  ): Promise<void> {
    const lifecycle = state.lifecycle;
    if (
      lifecycle.disposition !== "active"
      && lifecycle.disposition !== "mapped"
    ) return;
    await currentNamespace(lifecycle, null);
    const verified = await input.crypto.verify(lifecycle.cryptoObjectId);
    if (verified === null) {
      if (lifecycle.completion === "pending") return;
      await quarantine(lifecycle, "crypto_incomplete", null);
      throw new Error(
        "Message revision could not be verified before mutation",
      );
    }
    if (!verifiedMatches(verified, lifecycle)) {
      await quarantine(lifecycle, "crypto_mismatch", null);
      throw new Error(
        "Message revision could not be verified before mutation",
      );
    }
    await publishVerified(lifecycle, lifecycle.parityStatus, null);
  }

  return Object.freeze({
    async append(request: Parameters<ConversationRepository["append"]>[0]) {
      assertConversationSessionId(request.sessionId);
      assertConversationDurableKey(
        "message idempotency key",
        request.idempotencyKey,
      );
      assertConversationMessageKeyClass(request.keyClass);
      assertConversationAuthorRole(request.authorRole);
      assertConversationNotificationEligibility(
        request.structuralProjection.notificationEligibility,
      );
      assertConversationSubthreadReplyClassification(
        request.structuralProjection.subthreadReplyClassification,
      );
      const result = await input.product.appendAllocated({
        ...request,
        requestDigest: conversationAppendRequestDigest(request),
      });
      if (result.status === "conflict") {
        throw new Error("Message append idempotency conflict");
      }
      assertCanonicalLifecycle(result.lifecycle);
      if (result.lifecycle.sessionId !== request.sessionId) {
        throw new Error("Product message allocation coordinates disagree");
      }
      if (result.lifecycle.disposition === "mapped") {
        await currentNamespace(result.lifecycle, null);
        await verifyComplete(result.lifecycle, null);
      }
      return allocated(result.status, result.lifecycle);
    },

    async completeRevision(
      request: Parameters<ConversationRepository["completeRevision"]>[0],
    ) {
      assertConversationMessageId(request.messageId);
      assertConversationRevision(request.expectedRevision);
      const state = await input.product.getRevision(
        request.messageId,
        request.expectedRevision,
      );
      if (state === null) throw new Error("Message revision is missing");
      const lifecycle = state.lifecycle;
      if (
        lifecycle.messageId !== request.messageId
        || lifecycle.revision !== request.expectedRevision
      ) {
        throw new Error("Product message revision coordinates disagree");
      }
      assertPrepared(lifecycle, request.prepared);
      const existingOrphan = orphanReason(lifecycle.disposition);
      if (existingOrphan !== null) {
        if (lifecycle.completion === "complete") {
          await currentNamespace(lifecycle, null);
          await verifyComplete(lifecycle, null);
        }
        return Object.freeze({
          status: "orphaned",
          reason: existingOrphan,
          messageId: lifecycle.messageId,
          revision: lifecycle.revision,
          cryptoObjectId: lifecycle.cryptoObjectId,
        });
      }
      if (
        lifecycle.disposition === "quarantined"
        || lifecycle.disposition === "blocked"
      ) {
        throw new Error("Unavailable message revision cannot be completed");
      }
      assertParityAllowed(
        lifecycle,
        request.parityStatus,
        request.repairPublication,
      );
      if (
        request.repairPublication !== undefined
        && lifecycle.publicationPolicyRevision === null
        && request.publicationPolicy === undefined
      ) {
        throw new Error(
          "Historical repair requires its current prepared publication policy",
        );
      }
      await currentNamespace(lifecycle, null);

      if (lifecycle.disposition === "mapped") {
        await verifyComplete(lifecycle, null);
        const publicationPolicy = request.publicationPolicy
          ?? publicationPolicyFor(lifecycle);
        await input.product.markCryptoComplete({
          sessionId: lifecycle.sessionId,
          messageId: lifecycle.messageId,
          revision: lifecycle.revision,
          cryptoObjectId: lifecycle.cryptoObjectId,
          parityStatus: request.parityStatus,
          leaseToken: null,
          ...(publicationPolicy === undefined ? {} : { publicationPolicy }),
          ...(request.repairPublication === undefined
            ? {}
            : { repairPublication: request.repairPublication }),
        });
        return Object.freeze({
          status: "replayed",
          messageId: lifecycle.messageId,
          revision: lifecycle.revision,
          cryptoObjectId: lifecycle.cryptoObjectId,
        });
      }
      await input.crypto.complete(request.prepared);
      await verifyComplete(lifecycle, null);
      return publishVerified(
        lifecycle,
        request.parityStatus,
        null,
        request.repairPublication,
        request.publicationPolicy,
      );
    },

    async edit(request: Parameters<ConversationRepository["edit"]>[0]) {
      assertConversationMessageId(request.messageId);
      assertConversationRevision(request.expectedRevision);
      assertConversationDurableKey(
        "message edit operation id",
        request.operationId,
      );
      assertConversationSubthreadReplyClassification(
        request.subthreadReplyClassification,
      );
      const state = await input.product.getRevision(
        request.messageId,
        request.expectedRevision,
      );
      if (state === null) throw new Error("Message edit target is missing");
      assertCanonicalLifecycle(state.lifecycle);
      await reconcileBeforeMutation(state);
      const result = await input.product.editAllocated({
        ...request,
        requestDigest: conversationEditRequestDigest(request),
      });
      if (result.status === "missing") {
        throw new Error("Message edit target is missing");
      }
      if (result.status === "stale") throw new Error("Stale edit revision");
      if (result.status === "conflict") {
        throw new Error("Message edit idempotency conflict");
      }
      if (!("lifecycles" in result)) {
        throw new Error("Message edit returned an invalid result");
      }
      const lifecycle = result.lifecycles.find(
        (candidate) => candidate.messageId === request.messageId,
      );
      if (lifecycle === undefined) {
        throw new Error("Message edit omitted its requested physical row");
      }
      for (const candidate of result.lifecycles) {
        assertCanonicalLifecycle(candidate);
        if (candidate.disposition === "mapped") {
          await currentNamespace(candidate, null);
          await verifyComplete(candidate, null);
        }
      }
      const allocations = Object.freeze(
        result.lifecycles.map((candidate) =>
          allocated(result.status, candidate)
        ),
      );
      return Object.freeze({
        ...allocated(result.status, lifecycle),
        allocations,
      });
    },

    async hardDelete(
      request: Parameters<ConversationRepository["hardDelete"]>[0],
    ) {
      assertConversationMessageId(request.messageId);
      assertConversationRevision(request.expectedRevision);
      assertConversationDurableKey(
        "message delete operation id",
        request.operationId,
      );
      const state = await input.product.getRevision(
        request.messageId,
        request.expectedRevision,
      );
      if (state !== null && state.message !== null) {
        assertCanonicalLifecycle(state.lifecycle);
        await reconcileBeforeMutation(state);
      }
      const result = await input.product.hardDelete({
        ...request,
        requestDigest: conversationDeleteRequestDigest(request),
      });
      if (result.status === "conflict") {
        throw new Error("Message delete idempotency conflict");
      }
      if (
        result.status === "missing"
        || result.status === "stale"
        || result.status === "message_anchors_thread"
      ) {
        return Object.freeze({
          status: result.status,
          messageId: request.messageId,
        });
      }
      if (!("lifecycle" in result)) {
        throw new Error("Message delete returned an invalid result");
      }
      return Object.freeze({
        status: result.status,
        messageId: result.lifecycle.messageId,
        revision: result.lifecycle.revision,
        cryptoObjectId: result.lifecycle.cryptoObjectId,
        effects: result.effects,
      });
    },

    async reconcilePending(
      request: Parameters<ConversationRepository["reconcilePending"]>[0],
    ) {
      const limit = checkedLimit(request.limit);
      const lease = checkedLease(request);
      const candidates = await input.product.claimReconciliationCandidates({
        ...lease,
        limit,
      });
      if (candidates.length > limit) {
        throw new Error(
          "Conversation product adapter returned more rows than requested",
        );
      }
      const outcomes: {
        sequence: number;
        messageId: number;
        revision: number;
        outcome: ConversationReconciliationOutcome;
      }[] = [];
      let contractFault: Error | null = null;
      let previousDue = Number.NEGATIVE_INFINITY;
      let previousSequence = 0;
      for (const candidate of candidates) {
        const lifecycle = candidate.lifecycle;
        const enoughCoordinates = coordinatesSufficient(lifecycle);
        try {
          assertCanonicalLifecycle(lifecycle);
          if (lifecycle.leaseToken !== lease.leaseToken) {
            throw new Error(
              "Claimed conversation lifecycle has the wrong lease",
            );
          }
          const due = lifecycle.nextAttemptAt?.getTime()
            ?? Number.NEGATIVE_INFINITY;
          if (
            due < previousDue
            || (due === previousDue
              && lifecycle.sequence <= previousSequence)
          ) {
            throw new Error(
              "Claimed conversation lifecycles are not stably ordered",
            );
          }
          previousDue = due;
          previousSequence = lifecycle.sequence;
        } catch (cause) {
          if (enoughCoordinates) {
            await quarantine(
              lifecycle,
              "crypto_mismatch",
              lease.leaseToken,
            );
            outcomes.push({
              sequence: lifecycle.sequence,
              messageId: lifecycle.messageId,
              revision: lifecycle.revision,
              outcome: "quarantined",
            });
          } else {
            contractFault ??= new Error(
              "Claimed conversation lifecycle has invalid coordinates",
              { cause },
            );
          }
          continue;
        }
        outcomes.push({
          sequence: lifecycle.sequence,
          messageId: lifecycle.messageId,
          revision: lifecycle.revision,
          outcome: await reconcileOne(
            candidate,
            lease.leaseToken,
          ),
        });
      }
      if (contractFault !== null) throw contractFault;
      return Object.freeze({
        outcomes: Object.freeze(
          outcomes.map((outcome) => Object.freeze(outcome)),
        ),
      });
    },
  });
}
