import { expect, test } from "bun:test";

test("global task attention routes only exact Task identities into the shared detail route", async () => {
  const source = await Bun.file(new URL("../app/_layout.tsx", import.meta.url)).text();
  expect(source).toContain('import { isExactTaskId } from "@/features/task-work/task-detail-state"');
  expect(source).toContain('attentionApproval.origin === "task" && isExactTaskId(attentionApproval.taskId)');
  expect(source).toContain('router.push(`/tasks/${attentionApproval.taskId}`)');
  expect(source).toContain('rootTaskAttentionPlacement(pathname) === "hidden"');
  expect(source).toContain("compact={isTaskApproval}");
  expect(source).toContain('"Approval needed — tap to review"');
  expect(source).not.toContain('`Approval needed: ${attentionApproval.reason}`');
  expect(source).not.toContain("tapping is a no-op for task approvals");
});

test("expanded delegated work owns the direct canonical Task approval controls", async () => {
  const source = await Bun.file(new URL("../features/task-work/task-work-overview-content.tsx", import.meta.url)).text();

  expect(source).toContain("taskApprovalForOverviewRow({");
  expect(source).toContain("taskId: item.row.taskId");
  expect(source).toContain("pendingApprovals");
  expect(source).toContain("<ApprovalCard approval={taskApproval} />");
});
