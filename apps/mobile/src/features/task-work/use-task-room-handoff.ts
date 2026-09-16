import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { getApiClient } from "@/lib/api";

import { type TaskDetailTarget } from "./task-detail-state";
import {
  createTaskRoomHandoffController,
  sameTaskRoomHandoffTarget,
  taskRoomHandoffTarget,
  type TaskRoomHandoffApi,
  type TaskRoomHandoffTarget,
} from "./task-room-handoff";

/** Thin React binding; the controller remains the only Room preflight owner. */
export function useTaskRoomHandoff({
  detailTarget,
  taskStatus,
  targetRoomId,
  attentionPending,
  server,
}: {
  readonly detailTarget: TaskDetailTarget | null;
  readonly taskStatus: string | null;
  readonly targetRoomId: string | null | undefined;
  readonly attentionPending: boolean;
  readonly server: { readonly id: string; readonly serverUrl: string } | null;
}) {
  const controllerRef = useRef(createTaskRoomHandoffController());
  const controller = controllerRef.current;
  const target = useMemo(() => taskRoomHandoffTarget({ detailTarget, taskStatus, targetRoomId, attentionPending }), [attentionPending, detailTarget, targetRoomId, taskStatus]);
  // Effects are intentionally too late for a route/server/viewer change that
  // lands while the press preflight is awaiting. Keep the rendered target in a
  // ref so the final navigation check is synchronous with that render.
  const currentTargetRef = useRef(target);
  currentTargetRef.current = target;
  const api = useMemo<TaskRoomHandoffApi>(() => ({
    async getRoom(requestTarget) {
      if (!server || server.id !== requestTarget.serverId || server.serverUrl !== requestTarget.serverUrl) {
        throw new Error("Active server changed.");
      }
      const client = getApiClient(requestTarget.serverUrl);
      // Keep only the ID from the member response. Labels, roster, and other
      // Room content must never reach Task-detail state.
      const room = await client.getRoom(requestTarget.targetRoomId);
      return { id: room.id };
    },
    async whoami(requestTarget) {
      if (!server || server.id !== requestTarget.serverId || server.serverUrl !== requestTarget.serverUrl) {
        throw new Error("Active server changed.");
      }
      const client = getApiClient(requestTarget.serverUrl);
      const whoami = await client.whoami();
      return {
        sessionUserId: whoami.sessionUserId,
        sessionActorId: whoami.sessionActorId,
      };
    },
  }), [server]);
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const visible = sameTaskRoomHandoffTarget(snapshot.target, target) ? snapshot : { target, phase: "idle" as const, error: null };

  useEffect(() => {
    controller.setTarget(target);
    if (target) void controller.authorize(api);
  }, [api, controller, target]);
  useEffect(() => () => controller.dispose(), [controller]);

  return {
    authorized: visible.phase === "authorized",
    opening: visible.phase === "opening",
    error: visible.error,
    open: useCallback(async () => {
      const result = await controller.open(api);
      return result.status === "navigate" && !sameTaskRoomHandoffTarget(result.target, currentTargetRef.current)
        ? { status: "ignored" as const }
        : result;
    }, [api, controller]),
    mayNavigate: useCallback((candidate: TaskRoomHandoffTarget) =>
      sameTaskRoomHandoffTarget(candidate, currentTargetRef.current) && controller.mayNavigate(candidate),
    [controller]),
    reportNavigationFailure: useCallback(() => controller.reportNavigationFailure(), [controller]),
  };
}
