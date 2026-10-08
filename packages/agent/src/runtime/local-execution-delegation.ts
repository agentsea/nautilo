import { AsyncLocalStorage } from "node:async_hooks";
import type { LocalExecutionDelegation } from "@nautilo/types";

export type DelegatedLocalExecutionOperation = "start" | "input" | "read" | "cancel";
export interface DelegatedLocalExecutionAdmission {
  readonly delegation: LocalExecutionDelegation;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly signal: AbortSignal;
}
/** An invocation-owned callback to current Task/content authority. Its
 * serializable descriptor is a locator; only this live port admits an effect. */
export interface DelegatedLocalExecutionPort {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly signal: AbortSignal;
  /** Retained by the existing Relay execution record, released on its cleanup. */
  retain?(): () => void;
  withAdmission<Value>(
    operation: DelegatedLocalExecutionOperation,
    work: (admission: DelegatedLocalExecutionAdmission) => Promise<Value>,
  ): Promise<Value>;
}

/** Task tools may inherit this live source while creating a child. The slot is
 * process-local and cannot be restored from model arguments or a checkpoint. */
const context = new AsyncLocalStorage<DelegatedLocalExecutionPort>();
export function runWithLocalExecutionDelegation<T>(port: DelegatedLocalExecutionPort | undefined, work: () => T): T {
  return port ? context.run(port, work) : context.exit(work);
}
export function getCurrentLocalExecutionDelegation(): DelegatedLocalExecutionPort | undefined {
  return context.getStore();
}
