import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  createDormantConversationShadowRepository,
  type ConversationProtectedProductReadAuthorization,
} from "@nautilo/lattice-bridge";
import {
  FakeAtomicConversationCryptoCompletion,
  FakeConversationProductStore,
  createSyntheticProtectedAgentConversationCryptoHarness,
} from "@nautilo/lattice-bridge/testing";
import {
  parseProtectedMessageRealtimeEventV2,
  type ProtectedMessageDtoV2,
  type ServerEvent,
} from "@nautilo/types";

import {
  createProtectedActiveConversationRepository,
} from "../../src/conversation/protected-active-conversation-repository";
import {
  createProtectedAgentMessageWriteCoordinator,
} from "../../src/conversation/protected-agent-message-write-coordinator";
import {
  createProtectedConversationJobRunner,
} from "../../src/conversation/protected-conversation-job-runner";
import {
  ForegroundAuthorizationSessionRegistry,
  foregroundAuthorizationChildWorkDescriptorDigest,
} from "../../src/protected-execution/foreground-authorization-session";
import { createDormantEncryptedCheckpointSaverForTests } from "./support/encrypted-checkpoint-saver";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";
const SUBTHREAD_ROOM_ID = "20000000-0000-4000-8000-000000000002";
const LANE_KEY = `room:${ROOM_ID}`;
const PRODUCT_AUTHORIZATION = Object.freeze(
  {},
) as ConversationProtectedProductReadAuthorization;

