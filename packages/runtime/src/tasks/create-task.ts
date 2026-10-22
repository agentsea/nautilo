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
import {
  prepareTaskCreationFunding,
  type TaskFundingAdmission,
} from "../task-funding-port";
import {
  assertTaskCreationProvenance,
  TaskCreationUnavailableError,
  type TaskCreationAdmissionPort,
  type TaskCreationProvenance,
} from "./task-creation-admission";

/** Input to the runtime `createTask` wrapper. `nextFireAt` / `status` are
 * computed here; everything else is a `tasks` insert field. */
export type TaskCreateInput = Omit<NewTask, "nextFireAt" | "status" | "localExecutionDelegation">;

export type TaskCreationResult = Readonly<{
  publicationDisposition?: "created" | "replayed";
  taskId: string;
  status: Task["status"];
  nextFireAt: Date | undefined;
}>;

export interface PrepareTaskCreationDeps {
  assertInvocation?: (input: AgentInvocationAdmissionInput) => Promise<void>;
  prepareFunding?: typeof prepareTaskCreationFunding;
  assertServerFunding?: typeof assertCanUseServerProviderCredentials;
}

function invocationAdmissionInput(input: TaskCreateInput): AgentInvocationAdmissionInput {
  return {
    humanUserId: input.requestorId,
    origin: "task_create",
    agentId: input.agentId,
    ...(input.targetRoomId ? { roomId: input.targetRoomId } : {}),
  };
}

/** Fully shaped definition handed to the protected repository. Runtime has
 * already bound the trusted funding and local-execution sources at this point. */
export type ProtectedTaskCreateCandidate = TaskCreateInput & Readonly<{
  id: string;
  nextFireAt: Date;
  status: "pending";
  fundingMode: "caller" | "legacy_server";
  localExecutionDelegation: LocalExecutionDelegation | null;
}>;

export interface CreateTaskDeps<Prepared = unknown> {
  db: DirectDatabase;
  /** The live observer to wake for now-tasks. */
  observer: { kick(): void };
  /** Explicit external acceptance, or inherited from an executing parent Job. */
  invocationAuthority?: AcceptedInvocationAuthority;
  /** Server-authored origin, carried outside caller-controlled Task fields. */
  provenance: TaskCreationProvenance;
  /** Lattice-selected admission. Plain uses the inert ordinary port. */
  admission: TaskCreationAdmissionPort<Prepared>;
  /** Fresh exact-target RBAC check before a durable Task is created. */
  assertInvocation?: (input: AgentInvocationAdmissionInput) => Promise<void>;
  assertServerFunding?: typeof assertCanUseServerProviderCredentials;
  /** Trusted source port, never a field supplied by a Task tool or HTTP body. */
  captureLocalExecution?: (task: TaskCreateInput & { id: string }) => Promise<LocalExecutionDelegation | null>;
  /** Trusted protected repository. The prepared plan and fully shaped Task
   * candidate are never accepted from a Task tool or public request body. */
  publishProtected?: (input: Readonly<{
    prepared: Prepared;
    candidate: ProtectedTaskCreateCandidate;
  }>) => Promise<TaskCreationResult>;
  /** Protected foreground retries bind the Task and schedule to the original
   * checkpointed tool effect. Plain creation never invokes this port. */
  resolveProtectedIdentity?: (input: Readonly<{ prepared: Prepared; candidate: TaskCreateInput }>) =>
    Readonly<{ taskId: string; scheduleReference: Date }>;
}

export type PreparedTaskCreationDeps<Prepared = unknown> = Omit<
  CreateTaskDeps<Prepared>,
  "invocationAuthority" | "provenance" | "assertInvocation" | "assertServerFunding"
>;

