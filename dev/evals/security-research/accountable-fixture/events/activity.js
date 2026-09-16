import { timestamp } from "../core/clock.js";
import { requireMembership } from "../identity/membership.js";

export function recordActivity(ctx, projectId, kind, actorId) {
  const event = ctx.store.activity.put({ id: ctx.store.id("activity"), projectId, kind, actorId, at: timestamp(ctx.clock) });
  const project = ctx.store.projects.get(projectId);
  if (project) ctx.bus.publish(`organization:${project.organizationId}`, { kind: "activity_changed", activityId: event.id, at: event.at });
  return event.id;
}
export function listActivity(ctx, actor, projectId) {
  requireMembership(ctx, actor.userId, projectId, "read");
  return ctx.store.activity.all().filter((event) => event.projectId === projectId).map(({ id, kind, at }) => ({ id, kind, at }));
}
