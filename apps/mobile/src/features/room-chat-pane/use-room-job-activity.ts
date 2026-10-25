import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@nautilo/types";
import { roomIdFromLaneKey } from "@/lib/messages";

type Binding = { key: string | null };
const EMPTY: ReadonlySet<string> = new Set();

/** Recover missed job lifecycle events from server truth after mobile resumes. */
export function useRoomJobActivity({
  scopeKey, roomId, active, recoveryRevision, subscribe, getActiveJobs,
}: {
  scopeKey: string | null;
  roomId: string | null;
  active: boolean;
  recoveryRevision: number;
  subscribe: (handler: (event: ServerEvent) => void) => () => void;
  getActiveJobs: () => Promise<{ jobIds: string[] }>;
}): ReadonlySet<string> {
  const bindingRef = useRef<Binding>({ key: scopeKey });
  if (bindingRef.current.key !== scopeKey) bindingRef.current = { key: scopeKey };
  const binding = bindingRef.current;
  const [snapshot, setSnapshot] = useState({ binding, ids: EMPTY });
  const pendingRef = useRef<{
    binding: Binding;
    changes: Map<string, boolean>;
  } | null>(null);

  useEffect(() => {
    if (!scopeKey || !roomId) return;
    return subscribe(event => {
      if (bindingRef.current !== binding) return;
      if (event.type !== "job.dispatched" && event.type !== "job.status") return;
      const eventRoom = roomIdFromLaneKey(event.laneKey);
      const terminal = event.type === "job.status" &&
        (event.status === "completed" || event.status === "failed" ||
          event.status === "timed_out" || event.status === "cancelled");
      // Older terminal events may omit their lane; their exact job ID still
      // retires a tracked job. Never admit an unscoped job as running.
      if (eventRoom !== roomId && !(terminal && eventRoom === null)) return;
      const live = !terminal;
      if (pendingRef.current?.binding === binding) {
        pendingRef.current.changes.set(event.jobId, live);
      }
      setSnapshot(previous => {
        const ids = new Set(previous.binding === binding ? previous.ids : EMPTY);
        if (live) ids.add(event.jobId);
        else ids.delete(event.jobId);
        return { binding, ids };
      });
    });
  }, [binding, roomId, scopeKey, subscribe]);

  useEffect(() => {
    if (!scopeKey || !roomId || !active) return;
    const request = { binding, changes: new Map<string, boolean>() };
    pendingRef.current = request;
    let cancelled = false;
    void (async () => {
      try {
        const { jobIds } = await getActiveJobs();
        if (cancelled || bindingRef.current !== binding) return;
        const ids = new Set(jobIds);
        // Events received during the HTTP request are newer than its
        // snapshot: retain new jobs and do not resurrect completed ones.
        for (const [id, live] of request.changes) {
          if (live) ids.add(id);
          else ids.delete(id);
        }
        setSnapshot({ binding, ids });
      } catch {
        // An unavailable snapshot is not proof that active work has stopped.
      } finally {
        if (pendingRef.current === request) pendingRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
      if (pendingRef.current === request) pendingRef.current = null;
    };
  }, [active, binding, getActiveJobs, recoveryRevision, roomId, scopeKey]);

  return snapshot.binding === binding ? snapshot.ids : EMPTY;
}
