import {
  normalizeTaskPresentationStatus,
  type TaskFundingFailureCode,
  type TaskFundingSource,
  type TaskPresentationStatus,
  type TaskRunTranscriptMessage,
} from "@nautilo/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversationEncryptionPolicyMode, useRunningSubagents } from "../../../adapters/runtime-contexts";
import { useAuth } from "../../../hooks/use-auth";
import { taskContentViewerScopeKey } from "./task-content-viewer-scope";
import {
  taskDetailToVMs,
  taskRunToVMs,
  type TranscriptMessageVM,
} from "./transcript-vm";
import { createWorkbenchDataOperationOwner } from
  "../../../lib/encryption-data-operation-policy";
import {
  createWorkbenchProtectedHumanTaskController,
  readWorkbenchTaskForViewer,
} from "../../../lib/protected-human-task-controller";
import { currentClientActionSessionIdForResume } from
  "../../../lib/client-action-session";

export interface UseSubagentTranscriptResult {
  readonly status: TaskPresentationStatus | null;
  readonly messages: TranscriptMessageVM[];
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly error: string | null;
  readonly fundingSource: TaskFundingSource | null;
  readonly fundingFailure: TaskFundingFailureCode | null;
}

interface TranscriptSnapshot {
  readonly requestKey: string;
  readonly status: TaskPresentationStatus | null;
  readonly messages: TranscriptMessageVM[];
  readonly protectedMessages: readonly TaskRunTranscriptMessage[] | null;
  readonly protectedAgentId: string | null;
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
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
  options?: { enabled?: boolean; taskRunId?: string | null },
): UseSubagentTranscriptResult {
  const enabled = taskId !== null && options?.enabled !== false;
  const requestedTaskRunId = options?.taskRunId ?? null;
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
  const actionSessionId = currentClientActionSessionIdForResume() ?? "";
  const scopeKey = `${taskContentViewerScopeKey({
    serverOrigin,
    viewerGeneration: auth.viewerGeneration,
    viewerId: auth.viewer.sessionUserId,
    actorId: auth.viewer.sessionActorId,
    viewerVerified: auth.viewer.isVerified,
    policyMode,
  })}\0${actionSessionId}`;

  const refreshKey = useMemo(() => {
    if (!taskId) return null;
    const entry = list.find((s) => s.taskId === taskId);
    if (!entry) return `${taskId}|`;
    return `${entry.status}|${entry.line3}|${entry.taskRunId ?? ""}|${requestedTaskRunId ?? ""}`;
  }, [list, requestedTaskRunId, taskId]);
  const requestKey = [scopeKey, taskId ?? "", requestedTaskRunId ?? ""]
    .join("\0");

  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>({
    requestKey, status: null, messages: [], protectedMessages: null,
    protectedAgentId: null, nextCursor: null, loading: false,
    loadingMore: false, error: null,
    fundingSource: null, fundingFailure: null,
  });
  const generationRef = useRef(0);
  const pageReadRef = useRef<string | null>(null);

  useEffect(() => {
    pageReadRef.current = null;
    if (!enabled || !taskId || !auth.viewer.isVerified) {
      setSnapshot({ requestKey, status: null, messages: [], protectedMessages: null,
        protectedAgentId: null, nextCursor: null, loading: false,
        loadingMore: false, error: null,
        fundingSource: null, fundingFailure: null });
      return;
    }

    const generation = ++generationRef.current;
    const actionSessionAtStart = currentClientActionSessionIdForResume() ?? "";
    const current = () => generation === generationRef.current
      && actionSessionAtStart === (currentClientActionSessionIdForResume() ?? "");
    setSnapshot((prior) => prior.requestKey === requestKey
      ? { ...prior, status: null, loading: true, loadingMore: false, error: null }
      : { requestKey, status: null, messages: [], protectedMessages: null,
          protectedAgentId: null, nextCursor: null, loading: true,
          loadingMore: false, error: null,
          fundingSource: null, fundingFailure: null });

    void readWorkbenchTaskForViewer({
      owner: protectedOwner,
      taskId,
      protectedController,
    }).then((read) => {
        if (!current()) return;
        if (read.representation === "protected") {
          const selectedRun = requestedTaskRunId === null
            ? undefined
            : read.runs.find((run) => run.id === requestedTaskRunId);
          if (selectedRun === undefined) {
            setSnapshot({
              requestKey,
              status: normalizeTaskPresentationStatus(read.opened.task.status),
              messages: [], protectedMessages: null, protectedAgentId: null,
              nextCursor: null, loading: false, loadingMore: false,
              error: requestedTaskRunId === null
                ? "Choose a stored run to open its protected transcript."
                : "The selected stored run is unavailable.",
              fundingSource: null,
              fundingFailure: read.opened.task.fundingFailure ?? null,
            });
            return;
          }
          const agentId = read.opened.task.agentId;
          if (agentId === null || agentId === undefined) {
            setSnapshot({
              requestKey,
              status: normalizeTaskPresentationStatus(read.opened.task.status),
              messages: [], protectedMessages: null, protectedAgentId: null,
              nextCursor: null, loading: false, loadingMore: false,
              error: "Protected Task transcript identity is unavailable.",
              fundingSource: selectedRun.fundingSource ?? null,
              fundingFailure: selectedRun.fundingFailure
                ?? read.opened.task.fundingFailure ?? null,
            });
            return;
          }
          if (protectedController === undefined) return;
          return protectedController.openTranscript({
            taskId,
            taskRunId: selectedRun.id,
            agentId,
          }).then((transcript) => {
            if (!current()) return;
            setSnapshot({
              requestKey,
              status: normalizeTaskPresentationStatus(read.opened.task.status),
              messages: transcript.status === "ready"
                ? taskRunToVMs(transcript.messages, selectedRun.id)
                : [],
              protectedMessages: transcript.status === "ready"
                ? transcript.messages : null,
              protectedAgentId: transcript.status === "ready" ? agentId : null,
              nextCursor: transcript.status === "ready"
                ? transcript.nextCursor : null,
              loading: false, loadingMore: false,
              error: transcript.status === "waiting"
                ? null
                : transcript.status === "unavailable"
                  ? "Protected Task transcript is unavailable on this device."
                  : null,
              fundingSource: selectedRun.fundingSource ?? null,
              fundingFailure: selectedRun.fundingFailure
                ?? read.opened.task.fundingFailure ?? null,
            });
          });
        }
        const detail = read.detail;
        const latestRun = detail.runs.at(-1);
        setSnapshot({
          requestKey,
          status: normalizeTaskPresentationStatus(detail.task.status),
          messages: taskDetailToVMs(detail), protectedMessages: null,
          protectedAgentId: null, nextCursor: null,
          loading: false, loadingMore: false, error: null,
          fundingSource: latestRun?.fundingSource ?? null,
          fundingFailure: latestRun?.fundingFailure ?? detail.task.fundingFailure ?? null,
        });
      }).catch((err: unknown) => {
        if (!current()) return;
        setSnapshot({
          requestKey, status: null, messages: [], protectedMessages: null,
          protectedAgentId: null, nextCursor: null,
          loading: false, loadingMore: false,
          error: err instanceof Error ? err.message : String(err),
          fundingSource: null, fundingFailure: null,
        });
      });

    return () => {
      generationRef.current += 1;
    };
  }, [enabled, taskId, refreshKey, scopeKey, auth.viewer.isVerified,
    protectedOwner,
    protectedController, requestKey, requestedTaskRunId]);

  const loadMore = useCallback(() => {
    if (taskId === null
      || requestedTaskRunId === null
      || protectedController === undefined
      || snapshot.requestKey !== requestKey
      || snapshot.protectedMessages === null
      || snapshot.protectedAgentId === null
      || snapshot.nextCursor === null
      || snapshot.loading
      || snapshot.loadingMore
      || pageReadRef.current !== null) return;
    const generation = generationRef.current;
    const actionSessionAtStart = currentClientActionSessionIdForResume() ?? "";
    const cursor = snapshot.nextCursor;
    const priorMessages = snapshot.protectedMessages;
    const agentId = snapshot.protectedAgentId;
    const pageReadKey = [String(generation), requestKey, cursor].join("\0");
    pageReadRef.current = pageReadKey;
    const releasePageRead = () => {
      if (pageReadRef.current === pageReadKey) pageReadRef.current = null;
    };
    const current = () => generation === generationRef.current
      && actionSessionAtStart === (currentClientActionSessionIdForResume() ?? "");
    const clearProtectedPage = (error: string | null): void => {
      setSnapshot((prior) => prior.requestKey === requestKey
        ? {
            ...prior,
            messages: [],
            protectedMessages: null,
            protectedAgentId: null,
            nextCursor: null,
            loading: false,
            loadingMore: false,
            error,
          }
        : prior);
    };
    setSnapshot((prior) => prior.requestKey === requestKey
      ? { ...prior, loadingMore: true, error: null }
      : prior);
    void protectedController.openTranscript({
      taskId,
      taskRunId: requestedTaskRunId,
      agentId,
      cursor,
    }).then((transcript) => {
      releasePageRead();
      if (!current()) {
        clearProtectedPage(null);
        return;
      }
      if (transcript.status !== "ready") {
        clearProtectedPage(transcript.status === "unavailable"
          ? "Protected Task transcript is unavailable on this device."
          : null);
        return;
      }
      setSnapshot((prior) => {
        if (prior.requestKey !== requestKey) return prior;
        const protectedMessages = Object.freeze([
          ...priorMessages,
          ...transcript.messages,
        ]);
        return {
          ...prior,
          messages: taskRunToVMs(protectedMessages, requestedTaskRunId),
          protectedMessages,
          nextCursor: transcript.nextCursor,
          loadingMore: false,
          error: null,
        };
      });
    }).catch((err: unknown) => {
      releasePageRead();
      clearProtectedPage(current()
        ? err instanceof Error ? err.message : String(err)
        : null);
    });
  }, [protectedController, requestKey, requestedTaskRunId, snapshot, taskId]);

  return snapshot.requestKey === requestKey && enabled && auth.viewer.isVerified
    ? { ...snapshot, hasMore: snapshot.nextCursor !== null, loadMore }
    : { messages: [], loading: false, loadingMore: false, hasMore: false,
        loadMore: () => undefined, error: null, status: null,
        fundingSource: null, fundingFailure: null };
}
