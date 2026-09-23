import { readTaskPreparation } from "@nautilo/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ListTasksQuery,
  TaskCreatePayload,
  TaskCreateResponse,
  TaskDetail,
  TaskLifecycleResponse,
  TaskRunSummary,
  TaskSummary,
  TaskUpdatePayload,
  ServerEvent,
} from "@nautilo/types";
import {
  createTask as runtimeCreateTask,
  createHumanApiTaskCreationProvenance,
  computeNextFireAt,
  getPlaintextTaskCreationAdmission,
  jobManager,
  pauseTask,
  unpauseTask,
  canResumeSecurityResearchContextFailure,
  stopTask,
  replayTaskInterruptEvents,
  type TaskCreateInput,
  type TaskLifecycleResult,
} from "@nautilo/runtime";
import {
  and,
  eq,
  getTaskById,
  getTaskRuns,
  getLatestRunModelByTask,
  listTasksForOwner,
  listAwaitingTaskRunsForOwner,
  profiles,
  updateTask,
  type NewTask,
  getOwnerAgentDisplayNamesByAgentId,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import {
  rejectNotYetWiredTaskParams,
  validateTaskModelSelectionForCreate,
  getRunAgentTranscript,
} from "@nautilo/agent";
import { getServerDirectDb } from "../lib/server-direct-db";
import { requireAgentInvocation } from "../lib/agent-invocation-admission";
import { createAcceptedInvocationAuthority, isUuidString } from "@nautilo/trust";
import { SHELL_AVATAR_REF } from "@nautilo/types";
import { sendAvatar, setMediaCacheHeaders } from "./_helpers/avatar";

interface TasksRoutesDeps {
  /** The live TaskObserver — kicked for `now` tasks (mirrors app.ts wiring). */
  observer: { kick(): void };
  /** Exact native custody hook; resolves only after a locally owned Stop is contained. */
  prepareStopTask?: (taskId: string) => Promise<boolean>;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseRunAt(runAt: string | undefined): Date | undefined {
  if (runAt === undefined) return undefined;
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`run_at is not a valid ISO timestamp: "${runAt}"`);
  }
  return d;
}

function toolsFields(
  tools: string[] | undefined,
): Pick<NewTask, "toolsMode" | "toolsWhitelist"> | Record<string, never> {
  if (tools === undefined) return {};
  if (tools.length === 0) return { toolsMode: "none", toolsWhitelist: [] };
  return { toolsMode: "whitelist", toolsWhitelist: tools };
}

type TaskSummarySource = Pick<
  Task,
  | "id"
  | "parentTaskId"
  | "depth"
  | "status"
  | "preset"
  | "metadata"
  | "prompt"
  | "scheduleKind"
  | "cron"
  | "nextFireAt"
  | "callingRoomId"
  | "lastError"
>;
type TaskSummarySourceWithTiming = TaskSummarySource & {
  updatedAt?: Task["updatedAt"];
};

export function toTaskSummary(task: TaskSummarySourceWithTiming): TaskSummary {
  return {
    id: task.id,
    parentTaskId: task.parentTaskId,
    depth: task.depth,
    status: task.status,
    preset: task.preset,
    harnessId: taskHarnessId(task.metadata),
    ...(readTaskPreparation(task.metadata?.["preparation"]) ? { preparation: readTaskPreparation(task.metadata?.["preparation"])! } : {}),
    prompt: task.prompt.slice(0, 80),
    scheduleKind: task.scheduleKind,
    cron: task.cron,
    nextFireAt: toIso(task.nextFireAt),
    callingRoomId: task.callingRoomId,
    lastError: task.lastError,
    ...(task.updatedAt !== undefined ? { updatedAt: task.updatedAt.toISOString() } : {}),
  };
}

/**
 * The owner-visible shape used by both the bounded list and exact reader.
 * Keep identity enrichment server-authored: a route locator or stale list row
 * must never supply the responsible Genie name for a Task detail surface.
 */
