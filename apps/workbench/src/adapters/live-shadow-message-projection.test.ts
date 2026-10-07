import { describe, expect, test } from "bun:test";
import type {
  FullEncryptionMessageRealtimeContentEventV2,
  LiveShadowMessageRealtimeEventV1,
} from "@nautilo/types";

import { projectLiveShadowMessageResult } from
  "./live-shadow-message-projection";

const frameEvent: LiveShadowMessageRealtimeEventV1 = {
  wireVersion: 1,
  type: "message.shadow_stream_frame",
  laneKey: "room:20000000-0000-4000-8000-000000000282",
  operationId: "turn:m282",
  transcriptOrdinal: 2,
  ordinaryChunk: "hello",
  frameBytesBase64url: "AA",
  done: false,
};

describe("live Shadow Message UI projection", () => {
  test.each([
    ["share_memory", '{"error":"Cannot project Memory: search first."}', undefined, "error"],
    ["share_memory", '{"error":"Cannot project Memory: search first."}', "success", "success"],
    ["share_memory", "Cannot project Memory: search first.", undefined, "success"],
    ["share_memory", '{"error":null}', undefined, "success"],
    ["share_memory", '{"error":""}', undefined, "success"],
    ["share_memory", '[{"error":"data"}]', undefined, "success"],
    ["share_memory", '{"error":"data","ok":true}', undefined, "success"],
    ["lookup", '{"error":"data"}', undefined, "success"],
    ["share_memory", "denied", "error", "error"],
  ] as const)("projects exact opened rejection envelope: %s %s %s", (
    toolName, content, toolStatus, status,
  ) => {
    const events = projectLiveShadowMessageResult({
      event: frameEvent,
      result: {
        status: "durable_verified",
        payload: {
          role: "tool", content, toolName,
          sensitiveMetadata: {
            toolCallId: "rejected-projection",
            ...(toolStatus === undefined ? {} : { toolStatus }),
          },
        },
        messageId: "43", assistantMessageKey: null, authorAgentId: "agent-m322",
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool.end", toolCallId: "rejected-projection", toolName, status,
      laneKey: frameEvent.laneKey, turnId: frameEvent.operationId,
    });
    if (status === "error") expect(events[0]).toHaveProperty("error");
    else expect(events[0]).not.toHaveProperty("error");
  });

  test("projects only authenticated opened bytes for a protected-only V2 frame", () => {
    const event: FullEncryptionMessageRealtimeContentEventV2 = {
      wireVersion: 2,
      type: "message.shadow_stream_frame",
      laneKey: frameEvent.laneKey,
      operationId: "turn:m318",
      transcriptOrdinal: 2,
      frameBytesBase64url: "AA",
      done: false,
    };
    expect(projectLiveShadowMessageResult({
      event,
      result: {
        status: "frame_verified",
        ordinaryChunk: "opened on device",
        done: false,
        chunkSequence: 1,
        messageId: 42,
        assistantMessageKey: "assistant:turn:m318:0",
        authorAgentId: "agent-m318",
      },
    })[0]).toMatchObject({
      type: "message.tokens",
      content: "opened on device",
      turnId: "turn:m318",
    });
    expect(projectLiveShadowMessageResult({
      event,
      result: { status: "failed", reason: "integrity" },
    })).toEqual([]);
  });

  test("projects only locally verified frame bytes with their real sequence", () => {
    expect(projectLiveShadowMessageResult({
      event: frameEvent,
      result: {
        status: "frame_verified",
        ordinaryChunk: "hello",
        done: false,
        chunkSequence: 7,
        messageId: 42,
        assistantMessageKey: "assistant:turn:m282:0",
        authorAgentId: "agent-m282",
      },
    })).toEqual([{
      type: "message.tokens",
      laneKey: frameEvent.laneKey,
      content: "hello",
      chunkSequence: 7,
      done: false,
      authorAgentId: "agent-m282",
      turnId: "turn:m282",
      assistantMessageKey: "assistant:turn:m282:0",
    }]);
  });

  test("projects opened tool calls and results, never protected wire bytes", () => {
    const durableEvent: LiveShadowMessageRealtimeEventV1 = {
      wireVersion: 1,
      type: "message.shadow_durable",
      laneKey: frameEvent.laneKey,
      operationId: "turn:m282",
      policyRevision: 5,
      transcriptOrdinal: 2,
      ordinaryPayloadBytesBase64url: "AA",
      durableEventDigestBase64url: "A".repeat(43),
      protectedMessage: {
        dtoVersion: 2,
        projection: {
          messageId: "42",
          sessionId: "10000000-0000-4000-8000-000000000282",
          roomId: "20000000-0000-4000-8000-000000000282",
          namespaceId: "30000000-0000-4000-8000-000000000282",
          role: "assistant",
          createdAt: "2027-01-15T08:00:00.000Z",
          editRevision: 0,
          authorAgentId: "40000000-0000-4000-8000-000000000282",
        },
        protectedPayload: { status: "pending", reason: "shadow_pending" },
      },
    };
    expect(projectLiveShadowMessageResult({
      event: durableEvent,
      result: {
        status: "durable_verified",
        payload: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call-m282",
            name: "lookup",
            args: { secret: "opened-only" },
          }],
        },
        messageId: "42",
        assistantMessageKey: "assistant:turn:m282:0",
        authorAgentId: "40000000-0000-4000-8000-000000000282",
      },
    })).toEqual([{
      type: "tool.start",
      laneKey: frameEvent.laneKey,
      toolCallId: "call-m282",
      toolName: "lookup",
      argsSummary: "{\"secret\":\"opened-only\"}",
      authorAgentId: "40000000-0000-4000-8000-000000000282",
      turnId: "turn:m282",
    }]);

    expect(projectLiveShadowMessageResult({
      event: { ...durableEvent, transcriptOrdinal: 3 },
      result: {
        status: "durable_verified",
        payload: {
          role: "tool",
          content: "found",
          toolName: "lookup",
          sensitiveMetadata: {
            toolCallId: "call-m282",
            toolStatus: "success",
          },
        },
        messageId: "43",
        assistantMessageKey: null,
        authorAgentId: "40000000-0000-4000-8000-000000000282",
      },
    })[0]).toMatchObject({
      type: "tool.end",
      toolCallId: "call-m282",
      status: "success",
      result: "found",
    });
  });

  test("releases the explicit ordinary sibling after an availability failure", () => {
    expect(projectLiveShadowMessageResult({
      event: frameEvent,
      result: {
        status: "failed",
        reason: "unavailable",
        ordinaryFallback: {
          kind: "frame",
          ordinaryChunk: "hello",
          done: false,
          chunkSequence: 1,
          messageId: 42,
          assistantMessageKey: "assistant:turn:m282:0",
          authorAgentId: "agent-m282",
        },
      },
    })[0]).toMatchObject({
      type: "message.tokens",
      content: "hello",
    });
  });

  test("projects an authenticated durable assistant payload", () => {
    const durableEvent: LiveShadowMessageRealtimeEventV1 = {
      wireVersion: 1,
      type: "message.shadow_durable",
      laneKey: frameEvent.laneKey,
      operationId: "turn:surplus",
      policyRevision: 1,
      transcriptOrdinal: 4,
      ordinaryPayloadBytesBase64url: "AA",
      durableEventDigestBase64url: "A".repeat(43),
      protectedMessage: {
        dtoVersion: 2,
        projection: {
          messageId: "44",
          sessionId: "10000000-0000-4000-8000-000000000282",
          roomId: "20000000-0000-4000-8000-000000000282",
          namespaceId: "30000000-0000-4000-8000-000000000282",
          role: "assistant",
          createdAt: "2027-01-15T08:00:00.000Z",
          editRevision: 0,
          authorAgentId: "40000000-0000-4000-8000-000000000282",
        },
        protectedPayload: { status: "pending", reason: "shadow_pending" },
      },
    };
    expect(projectLiveShadowMessageResult({
      event: durableEvent,
      result: {
        status: "durable_verified",
        payload: {
          role: "assistant",
          content: "settled answer",
        },
        messageId: "44",
        assistantMessageKey: "assistant:turn:durable:0",
        authorAgentId: "40000000-0000-4000-8000-000000000282",
      },
    })[0]).toMatchObject({
      type: "message.new",
      content: "settled answer",
    });
  });

  test("never releases an ordinary sibling after an integrity failure", () => {
    expect(projectLiveShadowMessageResult({
      event: frameEvent,
      result: {
        status: "failed",
        reason: "integrity",
        ordinaryFallback: {
          kind: "frame",
          ordinaryChunk: "must not be displayed",
          done: false,
          chunkSequence: 1,
          messageId: 42,
          assistantMessageKey: "assistant:turn:m282:0",
          authorAgentId: "agent-m282",
        },
      },
    })).toEqual([]);
  });
});


