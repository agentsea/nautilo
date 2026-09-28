import {
  acceptProtectedTaskRunOutputBinding,
  and,
  eq,
  isNull,
  rooms,
  type DirectDatabase,
} from "@nautilo/db";
import type { ProtectedTaskOccurrence } from "@nautilo/runtime";

import type {
  ProtectedTaskRuntimeGrantPlanBuilderDependencies,
} from "./protected-task-runtime-grant-plan";

type OutputPorts = Pick<
  ProtectedTaskRuntimeGrantPlanBuilderDependencies,
  "resolveOutputDestination" | "acceptOutputBinding"
>;

/**
 * Read the current calling Room and accept its exact, content-free output
 * binding before a protected grant plan can be issued. The acceptance query
 * locks the Task, Run, policy and destination Room again; the first read only
 * supplies a candidate Namespace for the grant inventory.
 */
export function createProtectedTaskOutputBindingPorts(
  db: DirectDatabase,
): OutputPorts {
  return Object.freeze({
    async resolveOutputDestination(occurrence: ProtectedTaskOccurrence) {
      const roomId = occurrence.task.callingRoomId;
      if (roomId === null) return null;
      const candidates = await db.select({
        id: rooms.id,
        namespaceId: rooms.namespaceId,
      }).from(rooms).where(and(
        eq(rooms.id, roomId),
        isNull(rooms.archivedAt),
      )).limit(2);
      const room = candidates[0];
      if (candidates.length !== 1 || room === undefined) {
        throw new TypeError("Protected Task output Room is unavailable");
      }
      return Object.freeze({ roomId: room.id, namespaceId: room.namespaceId });
    },
    acceptOutputBinding: input =>
      acceptProtectedTaskRunOutputBinding(db, input),
  });
}
