import { z } from "zod";

const lane = z.enum(["stenographer", "reflection", "memory"]);
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime({ offset: true });
const version = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
const jobId = z.string().min(1).max(512);

const job = z.object({
  id: jobId,
  lane,
  version,
  stage: z.string(),
  reason: z.string(),
  modelId: z.string().nullable(),
  action: z.enum(["retry_with_model", "retry_review", "reconcile_review", "blocked"]),
}).strict();

const model = z.object({
  id: z.string(),
  label: z.string(),
  lanes: z.array(lane),
}).strict();

export const memoryRecoveryPreviewSchema = z.object({
  roomId: z.string().uuid(),
  generatedAt: timestamp,
  journal: z.object({
    generation: count,
    cursor: count,
    lastCompletedAt: timestamp.nullable(),
    target: count.nullable(),
    rebuild: z.enum(["available", "running", "blocked", "unavailable"]),
  }).strict(),
  reflection: z.object({ pending: count, completed: count }).strict(),
  memory: z.object({
    pending: count,
    covered: count,
    latestOutcome: z.enum(["published", "no_change"]).nullable(),
  }).strict(),
  jobs: z.array(job),
  hasMoreJobs: z.boolean(),
  models: z.array(model),
}).strict();

const roomId = z.string().uuid();
export const memoryRecoveryRequestSchema = z.discriminatedUnion("action", [
  z.object({ roomId, action: z.literal("rebuild_journal"), generation: count, cursor: count, confirmBillableWork: z.literal(true) }).strict(),
  z.object({ roomId, action: z.literal("retry_with_model"), lane, jobId, version, modelId: z.string().min(1).max(256) }).strict(),
  z.object({ roomId, action: z.literal("retry_review"), jobId: z.string().uuid(), version }).strict(),
  z.object({ roomId, action: z.literal("reconcile_review"), jobId: z.string().uuid(), version, confirmBillableWork: z.literal(true) }).strict(),
]);

export const memoryRecoveryResultSchema = z.object({
  status: z.enum(["queued", "already_queued", "blocked", "stale"]),
}).strict();

export type MemoryRecoveryPreview = z.infer<typeof memoryRecoveryPreviewSchema>;
export type MemoryRecoveryJob = z.infer<typeof job>;
export type MemoryRecoveryModel = z.infer<typeof model>;
export type MemoryRecoveryRequest = z.infer<typeof memoryRecoveryRequestSchema>;
export type MemoryRecoveryResult = z.infer<typeof memoryRecoveryResultSchema>;