function encoded(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("Wave 9 protected Agent conversation vertical slice", () => {
  test("uses one reusable foreground Grant for durable Agent-v3 writes, replay, and protected realtime", async () => {
    const crypto = await createSyntheticProtectedAgentConversationCryptoHarness();
    const events: string[] = [];
    const product = new FakeConversationProductStore(events);
    product.addSession({
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: crypto.namespaceId,
      ownerId: crypto.humanId,
    });
    const completion = new FakeAtomicConversationCryptoCompletion({
      crypto: crypto.crypto,
      events,
      storage: crypto.storage,
    });
    const mutations = createDormantConversationShadowRepository({
      product,
      crypto: completion,
    });
    const historicalMessageIds: number[] = [];

    const protectedRecord = async (
      messageId: number,
    ) => {
      const message = product.peekMessage(messageId);
      if (message?.cryptoObjectId === null || message === null) return null;
      const object = await crypto.storage.getObject(message.cryptoObjectId);
      const access = await crypto.storage.getObjectAccessState(
        message.cryptoObjectId,
      );
      const envelope = access?.namespaceEnvelopes.find((candidate) =>
        candidate.namespaceId === crypto.namespaceId
      );
      if (object === null || access === null || envelope === undefined) {
        return null;
      }
      const dto: ProtectedMessageDtoV2 = Object.freeze({
        dtoVersion: 2,
        projection: Object.freeze({
          messageId: String(message.messageId),
          sessionId: message.sessionId,
          roomId: message.roomId,
          namespaceId: crypto.namespaceId,
          role: message.authorRole,
          createdAt: new Date(crypto.now + message.messageId).toISOString(),
          editRevision: message.revision,
          ...(message.authorRole === "user"
            ? {}
            : { authorAgentId: crypto.agentId }),
        }),
        protectedPayload: Object.freeze({
          status: "encrypted",
          cryptoObjectId: message.cryptoObjectId,
          payloadVersion: 2,
          keyClass: message.keyClass,
          encryptedPayloadBytesBase64url: encoded(object.payloadBytes),
          accessManifestBytesBase64url:
            encoded(access.head.manifestBytes),
          namespaceEnvelopeBytesBase64url:
            encoded(envelope.envelopeBytes),
        }),
      });
      return Object.freeze({
        dto,
        author: Object.freeze({
          actorId: message.authorRole === "user"
            ? crypto.humanId
            : crypto.agentId,
          handle: message.authorRole === "user" ? "owner" : "genie",
          displayName: message.authorRole === "user" ? "Owner" : "Genie",
        }),
      });
    };
    const productReads = {
      readPage: async () => [],
      readAround: async (input: { readonly messageId: number }) => {
        const record = await protectedRecord(input.messageId);
        return record === null ? [] : [record];
      },
      readAgentTranscript: async () => {
        const records = await Promise.all(
          historicalMessageIds.map(protectedRecord),
        );
        return {
          sessionId: SESSION_ID,
          roomId: ROOM_ID,
          namespaceId: crypto.namespaceId,
          domainId: crypto.domainId,
          expectedAccessRevision: crypto.expectedAccessRevision,
          expectedPolicyRevision: crypto.expectedPolicyRevision,
          messages: records.filter((record) => record !== null),
        };
      },
    };
    let viewSequence = 0;
    const registry = new ForegroundAuthorizationSessionRegistry({
      contentPort: {
        execute: async () => ({
          status: "unavailable",
          reason: "authorization_unavailable",
        }),
      },
      now: () => crypto.now + 3,
      createSessionId: () => "foreground:wave-9-scenario",
      createViewId: () => `view:wave-9-scenario:${++viewSequence}`,
      createLeaseId: (() => {
        let sequence = 0;
        return () => `lease:wave-9-scenario:${++sequence}`;
      })(),
      startSweep: false,
    });
    const registered = registry.register({
      capability: crypto.capability,
      authenticatedBinding: {
        humanId: crypto.humanId,
        issuingDeviceId: crypto.deviceId,
        recipientAgentId: crypto.agentId,
      },
      allowedOperations: ["encrypt"],
    });
    expect(registered.status).toBe("registered");
    if (registered.status !== "registered") {
      throw new Error(registered.reason);
    }
    const writes = createProtectedAgentMessageWriteCoordinator({
      mutations,
      productReads,
      registry,
      cryptoPreparer: crypto.preparer,
      resolveWriteAuthority: async () => ({
        namespaceId: crypto.namespaceId,
        domainId: crypto.domainId,
        expectedAccessRevision: crypto.expectedAccessRevision,
        expectedPolicyRevision: crypto.expectedPolicyRevision,
        publicationRepresentation: "ordinary_and_protected",
      }),
      now: () => crypto.now,
    });
    const repository = createProtectedActiveConversationRepository({
      mutations,
      productReads,
      agentWrites: writes.committer,
      agentContentOpener: {
        openBatch: async (input) => {
          const outcomes = await Promise.all(input.messages.map(
            async (record) => {
              const protectedPayload = record.dto.protectedPayload;
              if (protectedPayload.status !== "encrypted") {
                throw new Error("expected encrypted synthetic history");
              }
              return {
                status: "opened" as const,
                messageId: Number(record.dto.projection.messageId),
                revision: record.dto.projection.editRevision,
                payload: await crypto.readPayload(
                  protectedPayload.cryptoObjectId,
                ),
              };
            },
          ));
          return Object.freeze({
            status: "executed" as const,
            value: await input.execute(outcomes),
          });
        },
      },
    });
    const runner = createProtectedConversationJobRunner({
      entrypointId: "foreground.main",
      run: async function* (
        _input,
        _jobId,
        laneKey,
        _signal,
        _services,
        _invocation,
        scope,
      ) {
        expect(scope.history).toHaveLength(1);
        expect(scope.history[0]).toMatchObject({
          role: "user",
          authorDisplayName: "Owner",
          snippet: "Human question",
        });
        await scope.persist([
          new AIMessage({
            content: "I will inspect it.",
            tool_calls: [{
              id: "call-wave-9",
              name: "lookup",
              args: { query: "private" },
              type: "tool_call",
            }],
          }),
          new ToolMessage({
            content: "private tool result",
            tool_call_id: "call-wave-9",
            name: "lookup",
          }),
          new AIMessage("protected final answer"),
        ]);
        yield {
          type: "tool.end",
          laneKey,
          toolCallId: "call-wave-9",
          toolName: "lookup",
          duration: 1,
          status: "success",
          result: "must not cross realtime",
        };
        yield {
          type: "message.tokens",
          laneKey,
          content: "must not cross realtime",
          chunkSequence: 1,
          done: true,
        };
      },
    });
    const services = Object.freeze({
      repository,
      authorization: registered.rootView,
      checkpointSavers: Object.freeze({
        createForInvocation: ({ logicalThreadId }: {
          readonly logicalThreadId: string;
        }) =>
          createDormantEncryptedCheckpointSaverForTests(logicalThreadId),
      }),
      protectedAgentMessagePreparer: writes.preparer,
    });
    const invocation = Object.freeze({
      sessionId: SESSION_ID,
      namespaceId: crypto.namespaceId,
      productReadAuthorization: PRODUCT_AUTHORIZATION,
    });
    const jobInput = {
      roomId: ROOM_ID,
      agentId: crypto.agentId,
      turnId: "turn-wave-9-scenario",
    };

    const human = await repository.allocateHumanAppend({
      sessionId: SESSION_ID,
      idempotencyKey: "human-wave-9-question",
      keyClass: "ai",
      legacyPayload: {
        role: "user",
        content: "Human question",
      },
      fingerprint: "human-wave-9-question",
      humanTurnId: "turn-wave-9-human",
      transcriptOrigin: "main",
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
        notificationEligibility: "eligible",
        subthreadReplyClassification: "counted",
      },
    });
    expect(human.status).toBe("allocated");
    if (human.status !== "allocated" && human.status !== "replayed") {
      throw new Error("Human allocation failed");
    }
    expect(await repository.completeHumanRevision({
      messageId: human.messageId,
      expectedRevision: human.revision,
      preparedClientRevision: crypto.prepareHumanRevision(
        human.cryptoObjectId,
        { role: "user", content: "Human question" },
      ),
    })).toMatchObject({
      status: "mapped",
      messageId: human.messageId,
      cryptoObjectId: human.cryptoObjectId,
    });
    historicalMessageIds.push(human.messageId);
    expect(await crypto.readPayload(human.cryptoObjectId)).toEqual({
      role: "user",
      content: "Human question",
    });

    const runOnce = async () => {
      const published: ServerEvent[] = [];
      for await (const event of runner(
        jobInput,
        "job-wave-9-scenario",
        LANE_KEY,
        new AbortController().signal,
        services,
        invocation,
      )) {
        published.push(event);
      }
      return published;
    };

    const first = await runOnce().catch((cause: unknown) => {
      throw new Error(
        `Protected vertical failed after: ${events.join(", ")}; ${
          completion.lastFailure?.message ?? "no crypto failure"
        }; preparation trace: ${
          crypto.preparationTrace.join(", ") || "none"
        }`,
        { cause },
      );
    });
    const protectedEvents = first.map((event) =>
      parseProtectedMessageRealtimeEventV2(event)
    );
    expect(protectedEvents.filter((event) =>
      event.type === "message.new"
    )).toHaveLength(3);
    expect(protectedEvents.filter((event) =>
      event.type === "message.tokens"
    )).toEqual([{
      wireVersion: 2,
      type: "message.tokens",
      protection: "protected",
      laneKey: LANE_KEY,
      streaming: "suppressed",
      done: true,
      turnId: "turn-wave-9-scenario",
      authorAgentId: crypto.agentId,
    }]);
    expect(JSON.stringify(first)).not.toContain("private");
    expect(completion.completionCount).toBe(4);

    const firstDtos = protectedEvents.flatMap((event) =>
      event.type === "message.new" ? [event.message] : []
    );
    expect(await Promise.all(firstDtos.map(async (dto) =>
      dto.protectedPayload.status === "encrypted"
        ? await crypto.readPayload(dto.protectedPayload.cryptoObjectId)
        : null
    ))).toEqual([
      {
        role: "assistant",
        content: "I will inspect it.",
        toolCalls: [{
          id: "call-wave-9",
          name: "lookup",
          args: { query: "private" },
        }],
      },
      {
        role: "tool",
        content: "private tool result",
        toolName: "lookup",
        sensitiveMetadata: { toolCallId: "call-wave-9" },
      },
      {
        role: "assistant",
        content: "protected final answer",
      },
    ]);
    const replay = await runOnce();
    expect(replay).toEqual(first);
    expect(completion.completionCount).toBe(4);
    historicalMessageIds.push(...firstDtos.map((dto) =>
      Number(dto.projection.messageId)
    ));

    const edit = await repository.allocateHumanEdit({
      messageId: human.messageId,
      operationId: "edit-wave-9-human",
      expectedRevision: human.revision,
      legacyPayload: {
        role: "user",
        content: "Edited Human question",
      },
      subthreadReplyClassification: "counted",
    });
    expect(edit.status).toBe("allocated");
    if (edit.status !== "allocated" && edit.status !== "replayed") {
      throw new Error("Human edit allocation failed");
    }
    expect(edit.allocations).toHaveLength(1);
    for (const allocation of edit.allocations) {
      expect(await repository.completeHumanRevision({
        messageId: allocation.messageId,
        expectedRevision: allocation.revision,
        preparedClientRevision: crypto.prepareHumanRevision(
          allocation.cryptoObjectId,
          { role: "user", content: "Edited Human question" },
        ),
      })).toMatchObject({
        status: "mapped",
        messageId: allocation.messageId,
        cryptoObjectId: allocation.cryptoObjectId,
      });
    }
    const edited = product.peekMessage(human.messageId);
    expect(edited?.revision).toBe(1);
    expect(edited?.cryptoObjectId).not.toBeNull();
    expect(await crypto.readPayload(edited!.cryptoObjectId!)).toEqual({
      role: "user",
      content: "Edited Human question",
    });

    const subthreadReply = await repository.allocateHumanAppend({
      sessionId: SESSION_ID,
      idempotencyKey: "human-wave-9-subthread-reply",
      keyClass: "ai",
      legacyPayload: {
        role: "user",
        content: "Human Subthread reply",
      },
      fingerprint: "human-wave-9-subthread-reply",
      humanTurnId: "turn-wave-9-subthread",
      transcriptOrigin: "main",
      parentThreadId: null,
      scopeId: null,
      subthreadRoomId: SUBTHREAD_ROOM_ID,
      replyToMessageId: human.messageId,
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
    expect(subthreadReply.status).toBe("allocated");
    if (
      subthreadReply.status !== "allocated"
      && subthreadReply.status !== "replayed"
    ) {
      throw new Error("Human Subthread reply allocation failed");
    }
    expect(await repository.completeHumanRevision({
      messageId: subthreadReply.messageId,
      expectedRevision: subthreadReply.revision,
      preparedClientRevision: crypto.prepareHumanRevision(
        subthreadReply.cryptoObjectId,
        { role: "user", content: "Human Subthread reply" },
      ),
    })).toMatchObject({
      status: "mapped",
      messageId: subthreadReply.messageId,
      cryptoObjectId: subthreadReply.cryptoObjectId,
    });
    historicalMessageIds.push(subthreadReply.messageId);
    expect(product.peekLifecycle(
      subthreadReply.messageId,
      subthreadReply.revision,
    )).toMatchObject({
      subthreadReplyClassification: "counted",
      completion: "complete",
      disposition: "mapped",
    });

    const toolDto = firstDtos[1]!;
    if (toolDto.protectedPayload.status !== "encrypted") {
      throw new Error("expected encrypted tool message");
    }
    const toolMessageId = Number(toolDto.projection.messageId);
    expect(await repository.hardDelete({
      messageId: toolMessageId,
      operationId: "delete-wave-9-tool",
      expectedRevision: toolDto.projection.editRevision,
    })).toMatchObject({
      status: "committed",
      disposition: "deleted",
    });
    expect(product.peekMessage(toolMessageId)).toBeNull();
    expect(completion.inspect(
      toolDto.protectedPayload.cryptoObjectId,
    )).toBe("complete");
    expect(product.peekLifecycle(
      toolMessageId,
      toolDto.projection.editRevision,
    )).toMatchObject({
      disposition: "hard_delete",
      completion: "complete",
    });
    expect(completion.completionCount).toBe(6);

    const child = registry.createChildView({
      parent: registered.rootView,
      namespaceIds: [crypto.namespaceId],
      domainIds: [crypto.domainId],
      operations: ["encrypt"],
      workDescriptorDigest: foregroundAuthorizationChildWorkDescriptorDigest({
        parentInvocationId: "turn-wave-9",
        childExecutionId: "child-wave-9",
      }),
    });
    expect(child.status).toBe("created");
    if (child.status !== "created") {
      throw new Error(child.reason);
    }
    expect(child.view.sessionId).toBe(registered.sessionId);

    const forkRunner = createProtectedConversationJobRunner({
      entrypointId: "foreground.fork",
      run: async function* (
        _input,
        _jobId,
        laneKey,
        _signal,
        _services,
        invocationInput,
        scope,
      ) {
        expect(invocationInput.namespaceId).toBe(crypto.namespaceId);
        expect(scope.history.map((message) => message.snippet)).toEqual([
          "Edited Human question",
          "I will inspect it.",
          "protected final answer",
          "Human Subthread reply",
        ]);
        await scope.persist([
          new AIMessage("protected fork answer"),
        ]);
        yield {
          type: "message.tokens",
          laneKey,
          content: "protected fork answer",
          chunkSequence: 1,
          done: true,
        };
      },
    });
    const forkEvents: ServerEvent[] = [];
    for await (const event of forkRunner(
      {
        ...jobInput,
        turnId: "turn-wave-9-fork",
      },
      "job-wave-9-fork",
      LANE_KEY,
      new AbortController().signal,
      Object.freeze({
        ...services,
        authorization: child.view,
      }),
      invocation,
    )) {
      forkEvents.push(event);
    }
    expect(forkEvents).toHaveLength(2);
    expect(JSON.stringify(forkEvents)).not.toContain("protected fork answer");
    const forkEvent = parseProtectedMessageRealtimeEventV2(forkEvents[0]);
    expect(forkEvent.type).toBe("message.new");
    if (forkEvent.type !== "message.new") {
      throw new Error("expected protected fork message");
    }
    expect(forkEvent.message.projection.role).toBe("assistant");
    if (forkEvent.message.protectedPayload.status !== "encrypted") {
      throw new Error("expected encrypted fork payload");
    }
    expect(await crypto.readPayload(
      forkEvent.message.protectedPayload.cryptoObjectId,
    )).toEqual({
      role: "assistant",
      content: "protected fork answer",
    });
    expect(parseProtectedMessageRealtimeEventV2(forkEvents[1])).toMatchObject({
      type: "message.tokens",
      protection: "protected",
      streaming: "suppressed",
      done: true,
      turnId: "turn-wave-9-fork",
    });
    expect(completion.completionCount).toBe(7);
    expect(registry.size).toBe(1);
    expect(registry.liveOperationCount).toBe(0);
    registry.close();
  });
});