export interface PreparedTaskCreation {
  create<Prepared = unknown>(
    deps: PreparedTaskCreationDeps<Prepared>,
  ): Promise<TaskCreationResult>;
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

function taskCreationTiming(input: TaskCreateInput): Readonly<{
  scheduleKind: NonNullable<TaskCreateInput["scheduleKind"]>;
  nextFireAt: Date;
}> {
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
  return { scheduleKind, nextFireAt };
}

function currentTaskCreationAuthority(
  requestorId: string,
  supplied?: AcceptedInvocationAuthority,
): AcceptedInvocationAuthority {
  const invocationAuthority = supplied ?? getCurrentAcceptedInvocationAuthority();
  if (!invocationAuthority) {
    throw new TypeError("createTask requires accepted invocation authority");
  }
  assertAcceptedInvocationAuthoritySubject(invocationAuthority, requestorId);
  return invocationAuthority;
}

/**
 * Complete global Task-creation checks before borrowing a product transaction.
 * The returned one-shot creator owns the exact cloned input and trusted
 * provenance; its transaction call accepts no security-input overrides.
 */
export async function prepareTaskCreation(
  input: TaskCreateInput,
  provenance: TaskCreationProvenance,
  deps: PrepareTaskCreationDeps = {},
): Promise<PreparedTaskCreation> {
  // Capture the full candidate before the first await. Later mutation of a
  // tool/request object cannot change either the checks or durable candidate.
  const candidate = structuredClone(input);
  taskCreationTiming(candidate);
  const invocationAuthority = currentTaskCreationAuthority(candidate.requestorId);
  assertTaskCreationProvenance(provenance, candidate.ownerId);
  await (deps.assertInvocation ?? assertCanInvokeAgent)(invocationAdmissionInput(candidate));
  const callerFunded = await (deps.prepareFunding ?? prepareTaskCreationFunding)(candidate, provenance);
  if (!callerFunded) {
    await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(
      candidate.requestorId,
      "task_create",
    );
  }

  let consumed = false;
  return Object.freeze({
    async create<Prepared = unknown>(
      createDeps: PreparedTaskCreationDeps<Prepared>,
    ): Promise<TaskCreationResult> {
      if (consumed) throw new TypeError("Prepared Task creation is already consumed");
      consumed = true;
      if (["input", "provenance", "invocationAuthority", "assertInvocation",
        "prepareFunding", "assertServerFunding"].some(key =>
        Object.prototype.hasOwnProperty.call(createDeps, key))) {
        throw new TypeError("Prepared Task creation does not accept security input overrides");
      }
      if (getCurrentAcceptedInvocationAuthority() !== invocationAuthority) {
        throw new TypeError("Prepared Task creation authority changed");
      }
      const timing = taskCreationTiming(candidate);
      assertAcceptedInvocationAuthoritySubject(invocationAuthority, candidate.requestorId);
      assertTaskCreationProvenance(provenance, candidate.ownerId);
      return createTaskAfterGlobalChecks(
        createDeps,
        candidate,
        provenance,
        invocationAuthority,
        callerFunded,
        timing,
      );
    },
  });
}

/**
 * Runtime `createTask` is the shared entry point for Task creation surfaces.
 * It enforces the depth cap, computes `next_fire_at`, inserts the durable
 * `tasks` row through the data-access layer, and kicks the observer for
 * now-tasks so dispatch is near-instant.
 */
export async function createTask<Prepared = unknown>(
  deps: CreateTaskDeps<Prepared>,
  input: TaskCreateInput,
): Promise<TaskCreationResult> {
  const timing = taskCreationTiming(input);
  const invocationAuthority = currentTaskCreationAuthority(
    input.requestorId,
    deps.invocationAuthority,
  );
  assertTaskCreationProvenance(deps.provenance, input.ownerId);
  await (deps.assertInvocation ?? assertCanInvokeAgent)(invocationAdmissionInput(input));
  const callerFunded = await prepareTaskCreationFunding(input, deps.provenance);
  if (!callerFunded) {
    await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(
      input.requestorId,
      "task_create",
    );
  }
  return createTaskAfterGlobalChecks(
    deps,
    input,
    deps.provenance,
    invocationAuthority,
    callerFunded,
    timing,
  );
}

async function createTaskAfterGlobalChecks<Prepared>(
  deps: PreparedTaskCreationDeps<Prepared>,
  input: TaskCreateInput,
  provenance: TaskCreationProvenance,
  invocationAuthority: AcceptedInvocationAuthority,
  callerFunded: boolean | TaskFundingAdmission,
  timing: Readonly<{
    scheduleKind: NonNullable<TaskCreateInput["scheduleKind"]>;
    nextFireAt: Date;
  }>,
): Promise<TaskCreationResult> {
  const { scheduleKind, nextFireAt } = timing;
  const admission = await deps.admission.admit({
    db: deps.db,
    candidate: input,
    provenance,
    invocationAuthority,
  });
  if (admission.kind === "unavailable") {
    throw new TaskCreationUnavailableError(admission.reason);
  }
  if (admission.kind === "protected" && !deps.publishProtected) {
    throw new TaskCreationUnavailableError("task_shape_unsupported");
  }

  // Capture only after canonical invocation/content admission; the Desktop
  // grant is scoped to this exact identity even if the subsequent insert fails.
  const protectedIdentity = admission.kind === "protected" ? admission.canonicalTaskIdentity : undefined;
  if (protectedIdentity !== undefined && (protectedIdentity.ownerId !== input.requestorId
    || protectedIdentity.requestorId !== input.requestorId || protectedIdentity.agentId !== input.agentId)) {
    throw new TypeError("Protected Task admission changed its canonical requester or Agent");
  }
  const admittedCandidate = admission.kind === "ordinary" ? admission.candidate
    : protectedIdentity === undefined ? input : { ...input, ...protectedIdentity };
  const protectedSource = admission.kind === "protected"
    ? deps.resolveProtectedIdentity?.({ prepared: admission.prepared, candidate: admittedCandidate }) : undefined;
  if (protectedSource !== undefined && (!protectedSource.taskId
    || !Number.isFinite(protectedSource.scheduleReference.getTime())
    || admittedCandidate.id !== undefined && admittedCandidate.id !== protectedSource.taskId)) {
    throw new TypeError("Protected Task source identity changed");
  }
  const candidate = { ...admittedCandidate, id: protectedSource?.taskId ?? admittedCandidate.id ?? randomUUID() };
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
  const durableCandidate: ProtectedTaskCreateCandidate = {
    ...candidate,
    localExecutionDelegation,
    // The funding owner, never a model argument, records a subscription pin.
    // Each dispatch still rechecks the requestor's current policy and custody.
    ...(typeof callerFunded === "object" ? {
      metadata: { ...candidate.metadata, subscriptionFunding: callerFunded.binding },
    } : {}),
    // Only the trusted funding port may author this definition discriminator.
    fundingMode: callerFunded ? "caller" : "legacy_server",
    nextFireAt: protectedSource === undefined ? nextFireAt : computeNextFireAt(scheduleKind,
      input.runAt, input.cron, input.timezone ?? "UTC", protectedSource.scheduleReference),
    status: "pending",
  };
  if (admission.kind === "protected") {
    const published = await deps.publishProtected!({
      prepared: admission.prepared,
      candidate: durableCandidate,
    });
    if (published.taskId !== candidate.id) {
      throw new TypeError("Protected Task publication returned a different Task identity");
    }
    if (scheduleKind === "now") {
      deps.observer.kick();
    }
    return published;
  }
  const row = await dbCreateTask(deps.db, {
    ...durableCandidate,
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
    if (!parent || !inherited || parent.requestorId !== child.requestorId
      || inherited.humanUserId !== parent.requestorId || inherited.agentId !== parent.agentId
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
