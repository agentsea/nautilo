import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  anyStreamHasVisibleOutput,
  applyTokensContentChunk,
  finalizeTokensDone,
  findAssistantReconcileIndex,
  laneAuthorStreamLookupKey,
  plannedShutdownReconnectMessage,
  reconcileAssistantDurableMessage,
  resolveFailedJobStreamFinalization,
  streamKey,
  type StreamState,
} from "../../src/adapters/nautilo-stream-state";

function assistantTextMessage(
  id: string,
  text: string,
  authorAgentId?: string,
  assistantMessageKey?: string,
): ThreadMessageLike {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    ...(authorAgentId || assistantMessageKey
      ? { metadata: { custom: {
          ...(authorAgentId ? { authorAgentId } : {}),
          ...(assistantMessageKey ? { assistantMessageKey } : {}),
        } } }
      : {}),
  };
}

describe("streamKey (M178)", () => {
  test("prefers the server-authored assistant message identity", () => {
    expect(
      streamKey({
        assistantMessageKey: "assistant:turn-1:2",
        turnId: "turn-1",
        laneKey: "room:a",
        authorAgentId: "bot-a",
      }),
    ).toBe("message:assistant:turn-1:2");
  });

  test("turnId + authorAgentId composite key", () => {
    expect(
      streamKey({
        turnId: "turn-1",
        laneKey: "room:a",
        authorAgentId: "bot-a",
      }),
    ).toBe("turn:turn-1|bot-a");
  });

  test("legacy lane fallback when turnId absent", () => {
    expect(
      streamKey({ laneKey: "room:a", authorAgentId: "bot-a" }),
    ).toBe("lane:room:a|bot-a");
  });
});

describe("laneAuthorStreamLookupKey (M178)", () => {
  test("ignores turnId so done frames can find the last stream for a lane and author", () => {
    expect(
      laneAuthorStreamLookupKey({
        laneKey: "room:a",
        authorAgentId: "bot-a",
      }),
    ).toBe("lane:room:a|bot-a");
  });
});

describe("applyTokensContentChunk (M178)", () => {
  test("no overwrite — user bubble appended mid-stream stays intact", () => {
    const streams = new Map<string, StreamState>();
    const key = streamKey({
      turnId: "turn-1",
      laneKey: "room:a",
      authorAgentId: "genie",
    });

    applyTokensContentChunk({
      streams,
      key,
      content: "Hello",
      newBubbleId: "asst-1",
    });
    applyTokensContentChunk({
      streams,
      key,
      content: " world",
      newBubbleId: "asst-should-not-be-used",
    });

    expect(streams.get(key)?.acc).toBe("Hello world");
    expect(streams.get(key)?.bubbleId).toBe("asst-1");
    expect(streams.size).toBe(1);
  });

  test("concurrent same turn, different author — two bubbles", () => {
    const streams = new Map<string, StreamState>();
    const sharedTurn = "turn-shared";

    applyTokensContentChunk({
      streams,
      key: streamKey({
        turnId: sharedTurn,
        laneKey: "room:a",
        authorAgentId: "bot-a",
      }),
      content: "A",
      newBubbleId: "bubble-a",
    });
    applyTokensContentChunk({
      streams,
      key: streamKey({
        turnId: sharedTurn,
        laneKey: "room:a",
        authorAgentId: "bot-b",
      }),
      content: "B",
      newBubbleId: "bubble-b",
    });

    expect(streams.size).toBe(2);
    expect(streams.get("turn:turn-shared|bot-a")?.acc).toBe("A");
    expect(streams.get("turn:turn-shared|bot-b")?.acc).toBe("B");
  });

  test("concurrent different turn, same author — two bubbles", () => {
    const streams = new Map<string, StreamState>();
    const author = "genie";

    applyTokensContentChunk({
      streams,
      key: streamKey({
        turnId: "turn-1",
        laneKey: "room:a",
        authorAgentId: author,
      }),
      content: "fork-1",
      newBubbleId: "b1",
    });
    applyTokensContentChunk({
      streams,
      key: streamKey({
        turnId: "turn-2",
        laneKey: "room:a",
        authorAgentId: author,
      }),
      content: "fork-2",
      newBubbleId: "b2",
    });

    expect(streams.size).toBe(2);
    expect(streams.get("turn:turn-1|genie")?.bubbleId).toBe("b1");
    expect(streams.get("turn:turn-2|genie")?.bubbleId).toBe("b2");
  });

  test("legacy fallback — single lane|author stream", () => {
    const streams = new Map<string, StreamState>();
    const key = streamKey({ laneKey: "room:legacy", authorAgentId: "genie" });

    applyTokensContentChunk({
      streams,
      key,
      content: "chunk",
      newBubbleId: "legacy-bubble",
    });

    expect(streams.size).toBe(1);
    expect(streams.get(key)?.acc).toBe("chunk");
  });
});

describe("finalizeTokensDone (M178)", () => {
  test("removes stream entry on done", () => {
    const streams = new Map<string, StreamState>();
    const key = "turn:t|a";
    streams.set(key, { bubbleId: "b1", acc: "done text" });

    const result = finalizeTokensDone({ streams, key });
    expect(result).toEqual({ bubbleId: "b1", acc: "done text" });
    expect(streams.size).toBe(0);
  });
});

describe("anyStreamHasVisibleOutput (M178)", () => {
  test("true when any acc has trimmed content", () => {
    const streams = new Map<string, StreamState>([
      ["k1", { bubbleId: "b1", acc: "  hi " }],
    ]);
    expect(anyStreamHasVisibleOutput(streams)).toBe(true);
  });

  test("false when all acc empty or whitespace", () => {
    const streams = new Map<string, StreamState>([
      ["k1", { bubbleId: "b1", acc: "   " }],
    ]);
    expect(anyStreamHasVisibleOutput(streams)).toBe(false);
  });
});

