import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareObjectAccessManifestGenesis,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type ResolveCurrentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  deriveHumanMessageEditCryptoObjectIdV1,
} from "@nautilo/lattice-crypto/wire";
import {
  createDormantConversationShadowRepository,
  deriveMessageCryptoObjectIdV2,
  deriveLiveShadowMessageCryptoObjectIdV1,
  conversationAppendRequestDigest,
  conversationEditRequestDigest,
  conversationExistingRepresentationRepairIdentityDigest,
  encodeMessagePayloadV2,
  type ConversationAllocatedRevision,
  type ConversationProductStorePort,
  type MessagePayloadV2,
} from "../../src/index.ts";
import {
  createFakeConversationShadowHarness,
} from "../../src/testing/index.ts";

const SESSION_ALPHA = "10000000-0000-4000-8000-000000000001";
const SESSION_BETA = "10000000-0000-4000-8000-000000000002";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

async function fixture() {
  let nowMs = Date.parse("2027-01-15T07:59:00.000Z");
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x237_03) },
    { now: () => 1_800_000_000_000 },
  );
  const signing = crypto.generateSigningKeyPair();
  const namespaceKey = new Uint8Array(32).fill(37);
  const harness = createFakeConversationShadowHarness({
    crypto,
    now: () => new Date(nowMs),
  });
  harness.product.addSession({
    sessionId: SESSION_ALPHA,
    roomId: "room-alpha",
    namespaceId: "namespace-alpha",
  });
  harness.product.addSession({
    sessionId: SESSION_BETA,
    roomId: "room-beta",
    namespaceId: "namespace-beta",
  });

  function prepared(
    revision: ConversationAllocatedRevision,
    payload: MessagePayloadV2,
    override: Readonly<{
      objectType?: string;
      payloadKeyClass?: "ai" | "human";
      envelopeKeyClass?: "ai" | "human";
      namespaceId?: string;
    }> = {},
  ) {
    const payloadKeyClass = override.payloadKeyClass ?? revision.keyClass;
    const envelopeKeyClass = override.envelopeKeyClass ?? payloadKeyClass;
    const targetNamespaceId =
      override.namespaceId ?? revision.namespaceId;
    const encrypted = encryptObjectPayload(
      crypto,
      {
        objectId: objectId(revision.cryptoObjectId),
        keyClass: payloadKeyClass,
        objectType: override.objectType ?? "nautilo-message-v2",
        createdAt: unixTimestamp(
          1_800_000_000_000 + revision.revision,
        ),
      },
      encodeMessagePayloadV2(payload),
    );
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelope = wrapObjectDekForNamespace(
      crypto,
      namespaceKey,
      {
        objectId: objectId(revision.cryptoObjectId),
        namespaceId: namespaceId(targetNamespaceId),
        keyClass: envelopeKeyClass,
        keyGeneration: namespaceGeneration(1),
        bindingRevisionAtWrap: accessRevision(4),
      },
      encrypted.dek,
    );
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
    const access = prepareObjectAccessManifestGenesis(crypto, {
      objectId: objectId(revision.cryptoObjectId),
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alpha"),
      hostAuthorizationRevision: authorizationRevision(9),
      signingPrivateKey: signing.privateKey,
    });
    const resolveCurrentAuthorization:
      ResolveCurrentObjectAccessGenesisAuthorization = (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision:
          context.hostAuthorizationRevision,
        committerSigningPublicKey: signing.publicKey,
      });
    return harness.prepareCryptoRevision({
      objectId: revision.cryptoObjectId,
      namespaceId: revision.namespaceId,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
      resolveCurrentAuthorization,
    });
  }

  async function allocate(input: Readonly<{
    sessionId?: string;
    idempotencyKey: string;
    content: string;
    keyClass?: "ai" | "human";
    authorRole?: "user" | "assistant" | "tool" | "system";
    fingerprint?: string | null;
    full?: boolean;
  }>) {
    return harness.repository.append({
      sessionId: input.sessionId ?? SESSION_ALPHA,
      idempotencyKey: input.idempotencyKey,
      content: input.full ? null : input.content,
      ...(input.full ? { publicationPolicy: {
        expectedRevision: 18, representation: "protected_only" as const,
      } } : {}),
      keyClass: input.keyClass ?? "ai",
      authorRole: input.authorRole ?? "user",
      toolCalls: null,
      toolName: null,
      fingerprint: input.fingerprint ?? null,
      humanTurnId: null,
      transcriptOrigin: "main",
      parentThreadId: null,
      scopeId: null,
      metadata: null,
      subthreadRoomId: null,
      replyToMessageId: null,
      notificationContext: {
        mentionedHumanUserIds: [],
        causalHumanUserId: null,
        causalHumanTurnId: null,
      },
      structuralProjection: {
        notificationEligibility: "eligible",
        subthreadReplyClassification: "counted",
      },
    });
  }

  return {
    harness,
    prepared,
    allocate,
    setNow: (value: Date) => {
      nowMs = value.getTime();
    },
  };
}

