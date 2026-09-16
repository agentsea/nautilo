/**
 * D124 — read-state routes enforce room membership (B1), hermetic.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";

const assertUserCanAccessMessage = mock(async (_messageId: number, _userId: string) => {});
const getHumanSenderUserIdForMessageBroadcast = mock(async (_messageId: number) => null as string | null);
const markRead = mock(async () => ({ flipped: false, roomId: null as string | null }));
const markDelivered = mock(async () => {});
const getMessageReadState = mock(async () => ({
  shape: "1:1" as const,
  selfDelivered: false,
  selfRead: true,
  recipientCount: 1,
  deliveredCount: 0,
  readCount: 1,
}));

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    assertUserCanAccessMessage,
    getHumanSenderUserIdForMessageBroadcast,
    markRead,
    markDelivered,
    getMessageReadState,
  };
});

import { MessageAccessError } from "@nautilo/trust";
import { messagesReadStateRoutes } from "../../src/routes/messages-readstate";

afterAll(() => {
  mock.restore();
});

function makeApp(sessionUserId: string | null) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    (request as { sessionUserId?: string | null }).sessionUserId = sessionUserId;
  });
  messagesReadStateRoutes(app);
  return app;
}

describe("messages read-state membership (B1)", () => {
  test("401 / 404 / 200 matrix for read, read-state, delivered", async () => {
    const app401 = makeApp(null);
    await app401.ready();
    const r401 = await app401.inject({
      method: "POST",
      url: "/api/messages/1/read",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(r401.statusCode).toBe(401);
    await app401.close();

    const appBadId = makeApp("user-1");
    await appBadId.ready();
    const r400 = await appBadId.inject({
      method: "POST",
      url: "/api/messages/nan/read",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(r400.statusCode).toBe(400);
    await appBadId.close();

    assertUserCanAccessMessage.mockImplementation(async () => {
      throw new MessageAccessError("not_found");
    });
    getHumanSenderUserIdForMessageBroadcast.mockClear();
    const app404 = makeApp("user-1");
    await app404.ready();
    const r404 = await app404.inject({
      method: "POST",
      url: "/api/messages/10/read",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(r404.statusCode).toBe(404);
    expect(getHumanSenderUserIdForMessageBroadcast.mock.calls.length).toBe(0);
    await app404.close();

    assertUserCanAccessMessage.mockImplementation(async () => {
      throw new MessageAccessError("forbidden");
    });
    const app404b = makeApp("user-1");
    await app404b.ready();
    const r404b = await app404b.inject({
      method: "GET",
      url: "/api/messages/10/read-state",
    });
    expect(r404b.statusCode).toBe(404);
    await app404b.close();

    assertUserCanAccessMessage.mockImplementation(async () => {});
    getHumanSenderUserIdForMessageBroadcast.mockImplementation(async () => null);
    markRead.mockClear();
    markDelivered.mockClear();
    getMessageReadState.mockClear();
    getHumanSenderUserIdForMessageBroadcast.mockClear();

    const appOk = makeApp("user-1");
    await appOk.ready();
    const okRead = await appOk.inject({
      method: "POST",
      url: "/api/messages/10/read",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(okRead.statusCode).toBe(200);
    expect(assertUserCanAccessMessage).toHaveBeenCalledWith(10, "user-1");
    expect(markRead.mock.calls.length).toBe(1);

    const okState = await appOk.inject({ method: "GET", url: "/api/messages/10/read-state" });
    expect(okState.statusCode).toBe(200);
    expect(getMessageReadState.mock.calls.length).toBe(1);

    const okDel = await appOk.inject({
      method: "POST",
      url: "/api/messages/10/delivered",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(okDel.statusCode).toBe(200);
    expect(markDelivered.mock.calls.length).toBe(1);
    await appOk.close();
  });
});

describe("POST /api/messages/:id/read — Blocker 3 sender self-stamp gate", () => {
  const messageId = 42;
  const userId = "user-recipient";
  const senderId = "user-sender";

  test("sender cannot mark own human-authored message as read", async () => {
    assertUserCanAccessMessage.mockImplementation(async () => {});
    getHumanSenderUserIdForMessageBroadcast.mockImplementation(async () => userId);
    markRead.mockClear();
    getHumanSenderUserIdForMessageBroadcast.mockClear();

    const app = makeApp(userId);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/read`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, noop: "self_stamp_ignored" });
    expect(markRead.mock.calls.length).toBe(0);
    await app.close();
  });

  test("recipient can mark sender's message as read", async () => {
    assertUserCanAccessMessage.mockImplementation(async () => {});
    getHumanSenderUserIdForMessageBroadcast.mockImplementation(async () => senderId);
    markRead.mockClear();
    getHumanSenderUserIdForMessageBroadcast.mockClear();

    const app = makeApp(userId);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/read`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(markRead.mock.calls.length).toBe(1);
    expect(markRead).toHaveBeenCalledWith(messageId, userId);
    await app.close();
  });

  test("assistant/system row passes through unchanged for read", async () => {
    assertUserCanAccessMessage.mockImplementation(async () => {});
    getHumanSenderUserIdForMessageBroadcast.mockImplementation(async () => null);
    markRead.mockClear();
    getHumanSenderUserIdForMessageBroadcast.mockClear();

    const app = makeApp(userId);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/read`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(markRead.mock.calls.length).toBe(1);
    await app.close();
  });
});

describe("POST /api/messages/:id/delivered — Blocker 3 sender self-stamp gate", () => {
  const messageId = 42;
  const userId = "user-recipient";
  const senderId = "user-sender";

  test("sender cannot mark own human-authored message as delivered", async () => {
    assertUserCanAccessMessage.mockImplementation(async () => {});
    getHumanSenderUserIdForMessageBroadcast.mockImplementation(async () => userId);
    markDelivered.mockClear();
    getHumanSenderUserIdForMessageBroadcast.mockClear();

    const app = makeApp(userId);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/delivered`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, noop: "self_stamp_ignored" });
    expect(markDelivered.mock.calls.length).toBe(0);
    await app.close();
  });

  test("recipient can mark sender's message as delivered", async () => {
    assertUserCanAccessMessage.mockImplementation(async () => {});
    getHumanSenderUserIdForMessageBroadcast.mockImplementation(async () => senderId);
    markDelivered.mockClear();
    getHumanSenderUserIdForMessageBroadcast.mockClear();

    const app = makeApp(userId);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/delivered`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(markDelivered.mock.calls.length).toBe(1);
    expect(markDelivered).toHaveBeenCalledWith(messageId, userId);
    await app.close();
  });

  test("assistant/system row passes through unchanged for delivered", async () => {
    assertUserCanAccessMessage.mockImplementation(async () => {});
    getHumanSenderUserIdForMessageBroadcast.mockImplementation(async () => null);
    markDelivered.mockClear();
    getHumanSenderUserIdForMessageBroadcast.mockClear();

    const app = makeApp(userId);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/delivered`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(markDelivered.mock.calls.length).toBe(1);
    await app.close();
  });
});

describe("POST /api/messages/:id/read — Blocker 3 membership regression", () => {
  test("membership failure returns 404 before sender gate", async () => {
    assertUserCanAccessMessage.mockImplementation(async () => {
      throw new MessageAccessError("not_found");
    });
    getHumanSenderUserIdForMessageBroadcast.mockClear();
    markRead.mockClear();

    const app = makeApp("user-1");
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/messages/10/read",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(getHumanSenderUserIdForMessageBroadcast.mock.calls.length).toBe(0);
    expect(markRead.mock.calls.length).toBe(0);
    await app.close();
  });
});
