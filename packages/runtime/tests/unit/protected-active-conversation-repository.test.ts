import { describe, expect, it } from "bun:test";
import type {
  ConversationAllocatedRevision,
  ConversationDeleteEffects,
  ConversationEditAllocationResult,
  ConversationRepository,
  MessagePayloadV2,
  PreparedConversationCryptoRevision,
} from "@nautilo/lattice-bridge";
import type {
  ProtectedMessageDtoV2,
} from "@nautilo/types";

import type {
  ForegroundAuthorizationView,
} from "../../src/protected-execution/foreground-authorization-session";
import {
  createProtectedActiveConversationRepository,
} from "../../src/conversation/protected-active-conversation-repository";
import type {
  PreparedProtectedAgentMessageWrite,
  ProtectedConversationAgentContentOpener,
  ProtectedConversationAgentObjectOutcome,
  ProtectedConversationProductReadAuthorization,
  ProtectedConversationProductReadPort,
  ProtectedConversationProductReadRecord,
} from "../../src/conversation/active-conversation-repository";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const SIBLING_SESSION_ID = "00000000-0000-0000-0000-000000000002";
const ROOM_ID = "00000000-0000-0000-0000-000000000003";
const NAMESPACE_ID = "00000000-0000-0000-0000-000000000004";
const OTHER_NAMESPACE_ID = "00000000-0000-0000-0000-000000000005";
const DOMAIN_ID = "domain:active-conversation";
const PRODUCT_READ_AUTHORIZATION =
  Object.freeze({}) as ProtectedConversationProductReadAuthorization;

function payload(
  content: string,
  role: MessagePayloadV2["role"] = "user",
): MessagePayloadV2 {
  return Object.freeze({
    role,
    content,
    ...(role === "user"
      ? {
        toolCalls: [Object.freeze({
          id: "call-1",
          name: "lookup",
          args: Object.freeze({ z: 1, a: "two" }),
        })],
      }
      : {}),
    sensitiveMetadata: Object.freeze({ confidential: "value" }),
  });
}

function contentOnlyPayload(content: string): MessagePayloadV2 {
  return Object.freeze({ role: "user", content });
}

function allocation(
  messageId: number,
  sessionId = SESSION_ID,
  revision = 0,
  overrides: Partial<ConversationAllocatedRevision> = {},
): ConversationAllocatedRevision {
  return Object.freeze({
    status: "allocated",
    sessionId,
    messageId,
    revision,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    keyClass: "ai",
    authorRole: "user",
    cryptoObjectId: `message:v2:${messageId}`,
    ...overrides,
  });
}

function encryptedDto(
  messageId: number,
  overrides: Partial<ProtectedMessageDtoV2["projection"]> = {},
): ProtectedMessageDtoV2 {
  return {
    dtoVersion: 2,
    projection: {
      messageId: String(messageId),
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      role: "user",
      createdAt: new Date(messageId * 1_000).toISOString(),
      editRevision: 0,
      ...overrides,
    },
    protectedPayload: {
      status: "encrypted",
      cryptoObjectId: `message:v2:${messageId}`,
      payloadVersion: 2,
      keyClass: "ai",
      encryptedPayloadBytesBase64url: "AA",
      accessManifestBytesBase64url: "AA",
      namespaceEnvelopeBytesBase64url: "AA",
    },
  };
}

function pendingDto(messageId: number): ProtectedMessageDtoV2 {
  return {
    ...encryptedDto(messageId),
    protectedPayload: {
      status: "pending",
      reason: "shadow_pending",
    },
  };
}

function record(
  dto: ProtectedMessageDtoV2,
  author: Partial<
    ProtectedConversationProductReadRecord["author"]
  > = {},
): ProtectedConversationProductReadRecord {
  return Object.freeze({
    dto,
    author: Object.freeze({
      actorId: "human:one",
      handle: "@human",
      displayName: "Human One",
      ...author,
    }),
  });
}

function noReads(): ProtectedConversationProductReadPort {
  return {
    readPage: async () => [],
    readAround: async () => [],
    readAgentTranscript: async () => null,
  };
}

function noOpener(): ProtectedConversationAgentContentOpener {
  return {
    openBatch: async () => ({
      status: "unavailable",
      reason: "authorization_unavailable",
    }),
  };
}

