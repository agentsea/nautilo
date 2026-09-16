import { invariant } from "../core/errors.js";
import { requireRole } from "./roles.js";

export function activeMembership(ctx, userId, projectId) {
  const user = ctx.store.users.get(userId);
  const project = ctx.store.projects.get(projectId);
  const membership = ctx.store.memberships.get(`${projectId}:${userId}`);
  if (!user?.active || !project || project.archived) return null;
  if (!membership || membership.state !== "active") return null;
  if (membership.expiresAt !== undefined && ctx.clock.isExpired(membership.expiresAt)) return null;
  if (!user.organizationIds.includes(project.organizationId)) return null;
  return membership;
}
export function requireMembership(ctx, userId, projectId, action = "read") {
  const membership = activeMembership(ctx, userId, projectId);
  invariant(membership, 403, "project_access_denied", "Current project membership is required");
  return requireRole(membership, action);
}
export function revokeMembership(ctx, projectId, userId) {
  const key = `${projectId}:${userId}`;
  const prior = ctx.store.memberships.get(key);
  invariant(prior, 404, "membership_missing", "Membership was not found");
  return ctx.store.memberships.update(key, { state: "revoked", revision: prior.revision + 1 });
}
