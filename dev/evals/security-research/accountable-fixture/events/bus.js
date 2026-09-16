import { invariant } from "../core/errors.js";

export function createBus() {
  const subscribers = new Map();
  return {
    subscribe(channel, listener) {
      const listeners = subscribers.get(channel) ?? new Set();
      listeners.add(listener);
      subscribers.set(channel, listeners);
      return () => { listeners.delete(listener); if (listeners.size === 0) subscribers.delete(channel); };
    },
    publish(channel, event) {
      for (const listener of subscribers.get(channel) ?? []) listener(structuredClone(event));
    },
  };
}
export function subscribeOrganization(ctx, actor, organizationId, listener) {
  const user = ctx.store.users.get(actor.userId);
  invariant(user?.active && user.organizationIds.includes(organizationId), 403, "organization_access", "Organization membership is required");
  return ctx.bus.subscribe(`organization:${organizationId}`, listener);
}
