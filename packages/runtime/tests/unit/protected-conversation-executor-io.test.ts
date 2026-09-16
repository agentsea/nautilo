import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ProtectedMessageDtoV2 } from "@nautilo/types";

import type {
  ActiveConversationRepository,
  PreparedProtectedAgentMessageWrite,
  ProtectedAgentMessageWritePreparer,
} from "../../src/conversation/active-conversation-repository";
import {
  executeProtectedConversationTurn,
  ProtectedConversationPersistenceError,
  persistProtectedAgentMessages,
  protectedAgentMessagePayload,
} from "../../src/conversation/protected-conversation-executor-io";

const authorization = Object.freeze({}) as never;
const committedMessage = Object.freeze({
  dtoVersion: 2,
  projection: {
    messageId: "1",
    sessionId: "10000000-0000-4000-8000-000000000001",
    roomId: "20000000-0000-4000-8000-000000000001",
    namespaceId: "30000000-0000-4000-8000-000000000001",
    role: "assistant",
    createdAt: "2027-01-15T08:00:00.000Z",
    editRevision: 0,
    authorAgentId: "40000000-0000-4000-8000-000000000001",
  },
  protectedPayload: {
    status: "encrypted",
    cryptoObjectId: "message:test",
    payloadVersion: 2,
    keyClass: "ai",
    encryptedPayloadBytesBase64url: "AA",
    accessManifestBytesBase64url: "AA",
    namespaceEnvelopeBytesBase64url: "AA",
  },
}) as ProtectedMessageDtoV2;

function prepared(
  sessionId: string,
  idempotencyKey: string,
): PreparedProtectedAgentMessageWrite {
  return Object.freeze({
    sessionId,
    idempotencyKey,
  }) as PreparedProtectedAgentMessageWrite;
}

