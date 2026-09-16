import { requiredString } from "../core/errors.js";
import { requireMembership } from "../identity/membership.js";
import { getProject } from "./service.js";

export function updateSettings(ctx, actor, projectId, body) {
  requireMembership(ctx, actor.userId, projectId, "settings");
  const prior = getProject(ctx, projectId);
  const next = ctx.store.projects.update(projectId, { name: requiredString(body.name, "name"), revision: prior.revision + 1 });
  ctx.accessCache.clearProject(projectId);
  return { projectId, name: next.name, revision: next.revision };
}
