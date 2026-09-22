import {
  createTask as dbCreateTask,
  type DirectDatabase,
  type NewTask,
  type Task,
} from "@nautilo/db";
import { MAX_SUBAGENT_DEPTH } from "@nautilo/agent";
import { nextCronOccurrence } from "./cron";
import {
  assertAcceptedInvocationAuthoritySubject,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import { getCurrentAcceptedInvocationAuthority } from "../job-manager";
import {
  assertTaskCreationProvenance,
  TaskCreationUnavailableError,
  type TaskCreationAdmissionPort,
  type TaskCreationProvenance,
} from "./task-creation-admission";

/** Input to the runtime `createTask` wrapper. `nextFireAt` / `status` are
 * computed here; everything else is a `tasks` insert field. */
export type TaskCreateInput = Omit<NewTask, "nextFireAt" | "status">;

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
}

/**
 * M146 (Step 0) — the schedule → `next_fire_at` computation, extracted from
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
 * M142 (spec §5.1) — runtime `createTask`. The thin entry every later
 * surface (M143's `task create` tool + the Phase 3/4 shortcuts) calls: it
 * enforces the depth cap, computes `next_fire_at`, inserts the durable
 * `tasks` row via the M141 store helper, and kicks the observer for
 * now-tasks so dispatch is near-instant.
 */
export async function createTask(
  deps: CreateTaskDeps,
  input: TaskCreateInput,
): Promise<{ taskId: string; status: Task["status"]; nextFireAt: Date | undefined }> {
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

  const row = await dbCreateTask(deps.db, {
    ...admission.candidate,
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
