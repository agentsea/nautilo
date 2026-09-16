import { invariant } from "../core/errors.js";

function ownedJob(ctx, actor, jobId) {
  const job = ctx.store.jobs.get(jobId);
  invariant(job?.ownerId === actor.userId, 404, "job_missing", "Export was not found");
  return job;
}
export function exportStatus(ctx, actor, jobId) {
  const job = ownedJob(ctx, actor, jobId);
  return { jobId: job.id, projectId: job.projectId, state: job.state, createdAt: job.createdAt,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
}
export function downloadExport(ctx, actor, jobId) {
  const job = ownedJob(ctx, actor, jobId);
  invariant(job.state === "completed" && job.result, 409, "export_not_ready", "Export is not ready");
  return job.result;
}
