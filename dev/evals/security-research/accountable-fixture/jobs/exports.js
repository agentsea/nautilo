import { requireMembership } from "../identity/membership.js";
import { invariant } from "../core/errors.js";
import { documentInProject } from "../documents/repository.js";
import { timestamp } from "../core/clock.js";

export function requestExport(ctx, actor, projectId, body) {
  const membership = requireMembership(ctx, actor.userId, projectId, "export");
  if (body.documentIds !== undefined) {
    invariant(Array.isArray(body.documentIds), 400, "invalid_documents", "Document identifiers must be an array");
    body.documentIds.forEach((id) => documentInProject(ctx, projectId, id));
  }
  const job = ctx.store.jobs.put({ id: ctx.store.id("export"), ownerId: actor.userId, projectId,
    documentIds: body.documentIds, acceptedRole: membership.role, membershipRevision: membership.revision,
    state: "queued", createdAt: timestamp(ctx.clock), result: null });
  return { jobId: job.id, state: job.state };
}
export function cancelExport(ctx, actor, jobId) {
  const job = ctx.store.jobs.get(jobId);
  invariant(job?.ownerId === actor.userId, 404, "job_missing", "Export was not found");
  invariant(job.state === "queued", 409, "job_started", "Only queued exports can be cancelled");
  ctx.store.jobs.update(jobId, { state: "cancelled" });
  return { cancelled: true };
}
