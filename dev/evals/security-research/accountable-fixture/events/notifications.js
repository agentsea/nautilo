import { timestamp } from "../core/clock.js";

function channel(ctx, projectId) {
  const project = ctx.store.projects.get(projectId);
  return project ? `organization:${project.organizationId}` : null;
}
export function exportProgress(ctx, job) {
  const destination = channel(ctx, job.projectId);
  if (!destination) return;
  ctx.bus.publish(destination, { kind: "export_progress", jobId: job.id, state: "running", at: timestamp(ctx.clock) });
}
export function exportReady(ctx, job) {
  const destination = channel(ctx, job.projectId);
  if (!destination) return;
  ctx.bus.publish(destination, { kind: "export_ready", jobId: job.id, projectId: job.projectId,
    requestedBy: job.ownerId, result: job.result, at: timestamp(ctx.clock) });
}
