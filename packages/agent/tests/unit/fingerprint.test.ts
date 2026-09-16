import { describe, expect, test } from "bun:test";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { computeMessageFingerprint } from "../../src/store/fingerprint";

const HEX64 = /^fp:v1:(human|ai|tool|unknown):[0-9a-f]{64}$/;

describe("computeMessageFingerprint (M070 — sha256 hashed)", () => {
  test("returns fixed-shape fp:v1:<type>:<sha256-hex>", () => {
    expect(computeMessageFingerprint(new HumanMessage("hi"))).toMatch(HEX64);
    expect(computeMessageFingerprint(new AIMessage("hi"))).toMatch(HEX64);
    expect(computeMessageFingerprint(new ToolMessage({ content: "x", tool_call_id: "x" }))).toMatch(HEX64);
  });

  test("constant length regardless of input size (postgres btree-safe)", () => {
    const tiny = computeMessageFingerprint(new HumanMessage("hi"));
    const huge = computeMessageFingerprint(new HumanMessage("x".repeat(50_000)));
    expect(tiny.length).toBe(huge.length);
    expect(tiny.length).toBeLessThanOrEqual(80);
  });

  test("identical content (including whitespace normalization) collides", () => {
    const a = computeMessageFingerprint(new HumanMessage("  hello   world  "));
    const b = computeMessageFingerprint(new HumanMessage("hello world"));
    expect(a).toBe(b);
  });

  test("different content does not collide", () => {
    expect(computeMessageFingerprint(new HumanMessage("a")))
      .not.toBe(computeMessageFingerprint(new HumanMessage("b")));
  });

  test("type prefix distinguishes human / ai / tool with same content", () => {
    const text = "ok";
    expect(computeMessageFingerprint(new HumanMessage(text)))
      .not.toBe(computeMessageFingerprint(new AIMessage(text)));
    expect(computeMessageFingerprint(new HumanMessage(text)))
      .not.toBe(computeMessageFingerprint(new ToolMessage({ content: text, tool_call_id: "x" })));
  });

  test("humanTurnId suffix only affects human messages", () => {
    const a = computeMessageFingerprint(new HumanMessage("ok"));
    const b = computeMessageFingerprint(new HumanMessage("ok"), { humanTurnId: "turn-1" });
    const c = computeMessageFingerprint(new HumanMessage("ok"), { humanTurnId: "turn-2" });
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);

    const aiNoTurn = computeMessageFingerprint(new AIMessage("ok"));
    const aiWithTurn = computeMessageFingerprint(new AIMessage("ok"), { humanTurnId: "turn-1" });
    expect(aiNoTurn).toBe(aiWithTurn);
  });

  test("AIMessage string id suffix distinguishes otherwise identical AI rows", () => {
    const a = new AIMessage({ content: "x", id: "run-1" });
    const b = new AIMessage({ content: "x", id: "run-2" });
    expect(computeMessageFingerprint(a)).not.toBe(computeMessageFingerprint(b));
  });

  test("ToolMessage tool_call_id suffix distinguishes otherwise identical tool rows", () => {
    // Same tool, same output, different invocations → must persist
    // as two distinct rows. Without the tool_call_id qualifier the
    // partial unique index collapses them via ON CONFLICT DO NOTHING
    // and the second invocation is silently lost.
    const big = "Found 15 memories: ".repeat(2000);
    const a = new ToolMessage({ content: big, tool_call_id: "call_aaa" });
    const b = new ToolMessage({ content: big, tool_call_id: "call_bbb" });
    expect(computeMessageFingerprint(a)).not.toBe(computeMessageFingerprint(b));
  });

  test("ToolMessage with same content AND same tool_call_id collides (true duplicate from a retry)", () => {
    const a = new ToolMessage({ content: "ok", tool_call_id: "call_x" });
    const b = new ToolMessage({ content: "ok", tool_call_id: "call_x" });
    expect(computeMessageFingerprint(a)).toBe(computeMessageFingerprint(b));
  });

  test("ToolMessage without tool_call_id falls back to content-only fingerprint (legacy / synthetic)", () => {
    const a = new ToolMessage({ content: "x", tool_call_id: "" });
    const b = new ToolMessage({ content: "x", tool_call_id: "" });
    expect(computeMessageFingerprint(a)).toBe(computeMessageFingerprint(b));
  });

  test("identical multimodal human content yields identical fingerprints", () => {
    const blocks = [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: "https://example.com/x.png" },
    ];
    const m1 = new HumanMessage({ content: blocks });
    const m2 = new HumanMessage({ content: blocks });
    expect(computeMessageFingerprint(m1)).toBe(computeMessageFingerprint(m2));
  });

  test("human replyToMessageId suffix distinguishes same text", () => {
    const a = new HumanMessage({ content: "same", additional_kwargs: { nautilo_reply_to_message_id: 1 } });
    const b = new HumanMessage({ content: "same", additional_kwargs: { nautilo_reply_to_message_id: 2 } });
    expect(computeMessageFingerprint(a)).not.toBe(computeMessageFingerprint(b));
  });
});