function mutationFake(overrides: Partial<ConversationRepository> = {}): {
  readonly repository: ConversationRepository;
  readonly completed: Array<
    Parameters<ConversationRepository["completeRevision"]>[0]
  >;
} {
  const completed: Array<
    Parameters<ConversationRepository["completeRevision"]>[0]
  > = [];
  const repository: ConversationRepository = {
    append: async () => allocation(11),
    completeRevision: async (input) => {
      completed.push(input);
      return {
        status: "mapped",
        messageId: input.messageId,
        revision: input.expectedRevision,
        cryptoObjectId: input.prepared.objectId,
      };
    },
    edit: async () => ({
      ...allocation(11, SESSION_ID, 1),
      allocations: [allocation(11, SESSION_ID, 1)],
    }),
    hardDelete: async ({ messageId }) => ({
      status: "missing",
      messageId,
    }),
    reconcilePending: async () => ({ outcomes: [] }),
    ...overrides,
  };
  return { repository, completed };
}

function repositoryOptions(input: {
  readonly mutations?: ConversationRepository;
  readonly productReads?: ProtectedConversationProductReadPort;
  readonly agentContentOpener?: ProtectedConversationAgentContentOpener;
}) {
  return {
    mutations: input.mutations ?? mutationFake().repository,
    productReads: input.productReads ?? noReads(),
    agentContentOpener: input.agentContentOpener ?? noOpener(),
    agentWrites: {
      appendPrepared: async () => ({ status: "pending_shadow" as const }),
    },
  };
}

function humanAppendInput() {
  return {
    sessionId: SESSION_ID,
    idempotencyKey: "append:one",
    keyClass: "ai" as const,
    legacyPayload: payload("human plaintext"),
    fingerprint: "fingerprint:one",
    humanTurnId: "turn:one",
    transcriptOrigin: "main" as const,
    parentThreadId: null,
    scopeId: null,
    subthreadRoomId: null,
    replyToMessageId: null,
    notificationContext: {
      mentionedHumanUserIds: [],
      causalHumanUserId: null,
      causalHumanTurnId: null,
    },
    structuralProjection: {
      notificationEligibility: "eligible" as const,
      subthreadReplyClassification: "counted" as const,
    },
  };
}

