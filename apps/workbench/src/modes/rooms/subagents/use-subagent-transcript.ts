import { normalizeTaskPresentationStatus, type TaskPresentationStatus } from "@nautilo/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRunningSubagents } from "../../../adapters/runtime-contexts";
import { apiClient } from "../../../lib/api";
import { taskDetailToVMs, type TranscriptMessageVM } from "./transcript-vm";

export interface UseSubagentTranscriptResult {
  readonly status: TaskPresentationStatus | null;
  readonly messages: TranscriptMessageVM[];
  readonly loading: boolean;
  readonly error: string | null;
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

  const refreshKey = useMemo(() => {
    if (!taskId) return null;
    const entry = list.find((s) => s.taskId === taskId);
    if (!entry) return `${taskId}|`;
    return `${entry.status}|${entry.line3}|${entry.taskRunId ?? ""}`;
  }, [list, taskId]);

  const [status, setStatus] = useState<TaskPresentationStatus | null>(null);
  const [messages, setMessages] = useState<TranscriptMessageVM[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled || !taskId) {
      setMessages([]);
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }

    const generation = ++generationRef.current;
    setLoading(true);
    setStatus(null);
    setError(null);

    void apiClient
      .getTask(taskId)
      .then((detail) => {
        if (generation !== generationRef.current) return;
        setStatus(normalizeTaskPresentationStatus(detail.task.status));
        setMessages(taskDetailToVMs(detail));
        setError(null);
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        setMessages([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        setLoading(false);
      });

    return () => {
      generationRef.current += 1;
    };
  }, [enabled, taskId, refreshKey]);

  return { messages, loading, error, status };
}
