import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { TaskOperationRunResultReadV1 } from "@nautilo/types";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";

import {
  readWorkbenchTaskRunResultForViewer,
  type WorkbenchProtectedHumanTaskController,
} from "../../../lib/protected-human-task-controller";

type ResultSnapshot =
  | Readonly<{ requestKey: string; state: "loading" }>
  | Readonly<{
      requestKey: string;
      state: "resolved";
      result: TaskOperationRunResultReadV1;
    }>
  | Readonly<{ requestKey: string; state: "error" }>;

export function protectedTaskRunResultRequestKey(input: Readonly<{
  scopeKey: string;
  taskId: string;
  taskRunId: string;
  agentId: string;
}>): string {
  return [input.scopeKey, input.taskId, input.taskRunId, input.agentId]
    .join("\0");
}

function unavailableMessage(
  reason: Extract<TaskOperationRunResultReadV1, { status: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "result_not_protected":
      return "This Task run does not have a protected result.";
    case "authority_changed":
      return "Your access to this protected result changed. Refresh device access and try again.";
    case "unsupported_crypto_access_revision":
      return "This protected result requires a newer Nautilo client.";
    case "integrity_failure":
      return "This protected result could not be verified.";
  }
}

function ResultBody({ result }: {
  readonly result: TaskOperationRunResultReadV1;
}): ReactElement {
  if (result.status === "waiting") {
    return <p role="status">The protected result is still being prepared.</p>;
  }
  if (result.status === "unavailable") {
    return <p role="status">{unavailableMessage(result.reason)}</p>;
  }
  return (
    <div className="space-y-1">
      <p className="font-medium text-foreground">Protected result</p>
      {result.payload.resultText !== null ? (
        <p className="whitespace-pre-wrap break-words">{result.payload.resultText}</p>
      ) : null}
      {result.payload.lastError !== null ? (
        <p className="whitespace-pre-wrap break-words text-[var(--error)]">
          {result.payload.lastError}
        </p>
      ) : null}
    </div>
  );
}

/** Viewer-bound presentation of one exact protected TaskRun result. */
export function ProtectedTaskRunResult({
  agentId,
  controller,
  owner,
  refreshToken,
  scopeKey,
  taskId,
  taskRunId,
}: Readonly<{
  agentId: string | null | undefined;
  controller: WorkbenchProtectedHumanTaskController | undefined;
  owner: EncryptionDataOperationOwner;
  refreshToken?: string | number | null;
  scopeKey: string;
  taskId: string;
  taskRunId: string | null | undefined;
}>): ReactElement | null {
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestKey = useMemo(() => taskRunId && agentId
    ? protectedTaskRunResultRequestKey({ scopeKey, taskId, taskRunId, agentId })
    : null, [agentId, scopeKey, taskId, taskRunId]);
  const [snapshot, setSnapshot] = useState<ResultSnapshot | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setSnapshot(null);
    if (requestKey === null
      || taskRunId === null || taskRunId === undefined
      || agentId === null || agentId === undefined) return;
    setSnapshot({ requestKey, state: "loading" });
    void readWorkbenchTaskRunResultForViewer({
      owner,
      taskId,
      taskRunId,
      agentId,
      protectedController: controller,
    }).then((read) => {
      if (generation !== generationRef.current) return;
      if (read.representation !== "protected") {
        setSnapshot({ requestKey, state: "error" });
        return;
      }
      setSnapshot({ requestKey, state: "resolved", result: read.result });
    }).catch(() => {
      if (generation !== generationRef.current) return;
      setSnapshot({ requestKey, state: "error" });
    });
    return () => { generationRef.current += 1; };
  }, [agentId, controller, owner, refreshToken, requestKey, retryGeneration,
    taskId, taskRunId]);

  if (taskRunId === null || taskRunId === undefined) {
    return null;
  }
  if (agentId === null || agentId === undefined) {
    return (
      <div className="rounded bg-background px-2 py-1.5 text-xs text-foreground-muted"
        data-testid="protected-task-run-result">
        <p role="status">The protected result identity is unavailable.</p>
      </div>
    );
  }
  const current = snapshot?.requestKey === requestKey ? snapshot : null;
  return (
    <div className="rounded bg-background px-2 py-1.5 text-xs text-foreground-muted"
      data-testid="protected-task-run-result">
      {current?.state === "loading" || current === null ? (
        <p role="status">Opening protected result…</p>
      ) : current.state === "error" ? (
        <div className="space-y-1">
          <p role="alert">The protected result is unavailable on this device.</p>
          <button type="button" className="font-medium text-primary"
            onClick={() => setRetryGeneration((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <ResultBody result={current.result} />
      )}
    </div>
  );
}