describe("protected Active conversation repository", () => {
  it("allocates Human coordinates first and completes every grouped edit sibling", async () => {
    const appended: Array<
      Parameters<ConversationRepository["append"]>[0]
    > = [];
    const edited: Array<Parameters<ConversationRepository["edit"]>[0]> = [];
    const fake = mutationFake({
      append: async (input) => {
        appended.push(input);
        return allocation(11);
      },
      edit: async (input) => {
        edited.push(input);
        return {
          ...allocation(11, SESSION_ID, 1),
          allocations: [
            allocation(11, SESSION_ID, 1),
            allocation(22, SIBLING_SESSION_ID, 1),
          ],
        };
      },
    });
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({ mutations: fake.repository }),
    );

    expect(await repository.allocateHumanAppend(humanAppendInput())).toEqual({
      status: "allocated",
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      namespaceId: NAMESPACE_ID,
      cryptoObjectId: "message:v2:11",
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      content: "human plaintext",
      authorRole: "user",
      keyClass: "ai",
      metadata: { confidential: "value" },
      structuralProjection: {
        notificationEligibility: "eligible",
        subthreadReplyClassification: "counted",
      },
    });
    expect(appended[0]!.toolCalls).toBe(
      '[{"id":"call-1","name":"lookup","args":{"a":"two","z":1}}]',
    );
    expect(fake.completed).toEqual([]);

    const edit = await repository.allocateHumanEdit({
      messageId: 11,
      operationId: "edit:one",
      expectedRevision: 0,
      legacyPayload: contentOnlyPayload("edited plaintext"),
      subthreadReplyClassification: "counted",
    });
    expect(edit).toEqual({
      status: "allocated",
      allocations: [
        {
          status: "allocated",
          sessionId: SESSION_ID,
          messageId: 11,
          revision: 1,
          namespaceId: NAMESPACE_ID,
          cryptoObjectId: "message:v2:11",
        },
        {
          status: "allocated",
          sessionId: SIBLING_SESSION_ID,
          messageId: 22,
          revision: 1,
          namespaceId: NAMESPACE_ID,
          cryptoObjectId: "message:v2:22",
        },
      ],
    });
    expect(edited).toEqual([{
      messageId: 11,
      operationId: "edit:one",
      expectedRevision: 0,
      content: "edited plaintext",
      subthreadReplyClassification: "counted",
    }]);
    if (edit.status !== "allocated" && edit.status !== "replayed") {
      throw new Error("expected grouped edit allocations");
    }
    for (const physical of edit.allocations) {
      await repository.completeHumanRevision({
        messageId: physical.messageId,
        expectedRevision: physical.revision,
        preparedClientRevision: {
          objectId: physical.cryptoObjectId,
          namespaceId: physical.namespaceId,
          objectType: "nautilo-message-v2",
          payloadVersion: 2,
          keyClass: "ai",
        } as PreparedConversationCryptoRevision,
      });
    }
    expect(fake.completed.map((item) => ({
      messageId: item.messageId,
      revision: item.expectedRevision,
      parityStatus: item.parityStatus,
      objectId: item.prepared.objectId,
    }))).toEqual([
      {
        messageId: 11,
        revision: 1,
        parityStatus: "client_verified",
        objectId: "message:v2:11",
      },
      {
        messageId: 22,
        revision: 1,
        parityStatus: "client_verified",
        objectId: "message:v2:22",
      },
    ]);
  });

  it("keeps Human edits content-only before touching the shadow mutation", async () => {
    let editCalls = 0;
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({
        mutations: mutationFake({
          edit: async () => {
            editCalls += 1;
            return {
              ...allocation(11, SESSION_ID, 1),
              allocations: [allocation(11, SESSION_ID, 1)],
            };
          },
        }).repository,
      }),
    );
    const confidentialVariants: readonly MessagePayloadV2[] = [
      {
        role: "user",
        content: "edit",
        toolCalls: [],
      },
      {
        role: "user",
        content: "edit",
        toolName: "tool",
      },
      {
        role: "user",
        content: "edit",
        sensitiveMetadata: {},
      },
      {
        role: "user",
        content: "edit",
        attachmentRefs: [],
      },
    ];
    for (const legacyPayload of confidentialVariants) {
      const error = await repository.allocateHumanEdit({
        messageId: 11,
        operationId: "edit:content-only",
        expectedRevision: 0,
        legacyPayload,
        subthreadReplyClassification: "counted",
      }).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "Human conversation edits may change content only",
      );
    }
    expect(editCalls).toBe(0);
  });

  it("rejects malformed grouped Human edit allocations exactly", async () => {
    const top = allocation(11, SESSION_ID, 1);
    const sibling = allocation(22, SIBLING_SESSION_ID, 1);
    const malformed: readonly ConversationEditAllocationResult[] = [
      { ...top, allocations: [top, top] },
      { ...top, allocations: [sibling] },
      {
        ...top,
        allocations: [allocation(11, SESSION_ID, 2)],
      },
      {
        ...top,
        allocations: [
          top,
          allocation(22, SIBLING_SESSION_ID, 1, {
            namespaceId: OTHER_NAMESPACE_ID,
          }),
        ],
      },
      {
        ...top,
        allocations: [
          allocation(11, SESSION_ID, 1, { keyClass: "human" }),
        ],
      },
      {
        ...top,
        allocations: [
          allocation(11, SESSION_ID, 1, {
            authorRole: "assistant",
          }),
        ],
      },
      {
        ...top,
        allocations: [
          allocation(11, SESSION_ID, 1, { status: "replayed" }),
        ],
      },
      {
        ...top,
        cryptoObjectId: "message:v2:wrong-top-level",
        allocations: [top],
      },
    ];
    for (const result of malformed) {
      const repository = createProtectedActiveConversationRepository(
        repositoryOptions({
          mutations: mutationFake({
            edit: async () => result,
          }).repository,
        }),
      );
      const error = await repository.allocateHumanEdit({
        messageId: 11,
        operationId: "edit:malformed-group",
        expectedRevision: 0,
        legacyPayload: contentOnlyPayload("edit"),
        subthreadReplyClassification: "counted",
      }).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "Human edit allocation group is malformed",
      );
    }
  });

  it("maps the durable hard-delete effects without reconstructing them", async () => {
    const effects: ConversationDeleteEffects = {
      roomId: ROOM_ID,
      wasUnread: true,
      orphanedTurnId: "turn:one",
      rootSummary: {
        parentRoomId: ROOM_ID,
        anchorMessageId: 4,
        replyCount: 2,
        lastReplyAt: new Date(4_000),
        revision: 7,
      },
    };
    const fake = mutationFake({
      hardDelete: async () => ({
        status: "replayed",
        messageId: 11,
        revision: 0,
        cryptoObjectId: "message:v2:11",
        effects,
      }),
    });
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({ mutations: fake.repository }),
    );

    expect(await repository.hardDelete({
      messageId: 11,
      operationId: "delete:one",
      expectedRevision: 0,
    })).toEqual({
      status: "committed",
      disposition: "replayed",
      effects,
    });
  });

  it("returns only protected Human DTOs and keeps search explicitly unavailable", async () => {
    let pageCalls = 0;
    let aroundCalls = 0;
    const first = record(encryptedDto(1));
    const second = record(pendingDto(2));
    const productReads: ProtectedConversationProductReadPort = {
      readPage: async (input) => {
        expect(input.authorization).toBe(PRODUCT_READ_AUTHORIZATION);
        pageCalls += 1;
        return [first, second];
      },
      readAround: async (input) => {
        expect(input.authorization).toBe(PRODUCT_READ_AUTHORIZATION);
        aroundCalls += 1;
        return [second];
      },
      readAgentTranscript: async () => null,
    };
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({ productReads }),
    );

    const page = await repository.readHumanMessages({
      kind: "page",
      authorization: PRODUCT_READ_AUTHORIZATION,
      sessionId: SESSION_ID,
      limit: 2,
    });
    expect(page).toEqual({
      status: "available",
      messages: [
        { mode: "protected", dto: first.dto },
        { mode: "protected", dto: second.dto },
      ],
    });
    expect(
      await repository.readHumanMessages({
        kind: "around",
        authorization: PRODUCT_READ_AUTHORIZATION,
        sessionId: SESSION_ID,
        messageId: 2,
        radius: 1,
      }),
    ).toEqual({
      status: "available",
      messages: [{ mode: "protected", dto: second.dto }],
    });
    expect(
      await repository.readHumanMessages({
        kind: "search",
        namespaceId: NAMESPACE_ID,
        query: "human plaintext",
        limit: 10,
      }),
    ).toEqual({
      status: "unavailable",
      reason: "search_unavailable",
    });
    expect({ pageCalls, aroundCalls }).toEqual({
      pageCalls: 1,
      aroundCalls: 1,
    });
  });

  it("fails closed on reordered, cross-Room/Namespace, and malformed-author Human rows", async () => {
    const cases: readonly (
      readonly ProtectedConversationProductReadRecord[]
    )[] = [
      [record(encryptedDto(2)), record(encryptedDto(1))],
      [
        record(encryptedDto(1)),
        record(encryptedDto(2, { namespaceId: OTHER_NAMESPACE_ID })),
      ],
      [
        record(encryptedDto(1)),
        record(encryptedDto(2, {
          roomId: "00000000-0000-0000-0000-000000000006",
        })),
      ],
      [record(encryptedDto(1), { displayName: "\u0000invalid" })],
    ];
    for (const rows of cases) {
      const repository = createProtectedActiveConversationRepository(
        repositoryOptions({
          productReads: {
            ...noReads(),
            readPage: async () => rows,
          },
        }),
      );
      expect(await repository.readHumanMessages({
        kind: "page",
        authorization: PRODUCT_READ_AUTHORIZATION,
        sessionId: SESSION_ID,
        limit: 2,
      })).toEqual({
        status: "unavailable",
        reason: "content_invalid",
      });
    }
  });

  it("fails closed when Human page cursors or around anchors are violated", async () => {
    const cases = [
      {
        read: {
          kind: "page" as const,
          authorization: PRODUCT_READ_AUTHORIZATION,
          sessionId: SESSION_ID,
          beforeMessageId: 2,
          limit: 2,
        },
        rows: [record(encryptedDto(2))],
      },
      {
        read: {
          kind: "around" as const,
          authorization: PRODUCT_READ_AUTHORIZATION,
          sessionId: SESSION_ID,
          messageId: 2,
          radius: 1,
        },
        rows: [record(encryptedDto(1)), record(encryptedDto(3))],
      },
      {
        read: {
          kind: "around" as const,
          authorization: PRODUCT_READ_AUTHORIZATION,
          sessionId: SESSION_ID,
          messageId: 1,
          radius: 1,
        },
        rows: [
          record(encryptedDto(1)),
          record(encryptedDto(2)),
          record(encryptedDto(3)),
        ],
      },
    ];
    for (const item of cases) {
      const repository = createProtectedActiveConversationRepository(
        repositoryOptions({
          productReads: {
            ...noReads(),
            readPage: async () => item.rows,
            readAround: async () => item.rows,
          },
        }),
      );
      expect(await repository.readHumanMessages(item.read)).toEqual({
        status: "unavailable",
        reason: "content_invalid",
      });
    }
  });

  it("rejects unbounded Human and Agent reads before invoking a product port", async () => {
    let productCalls = 0;
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          readPage: async () => {
            productCalls += 1;
            return [];
          },
          readAround: async () => {
            productCalls += 1;
            return [];
          },
          readAgentTranscript: async () => {
            productCalls += 1;
            return null;
          },
        },
      }),
    );

    const operations = [
      () => repository.readHumanMessages({
        kind: "page",
        authorization: PRODUCT_READ_AUTHORIZATION,
        sessionId: SESSION_ID,
        limit: 257,
      }),
      () => repository.readHumanMessages({
        kind: "around",
        authorization: PRODUCT_READ_AUTHORIZATION,
        sessionId: SESSION_ID,
        messageId: 1,
        radius: 128,
      }),
      () => repository.withAgentTranscript({
        sessionId: SESSION_ID,
        namespaceId: NAMESPACE_ID,
        limit: 257,
        productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
        authorization: {
          sessionId: "foreground:one",
          viewId: "view:one",
        } as ForegroundAuthorizationView,
        entrypointId: "foreground.main",
        execute: () => undefined,
      }),
    ] as const;
    const failures = await Promise.allSettled(
      operations.map((operation) => operation()),
    );
    expect(failures.map((failure) =>
      failure.status === "rejected"
        ? String(failure.reason)
        : "unexpected success"
    )).toEqual([
      "RangeError: protected conversation read limit is out of bounds",
      "RangeError: protected conversation around radius is out of bounds",
      "RangeError: protected conversation read limit is out of bounds",
    ]);
    expect(productCalls).toBe(0);
  });

  it("opens Agent transcript content only inside the exact injected authorization callback", async () => {
    const first = record(encryptedDto(1, { role: "assistant" }));
    const second = record(encryptedDto(2, { role: "tool" }));
    const authorization = {
      sessionId: "foreground:one",
      viewId: "view:one",
    } as ForegroundAuthorizationView;
    let openerCallbackIsLive = false;
    let executeCalls = 0;
    const opener: ProtectedConversationAgentContentOpener = {
      openBatch: async (input) => {
        expect(input.authorizationSession).toBe(authorization);
        expect(input.entrypointId).toBe("foreground.main");
        expect(input.namespaceId).toBe(NAMESPACE_ID);
        expect(input.domainId).toBe(DOMAIN_ID);
        expect(input.expectedAccessRevision).toBe(4);
        expect(input.expectedPolicyRevision).toBe(9);
        openerCallbackIsLive = true;
        try {
          return {
            status: "executed",
            value: await input.execute([
              {
                status: "opened",
                messageId: 1,
                revision: 0,
                payload: payload("assistant answer", "assistant"),
              },
              {
                status: "opened",
                messageId: 2,
                revision: 0,
                payload: payload("tool result", "tool"),
              },
            ]),
          };
        } finally {
          openerCallbackIsLive = false;
        }
      },
    };
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async (input) => {
            expect(input.authorization).toBe(
              PRODUCT_READ_AUTHORIZATION,
            );
            return {
              sessionId: SESSION_ID,
              roomId: ROOM_ID,
              namespaceId: NAMESPACE_ID,
              domainId: DOMAIN_ID,
              expectedAccessRevision: 4,
              expectedPolicyRevision: 9,
              messages: [first, second],
            };
          },
        },
        agentContentOpener: opener,
      }),
    );

    const result = await repository.withAgentTranscript({
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      limit: 2,
      productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
      authorization,
      entrypointId: "foreground.main",
      execute: (messages) => {
        executeCalls += 1;
        expect(openerCallbackIsLive).toBe(true);
        expect(messages.map((message) => ({
          messageId: message.messageId,
          role: message.payload.role,
          content: message.payload.content,
        }))).toEqual([
          {
            messageId: 1,
            role: "assistant",
            content: "assistant answer",
          },
          { messageId: 2, role: "tool", content: "tool result" },
        ]);
        return "finished";
      },
    });
    expect(result).toEqual({ status: "executed", value: "finished" });
    expect(executeCalls).toBe(1);
    expect(openerCallbackIsLive).toBe(false);
  });

  it("preserves an Agent execution callback failure instead of disguising it as a content read failure", async () => {
    const executionFailure = new Error("graph execution failed");
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async () => ({
            sessionId: SESSION_ID,
            roomId: ROOM_ID,
            namespaceId: NAMESPACE_ID,
            domainId: DOMAIN_ID,
            expectedAccessRevision: 4,
            expectedPolicyRevision: 9,
            messages: [
              record(encryptedDto(1, { role: "assistant" })),
            ],
          }),
        },
        agentContentOpener: {
          openBatch: async (input) => ({
            status: "executed",
            value: await input.execute([{
              status: "opened",
              messageId: 1,
              revision: 0,
              payload: payload("history", "assistant"),
            }]),
          }),
        },
      }),
    );

    const result = repository.withAgentTranscript({
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      limit: 1,
      productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
      authorization: {
        sessionId: "foreground:one",
        viewId: "view:one",
      } as ForegroundAuthorizationView,
      entrypointId: "foreground.main",
      execute: () => {
        throw executionFailure;
      },
    });

    expect(await result.catch((error: unknown) => error)).toBe(
      executionFailure,
    );
  });

  it("rejects Agent rows beyond the requested causal boundary before opening", async () => {
    let openerCalls = 0;
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async (input) => {
            expect(input.upToMessageId).toBe(1);
            return {
              sessionId: SESSION_ID,
              roomId: ROOM_ID,
              namespaceId: NAMESPACE_ID,
              domainId: DOMAIN_ID,
              expectedAccessRevision: 4,
              expectedPolicyRevision: 9,
              messages: [
                record(encryptedDto(2, { role: "assistant" })),
              ],
            };
          },
        },
        agentContentOpener: {
          openBatch: async () => {
            openerCalls += 1;
            return {
              status: "unavailable",
              reason: "content_unavailable",
            };
          },
        },
      }),
    );
    expect(await repository.withAgentTranscript({
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      upToMessageId: 1,
      limit: 1,
      productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
      authorization: {
        sessionId: "foreground:one",
        viewId: "view:one",
      } as ForegroundAuthorizationView,
      entrypointId: "foreground.main",
      execute: () => "must not run",
    })).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(openerCalls).toBe(0);
  });

  it("fails closed when the Agent opener throws or supplies a non-array outcome", async () => {
    const message = record(encryptedDto(1, { role: "assistant" }));
    const batch = {
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 4,
      expectedPolicyRevision: 9,
      messages: [message],
    } as const;
    let userExecuteCalls = 0;
    const input = {
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      limit: 1,
      productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
      authorization: {
        sessionId: "foreground:one",
        viewId: "view:one",
      } as ForegroundAuthorizationView,
      entrypointId: "foreground.main" as const,
      execute: () => {
        userExecuteCalls += 1;
        return "must not run";
      },
    };

    const throwing = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async () => batch,
        },
        agentContentOpener: {
          openBatch: async () => {
            throw new Error("opener failed");
          },
        },
      }),
    );
    expect(await throwing.withAgentTranscript(input)).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
    });

    const malformedOutcomes = Object.freeze({}) as unknown as ReadonlyArray<
      ProtectedConversationAgentObjectOutcome
    >;
    const nonArray = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async () => batch,
        },
        agentContentOpener: {
          openBatch: async (openInput) => ({
            status: "executed",
            value: await openInput.execute(malformedOutcomes),
          }),
        },
      }),
    );
    expect(await nonArray.withAgentTranscript(input)).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(userExecuteCalls).toBe(0);
  });

  it("expires a retained Agent opener callback when openBatch settles", async () => {
    const retained: {
      execute: ((
        outcomes: readonly ProtectedConversationAgentObjectOutcome[],
      ) => unknown) | null;
    } = { execute: null };
    let userExecuteCalls = 0;
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async () => ({
            sessionId: SESSION_ID,
            roomId: ROOM_ID,
            namespaceId: NAMESPACE_ID,
            domainId: DOMAIN_ID,
            expectedAccessRevision: 4,
            expectedPolicyRevision: 9,
            messages: [
              record(encryptedDto(1, { role: "assistant" })),
            ],
          }),
        },
        agentContentOpener: {
          openBatch: async (input) => {
            retained.execute = input.execute;
            return {
              status: "unavailable",
              reason: "authorization_unavailable",
            };
          },
        },
      }),
    );
    expect(await repository.withAgentTranscript({
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      limit: 1,
      productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
      authorization: {
        sessionId: "foreground:one",
        viewId: "view:one",
      } as ForegroundAuthorizationView,
      entrypointId: "foreground.main",
      execute: () => {
        userExecuteCalls += 1;
      },
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(retained.execute).not.toBeNull();
    expect(await retained.execute!([{
      status: "opened",
      messageId: 1,
      revision: 0,
      payload: payload("late plaintext", "assistant"),
    }])).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(userExecuteCalls).toBe(0);
  });

  it("retains mixed per-object outcomes and never falls back to plaintext", async () => {
    const first = record(encryptedDto(1, { role: "assistant" }));
    const second = record(pendingDto(2));
    let userExecuteCalls = 0;
    const repository = createProtectedActiveConversationRepository(
      repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async () => ({
            sessionId: SESSION_ID,
            roomId: ROOM_ID,
            namespaceId: NAMESPACE_ID,
            domainId: DOMAIN_ID,
            expectedAccessRevision: 4,
            expectedPolicyRevision: 9,
            messages: [first, second],
          }),
        },
        agentContentOpener: {
          openBatch: async (input) => ({
            status: "executed",
            value: await input.execute([
              {
                status: "opened",
                messageId: 1,
                revision: 0,
                payload: payload("opened only", "assistant"),
              },
              {
                status: "pending",
                messageId: 2,
                revision: 0,
                reason: "shadow_pending",
              },
            ]),
          }),
        },
      }),
    );

    const result = await repository.withAgentTranscript({
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      limit: 2,
      productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
      authorization: {
        sessionId: "foreground:one",
        viewId: "view:one",
      } as ForegroundAuthorizationView,
      entrypointId: "foreground.main",
      execute: () => {
        userExecuteCalls += 1;
      },
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
      outcomes: [
        { status: "opened", messageId: 1, revision: 0 },
        {
          status: "pending",
          messageId: 2,
          revision: 0,
          reason: "shadow_pending",
        },
      ],
    });
    expect(userExecuteCalls).toBe(0);
  });

  it("rejects malformed Agent outcome order and forwards opaque prepared writes", async () => {
    const dto = record(encryptedDto(1, { role: "assistant" }));
    const prepared = {
      sessionId: SESSION_ID,
      idempotencyKey: "agent:one",
    } as PreparedProtectedAgentMessageWrite;
    const forwarded: PreparedProtectedAgentMessageWrite[] = [];
    const repository = createProtectedActiveConversationRepository({
      ...repositoryOptions({
        productReads: {
          ...noReads(),
          readAgentTranscript: async () => ({
            sessionId: SESSION_ID,
            roomId: ROOM_ID,
            namespaceId: NAMESPACE_ID,
            domainId: DOMAIN_ID,
            expectedAccessRevision: 4,
            expectedPolicyRevision: 9,
            messages: [dto],
          }),
        },
        agentContentOpener: {
          openBatch: async (input) => ({
            status: "executed",
            value: await input.execute([{
              status: "opened",
              messageId: 999,
              revision: 0,
              payload: payload("wrong coordinate", "assistant"),
            }]),
          }),
        },
      }),
      agentWrites: {
        appendPrepared: async (write) => {
          forwarded.push(write);
          return { status: "pending_shadow" };
        },
      },
    });
    expect(await repository.withAgentTranscript({
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      limit: 1,
      productReadAuthorization: PRODUCT_READ_AUTHORIZATION,
      authorization: {
        sessionId: "foreground:one",
        viewId: "view:one",
      } as ForegroundAuthorizationView,
      entrypointId: "foreground.main",
      execute: () => "must not run",
    })).toMatchObject({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(await repository.appendPreparedAgent(prepared)).toEqual({
      status: "pending_shadow",
    });
    expect(forwarded).toEqual([prepared]);
  });
});