describe("two-phase dormant conversation shadow repository", () => {
  test("Full stores real protected crypto without ordinary body or invented parity", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "full-authentication", content: "full-private-sentinel", full: true,
    });
    const revision = prepared(allocated, { role: "user", content: "full-private-sentinel" });
    expect(harness.repository.completeRevision({
      messageId: allocated.messageId, expectedRevision: 0,
      parityStatus: "client_verified", prepared: revision,
    })).rejects.toThrow("parity status");
    expect(harness.crypto.completionCount).toBe(0);
    const completed = await harness.repository.completeRevision({
      messageId: allocated.messageId, expectedRevision: 0,
      parityStatus: "client_authenticated", prepared: revision,
    });
    expect(completed.status).toBe("mapped");
    const state = await harness.product.getRevision(allocated.messageId, 0);
    expect(state?.message?.content).toBeNull();
    expect(state?.lifecycle).toMatchObject({
      representationMode: "full_encryption", publicationPolicyRevision: 18,
      parityStatus: "client_authenticated", disposition: "mapped",
    });
    expect(harness.crypto.completionCount).toBe(1);
    expect(harness.product.completionPublicationPolicies).toEqual([{
      expectedRevision: 18, representation: "protected_only",
    }]);
    expect(harness.product.mappingPublicationPolicies).toEqual([{
      expectedRevision: 18, representation: "protected_only",
    }]);
  });

  test("authenticates operation-scoped edit lifecycles before later mutation", async () => {
    const { harness, prepared, allocate } = await fixture();
    const source = await allocate({
      idempotencyKey: "human-edit-lifecycle-source",
      content: "source",
      keyClass: "human",
    });
    const edited = await harness.repository.edit({
      messageId: source.messageId,
      operationId: "ordinary-edit-before-protected-lifecycle",
      expectedRevision: 0,
      content: "edited",
      subthreadReplyClassification: "counted",
    });
    const operationId = "human-edit:v1:12345678-1234-4123-8123-123456789abc";
    const editObjectId = deriveHumanMessageEditCryptoObjectIdV1({
      operationId,
      sessionId: edited.sessionId,
      messageId: edited.messageId,
      revision: edited.revision,
    });
    const state = await harness.product.getRevision(
      edited.messageId,
      edited.revision,
    );
    if (state === null) throw new Error("Missing edited lifecycle fixture");
    const authenticatedLifecycle = Object.freeze({
      ...state.lifecycle,
      cryptoObjectId: editObjectId,
      objectIdScheme: "human_message_edit_v1" as const,
      humanPeerShadowOperationId: "human-peer-origin-for-edit-lifecycle",
      shadowTranscriptOrdinal: 1,
      shadowReservedCreatedAt: new Date("2027-01-15T07:59:00.000Z"),
      representationMode: "full_encryption" as const,
      publicationPolicyRevision: 18,
      completion: "complete" as const,
      disposition: "mapped" as const,
      parityStatus: "client_authenticated" as const,
      nextAttemptAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      failureCode: null,
    });
    await harness.crypto.complete(prepared({
      ...edited,
      cryptoObjectId: editObjectId,
    }, { role: "user", content: "edited" }));
    const product = new Proxy(harness.product, {
      get(target, property, receiver) {
        if (property === "getRevision") {
          return async (messageId: number, revision: number) =>
            messageId === edited.messageId && revision === edited.revision
              ? { ...state, lifecycle: authenticatedLifecycle }
              : target.getRevision(messageId, revision);
        }
        if (property === "markCryptoComplete"
          || property === "compareAndSwapCryptoMapping") {
          return async () => "applied" as const;
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) as unknown : value;
      },
    }) as ConversationProductStorePort;
    const repository = createDormantConversationShadowRepository({
      product,
      crypto: harness.crypto,
    });
    expect(await repository.hardDelete({
      messageId: edited.messageId,
      operationId: "delete-authenticated-human-edit",
      expectedRevision: edited.revision,
    })).toMatchObject({ status: "deleted" });

    const tamperedLifecycle = Object.freeze({
      ...authenticatedLifecycle,
      cryptoObjectId: deriveHumanMessageEditCryptoObjectIdV1({
        operationId,
        sessionId: SESSION_BETA,
        messageId: edited.messageId,
        revision: edited.revision,
      }),
      disposition: "mapped" as const,
    });
    const tamperedProduct = new Proxy(harness.product, {
      get(target, property, receiver) {
        if (property === "getRevision") {
          return async () => ({ ...state, lifecycle: tamperedLifecycle });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) as unknown : value;
      },
    }) as ConversationProductStorePort;
    const tamperedRepository = createDormantConversationShadowRepository({
      product: tamperedProduct,
      crypto: harness.crypto,
    });
    expect(tamperedRepository.hardDelete({
      messageId: edited.messageId,
      operationId: "delete-tampered-human-edit",
      expectedRevision: edited.revision,
    })).rejects.toThrow(/crypto object/i);
  });
  test("allocates real product coordinates before crypto preparation", async () => {
    const { harness, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-01",
      content: "first",
    });

    expect(allocated).toMatchObject({
      status: "allocated",
      sessionId: SESSION_ALPHA,
      messageId: 1,
      revision: 0,
      namespaceId: "namespace-alpha",
      keyClass: "ai",
      authorRole: "user",
      cryptoObjectId: deriveMessageCryptoObjectIdV2({
        sessionId: SESSION_ALPHA,
        messageId: 1,
        revision: 0,
      }),
    });
    expect(harness.crypto.completionCount).toBe(0);
    expect(harness.events).toEqual(["product.append"]);
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "pending",
      disposition: "active",
      parityStatus: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date("2027-01-15T07:59:00.000Z"),
      failureCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  test("scopes append idempotency to Session plus key and allocates the serial", async () => {
    const { harness, allocate } = await fixture();
    const first = await allocate({
      idempotencyKey: "same-key",
      content: "same",
    });
    const replay = await allocate({
      idempotencyKey: "same-key",
      content: "same",
    });
    const otherSession = await allocate({
      sessionId: SESSION_BETA,
      idempotencyKey: "same-key",
      content: "same",
    });

    expect(replay).toEqual({ ...first, status: "replayed" });
    expect(otherSession.messageId).toBe(2);
    expect(
      harness.repository.append({
        sessionId: SESSION_ALPHA,
        idempotencyKey: "same-key",
        content: "changed",
        keyClass: "ai",
        authorRole: "user",
        toolCalls: null,
        toolName: null,
        fingerprint: null,
        humanTurnId: null,
        transcriptOrigin: "main",
        parentThreadId: null,
        scopeId: null,
        metadata: null,
        subthreadRoomId: null,
        replyToMessageId: null,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
        structuralProjection: {
          notificationEligibility: "eligible",
          subthreadReplyClassification: "counted",
        },
      }),
    ).rejects.toThrow(/idempotency conflict/i);
  });

  test("completes and verifies object plus access before publishing mapping", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-02",
      content: "complete",
    });
    harness.events.length = 0;

    const result = await harness.repository.completeRevision({
      messageId: allocated.messageId,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: prepared(allocated, {
        role: "user",
        content: "complete",
      }),
    });

    expect(result).toMatchObject({
      status: "mapped",
      messageId: 1,
      revision: 0,
      cryptoObjectId: allocated.cryptoObjectId,
    });
    expect(harness.events).toEqual([
      "product.get_revision",
      "product.resolve_namespace",
      "crypto.complete",
      "crypto.verify",
      "product.mark_complete",
      "product.mapping_cas",
    ]);
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "complete",
      disposition: "mapped",
    });
  });

  test("keeps atomic crypto failure wholly pending", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-03",
      content: "retry",
    });
    const encrypted = prepared(allocated, {
      role: "user",
      content: "retry",
    });
    harness.crypto.failNextCompletion();

    expect(harness.repository.completeRevision({
      messageId: allocated.messageId,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: encrypted,
    })).rejects.toThrow(/atomic crypto completion failed/i);
    expect(harness.crypto.inspect(allocated.cryptoObjectId)).toBe("absent");
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "pending",
      disposition: "active",
    });

    expect(await harness.repository.completeRevision({
      messageId: allocated.messageId,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: encrypted,
    })).toMatchObject({ status: "mapped" });
  });

  test("replays a committed mapping after its response is lost", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-04",
      content: "crash",
    });
    harness.product.failNextMappingCas();

    expect(harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: prepared(allocated, { role: "user", content: "crash" }),
    })).rejects.toThrow(/mapping response was lost after commit/i);
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "complete",
      disposition: "mapped",
    });

    expect(await harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: prepared(allocated, { role: "user", content: "crash" }),
    })).toMatchObject({ status: "replayed" });
  });

  test("verifies the complete authentic set on every mapped completion replay", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-05",
      content: "mapped",
      authorRole: "assistant",
    });
    const encrypted = prepared(allocated, {
      role: "assistant",
      content: "mapped",
    });
    await harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "server_verified",
      prepared: encrypted,
    });
    const count = harness.crypto.completionCount;
    harness.crypto.failNextVerification();

    expect(harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "server_verified",
      prepared: encrypted,
    })).rejects.toThrow(/complete crypto revision is not verified/i);
    expect(harness.crypto.completionCount).toBe(count);
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "complete",
      disposition: "quarantined",
    });
  });

  test("keeps authorship distinct from key class and enforces parity authority", async () => {
    const { harness, prepared, allocate } = await fixture();
    const humanAuthoredAiReadable = await allocate({
      idempotencyKey: "parity-user-ai",
      content: "human authored, AI readable",
      keyClass: "ai",
      authorRole: "user",
    });
    expect(harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "server_verified",
      prepared: prepared(humanAuthoredAiReadable, {
        role: "user",
        content: "human authored, AI readable",
      }),
    })).rejects.toThrow(/parity status is not allowed/i);
    expect(harness.crypto.completionCount).toBe(0);

    const agentAuthoredHumanPublished = await allocate({
      idempotencyKey: "parity-assistant-client",
      content: "agent authored, Human representation publisher",
      keyClass: "ai",
      authorRole: "assistant",
    });
    expect(harness.repository.completeRevision({
      messageId: 2,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: prepared(agentAuthoredHumanPublished, {
        role: "assistant",
        content: "agent authored, Human representation publisher",
      }),
    })).resolves.toMatchObject({ status: "mapped", messageId: 2 });
    expect(harness.product.peekLifecycle(2, 0)).toMatchObject({
      authorRole: "assistant",
      parityStatus: "client_verified",
    });
  });

  test("reconciles a NULL prior revision before atomic edit classification", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-06",
      content: "before",
    });
    await harness.crypto.complete(prepared(allocated, {
      role: "user",
      content: "before",
    }));

    const edited = await harness.repository.edit({
      messageId: 1,
      operationId: "edit-06-1",
      expectedRevision: 0,
      content: "after",
      subthreadReplyClassification: "counted",
    });

    expect(edited).toMatchObject({
      status: "allocated",
      messageId: 1,
      revision: 1,
      cryptoObjectId: deriveMessageCryptoObjectIdV2({
        sessionId: SESSION_ALPHA,
        messageId: 1,
        revision: 1,
      }),
    });
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "complete",
      disposition: "superseded",
    });
    expect(harness.product.peekLifecycle(1, 1)).toMatchObject({
      completion: "pending",
      disposition: "active",
    });
  });

  test("returns, completes, and exactly replays every Human edit sibling allocation", async () => {
    const { harness, prepared, allocate } = await fixture();
    const siblingSession = "10000000-0000-4000-8000-000000000003";
    harness.product.addSession({
      sessionId: siblingSession,
      roomId: "room-alpha",
      namespaceId: "namespace-alpha",
      ownerId: "human-alpha",
    });
    harness.product.addSession({
      sessionId: SESSION_ALPHA,
      roomId: "room-alpha",
      namespaceId: "namespace-alpha",
      ownerId: "human-alpha",
    });
    const first = await allocate({
      sessionId: SESSION_ALPHA,
      idempotencyKey: "human-sibling-first",
      content: "before",
      keyClass: "human",
      authorRole: "user",
      fingerprint: "human-turn-shared",
    });
    const sibling = await allocate({
      sessionId: siblingSession,
      idempotencyKey: "human-sibling-second",
      content: "before",
      keyClass: "human",
      authorRole: "user",
      fingerprint: "human-turn-shared",
    });
    const request = {
      messageId: first.messageId,
      operationId: "human-sibling-edit",
      expectedRevision: 0,
      content: "after",
      subthreadReplyClassification: "counted" as const,
    };

    const edited = await harness.repository.edit(request);
    expect(edited.allocations.map((allocation) => allocation.messageId))
      .toEqual([first.messageId, sibling.messageId]);
    for (const allocation of edited.allocations) {
      await harness.repository.completeRevision({
        messageId: allocation.messageId,
        expectedRevision: allocation.revision,
        parityStatus: "client_verified",
        prepared: prepared(allocation, {
          role: "user",
          content: "after",
        }),
      });
    }
    expect(
      edited.allocations.map((allocation) =>
        harness.product.peekLifecycle(
          allocation.messageId,
          allocation.revision,
        )?.disposition
      ),
    ).toEqual(["mapped", "mapped"]);

    const replayed = await harness.repository.edit(request);
    expect(replayed.status).toBe("replayed");
    expect(replayed.allocations.map((allocation) => allocation.messageId))
      .toEqual([first.messageId, sibling.messageId]);
  });

  test("quarantines a complete lifecycle whose crypto set disappeared before mutation", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "complete-crypto-disappeared",
      content: "must remain",
    });
    await harness.repository.completeRevision({
      messageId: allocated.messageId,
      expectedRevision: allocated.revision,
      parityStatus: "client_verified",
      prepared: prepared(allocated, {
        role: "user",
        content: "must remain",
      }),
    });
    harness.crypto.loseCommittedRevisionForTesting(
      allocated.cryptoObjectId,
    );

    expect(harness.repository.edit({
      messageId: allocated.messageId,
      operationId: "edit-after-crypto-loss",
      expectedRevision: allocated.revision,
      content: "must not commit",
      subthreadReplyClassification: "counted",
    })).rejects.toThrow(/could not be verified before mutation/i);

    expect(harness.product.peekMessage(allocated.messageId)).toMatchObject({
      content: "must remain",
      revision: 0,
    });
    expect(
      harness.product.peekLifecycle(allocated.messageId, allocated.revision),
    ).toMatchObject({
      completion: "complete",
      disposition: "quarantined",
      failureCode: "crypto_incomplete",
    });
  });

  test("aborts hard delete when a complete lifecycle lost its crypto set", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "delete-complete-crypto-disappeared",
      content: "must survive",
    });
    await harness.repository.completeRevision({
      messageId: allocated.messageId,
      expectedRevision: allocated.revision,
      parityStatus: "client_verified",
      prepared: prepared(allocated, {
        role: "user",
        content: "must survive",
      }),
    });
    harness.crypto.loseCommittedRevisionForTesting(
      allocated.cryptoObjectId,
    );

    expect(harness.repository.hardDelete({
      messageId: allocated.messageId,
      operationId: "delete-after-crypto-loss",
      expectedRevision: allocated.revision,
    })).rejects.toThrow(/could not be verified before mutation/i);
    expect(harness.product.peekMessage(allocated.messageId)).toMatchObject({
      content: "must survive",
    });
    expect(
      harness.product.peekLifecycle(allocated.messageId, allocated.revision),
    ).toMatchObject({
      disposition: "quarantined",
      failureCode: "crypto_incomplete",
    });
  });

  test("hard delete persists exact replay/conflict receipt and orphan state", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-07",
      content: "delete",
    });
    await harness.crypto.complete(prepared(allocated, {
      role: "user",
      content: "delete",
    }));
    const request = {
      messageId: 1,
      operationId: "delete-07-1",
      expectedRevision: 0,
    };

    harness.product.throwAfterNextDeleteCommit();
    expect(harness.repository.hardDelete(request)).rejects.toThrow(
      /response was lost after commit/i,
    );
    expect(await harness.repository.hardDelete(request)).toEqual({
      status: "replayed",
      messageId: 1,
      revision: 0,
      cryptoObjectId: allocated.cryptoObjectId,
      effects: {
        roomId: "room-alpha",
        wasUnread: false,
        orphanedTurnId: null,
        rootSummary: null,
      },
    });
    expect(harness.repository.hardDelete({
      ...request,
      expectedRevision: 1,
    })).rejects.toThrow(/delete idempotency conflict/i);
    expect(harness.product.peekMessage(1)).toBeNull();
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "complete",
      disposition: "hard_delete",
    });
  });

  test("does not create a late crypto orphan after a pending hard delete", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-07-late",
      content: "delete before encryption",
    });
    const encrypted = prepared(allocated, {
      role: "user",
      content: "delete before encryption",
    });
    await harness.repository.hardDelete({
      messageId: 1,
      operationId: "delete-07-late",
      expectedRevision: 0,
    });
    harness.events.length = 0;

    expect(await harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: encrypted,
    })).toEqual({
      status: "orphaned",
      reason: "hard_delete",
      messageId: 1,
      revision: 0,
      cryptoObjectId: allocated.cryptoObjectId,
    });
    expect(harness.crypto.inspect(allocated.cryptoObjectId)).toBe("absent");
    expect(harness.crypto.completionCount).toBe(0);
    expect(harness.events).toEqual(["product.get_revision"]);
  });

  test("persists stale mapping classification after the message loses its CAS", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-08",
      content: "race",
    });
    harness.product.returnNextMappingCas("stale");

    const result = await harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: prepared(allocated, { role: "user", content: "race" }),
    });

    expect(result).toMatchObject({
      status: "orphaned",
      reason: "stale_mapping",
      cryptoObjectId: allocated.cryptoObjectId,
    });
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "complete",
      disposition: "stale_mapping",
    });
  });

  test("fails closed when a product adapter violates the reconciliation limit", async () => {
    const { harness, allocate } = await fixture();
    await allocate({ idempotencyKey: "send-10-a", content: "a" });
    await allocate({ idempotencyKey: "send-10-b", content: "b" });
    harness.product.returnTooManyReconciliationCandidates();

    expect(harness.repository.reconcilePending({
      leaseToken: "20000000-0000-4000-8000-000000000010",
      limit: 1,
    })).rejects.toThrow(/more rows than requested/i);
  });

  test("enforces stable Room Namespace capability and rechecks it at mapping", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "send-11",
      content: "stable",
    });
    expect(() => harness.product.changeSessionNamespace(
      SESSION_ALPHA,
      "namespace-other",
    )).toThrow(/immutable Room Namespace/i);

    harness.product.returnNextMappingCas("wrong_namespace");
    const result = await harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: prepared(allocated, { role: "user", content: "stable" }),
    });
    expect(result).toMatchObject({
      status: "orphaned",
      reason: "stale_mapping",
    });
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      disposition: "stale_mapping",
    });
  });

  test("rejects wrong object type and payload/envelope key-class drift", async () => {
    const { harness, prepared, allocate } = await fixture();
    const wrongType = await allocate({
      idempotencyKey: "send-12-a",
      content: "wrong type",
    });
    expect(() =>
      prepared(
        wrongType,
        { role: "user", content: "wrong type" },
        { objectType: "not-a-message" },
      )
    ).toThrow(/object type/i);

    const drift = await allocate({
      idempotencyKey: "send-12-b",
      content: "class drift",
    });
    expect(() =>
      prepared(
        drift,
        { role: "user", content: "class drift" },
        { payloadKeyClass: "ai", envelopeKeyClass: "human" },
      )
    ).toThrow(/key class/i);

    const wrongExpectedClass = await allocate({
      idempotencyKey: "send-12-c",
      content: "wrong expected class",
    });
    expect(harness.repository.completeRevision({
      messageId: 3,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: prepared(
        wrongExpectedClass,
        { role: "user", content: "wrong expected class" },
        { payloadKeyClass: "human", envelopeKeyClass: "human" },
      ),
    })).rejects.toThrow(/key class mismatch/i);
    expect(harness.crypto.completionCount).toBe(0);
  });

  test("rolls back fake append message, lifecycle, and receipt together", async () => {
    const { harness, allocate } = await fixture();
    harness.product.failNextAppendTransaction();

    expect(allocate({
      idempotencyKey: "send-13",
      content: "rollback",
    })).rejects.toThrow(/append transaction failed/i);
    expect(harness.product.peekMessage(1)).toBeNull();
    expect(harness.product.peekLifecycle(1, 0)).toBeNull();

    const retried = await allocate({
      idempotencyKey: "send-13",
      content: "rollback",
    });
    expect(retried.status).toBe("allocated");
  });

  test("stores only exact 32-byte request digests in operation receipts", async () => {
    const { harness, allocate } = await fixture();
    const secret = "receipt plaintext must not survive";
    await allocate({ idempotencyKey: "digest-append", content: secret });
    await harness.repository.edit({
      messageId: 1,
      operationId: "digest-edit",
      expectedRevision: 0,
      content: `${secret} edited`,
      subthreadReplyClassification: "counted",
    });
    await harness.repository.hardDelete({
      messageId: 1,
      operationId: "digest-delete",
      expectedRevision: 1,
    });

    const receipts = harness.product.receiptSnapshotForTesting();
    expect(receipts.every((receipt) =>
      /^[0-9a-f]{64}$/.test(receipt.requestDigestHex)
    )).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain(secret);
  });

  test("never lets a stale mapping CAS overwrite superseded or deleted state", async () => {
    const { harness, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "terminal-cas",
      content: "before",
    });
    const edited = await harness.repository.edit({
      messageId: 1,
      operationId: "terminal-cas-edit",
      expectedRevision: 0,
      content: "after",
      subthreadReplyClassification: "counted",
    });

    expect(await harness.product.compareAndSwapCryptoMapping({
      sessionId: SESSION_ALPHA,
      messageId: 1,
      revision: 0,
      expectedNamespaceId: "namespace-alpha",
      cryptoObjectId: allocated.cryptoObjectId,
      leaseToken: null,
    })).toBe("stale");
    expect(harness.product.peekLifecycle(1, 0)?.disposition).toBe(
      "superseded",
    );

    await harness.repository.hardDelete({
      messageId: 1,
      operationId: "terminal-cas-delete",
      expectedRevision: 1,
    });
    expect(await harness.product.compareAndSwapCryptoMapping({
      sessionId: SESSION_ALPHA,
      messageId: 1,
      revision: 1,
      expectedNamespaceId: "namespace-alpha",
      cryptoObjectId: edited.cryptoObjectId,
      leaseToken: null,
    })).toBe("stale");
    expect(harness.product.peekLifecycle(1, 1)?.disposition).toBe(
      "hard_delete",
    );
  });

  test("replays an original global terminal receipt after later edits and deletion", async () => {
    const { harness, allocate } = await fixture();
    await allocate({
      idempotencyKey: "durable-terminal-replay",
      content: "zero",
    });
    const originalEdit = {
      messageId: 1,
      operationId: "global-terminal-operation",
      expectedRevision: 0,
      content: "one",
      subthreadReplyClassification: "counted" as const,
    };
    await harness.repository.edit(originalEdit);
    await harness.repository.edit({
      messageId: 1,
      operationId: "later-edit-operation",
      expectedRevision: 1,
      content: "two",
      subthreadReplyClassification: "counted",
    });
    await harness.repository.hardDelete({
      messageId: 1,
      operationId: "later-delete-operation",
      expectedRevision: 2,
    });

    expect(await harness.repository.edit(originalEdit)).toMatchObject({
      status: "replayed",
      messageId: 1,
      revision: 1,
    });
    expect(harness.repository.edit({
      ...originalEdit,
      content: "changed replay",
    })).rejects.toThrow(/edit idempotency conflict/i);
    expect(await allocate({
      idempotencyKey: "durable-terminal-replay",
      content: "zero",
    })).toMatchObject({
      status: "replayed",
      messageId: 1,
      revision: 0,
    });
    expect(harness.repository.hardDelete({
      messageId: 1,
      operationId: originalEdit.operationId,
      expectedRevision: 0,
    })).rejects.toThrow(/delete idempotency conflict/i);
  });

  test("recovers every post-commit response-loss boundary idempotently", async () => {
    const { harness, prepared, allocate } = await fixture();
    harness.product.throwAfterNextAppendCommit();
    expect(allocate({
      idempotencyKey: "loss-append",
      content: "append",
    })).rejects.toThrow(/append response was lost/i);
    const allocated = await allocate({
      idempotencyKey: "loss-append",
      content: "append",
    });
    expect(allocated.status).toBe("replayed");

    const encrypted = prepared(allocated, {
      role: "user",
      content: "append",
    });
    harness.crypto.throwAfterNextCompletionCommit();
    expect(harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: encrypted,
    })).rejects.toThrow(/crypto completion response was lost/i);
    harness.product.throwAfterNextMarkCompleteCommit();
    expect(harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: encrypted,
    })).rejects.toThrow(/completion receipt response was lost/i);
    harness.product.throwAfterNextMappingCommit();
    expect(harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: encrypted,
    })).rejects.toThrow(/mapping response was lost/i);
    expect(await harness.repository.completeRevision({
      messageId: 1,
      expectedRevision: 0,
      parityStatus: "client_verified",
      prepared: encrypted,
    })).toMatchObject({ status: "replayed" });

    harness.product.throwAfterNextEditCommit();
    const editRequest = {
      messageId: 1,
      operationId: "loss-edit",
      expectedRevision: 0,
      content: "edited",
      subthreadReplyClassification: "counted" as const,
    };
    expect(harness.repository.edit(editRequest)).rejects.toThrow(
      /edit response was lost/i,
    );
    expect(await harness.repository.edit(editRequest)).toMatchObject({
      status: "replayed",
      revision: 1,
    });

    harness.product.throwAfterNextDeleteCommit();
    const deleteRequest = {
      messageId: 1,
      operationId: "loss-delete",
      expectedRevision: 1,
    };
    expect(harness.repository.hardDelete(deleteRequest)).rejects.toThrow(
      /delete response was lost/i,
    );
    expect(await harness.repository.hardDelete(deleteRequest)).toMatchObject({
      status: "replayed",
    });
  });

  test("classifies a reconciliation mapping response loss from durable state", async () => {
    const { harness, prepared, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "reconcile-mapping-loss",
      content: "mapped despite lost response",
    });
    await harness.crypto.complete(prepared(allocated, {
      role: "user",
      content: "mapped despite lost response",
    }));
    harness.product.throwAfterNextMappingCommit();

    const report = await harness.repository.reconcilePending({
      leaseToken: "20000000-0000-4000-8000-000000000030",
      limit: 1,
    });
    expect(report.outcomes).toEqual([{
      sequence: 1,
      messageId: 1,
      revision: 0,
      outcome: "mapped",
    }]);
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      completion: "complete",
      disposition: "mapped",
      leaseToken: null,
    });
  });

  test("claims due work by backoff then sequence and isolates poison", async () => {
    const { harness, prepared, allocate } = await fixture();
    const poison = await allocate({
      idempotencyKey: "claim-poison",
      content: "poison",
    });
    const healthy = await allocate({
      idempotencyKey: "claim-healthy",
      content: "healthy",
    });
    await harness.crypto.complete(prepared(healthy, {
      role: "user",
      content: "healthy",
    }));
    harness.product.malformNextClaimCandidate("crypto_object_id");

    const report = await harness.repository.reconcilePending({
      leaseToken: "20000000-0000-4000-8000-000000000001",
      limit: 2,
    });
    expect(report.outcomes).toEqual([
      {
        sequence: 1,
        messageId: poison.messageId,
        revision: 0,
        outcome: "quarantined",
      },
      {
        sequence: 2,
        messageId: healthy.messageId,
        revision: 0,
        outcome: "mapped",
      },
    ]);
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      disposition: "quarantined",
      failureCode: "crypto_mismatch",
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  test("replays only the exact quarantine request after scheduling authority is cleared", async () => {
    const { harness, allocate } = await fixture();
    const allocated = await allocate({
      idempotencyKey: "quarantine-response-loss",
      content: "quarantine me",
    });
    const request = {
      sessionId: allocated.sessionId,
      messageId: allocated.messageId,
      revision: allocated.revision,
      leaseToken: null,
      failureCode: "crypto_mismatch" as const,
    };
    expect(await harness.product.quarantineRevision(request)).toBe("applied");
    expect(await harness.product.quarantineRevision(request)).toBe("duplicate");
    expect(await harness.product.quarantineRevision({
      ...request,
      failureCode: "namespace_mismatch",
    })).toBe("conflict");
  });

  test("orders due reconciliation by next attempt time before sequence", async () => {
    const { harness, allocate, setNow } = await fixture();
    await allocate({ idempotencyKey: "due-first", content: "first" });
    await harness.repository.reconcilePending({
      leaseToken: "20000000-0000-4000-8000-000000000040",
      limit: 1,
    });
    await allocate({ idempotencyKey: "due-second", content: "second" });
    setNow(new Date("2027-01-15T08:02:00.000Z"));

    const report = await harness.repository.reconcilePending({
      leaseToken: "20000000-0000-4000-8000-000000000041",
      limit: 2,
    });
    expect(report.outcomes.map((outcome) => outcome.sequence)).toEqual([
      2,
      1,
    ]);
  });

  test("continues a claimed page after bad coordinates and reclaims the row after lease expiry", async () => {
    const { harness, prepared, allocate, setNow } = await fixture();
    await allocate({
      idempotencyKey: "claim-bad-coordinates",
      content: "bad coordinates",
    });
    const healthy = await allocate({
      idempotencyKey: "claim-after-bad-coordinates",
      content: "healthy",
    });
    await harness.crypto.complete(prepared(healthy, {
      role: "user",
      content: "healthy",
    }));
    harness.product.malformNextClaimCandidate("coordinates");

    expect(harness.repository.reconcilePending({
      leaseToken: "20000000-0000-4000-8000-000000000020",
      limit: 2,
    })).rejects.toThrow(/invalid coordinates/i);
    expect(harness.product.peekLifecycle(2, 0)?.disposition).toBe("mapped");
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      disposition: "active",
      leaseToken: "20000000-0000-4000-8000-000000000020",
    });

    setNow(new Date("2027-01-15T08:02:00.000Z"));
    const reclaimed = await harness.repository.reconcilePending({
      leaseToken: "20000000-0000-4000-8000-000000000021",
      limit: 1,
    });
    expect(reclaimed.outcomes).toEqual([{
      sequence: 1,
      messageId: 1,
      revision: 0,
      outcome: "pending",
    }]);
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      disposition: "active",
      attemptCount: 1,
      failureCode: "crypto_absent",
      leaseToken: null,
    });
  });

  test("bounds retries and quarantines the eighth failed attempt", async () => {
    const { harness, allocate, setNow } = await fixture();
    await allocate({ idempotencyKey: "claim-retry", content: "pending" });
    for (let attempt = 1; attempt <= 8; attempt++) {
      const now = new Date(
        Date.parse("2027-01-15T08:00:00.000Z") + attempt * 1_000_000,
      );
      setNow(now);
      const report = await harness.repository.reconcilePending({
        leaseToken: `20000000-0000-4000-8000-${attempt.toString().padStart(12, "0")}`,
        limit: 1,
      });
      expect(report.outcomes[0]?.outcome).toBe(
        attempt === 8 ? "quarantined" : "pending",
      );
    }
    expect(harness.product.peekLifecycle(1, 0)).toMatchObject({
      attemptCount: 8,
      disposition: "quarantined",
      failureCode: "retry_exhausted",
      nextAttemptAt: null,
      leaseToken: null,
    });
  });
});