test("protected live answer projects completed authenticated image attribution", () => {
  const imageAssistance = { status: "completed" as const, modelId: "provider:vision", modelDisplayName: "Image reader", attachmentIds: ["image-1"] };
  const events = projectLiveShadowMessageResult({
    event: frameEvent,
    result: { status: "durable_verified", payload: { role: "assistant", content: "The chart rose", sensitiveMetadata: { imageAssistance } }, messageId: "43", assistantMessageKey: null, authorAgentId: "agent-1" },
  });
  expect(events[0]).toMatchObject({ type: "message.new", role: "ai", imageAssistance });
  const invalid = projectLiveShadowMessageResult({
    event: frameEvent,
    result: { status: "durable_verified", payload: { role: "assistant", content: "The chart rose", sensitiveMetadata: { imageAssistance: { ...imageAssistance, status: "failed" } } }, messageId: "44", assistantMessageKey: null, authorAgentId: "agent-1" },
  });
  expect(invalid[0]).not.toHaveProperty("imageAssistance");
});


test("omits authenticated image helper rows from realtime chat", () => {
  expect(projectLiveShadowMessageResult({
    event: frameEvent,
    result: { status: "durable_verified", payload: { role: "tool", toolName: "image_assistance", content: '{"observations":"private observation"}', sensitiveMetadata: { toolCallId: "image-assistance:input-digest" } }, messageId: "43", assistantMessageKey: null, authorAgentId: "agent-1" },
  })).toEqual([]);
});


test("omits empty protected image helper declarations without emitting tool activity", () => {
  expect(projectLiveShadowMessageResult({
    event: frameEvent,
    result: { status: "durable_verified", payload: { role: "assistant", content: "", toolCalls: [{ id: "image-assistance:input-digest", name: "image_assistance", args: {} }] }, messageId: "42", assistantMessageKey: null, authorAgentId: "agent-1" },
  })).toEqual([]);
});
