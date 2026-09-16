import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ToolActivityEvent } from "./runtime-contexts";
import {
  applyCanonicalToolEndToActivity,
  bindRunningToolActivityToJob,
  finalizeRunningToolActivityWithoutReceipt,
  finalizeToolCallMessagesWithoutReceipt,
  isSameToolLifecycleCandidate,
  missingToolReceiptMessage,
} from "./tool-lifecycle-reconciliation";

function running(overrides: Partial<ToolActivityEvent> = {}): ToolActivityEvent {
  return {
    toolCallId: "call-1",
    toolName: "share_memory",
    laneKey: "room:room-1",
    authorAgentId: "agent-1",
    turnId: "turn-1",
    args: { mode: "attach" },
    status: "running",
    startedAt: 1,
    ...overrides,
  };
}

const job = {
  jobId: "job-1",
  roomId: "room-1",
  turnId: "turn-1",
  authorAgentId: "agent-1",
} as const;

describe("tool lifecycle terminal-job reconciliation", () => {
  test("binds only the exact Room, turn, and author", () => {
    expect(bindRunningToolActivityToJob(running(), "room-1", job).jobId).toBe("job-1");
    expect(bindRunningToolActivityToJob(running({ turnId: "turn-2" }), "room-1", job).jobId).toBeUndefined();
    expect(bindRunningToolActivityToJob(running({ authorAgentId: "agent-2" }), "room-1", job).jobId).toBeUndefined();
    expect(bindRunningToolActivityToJob(running({ authorAgentId: undefined }), "room-1", job).jobId).toBeUndefined();
    expect(bindRunningToolActivityToJob(running(), "room-2", job).jobId).toBeUndefined();
  });

  test("does not bind a modern tool to a unique unrelated Room job", () => {
    const unrelated = { jobId: "only-live-job", roomId: "room-1" };
    expect(bindRunningToolActivityToJob(running(), "room-1", unrelated).jobId).toBeUndefined();
    expect(bindRunningToolActivityToJob(running({ turnId: undefined }), "room-1", unrelated).jobId).toBeUndefined();
  });

  test("selects neither of multiple Room jobs without an exact matching turn", () => {
    const candidates = [
      { jobId: "job-2", roomId: "room-1", turnId: "turn-2", authorAgentId: "agent-1" },
      { jobId: "job-3", roomId: "room-1", turnId: "turn-3", authorAgentId: "agent-1" },
    ];
    expect(candidates.map((candidate) =>
      bindRunningToolActivityToJob(running(), "room-1", candidate).jobId,
    )).toEqual([undefined, undefined]);
  });

  test("a delayed terminal read cannot settle a replacement with reused call and turn ids", () => {
    const original = running({ startedAt: 1 });
    const replacement = running({ startedAt: 2 });
    const candidates = new Map([[original.toolCallId, original]]);
    expect(isSameToolLifecycleCandidate(original.toolCallId, original, candidates)).toBe(true);
    expect(isSameToolLifecycleCandidate(replacement.toolCallId, replacement, candidates)).toBe(false);
  });

  test("marks a precisely bound missing receipt as unavailable, never success", () => {
    const settled = finalizeRunningToolActivityWithoutReceipt(running(), "room-1", {
      ...job,
      status: "failed",
    }, 9);
    expect(settled).toMatchObject({
      jobId: "job-1",
      status: "error",
      endedAt: 9,
      error: missingToolReceiptMessage("failed"),
    });
  });

  test("leaves a canonical completed result unchanged", () => {
    const completed = running({
      jobId: "job-1",
      status: "ok",
      result: "applied",
      endedAt: 8,
    });
    expect(finalizeRunningToolActivityWithoutReceipt(completed, "room-1", {
      ...job,
      status: "completed",
    }, 9)).toBe(completed);
  });

  test("an exact job id cannot bypass the Room fence", () => {
    const exact = running({ jobId: "job-1" });
    expect(finalizeRunningToolActivityWithoutReceipt(exact, "room-2", {
      ...job,
      status: "failed",
    }, 9)).toBe(exact);
  });

  test("updates only the exact pending card and preserves canonical results", () => {
    const messages: ThreadMessageLike[] = [
      { id: "pending", role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "share_memory", args: {} }] },
      { id: "other", role: "assistant", content: [{ type: "tool-call", toolCallId: "call-2", toolName: "share_memory", args: {} }] },
      { id: "complete", role: "assistant", content: [{ type: "tool-call", toolCallId: "call-3", toolName: "share_memory", args: {}, result: "applied" }] },
    ];
    const result = missingToolReceiptMessage("failed");
    const next = finalizeToolCallMessagesWithoutReceipt(messages, new Set(["call-1", "call-3"]), result);
    expect(next[0]?.content).toEqual([{ type: "tool-call", toolCallId: "call-1", toolName: "share_memory", args: {}, result, isError: true }]);
    expect(next[1]).toBe(messages[1]);
    expect(next[2]).toBe(messages[2]);
  });

  test("a later canonical tool.end can replace the unavailable fallback", () => {
    const unknown = finalizeRunningToolActivityWithoutReceipt(running(), "room-1", {
      ...job,
      status: "failed",
    }, 9);
    const canonical = applyCanonicalToolEndToActivity(unknown, {
      status: "success",
      endedAt: 10,
      result: "attached",
    });
    expect(canonical).toMatchObject({ status: "ok", result: "attached" });
    expect(canonical.error).toBeUndefined();
  });
});
