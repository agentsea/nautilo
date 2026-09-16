import type { FastifyInstance } from "fastify";
import type {
  CreateBackgroundJobRequest,
  CreateBackgroundJobResponse,
  JobStatusResponse,
  JobStopResponse,
  RoomStopResponse,
  RoomActiveJobsResponse,
} from "@nautilo/types";
import {
  createMaintenanceAcceptanceAuthority,
  getMaintenanceGate,
  jobManager,
} from "@nautilo/runtime";
import { getJobById } from "@nautilo/db";
import {
  createAcceptedInvocationAuthority,
  getRoomDetailForMember,
  isUuidString,
} from "@nautilo/trust";
import { operatorReleaseRoutes } from "./operator-release";
import {
  isMaintenanceDrainError,
  replyMaintenanceRejection,
} from "../lib/maintenance-rejection";
import {
  requireAgentInvocation,
  type AssertCanInvokeAgent,
} from "../lib/agent-invocation-admission";

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function jobRoutes(
  app: FastifyInstance,
  deps: {
    readonly assertCanInvokeAgent?: AssertCanInvokeAgent;
    /** Stops pending/paused Tasks that have no active Job to discover yet. */
    readonly stopTasksForRoom?: (ownerId: string, roomId: string) => Promise<number>;
  } = {},
) {
  operatorReleaseRoutes(app);

  app.post<{ Body: CreateBackgroundJobRequest }>(
    "/api/jobs",
    async (request, reply) => {
      const { task } = request.body;
      const ownerId =
        request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
      if (!ownerId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      if (!(await requireAgentInvocation(
        { humanUserId: ownerId, origin: "background_job" },
        reply,
        deps.assertCanInvokeAgent,
      ))) return;

      // D420 (Wave 2 task 2.2.1) — reject NEW external background jobs while
      // the durable maintenance state is active. `createBackgroundJob` throws
      // `MaintenanceDrainError` before the Job row is persisted; render the
      // typed retryable 503 so a caller can re-send once maintenance clears.
      let job;
      try {
        await getMaintenanceGate().assertAcceptingNewWork();
        const maintenanceAuthority = createMaintenanceAcceptanceAuthority();
        const invocationAuthority = createAcceptedInvocationAuthority(ownerId);
        job = await jobManager.createBackgroundJob(ownerId, ownerId, {
          task,
        }, maintenanceAuthority, invocationAuthority);
      } catch (err) {
        if (isMaintenanceDrainError(err)) return replyMaintenanceRejection(reply, err);
        throw err;
      }

      const response: CreateBackgroundJobResponse = {
        jobId: job.id,
        accepted: true,
      };
      return reply.status(202).send(response);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id",
    async (request, reply) => {
      const sessionUserId =
        request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
      if (!sessionUserId) {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const job = await getJobById(request.params.id);
      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }
      if (job.ownerId !== sessionUserId) {
        return reply.status(404).send({ error: "Job not found" });
      }

      const response: JobStatusResponse = {
        id: job.id,
        type: job.type,
        status: job.status,
        message: job.message,
        input: job.input,
        result: job.result,
        createdAt: toIso(job.createdAt) ?? new Date(0).toISOString(),
        startedAt: toIso(job.startedAt),
        completedAt: toIso(job.completedAt),
      };
      return reply.send(response);
    }
  );

  // M147 (R8b) — the single general "stop any live job by id". Covers an
  // ordinary foreground chat turn (D13b stop-mid-turn), an M085 fork, a task
  // run, and a background job — all live in `jobManager.active` keyed by
  // `jobId`. Owner-only, mirroring `GET /api/jobs/:id`: 401 when no subject,
  // 404 (not 403) when the persisted `jobs.owner_id` (= the authenticated
  // human / requestorId, M077) belongs to another owner — don't leak existence.
  // `abortJob` returns `false` for an already-terminal / unknown-live id; that
  // is still a 200 with `{ stopped: false }`. The aborted job emits its own
  // room-scoped `job.status:cancelled` — no new event needed.
  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/stop",
    async (request, reply) => {
      const sessionUserId =
        request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
      if (!sessionUserId) {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const job = await getJobById(request.params.id);
      if (!job || job.ownerId !== sessionUserId) {
        return reply.status(404).send({ error: "Job not found" });
      }

      const stopped = jobManager.abortJob(request.params.id);
      const response: JobStopResponse = { stopped };
      return reply.send(response);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/rooms/:id/stop",
    async (request, reply) => {
      const sessionUserId =
        request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
      const actorId = request.sessionActorId;
      if (!sessionUserId || !actorId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const roomId = request.params.id;
      if (!isUuidString(roomId)) {
        return reply.status(400).send({ error: "invalid room id" });
      }
      const detail = await getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.status(404).send({ error: "Room not found" });
      }

      // D420 (Wave 2 task 2.2.3) — `stopRoom` is awaitable: it durably
      // terminalizes the discarded queued/buffered acceptances as
      // `user_cancelled` before resolving. The caller must not receive success
      // before that durable outcome completes; a terminalization failure fails
      // loudly (500) instead of returning a misleading `stopped` result.
      let result;
      let stoppedTasks = 0;
      try {
        result = await jobManager.stopRoom(roomId);
        stoppedTasks = await deps.stopTasksForRoom?.(sessionUserId, roomId) ?? 0;
      } catch (err) {
        request.log.error(
          {
            err:
              err instanceof Error
                ? { message: err.message, name: err.name }
                : String(err),
          },
          "room stop durable terminalization failed",
        );
        return reply.code(500).send({ error: "Stop terminalization failed" });
      }
      const response: RoomStopResponse = {
        stopped:
          result.stoppedJobs > 0 ||
          result.droppedQueuedTurns > 0 ||
          result.droppedBufferedLanes > 0 ||
          stoppedTasks > 0,
        ...result,
        stoppedTasks,
      };
      return reply.send(response);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/rooms/:id/active-jobs",
    async (request, reply) => {
      const sessionUserId =
        request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
      const actorId = request.sessionActorId;
      if (!sessionUserId || !actorId) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const roomId = request.params.id;
      if (!isUuidString(roomId)) {
        return reply.status(400).send({ error: "invalid room id" });
      }
      const detail = await getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.status(404).send({ error: "Room not found" });
      }
      const response: RoomActiveJobsResponse = {
        jobIds: jobManager.getActiveJobIdsForRoom(roomId),
      };
      return reply.send(response);
    }
  );
}
