import { expect, test } from "bun:test";
import Fastify from "fastify";
import {
  encodeForegroundPendingAttentionCursor,
  foregroundPendingAttentionRoutes,
} from "../../src/routes/foreground-pending-attention";

const ROOM = "00000000-0000-4000-8000-000000000001";
const CHALLENGE = "00000000-0000-4000-8000-000000000002";
const body = { clientActionSessionId: "browser-session", authorizationDeviceId: "current-device" };

function setup(surface: string | null = "workbench.browser") {
  const app = Fastify();
  const calls: unknown[][] = [];
  let receivedBytes: Uint8Array | undefined;
  app.addHook("preHandler", (request, _reply, done) => {
    const signedIn = request.headers.authorization === "Bearer ok";
    request.sessionUserId = signedIn ? "user" : null;
    request.sessionActorId = signedIn ? "human" : null;
    request.policyContext = signedIn ? { actorRole: "member" } as typeof request.policyContext : null;
    done();
  });
  foregroundPendingAttentionRoutes(app, {
    service: {
      page: async (...args) => { calls.push(args); return { status: "ready", events: [], nextCursor: null }; },
      read: async (...args) => { calls.push(args); receivedBytes = args[3]; return { status: "read", events: [] }; },
      cancelForClientSession() {}, cancelForHuman() {}, close() {},
    },
    clientSessions: { inspect: ({ actorId, clientActionSessionId }) =>
      actorId === "human" && clientActionSessionId === body.clientActionSessionId && surface !== null
        ? { initiatingClientSurface: surface } : null },
  });
  return { app, calls, bytes: () => receivedBytes };
}

test("pending attention rejects unauthenticated, invalid, disconnected and frozen-client requests before reading", async () => {
  for (const surface of ["workbench.browser", null, "mobile"]) {
    const { app, calls } = setup(surface);
    try {
      const unauthenticated = await app.inject({ method: "POST", url: `/api/rooms/${ROOM}/pending-attention`, payload: body });
      expect(unauthenticated.statusCode).toBe(401);
      const response = await app.inject({ method: "POST", url: `/api/rooms/${ROOM}/pending-attention`, headers: { authorization: "Bearer ok" }, payload: { ...body, cursor: "not-a-coordinate" } });
      expect(response.statusCode).toBe(400);
      if (surface !== "workbench.browser") {
        const unavailable = await app.inject({ method: "POST", url: `/api/rooms/${ROOM}/pending-attention`, headers: { authorization: "Bearer ok" }, payload: body });
        expect(unavailable.statusCode).toBe(403);
      }
      expect(calls).toEqual([]);
    } finally { await app.close(); }
  }
});

test("read routes bind server identity, return no-store responses and wipe submitted authorization bytes", async () => {
  const { app, calls, bytes } = setup();
  try {
    const page = await app.inject({ method: "POST", url: `/api/rooms/${ROOM}/pending-attention`, headers: { authorization: "Bearer ok" }, payload: body });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("private, no-store");
    expect(page.headers["vary"]).toBe("Authorization");
    expect(calls[0]?.[0]).toEqual({ userId: "user", humanActorId: "human", clientDeviceId: "current-device", clientActionSessionId: "browser-session" });
    const read = await app.inject({ method: "POST", url: `/api/rooms/${ROOM}/pending-attention/read`, headers: { authorization: "Bearer ok" }, payload: { ...body, challengeId: CHALLENGE, authorizationBytesBase64url: "AQID" } });
    expect(read.json<unknown>()).toEqual({ status: "read", events: [] });
    expect(calls[1]?.[1]).toBe(ROOM);
    expect(calls[1]?.[2]).toBe(CHALLENGE);
    expect(Array.from(bytes()!)).toEqual([0, 0, 0]);
    const invalid = await app.inject({ method: "POST", url: `/api/rooms/${ROOM}/pending-attention/read`, headers: { authorization: "Bearer ok" }, payload: { ...body, challengeId: CHALLENGE, authorizationBytesBase64url: "AQID=" } });
    expect(invalid.statusCode).toBe(400);
    expect(calls).toHaveLength(2);
  } finally { await app.close(); }
});

test("page routes accept and forward the opaque creation-order cursor", async () => {
  const { app, calls } = setup();
  const cursor = encodeForegroundPendingAttentionCursor({
    version: 1,
    createdAt: new Date("2026-09-09T14:05:50.985Z"),
    reviewTurnId: "00000000-0000-4000-8000-000000000007",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/pending-attention`,
      headers: { authorization: "Bearer ok" },
      payload: { ...body, cursor },
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.[2]).toBe(cursor);
  } finally { await app.close(); }
});
