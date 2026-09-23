import { AsyncLocalStorage } from "node:async_hooks";

// Legacy Task checkpoints may lack this field, while the Task record retains
// the verified requestor. Never infer the payer from the Agent owner.
const taskHuman = new AsyncLocalStorage<string>();

export function runWithTaskCausalHuman<T>(humanUserId: string, run: () => T): T {
  return taskHuman.run(humanUserId, run);
}

export function causalHumanForExecution(checkpointHumanUserId: string | null | undefined): string {
  return checkpointHumanUserId?.trim() || taskHuman.getStore() || "";
}
