import type { ProtectedTaskExternalRequestClient } from "./protected-task-external-request-response";
import type { CodexRequestLifecycleAction } from "./runtime-contexts";

type RecoveryAction = Extract<
  CodexRequestLifecycleAction,
  { readonly kind: "arm" | "forget_content" }
>;

export async function recoverCurrentProtectedTaskExternalRequests(input: Readonly<{
  client: ProtectedTaskExternalRequestClient;
  clientActionSessionId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  previousRequestIds: ReadonlySet<string>;
  dispatch(action: RecoveryAction): void;
}>): Promise<ReadonlySet<string> | null> {
  const result = await input.client.recoverProtectedTaskExternalRequests({
    clientActionSessionId: input.clientActionSessionId,
    signal: input.signal,
    isCurrent: input.isCurrent,
  });
  if (!input.isCurrent() || result.status !== "ready") return null;

  const currentIds = new Set(result.entries.map(entry => entry.event.requestId));
  const absent = [...input.previousRequestIds].filter(id => !currentIds.has(id));
  if (absent.length !== 0) {
    input.dispatch({ kind: "forget_content", requestIds: absent });
  }
  for (const { event } of result.entries) {
    input.dispatch({ kind: "arm", event });
  }
  return currentIds;
}