describe("message crypto object identity v2", () => {
  test("binds every canonical transcript and notification fact into append replay identity", () => {
    const base = {
      sessionId: SESSION_ALPHA,
      idempotencyKey: "digest-all-facts",
      content: "content",
      keyClass: "ai" as const,
      authorRole: "tool" as const,
      toolCalls: "[{\"name\":\"search\"}]",
      toolName: "search",
      fingerprint: "fingerprint-1",
      humanTurnId: "human-turn-1",
      transcriptOrigin: "subagent" as const,
      parentThreadId: "parent-thread",
      scopeId: "scope-1",
      metadata: { originatedBy: "task" },
      subthreadRoomId: "room-1",
      replyToMessageId: 41,
      notificationContext: {
        mentionedHumanUserIds: ["user-1"],
        causalHumanUserId: "user-2",
        causalHumanTurnId: "turn-2",
      },
      structuralProjection: {
        notificationEligibility: "excluded" as const,
        subthreadReplyClassification: "excluded" as const,
      },
    };
    const baseline = conversationAppendRequestDigest(base);
    for (const changed of [
      { ...base, toolCalls: null },
      { ...base, toolName: null },
      { ...base, fingerprint: "fingerprint-2" },
      { ...base, humanTurnId: null },
      { ...base, transcriptOrigin: "main" as const },
      { ...base, parentThreadId: null },
      { ...base, scopeId: null },
      { ...base, metadata: { originatedBy: "human" } },
      { ...base, subthreadRoomId: null },
      { ...base, replyToMessageId: null },
      {
        ...base,
        notificationContext: {
          ...base.notificationContext,
          mentionedHumanUserIds: ["user-3"],
        },
      },
      {
        ...base,
        structuralProjection: {
          ...base.structuralProjection,
          subthreadReplyClassification: "counted" as const,
        },
      },
    ]) {
      expect(conversationAppendRequestDigest(changed)).not.toEqual(baseline);
    }
  });

  test("uses canonical product coordinates and a stable opaque vector", () => {
    const coordinates = {
      sessionId: SESSION_ALPHA,
      messageId: 42,
      revision: 3,
    };
    const identity = deriveMessageCryptoObjectIdV2(coordinates);

    expect(identity).toBe(
      "message:v2:8525634d13e7eb2e3e922c6bc239cdc30e644cd23e28594404b1afede32ed03d",
    );
    expect(identity).not.toContain(SESSION_ALPHA);
    expect(deriveMessageCryptoObjectIdV2(coordinates)).toBe(identity);
    expect(deriveMessageCryptoObjectIdV2({
      ...coordinates,
      revision: 4,
    })).not.toBe(identity);
  });

  test("binds existing-representation repair identity to authority and policy", () => {
    const input = {
      sessionId: SESSION_ALPHA,
      messageId: 42,
      revision: 3,
      namespaceId: "10000000-0000-4000-8000-000000000003",
      authorRole: "user" as const,
      authorityFingerprint: new Uint8Array(32).fill(0x42),
      policyRevision: 7,
    };
    const identity = conversationExistingRepresentationRepairIdentityDigest(
      input,
    );
    expect(identity).toEqual(
      conversationExistingRepresentationRepairIdentityDigest(input),
    );
    for (const changed of [
      { ...input, revision: 4 },
      { ...input, authorRole: "assistant" as const },
      { ...input, policyRevision: 8 },
      {
        ...input,
        authorityFingerprint: new Uint8Array(32).fill(0x43),
      },
    ]) {
      expect(
        conversationExistingRepresentationRepairIdentityDigest(changed),
      ).not.toEqual(identity);
    }
  });

  test("domain-separates live turn identities by operation, order, and role", () => {
    const coordinates = {
      operationId: "live-turn:alpha",
      sessionId: SESSION_ALPHA,
      messageId: 42,
      revision: 0,
      transcriptOrdinal: 1,
      authorRole: "user" as const,
    };
    const identity = deriveLiveShadowMessageCryptoObjectIdV1(coordinates);
    expect(identity).toBe(
      "message:live-shadow:v1:c1278ee6fa5a834b3780cd4ae19d870c1ff30ec39ffebb8c308b7c0aa14e513d",
    );
    expect(identity).not.toBe(deriveMessageCryptoObjectIdV2(coordinates));
    for (const changed of [
      { ...coordinates, operationId: "live-turn:beta" },
      { ...coordinates, transcriptOrdinal: 2 },
      { ...coordinates, authorRole: "assistant" as const },
      { ...coordinates, messageId: 43 },
    ]) {
      expect(deriveLiveShadowMessageCryptoObjectIdV1(changed)).not.toBe(
        identity,
      );
    }
  });

  test("binds the closed Subthread projection into edit replay identity", () => {
    const input = {
      messageId: 42,
      operationId: "edit-projection-digest",
      expectedRevision: 3,
      content: "edited",
      subthreadReplyClassification: "counted" as const,
    };
    expect(conversationEditRequestDigest({
      ...input,
      subthreadReplyClassification: "excluded",
    })).not.toEqual(conversationEditRequestDigest(input));
  });

  test("rejects noncanonical persisted coordinates", () => {
    expect(() => deriveMessageCryptoObjectIdV2({
      sessionId: "not-a-uuid",
      messageId: 1,
      revision: 0,
    })).toThrow(/Session ID/i);
    expect(() => deriveMessageCryptoObjectIdV2({
      sessionId: SESSION_ALPHA,
      messageId: 0,
      revision: 0,
    })).toThrow(/message ID/i);
    expect(() => deriveMessageCryptoObjectIdV2({
      sessionId: SESSION_ALPHA,
      messageId: 1,
      revision: -1,
    })).toThrow(/revision/i);
  });
});
