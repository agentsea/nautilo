import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  NotificationPreferenceError,
  NotificationStateTooLargeError,
} from "@nautilo/trust";
import { notificationPreferenceRoutes } from "../../src/routes/notification-preferences";

const USER = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";
const apps: FastifyInstance[] = [];

function makeApp(
  userId: string | null,
  deps: Parameters<typeof notificationPreferenceRoutes>[1],
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = userId;
  });
  notificationPreferenceRoutes(app, deps);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("notification preference routes", () => {
  test("returns a complete state for only the authenticated Human", async () => {
    const snapshot = {
      generatedAt: "2026-08-03T12:00:00.000Z",
      preferences: { defaultLevel: "direct" as const, roomOverrides: [] },
      totals: { unreadCount: 2, importantUnreadCount: 1 },
      rooms: [],
      subthreads: [],
    };
    const getState = mock(async () => snapshot);
    const app = makeApp(USER, { getState });

    const response = await app.inject({
      method: "GET",
      url: "/api/notifications/state",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(snapshot);
    expect(getState).toHaveBeenCalledWith(USER);
  });

  test("fails oversized complete state without returning partial arrays", async () => {
    const app = makeApp(USER, {
      getState: async () => {
        throw new NotificationStateTooLargeError(10_001);
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/notifications/state",
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: "Notification state exceeds the supported detail limit",
      code: "notification_state_too_large",
    });
    expect(response.json()).not.toHaveProperty("rooms");
  });

  test("uses only authenticated identity for reads and account mutation", async () => {
    const getPreferences = mock(async (userId: string) => ({
      defaultLevel: "direct" as const,
      roomOverrides: [],
      userId,
    }));
    const setDefault = mock(async (userId: string, defaultLevel: "all") => ({
      defaultLevel,
      roomOverrides: [],
      userId,
    }));
    const getState = mock(async () => ({
      generatedAt: "2026-08-03T12:00:00.000Z",
      preferences: { defaultLevel: "all" as const, roomOverrides: [] },
      totals: { unreadCount: 0, importantUnreadCount: 0 },
      rooms: [],
      subthreads: [],
    }));
    const publishDefaultChange = mock(async () => {});
    const app = makeApp(USER, {
      getPreferences: getPreferences as never,
      getState,
      setDefault: setDefault as never,
      publishDefaultChange,
    });

    const read = await app.inject({
      method: "GET",
      url: "/api/notifications/preferences",
    });
    expect(read.statusCode).toBe(200);
    expect(getPreferences).toHaveBeenCalledWith(USER);

    const update = await app.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      payload: { defaultLevel: "all", userId: "attacker" },
    });
    expect(update.statusCode).toBe(200);
    expect(setDefault).toHaveBeenCalledWith(USER, "all");
    expect(getState).toHaveBeenCalledWith(USER);
    expect(publishDefaultChange).toHaveBeenCalledTimes(1);
  });

  test("does not leak post-commit failure details into diagnostics", async () => {
    const secretCanary = "M237-PRIVATE-NOTIFICATION-CONTENT";
    const warn = mock((_message: string) => {});
    const app = makeApp(USER, {
      getPreferences: async () => ({
        defaultLevel: "all",
        roomOverrides: [],
        userId: USER,
      }),
      getState: async () => {
        throw new Error(secretCanary);
      },
      setDefault: async () => ({
        defaultLevel: "all",
        roomOverrides: [],
        userId: USER,
      }),
      warn,
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      payload: { defaultLevel: "all" },
    });

    expect(response.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      "[notifications] post-commit recomputation failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretCanary);
  });

  test("rejects invalid levels and unauthenticated callers", async () => {
    const app = makeApp(null, {});
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/notifications/preferences",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/notifications/state",
        })
      ).statusCode,
    ).toBe(401);

    const authenticated = makeApp(USER, {});
    const invalid = await authenticated.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      payload: { defaultLevel: "loud" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      code: "invalid_notification_level",
    });
  });

  test("returns effective inheritance and fail-closed Room errors", async () => {
    const setRoom = mock(async (input: {
      userId: string;
      roomId: string;
      level: "inherit" | "none" | "direct" | "all";
    }) => {
      if (input.level === "none") {
        throw new NotificationPreferenceError("not_found");
      }
      if (input.level === "all") {
        throw new NotificationPreferenceError("subthread_not_allowed");
      }
      return {
        roomId: input.roomId,
        effectiveLevel: "direct" as const,
        inherited: true,
        overrideLevel: null,
      };
    });
    const publishRoomChange = mock(async () => {});
    const app = makeApp(USER, { setRoom, publishRoomChange });

    const inherit = await app.inject({
      method: "PUT",
      url: `/api/rooms/${ROOM}/notification-preference`,
      payload: { level: "inherit" },
    });
    expect(inherit.statusCode).toBe(200);
    expect(inherit.json()).toMatchObject({
      roomId: ROOM,
      effectiveLevel: "direct",
      inherited: true,
    });
    expect(setRoom).toHaveBeenCalledWith({
      userId: USER,
      roomId: ROOM,
      level: "inherit",
    });
    expect(publishRoomChange).toHaveBeenCalledWith(USER, ROOM);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/rooms/${ROOM}/notification-preference`,
          payload: { level: "none" },
        })
      ).statusCode,
    ).toBe(404);
    const subthread = await app.inject({
      method: "PUT",
      url: `/api/rooms/${ROOM}/notification-preference`,
      payload: { level: "all" },
    });
    expect(subthread.statusCode).toBe(400);
    expect(subthread.json()).toMatchObject({
      code: "notification_subthread_not_allowed",
    });
  });
});
