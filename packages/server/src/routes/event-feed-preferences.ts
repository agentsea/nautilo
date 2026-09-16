import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";
import { eventFeedPreferenceSchema, EventFeedQueryError, type EventFeedPreference } from "@nautilo/types";

export interface EventFeedPreferenceRoutesDeps {
  preferences: {
    get: (userId: string) => Promise<EventFeedPreference>;
    set: (userId: string, preference: EventFeedPreference) => Promise<EventFeedPreference>;
  };
  changed: (userId: string) => void | Promise<void>;
}

export function eventFeedPreferenceRoutes(app: FastifyInstance, deps: EventFeedPreferenceRoutesDeps): void {
  app.get("/api/event-feed/preference", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    if (Object.keys(request.query as object).length > 0) {
      return reply.code(400).send({ error: "event_feed_error", code: "invalid_input" });
    }
    try {
      return reply.send(await deps.preferences.get(userId));
    } catch {
      warn("[event-feed] preference read failed");
      return reply.code(500).send({ error: "Event preference unavailable" });
    }
  });

  app.put<{ Body: unknown }>("/api/event-feed/preference", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const parsed = eventFeedPreferenceSchema.safeParse(request.body);
    if (Object.keys(request.query as object).length > 0 || !parsed.success
      || (parsed.data.mode === "snoozed" && Date.parse(parsed.data.until) <= Date.now())) {
      return reply.code(400).send({ error: "event_feed_error", code: "invalid_input" });
    }
    let result: EventFeedPreference;
    try {
      result = await deps.preferences.set(userId, parsed.data);
    } catch (error) {
      if (error instanceof EventFeedQueryError) {
        return reply.code(400).send({ error: "event_feed_error", code: error.code });
      }
      warn("[event-feed] preference update failed");
      return reply.code(500).send({ error: "Could not save event preference" });
    }
    try {
      // Content-free invalidation targets only this Human's sessions.
      await deps.changed(userId);
    } catch {
      // The preference is already durable; reconnect/focus refresh recovers.
      warn("[event-feed] preference change hint failed");
    }
    return reply.send(result);
  });
}
