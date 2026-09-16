import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";
import type { EventFeed } from "@nautilo/event-feed";
import {
  eventFeedListOptionsSchema,
  eventFeedSetReadRequestSchema,
  eventFeedTypeSchema,
  EventFeedQueryError,
  type EventFeedListOptions,
} from "@nautilo/types";

export type EventFeedReadService = Pick<
  EventFeed,
  "list" | "countUnread" | "setRead" | "markAllRead"
>;

export interface EventFeedRoutesDeps {
  feed: EventFeedReadService;
  warn?: (message: string) => void;
  resolveActorNames?: (actorIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

type EventFeedListQuery = {
  cursor?: unknown;
  unreadOnly?: unknown;
  types?: unknown;
  limit?: unknown;
  [key: string]: unknown;
};

function parseListQuery(query: EventFeedListQuery): EventFeedListOptions | null {
  const allowedKeys = new Set(["cursor", "unreadOnly", "types", "limit"]);
  if (Object.keys(query).some((key) => !allowedKeys.has(key))) return null;

  const rawTypes = query.types;
  const normalizedTypes =
    typeof rawTypes === "string"
      ? [rawTypes]
      : Array.isArray(rawTypes) && rawTypes.every((value) => typeof value === "string")
        ? rawTypes
        : rawTypes === undefined
          ? undefined
          : null;
  if (normalizedTypes === null) return null;
  if (normalizedTypes?.some((type) => !eventFeedTypeSchema.safeParse(type).success)) return null;

  let unreadOnly: boolean | undefined;
  if (query.unreadOnly === "true") unreadOnly = true;
  else if (query.unreadOnly === "false") unreadOnly = false;
  else if (query.unreadOnly !== undefined) return null;

  let limit: number | undefined;
  if (typeof query.limit === "string" && /^[1-9]\d*$/u.test(query.limit)) {
    limit = Number(query.limit);
  } else if (query.limit !== undefined) {
    return null;
  }

  const parsed = eventFeedListOptionsSchema.safeParse({
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(unreadOnly !== undefined ? { unreadOnly } : {}),
    ...(normalizedTypes !== undefined ? { types: normalizedTypes } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function operationErrorReply(error: unknown): {
  status: 400 | 404;
  body: {
    error: "event_feed_error";
    code: "invalid_cursor" | "invalid_input" | "not_found";
  };
} | null {
  if (!(error instanceof EventFeedQueryError)) return null;
  return {
    status: error.code === "not_found" ? 404 : 400,
    body: { error: "event_feed_error", code: error.code },
  };
}

/** M323 — authenticated, caller-owned durable event-feed HTTP boundary. */
export function eventFeedRoutes(app: FastifyInstance, deps: EventFeedRoutesDeps): void {
  const warnMessage = deps.warn ?? warn;

  app.get<{ Querystring: EventFeedListQuery }>("/api/event-feed", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const options = parseListQuery(request.query);
    if (options === null) {
      return reply.code(400).send({
        error: "event_feed_error",
        code: "invalid_input",
      });
    }
    try {
      const page = await deps.feed.list(userId, options);
      if (!deps.resolveActorNames) return reply.send(page);
      let names: ReadonlyMap<string, string> = new Map();
      try {
        names = await deps.resolveActorNames([...new Set(page.events.flatMap(item => item.actorId ? [item.actorId] : []))]);
      } catch { /* Unavailable identity presentation must not hide durable history. */ }
      return reply.send({ ...page, events: page.events.map(item => item.type === "unknown" ? item : {
        ...item, actorDisplayName: item.actorId ? names.get(item.actorId) ?? null : null,
      }) });
    } catch (error) {
      const response = operationErrorReply(error);
      if (response) return reply.code(response.status).send(response.body);
      warnMessage("[event-feed] list failed");
      return reply.code(500).send({ error: "Event feed unavailable" });
    }
  });

  app.get("/api/event-feed/unread-count", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    try {
      return reply.send({ unreadCount: await deps.feed.countUnread(userId) });
    } catch {
      warnMessage("[event-feed] unread count failed");
      return reply.code(500).send({ error: "Event feed unavailable" });
    }
  });

  app.put<{ Params: { eventId: string }; Body: unknown }>(
    "/api/event-feed/:eventId/read",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const eventId = request.params.eventId;
      const body = eventFeedSetReadRequestSchema.safeParse(request.body);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(eventId) || !body.success) {
        return reply.code(400).send({
          error: "event_feed_error",
          code: "invalid_input",
        });
      }
      try {
        return reply.send(await deps.feed.setRead(userId, eventId, body.data.read));
      } catch (error) {
        const response = operationErrorReply(error);
        if (response) return reply.code(response.status).send(response.body);
        warnMessage("[event-feed] read-state update failed");
        return reply.code(500).send({ error: "Event feed unavailable" });
      }
    },
  );

  app.post("/api/event-feed/mark-all-read", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    try {
      return reply.send(await deps.feed.markAllRead(userId));
    } catch {
      warnMessage("[event-feed] mark-all-read failed");
      return reply.code(500).send({ error: "Event feed unavailable" });
    }
  });
}