export function toOwnerVisibleTaskSummary(
  task: TaskSummarySourceWithTiming & Pick<Task, "agentId" | "targetRoomId" | "createdAt" | "requestedModelId">,
  enrichment: { readonly agentName: string | null; readonly lastModelId: string | null; readonly canResumeResearch?: boolean },
): TaskSummary {
  return {
    ...toTaskSummary(task),
    ...(enrichment.canResumeResearch === true ? { canResumeResearch: true } : {}),
    agentId: task.agentId,
    agentName: enrichment.agentName,
    targetRoomId: task.targetRoomId,
    ...(toIso(task.createdAt) ? { createdAt: toIso(task.createdAt)! } : {}),
    requestedModelId: task.requestedModelId,
    lastModelId: enrichment.lastModelId,
  };
}

function taskHarnessId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const execution = (metadata as Record<string, unknown>)["execution"];
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return null;
  const harnessId = (execution as Record<string, unknown>)["harnessId"];
  return typeof harnessId === "string" && harnessId.length > 0 && harnessId.length <= 64
    ? harnessId
    : null;
}

export function tasksRoutes(app: FastifyInstance, deps: TasksRoutesDeps) {
  app.post<{ Body: TaskCreatePayload }>("/api/tasks", async (request, reply) => {
    const ownerId =
      request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!ownerId) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const agentId = request.memoryEnvelope?.agentId ?? "";
    if (!agentId) {
      return reply
        .status(400)
        .send({ error: "no_agent_in_context", message: "No agent in context." });
    }

    const body = request.body ?? ({} as TaskCreatePayload);
    if (!body.prompt) {
      return reply.status(400).send({ error: "'prompt' is required." });
    }
    const reject = rejectNotYetWiredTaskParams(
      body as unknown as Record<string, unknown>,
    );
    if (reject) {
      return reply.status(400).send({ error: reject });
    }

    // D429 Phase 3 / M152 — create-time model-selection guard. The combined
    // validator owns the exact `requestedModelId` pin (curated IDs, capability
    // truth, mutual-exclusion conflict) and the M152 profile/spec bias.
    // Unsatisfiable → 422 with the actionable message + structured detail.
    const toolsFieldsForValidation = toolsFields(body.tools);
    const selectionError = validateTaskModelSelectionForCreate({
      requestedModelId: body.requestedModelId,
      profile: body.selectionProfile,
      spec: body.selectionSpec,
      toolsMode: toolsFieldsForValidation.toolsMode,
      toolsWhitelist: toolsFieldsForValidation.toolsWhitelist,
    });
    if (selectionError) {
      return reply
        .status(422)
        .send({ error: selectionError, detail: { message: selectionError } });
    }

    let runAt: Date | undefined;
    try {
      runAt = parseRunAt(body.runAt);
    } catch (err) {
      return reply
        .status(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }

    const scheduleKind = body.scheduleKind ?? "now";

    let depth = 0;
    if (body.parentTaskId) {
      const parent = await getTaskById(getServerDirectDb(), body.parentTaskId);
      if (!parent || parent.ownerId !== ownerId) {
        return reply.status(404).send({ error: "Parent task not found" });
      }
      depth = parent.depth + 1;
    }

    if (
      !(await requireAgentInvocation(
        { humanUserId: ownerId, origin: "task_create", agentId },
        reply,
      ))
    ) {
      return;
    }

    const input: TaskCreateInput = {
      ownerId,
      requestorId: ownerId,
      agentId,
      prompt: body.prompt,
      ...(body.expectedOutput !== undefined
        ? { expectedOutput: body.expectedOutput }
        : {}),
      scheduleKind,
      ...(runAt !== undefined ? { runAt } : {}),
      ...(body.cron !== undefined ? { cron: body.cron } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      targetChat: body.targetChat ?? "orphan",
      resultDelivery: body.resultDelivery ?? "wake",
      useScope: body.useScope ?? false,
      ...(body.scopeId !== undefined ? { scopeId: body.scopeId } : {}),
      ...(body.parentTaskId !== undefined
        ? { parentTaskId: body.parentTaskId }
        : {}),
      ...(body.timeLimitSeconds !== undefined
        ? { timeLimitSeconds: body.timeLimitSeconds }
        : {}),
      ...(body.selectionProfile !== undefined
        ? { selectionProfile: body.selectionProfile }
        : {}),
      ...(body.selectionSpec !== undefined
        ? { selectionSpec: body.selectionSpec }
        : {}),
      ...(body.requestedModelId !== undefined
        ? { requestedModelId: body.requestedModelId }
        : {}),
      preset: "task",
      depth,
      ...toolsFields(body.tools),
    };

    let result: { taskId: string; status: string; nextFireAt: Date | undefined };
    try {
      result = await runtimeCreateTask(
        {
          db: getServerDirectDb(),
          observer: deps.observer,
          invocationAuthority: createAcceptedInvocationAuthority(ownerId),
          provenance: createHumanApiTaskCreationProvenance({
            ownerId,
            requestedParentTaskId: body.parentTaskId ?? null,
          }),
          admission: getPlaintextTaskCreationAdmission(),
        },
        input,
      );
    } catch (err) {
      return reply
        .status(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }

    const response: TaskCreateResponse = {
      taskId: result.taskId,
      status: result.status,
      nextFireAt: toIso(result.nextFireAt),
    };
    return reply.status(201).send(response);
  });

  app.get<{ Querystring: ListTasksQuery }>("/api/tasks", async (request, reply) => {
    const ownerId =
      request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!ownerId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const { status, includeTerminal, recentTerminalLimit } = request.query;
    // Push status to the store (exact-status filter, precedence over
    // includeTerminal). Passing `{}` for a status query would make the store
    // EXCLUDE terminal rows, so `?status=completed` always returned [].
    const requestedTerminalLimit = Number(recentTerminalLimit);
    const terminalLimit = Number.isFinite(requestedTerminalLimit)
      ? requestedTerminalLimit
      : undefined;
    const isTerminalStatus = status === "completed" || status === "cancelled" || status === "errored";
    const opts = status
      ? {
          status: status as NonNullable<NewTask["status"]>,
          // A terminal status never becomes an unbounded HTTP history scan.
          ...(isTerminalStatus
            ? {
                includeRecentTerminal: true,
                ...(terminalLimit !== undefined ? { recentTerminalLimit: terminalLimit } : {}),
              }
            : {}),
        }
      : {
          includeTerminal: includeTerminal === true || String(includeTerminal) === "true",
          // Terminal history stays opt-in, but gets the Mobile default whenever
          // it is requested without an explicit size.
          ...(includeTerminal === true || String(includeTerminal) === "true"
            ? {
                includeRecentTerminal: true,
                ...(terminalLimit !== undefined ? { recentTerminalLimit: terminalLimit } : {}),
              }
            : {}),
        };
    const db = getServerDirectDb();
    const tasks = await listTasksForOwner(db, ownerId, opts);
    const taskIds = tasks.map((t) => t.id);
    const agentIds = tasks.map((t) => t.agentId);
    const [lastModels, agentNames] = await Promise.all([
      getLatestRunModelByTask(db, taskIds),
      getOwnerAgentDisplayNamesByAgentId(db, ownerId, agentIds),
    ]);
    return reply.send(
      await Promise.all(tasks.map(async (t) => toOwnerVisibleTaskSummary(t, {
        agentName: agentNames.get(t.agentId) ?? null,
        lastModelId: lastModels.get(t.id) ?? null,
        canResumeResearch: await canResumeSecurityResearchContextFailure(db, t),
      }))),
    );
  });

  /**
   * Re-project owner-private approval interrupts for Tasks that are still
   * canonically awaiting. The checkpoint is the authority; this endpoint
   * persists no parallel approval state and returns nothing for terminal or
   * superseded runs.
   */
  app.get("/api/tasks/pending-attention", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Vary", "Authorization");
    const ownerId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!ownerId) return reply.status(401).send({ error: "Authentication required" });

    const parked = await listAwaitingTaskRunsForOwner(getServerDirectDb(), ownerId);
    const projected = await Promise.all(parked.map(async ({ task, run }) => {
      try {
        return await replayTaskInterruptEvents({
          taskId: task.id,
          taskRunId: run.id,
          ownerId: task.ownerId,
          graphThreadId: run.graphThreadId,
          laneKey: `task:${task.id}`,
          hasRoom: task.targetRoomId !== null,
        });
      } catch {
        return [] as ServerEvent[];
      }
    }));
    return reply.send(projected.flat());
  });

  /**
   * D547 — serve the exact Genie's avatar for an owner-visible Task. This
   * intentionally resolves through both the Task's owner and agent ID: a
   * Task can be orphaned from a Room, but it must never borrow another owned
   * Genie's profile just because that profile happens to be available.
  */
  app.get<{ Params: { id: string } }>("/api/tasks/:id/agent/avatar", async (request, reply) => {
    // Error responses are per-viewer as well: an authenticated negative result
    // must never become a shared cache entry for another viewer.
    setMediaCacheHeaders(reply, { visibility: "private" });
    const ownerId = request.sessionUserId;
    if (!ownerId) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    if (!isUuidString(request.params.id)) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const db = getServerDirectDb();
    const task = await getTaskById(db, request.params.id);
    if (!task || task.ownerId !== ownerId) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const [profile] = await db
      .select({ avatarRef: profiles.avatarRef })
      .from(profiles)
      .where(
        and(
          eq(profiles.userId, task.ownerId),
          eq(profiles.agentId, task.agentId),
        ),
      )
      .limit(1);
    return sendAvatar(request, reply, profile?.avatarRef ?? SHELL_AVATAR_REF);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const ownerId =
      request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!ownerId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    if (!isUuidString(request.params.id)) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const db = getServerDirectDb();
    const task = await getTaskById(db, request.params.id);
    if (!task || task.ownerId !== ownerId) {
      return reply.status(404).send({ error: "Task not found" });
    }

    const [runs, agentNames] = await Promise.all([
      getTaskRuns(db, task.id),
      getOwnerAgentDisplayNamesByAgentId(db, ownerId, [task.agentId]),
    ]);
    const runSummaries: TaskRunSummary[] = await Promise.all(
      runs.map(async (run: TaskRun): Promise<TaskRunSummary> => {
        const base: TaskRunSummary = {
          id: run.id,
          status: run.status,
          modelId: run.modelId,
          resultText: run.resultText,
          lastError: run.lastError,
          startedAt: toIso(run.startedAt),
          completedAt: toIso(run.completedAt),
        };
        // M163 — agent-authored transcript for EVERY task (assistant/tool only),
        // including the agent's per-turn tool inputs. Empty for peer-owned DM
        // sessions read under the requester's RLS context (R4).
        const transcript = await getRunAgentTranscript({
          includeToolPresentation: true,
          ownerId,
          graphThreadId: run.graphThreadId,
          agentId: task.agentId,
          startedAt: run.startedAt ?? null,
          completedAt: run.completedAt ?? null,
        });
        return {
          ...base,
          transcript: transcript.map((m) => ({
            role: m.role,
            content: m.content,
            toolName: m.toolName,
            toolCalls: m.toolCalls,
            ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
            ...(m.toolStatus ? { toolStatus: m.toolStatus } : {}),
            createdAt: toIso(m.createdAt) ?? new Date(0).toISOString(),
          })),
        };
      }),
    );

    const detail: TaskDetail = {
      task: {
        ...toOwnerVisibleTaskSummary(task, {
          agentName: agentNames.get(task.agentId) ?? null,
          lastModelId: runs.at(-1)?.modelId ?? null,
          canResumeResearch: await canResumeSecurityResearchContextFailure(db, task),
        }),
        expectedOutput: task.expectedOutput,
        cron: task.cron,
        runAt: toIso(task.runAt),
        timezone: task.timezone,
        targetChat: task.targetChat,
        resultDelivery: task.resultDelivery,
        useScope: task.useScope,
        scopeId: task.scopeId,
        toolsMode: task.toolsMode,
        toolsWhitelist: task.toolsWhitelist,
        selectionProfile: task.selectionProfile,
        selectionSpec: task.selectionSpec,
        // D429 Phase 3 — requested exact pin, distinct from the per-run actual
        // model in `runs[].modelId`.
        requestedModelId: task.requestedModelId,
        createdAt: toIso(task.createdAt) ?? new Date(0).toISOString(),
        updatedAt: toIso(task.updatedAt) ?? new Date(0).toISOString(),
      },
      runs: runSummaries,
    };
    return reply.send(detail);
  });

  app.patch<{ Params: { id: string }; Body: TaskUpdatePayload }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const ownerId =
        request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
      if (!ownerId) {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const body = request.body ?? ({} as TaskUpdatePayload);
      const reject = rejectNotYetWiredTaskParams(
        body as unknown as Record<string, unknown>,
      );
      if (reject) {
        return reply.status(400).send({ error: reject });
      }

      const db = getServerDirectDb();
      const task = await getTaskById(db, request.params.id);
      if (!task || task.ownerId !== ownerId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      if (task.status !== "pending" && task.status !== "paused") {
        return reply.status(409).send({
          error: `Only pending or paused tasks can be updated (this one is '${task.status}').`,
        });
      }

      // D429 Phase 3 / M152 — validate a changed selection (422 on
      // unsatisfiable). The combined validator owns the exact pin, the
      // profile/spec bias, and their mutual-exclusion conflict. We validate
      // the EFFECTIVE selection (patch overlaid on the existing row) so
      // setting requestedModelId on a row that still carries a non-default
      // profile/spec is caught as a conflict.
      if (
        body.tools !== undefined ||
        body.requestedModelId !== undefined ||
        body.selectionProfile !== undefined ||
        body.selectionSpec !== undefined
      ) {
        const tf = toolsFields(body.tools);
        const effectiveToolsMode =
          body.tools !== undefined ? tf.toolsMode : task.toolsMode;
        const effectiveToolsWhitelist =
          body.tools !== undefined ? (tf.toolsWhitelist ?? []) : task.toolsWhitelist;
        const selectionError = validateTaskModelSelectionForCreate({
          requestedModelId:
            body.requestedModelId !== undefined
              ? body.requestedModelId
              : task.requestedModelId,
          profile:
            body.selectionProfile !== undefined
              ? body.selectionProfile
              : task.selectionProfile,
          spec:
            body.selectionSpec !== undefined
              ? body.selectionSpec
              : task.selectionSpec,
          toolsMode: effectiveToolsMode,
          toolsWhitelist: effectiveToolsWhitelist,
        });
        if (selectionError) {
          return reply
            .status(422)
            .send({ error: selectionError, detail: { message: selectionError } });
        }
      }

      let parsedRunAt: Date | undefined;
      try {
        parsedRunAt = parseRunAt(body.runAt);
      } catch (err) {
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }

      const patch: Partial<NewTask> = {};
      if (body.prompt !== undefined) patch.prompt = body.prompt;
      if (body.expectedOutput !== undefined) patch.expectedOutput = body.expectedOutput;
      if (body.scheduleKind !== undefined) patch.scheduleKind = body.scheduleKind;
      if (parsedRunAt !== undefined) patch.runAt = parsedRunAt;
      if (body.cron !== undefined) patch.cron = body.cron;
      if (body.timezone !== undefined) patch.timezone = body.timezone;
      if (body.targetChat !== undefined) patch.targetChat = body.targetChat;
      if (body.resultDelivery !== undefined) patch.resultDelivery = body.resultDelivery;
      if (body.tools !== undefined) {
        const tf = toolsFields(body.tools);
        Object.assign(patch, tf);
      }
      if (body.timeLimitSeconds !== undefined) {
        patch.timeLimitSeconds = body.timeLimitSeconds;
      }
      if (body.selectionProfile !== undefined) {
        patch.selectionProfile = body.selectionProfile;
      }
      if (body.selectionSpec !== undefined) {
        patch.selectionSpec = body.selectionSpec;
      }
      // D429 Phase 3 — explicit clearing semantics: `requestedModelId: null`
      // clears the pin; a string sets it; omission preserves the existing
      // value (omission is NOT treated as clear).
      if (body.requestedModelId !== undefined) {
        patch.requestedModelId = body.requestedModelId;
      }

      const scheduleChanged =
        body.scheduleKind !== undefined ||
        body.runAt !== undefined ||
        body.cron !== undefined ||
        body.timezone !== undefined;
      if (scheduleChanged) {
        const effectiveKind = body.scheduleKind ?? task.scheduleKind;
        const effectiveRunAt = parsedRunAt ?? task.runAt ?? undefined;
        const effectiveCron = body.cron ?? task.cron;
        const effectiveTz = body.timezone ?? task.timezone;
        try {
          patch.nextFireAt = computeNextFireAt(
            effectiveKind,
            effectiveRunAt,
            effectiveCron,
            effectiveTz,
          );
        } catch (err) {
          return reply
            .status(400)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (
        Object.keys(patch).length > 0 &&
        !(await requireAgentInvocation(
          {
            humanUserId: ownerId,
            origin: "task_update",
            agentId: task.agentId,
            ...(task.targetRoomId ? { roomId: task.targetRoomId } : {}),
          },
          reply,
        ))
      ) {
        return;
      }

      const updated = await updateTask(db, task.id, patch);
      if (!updated) {
        return reply.status(404).send({ error: "Task not found" });
      }
      return reply.send({ ...toTaskSummary(updated),
        ...(await canResumeSecurityResearchContextFailure(db, updated) ? { canResumeResearch: true } : {}),
      });
    },
  );

  // M147 (R8) — lifecycle routes. Owner-only, fail-closed: 401 when no subject
  // resolves, 404 (not 403) when the task belongs to another owner (mirror the
  // M146 don't-leak-existence rule). Each funnels through the SAME runtime
  // lifecycle fn the `task` tool uses (no second path). `unpauseTask` reaches
  // the live observer via `getTaskObserver()`, but we also pass `deps.observer`
  // explicitly so the route does not depend on module-singleton timing.
  const runLifecycle = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    fn: () => Promise<TaskLifecycleResult>,
    requiresInvocation = false,
  ) => {
    const ownerId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!ownerId) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const task = await getTaskById(getServerDirectDb(), request.params.id);
    if (!task || task.ownerId !== ownerId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    if (
      requiresInvocation &&
      !(await requireAgentInvocation(
        {
          humanUserId: ownerId,
          origin: "task_unpause",
          agentId: task.agentId,
          ...(task.targetRoomId ? { roomId: task.targetRoomId } : {}),
        },
        reply,
      ))
    ) {
      return;
    }
    const result = await fn();
    const response: TaskLifecycleResponse = {
      taskId: request.params.id,
      status: result.status,
      message: result.message,
    };
    return reply.send(response);
  };

  app.post<{ Params: { id: string } }>("/api/tasks/:id/pause", (request, reply) =>
    runLifecycle(request, reply, () =>
      pauseTask(
        { db: getServerDirectDb(), jobManager, observer: deps.observer },
        request.params.id,
      ),
    ),
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/unpause", (request, reply) =>
    runLifecycle(request, reply, () =>
      unpauseTask(
        { db: getServerDirectDb(), jobManager, observer: deps.observer },
        request.params.id,
      ),
      true,
    ),
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", (request, reply) =>
    runLifecycle(request, reply, async () => {
      await deps.prepareStopTask?.(request.params.id);
      return stopTask(
        { db: getServerDirectDb(), jobManager, observer: deps.observer },
        request.params.id,
      );
    }),
  );
}