describe("protected conversation executor IO", () => {
  test("preserves complete credentials inside the protected transcript payload", () => {
    const secret = "protected-session-secret";
    const message = new AIMessage({
      content: "Inspecting.",
      tool_calls: [{
        id: "call-secret",
        name: "inspect_open_design",
        args: { sessionToken: secret, cursor: "page:2", intent: "inspect canvas" },
      }],
    });

    expect(protectedAgentMessagePayload(message)).toMatchObject({
      toolCalls: [{
        args: {
          sessionToken: secret,
          cursor: "page:2",
          intent: "inspect canvas",
        },
      }],
    });
    expect(message.tool_calls?.[0]?.args).toMatchObject({ sessionToken: secret });
  });

  test("accepts provider-native tool transport only when a canonical tool call preserves it", () => {
    const message = new AIMessage({
      content: [
        { type: "text", text: "Checking now." },
        {
          type: "tool_use",
          id: "call-native",
          name: "inspect_open_design",
          input: { secret: "provider-secret" },
        },
      ],
      tool_calls: [{
        id: "call-native",
        name: "inspect_open_design",
        args: { secret: "provider-secret" },
      }],
    });

    expect(protectedAgentMessagePayload(message)).toEqual({
      role: "assistant",
      content: "Checking now.",
      toolCalls: [{
        id: "call-native",
        name: "inspect_open_design",
        args: { secret: "provider-secret" },
      }],
    });
  });

  test("protects accumulated Anthropic streaming tool blocks with exact canonical arguments", () => {
    // Shape produced by @langchain/anthropic 1.3.29's
    // _makeMessageChunkFromAnthropicEvent for start + input_json_delta events.
    const start = new AIMessageChunk({
      content: [{ index: 0, type: "tool_use", id: "call-streamed", name: "activate_tools", input: "" }],
      tool_call_chunks: [{ index: 0, id: "call-streamed", name: "activate_tools", args: "" }],
    });
    let message = start;
    for (const part of ['{"tools":', '["get_room_', 'members"]}']) {
      message = message.concat(new AIMessageChunk({
        content: [{ index: 0, type: "input_json_delta", input: part }],
        tool_call_chunks: [{ index: 0, args: part }],
      }));
    }
    expect(message.content).toMatchObject([{ type: "tool_use", input: '{"tools":["get_room_members"]}' }]);
    expect(message.tool_calls).toMatchObject([{ name: "activate_tools", args: { tools: ["get_room_members"] } }]);
    expect(protectedAgentMessagePayload(message)).toEqual({
      role: "assistant", content: "", toolCalls: [{
        id: "call-streamed", name: "activate_tools", args: { tools: ["get_room_members"] },
      }],
    });
    const incomplete = start.concat(new AIMessageChunk({
      content: [{ index: 0, type: "input_json_delta", input: '{"tools":[' }],
      tool_call_chunks: [{ index: 0, args: '{"tools":[' }],
    }));
    expect(() => protectedAgentMessagePayload(incomplete)).toThrow("lacks an exact canonical tool call");
  });

  test("protects an Anthropic zero-argument call with no input delta only when canonical arguments are empty", () => {
    // Anthropic's start chunk uses input=""; no-argument tools may end without
    // any input_json_delta. LangChain collapseToolCallChunks maps that to {}.
    const message = new AIMessageChunk({
      content: [{ index: 0, type: "tool_use", id: "call-empty", name: "get_room_members", input: "" }],
      tool_call_chunks: [{ index: 0, id: "call-empty", name: "get_room_members", args: "" }],
    }).concat(new AIMessageChunk({
      content: [], additional_kwargs: { stop_reason: "tool_use" },
    }));
    expect(message.tool_calls).toMatchObject([{ id: "call-empty", name: "get_room_members", args: {} }]);
    expect(protectedAgentMessagePayload(message)).toEqual({
      role: "assistant", content: "", toolCalls: [{ id: "call-empty", name: "get_room_members", args: {} }],
    });
    for (const tool_calls of [
      [],
      [{ id: "call-empty", name: "get_room_members", args: { unexpected: true } }],
      [{ id: "wrong-id", name: "get_room_members", args: {} }],
      [{ id: "call-empty", name: "wrong-name", args: {} }],
    ]) {
      expect(() => protectedAgentMessagePayload(new AIMessage({
        content: message.content, tool_calls,
      }))).toThrow("lacks an exact canonical tool call");
    }
    for (const input of [undefined, null, " ", "{"]) {
      expect(() => protectedAgentMessagePayload(new AIMessage({
        content: [{ type: "tool_use", id: "call-empty", name: "get_room_members", input }],
        tool_calls: [{ id: "call-empty", name: "get_room_members", args: {} }],
      }))).toThrow("lacks an exact canonical tool call");
    }
  });

  test("rejects incomplete, non-object, mismatched and unrepresented streamed native arguments", () => {
    for (const input of ['{"secret":', 'null', '[]', '{"secret":"different"}']) {
      expect(() => protectedAgentMessagePayload(new AIMessage({
        content: [{ type: "tool_use", id: "call-stream", name: "inspect", input }],
        tool_calls: [{ id: "call-stream", name: "inspect", args: { secret: "must-be-preserved" } }],
      }))).toThrow("lacks an exact canonical tool call");
    }
    for (const tool_calls of [[], [{ id: "wrong-id", name: "inspect", args: {} }], [{ id: "call-stream", name: "wrong-name", args: {} }]]) {
      expect(() => protectedAgentMessagePayload(new AIMessage({
        content: [{ type: "tool_use", id: "call-stream", name: "inspect", input: "{}" }],
        tool_calls,
      }))).toThrow("lacks an exact canonical tool call");
    }
  });

  test("accepts function transport only when its JSON arguments match canonically", () => {
    const message = new AIMessage({
      content: [{
        type: "function",
        id: "call-function",
        function: {
          name: "look_up",
          arguments: '{"limit":2,"query":"needle"}',
        },
      } as never],
      tool_calls: [{
        id: "call-function",
        name: "look_up",
        args: { query: "needle", limit: 2 },
      }],
    });

    expect(protectedAgentMessagePayload(message)).toMatchObject({
      toolCalls: [{
        id: "call-function",
        name: "look_up",
        args: { limit: 2, query: "needle" },
      }],
    });
  });

  test("preserves OpenAI Responses output_text blocks", () => {
    expect(protectedAgentMessagePayload(new AIMessage({
      content: [{
        type: "output_text",
        text: "Visible answer.",
        annotations: [],
      } as never],
    }))).toEqual({
      role: "assistant",
      content: "Visible answer.",
    });
  });

  test("rejects malformed confidential blocks instead of silently dropping them", () => {
    expect(() => protectedAgentMessagePayload(new AIMessage({
      content: [{ type: "text", text: 42 } as never],
    }))).toThrow("text block is malformed");
    expect(() => protectedAgentMessagePayload(new AIMessage({
      content: [{
        type: "tool_use",
        id: "uncanonicalized-call",
        name: "inspect_open_design",
        input: { secret: "must-not-disappear" },
      } as never],
    }))).toThrow("lacks an exact canonical tool call");
    expect(() => protectedAgentMessagePayload(new AIMessage({
      content: [{
        type: "tool_use",
        id: "mismatched-call",
        name: "inspect_open_design",
        input: { secret: "raw-secret" },
      } as never],
      tool_calls: [{
        id: "mismatched-call",
        name: "inspect_open_design",
        args: { secret: "different-secret" },
      }],
    }))).toThrow("lacks an exact canonical tool call");
    expect(() => protectedAgentMessagePayload(new AIMessage({
      content: [{
        type: "future_confidential_block",
        secret: "must-not-disappear",
      } as never],
    }))).toThrow("content block is unsupported");
  });

  test("prepares and commits assistant, tool, and system payloads in order", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const preparer: ProtectedAgentMessageWritePreparer = {
      prepare: async (input) => {
        calls.push({
          kind: "prepare",
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
          authorization: input.authorization,
          signal: input.signal,
        });
        return {
          status: "prepared",
          write: prepared(input.sessionId, input.idempotencyKey),
        };
      },
    };
    const repository = {
      appendPreparedAgent: async (write: PreparedProtectedAgentMessageWrite) => {
        calls.push({
          kind: "commit",
          sessionId: write.sessionId,
          idempotencyKey: write.idempotencyKey,
        });
        return { status: "committed" as const, message: committedMessage };
      },
    } as Pick<ActiveConversationRepository, "appendPreparedAgent">;
    const savedFingerprints = new Set<string>();
    const signal = new AbortController().signal;

    await persistProtectedAgentMessages({
      sessionId: "10000000-0000-4000-8000-000000000001",
      messages: [
        new AIMessage({
          content: [
            { type: "reasoning", reasoning: "private chain" },
            { type: "text", text: "I can help." },
          ],
          tool_calls: [{
            id: "call-1",
            name: "look_up",
            args: { query: "needle", limit: 2 },
          }],
        }),
        new ToolMessage({
          content: "found it",
          name: "look_up",
          tool_call_id: "call-1",
        }),
        new SystemMessage("system continuation"),
      ],
      savedFingerprints,
      preparer,
      repository,
      authorization,
      signal,
    });

    expect(calls.map((call) => call["kind"])).toEqual([
      "prepare",
      "commit",
      "prepare",
      "commit",
      "prepare",
      "commit",
    ]);
    expect(calls[0]?.["payload"]).toEqual({
      role: "assistant",
      content: "I can help.",
      toolCalls: [{
        id: "call-1",
        name: "look_up",
        args: { limit: 2, query: "needle" },
      }],
    });
    expect(calls[2]?.["payload"]).toEqual({
      role: "tool",
      content: "found it",
      toolName: "look_up",
      sensitiveMetadata: { toolCallId: "call-1" },
    });
    expect(calls[4]?.["payload"]).toEqual({
      role: "system",
      content: "system continuation",
    });
    expect(calls[0]?.["authorization"]).toBe(authorization);
    expect(calls[0]?.["signal"]).toBe(signal);
    expect(savedFingerprints.size).toBe(3);
  });

  test("does not manufacture an [image] marker from a structured image part", async () => {
    const payloads: unknown[] = [];
    const preparer: ProtectedAgentMessageWritePreparer = {
      prepare: async (input) => {
        payloads.push(input.payload);
        return {
          status: "prepared",
          write: prepared(input.sessionId, input.idempotencyKey),
        };
      },
    };
    const repository = {
      appendPreparedAgent: async () => ({
        status: "committed" as const,
        message: committedMessage,
      }),
    } as Pick<ActiveConversationRepository, "appendPreparedAgent">;

    await persistProtectedAgentMessages({
      sessionId: "10000000-0000-4000-8000-000000000001",
      messages: [new AIMessage({
        content: [
          { type: "text", text: "Here is the result." },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      })],
      savedFingerprints: new Set(),
      preparer,
      repository,
      authorization,
    });

    expect(payloads).toEqual([{
      role: "assistant",
      content: "Here is the result.",
    }]);
  });

  test("skips transient and already committed rows but rejects Human writes", async () => {
    let prepareCalls = 0;
    const preparer: ProtectedAgentMessageWritePreparer = {
      prepare: async (input) => {
        prepareCalls += 1;
        return {
          status: "prepared",
          write: prepared(input.sessionId, input.idempotencyKey),
        };
      },
    };
    const repository = {
      appendPreparedAgent: async () => ({
        status: "committed" as const,
        message: committedMessage,
      }),
    } as Pick<ActiveConversationRepository, "appendPreparedAgent">;
    const already = new AIMessage("already");
    const transient = new HumanMessage({
      content: "context",
      additional_kwargs: { nautilo_transient_context: true },
    });
    const first = new Set<string>();
    await persistProtectedAgentMessages({
      sessionId: "10000000-0000-4000-8000-000000000001",
      messages: [already],
      savedFingerprints: first,
      preparer,
      repository,
      authorization,
    });

    await persistProtectedAgentMessages({
      sessionId: "10000000-0000-4000-8000-000000000001",
      messages: [already, transient],
      savedFingerprints: first,
      preparer,
      repository,
      authorization,
    });
    expect(prepareCalls).toBe(1);

    const humanError = await persistProtectedAgentMessages({
        sessionId: "10000000-0000-4000-8000-000000000001",
        messages: [new HumanMessage("must use coordinate-first write")],
        savedFingerprints: new Set(),
        preparer,
        repository,
        authorization,
      })
      .catch((caught: unknown) => caught);
    expect(humanError).toBeInstanceOf(TypeError);
  });

  test("fails closed without marking a row saved when preparation is unavailable", async () => {
    const savedFingerprints = new Set<string>();
    const result = persistProtectedAgentMessages({
      sessionId: "10000000-0000-4000-8000-000000000001",
      messages: [new AIMessage("answer")],
      savedFingerprints,
      preparer: {
        prepare: async () => ({
          status: "unavailable",
          reason: "signing_capability_unavailable",
        }),
      },
      repository: {
        appendPreparedAgent: async () => {
          throw new Error("must not commit");
        },
      },
      authorization,
    });

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProtectedConversationPersistenceError);
    expect(error).toMatchObject({
      phase: "prepare",
      outcome: "signing_capability_unavailable",
    });
    expect(savedFingerprints.size).toBe(0);
  });

  test("aborts the batch at the first non-durable commit and permits retry", async () => {
    let commits = 0;
    const savedFingerprints = new Set<string>();
    const input = {
      sessionId: "10000000-0000-4000-8000-000000000001",
      messages: [new AIMessage("first"), new ToolMessage({
        content: "second",
        name: "tool",
        tool_call_id: "call-2",
      })],
      savedFingerprints,
      preparer: {
        prepare: async (request) => ({
          status: "prepared" as const,
          write: prepared(request.sessionId, request.idempotencyKey),
        }),
      } satisfies ProtectedAgentMessageWritePreparer,
      repository: {
        appendPreparedAgent: async () => {
          commits += 1;
          return commits === 1
            ? { status: "pending_shadow" as const }
            : {
              status: "committed" as const,
              message: committedMessage,
            };
        },
      },
      authorization,
    };

    const error = await persistProtectedAgentMessages(input).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProtectedConversationPersistenceError);
    expect(error).toMatchObject({
      phase: "commit",
      outcome: "pending_shadow",
    });
    expect(commits).toBe(1);
    expect(savedFingerprints.size).toBe(0);

    await persistProtectedAgentMessages(input);
    expect(commits).toBe(3);
    expect(savedFingerprints.size).toBe(2);
  });

  test("keeps decrypted history and its output writer inside one authorized callback", async () => {
    let callbackLive = false;
    let latePersist:
      | ((
        messages: readonly AIMessage[],
      ) => Promise<readonly ProtectedMessageDtoV2[]>)
      | undefined;
    const committed: string[] = [];
    const repository = {
      withAgentTranscript: async <Value>(
        input: Parameters<
          ActiveConversationRepository["withAgentTranscript"]
        >[0],
      ) => {
        callbackLive = true;
        try {
          return {
            status: "executed" as const,
            value: await input.execute([{
              messageId: 7,
              revision: 0,
              createdAt: new Date("2027-01-15T08:00:00.000Z"),
              author: {
                actorId: "actor-alice",
                handle: "alice",
                displayName: "Alice",
              },
              payload: { role: "user", content: "secret history" },
            }]) as Value,
          };
        } finally {
          callbackLive = false;
        }
      },
      appendPreparedAgent: async (write: PreparedProtectedAgentMessageWrite) => {
        expect(callbackLive).toBe(true);
        committed.push(write.idempotencyKey);
        return { status: "committed" as const, message: committedMessage };
      },
    } as Pick<
      ActiveConversationRepository,
      "withAgentTranscript" | "appendPreparedAgent"
    >;

    const result = await executeProtectedConversationTurn({
      sessionId: "10000000-0000-4000-8000-000000000001",
      namespaceId: "namespace-room",
      limit: 20,
      productReadAuthorization: Object.freeze({}) as never,
      authorization,
      entrypointId: "foreground.main",
      agentId: "40000000-0000-4000-8000-000000000001",
      appendContext: {
        transcriptOrigin: "main",
        parentThreadId: null,
        scopeId: null,
        subthreadRoomId: null,
        notificationContext: {
          mentionedHumanUserIds: [],
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
      repository,
      preparer: {
        prepare: async (input) => ({
          status: "prepared",
          write: prepared(input.sessionId, input.idempotencyKey),
        }),
      },
      execute: async ({ history, persist }) => {
        expect(callbackLive).toBe(true);
        expect(history).toHaveLength(1);
        expect(history[0]?.snippet).toBe("secret history");
        latePersist = persist;
        await persist([new AIMessage("protected answer")]);
        return "done";
      },
    });

    expect(result).toEqual({ status: "executed", value: "done" });
    expect(committed).toHaveLength(1);
    expect(callbackLive).toBe(false);
    const late = latePersist?.([new AIMessage("too late")]);
    const lateError = await late?.catch((caught: unknown) => caught);
    expect(lateError).toBeInstanceOf(ProtectedConversationPersistenceError);
    expect(lateError).toMatchObject({
      phase: "commit",
      outcome: "authorization_callback_closed",
    });
  });
});
