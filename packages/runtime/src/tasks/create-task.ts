import {
  createTask as dbCreateTask,
  getTaskById,
  type DirectDatabase,
  type NewTask,
  type Task,
} from "@nautilo/db";
import { randomUUID } from "node:crypto";
import { parseLocalExecutionDelegation, type LocalExecutionDelegation } from "@nautilo/types";
import { MAX_SUBAGENT_DEPTH } from "@nautilo/agent";
import { nextCronOccurrence } from "./cron";
import {
  assertAcceptedInvocationAuthoritySubject,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  type AgentInvocationAdmissionInput,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import { getCurrentAcceptedInvocationAuthority } from "../job-manager";
import { prepareTaskCreationFunding } from "../task-funding-port";
import {
  assertTaskCreationProvenance,
  TaskCreationUnavailableError,
  type TaskCreationAdmissionPort,
  type TaskCreationProvenance,
} from "./task-creation-admission";

/** Input to the runtime `createTask` wrapper. `nextFireAt` / `status` are
 * computed here; everything else is a `tasks` insert field. */
export type TaskCreateInput = Omit<NewTask, "nextFireAt" | "status" | "localExecutionDelegation">;

export interface CreateTaskDeps {
  db: DirectDatabase;
  /** The live observer to wake for now-tasks. */
  observer: { kick(): void };
  /** Explicit external acceptance, or inherited from an executing parent Job. */
  invocationAuthority?: AcceptedInvocationAuthority;
  /** Server-authored origin, carried outside caller-controlled Task fields. */
  provenance: TaskCreationProvenance;
  /** Lattice-selected admission. Plain uses the inert ordinary port. */
  admission: TaskCreationAdmissionPort<unknown>;
  /** Fresh exact-target RBAC check before a durable Task is created. */
  assertInvocation?: (input: AgentInvocationAdmissionInput) => Promise<void>;
  assertServerFunding?: typeof assertCanUseServerProviderCredentials;
  /** Trusted source port, never a field supplied by a Task tool or HTTP body. */
  captureLocalExecution?: (task: TaskCreateInput & { id: string }) => Promise<LocalExecutionDelegation | null>;
}

/**
 * Schedule-to-`next_fire_at` computation, extracted from
 * `createTask` so the `task` tool's `update` command + the `PATCH /api/tasks/:id`
 * route can recompute on a schedule change WITHOUT duplicating the branch.
 *
 * Pure: no DB, no observer. `now` is injectable for deterministic tests.
 */
export function computeNextFireAt(
  scheduleKind: "now" | "one_shot" | "cron",
  runAt: Date | null | undefined,
  cron: string | null | undefined,
  timezone: string,
  now: Date = new Date(),
): Date {
  if (scheduleKind === "now") return now;
  if (scheduleKind === "one_shot") {
    if (!runAt) throw new Error("one_shot task requires runAt");
    return runAt;
  }
  if (!cron) throw new Error("cron task requires a cron expression");
  return nextCronOccurrence(cron, timezone, now);
}

/**
 * Runtime `createTask` is the shared entry point for Task creation surfaces.
 * It enforces the depth cap, computes `next_fire_at`, inserts the durable
 * `tasks` row through the data-access layer, and kicks the observer for
 * now-tasks so dispatch is near-instant.
 */
export async function createTask(
  deps: CreateTaskDeps,
  input: TaskCreateInput,
): Promise<{ taskId: string; status: Task["status"]; nextFireAt: Date | undefined }> {
  if (Object.prototype.hasOwnProperty.call(input, "localExecutionDelegation")) {
    throw new TypeError("Task local execution authority must come from its trusted source");
  }
  const depth = input.depth ?? 0;
  if (depth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `createTask: task depth cap exceeded (${depth} >= ${MAX_SUBAGENT_DEPTH})`,
    );
  }

  const scheduleKind = input.scheduleKind ?? "now";
  const now = new Date();
  const nextFireAt = computeNextFireAt(
    scheduleKind,
    input.runAt,
    input.cron,
    input.timezone ?? "UTC",
    now,
  );

  const invocationAuthority =
    deps.invocationAuthority ?? getCurrentAcceptedInvocationAuthority();
  if (!invocationAuthority) {
    throw new TypeError("createTask requires accepted invocation authority");
  }
  assertAcceptedInvocationAuthoritySubject(invocationAuthority, input.requestorId);
  assertTaskCreationProvenance(deps.provenance, input.ownerId);
  await (deps.assertInvocation ?? assertCanInvokeAgent)({
    humanUserId: input.requestorId,
    origin: "task_create",
    agentId: input.agentId,
    ...(input.targetRoomId ? { roomId: input.targetRoomId } : {}),
  });
  const callerFunded = await prepareTaskCreationFunding(input, deps.provenance);
  if (!callerFunded) {
    await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(
      input.requestorId, "task_create",
    );
  }

  const admission = await deps.admission.admit({
    db: deps.db,
    candidate: input,
    provenance: deps.provenance,
    invocationAuthority,
  });
  if (admission.kind === "unavailable") {
    throw new TaskCreationUnavailableError(admission.reason);
  }
  if (admission.kind === "protected") {
    throw new TaskCreationUnavailableError("task_shape_unsupported");
  }

  // Capture only after canonical invocation/content admission; the Desktop
  // grant is scoped to this exact identity even if the subsequent insert fails.
  const candidate = { ...admission.candidate, id: admission.candidate.id ?? randomUUID() };
  const captured = await deps.captureLocalExecution?.(candidate) ?? null;
  const localExecutionDelegation = captured === null ? null : parseLocalExecutionDelegation(captured);
  if (captured !== null && (localExecutionDelegation === null
    || localExecutionDelegation.humanUserId !== candidate.requestorId
    || localExecutionDelegation.agentId !== candidate.agentId
    || (!candidate.parentTaskId && (localExecutionDelegation.sourceRoomId !== candidate.callingRoomId
      || localExecutionDelegation.rootTaskId !== candidate.id)))) {
    throw new TypeError("Task local execution delegation does not match its canonical source");
  }
  if (localExecutionDelegation && candidate.parentTaskId) {
    await assertCapturedParentLineage(deps.db, candidate, localExecutionDelegation);
  }
  const row = await dbCreateTask(deps.db, {
    ...candidate,
    localExecutionDelegation,
    // Only the trusted funding port may author this definition discriminator.
    fundingMode: callerFunded ? "caller" : "legacy_server",
    nextFireAt,
    status: "pending",
  });

  if (scheduleKind === "now") {
    deps.observer.kick();
  }

  return {
    taskId: row.id,
    status: row.status,
    nextFireAt: row.nextFireAt ?? undefined,
  };
}

