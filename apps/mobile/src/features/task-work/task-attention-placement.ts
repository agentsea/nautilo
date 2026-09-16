import type { ApprovalAskEvent } from "@nautilo/types";

export type RootTaskAttentionPlacement = "hidden" | "compact";

/**
 * Chat and Task detail own the canonical in-context Task approval surface.
 * Other routes retain a compact signal that navigates to the exact Task.
 */
export function rootTaskAttentionPlacement(pathname: string): RootTaskAttentionPlacement {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "hidden";
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return "hidden";
  return "compact";
}

/**
 * Overview approvals are attached only to the exact canonical Task row. Parent,
 * child, and sibling Tasks never inherit one another's approval authority.
 */
export function taskApprovalForOverviewRow(input: {
  readonly sectionId: string;
  readonly taskId: string;
  readonly pendingApprovals: readonly ApprovalAskEvent[];
}): ApprovalAskEvent | null {
  // The owner-scoped approval event can precede the canonical Task status
  // reconciliation by one frame. Keep the exact action reachable on its
  // Working/Paused row during that transition, but never revive Done work.
  if (input.sectionId === "done") return null;
  return input.pendingApprovals.find((approval) =>
    approval.origin === "task" && approval.taskId === input.taskId
  ) ?? null;
}
