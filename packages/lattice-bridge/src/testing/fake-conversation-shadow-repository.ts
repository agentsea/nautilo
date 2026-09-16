import {
  InMemoryLatticeStore,
  persistPreparedAgentObjectAccessManifestGenesis,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  persistPreparedObjectAccessManifestGenesis,
  type LatticeCrypto,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV2,
  decodeObjectAccessManifestV3,
} from "@nautilo/lattice-crypto/wire";
import {
  createPreparedConversationCryptoRevision,
  readPreparedConversationCryptoRevisionSnapshot,
  type AgentConversationCryptoRevisionSnapshot,
  type ConversationCryptoRevisionSnapshot,
  type DeviceWrappedLiveShadowAgentConversationCryptoRevisionSnapshot,
  type PreparedConversationCryptoRevisionSnapshot,
} from "../message/conversation-prepared-revision.ts";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
  CONVERSATION_RECONCILE_MAX_ATTEMPTS,
  CONVERSATION_RECONCILE_LEASE_SECONDS,
  IMMUTABLE_ROOM_NAMESPACE_INVARIANT,
  assertConversationDurableKey,
  assertConversationSessionId,
  deriveMessageCryptoObjectIdV2,
  deriveLiveShadowMessageCryptoObjectIdV1,
  type AtomicConversationCryptoCompletionPort,
  type ConversationDeleteEffects,
  type ConversationFailureCode,
  type ConversationMessageKeyClass,
  type ConversationProductAppendInput,
  type ConversationProductAppendResult,
  type ConversationProductDeleteResult,
  type ConversationProductEditResult,
  type ConversationProductMappingCasResult,
  type ConversationOrdinaryRepairInput,
  type ConversationProductMessage,
  type ConversationProductStorePort,
  type ConversationLiveShadowAgentPublishInput,
  type ConversationLiveShadowAgentEvidenceInput,
  type ConversationLiveShadowAgentEvidenceResult,
  type ConversationLiveShadowAgentReservationInput,
  type ConversationLiveShadowAgentReservationResult,
  type ConversationRevisionLifecycle,
  type ConversationRevisionState,
  type PreparedConversationCryptoRevision,
  type VerifiedConversationCryptoRevision,
} from "../message/conversation-repository.ts";
import {
  createDormantConversationShadowRepository,
} from "../message/conversation-shadow-saga.ts";

function copyBytes(value: Uint8Array): Uint8Array {
  return value.slice();
}

function copyNullableBytes(value: Uint8Array | null): Uint8Array | null {
  return value === null ? null : copyBytes(value);
}

function copyDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

function cloneMessage(
  message: ConversationProductMessage,
): ConversationProductMessage {
  return Object.freeze({ ...message });
}

function cloneLifecycle(
  lifecycle: ConversationRevisionLifecycle,
): ConversationRevisionLifecycle {
  return Object.freeze({
    ...lifecycle,
    nextAttemptAt: copyDate(lifecycle.nextAttemptAt),
    leaseExpiresAt: copyDate(lifecycle.leaseExpiresAt),
    shadowReservedCreatedAt: copyDate(lifecycle.shadowReservedCreatedAt),
    shadowStreamStartDigest: copyNullableBytes(
      lifecycle.shadowStreamStartDigest,
    ),
    shadowStreamTerminalDigest: copyNullableBytes(
      lifecycle.shadowStreamTerminalDigest,
    ),
    shadowStreamedTextDigest: copyNullableBytes(
      lifecycle.shadowStreamedTextDigest,
    ),
    shadowDurableEventDigest: copyNullableBytes(
      lifecycle.shadowDurableEventDigest,
    ),
    allocationRequestDigest: copyBytes(lifecycle.allocationRequestDigest),
    repairIdentityDigest: copyNullableBytes(lifecycle.repairIdentityDigest),
    repairAttestationDigest: copyNullableBytes(
      lifecycle.repairAttestationDigest,
    ),
    terminalRequestDigest: copyNullableBytes(lifecycle.terminalRequestDigest),
  });
}

function cloneDeleteEffects(
  effects: ConversationDeleteEffects,
): ConversationDeleteEffects {
  return Object.freeze({
    ...effects,
    rootSummary: effects.rootSummary === null
      ? null
      : Object.freeze({
        ...effects.rootSummary,
        lastReplyAt: copyDate(effects.rootSummary.lastReplyAt),
      }),
  });
}

