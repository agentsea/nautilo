import { describe, expect, test } from "bun:test";
import type { ToolActivityEvent } from "./runtime-contexts";
import { applyConnectedWebActionResumeFailureToActivity } from "./nautilo-runtime";

const failed = {
  type: "connected_web.action_resume_failed" as const,
  threadId: "thread-1",
  laneKey: "room:room-1:bot:genie-1",
  toolCallId: "tool-1",
  cancelRecovery: "available" as const,
};

describe("connected website action terminal ordering", () => {
  test("a resume-failed event after tool.end cannot replace canonical completion", () => {
    const completed: ToolActivityEvent = {
      toolCallId: failed.toolCallId,
      toolName: "act_connected_web_account",
      args: { target: "Project plan" },
      laneKey: failed.laneKey,
      status: "ok",
      startedAt: 1,
      completedAt: 2,
      result: JSON.stringify({ ok: true, status: "completed" }),
    };

    const projected = applyConnectedWebActionResumeFailureToActivity(completed, failed);

    expect(projected).toBe(completed);
    expect(projected?.status).toBe("ok");
    expect(projected?.result).toBe(completed.result);
    expect(projected?.connectedWebActionResumeFailed).toBeUndefined();
  });

  test("the same event annotates its exact action only while it is running", () => {
    const running: ToolActivityEvent = {
      toolCallId: failed.toolCallId,
      toolName: "act_connected_web_account",
      args: { target: "Project plan" },
      laneKey: failed.laneKey,
      status: "running",
      startedAt: 1,
    };

    expect(applyConnectedWebActionResumeFailureToActivity(running, failed))
      .toMatchObject({ status: "running", connectedWebActionResumeFailed: failed });
  });
});
