import { describe, expect, test } from "bun:test";
import { ToolMessage, mapStoredMessagesToChatMessages } from "@langchain/core/messages";
import { assignStableToolMessageId, isStableToolMessageId } from "../../src/stable-ids.js";

describe("assignStableToolMessageId", () => {
  test("sets msg.id to tm:<tool_call_id> on a fresh ToolMessage", () => {
    const msg = new ToolMessage({
      content: "ok",
      tool_call_id: "call_abc",
      name: "foo",
    });
    assignStableToolMessageId(msg);
    expect(msg.id).toBe("tm:call_abc");
  });

  test("is idempotent when called twice on the same message", () => {
    const msg = new ToolMessage({
      content: "ok",
      tool_call_id: "call_xyz",
      name: "foo",
    });
    assignStableToolMessageId(msg);
    const first = msg.id;
    assignStableToolMessageId(msg);
    expect(msg.id).toBe(first);
    expect(msg.id).toBe("tm:call_xyz");
  });

  test("keeps stable identity and outcome when a stored message is loaded", () => {
    const msg = new ToolMessage({ content: "saved source", tool_call_id: "persisted", name: "file", status: "error" });
    assignStableToolMessageId(msg);
    const [loaded] = mapStoredMessagesToChatMessages([msg.toDict()]);
    expect(loaded?.id).toBe(msg.id);
    expect(loaded?.content).toBe(msg.content);
    expect(ToolMessage.isInstance(loaded) && loaded.status).toBe("error");
  });

  test("does not set id when tool_call_id is missing or empty", () => {
    const emptyTc = new ToolMessage({
      content: "x",
      tool_call_id: "",
      name: "foo",
    });
    assignStableToolMessageId(emptyTc);
    expect(emptyTc.id).toBeUndefined();

    const missingTc = new ToolMessage({
      content: "x",
      tool_call_id: "will-remove",
      name: "foo",
    });
    delete (missingTc as { tool_call_id?: string }).tool_call_id;
    assignStableToolMessageId(missingTc);
    expect(missingTc.id).toBeUndefined();
  });
});

describe("isStableToolMessageId", () => {
  test("returns true for matching tm: prefix and tool_call_id", () => {
    expect(isStableToolMessageId("tm:abc", "abc")).toBe(true);
  });

  test("returns false for non-matching or undefined id", () => {
    expect(isStableToolMessageId("random-uuid", "abc")).toBe(false);
    expect(isStableToolMessageId(undefined, "abc")).toBe(false);
  });
});
