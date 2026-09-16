import { describe, expect, test } from "bun:test";
import type { LocalMcpInstallPrepared } from "@nautilo/types";
import { matchesLocalMcpInstallResumeBinding } from "../../src/nodes/post-model";

const approvalId = "local-mcp-install:turn-1:thread-1:call-1";
const digest = "digest-1";
const prepared = {
  binding: {
    version: "local-mcp-install-v1",
    approvalId,
    threadId: "thread-1",
    laneKey: "thread-1",
    toolCallId: "call-1",
    checkpointKey: "turn-1",
    digest,
  },
} as LocalMcpInstallPrepared;

function matches(overrides: Partial<Parameters<typeof matchesLocalMcpInstallResumeBinding>[0]> = {}): boolean {
  const base = {
    state: { turnId: "turn-1", langgraphThreadId: "thread-1", currentThreadId: "", approvalLaneKey: "thread-1" },
    decision: {
      localMcpInstallApprovalId: approvalId,
      localMcpInstallDigest: digest,
      localMcpInstallLaneKey: "thread-1",
    },
    prepared,
    laneKey: "thread-1",
    toolCallId: "call-1",
    approvalId,
    digest,
    verb: "once" as const,
  };
  return matchesLocalMcpInstallResumeBinding({ ...base, ...overrides });
}

describe("local MCP approval checkpoint binding", () => {
  test("accepts a restart replay of the same pending turn/checkpoint", () => {
    expect(matches()).toBe(true);
  });

  test("fails closed for a wrong reply lane, thread, turn, missing receipt, or reused tool id on a later turn", () => {
    expect(matches({ decision: { localMcpInstallApprovalId: approvalId, localMcpInstallDigest: digest, localMcpInstallLaneKey: "wrong-lane" } })).toBe(false);
    expect(matches({ state: { turnId: "turn-1", langgraphThreadId: "wrong-thread", currentThreadId: "", approvalLaneKey: "thread-1" } })).toBe(false);
    expect(matches({ state: { turnId: "turn-2", langgraphThreadId: "thread-1", currentThreadId: "", approvalLaneKey: "thread-1" } })).toBe(false);
    expect(matches({ decision: { localMcpInstallApprovalId: "", localMcpInstallDigest: "", localMcpInstallLaneKey: "thread-1" } })).toBe(false);
    // Model providers may reuse a tool-call id. The checkpointed turn nonce
    // keeps that later request from consuming this earlier approval.
    expect(matches({ state: { turnId: "later-turn", langgraphThreadId: "thread-1", currentThreadId: "", approvalLaneKey: "thread-1" } })).toBe(false);
  });

  test("task resume uses the same checkpointed task lane and rejects wrong lane/thread/turn", () => {
    const taskLane = "task:task-1";
    const taskApproval = "local-mcp-install:turn-1:task:task-1:call-1";
    const taskPrepared = {
      ...prepared,
      binding: { ...prepared.binding, approvalId: taskApproval, laneKey: taskLane },
    } as LocalMcpInstallPrepared;
    const taskBase = {
      state: { turnId: "turn-1", langgraphThreadId: "thread-1", currentThreadId: "", approvalLaneKey: taskLane },
      decision: { localMcpInstallApprovalId: taskApproval, localMcpInstallDigest: digest, localMcpInstallLaneKey: taskLane },
      prepared: taskPrepared,
      laneKey: taskLane,
      toolCallId: "call-1",
      approvalId: taskApproval,
      digest,
      verb: "once" as const,
    };
    expect(matchesLocalMcpInstallResumeBinding(taskBase)).toBe(true);
    expect(matchesLocalMcpInstallResumeBinding({ ...taskBase, laneKey: "thread-1" })).toBe(false);
    expect(matchesLocalMcpInstallResumeBinding({ ...taskBase, state: { ...taskBase.state, langgraphThreadId: "other" } })).toBe(false);
    expect(matchesLocalMcpInstallResumeBinding({ ...taskBase, state: { ...taskBase.state, turnId: "later" } })).toBe(false);
  });

  test("requires the exact once verb and exact prepared receipt", () => {
    expect(matches({ verb: "deny" })).toBe(false);
    expect(matches({ prepared: undefined })).toBe(false);
    expect(matches({ toolCallId: "other-call" })).toBe(false);
  });
});
