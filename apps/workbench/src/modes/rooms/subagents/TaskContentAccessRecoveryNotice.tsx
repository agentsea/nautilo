import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../../lib/api";

type TaskRecoveryCoordinate = NonNullable<Awaited<
  ReturnType<typeof apiClient.getTaskContentAccessRecovery>
>["recovery"]>;

export interface TaskContentAccessRecoveryClient {
  getTaskContentAccessRecovery(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ recovery: TaskRecoveryCoordinate | null }>;
  recoverTaskContentAccess(
    taskId: string,
    coordinate: TaskRecoveryCoordinate,
    options?: { signal?: AbortSignal },
  ): Promise<{ outcome: "completed" | "busy" | "unavailable" | "retry_required" }>;
}

interface RecoverySnapshot {
  readonly scopeKey: string;
  readonly recovery: TaskRecoveryCoordinate | null;
}

export function shouldShowTaskContentAccessRecovery(input: Readonly<{
  mode: string | null | undefined;
  viewerVerified: boolean;
  taskId: string;
  scopeKey: string;
}>): boolean {
  return input.mode === "plaintext_only"
    && input.viewerVerified
    && input.taskId.length > 0
    && input.scopeKey.length > 0;
}

function outcomeMessage(outcome: "completed" | "busy" | "unavailable" | "retry_required"): string {
  switch (outcome) {
    case "completed": return "Recovery finished. Checking Task state…";
    case "busy": return "This Task is still settling. You can check again.";
    case "unavailable": return "Sharing recovery is unavailable. Checking Task state…";
    case "retry_required": return "Sharing still needs verification. Check again to continue.";
  }
}

/** Owner-scoped explicit recovery for one exact durable Task checkpoint. */
export function TaskContentAccessRecoveryNotice({
  taskId,
  taskStatus,
  scopeKey,
  discoveryGeneration,
  client = apiClient,
}: Readonly<{
  taskId: string;
  taskStatus?: string;
  scopeKey: string;
  discoveryGeneration: number;
  client?: TaskContentAccessRecoveryClient;
}>) {
  const [snapshot, setSnapshot] = useState<RecoverySnapshot>({ scopeKey, recovery: null });
  const [rediscoveryGeneration, setRediscoveryGeneration] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("Sharing outcome needs verification");
  const requestGenerationRef = useRef(0);
  const scopeGenerationRef = useRef(0);
  const recoveryControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSubmitting(false);
    setMessage("Sharing outcome needs verification");
    return () => {
      recoveryControllerRef.current?.abort();
      recoveryControllerRef.current = null;
      scopeGenerationRef.current += 1;
    };
  }, [scopeKey, taskId]);

  useEffect(() => {
    const controller = new AbortController();
    const requestGeneration = ++requestGenerationRef.current;
    void client.getTaskContentAccessRecovery(taskId, { signal: controller.signal })
      .then(({ recovery }) => {
        if (controller.signal.aborted || requestGeneration !== requestGenerationRef.current) return;
        if (recovery !== null && recovery.taskId !== taskId) return;
        setSnapshot({ scopeKey, recovery });
      })
      .catch(() => {
        // Read failure cannot prove that an admitted same-scope recovery vanished.
      });
    return () => {
      controller.abort();
      requestGenerationRef.current += 1;
    };
  }, [client, discoveryGeneration, rediscoveryGeneration, scopeKey, taskId, taskStatus]);

  const recovery = snapshot.scopeKey === scopeKey ? snapshot.recovery : null;
  const checkAndContinue = useCallback(() => {
    if (recovery === null || submitting) return;
    const controller = new AbortController();
    recoveryControllerRef.current = controller;
    const scopeGeneration = scopeGenerationRef.current;
    setSubmitting(true);
    setMessage("Checking sharing outcome…");
    void client.recoverTaskContentAccess(taskId, recovery, { signal: controller.signal })
      .then((result) => {
        if (scopeGeneration !== scopeGenerationRef.current) return;
        if (recoveryControllerRef.current === controller) recoveryControllerRef.current = null;
        setSubmitting(false);
        setMessage(outcomeMessage(result.outcome));
        // Never hide optimistically; reload the durable server projection.
        setRediscoveryGeneration((generation) => generation + 1);
      })
      .catch(() => {
        if (scopeGeneration !== scopeGenerationRef.current) return;
        if (recoveryControllerRef.current === controller) recoveryControllerRef.current = null;
        setSubmitting(false);
        setMessage("Sharing outcome is still unknown. Check again.");
        // The POST may have arrived. Keep the coordinate until a successful read says otherwise.
        setRediscoveryGeneration((generation) => generation + 1);
      });
  }, [client, recovery, submitting, taskId]);

  if (recovery === null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="task-content-access-recovery"
      className="rounded border border-border/70 bg-background px-2 py-1.5 text-xs text-foreground-muted"
    >
      <span>{message}</span>{" "}
      <button
        type="button"
        onClick={checkAndContinue}
        disabled={submitting}
        className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Check and continue
      </button>
    </div>
  );
}
