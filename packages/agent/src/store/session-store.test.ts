import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  extractReplyToMessageId,
  parseTranscriptToolCalls,
  projectRoomHistorySelectedMessageCoordinate,
  visibleTranscriptContent,
} from "./session-store";
import { computeMessageFingerprint } from "./fingerprint";
import {
  sanitizeSerializedTranscriptToolCalls,
  serializeTranscriptToolCalls,
} from "./transcript-tool-arguments";
import { COMPUTER_RESULT_DURABLE_SIDECAR_KEY } from "../tools/computer/model-result-projector";

describe("Computer Use durable transcript result", () => {
  test("persists the full scanned sidecar while ordinary tools remain content-based", () => {
    const compact = JSON.stringify({ version: 1, ok: true, result: { kind: "observation" } });
    const full = JSON.stringify({ ok: true, provider: { privateDiagnostic: "retained" }, result: { kind: "observation" } });
    const computer = new ToolMessage({
      content: compact,
      tool_call_id: "computer-1",
      name: "computer_observe",
      additional_kwargs: { [COMPUTER_RESULT_DURABLE_SIDECAR_KEY]: full },
    });
    const ordinary = new ToolMessage({
      content: "ordinary compact content",
      tool_call_id: "ordinary-1",
      name: "run_shell",
      additional_kwargs: { [COMPUTER_RESULT_DURABLE_SIDECAR_KEY]: "hostile unrelated sidecar" },
    });

    expect(visibleTranscriptContent(computer)).toBe(full);
    expect(visibleTranscriptContent(ordinary)).toBe("ordinary compact content");
    expect(computer.content).toBe(compact);
  });
});

describe("Room history selected coordinates", () => {
  test("preserves the surviving physical row while binding the public logical key", () => {
    expect(projectRoomHistorySelectedMessageCoordinate({
      id: 42,
      sessionId: "10000000-0000-4000-8000-000000000001",
      editRevision: 3,
      role: "user",
      fingerprint: "shared-human-turn",
    })).toEqual({
      sessionId: "10000000-0000-4000-8000-000000000001",
      messageId: 42,
      editRevision: 3,
      role: "user",
      logicalMessageKey: "turn:shared-human-turn",
    });

    expect(projectRoomHistorySelectedMessageCoordinate({
      id: 43,
      sessionId: "10000000-0000-4000-8000-000000000002",
      editRevision: 0,
      role: "assistant",
      fingerprint: null,
    }).logicalMessageKey).toBe("row:43");
  });
});

/**
 * D359 — Phase 1: `reply_to_message_id` is persisted on insert by reading
 * `additional_kwargs.nautilo_reply_to_message_id` off the human HumanMessage.
 * These tests pin the extraction guard that the row mapping in
 * `appendTranscriptMessages` delegates to. A true INSERT test would require
 * a Postgres + RLS harness; the row mapping itself is a pure projection over
 * `extractReplyToMessageId`, so unit-testing the helper covers the contract.
 */
describe("extractReplyToMessageId", () => {
  test("returns the integer id from a human HumanMessage's additional_kwargs", () => {
    const msg = new HumanMessage({
      content: "reply",
      additional_kwargs: { nautilo_reply_to_message_id: 42 },
    });
    expect(extractReplyToMessageId(msg)).toBe(42);
  });

  test("returns null when the kwarg is absent", () => {
    const msg = new HumanMessage("plain user turn");
    expect(extractReplyToMessageId(msg)).toBeNull();
  });

  test("returns null when additional_kwargs is empty", () => {
    const msg = new HumanMessage({
      content: "no kwargs",
      additional_kwargs: {},
    });
    expect(extractReplyToMessageId(msg)).toBeNull();
  });

  test("returns null for non-human roles even if the kwarg is present", () => {
    const kwarg = { nautilo_reply_to_message_id: 99 };
    expect(
      extractReplyToMessageId(new AIMessage({ content: "ai", additional_kwargs: kwarg })),
    ).toBeNull();
    expect(
      extractReplyToMessageId(
        new ToolMessage({ content: "tool", tool_call_id: "x", name: "t", additional_kwargs: kwarg }),
      ),
    ).toBeNull();
    expect(
      extractReplyToMessageId(new SystemMessage({ content: "sys", additional_kwargs: kwarg })),
    ).toBeNull();
  });

  test("rejects non-integer numeric values", () => {
    const msg = new HumanMessage({
      content: "fractional",
      additional_kwargs: { nautilo_reply_to_message_id: 1.5 },
    });
    expect(extractReplyToMessageId(msg)).toBeNull();
  });

  test("rejects negative ids (DB row ids are non-negative)", () => {
    const msg = new HumanMessage({
      content: "negative",
      additional_kwargs: { nautilo_reply_to_message_id: -1 },
    });
    expect(extractReplyToMessageId(msg)).toBeNull();
  });

  test("rejects non-numeric kwarg shapes (string, null, undefined, object)", () => {
    for (const raw of ["42", null, undefined, { id: 42 }, [42], true]) {
      const msg = new HumanMessage({
        content: "bad shape",
        additional_kwargs: { nautilo_reply_to_message_id: raw },
      });
      expect(extractReplyToMessageId(msg)).toBeNull();
    }
  });

  test("returns 0 for a valid zero id (non-negative integer boundary)", () => {
    const msg = new HumanMessage({
      content: "zero",
      additional_kwargs: { nautilo_reply_to_message_id: 0 },
    });
    expect(extractReplyToMessageId(msg)).toBe(0);
  });
});

