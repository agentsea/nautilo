import { and, eq, inArray, isNull, isNotNull, or } from "drizzle-orm";
import { jobs } from "../schema/jobs";
import type { JobStatus } from "@nautilo/types";
import { getSharedDirectDb } from "../config/direct-database";
import {
  acquireEncryptionConsumptionFence,
  acquireEncryptionPublicationFence,
  acquireOrdinaryEncryptionPublicationFence,
} from
  "../utils/encryption-transition-queries";
import type { ProtectedTaskDurableJobReference } from "./tasks";

export type JobPublicationPolicy = Readonly<{
  expectedRevision: number;
  representation: "protected_only";
}>;

export type ProtectedTaskJobStartResult = "started" | "rejected";

export type ProtectedTaskJobTerminalRequest =
  | "completed"
  | "failed"
  | "cancelled";

export type ProtectedTaskJobTerminalResult =
  | Readonly<{
      kind: "transitioned";
      status: ProtectedTaskJobTerminalRequest;
    }>
  | Readonly<{
      kind: "existing_terminal";
      status: "completed" | "failed" | "cancelled" | "timed_out";
    }>
  | Readonly<{ kind: "rejected" }>;

function db() {
  return getSharedDirectDb();
}
type JobMutationDb = Pick<ReturnType<typeof db>, "insert" | "update">;
type JobInsertDb = Pick<ReturnType<typeof db>, "insert">;
type ProtectedTaskJobTerminalDb = Pick<
  ReturnType<typeof db>,
  "select" | "update"
>;

export interface PersistJobPayload {
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  /**
   * M042B: optional room context. Derived by the JobManager from the
   * input's roomId when present; NULL for guest / background / legacy
   * jobs. Carried to the DB so downstream observability can filter
   * by room when the feature lands.
   */
  roomId?: string | null;
  type: "foreground" | "background";
  input: Record<string, unknown>;
  /** Trusted product-owner metadata; never inferred from the JSON input. */
  publicationPolicy?: JobPublicationPolicy;
}

