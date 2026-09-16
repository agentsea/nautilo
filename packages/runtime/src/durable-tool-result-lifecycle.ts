/**
 * D513 Phase 3.3 — process-local observations made only after a normal
 * transcript ToolMessage has been durably inserted. This is not a ServerEvent,
 * a transcript field, or a routing mechanism. The server may use one matching
 * observation to attempt an exact-socket presentation, and failure remains a
 * durable-card-only outcome.
 */

export type DurableToolExecutionEntrypoint =
  | "foreground.main"
  | "foreground.fork"
  | "foreground.task_report_back"
  | "background.task"
  | "foreground.subagent"
  | null;

export type DurableToolResultLifecycleEvent = Readonly<{
  kind: "tool_result_persisted";
  toolName: string;
  content: string;
  fingerprint: string;
  trustedExecutionEntrypoint: DurableToolExecutionEntrypoint;
  turnId: string | null;
}>;

export type DurableToolResultLifecycleObserver = (
  event: DurableToolResultLifecycleEvent,
) => void;

let installed: { token: symbol; observer: DurableToolResultLifecycleObserver } | null = null;

/**
 * One app owns the observer. Replacement is intentional for repeated app
 * construction in tests; an older cleanup closure cannot remove a replacement.
 */
export function installDurableToolResultLifecycleObserver(
  observer: DurableToolResultLifecycleObserver,
): () => void {
  const token = Symbol("durable-tool-result-lifecycle");
  installed = { token, observer };
  return () => {
    if (installed?.token === token) installed = null;
  };
}

/** Observers are advisory: durable transcript persistence must never fail here. */
export function notifyDurableToolResultLifecycle(
  event: DurableToolResultLifecycleEvent,
): void {
  try {
    installed?.observer(event);
  } catch {
    // No content, ids, or target information may be exposed by this diagnostic.
    console.warn("[durable-tool-result-lifecycle] observer failed; automatic presentation dropped");
  }
}

/** Narrow test reset; production always installs through the guarded API. */
export function _resetDurableToolResultLifecycleObserverForTests(): void {
  installed = null;
}