describe("transcript tool argument boundary", () => {
  test("serializes redacted args without mutating execution messages or raw fingerprints", () => {
    const secret = "durable-session-secret";
    const message = new AIMessage({
      content: "",
      tool_calls: [{
        id: "inspect-1",
        name: "inspect_open_design",
        args: {
          sessionToken: secret,
          cursor: "page:2",
          nested: { refresh_token: "nested-secret", intent: "continue" },
        },
      }],
    });
    const rawFingerprint = computeMessageFingerprint(message);
    const toolCalls = message.tool_calls ?? [];
    const serialized = serializeTranscriptToolCalls(toolCalls);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("nested-secret");
    expect(serialized).toContain("cursor");
    expect(toolCalls[0]?.args).toMatchObject({ sessionToken: secret });
    expect(computeMessageFingerprint(message)).toBe(rawFingerprint);
  });

  test("redacts legacy stored args before parsed and serialized history is returned", () => {
    const opaqueCursor = "Qm7_Na2-Xp9_Lc4-Vr8_Kd1-Zs6_Hf3-Wt5_By0-Gj7_Pe2-Ru9_Cx4";
    const legacy = JSON.stringify([{
      id: "inspect-legacy",
      name: "inspect_open_design",
      args: {
        session_token: "legacy-session-secret",
        cursor: opaqueCursor,
        pageSize: 25,
        nested: { clientSecret: "legacy-nested-secret", intent: "inspect" },
      },
    }]);

    const returned = sanitizeSerializedTranscriptToolCalls(legacy);
    expect(returned).not.toContain("legacy-session-secret");
    expect(returned).not.toContain("legacy-nested-secret");
    expect(returned).not.toContain(opaqueCursor);
    expect(parseTranscriptToolCalls(legacy)?.[0]?.args).toEqual({
      session_token: "[REDACTED TOOL ARG]",
      cursor: "[REDACTED TOOL ARG]",
      pageSize: 25,
      nested: { clientSecret: "[REDACTED TOOL ARG]", intent: "inspect" },
    });
  });

  test("redacts legacy provider argument strings instead of preserving a raw fallback", () => {
    const sessionSecret = "legacy-provider-session-secret";
    const nestedSecret = "legacy-provider-nested-secret";
    const legacy = JSON.stringify([{
      id: "inspect-provider",
      type: "function",
      function: {
        name: "inspect_open_design",
        arguments: JSON.stringify({
          sessionToken: sessionSecret,
          cursor: "page:3",
          nested: { api_key: nestedSecret },
        }),
      },
    }]);

    const returned = sanitizeSerializedTranscriptToolCalls(legacy);
    expect(returned).not.toContain(sessionSecret);
    expect(returned).not.toContain(nestedSecret);
    expect(returned).not.toContain("page:3");
    expect(returned).toContain("cursor");
    expect(returned).toContain("REDACTED TOOL ARG");
  });

  test("bounds the durable batch while preserving FIFO call identity", () => {
    const calls = Array.from({ length: 64 }, (_, index) => ({
      id: `call-${index}`,
      name: "inspect_open_design",
      args: Object.fromEntries(
        Array.from({ length: 64 }, (__, item) => [`field-${item}`, "x".repeat(4_096)]),
      ),
    }));

    const serialized = serializeTranscriptToolCalls(calls);
    const parsed = JSON.parse(serialized) as Array<Record<string, unknown>>;
    expect(serialized.length).toBeLessThan(1_048_576);
    expect(parsed).toHaveLength(64);
    expect(parsed[63]).toMatchObject({
      id: "call-63",
      name: "inspect_open_design",
      args: {},
    });
  });
});
