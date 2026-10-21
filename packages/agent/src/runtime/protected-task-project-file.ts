import { AsyncLocalStorage } from "node:async_hooks";
import type { RelayLocalFileRequest, RelayLocalFileResult } from "@nautilo/relay";
import type { NautiloState } from "../agent/state";

/** Server-owned, fresh Task/delegation authority for one prepared project child.
 * Never serialized into graph state or reconstructed from a tool argument. */
export interface ProtectedTaskProjectFilePort {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly agentId: string;
  readonly humanUserId: string;
  readonly relayId: string;
  readonly workspaceRoot: string;
  dispatch(request: RelayLocalFileRequest, options: Readonly<{
    mutating: boolean;
    approvalObtained: boolean;
    signal?: AbortSignal;
  }>): Promise<RelayLocalFileResult>;
}

type Scope = { readonly port: ProtectedTaskProjectFilePort; active: boolean };
const storage = new AsyncLocalStorage<Scope>();

export async function runWithProtectedTaskProjectFilePort<Value>(
  port: ProtectedTaskProjectFilePort,
  use: () => Value | Promise<Value>,
): Promise<Value> {
  const dispatch = port.dispatch.bind(port);
  const scope: Scope = { port: Object.freeze({ ...port, dispatch: async (request: RelayLocalFileRequest, options: Parameters<ProtectedTaskProjectFilePort["dispatch"]>[1]) => {
    if (!scope.active || storage.getStore() !== scope) throw new Error("Task project file custody ended");
    options.signal?.throwIfAborted();
    const result = await dispatch(request, options);
    if (!scope.active || storage.getStore() !== scope) throw new Error("Task project file custody ended");
    options.signal?.throwIfAborted();
    return result;
  } }), active: true };
  try { return await storage.run(scope, use); }
  finally { scope.active = false; }
}

export function getCurrentProtectedTaskProjectFilePort(): ProtectedTaskProjectFilePort | null {
  const scope = storage.getStore();
  if (scope !== undefined && !scope.active) throw new Error("Task project file custody ended");
  return scope?.port ?? null;
}

export function matchesProtectedTaskProjectFilePort(
  port: ProtectedTaskProjectFilePort,
  state: Pick<NautiloState, "taskRun" | "currentTaskId" | "currentTaskRunId" | "agentId" | "causalHumanUserId" | "trustedExecutionEntrypoint">,
): boolean {
  return state.taskRun === true && state.trustedExecutionEntrypoint === "background.task"
    && state.currentTaskId === port.taskId && state.currentTaskRunId === port.taskRunId
    && state.agentId === port.agentId && state.causalHumanUserId === port.humanUserId;
}
