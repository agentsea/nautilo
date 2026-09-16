import { invariant } from "../core/errors.js";
import { permits } from "../identity/roles.js";
import { assembleBundle } from "../documents/bundles.js";
import { exportReady, exportProgress } from "../events/notifications.js";
import { timestamp } from "../core/clock.js";

export function runExport(ctx, jobId) {
  const job = ctx.store.jobs.get(jobId);
  invariant(job, 404, "job_missing", "Export was not found");
  if (job.state !== "queued") return { jobId, state: job.state };
  ctx.store.jobs.update(jobId, { state: "running", startedAt: timestamp(ctx.clock) });
  exportProgress(ctx, job);
  try {
    invariant(permits(job.acceptedRole, "export"), 403, "export_role", "Export permission is required");
    const bundle = assembleBundle(ctx, job.projectId, job.documentIds);
    const result = ctx.store.jobs.update(job.id, { state: "completed", result: bundle, completedAt: timestamp(ctx.clock) });
    exportReady(ctx, result);
    return { jobId, state: result.state };
  } catch (error) {
    ctx.store.jobs.update(jobId, { state: "failed", errorCode: error.code ?? "export_failed", result: null });
    return { jobId, state: "failed" };
  }
}
export function drainExports(ctx) {
  return ctx.store.jobs.all().filter((job) => job.state === "queued").map((job) => runExport(ctx, job.id));
}
