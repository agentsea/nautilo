import { describe, expect, test } from "bun:test";
import { connectedWebActionAttentionKey, consumePendingAttentionForToolStart, parseConnectedWebActionAttention, parseConnectedWebActionResumeFailed, pendingAttentionForToolStart } from "./connected-web-action-attention";

const attention = {
  type: "connected_web.action_attention",
  threadId: "thread-1",
  laneKey: "room:room-1:user:human:bot:genie",
  toolCallId: "tool-call-1",
  userId: "human-1",
  intervention: {
    kind: "authentication_required",
    mode: "reconnect",
    reason: "mfa",
    account: {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Notion",
      service: "Notion",
      origin: "https://www.notion.so",
    },
  },
};

describe("connected web action attention", () => {
  test("preserves the exact thread/lane/tool binding without provider data", () => {
    const parsed = parseConnectedWebActionAttention(attention, 3, "human-1");
    const { userId: _userId, ...expected } = attention;
    expect(parsed).toEqual({ ...expected, revision: 3 });
    expect(connectedWebActionAttentionKey(parsed!)).toBe("thread-1\0room:room-1:user:human:bot:genie\0tool-call-1");
  });

  test("fails closed for extra provider fields or an invalid intervention", () => {
    expect(parseConnectedWebActionAttention({ ...attention, providerRunId: "provider-secret" }, 1, "human-1")).toBeNull();
    expect(parseConnectedWebActionAttention({ ...attention, intervention: { ...attention.intervention, account: { ...attention.intervention.account, origin: "https://user:secret@www.notion.so" } } }, 1, "human-1")).toBeNull();
    expect(parseConnectedWebActionAttention(attention, 1, "another-human")).toBeNull();
  });

  test("accepts only an exact requester-private resume failure", () => {
    const failed = { type: "connected_web.action_resume_failed", threadId: attention.threadId, laneKey: attention.laneKey, toolCallId: attention.toolCallId, userId: attention.userId, cancelRecovery: "available" };
    expect(parseConnectedWebActionResumeFailed(failed, "human-1")).toEqual({ type: failed.type, threadId: failed.threadId, laneKey: failed.laneKey, toolCallId: failed.toolCallId, cancelRecovery: failed.cancelRecovery });
    expect(parseConnectedWebActionResumeFailed({ ...failed, providerRunId: "secret" }, "human-1")).toBeNull();
    expect(parseConnectedWebActionResumeFailed(failed, "another-human")).toBeNull();
  });

  test("keeps an early event for its exact later tool.start and replaces repeated attention", () => {
    const first = parseConnectedWebActionAttention(attention, 1, "human-1")!;
    const repeated = parseConnectedWebActionAttention(attention, 2, "human-1")!;
    const pending = new Map([[connectedWebActionAttentionKey(first), first]]);
    expect(pendingAttentionForToolStart(pending.values(), "act_connected_web_account", attention.laneKey, attention.toolCallId)).toBe(first);
    pending.set(connectedWebActionAttentionKey(repeated), repeated);
    expect(pendingAttentionForToolStart(pending.values(), "act_connected_web_account", attention.laneKey, attention.toolCallId)).toBe(repeated);
    expect(pendingAttentionForToolStart(pending.values(), "read_connected_web_account", attention.laneKey, attention.toolCallId)).toBeUndefined();
  });

  test("consumes attention once so replaying the same tool start cannot restore the prompt", () => {
    const parsed = parseConnectedWebActionAttention(attention, 1, "human-1")!;
    const pending = new Map([[connectedWebActionAttentionKey(parsed), parsed]]);
    expect(consumePendingAttentionForToolStart(pending, "act_connected_web_account", attention.laneKey, attention.toolCallId)).toBe(parsed);
    expect(consumePendingAttentionForToolStart(pending, "act_connected_web_account", attention.laneKey, attention.toolCallId)).toBeUndefined();
    expect(pending.size).toBe(0);
  });
});
