import { and, eq } from "drizzle-orm";
import { jobs } from "../schema/jobs";
import type { JobStatus } from "@nautilo/types";
import { getSharedDirectDb } from "../config/direct-database";
import {
  acquireEncryptionPublicationFence,
  acquireOrdinaryEncryptionPublicationFence,
} from
  "../utils/encryption-transition-queries";

export type JobPublicationPolicy = Readonly<{
  expectedRevision: number;
  representation: "protected_only";
}>;

function db() {
  return getSharedDirectDb();
}
type JobMutationDb = Pick<ReturnType<typeof db>, "insert" | "update">;

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
  const insert = async (tx: JobMutationDb) => {
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
  };
  if (payload.publicationPolicy === undefined) {
    return database.transaction(async (tx) => {
      await acquireOrdinaryEncryptionPublicationFence(tx);
      return insert(tx);
    });
  }
  const publicationPolicy = payload.publicationPolicy;
  return database.transaction(async (tx) => {
    await acquireEncryptionPublicationFence(tx, publicationPolicy);
    return insert(tx);
  });
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
