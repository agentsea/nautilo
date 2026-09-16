import { invariant } from "../core/errors.js";
import { getProject, projectSummary } from "./service.js";
import { requireMembership } from "../identity/membership.js";

export function overview(ctx, actor, projectId) {
  getProject(ctx, projectId);
  const decision = ctx.accessCache.decision(ctx, actor.userId, projectId);
  invariant(decision?.permitted, 403, "project_access_denied", "Project access is required");
  return projectSummary(ctx, projectId);
}
export function membershipView(ctx, actor, projectId) {
  const membership = requireMembership(ctx, actor.userId, projectId);
  const project = getProject(ctx, projectId);
  return { projectId, projectName: project.name, role: membership.role, membershipRevision: membership.revision };
}
