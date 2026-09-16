import { describe, expect, test } from "bun:test";

import type {
  ConversationAllocatedRevision,
  ConversationRepository,
  PreparedConversationCryptoRevision,
} from "@nautilo/lattice-bridge";
import type {
  ProtectedMessageDtoV2,
} from "@nautilo/types";

import type {
  PreparedProtectedAgentMessageWrite,
  ProtectedConversationProductReadAuthorization,
  ProtectedConversationProductReadPort,
} from "../../src/conversation/active-conversation-repository";
import {
  createProtectedAgentMessageWriteCoordinator,
} from "../../src/conversation/protected-agent-message-write-coordinator";
import type {
  ForegroundAuthorizationOperationLease,
  ForegroundAuthorizationView,
} from "../../src/protected-execution/foreground-authorization-session";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const AGENT_ID = "40000000-0000-4000-8000-000000000001";
const AUTHORIZATION = {
  sessionId: "foreground:writer",
  viewId: "view:writer",
} as ForegroundAuthorizationView;
const PRODUCT_AUTHORIZATION = Object.freeze({
  subjectId: "human-writer",
  authorizationId: "product-authorization-writer",
}) as unknown as ProtectedConversationProductReadAuthorization;
const PREPARED_REVISION = Object.freeze({
  objectId: "nautilo-message:v2:writer",
  namespaceId: NAMESPACE_ID,
  objectType: "nautilo.conversation.message",
  payloadVersion: 2,
  keyClass: "ai",
}) as unknown as PreparedConversationCryptoRevision;
const ALLOCATION: ConversationAllocatedRevision = Object.freeze({
  status: "allocated",
  sessionId: SESSION_ID,
  messageId: 41,
  revision: 0,
  roomId: ROOM_ID,
  namespaceId: NAMESPACE_ID,
  keyClass: "ai",
  authorRole: "assistant",
  cryptoObjectId: PREPARED_REVISION.objectId,
});
const DTO: ProtectedMessageDtoV2 = Object.freeze({
  dtoVersion: 2,
  projection: Object.freeze({
    messageId: "41",
    sessionId: SESSION_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    role: "assistant",
    createdAt: new Date(1_800_000_000_000).toISOString(),
    editRevision: 0,
    authorAgentId: AGENT_ID,
  }),
  protectedPayload: Object.freeze({
    status: "encrypted",
    cryptoObjectId: PREPARED_REVISION.objectId,
    payloadVersion: 2,
    keyClass: "ai",
    encryptedPayloadBytesBase64url: "AA",
    accessManifestBytesBase64url: "AA",
    namespaceEnvelopeBytesBase64url: "AA",
  }),
});

function fixture(options: Readonly<{
  prepareUnavailable?: boolean;
  failFirstCompletion?: boolean;
  rejectPublicationPolicy?: boolean;
}> = {}) {
  const appendInputs: Array<
    Parameters<ConversationRepository["append"]>[0]
  > = [];
  const completionInputs: Array<
    Parameters<ConversationRepository["completeRevision"]>[0]
  > = [];
  const leaseInputs: unknown[] = [];
  const cryptoInputs: unknown[] = [];
  let failCompletion = options.failFirstCompletion === true;
  const mutations = {
    append: async (
      input: Parameters<ConversationRepository["append"]>[0],
    ) => {
      appendInputs.push(input);
      if (options.rejectPublicationPolicy === true) {
        throw new Error("stale publication policy");
      }
      return Object.freeze({
        ...ALLOCATION,
        status: appendInputs.length === 1
          ? "allocated" as const
          : "replayed" as const,
      });
    },
    completeRevision: async (
      input: Parameters<ConversationRepository["completeRevision"]>[0],
    ) => {
      completionInputs.push(input);
      if (failCompletion) {
        failCompletion = false;
        throw new Error("response lost");
      }
      return Object.freeze({
        status: completionInputs.length > 1 ? "replayed" : "mapped",
        messageId: 41,
        revision: 0,
        cryptoObjectId: PREPARED_REVISION.objectId,
      } as const);
    },
  } as ConversationRepository;
  const productReads = {
    readPage: async () => [],
    readAround: async () => [{
      dto: DTO,
      author: {
        actorId: AGENT_ID,
        handle: "genie",
        displayName: "Genie",
      },
    }],
    readAgentTranscript: async () => ({
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      domainId: "domain-writer",
      expectedAccessRevision: 2,
      expectedPolicyRevision: 7,
      messages: [],
    }),
  } satisfies ProtectedConversationProductReadPort;
  const lease = Object.freeze({
    sessionId: "foreground:writer",
    leaseId: "lease:writer",
  }) as ForegroundAuthorizationOperationLease;
  const registry = {
    leaseOperation(input: unknown) {
      leaseInputs.push(input);
      return Object.freeze({ status: "leased" as const, lease });
    },
    async executeAgentConversationPreparation(
      _lease: ForegroundAuthorizationOperationLease,
      input: unknown,
    ) {
      cryptoInputs.push(input);
      return options.prepareUnavailable === true
        ? Object.freeze({
          status: "unavailable" as const,
          reason: "content_invalid" as const,
        })
        : Object.freeze({
          status: "executed" as const,
          value: PREPARED_REVISION,
        });
    },
  };
  const coordinator = createProtectedAgentMessageWriteCoordinator({
    mutations,
    productReads,
    registry,
    cryptoPreparer: {
      prepare: async () => ({
        status: "prepared",
        revision: PREPARED_REVISION,
      }),
    },
    resolveWriteAuthority: async () => ({
      namespaceId: NAMESPACE_ID,
      domainId: "domain-writer",
      expectedAccessRevision: 2,
      expectedPolicyRevision: 7,
      publicationRepresentation: "ordinary_and_protected",
    }),
    now: () => 1_800_000_000_000,
  });
  return {
    ...coordinator,
    appendInputs,
    completionInputs,
    cryptoInputs,
    leaseInputs,
  };
}