export interface PersistedJobRecord {
  id: string;
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  type: "foreground" | "background";
  status: JobStatus;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  message: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export async function persistJob(payload: PersistJobPayload): Promise<string> {
  return persistJobWithDatabase(db(), payload);
}

/** @internal Transaction seam for exact unit verification. */
export async function persistJobWithDatabase(
  database: ReturnType<typeof db>,
  payload: PersistJobPayload,
): Promise<string> {
  if (payload.publicationPolicy === undefined) {
    return database.transaction(async (tx) => {
      await acquireOrdinaryEncryptionPublicationFence(tx);
      return persistJobInTransaction(tx, payload);
    });
  }
  const publicationPolicy = payload.publicationPolicy;
  return database.transaction(async (tx) => {
    await acquireEncryptionPublicationFence(tx, publicationPolicy);
    return persistJobInTransaction(tx, payload);
  });
}

/** @internal Insert through an already fenced canonical product transaction. */
export async function persistJobInTransaction(
  tx: JobInsertDb,
  payload: PersistJobPayload,
): Promise<string> {
  const [row] = await tx
    .insert(jobs)
    .values({
      ownerId: payload.ownerId,
      requestorId: payload.requestorId,
      laneKey: payload.laneKey,
      // M042B: room_id nullable; empty / undefined → NULL.
      ...(payload.roomId ? { roomId: payload.roomId } : {}),
      type: payload.type,
      status: "queued",
      input: payload.input,
    })
    .returning({ id: jobs.id });
  if (!row) throw new Error("Failed to persist job");
  return row.id;
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  fields?: { message?: string; result?: Record<string, unknown> },
  publicationPolicy?: JobPublicationPolicy,
) {
  return updateJobStatusWithDatabase(
    db(), jobId, status, fields, publicationPolicy,
  );
}

export async function startProtectedTaskJob(
  jobId: string,
  expectedReference: ProtectedTaskDurableJobReference,
  publicationPolicy: JobPublicationPolicy,
): Promise<ProtectedTaskJobStartResult> {
  return startProtectedTaskJobWithDatabase(
    db(), jobId, expectedReference, publicationPolicy,
  );
}

export async function settleProtectedTaskJobTerminal(
  jobId: string,
  expectedReference: ProtectedTaskDurableJobReference,
  requested: ProtectedTaskJobTerminalRequest,
  publicationPolicy: JobPublicationPolicy,
): Promise<ProtectedTaskJobTerminalResult> {
  return settleProtectedTaskJobTerminalWithDatabase(
    db(), jobId, expectedReference, requested, publicationPolicy,
  );
}

function protectedTaskJobTerminalPredecessor(
  requested: ProtectedTaskJobTerminalRequest,
) {
  const running = and(
    eq(jobs.status, "running"),
    isNotNull(jobs.startedAt),
  );
  return requested === "completed"
    ? running
    : or(
        and(eq(jobs.status, "queued"), isNull(jobs.startedAt)),
        running,
      );
}

function existingProtectedTaskJobTerminal(
  row: Readonly<{
    status: string;
    startedAt: Date | null;
    completedAt: Date | null;
  }> | undefined,
): ProtectedTaskJobTerminalResult | null {
  if (row?.completedAt === null || row === undefined) return null;
  if (row.status === "completed") {
    return row.startedAt === null
      ? null
      : { kind: "existing_terminal", status: "completed" };
  }
  if (
    row.status === "failed"
    || row.status === "cancelled"
    || row.status === "timed_out"
  ) {
    return { kind: "existing_terminal", status: row.status };
  }
  return null;
}

async function settleProtectedTaskJobTerminalInTransaction(
  tx: ProtectedTaskJobTerminalDb,
  jobId: string,
  expectedReference: ProtectedTaskDurableJobReference,
  requested: ProtectedTaskJobTerminalRequest,
): Promise<ProtectedTaskJobTerminalResult> {
  const exactIdentity = and(
    eq(jobs.id, jobId),
    eq(jobs.input, { ...expectedReference }),
    eq(jobs.laneKey, `task:${expectedReference.taskId}`),
    eq(jobs.type, "foreground"),
    isNull(jobs.result),
    isNull(jobs.message),
  );
  const transitioned = await tx.update(jobs).set({
    status: requested,
    completedAt: new Date(),
  }).where(and(
    exactIdentity,
    isNull(jobs.completedAt),
    protectedTaskJobTerminalPredecessor(requested),
  )).returning({ id: jobs.id });
  if (transitioned.length === 1) {
    return { kind: "transitioned", status: requested };
  }

  const [existing] = await tx.select({
    status: jobs.status,
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
  }).from(jobs).where(and(
    exactIdentity,
    inArray(jobs.status, ["completed", "failed", "cancelled", "timed_out"]),
    isNotNull(jobs.completedAt),
  )).limit(1);
  return existingProtectedTaskJobTerminal(existing) ?? { kind: "rejected" };
}

/** @internal Transaction seam for exact unit verification. */
export async function settleProtectedTaskJobTerminalWithDatabase(
  database: ReturnType<typeof db>,
  jobId: string,
  expectedReference: ProtectedTaskDurableJobReference,
  requested: ProtectedTaskJobTerminalRequest,
  publicationPolicy: JobPublicationPolicy,
): Promise<ProtectedTaskJobTerminalResult> {
  if (
    jobId.length === 0
    || expectedReference.kind !== "protected_task_run_v1"
    || expectedReference.policyRevision !== publicationPolicy.expectedRevision
    || publicationPolicy.representation !== "protected_only"
    || !["completed", "failed", "cancelled"].includes(requested)
  ) {
    throw new TypeError("Protected Task Job terminal authority is invalid");
  }
  return database.transaction(async (tx) => {
    await acquireEncryptionPublicationFence(tx, publicationPolicy);
    return settleProtectedTaskJobTerminalInTransaction(
      tx, jobId, expectedReference, requested,
    );
  });
}

/** @internal Transaction seam for exact unit verification. */
export async function startProtectedTaskJobWithDatabase(
  database: ReturnType<typeof db>,
  jobId: string,
  expectedReference: ProtectedTaskDurableJobReference,
  publicationPolicy: JobPublicationPolicy,
): Promise<ProtectedTaskJobStartResult> {
  if (
    jobId.length === 0
    || expectedReference.kind !== "protected_task_run_v1"
    || expectedReference.policyRevision !== publicationPolicy.expectedRevision
    || publicationPolicy.representation !== "protected_only"
  ) {
    throw new TypeError("Protected Task Job start authority is invalid");
  }
  const durableInput = { ...expectedReference };
  return database.transaction(async (tx) => {
    await acquireEncryptionPublicationFence(tx, publicationPolicy);
    const rows = await tx
      .update(jobs)
      .set({ status: "running", startedAt: new Date() })
      .where(and(
        eq(jobs.id, jobId),
        eq(jobs.status, "queued"),
        isNull(jobs.startedAt),
        isNull(jobs.completedAt),
        eq(jobs.input, durableInput),
      ))
      .returning({ id: jobs.id });
    return rows.length === 1 ? "started" : "rejected";
  });
}

/** Cancel only a content-free protected Job that never crossed its start fence. */
export async function cancelUnstartedProtectedTaskJobWithDatabase(
  database: ReturnType<typeof db>,
  jobId: string,
  expectedReference: ProtectedTaskDurableJobReference,
): Promise<"cancelled" | "exact_replay" | "ineligible"> {
  if (!jobId || expectedReference.kind !== "protected_task_run_v1"
    || expectedReference.executionSegment !== 1
    || expectedReference.resumeAcceptanceId !== undefined
    || expectedReference.resumeContinuationFingerprint !== undefined) {
    throw new TypeError("Protected Task unstarted cancellation is invalid");
  }
  return database.transaction(async tx => {
    // Cleanup is valid after a policy change; it never writes content.
    await acquireEncryptionConsumptionFence(tx);
    const exact = and(
      eq(jobs.id, jobId),
      eq(jobs.input, { ...expectedReference }),
      isNull(jobs.startedAt),
      isNull(jobs.result),
      isNull(jobs.message),
    );
    const cancelled = await tx.update(jobs).set({
      status: "cancelled", completedAt: new Date(),
    }).where(and(exact, eq(jobs.status, "queued"), isNull(jobs.completedAt)))
      .returning({ id: jobs.id });
    if (cancelled.length === 1) return "cancelled";
    const replay = await tx.select({ id: jobs.id }).from(jobs).where(and(
      exact, eq(jobs.status, "cancelled"), isNotNull(jobs.completedAt),
    )).limit(1);
    return replay.length === 1 ? "exact_replay" : "ineligible";
  });
}

/** @internal Transaction seam for exact unit verification. */
export async function updateJobStatusWithDatabase(
  database: ReturnType<typeof db>,
  jobId: string,
  status: JobStatus,
  fields?: { message?: string; result?: Record<string, unknown> },
  publicationPolicy?: JobPublicationPolicy,
) {
  const now = new Date();
  const isTerminal =
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled";

  const update = async (tx: JobMutationDb) => {
    await tx
    .update(jobs)
    .set({
      status,
      message: fields?.message ?? null,
      result: fields?.result ?? null,
      ...(status === "running" ? { startedAt: now } : {}),
      ...(isTerminal ? { completedAt: now } : {}),
    })
    .where(eq(jobs.id, jobId));
  };
  if (publicationPolicy === undefined) {
    if (fields?.message === undefined && fields?.result === undefined) {
      return update(database);
    }
    return database.transaction(async (tx) => {
      await acquireOrdinaryEncryptionPublicationFence(tx);
      await update(tx);
    });
  }
  if (fields?.message !== undefined || fields?.result !== undefined) {
    throw new TypeError("Full encryption Job status forbids ordinary fields");
  }
  return database.transaction(async (tx) => {
    await acquireEncryptionPublicationFence(tx, publicationPolicy);
    await update(tx);
  });
}

export async function getJobById(
  jobId: string,
  ownerId?: string,
): Promise<PersistedJobRecord | null> {
  const where = ownerId
    ? and(eq(jobs.id, jobId), eq(jobs.ownerId, ownerId))
    : eq(jobs.id, jobId);

  const [row] = await db()
    .select({
      id: jobs.id,
      ownerId: jobs.ownerId,
      requestorId: jobs.requestorId,
      laneKey: jobs.laneKey,
      type: jobs.type,
      status: jobs.status,
      input: jobs.input,
      result: jobs.result,
      message: jobs.message,
      createdAt: jobs.createdAt,
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
    })
    .from(jobs)
    .where(where)
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    type: row.type as "foreground" | "background",
    status: row.status as JobStatus,
  };
}