function lifecycleKey(messageId: number, revision: number): string {
  return `${messageId}:${revision}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function byteArraysEqual(
  left: readonly Uint8Array[],
  right: readonly Uint8Array[],
): boolean {
  return left.length === right.length
    && left.every((bytes, index) => bytesEqual(bytes, right[index]!));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function validRequestDigest(value: Uint8Array): boolean {
  return value instanceof Uint8Array && value.length === 32;
}

interface FakeSession {
  readonly sessionId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly ownerId?: string;
}

interface FakeMessageStructuralFacts {
  readonly fingerprint: string | null;
  readonly createdAt: Date;
}

interface AppendReceipt {
  readonly requestDigest: Uint8Array;
  readonly lifecycleKey: string;
}

interface EditReceipt {
  readonly messageId: number;
  readonly expectedRevision: number;
  readonly requestDigest: Uint8Array;
  readonly lifecycleKeys: readonly string[];
}

interface QuarantineReceipt {
  readonly leaseToken: string | null;
  readonly failureCode: ConversationFailureCode;
}

interface DeleteReceipt {
  readonly messageId: number;
  readonly expectedRevision: number;
  readonly requestDigest: Uint8Array;
  readonly lifecycleKey: string;
  readonly effects: ConversationDeleteEffects;
}

export class FakeConversationProductStore
  implements ConversationProductStorePort
{
  readonly completionPublicationPolicies: Array<
    ConversationProductAppendInput["publicationPolicy"]
  > = [];
  readonly mappingPublicationPolicies: Array<
    ConversationProductAppendInput["publicationPolicy"]
  > = [];
  readonly ordinaryRepairInputs: ConversationOrdinaryRepairInput[] = [];
  readonly roomNamespaceInvariant = IMMUTABLE_ROOM_NAMESPACE_INVARIANT;
  readonly #events: string[];
  readonly #sessions = new Map<string, FakeSession>();
  readonly #messages = new Map<number, ConversationProductMessage>();
  readonly #messageStructuralFacts =
    new Map<number, FakeMessageStructuralFacts>();
  readonly #lifecycles = new Map<string, ConversationRevisionLifecycle>();
  readonly #objectOwners = new Map<string, string>();
  readonly #appendReceipts = new Map<string, AppendReceipt>();
  readonly #editReceipts = new Map<string, EditReceipt>();
  readonly #deleteReceipts = new Map<string, DeleteReceipt>();
  readonly #quarantineReceipts = new Map<string, QuarantineReceipt>();
  #nextMessageId = 1;
  #nextSequence = 1;
  #failAppend = false;
  #tooManyCandidates = false;
  #malformedClaim: "crypto_object_id" | "coordinates" | null = null;
  #nextMappingCasResult: ConversationProductMappingCasResult | null = null;
  #throwAfterAppendCommit = false;
  #throwAfterEditCommit = false;
  #throwAfterMarkCompleteCommit = false;
  #throwAfterMappingCommit = false;
  #throwAfterDeleteCommit = false;
  readonly #now: () => Date;

  constructor(events: string[], now: () => Date = () => new Date()) {
    this.#events = events;
    this.#now = now;
  }

  addSession(input: FakeSession): void {
    assertConversationSessionId(input.sessionId);
    const current = this.#sessions.get(input.sessionId);
    if (
      current !== undefined
      && (
        current.roomId !== input.roomId
        || current.namespaceId !== input.namespaceId
      )
    ) {
      throw new Error("Immutable Room Namespace cannot be changed");
    }
    this.#sessions.set(input.sessionId, Object.freeze({
      ...input,
      ownerId: input.ownerId ?? input.sessionId,
    }));
  }

  changeSessionNamespace(_sessionId: string, _namespaceId: string): never {
    throw new Error("Immutable Room Namespace cannot be changed");
  }

  peekMessage(messageId: number): ConversationProductMessage | null {
    const message = this.#messages.get(messageId);
    return message === undefined ? null : cloneMessage(message);
  }

  peekLifecycle(
    messageId: number,
    revision: number,
  ): ConversationRevisionLifecycle | null {
    const lifecycle = this.#lifecycles.get(
      lifecycleKey(messageId, revision),
    );
    return lifecycle === undefined ? null : cloneLifecycle(lifecycle);
  }

  receiptSnapshotForTesting(): readonly Readonly<{
    kind: "append" | "edit" | "delete";
    requestDigestHex: string;
  }>[] {
    return Object.freeze([
      ...Array.from(this.#appendReceipts.values(), (receipt) =>
        Object.freeze({
          kind: "append" as const,
          requestDigestHex: bytesToHex(receipt.requestDigest),
        })
      ),
      ...Array.from(this.#editReceipts.values(), (receipt) =>
        Object.freeze({
          kind: "edit" as const,
          requestDigestHex: bytesToHex(receipt.requestDigest),
        })
      ),
      ...Array.from(this.#deleteReceipts.values(), (receipt) =>
        Object.freeze({
          kind: "delete" as const,
          requestDigestHex: bytesToHex(receipt.requestDigest),
        })
      ),
    ]);
  }

  failNextAppendTransaction(): void {
    this.#failAppend = true;
  }

  failNextMappingCas(): void {
    this.throwAfterNextMappingCommit();
  }

  returnNextMappingCas(result: ConversationProductMappingCasResult): void {
    this.#nextMappingCasResult = result;
  }

  returnTooManyReconciliationCandidates(): void {
    this.#tooManyCandidates = true;
  }

  malformNextClaimCandidate(
    kind: "crypto_object_id" | "coordinates",
  ): void {
    this.#malformedClaim = kind;
  }

  throwAfterNextAppendCommit(): void {
    this.#throwAfterAppendCommit = true;
  }

  throwAfterNextEditCommit(): void {
    this.#throwAfterEditCommit = true;
  }

  throwAfterNextMarkCompleteCommit(): void {
    this.#throwAfterMarkCompleteCommit = true;
  }

  throwAfterNextMappingCommit(): void {
    this.#throwAfterMappingCommit = true;
  }

  throwAfterNextDeleteCommit(): void {
    this.#throwAfterDeleteCommit = true;
  }

  reserveLiveShadowAgent(
    input: ConversationLiveShadowAgentReservationInput,
  ): Promise<ConversationLiveShadowAgentReservationResult> {
    const session = this.#sessions.get(input.sessionId);
    if (session === undefined) return Promise.resolve({ status: "stale" });
    const replay = Array.from(this.#lifecycles.values()).find((lifecycle) =>
      lifecycle.shadowOperationId === input.operationId
      && lifecycle.shadowTranscriptOrdinal === input.transcriptOrdinal
    );
    if (replay !== undefined) {
      const expectedRepresentationMode = input.publicationPolicy?.representation === "protected_only"
        ? "full_encryption"
        : "shadow_encryption";
      const expectedPolicyRevision = expectedRepresentationMode === "full_encryption"
        ? input.publicationPolicy!.expectedRevision
        : null;
      if (
        replay.sessionId !== input.sessionId
        || replay.authorRole !== input.authorRole
        || replay.shadowReservedCreatedAt?.getTime() !== input.createdAt
        || replay.representationMode !== expectedRepresentationMode
        || replay.publicationPolicyRevision !== expectedPolicyRevision
        || !bytesEqual(replay.allocationRequestDigest, input.requestDigest)
      ) return Promise.resolve({ status: "conflict" });
      return Promise.resolve({
        status: "replayed",
        allocation: {
          status: "replayed",
          sessionId: replay.sessionId,
          messageId: replay.messageId,
          revision: replay.revision,
          roomId: replay.roomId,
          namespaceId: replay.namespaceIdAtAllocation,
          keyClass: replay.keyClass,
          authorRole: replay.authorRole,
          cryptoObjectId: replay.cryptoObjectId,
        },
        createdAt: input.createdAt,
      });
    }
    const messageId = this.#nextMessageId++;
    const cryptoObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
      operationId: input.operationId,
      sessionId: input.sessionId,
      messageId,
      revision: 0,
      transcriptOrdinal: input.transcriptOrdinal,
      authorRole: input.authorRole,
    });
    const lifecycle = cloneLifecycle({
      sessionId: input.sessionId,
      messageId,
      revision: 0,
      sequence: this.#nextSequence++,
      roomId: session.roomId,
      namespaceIdAtAllocation: session.namespaceId,
      cryptoObjectId,
      objectIdScheme: "live_shadow_v1",
      representationMode: input.publicationPolicy?.representation === "protected_only"
        ? "full_encryption"
        : "shadow_encryption",
      publicationPolicyRevision: input.publicationPolicy?.representation === "protected_only"
        ? input.publicationPolicy.expectedRevision
        : null,
      shadowOperationId: input.operationId,
      humanPeerShadowOperationId: null,
      sharedAgentShadowOperationId: null,
      sharedAgentShadowExecutionId: null,
      shadowTranscriptOrdinal: input.transcriptOrdinal,
      shadowReservedCreatedAt: new Date(input.createdAt),
      shadowStreamId: null,
      shadowStreamStartDigest: null,
      shadowStreamTerminalDigest: null,
      shadowStreamedTextDigest: null,
      shadowDurableEventDigest: null,
      keyClass: "ai",
      authorRole: input.authorRole,
      subthreadReplyClassification: input.subthreadReplyClassification,
      completion: "pending",
      disposition: "active",
      parityStatus: "pending",
      attemptCount: 0,
      nextAttemptAt: this.#now(),
      failureCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
      appendIdempotencyKey:
        `live-agent:${input.operationId}:${input.transcriptOrdinal}`,
      allocationRequestDigest: input.requestDigest,
      repairIdentityDigest: null,
      repairPublisherKind: null,
      repairPublisherId: null,
      repairAttestationDigest: null,
      terminalOperationId: null,
      terminalOperationType: null,
      terminalExpectedRevision: null,
      terminalRequestDigest: null,
    });
    const key = lifecycleKey(messageId, 0);
    this.#lifecycles.set(key, lifecycle);
    this.#objectOwners.set(cryptoObjectId, key);
    return Promise.resolve({
      status: "reserved",
      allocation: {
        status: "allocated",
        sessionId: input.sessionId,
        messageId,
        revision: 0,
        roomId: session.roomId,
        namespaceId: session.namespaceId,
        keyClass: "ai",
        authorRole: input.authorRole,
        cryptoObjectId,
      },
      createdAt: input.createdAt,
    });
  }

  publishReservedLiveShadowAgent(
    input: ConversationLiveShadowAgentPublishInput,
  ): Promise<ConversationProductAppendResult> {
    const lifecycle = this.#lifecycles.get(
      lifecycleKey(input.reservedMessageId, 0),
    );
    if (
      lifecycle === undefined
      || lifecycle.shadowOperationId !== input.operationId
      || lifecycle.shadowTranscriptOrdinal !== input.transcriptOrdinal
      || lifecycle.shadowReservedCreatedAt?.getTime()
        !== input.reservedCreatedAt
      || lifecycle.cryptoObjectId !== input.cryptoObjectId
      || !bytesEqual(
        lifecycle.allocationRequestDigest,
        input.reservationDigest,
      )
    ) return Promise.resolve({ status: "conflict" });
    const current = this.#messages.get(input.reservedMessageId);
    if (current !== undefined) {
      return current.content === input.content
        && current.authorRole === input.authorRole
        ? Promise.resolve({ status: "replayed", lifecycle })
        : Promise.resolve({ status: "conflict" });
    }
    this.#messages.set(input.reservedMessageId, cloneMessage({
      sessionId: input.sessionId,
      messageId: input.reservedMessageId,
      roomId: lifecycle.roomId,
      content: input.content,
      revision: 0,
      keyClass: "ai",
      authorRole: input.authorRole,
      cryptoObjectId: null,
    }));
    this.#messageStructuralFacts.set(
      input.reservedMessageId,
      Object.freeze({ fingerprint: input.fingerprint, createdAt: new Date(input.reservedCreatedAt) }),
    );
    return Promise.resolve({ status: "allocated", lifecycle });
  }

  recordLiveShadowAgentEvidence(
    input: ConversationLiveShadowAgentEvidenceInput,
  ): Promise<ConversationLiveShadowAgentEvidenceResult> {
    const key = lifecycleKey(input.messageId, 0);
    const lifecycle = this.#lifecycles.get(key);
    if (
      lifecycle === undefined
      || lifecycle.sessionId !== input.sessionId
      || lifecycle.shadowOperationId !== input.operationId
      || lifecycle.shadowTranscriptOrdinal !== input.transcriptOrdinal
      || lifecycle.completion !== "complete"
      || lifecycle.disposition !== "mapped"
      || lifecycle.parityStatus !== "server_verified"
    ) return Promise.resolve("conflict");
    const exact = lifecycle.shadowDurableEventDigest !== null
      && bytesEqual(
        lifecycle.shadowDurableEventDigest,
        input.durableEventDigest,
      )
      && (lifecycle.shadowStreamId === null
        ? input.streamEvidence === null
        : input.streamEvidence !== null
          && lifecycle.shadowStreamId === input.streamEvidence.streamId
          && lifecycle.shadowStreamStartDigest !== null
          && bytesEqual(
            lifecycle.shadowStreamStartDigest,
            input.streamEvidence.startDigest,
          )
          && lifecycle.shadowStreamTerminalDigest !== null
          && bytesEqual(
            lifecycle.shadowStreamTerminalDigest,
            input.streamEvidence.terminalDigest,
          )
          && lifecycle.shadowStreamedTextDigest !== null
          && bytesEqual(
            lifecycle.shadowStreamedTextDigest,
            input.streamEvidence.streamedTextDigest,
          ));
    if (lifecycle.shadowDurableEventDigest !== null) {
      return Promise.resolve(exact ? "duplicate" : "conflict");
    }
    this.#lifecycles.set(key, cloneLifecycle({
      ...lifecycle,
      shadowStreamId: input.streamEvidence?.streamId ?? null,
      shadowStreamStartDigest: input.streamEvidence?.startDigest ?? null,
      shadowStreamTerminalDigest: input.streamEvidence?.terminalDigest ?? null,
      shadowStreamedTextDigest:
        input.streamEvidence?.streamedTextDigest ?? null,
      shadowDurableEventDigest: input.durableEventDigest,
    }));
    return Promise.resolve("applied");
  }

  appendAllocated(
    input: ConversationProductAppendInput,
  ): Promise<ConversationProductAppendResult> {
    this.#events.push("product.append");
    assertConversationSessionId(input.sessionId);
    assertConversationDurableKey(
      "message idempotency key",
      input.idempotencyKey,
    );
    if (!validRequestDigest(input.requestDigest)) {
      throw new TypeError("Append request digest must contain 32 bytes");
    }
    const session = this.#sessions.get(input.sessionId);
    if (session === undefined) {
      return Promise.reject(new Error("Conversation Session is missing"));
    }
    const receiptKey = `${input.sessionId}\u0000${input.idempotencyKey}`;
    const receipt = this.#appendReceipts.get(receiptKey);
    if (receipt !== undefined) {
      if (!bytesEqual(receipt.requestDigest, input.requestDigest)) {
        return Promise.resolve({ status: "conflict" });
      }
      const lifecycle = this.#lifecycles.get(receipt.lifecycleKey);
      if (lifecycle === undefined) {
        return Promise.reject(
          new Error("Append receipt lost its product lifecycle"),
        );
      }
      return Promise.resolve({
        status: "replayed",
        lifecycle: cloneLifecycle(lifecycle),
      });
    }

    const liveCoordinate = input.liveShadow
      ?? input.humanPeerLiveShadow
      ?? input.sharedAgentLiveShadow;
    const messageId = liveCoordinate?.reservedMessageId
      ?? this.#nextMessageId++;
    this.#nextMessageId = Math.max(this.#nextMessageId, messageId + 1);
    const revision = 0;
    const sequence = this.#nextSequence++;
    if (this.#failAppend) {
      this.#failAppend = false;
      throw new Error("Append transaction failed (injected)");
    }
    const cryptoObjectId = liveCoordinate?.cryptoObjectId
      ?? deriveMessageCryptoObjectIdV2({
        sessionId: input.sessionId,
        messageId,
        revision,
      });
    const message = cloneMessage({
      sessionId: input.sessionId,
      messageId,
      roomId: session.roomId,
      content: input.content,
      revision,
      keyClass: input.keyClass,
      authorRole: input.authorRole,
      cryptoObjectId: null,
    });
    const lifecycle = cloneLifecycle({
      sessionId: input.sessionId,
      messageId,
      revision,
      sequence,
      roomId: session.roomId,
      namespaceIdAtAllocation: session.namespaceId,
      cryptoObjectId,
      objectIdScheme: liveCoordinate === undefined
        ? "message_v2"
        : "live_shadow_v1",
      representationMode: input.publicationPolicy?.representation === "protected_only"
        ? "full_encryption"
        : "shadow_encryption",
      publicationPolicyRevision: input.publicationPolicy?.representation === "protected_only"
        ? input.publicationPolicy.expectedRevision
        : null,
      shadowOperationId: input.liveShadow?.operationId ?? null,
      humanPeerShadowOperationId:
        input.humanPeerLiveShadow?.operationId ?? null,
      sharedAgentShadowOperationId:
        input.sharedAgentLiveShadow?.operationId ?? null,
      sharedAgentShadowExecutionId: null,
      shadowTranscriptOrdinal: liveCoordinate?.transcriptOrdinal ?? null,
      shadowReservedCreatedAt: liveCoordinate === undefined
        ? null
        : new Date(liveCoordinate.createdAt),
      shadowStreamId: null,
      shadowStreamStartDigest: null,
      shadowStreamTerminalDigest: null,
      shadowStreamedTextDigest: null,
      shadowDurableEventDigest: null,
      keyClass: input.keyClass,
      authorRole: input.authorRole,
      subthreadReplyClassification:
        input.structuralProjection.subthreadReplyClassification,
      completion: "pending",
      disposition: "active",
      parityStatus: "pending",
      attemptCount: 0,
      nextAttemptAt: this.#now(),
      failureCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
      appendIdempotencyKey: input.idempotencyKey,
      allocationRequestDigest: input.requestDigest,
      repairIdentityDigest: null,
      repairPublisherKind: null,
      repairPublisherId: null,
      repairAttestationDigest: null,
      terminalOperationId: null,
      terminalOperationType: null,
      terminalExpectedRevision: null,
      terminalRequestDigest: null,
    });
    const key = lifecycleKey(messageId, revision);
    // One product transaction: row, lifecycle, object ownership and receipt.
    this.#messages.set(messageId, message);
    this.#messageStructuralFacts.set(messageId, Object.freeze({
      fingerprint: input.fingerprint,
      createdAt: this.#now(),
    }));
    this.#lifecycles.set(key, lifecycle);
    this.#objectOwners.set(cryptoObjectId, key);
    this.#appendReceipts.set(receiptKey, {
      requestDigest: input.requestDigest.slice(),
      lifecycleKey: key,
    });
    if (this.#throwAfterAppendCommit) {
      this.#throwAfterAppendCommit = false;
      throw new Error("Append response was lost after commit (injected)");
    }
    return Promise.resolve({
      status: "allocated",
      lifecycle,
    });
  }

  getRevision(
    messageId: number,
    revision: number,
  ): Promise<ConversationRevisionState | null> {
    this.#events.push("product.get_revision");
    const lifecycle = this.#lifecycles.get(lifecycleKey(messageId, revision));
    if (lifecycle === undefined) return Promise.resolve(null);
    const current = this.#messages.get(messageId);
    return Promise.resolve(Object.freeze({
      message: current?.revision === revision ? cloneMessage(current) : null,
      lifecycle: cloneLifecycle(lifecycle),
    }));
  }

  resolveCurrentNamespace(sessionId: string): Promise<string | null> {
    this.#events.push("product.resolve_namespace");
    return Promise.resolve(
      this.#sessions.get(sessionId)?.namespaceId ?? null,
    );
  }

  restoreOrdinaryExistingRepresentation(
    input: ConversationOrdinaryRepairInput,
  ): Promise<"applied" | "replayed" | "missing" | "stale" | "conflict"> {
    this.ordinaryRepairInputs.push(input);
    const current = this.#messages.get(input.messageId);
    const lifecycle = this.#lifecycles.get(
      lifecycleKey(input.messageId, input.revision),
    );
    if (current === undefined || lifecycle === undefined) {
      return Promise.resolve("missing");
    }
    if (current.sessionId !== input.sessionId
      || current.revision !== input.revision
      || current.cryptoObjectId !== input.cryptoObjectId
      || lifecycle.cryptoObjectId !== input.cryptoObjectId) {
      return Promise.resolve("stale");
    }
    if (current.content !== null) {
      return Promise.resolve(current.content === input.content
        ? "replayed" : "conflict");
    }
    this.#messages.set(input.messageId, cloneMessage({
      ...current, content: input.content,
    }));
    return Promise.resolve("applied");
  }

  markCryptoComplete(input: {
    readonly sessionId: string;
    readonly messageId: number;
    readonly revision: number;
    readonly cryptoObjectId: string;
    readonly parityStatus: ConversationRevisionLifecycle["parityStatus"];
    readonly leaseToken: string | null;
    readonly publicationPolicy?: ConversationProductAppendInput["publicationPolicy"];
  }): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    this.completionPublicationPolicies.push(input.publicationPolicy);
    this.#events.push("product.mark_complete");
    const key = lifecycleKey(input.messageId, input.revision);
    const lifecycle = this.#lifecycles.get(key);
    if (lifecycle === undefined) return Promise.resolve("missing");
    if (
      lifecycle.sessionId !== input.sessionId
      || lifecycle.cryptoObjectId !== input.cryptoObjectId
      || this.#objectOwners.get(input.cryptoObjectId) !== key
      || lifecycle.leaseToken !== input.leaseToken
      || (
        lifecycle.parityStatus !== "pending"
        && input.parityStatus !== "pending"
        && lifecycle.parityStatus !== input.parityStatus
      )
    ) return Promise.resolve("conflict");
    const parityStatus = input.parityStatus === "pending"
      ? lifecycle.parityStatus
      : input.parityStatus;
    const duplicate = lifecycle.completion === "complete"
      && lifecycle.parityStatus === parityStatus;
    this.#lifecycles.set(key, cloneLifecycle({
      ...lifecycle,
      completion: "complete",
      parityStatus,
    }));
    if (this.#throwAfterMarkCompleteCommit) {
      this.#throwAfterMarkCompleteCommit = false;
      throw new Error(
        "Completion receipt response was lost after commit (injected)",
      );
    }
    return Promise.resolve(duplicate ? "duplicate" : "applied");
  }

  compareAndSwapCryptoMapping(input: {
    readonly sessionId: string;
    readonly messageId: number;
    readonly revision: number;
    readonly expectedNamespaceId: string;
    readonly cryptoObjectId: string;
    readonly leaseToken: string | null;
    readonly publicationPolicy?: ConversationProductAppendInput["publicationPolicy"];
  }): Promise<ConversationProductMappingCasResult> {
    this.mappingPublicationPolicies.push(input.publicationPolicy);
    this.#events.push("product.mapping_cas");
    const key = lifecycleKey(input.messageId, input.revision);
    const lifecycle = this.#lifecycles.get(key);
    if (lifecycle === undefined) return Promise.resolve("missing");
    if (lifecycle.leaseToken !== input.leaseToken) {
      return Promise.resolve("lease_lost");
    }
    if (
      lifecycle.disposition === "superseded"
      || lifecycle.disposition === "hard_delete"
      || lifecycle.disposition === "stale_mapping"
      || lifecycle.disposition === "quarantined"
      || lifecycle.disposition === "blocked"
    ) return Promise.resolve("stale");

    let status = this.#nextMappingCasResult;
    this.#nextMappingCasResult = null;
    const current = this.#messages.get(input.messageId);
    if (status === null) {
      if (current === undefined) status = "missing";
      else if (
        this.#sessions.get(input.sessionId)?.namespaceId
          !== input.expectedNamespaceId
      ) status = "wrong_namespace";
      else if (
        current.sessionId !== input.sessionId
        || current.revision !== input.revision
      ) status = "stale";
      else if (current.cryptoObjectId !== null) {
        status = current.cryptoObjectId === input.cryptoObjectId
          ? "duplicate"
          : "stale";
      } else status = "applied";
    }

    if (
      status === "missing"
      || status === "stale"
      || status === "wrong_namespace"
    ) {
      this.#lifecycles.set(key, cloneLifecycle({
        ...lifecycle,
        completion: "complete",
        disposition: "stale_mapping",
        failureCode: "mapping_conflict",
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      }));
      return Promise.resolve(status);
    }
    if (current === undefined) {
      throw new Error("Mapping CAS succeeded without a current message");
    }
    this.#messages.set(input.messageId, cloneMessage({
      ...current,
      cryptoObjectId: input.cryptoObjectId,
    }));
    this.#lifecycles.set(key, cloneLifecycle({
      ...lifecycle,
      completion: "complete",
      disposition: "mapped",
      failureCode: null,
      nextAttemptAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    }));
    if (this.#throwAfterMappingCommit) {
      this.#throwAfterMappingCommit = false;
      throw new Error("Mapping response was lost after commit (injected)");
    }
    return Promise.resolve(status);
  }

  editAllocated(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly content: string;
    readonly subthreadReplyClassification: "counted" | "excluded";
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductEditResult> {
    if (!validRequestDigest(input.requestDigest)) {
      throw new TypeError("Edit request digest must contain 32 bytes");
    }
    const receipt = this.#editReceipts.get(input.operationId);
    if (receipt !== undefined) {
      const exact = receipt.messageId === input.messageId
        && receipt.expectedRevision === input.expectedRevision
        && bytesEqual(receipt.requestDigest, input.requestDigest);
      if (!exact) return Promise.resolve({ status: "conflict" });
      const lifecycles = receipt.lifecycleKeys.map((key) =>
        this.#lifecycles.get(key)
      );
      if (lifecycles.some((lifecycle) => lifecycle === undefined)) {
        return Promise.resolve({ status: "missing" });
      }
      return Promise.resolve({
        status: "replayed",
        lifecycles: lifecycles.map((lifecycle) =>
          cloneLifecycle(lifecycle!)
        ),
      });
    }
    if (this.#deleteReceipts.has(input.operationId)) {
      return Promise.resolve({ status: "conflict" });
    }
    const current = this.#messages.get(input.messageId);
    if (current === undefined) return Promise.resolve({ status: "missing" });
    if (current.revision !== input.expectedRevision) {
      return Promise.resolve({ status: "stale" });
    }
    const requestedSession = this.#sessions.get(current.sessionId);
    const requestedFacts = this.#messageStructuralFacts.get(input.messageId);
    const physicalMessages =
      current.authorRole === "user"
        && requestedFacts?.fingerprint !== null
        && requestedFacts?.fingerprint !== undefined
        && requestedSession !== undefined
        ? Array.from(this.#messages.values())
          .filter((candidate) => {
            const candidateSession = this.#sessions.get(candidate.sessionId);
            const candidateFacts =
              this.#messageStructuralFacts.get(candidate.messageId);
            return candidate.authorRole === "user"
              && candidate.revision === input.expectedRevision
              && candidate.roomId === current.roomId
              && candidateSession?.ownerId === requestedSession.ownerId
              && candidateFacts?.fingerprint === requestedFacts.fingerprint;
          })
          .sort((left, right) => left.messageId - right.messageId)
        : [current];
    const previousLifecycles = physicalMessages.map((message) =>
      this.#lifecycles.get(
        lifecycleKey(message.messageId, input.expectedRevision),
      )
    );
    if (previousLifecycles.some((lifecycle) => lifecycle === undefined)) {
      return Promise.resolve({ status: "missing" });
    }
    const revision = current.revision + 1;
    const nextLifecycles: ConversationRevisionLifecycle[] = [];
    const nextKeys: string[] = [];
    for (const [index, physical] of physicalMessages.entries()) {
      const previous = previousLifecycles[index]!;
      const previousKey = lifecycleKey(
        physical.messageId,
        input.expectedRevision,
      );
      const nextKey = lifecycleKey(physical.messageId, revision);
      const cryptoObjectId = deriveMessageCryptoObjectIdV2({
        sessionId: physical.sessionId,
        messageId: physical.messageId,
        revision,
      });
      if (this.#objectOwners.has(cryptoObjectId)) {
        throw new Error("Crypto object identity is already product-owned");
      }
      const next = cloneLifecycle({
        ...previous,
        revision,
        sequence: this.#nextSequence++,
        cryptoObjectId,
        completion: "pending",
        disposition: "active",
        parityStatus: "pending",
        attemptCount: 0,
        nextAttemptAt: this.#now(),
        failureCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
        appendIdempotencyKey: null,
        subthreadReplyClassification: input.subthreadReplyClassification,
        allocationRequestDigest: input.requestDigest,
        repairIdentityDigest: null,
        repairPublisherKind: null,
        repairPublisherId: null,
        repairAttestationDigest: null,
        terminalOperationId: null,
        terminalOperationType: null,
        terminalExpectedRevision: null,
        terminalRequestDigest: null,
      });
      const superseded = cloneLifecycle({
        ...previous,
        disposition: "superseded",
        terminalOperationId: input.operationId,
        terminalOperationType: "edit",
        terminalExpectedRevision: input.expectedRevision,
        terminalRequestDigest: input.requestDigest,
        nextAttemptAt: null,
        failureCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      const message = cloneMessage({
        ...physical,
        content: input.content,
        revision,
        cryptoObjectId: null,
      });
      // One product transaction.
      this.#lifecycles.set(previousKey, superseded);
      this.#lifecycles.set(nextKey, next);
      this.#objectOwners.set(cryptoObjectId, nextKey);
      this.#messages.set(physical.messageId, message);
      nextLifecycles.push(next);
      nextKeys.push(nextKey);
    }
    this.#editReceipts.set(input.operationId, {
      messageId: input.messageId,
      expectedRevision: input.expectedRevision,
      requestDigest: input.requestDigest.slice(),
      lifecycleKeys: Object.freeze(nextKeys),
    });
    if (this.#throwAfterEditCommit) {
      this.#throwAfterEditCommit = false;
      throw new Error("Edit response was lost after commit (injected)");
    }
    return Promise.resolve({
      status: "allocated",
      lifecycles: Object.freeze(nextLifecycles),
    });
  }

  async publishProtectedEdit(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
    readonly policyRevision: number;
    readonly lockCryptoAuthority: () => Promise<void>;
    readonly targets: readonly Readonly<{
      sessionId: string;
      messageId: number;
      namespaceId: string;
      cryptoObjectId: string;
      keyClass: "ai" | "human";
      namespaceAccessRevision: number;
      namespaceKeyGeneration: number;
      namespaceAudienceFingerprint: Uint8Array;
    }>[];
  }): Promise<ConversationProductEditResult> {
    await input.lockCryptoAuthority();
    const result = await this.editAllocated({
      messageId: input.messageId,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      content: "protected-edit-transient",
      subthreadReplyClassification: "counted",
      requestDigest: input.requestDigest,
    });
    if (result.status !== "allocated" && result.status !== "replayed") {
      return result;
    }
    const targetByMessage = new Map(input.targets.map((target) => [target.messageId, target]));
    const lifecycles = result.lifecycles.map((lifecycle) => {
      const target = targetByMessage.get(lifecycle.messageId);
      if (
        target === undefined
        || target.sessionId !== lifecycle.sessionId
        || target.cryptoObjectId !== lifecycle.cryptoObjectId
      ) throw new TypeError("Fake protected edit target set disagrees");
      const next = cloneLifecycle({
        ...lifecycle,
        namespaceIdAtAllocation: target.namespaceId,
        keyClass: target.keyClass,
        completion: "complete",
        disposition: "mapped",
        parityStatus: "client_authenticated",
        representationMode: "full_encryption",
        publicationPolicyRevision: input.policyRevision,
        nextAttemptAt: null,
      });
      this.#lifecycles.set(
        lifecycleKey(next.messageId, next.revision),
        next,
      );
      const message = this.#messages.get(next.messageId);
      if (message === undefined) throw new Error("Fake protected edit lost its Message");
      this.#messages.set(next.messageId, cloneMessage({
        ...message,
        content: null,
        cryptoObjectId: target.cryptoObjectId,
      }));
      return next;
    });
    return { status: result.status, lifecycles: Object.freeze(lifecycles) };
  }

  inspectProtectedEditReplay(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductEditResult | null> {
    const receipt = this.#editReceipts.get(input.operationId);
    if (receipt === undefined) return Promise.resolve(null);
    if (
      receipt.messageId !== input.messageId
      || receipt.expectedRevision !== input.expectedRevision
      || !bytesEqual(receipt.requestDigest, input.requestDigest)
    ) return Promise.resolve({ status: "conflict" });
    const lifecycles = receipt.lifecycleKeys.map((key) => this.#lifecycles.get(key));
    if (lifecycles.some((lifecycle) => lifecycle === undefined)) {
      return Promise.resolve({ status: "missing" });
    }
    return Promise.resolve({
      status: "replayed",
      lifecycles: Object.freeze(lifecycles.map((lifecycle) => cloneLifecycle(lifecycle!))),
    });
  }

  inspectProtectedEditPlanSource(
    messageId: number,
    expectedRevision: number,
  ): Promise<import("../message/conversation-repository.ts").ConversationProtectedEditPlanSource | null> {
    const message = this.#messages.get(messageId);
    const facts = this.#messageStructuralFacts.get(messageId);
    const session = message === undefined ? undefined : this.#sessions.get(message.sessionId);
    if (
      message === undefined
      || facts === undefined
      || session === undefined
      || session.ownerId === undefined
      || message.authorRole !== "user"
      || message.revision !== expectedRevision
    ) return Promise.resolve(null);
    const siblings = [...this.#messages.values()].filter((candidate) => {
      const candidateFacts = this.#messageStructuralFacts.get(candidate.messageId);
      const candidateSession = this.#sessions.get(candidate.sessionId);
      return facts.fingerprint === null
        ? candidate.messageId === messageId
        : candidate.authorRole === "user"
          && candidate.revision === expectedRevision
          && candidate.roomId === message.roomId
          && candidateSession?.ownerId === session.ownerId
          && candidateFacts?.fingerprint === facts.fingerprint;
    }).sort((left, right) => left.messageId - right.messageId);
    const lifecycles = siblings.map((candidate) => this.#lifecycles.get(
      lifecycleKey(candidate.messageId, expectedRevision),
    ));
    if (lifecycles.some((lifecycle) => lifecycle === undefined)) {
      return Promise.resolve(null);
    }
    return Promise.resolve(Object.freeze({
      roomId: message.roomId,
      subjectUserId: session.ownerId,
      authorHumanId: session.ownerId,
      logicalMessageKey: facts.fingerprint,
      authorizationScheme: "human_ai_readable_v1" as const,
      targets: Object.freeze(lifecycles.map((lifecycle) => Object.freeze({
        sessionId: lifecycle!.sessionId,
        messageId: lifecycle!.messageId,
        expectedRevision,
        createdAt: facts.createdAt.getTime(),
        editedAt: null,
        namespaceId: lifecycle!.namespaceIdAtAllocation,
        keyClass: lifecycle!.keyClass,
        cryptoObjectId: lifecycle!.cryptoObjectId,
      }))),
    }));
  }

  hardDelete(input: {
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly requestDigest: Uint8Array;
  }): Promise<ConversationProductDeleteResult> {
    if (!validRequestDigest(input.requestDigest)) {
      throw new TypeError("Delete request digest must contain 32 bytes");
    }
    const receipt = this.#deleteReceipts.get(input.operationId);
    if (receipt !== undefined) {
      const exact = receipt.messageId === input.messageId
        && receipt.expectedRevision === input.expectedRevision
        && bytesEqual(receipt.requestDigest, input.requestDigest);
      if (!exact) return Promise.resolve({ status: "conflict" });
      const lifecycle = this.#lifecycles.get(receipt.lifecycleKey);
      if (lifecycle === undefined) {
        return Promise.reject(
          new Error("Delete receipt lost its product lifecycle"),
        );
      }
      return Promise.resolve({
        status: "replayed",
        lifecycle: cloneLifecycle(lifecycle),
        effects: cloneDeleteEffects(receipt.effects),
      });
    }
    if (this.#editReceipts.has(input.operationId)) {
      return Promise.resolve({ status: "conflict" });
    }
    const current = this.#messages.get(input.messageId);
    if (current === undefined) return Promise.resolve({ status: "missing" });
    if (current.revision !== input.expectedRevision) {
      return Promise.resolve({ status: "stale" });
    }
    const key = lifecycleKey(input.messageId, input.expectedRevision);
    const lifecycle = this.#lifecycles.get(key);
    if (lifecycle === undefined) return Promise.resolve({ status: "missing" });
    const deleted = cloneLifecycle({
      ...lifecycle,
      disposition: "hard_delete",
      terminalOperationId: input.operationId,
      terminalOperationType: "delete",
      terminalExpectedRevision: input.expectedRevision,
      terminalRequestDigest: input.requestDigest,
      nextAttemptAt: null,
      failureCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    const effects = Object.freeze({
      roomId: current.roomId,
      wasUnread: false,
      orphanedTurnId: null,
      rootSummary: null,
    }) satisfies ConversationDeleteEffects;
    // One product transaction.
    this.#lifecycles.set(key, deleted);
    this.#messages.delete(input.messageId);
    this.#messageStructuralFacts.delete(input.messageId);
    this.#deleteReceipts.set(input.operationId, {
      messageId: input.messageId,
      expectedRevision: input.expectedRevision,
      requestDigest: input.requestDigest.slice(),
      lifecycleKey: key,
      effects,
    });
    if (this.#throwAfterDeleteCommit) {
      this.#throwAfterDeleteCommit = false;
      throw new Error("Delete response was lost after commit (injected)");
    }
    return Promise.resolve({ status: "deleted", lifecycle: deleted, effects });
  }

  quarantineRevision(input: {
    readonly sessionId: string;
    readonly messageId: number;
    readonly revision: number;
    readonly leaseToken: string | null;
    readonly failureCode: ConversationFailureCode;
  }): Promise<"applied" | "duplicate" | "missing" | "conflict"> {
    const key = lifecycleKey(input.messageId, input.revision);
    const lifecycle = this.#lifecycles.get(key);
    const receipt = this.#quarantineReceipts.get(key);
    if (receipt !== undefined) {
      return Promise.resolve(
        receipt.leaseToken === input.leaseToken
          && receipt.failureCode === input.failureCode
          ? "duplicate"
          : "conflict",
      );
    }
    if (
      lifecycle === undefined
      || lifecycle.sessionId !== input.sessionId
      || lifecycle.leaseToken !== input.leaseToken
    ) return Promise.resolve("missing");
    if (
      lifecycle.disposition === "superseded"
      || lifecycle.disposition === "hard_delete"
      || lifecycle.disposition === "stale_mapping"
    ) return Promise.resolve("duplicate");
    this.#lifecycles.set(key, cloneLifecycle({
      ...lifecycle,
      disposition: "quarantined",
      failureCode: input.failureCode,
      nextAttemptAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    }));
    this.#quarantineReceipts.set(key, Object.freeze({
      leaseToken: input.leaseToken,
      failureCode: input.failureCode,
    }));
    return Promise.resolve("applied");
  }

  claimReconciliationCandidates(input: {
    readonly leaseToken: string;
    readonly limit: number;
  }): Promise<readonly ConversationRevisionState[]> {
    const now = this.#now();
    const nowMs = now.getTime();
    const leaseExpiresAt = new Date(
      nowMs + CONVERSATION_RECONCILE_LEASE_SECONDS * 1_000,
    );
    const candidates = Array.from(this.#lifecycles.values())
      .filter((lifecycle) =>
        lifecycle.disposition === "active"
        && lifecycle.attemptCount < CONVERSATION_RECONCILE_MAX_ATTEMPTS
        && (
          lifecycle.nextAttemptAt === null
          || lifecycle.nextAttemptAt.getTime() <= nowMs
        )
        && (
          lifecycle.leaseToken === null
          || lifecycle.leaseExpiresAt === null
          || lifecycle.leaseExpiresAt.getTime() <= nowMs
        )
      )
      .sort((left, right) => {
        const leftDue = left.nextAttemptAt?.getTime()
          ?? Number.NEGATIVE_INFINITY;
        const rightDue = right.nextAttemptAt?.getTime()
          ?? Number.NEGATIVE_INFINITY;
        return leftDue - rightDue || left.sequence - right.sequence;
      });
    const count = this.#tooManyCandidates
      ? input.limit + 1
      : input.limit;
    this.#tooManyCandidates = false;
    const claimed = candidates.slice(0, count).map((lifecycle) => {
      const stored = cloneLifecycle({
        ...lifecycle,
        leaseToken: input.leaseToken,
        leaseExpiresAt,
      });
      this.#lifecycles.set(
        lifecycleKey(lifecycle.messageId, lifecycle.revision),
        stored,
      );
      const current = this.#messages.get(lifecycle.messageId);
      return {
        message: current?.revision === lifecycle.revision
          ? cloneMessage(current)
          : null,
        lifecycle: cloneLifecycle(stored),
      } satisfies ConversationRevisionState;
    });
    if (claimed.length > 0 && this.#malformedClaim !== null) {
      const first = claimed[0]!;
      const malformed = this.#malformedClaim === "crypto_object_id"
        ? {
          ...first.lifecycle,
          cryptoObjectId: "malformed-object-id",
        }
        : {
          ...first.lifecycle,
          messageId: 0,
        };
      claimed[0] = {
        ...first,
        lifecycle: malformed as ConversationRevisionLifecycle,
      };
      this.#malformedClaim = null;
    }
    return Promise.resolve(Object.freeze(claimed));
  }

  failReconciliationClaim(input: {
    readonly sessionId: string;
    readonly messageId: number;
    readonly revision: number;
    readonly leaseToken: string;
    readonly failureCode: ConversationFailureCode;
  }): Promise<ConversationRevisionLifecycle | null> {
    const key = lifecycleKey(input.messageId, input.revision);
    const lifecycle = this.#lifecycles.get(key);
    if (
      lifecycle === undefined
      || lifecycle.sessionId !== input.sessionId
      || lifecycle.leaseToken !== input.leaseToken
    ) return Promise.resolve(null);
    if (lifecycle.disposition !== "active") {
      return Promise.resolve(cloneLifecycle(lifecycle));
    }
    const attemptCount = lifecycle.attemptCount + 1;
    const exhausted = attemptCount >= CONVERSATION_RECONCILE_MAX_ATTEMPTS;
    const delay = Math.min(
      300_000,
      1_000 * (2 ** Math.max(0, attemptCount - 1)),
    );
    const failedAt = this.#now();
    const failed = cloneLifecycle({
      ...lifecycle,
      attemptCount,
      disposition: exhausted ? "quarantined" : "active",
      failureCode: exhausted ? "retry_exhausted" : input.failureCode,
      nextAttemptAt: exhausted
        ? null
        : new Date(failedAt.getTime() + delay),
      leaseToken: null,
      leaseExpiresAt: null,
    });
    this.#lifecycles.set(key, failed);
    return Promise.resolve(cloneLifecycle(failed));
  }
}

interface CommittedCryptoRevision {
  readonly kind: PreparedConversationCryptoRevisionSnapshot["kind"];
  readonly snapshot: PreparedConversationCryptoRevisionSnapshot["value"];
  readonly payloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly verified: VerifiedConversationCryptoRevision;
}

export class FakeAtomicConversationCryptoCompletion
  implements AtomicConversationCryptoCompletionPort
{
  readonly #crypto: LatticeCrypto;
  readonly #events: string[];
  readonly #storage: LatticeStorage | null;
  readonly #committed = new Map<string, CommittedCryptoRevision>();
  readonly #verificationThrows = new Set<string>();
  #failCompletion = false;
  #failVerification = false;
  #throwAfterCompletionCommit = false;
  completionCount = 0;
  lastFailure: Error | null = null;

  constructor(input: {
    readonly crypto: LatticeCrypto;
    readonly events: string[];
    readonly storage?: LatticeStorage;
  }) {
    this.#crypto = input.crypto;
    this.#events = input.events;
    this.#storage = input.storage ?? null;
  }

  failNextCompletion(): void {
    this.#failCompletion = true;
  }

  failNextVerification(): void {
    this.#failVerification = true;
  }

  throwAfterNextCompletionCommit(): void {
    this.#throwAfterCompletionCommit = true;
  }

  throwNextVerificationFor(objectId: string): void {
    this.#verificationThrows.add(objectId);
  }

  inspect(objectId: string): "absent" | "complete" {
    return this.#committed.has(objectId) ? "complete" : "absent";
  }

  loseCommittedRevisionForTesting(objectId: string): void {
    this.#committed.delete(objectId);
  }

  async #validate(
    tagged: ReturnType<
      typeof readPreparedConversationCryptoRevisionSnapshot
    >,
  ): Promise<CommittedCryptoRevision> {
    const snapshot = tagged.value;
    const payloadBytes = snapshot.object.payloadBytes.ciphertext;
    const payload = decodeEncryptedPayloadV2(payloadBytes);
    const manifest = tagged.kind === "human-v2"
      ? decodeObjectAccessManifestV2(snapshot.access.manifestBytes)
      : decodeObjectAccessManifestV3(snapshot.access.manifestBytes);
    if (
      snapshot.objectId !== snapshot.object.objectId
      || payload.context.objectId !== snapshot.objectId
      || manifest.objectId !== snapshot.objectId
    ) {
      throw new Error("Conversation crypto object coordinates disagree");
    }
    if (payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE) {
      throw new Error("Conversation crypto object type is invalid");
    }
    if (snapshot.access.envelopeBytes.length !== 1) {
      throw new Error(
        "Conversation revision must have exactly one Namespace envelope",
      );
    }
    const envelope = decodeNamespaceObjectEnvelopeV2(
      snapshot.access.envelopeBytes[0],
    );
    if (
      envelope.context.objectId !== snapshot.objectId
      || envelope.context.namespaceId !== snapshot.namespaceId
    ) {
      throw new Error("Conversation crypto Namespace coordinates disagree");
    }
    if (envelope.context.keyClass !== payload.context.keyClass) {
      throw new Error(
        "Conversation payload and envelope key class disagree",
      );
    }

    const storage = this.#storage ?? new InMemoryLatticeStore();
    await storage.putObject(snapshot.object);
    const status = tagged.kind === "human-v2"
      ? await persistPreparedObjectAccessManifestGenesis({
        crypto: this.#crypto,
        storage,
        prepared: tagged.value.access,
        resolveCurrentAuthorization:
          tagged.value.resolveCurrentAuthorization,
      })
      : tagged.kind === "agent-v3"
      ? await persistPreparedAgentObjectAccessManifestGenesis({
        crypto: this.#crypto,
        storage,
        prepared: tagged.value.access,
        resolveCurrentAuthorization:
          tagged.value.resolveCurrentAuthorization,
      })
      : await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({
        crypto: this.#crypto,
        storage,
        prepared: tagged.value.access,
        resolveCurrentAuthorization:
          tagged.value.resolveCurrentAuthorization,
      });
    if (status !== "applied" && status !== "duplicate") {
      throw new Error(
        `Conversation crypto object and genesis access are not complete: ${status}`,
      );
    }
    const object = await storage.getObject(snapshot.objectId);
    const access = await storage.getObjectAccessState(snapshot.objectId);
    if (
      object === null
      || access === null
      || !bytesEqual(object.payloadBytes, payloadBytes)
      || !bytesEqual(access.head.manifestBytes, snapshot.access.manifestBytes)
      || !byteArraysEqual(
        access.namespaceEnvelopes.map((item) => item.envelopeBytes),
        snapshot.access.envelopeBytes,
      )
    ) {
      throw new Error(
        "Conversation crypto object failed complete-set verification",
      );
    }
    return Object.freeze({
      kind: tagged.kind,
      snapshot,
      payloadBytes: payloadBytes.slice(),
      manifestBytes: snapshot.access.manifestBytes.slice(),
      envelopeBytes: snapshot.access.envelopeBytes.map((bytes) =>
        bytes.slice()
      ),
      verified: Object.freeze({
        objectId: snapshot.objectId,
        namespaceId: snapshot.namespaceId,
        objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
        payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
        keyClass: payload.context.keyClass as ConversationMessageKeyClass,
      }),
    });
  }

  async complete(
    revision: PreparedConversationCryptoRevision,
  ): Promise<"created" | "duplicate"> {
    this.#events.push("crypto.complete");
    if (this.#failCompletion) {
      this.#failCompletion = false;
      throw new Error("Atomic crypto completion failed (injected)");
    }
    let candidate: CommittedCryptoRevision;
    try {
      candidate = await this.#validate(
        readPreparedConversationCryptoRevisionSnapshot(revision),
      );
    } catch (cause) {
      this.lastFailure = cause instanceof Error
        ? cause
        : new Error("Fake atomic crypto completion failed", { cause });
      throw cause;
    }
    const current = this.#committed.get(candidate.snapshot.objectId);
    if (current !== undefined) {
      if (
        current.snapshot.namespaceId !== candidate.snapshot.namespaceId
        || !bytesEqual(current.payloadBytes, candidate.payloadBytes)
        || !bytesEqual(current.manifestBytes, candidate.manifestBytes)
        || !byteArraysEqual(current.envelopeBytes, candidate.envelopeBytes)
      ) {
        throw new Error(
          "Conversation crypto object identity conflicts with existing bytes",
        );
      }
      return "duplicate";
    }
    this.#committed.set(candidate.snapshot.objectId, candidate);
    this.completionCount += 1;
    if (this.#throwAfterCompletionCommit) {
      this.#throwAfterCompletionCommit = false;
      throw new Error(
        "Crypto completion response was lost after commit (injected)",
      );
    }
    return "created";
  }

  async verify(
    objectId: string,
  ): Promise<VerifiedConversationCryptoRevision | null> {
    this.#events.push("crypto.verify");
    if (this.#verificationThrows.delete(objectId)) {
      throw new Error("Crypto verification failed (injected)");
    }
    if (this.#failVerification) {
      this.#failVerification = false;
      return null;
    }
    const committed = this.#committed.get(objectId);
    if (committed === undefined) return null;
    const verified = await this.#validate(
      committed.kind === "human-v2"
        ? Object.freeze({
          kind: "human-v2" as const,
          value: committed.snapshot as ConversationCryptoRevisionSnapshot,
        })
        : committed.kind === "agent-v3"
        ? Object.freeze({
          kind: "agent-v3" as const,
          value: committed.snapshot as AgentConversationCryptoRevisionSnapshot,
        })
        : Object.freeze({
          kind: "agent-v3-device-wrapped-live-shadow" as const,
          value: committed.snapshot as DeviceWrappedLiveShadowAgentConversationCryptoRevisionSnapshot,
        }),
    );
    if (
      !bytesEqual(committed.payloadBytes, verified.payloadBytes)
      || !bytesEqual(committed.manifestBytes, verified.manifestBytes)
      || !byteArraysEqual(committed.envelopeBytes, verified.envelopeBytes)
    ) return null;
    return Object.freeze({ ...committed.verified });
  }
}

export function createFakeConversationShadowHarness(input: {
  readonly crypto: LatticeCrypto;
  readonly now?: () => Date;
}) {
  const events: string[] = [];
  const product = new FakeConversationProductStore(events, input.now);
  const crypto = new FakeAtomicConversationCryptoCompletion({
    crypto: input.crypto,
    events,
  });
  return Object.freeze({
    events,
    product,
    crypto,
    prepareCryptoRevision(
      snapshot: ConversationCryptoRevisionSnapshot,
    ): PreparedConversationCryptoRevision {
      return createPreparedConversationCryptoRevision(snapshot);
    },
    repository: createDormantConversationShadowRepository({
      product,
      crypto,
    }),
  });
}