const PREPARE_INPUT = Object.freeze({
  sessionId: SESSION_ID,
  idempotencyKey: "agent-message:writer:41",
  payload: {
    role: "assistant" as const,
    content: "protected response",
  },
  entrypointId: "foreground.main" as const,
  agentId: AGENT_ID,
  appendContext: {
    transcriptOrigin: "main" as const,
    parentThreadId: null,
    scopeId: null,
    subthreadRoomId: null,
    notificationContext: {
      mentionedHumanUserIds: [],
      causalHumanUserId: null,
      causalHumanTurnId: null,
    },
  },
  productReadAuthorization: PRODUCT_AUTHORIZATION,
  authorization: AUTHORIZATION,
});

describe("protected Agent message write coordinator", () => {
  test("allocates, prepares, completes, and replays one opaque Agent write", async () => {
    const state = fixture();
    const prepared = await state.preparer.prepare(PREPARE_INPUT);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("not prepared");
    expect(Object.keys(prepared.write).sort()).toEqual([
      "idempotencyKey",
      "sessionId",
    ]);
    expect(state.appendInputs).toHaveLength(1);
    expect(state.appendInputs[0]).toMatchObject({
      sessionId: SESSION_ID,
      content: "protected response",
      keyClass: "ai",
      authorRole: "assistant",
      publicationPolicy: {
        expectedRevision: 7,
        representation: "ordinary_and_protected",
      },
      metadata: null,
      structuralProjection: {
        notificationEligibility: "eligible",
        subthreadReplyClassification: "counted",
      },
    });
    expect(state.leaseInputs).toHaveLength(1);
    expect(state.cryptoInputs).toHaveLength(1);

    expect(await state.committer.appendPrepared(prepared.write)).toEqual({
      status: "committed",
      message: DTO,
    });
    expect(await state.committer.appendPrepared(prepared.write)).toEqual({
      status: "committed",
      message: DTO,
    });
    expect(state.completionInputs).toHaveLength(1);
    expect(state.completionInputs[0]).toMatchObject({
      messageId: 41,
      expectedRevision: 0,
      parityStatus: "server_verified",
      prepared: PREPARED_REVISION,
    });
  });

  test("leaves an allocated shadow pending when crypto preparation fails", async () => {
    const state = fixture({ prepareUnavailable: true });
    expect(await state.preparer.prepare(PREPARE_INPUT)).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(state.appendInputs).toHaveLength(1);
    expect(state.completionInputs).toHaveLength(0);
  });

  test("rejects a stale Shadow publication policy before crypto preparation", async () => {
    const state = fixture({ rejectPublicationPolicy: true });
    expect(await state.preparer.prepare(PREPARE_INPUT)).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
    });
    expect(state.appendInputs[0]?.publicationPolicy).toEqual({
      expectedRevision: 7,
      representation: "ordinary_and_protected",
    });
    expect(state.cryptoInputs).toHaveLength(0);
    expect(state.completionInputs).toHaveLength(0);
  });

  test("retries a response-loss completion and rejects forged write tokens", async () => {
    const state = fixture({ failFirstCompletion: true });
    const prepared = await state.preparer.prepare(PREPARE_INPUT);
    if (prepared.status !== "prepared") throw new Error("not prepared");
    expect(await state.committer.appendPrepared(prepared.write)).toEqual({
      status: "pending_shadow",
    });
    expect(await state.committer.appendPrepared(prepared.write)).toEqual({
      status: "committed",
      message: DTO,
    });
    expect(state.completionInputs).toHaveLength(2);
    expect(await state.committer.appendPrepared({
      sessionId: SESSION_ID,
      idempotencyKey: "forged",
    } as PreparedProtectedAgentMessageWrite)).toEqual({
      status: "conflict",
    });
  });

  test("replays a durably committed append without regenerating ciphertext", async () => {
    const state = fixture();
    const first = await state.preparer.prepare(PREPARE_INPUT);
    if (first.status !== "prepared") throw new Error("not prepared");
    expect(await state.committer.appendPrepared(first.write)).toMatchObject({
      status: "committed",
    });

    const replay = await state.preparer.prepare(PREPARE_INPUT);
    if (replay.status !== "prepared") throw new Error("not replayed");
    expect(await state.committer.appendPrepared(replay.write)).toEqual({
      status: "committed",
      message: DTO,
    });
    expect(state.cryptoInputs).toHaveLength(1);
    expect(state.completionInputs).toHaveLength(1);
  });
});
