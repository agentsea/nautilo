import { activeMembership } from "../identity/membership.js";

export function createAccessCache() {
  const decisions = new Map();
  return {
    decision(ctx, userId, projectId) {
      const project = ctx.store.projects.get(projectId);
      if (!project) return null;
      const key = `${projectId}:${project.revision}`;
      if (decisions.has(key)) return structuredClone(decisions.get(key));
      const membership = activeMembership(ctx, userId, projectId);
      const result = membership ? { permitted: true, role: membership.role } : null;
      decisions.set(key, result);
      return structuredClone(result);
    },
    clearProject(projectId) {
      for (const key of decisions.keys()) if (key.startsWith(`${projectId}:`)) decisions.delete(key);
    },
  };
}
