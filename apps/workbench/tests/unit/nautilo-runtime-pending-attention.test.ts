import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  changesPendingAttention,
  isPendingAttentionSubmissionCurrent,
  isTaskPendingAttentionPreviewEvent,
  pendingAttentionPreviewIngress,
  recoverDesktopRoomPendingAttention,
  shouldAutoResolvePendingAttentionAsk,
} from "../../src/adapters/nautilo-runtime";

const ROOM = "40000000-0000-4000-8000-000000000322";
const OTHER_ROOM = "50000000-0000-4000-8000-000000000322";
const VIEWER = "viewer-322";

function approval(roomId = ROOM, userId = VIEWER): Extract<
  ServerEvent,
  { type: "approval.ask" }
> {
  return {
    type: "approval.ask",
    approvalId: `approval:${roomId}`,
    threadId: `thread:${roomId}`,
    laneKey: `room:${roomId}`,
    userId,
    tools: [{ name: "read_file", args: { path: "/tmp/example" } }],
    reason: "Review required",
    reasonCode: "destructive-tool",
    allowedVerbs: ["once", "deny"],
  };
}

const scope = {
  roomId: ROOM,
  userId: VIEWER,
  laneKeyToRoomId: new Map<string, string>(),
  jobIdToRoomId: new Map<string, string>(),
};

describe("pending approval restart recovery", () => {
  test("older Desktop shells fail pending recovery closed before crypto admission", async () => {
    let admissionCalls = 0;
    const result = await recoverDesktopRoomPendingAttention(
      {},
      {
        roomId: ROOM,
        clientActionSessionId: "session-322",
      },
      async (operation) => {
        admissionCalls += 1;
        return operation();
      },
    );

    expect(result).toEqual({ status: "unavailable", events: [] });
    expect(admissionCalls).toBe(0);
  });

  test("preserves every Task/subagent attention type on the owner-scoped live path", () => {
    const taskScope = {
      origin: "task" as const,
      taskId: "task-322",
      taskRunId: "run-322",
      threadId: "thread-322",
      laneKey: "task:task-322",
    };
    const events: ServerEvent[] = [
      {
        type: "approval.ask",
        approvalId: "approval-322",
        userId: VIEWER,
        tools: [],
        reason: "Review required",
        reasonCode: "destructive-tool",
        allowedVerbs: ["once", "deny"],
        ...taskScope,
      },
      {
        type: "prove_it.challenge",
        userId: VIEWER,
        tools: [],
        ...taskScope,
      },
      {
        type: "identity.challenge",
        userId: VIEWER,
        challengeId: "challenge-322",
        expiresAt: "2100-01-01T00:00:00.000Z",
        ...taskScope,
      },
    ];

    expect(events.map(isTaskPendingAttentionPreviewEvent)).toEqual([
      true,
      true,
      true,
    ]);
    expect(events.map((event) => pendingAttentionPreviewIngress(event, false)))
      .toEqual(["direct", "direct", "direct"]);

    expect(pendingAttentionPreviewIngress({
      ...events[0],
      origin: undefined,
      laneKey: "task:legacy-task-322",
    }, false)).toBe("direct");
    expect(pendingAttentionPreviewIngress({
      ...events[1],
      origin: "task",
      laneKey: "legacy-owner-scoped-lane",
    }, false)).toBe("direct");
  });

  test("does not divert ordinary Room attention from checkpoint reconciliation", () => {
    expect(isTaskPendingAttentionPreviewEvent(approval())).toBe(false);
    expect(pendingAttentionPreviewIngress(approval(), true)).toBe("enqueue");
    expect(pendingAttentionPreviewIngress(approval(OTHER_ROOM), false)).toBe("drop");
  });

  test("rejects a late callback after challenge, Room, or viewer generation changes", () => {
    const base = {
      capturedKey: "prove-it:challenge-a",
      capturedRoomId: ROOM,
      capturedViewerGeneration: 7,
      capturedScopeGeneration: 11,
      currentKey: "prove-it:challenge-a",
      currentRoomId: ROOM,
      currentViewerGeneration: 7,
      currentScopeGeneration: 11,
    };
    expect(isPendingAttentionSubmissionCurrent(base)).toBe(true);
    expect(isPendingAttentionSubmissionCurrent({ ...base, currentKey: "prove-it:challenge-b" })).toBe(false);
    expect(isPendingAttentionSubmissionCurrent({ ...base, currentRoomId: OTHER_ROOM })).toBe(false);
    expect(isPendingAttentionSubmissionCurrent({ ...base, currentViewerGeneration: 8 })).toBe(false);
    expect(isPendingAttentionSubmissionCurrent({ ...base, currentScopeGeneration: 12 })).toBe(false);
  });
  test("never auto-replies to recovered previews while preserving live auto-approve", () => {
    let approvalReplies = 0;
    const maybeReply = (recovered: boolean): void => {
      if (shouldAutoResolvePendingAttentionAsk({
        recovered,
        enabled: true,
        hasNetworkContext: false,
        requiresExplicitReview: false,
      })) approvalReplies += 1;
    };

    maybeReply(true);
    expect(approvalReplies).toBe(0);
    maybeReply(false);
    expect(approvalReplies).toBe(1);
  });

  test("does not invalidate the active recovery for another Room or viewer", () => {
    expect(changesPendingAttention(approval(), scope)).toBe(true);
    expect(changesPendingAttention(approval(OTHER_ROOM), scope)).toBe(false);
    expect(changesPendingAttention(approval(ROOM, "other-viewer"), scope)).toBe(false);
  });

  test("scopes terminal job invalidation through exact job or lane provenance", () => {
    const terminal: Extract<ServerEvent, { type: "job.status" }> = {
      type: "job.status",
      jobId: "job-322",
      status: "completed",
      laneKey: `room:${OTHER_ROOM}`,
    };
    expect(changesPendingAttention(terminal, scope)).toBe(false);
    expect(changesPendingAttention(terminal, {
      ...scope,
      jobIdToRoomId: new Map([[terminal.jobId, ROOM]]),
    })).toBe(true);
  });
});
