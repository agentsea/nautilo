import { invariant } from "../core/errors.js";
import { requireMembership } from "../identity/membership.js";

export function getProject(ctx, projectId) {
  const project = ctx.store.projects.get(projectId);
  invariant(project && !project.archived, 404, "project_missing", "Project was not found");
  return project;
}
export function listProjects(ctx, actor) {
  return ctx.store.projects.all().filter((project) => {
    try { requireMembership(ctx, actor.userId, project.id); return true; }
    catch { return false; }
  }).map(({ id, name, organizationId }) => ({ id, name, organizationId }));
}
export function projectSummary(ctx, projectId) {
  const project = getProject(ctx, projectId);
  const documents = ctx.store.documents.all().filter((item) => item.projectId === projectId);
  return { id: project.id, name: project.name, documents: documents.map(({ id, title, body, revision }) => ({ id, title, body, revision })) };
}