describe("findAssistantReconcileIndex (M178)", () => {
  test("matches server-authored identity before content", () => {
    const messages = [
      assistantTextMessage("1", "partial stream", "bot-a", "assistant:turn-1:0"),
      assistantTextMessage("2", "same durable text", "bot-a", "assistant:turn-2:0"),
    ];
    expect(
      findAssistantReconcileIndex({
        messages,
        content: "different normalized text",
        authorAgentId: "bot-a",
        assistantMessageKey: "assistant:turn-1:0",
      }),
    ).toBe(0);
  });

  test("does not fall back to text when an unknown identity is present", () => {
    const messages = [assistantTextMessage("1", "same text", "bot-a")];
    expect(
      findAssistantReconcileIndex({
        messages,
        content: "same text",
        authorAgentId: "bot-a",
        assistantMessageKey: "assistant:missing:0",
      }),
    ).toBe(-1);
  });

  test("matches content from the end", () => {
    const messages = [
      assistantTextMessage("1", "older"),
      assistantTextMessage("2", "final answer"),
    ];
    expect(
      findAssistantReconcileIndex({
        messages,
        content: "final answer",
      }),
    ).toBe(1);
  });

  test("requires authorAgentId match when both sides carry it", () => {
    const messages = [
      assistantTextMessage("1", "same text", "bot-a"),
      assistantTextMessage("2", "same text", "bot-b"),
    ];
    expect(
      findAssistantReconcileIndex({
        messages,
        content: "same text",
        authorAgentId: "bot-b",
      }),
    ).toBe(1);
    expect(
      findAssistantReconcileIndex({
        messages,
        content: "same text",
        authorAgentId: "bot-a",
      }),
    ).toBe(0);
  });
});

describe("reconcileAssistantDurableMessage", () => {
  test("adds harness authorship when a protected live bubble arrived first", () => {
    const messages = [{
      id: "assistant-shadow",
      role: "assistant",
      content: [{ type: "text", text: "Harness result" }],
      metadata: { custom: { authorAgentId: "agent-moxie" } },
    }] as ThreadMessageLike[];

    const reconciled = reconcileAssistantDurableMessage({
      messages,
      index: 0,
      messageId: "28084",
      custom: {
        authorAgentId: "agent-moxie",
        authorHarnessId: "claude-code",
      },
    });

    expect(reconciled).toMatchObject([{
      id: "28084",
      metadata: {
        custom: {
          authorAgentId: "agent-moxie",
          authorHarnessId: "claude-code",
        },
      },
    }]);
  });

  test("repairs missing durable metadata even when the id already matches", () => {
    const messages = [{
      id: "28084",
      role: "assistant",
      content: [{ type: "text", text: "Harness result" }],
    }] as ThreadMessageLike[];

    const reconciled = reconcileAssistantDurableMessage({
      messages,
      index: 0,
      messageId: "28084",
      custom: { authorHarnessId: "claude-code" },
    });

    expect(reconciled[0]?.metadata).toMatchObject({
      custom: { authorHarnessId: "claude-code" },
    });
  });

  test("preserves the server-authored document pointers on a live assistant question", () => {
    const messages = [{
      id: "assistant-stream",
      role: "assistant",
      content: [{ type: "text", text: "Please review the attached document." }],
      metadata: { custom: { authorAgentId: "agent-moxie" } },
    }] as ThreadMessageLike[];
    const artifactOpenRefs = [{
      roomId: "peer-dm",
      artifactInternalId: "artifact-1",
      basename: "routing-test.html",
      mimeType: "text/html",
      sizeBytes: 240,
    }];

    const reconciled = reconcileAssistantDurableMessage({
      messages,
      index: 0,
      messageId: "28037",
      custom: { artifactOpenRefs },
    });

    expect(reconciled[0]?.metadata).toMatchObject({
      custom: { artifactOpenRefs },
    });
  });
});

describe("resolveFailedJobStreamFinalization (M178)", () => {
  test("single stream appends error inline", () => {
    const streams = new Map<string, StreamState>([
      ["k", { bubbleId: "b1", acc: "partial" }],
    ]);
    const result = resolveFailedJobStreamFinalization({
      streams,
      messageBody: "**Error:** oops",
    });
    expect(result.standaloneError).toBeNull();
    expect(result.updates).toEqual([
      { bubbleId: "b1", content: "partial\n\n**Error:** oops" },
    ]);
    expect(streams.size).toBe(0);
  });

  test("multiple streams finalize partials and emit standalone error", () => {
    const streams = new Map<string, StreamState>([
      ["k1", { bubbleId: "b1", acc: "a" }],
      ["k2", { bubbleId: "b2", acc: "b" }],
    ]);
    const result = resolveFailedJobStreamFinalization({
      streams,
      messageBody: "**Error:** fail",
    });
    expect(result.updates).toHaveLength(2);
    expect(result.standaloneError).toBe("**Error:** fail");
    expect(streams.size).toBe(0);
  });
});

describe("plannedShutdownReconnectMessage (M305)", () => {
  test("projects only the exact durable planned-shutdown terminal", () => {
    expect(plannedShutdownReconnectMessage({
      status: "cancelled",
      message: "Cancelled because the server is shutting down for planned maintenance",
    })).toBe(
      "**Error:** The server restarted before this response finished. Please try again.",
    );
    expect(plannedShutdownReconnectMessage({
      status: "cancelled",
      message: "Stopped by user",
    })).toBeNull();
    expect(plannedShutdownReconnectMessage({
      status: "failed",
      message: "Cancelled because the server is shutting down for planned maintenance",
    })).toBeNull();
  });
});
