import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type {
  ProtectedMessageDtoV2,
  ServerEvent,
} from "@nautilo/types";

import type {
  ActiveConversationRepository,
  PreparedProtectedAgentMessageWrite,
  ProtectedAgentMessageWritePreparer,
  ProtectedConversationProductReadAuthorization,
} from "../../src/conversation/active-conversation-repository";
import type {
  ProtectedConversationExecutionServices,
} from "../../src/conversation/conversation-execution-services";
import {
  createProtectedConversationJobRunner,
} from "../../src/conversation/protected-conversation-job-runner";
import type {
  ForegroundAuthorizationView,
} from "../../src/protected-execution/foreground-authorization-session";
import { createDormantEncryptedCheckpointSaverForTests } from "./support/encrypted-checkpoint-saver";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000002";
const AGENT_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";
const LANE_KEY = `room:${ROOM_ID}`;
const authorization = Object.freeze({
  sessionId: "foreground-session",
  viewId: "foreground-view",
}) as ForegroundAuthorizationView;
const productReadAuthorization =
  Object.freeze({}) as ProtectedConversationProductReadAuthorization;
const committedMessage = Object.freeze({
  dtoVersion: 2,
  projection: {
    messageId: "42",
    sessionId: SESSION_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    role: "assistant",
    createdAt: "2027-01-15T08:00:00.000Z",
    editRevision: 0,
    authorAgentId: AGENT_ID,
  },
  protectedPayload: {
    status: "encrypted",
    cryptoObjectId: "message:protected-runner:42",
    payloadVersion: 2,
    keyClass: "ai",
    encryptedPayloadBytesBase64url: "AA",
    accessManifestBytesBase64url: "AA",
    namespaceEnvelopeBytesBase64url: "AA",
  },
}) as ProtectedMessageDtoV2;

function services(live: { value: boolean }): ProtectedConversationExecutionServices {
  const repository = Object.freeze({
    allocateHumanAppend: async () => ({ status: "conflict" as const }),
    allocateHumanEdit: async () => ({ status: "conflict" as const }),
    completeHumanRevision: async () => ({
      status: "orphaned" as const,
      reason: "stale_mapping" as const,
      messageId: 1,
      revision: 0,
      cryptoObjectId: "message:test",
    }),
    appendPreparedAgent: async () => ({
      status: "committed" as const,
      message: committedMessage,
    }),
    hardDelete: async () => ({
      status: "missing" as const,
    }),
    readHumanMessages: async () => ({
      status: "available" as const,
      messages: [],
    }),
    withAgentTranscript: async <Value>(
      input: Parameters<
        ActiveConversationRepository["withAgentTranscript"]
      >[0],
    ) => {
      live.value = true;
      try {
        return {
          status: "executed" as const,
          value: await input.execute([]) as Value,
        };
      } finally {
        live.value = false;
      }
    },
  }) satisfies ActiveConversationRepository;
  return Object.freeze({
    repository,
    authorization,
    checkpointSavers: Object.freeze({
      createForInvocation: ({ logicalThreadId }: {
        logicalThreadId: string;
      }) => createDormantEncryptedCheckpointSaverForTests(logicalThreadId),
    }),
    protectedAgentMessagePreparer: Object.freeze({
      prepare: async (
        input: Parameters<
          ProtectedAgentMessageWritePreparer["prepare"]
        >[0],
      ) => ({
        status: "prepared" as const,
        write: Object.freeze({
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
        }) as PreparedProtectedAgentMessageWrite,
      }),
    }),
  });
}

function invocation() {
  return Object.freeze({
    sessionId: SESSION_ID,
    namespaceId: NAMESPACE_ID,
    productReadAuthorization,
  });
}

function jobInput() {
  return {
    roomId: ROOM_ID,
    agentId: AGENT_ID,
    turnId: "turn-protected-runner",
  };
}

describe("protected conversation job runner", () => {
  test("keeps execution under live transcript authority and replaces plaintext stream/tool events", async () => {
    const live = { value: false };
    let coreSawHistory = false;
    const runner = createProtectedConversationJobRunner({
      entrypointId: "foreground.main",
      run: async function* (
        _input,
        _jobId,
        _laneKey,
        _signal,
        _services,
        _invocation,
        scope,
      ) {
        coreSawHistory = Array.isArray(scope.history);
        expect(live.value).toBe(true);
        yield {
          type: "message.tokens",
          laneKey: LANE_KEY,
          content: "must never cross protected realtime",
          chunkSequence: 1,
          done: false,
        };
        expect(live.value).toBe(true);
        yield {
          type: "tool.end",
          laneKey: LANE_KEY,
          toolCallId: "secret-call",
          toolName: "secret-tool",
          duration: 1,
          status: "success",
          result: "secret result",
        };
      },
    });

    const events: ServerEvent[] = [];
    for await (const event of runner(
      jobInput(),
      "job-protected-runner",
      LANE_KEY,
      new AbortController().signal,
      services(live),
      invocation(),
    )) {
      expect(live.value).toBe(true);
      events.push(event);
    }

    expect(coreSawHistory).toBe(true);
    expect(live.value).toBe(false);
    expect(events).toEqual([{
      wireVersion: 2,
      type: "message.tokens",
      protection: "protected",
      laneKey: LANE_KEY,
      streaming: "suppressed",
      done: true,
      turnId: "turn-protected-runner",
      authorAgentId: AGENT_ID,
    }]);
  });

  test("rejects plaintext final message events and a substituted Room lane", async () => {
    const live = { value: false };
    const runner = createProtectedConversationJobRunner({
      entrypointId: "foreground.fork",
      run: async function* () {
        yield {
          type: "message.new",
          laneKey: LANE_KEY,
          messageId: "42",
          role: "ai",
          content: "plaintext final answer",
        };
      },
    });
    const emitted = runner(
      jobInput(),
      "job-protected-runner",
      LANE_KEY,
      new AbortController().signal,
      services(live),
      invocation(),
    );
    const finalError = await (async () => {
      try {
        for await (const _event of emitted) {
          // The plaintext event must be rejected before yielding.
        }
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(finalError).toBeInstanceOf(Error);
    expect((finalError as Error).message).toContain(
      "plaintext message realtime",
    );

    const wrongLane = runner(
      jobInput(),
      "job-protected-runner",
      "room:10000000-0000-4000-8000-000000000099",
      new AbortController().signal,
      services(live),
      invocation(),
    );
    const laneError = await wrongLane.next().catch(
      (error: unknown) => error,
    );
    expect(laneError).toBeInstanceOf(Error);
    expect((laneError as Error).message).toContain("exact canonical Room lane");
  });

  test("publishes only the committed protected final DTO", async () => {
    const live = { value: false };
    const runner = createProtectedConversationJobRunner({
      entrypointId: "foreground.main",
      run: async function* (
        _input,
        _jobId,
        _laneKey,
        _signal,
        _services,
        _invocation,
        scope,
      ) {
        await scope.persist([new AIMessage("encrypted final")]);
        yield* [] as ServerEvent[];
      },
    });
    const events: ServerEvent[] = [];
    for await (const event of runner(
      jobInput(),
      "job-protected-runner",
      LANE_KEY,
      new AbortController().signal,
      services(live),
      invocation(),
    )) {
      events.push(event);
    }
    expect(events).toEqual([{
      wireVersion: 2,
      type: "message.new",
      protection: "protected",
      laneKey: LANE_KEY,
      message: committedMessage,
    }]);
  });
});
