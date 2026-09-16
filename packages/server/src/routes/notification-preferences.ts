import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";
import type {
  NotificationLevel,
  NotificationPreferencesDto,
  NotificationStateResponse,
  RoomNotificationPreferenceDto,
} from "@nautilo/types";
import {
  NotificationPreferenceError,
  NotificationStateTooLargeError,
  getNotificationPreferences,
  getNotificationState,
  isUuidString,
  isNotificationLevel,
  setDefaultNotificationLevel,
  setRoomNotificationPreference,
} from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import {
  publishNotificationStateSnapshot,
  recomputeAndPublishNotificationState,
} from "../realtime/ws-publisher";

export interface NotificationPreferenceRoutesDeps {
  getState?: (userId: string) => Promise<NotificationStateResponse>;
  getPreferences?: (userId: string) => Promise<NotificationPreferencesDto>;
  setDefault?: (
    userId: string,
    level: NotificationLevel,
  ) => Promise<NotificationPreferencesDto>;
  setRoom?: (input: {
    userId: string;
    roomId: string;
    level: "inherit" | NotificationLevel;
  }) => Promise<RoomNotificationPreferenceDto>;
  publishDefaultChange?: (
    userId: string,
    state: NotificationStateResponse,
  ) => Promise<void> | void;
  publishRoomChange?: (userId: string, roomId: string) => Promise<void>;
  warn?: (message: string) => void;
}

function notificationPreferenceErrorReply(
  error: unknown,
): { status: 400 | 404; body: { error: string; code: string } } | null {
  if (!(error instanceof NotificationPreferenceError)) return null;
  if (error.reason === "not_found") {
    return {
      status: 404,
      body: { error: "Room not found", code: "notification_room_not_found" },
    };
  }
  return {
    status: 400,
    body: {
      error:
        error.reason === "subthread_not_allowed"
          ? "Subthreads inherit their parent Room notification preference"
          : "Notification preferences require a live conversational Room",
      code: `notification_${error.reason}`,
    },
  };
}

export function notificationPreferenceRoutes(
  app: FastifyInstance,
  deps: NotificationPreferenceRoutesDeps = {},
): void {
  const warnMessage = deps.warn ?? warn;
  const getPreferences =
    deps.getPreferences ??
    ((userId: string) =>
      getNotificationPreferences(userId, getServerDirectDb()));
  const getState =
    deps.getState ??
    ((userId: string) => getNotificationState(userId, getServerDirectDb()));
  const setDefault =
    deps.setDefault ??
    ((userId: string, level: NotificationLevel) =>
      setDefaultNotificationLevel(userId, level, getServerDirectDb()));
  const setRoom =
    deps.setRoom ??
    ((input: {
      userId: string;
      roomId: string;
      level: "inherit" | NotificationLevel;
    }) => setRoomNotificationPreference(input, getServerDirectDb()));
  const publishDefaultChange =
    deps.publishDefaultChange ??
    ((userId: string, state: NotificationStateResponse) =>
      publishNotificationStateSnapshot(userId, state));
  const publishRoomChange =
    deps.publishRoomChange ??
    ((userId: string, roomId: string) =>
      recomputeAndPublishNotificationState({
        roomId,
        recipientUserIds: [userId],
      }));

  async function publishAfterCommit(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      warnMessage("[notifications] post-commit recomputation failed");
    }
  }

  app.get("/api/notifications/preferences", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    return reply.send(await getPreferences(userId));
  });

  app.get("/api/notifications/state", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    try {
      return reply.send(await getState(userId));
    } catch (error) {
      if (!(error instanceof NotificationStateTooLargeError)) throw error;
      return reply.code(413).send({
        error: "Notification state exceeds the supported detail limit",
        code: error.code,
      });
    }
  });

  app.put<{ Body: { defaultLevel?: unknown } }>(
    "/api/notifications/preferences",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      if (!isNotificationLevel(request.body?.defaultLevel)) {
        return reply.code(400).send({
          error: "defaultLevel must be none, direct, or all",
          code: "invalid_notification_level",
        });
      }
      const preferences = await setDefault(userId, request.body.defaultLevel);
      await publishAfterCommit(async () => {
        const state = await getState(userId);
        await publishDefaultChange(userId, state);
      });
      return reply.send(preferences);
    },
  );

  app.put<{
    Params: { roomId: string };
    Body: { level?: unknown };
  }>(
    "/api/rooms/:roomId/notification-preference",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      if (!isUuidString(request.params.roomId)) {
        return reply.code(404).send({
          error: "Room not found",
          code: "notification_room_not_found",
        });
      }
      const level = request.body?.level;
      if (level !== "inherit" && !isNotificationLevel(level)) {
        return reply.code(400).send({
          error: "level must be inherit, none, direct, or all",
          code: "invalid_notification_level",
        });
      }
      try {
        const preference = await setRoom({
          userId,
          roomId: request.params.roomId,
          level,
        });
        await publishAfterCommit(() =>
          publishRoomChange(userId, request.params.roomId),
        );
        return reply.send(preference);
      } catch (error) {
        const response = notificationPreferenceErrorReply(error);
        if (!response) throw error;
        return reply.code(response.status).send(response.body);
      }
    },
  );
}
