import { PROTECTED_TASK_CANCELLED_RESULT } from "@nautilo/db";
import {
  lockExactProtectedTaskMessageAllocation,
  type LockedProtectedTaskMessageAllocation,
} from "./protected-task-message-allocation";
import type { ProtectedTaskTerminalMessageIntent } from
  "./protected-task-terminal-message-product";

export type LockedProtectedTaskTerminalMessageAllocation = LockedProtectedTaskMessageAllocation;

/** The cancellation sibling always retains its fixed ordinary payload. */
export function lockExactProtectedTaskTerminalMessageAllocation(input:
  Omit<Parameters<typeof lockExactProtectedTaskMessageAllocation>[0],
    "intent" | "shadowContentMatches"> & Readonly<{
      intent: ProtectedTaskTerminalMessageIntent;
    }>,
): Promise<LockedProtectedTaskTerminalMessageAllocation | null> {
  return lockExactProtectedTaskMessageAllocation({ ...input,
    shadowContentMatches: content => content === PROTECTED_TASK_CANCELLED_RESULT,
  });
}
