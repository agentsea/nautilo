import { describe, expect, test } from "bun:test";

import type { ApprovalAskEvent } from "@nautilo/types";
import { rootTaskAttentionPlacement, taskApprovalForOverviewRow } from "./task-attention-placement";

const taskApproval = (approvalId: string, taskId: string): ApprovalAskEvent => ({
  type: "approval.ask",
  approvalId,
  origin: "task",
  taskId,
} as ApprovalAskEvent);

describe("Task approval placement", () => {
  test("uses the in-context approval surface in Chat and Task detail", () => {
    expect(rootTaskAttentionPlacement("/chat/room-id")).toBe("hidden");
    expect(rootTaskAttentionPlacement("/tasks/task-id")).toBe("hidden");
  });

  test("retains a compact route-to-action signal elsewhere", () => {
    expect(rootTaskAttentionPlacement("/home")).toBe("compact");
    expect(rootTaskAttentionPlacement("/settings/profile")).toBe("compact");
  });

  test("does not confuse similarly prefixed routes with the owned surfaces", () => {
    expect(rootTaskAttentionPlacement("/chat-export")).toBe("compact");
    expect(rootTaskAttentionPlacement("/tasks-archive")).toBe("compact");
  });

  test("binds a nested Task approval only to its exact child row", () => {
    const parentId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const siblingId = "33333333-3333-4333-8333-333333333333";
    const childApproval = taskApproval("shared-looking-id", childId);
    const approvals = [childApproval];

    expect(taskApprovalForOverviewRow({ sectionId: "needs-you", taskId: parentId, pendingApprovals: approvals })).toBeNull();
    expect(taskApprovalForOverviewRow({ sectionId: "needs-you", taskId: childId, pendingApprovals: approvals })).toBe(childApproval);
    expect(taskApprovalForOverviewRow({ sectionId: "needs-you", taskId: siblingId, pendingApprovals: approvals })).toBeNull();
  });

  test("survives the approval-before-awaiting race without reviving Done work", () => {
    const taskId = "22222222-2222-4222-8222-222222222222";
    const approval = taskApproval("approval", taskId);
    expect(taskApprovalForOverviewRow({ sectionId: "working-paused", taskId, pendingApprovals: [approval] })).toBe(approval);
    expect(taskApprovalForOverviewRow({ sectionId: "done", taskId, pendingApprovals: [approval] })).toBeNull();
  });
});
