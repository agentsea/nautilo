import {
  normalizeTaskPresentationStatus,
  type TaskFundingFailureCode,
  type TaskFundingSource,
  type TaskPresentationStatus,
} from "@nautilo/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConversationEncryptionPolicyMode, useRunningSubagents } from "../../../adapters/runtime-contexts";
import { useAuth } from "../../../hooks/use-auth";
import { taskContentViewerScopeKey } from "./task-content-viewer-scope";
import { taskDetailToVMs, type TranscriptMessageVM } from "./transcript-vm";
import { createWorkbenchDataOperationOwner } from
  "../../../lib/encryption-data-operation-policy";
import {
  createWorkbenchProtectedHumanTaskController,
  readWorkbenchTaskForViewer,
} from "../../../lib/protected-human-task-controller";

export interface UseSubagentTranscriptResult {
  readonly status: TaskPresentationStatus | null;
  readonly messages: TranscriptMessageVM[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly fundingSource: TaskFundingSource | null;
  readonly fundingFailure: TaskFundingFailureCode | null;
}

interface TranscriptSnapshot {
  readonly scopeKey: string;
  readonly taskId: string | null;
  readonly status: TaskPresentationStatus | null;
  readonly messages: TranscriptMessageVM[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly fundingSource: TaskFundingSource | null;
  readonly fundingFailure: TaskFundingFailureCode | null;
}

/**
 * Fetch and map a subagent task transcript. Re-fetches when the dock card's
 * live snapshot (`status` / `line3` / `taskRunId`) ticks via WS-fed state.
 */
export function useSubagentTranscript(
  taskId: string | null,
  options?: { enabled?: boolean },
): UseSubagentTranscriptResult {
  const enabled = taskId !== null && options?.enabled !== false;
  const { list } = useRunningSubagents();
  const auth = useAuth();
  const policyMode = useConversationEncryptionPolicyMode();
  const serverOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const protectedOwner = useMemo(() => createWorkbenchDataOperationOwner(), []);
  const protectedController = useMemo(() => {
    if (
      policyMode === "plaintext_only"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null
      || serverOrigin.length === 0
    ) return undefined;
    return createWorkbenchProtectedHumanTaskController({
      owner: protectedOwner,
      serverScope: serverOrigin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
  }, [auth.viewer.isVerified, auth.viewer.sessionActorId,
    auth.viewer.sessionUserId, policyMode, protectedOwner, serverOrigin]);
  const scopeKey = taskContentViewerScopeKey({
    serverOrigin,
    viewerGeneration: auth.viewerGeneration,
    viewerId: auth.viewer.sessionUserId,
    actorId: auth.viewer.sessionActorId,
    viewerVerified: auth.viewer.isVerified,
    policyMode,
  });

  const refreshKey = useMemo(() => {
    if (!taskId) return null;
    const entry = list.find((s) => s.taskId === taskId);
    if (!entry) return `${taskId}|`;
    return `${entry.status}|${entry.line3}|${entry.taskRunId ?? ""}`;
  }, [list, taskId]);

  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>({
    scopeKey, taskId, status: null, messages: [], loading: false, error: null,
    fundingSource: null, fundingFailure: null,
  });
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled || !taskId || !auth.viewer.isVerified) {
      setSnapshot({ scopeKey, taskId, status: null, messages: [], loading: false, error: null,
        fundingSource: null, fundingFailure: null });
      return;
    }

    const generation = ++generationRef.current;
    setSnapshot((prior) => prior.scopeKey === scopeKey && prior.taskId === taskId
      ? { ...prior, status: null, loading: true, error: null }
      : { scopeKey, taskId, status: null, messages: [], loading: true, error: null,
          fundingSource: null, fundingFailure: null });

    void readWorkbenchTaskForViewer({
      mode: policyMode,
      taskId,
      protectedController,
    }).then((read) => {
        if (generation !== generationRef.current) return;
        if (read.representation === "protected") {
          setSnapshot({
            scopeKey, taskId,
            status: normalizeTaskPresentationStatus(read.opened.task.status),
            messages: [], loading: false,
            error: "Protected Task run transcripts are not available yet.",
            fundingSource: null,
            fundingFailure: read.opened.task.fundingFailure ?? null,
          });
          return;
        }
        const detail = read.detail;
        const latestRun = detail.runs.at(-1);
        setSnapshot({
          scopeKey, taskId,
          status: normalizeTaskPresentationStatus(detail.task.status),
          messages: taskDetailToVMs(detail), loading: false, error: null,
          fundingSource: latestRun?.fundingSource ?? null,
          fundingFailure: latestRun?.fundingFailure ?? detail.task.fundingFailure ?? null,
        });
      }).catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        setSnapshot({
          scopeKey, taskId, status: null, messages: [], loading: false,
          error: err instanceof Error ? err.message : String(err),
          fundingSource: null, fundingFailure: null,
        });
      });

    return () => {
      generationRef.current += 1;
    };
  }, [enabled, taskId, refreshKey, scopeKey, auth.viewer.isVerified, policyMode,
    protectedController]);

  return snapshot.scopeKey === scopeKey && snapshot.taskId === taskId && enabled && auth.viewer.isVerified
    ? snapshot
    : { messages: [], loading: false, error: null, status: null,
        fundingSource: null, fundingFailure: null };
}