/** Nested tools execute in a Task Room. Only canonical parent rows can connect
 * that Room to the original Human source and the retained project grant. */
async function assertCapturedParentLineage(
  db: DirectDatabase,
  child: TaskCreateInput & { id: string },
  delegation: LocalExecutionDelegation,
): Promise<void> {
  const seen = new Set([child.id]);
  const parents: Task[] = [];
  let parentId = child.parentTaskId;
  let callingRoomId = child.callingRoomId;
  const identity = (task: Task) => ({
    id: task.id, ownerId: task.ownerId, requestorId: task.requestorId,
    callingRoomId: task.callingRoomId, targetRoomId: task.targetRoomId,
    parentTaskId: task.parentTaskId, status: task.status,
    contentRevision: task.contentRevision, localExecutionDelegation: task.localExecutionDelegation,
  });
  const deny = () => new TypeError("Task local execution delegation has no current parent lineage");
  while (parentId) {
    if (seen.has(parentId)) throw deny();
    seen.add(parentId);
    const parent = await getTaskById(db, parentId);
    const inherited = parseLocalExecutionDelegation(parent?.localExecutionDelegation);
    if (!parent || !inherited || parent.ownerId !== child.ownerId
      || parent.requestorId !== child.requestorId || inherited.agentId !== parent.agentId
      || ["cancelled", "paused", "errored"].includes(parent.status)
      || (callingRoomId !== parent.callingRoomId && callingRoomId !== parent.targetRoomId)
      || JSON.stringify({ ...inherited, agentId: delegation.agentId }) !== JSON.stringify(delegation)) throw deny();
    parents.push(parent);
    if (parent.id === delegation.rootTaskId) {
      if (parent.parentTaskId !== null || parent.callingRoomId !== delegation.sourceRoomId) throw deny();
      // Close awaits through the parent chain before persisting the child.
      const refreshed = await Promise.all(parents.map(value => getTaskById(db, value.id)));
      if (refreshed.some((value, index) => !value
        || JSON.stringify(identity(value)) !== JSON.stringify(identity(parents[index]!)))) throw deny();
      return;
    }
    callingRoomId = parent.callingRoomId;
    parentId = parent.parentTaskId;
  }
  throw deny();
}
