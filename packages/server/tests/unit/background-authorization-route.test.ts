import { describe, expect, test } from "bun:test";
import Fastify from "fastify";

import {
  BackgroundAuthorizationDeviceServiceError,
  backgroundAuthorizationRoutes,
  type BackgroundAuthorizationDeviceService,
} from "../../src/routes/background-authorization";

const USER = "31000000-0000-4000-8000-000000000001";
const HUMAN = "31000000-0000-4000-8000-000000000002";

function fixture(overrides: Partial<BackgroundAuthorizationDeviceService> = {}) {
  const calls: Uint8Array[] = [];
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("cryptoDeviceAdmission", null);
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.headers.authorization === "Bearer ok") {
      request.sessionUserId = USER;
      request.sessionActorId = HUMAN;
      request.cryptoDeviceAdmission = {
        deviceId: "device-m317",
        deviceGeneration: 3,
        serverInstanceId: "server-m317",
        lineageGeneration: 2,
        epoch: 7,
        securityRevision: 9,
        headDigest: Uint8Array.from({ length: 32 }, (_, index) => index),
        expiresAt: Date.now() + 60_000,
      };
    } else if (request.headers.authorization === "Bearer expired") {
      request.sessionUserId = USER;
      request.sessionActorId = HUMAN;
      request.cryptoDeviceAdmission = {
        deviceId: "device-m317",
        deviceGeneration: 3,
        serverInstanceId: "server-m317",
        lineageGeneration: 2,
        epoch: 7,
        securityRevision: 9,
        headDigest: new Uint8Array(32),
        expiresAt: Date.now() - 1,
      };
    }
    done();
  });
  const service: BackgroundAuthorizationDeviceService = {
    limits: {
      requestBytes: 8,
      requestPageBytes: 16,
      maximumRequests: 4,
      responseBytes: 8,
      continuationCharacters: 16,
    },
    list: async (subject, input) => {
      expect(subject).toMatchObject({
        userId: USER,
        humanActorId: HUMAN,
        deviceId: "device-m317",
      });
      return input.continuation === undefined
        ? {
          requests: [{ requestBytes: Uint8Array.of(0, 1, 2, 253, 254, 255) }],
          continuation: "bmV4dA",
        }
        : { requests: [] };
    },
    respond: async (subject, input) => {
      expect(subject.deviceId).toBe("device-m317");
      calls.push(input.responseBytes);
      return { status: "accepted" };
    },
    ...overrides,
  };
  backgroundAuthorizationRoutes(app, service);
  return { app, calls };
}

describe("background authorization device routes", () => {
  test("lists exact opaque bytes with a service-owned continuation", async () => {
    const { app } = fixture();
    const first = await app.inject({
      method: "POST",
      url: "/api/background-authorization/requests/list",
      headers: { authorization: "Bearer ok", "content-type": "application/json" },
      payload: { requestVersion: 1 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    const firstBody: unknown = first.json();
    expect(firstBody).toEqual({
      responseVersion: 1,
      requests: [{ requestBytesBase64url: "AAEC_f7_" }],
      continuation: "bmV4dA",
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/background-authorization/requests/list",
      headers: { authorization: "Bearer ok", "content-type": "application/json" },
      payload: { requestVersion: 1, continuation: "bmV4dA" },
    });
    const secondBody: unknown = second.json();
    expect(secondBody).toEqual({ responseVersion: 1, requests: [] });
    await app.close();
  });

  test("derives identity only from the session and admitted device", async () => {
    let listCalls = 0;
    const { app } = fixture({
      list: async () => {
        listCalls += 1;
        return { requests: [] };
      },
    });
    for (const payload of [
      { requestVersion: 1, userId: USER },
      { requestVersion: 1, humanActorId: HUMAN },
      { requestVersion: 1, deviceId: "spoofed" },
      { requestVersion: 1, roomId: "spoofed" },
      { requestVersion: 1, limit: 1 },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/background-authorization/requests/list",
        headers: { authorization: "Bearer ok", "content-type": "application/json" },
        payload,
      });
      expect([400, 413]).toContain(response.statusCode);
    }
    expect(listCalls).toBe(0);
    await app.close();
  });

  test("rejects missing and expired admission before invoking the service", async () => {
    let listCalls = 0;
    const { app } = fixture({
      list: async () => {
        listCalls += 1;
        return { requests: [] };
      },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/background-authorization/requests/list",
      headers: { "content-type": "application/json" },
      payload: { requestVersion: 1 },
    });
    expect(missing.statusCode).toBe(401);
    const expired = await app.inject({
      method: "POST",
      url: "/api/background-authorization/requests/list",
      headers: { authorization: "Bearer expired", "content-type": "application/json" },
      payload: { requestVersion: 1 },
    });
    expect(expired.statusCode).toBe(428);
    expect(listCalls).toBe(0);
    await app.close();
  });

  test("passes exact response bytes, wipes them, and returns every service status", async () => {
    for (const status of ["accepted", "duplicate", "stale"] as const) {
      let borrowed: Uint8Array | undefined;
      const { app } = fixture({
        respond: async (_subject, input) => {
          borrowed = input.responseBytes;
          expect([...input.responseBytes]).toEqual([0, 1, 2, 253, 254, 255]);
          return { status };
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/background-authorization/respond",
        headers: { authorization: "Bearer ok", "content-type": "application/json" },
        payload: { requestVersion: 1, responseBytesBase64url: "AAEC_f7_" },
      });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(body).toEqual({ responseVersion: 1, status });
      expect([...borrowed!]).toEqual([0, 0, 0, 0, 0, 0]);
      await app.close();
    }
  });

  test("rejects malformed, noncanonical, oversized, and identity-bearing submissions before service", async () => {
    let respondCalls = 0;
    const { app } = fixture({
      respond: async () => {
        respondCalls += 1;
        return { status: "accepted" };
      },
    });
    for (const payload of [
      { requestVersion: 2, responseBytesBase64url: "AQ" },
      { requestVersion: 1, responseBytesBase64url: "AQ==" },
      { requestVersion: 1, responseBytesBase64url: "A" },
      { requestVersion: 1, responseBytesBase64url: "AAAAAAAAAAAA" },
      { requestVersion: 1, responseBytesBase64url: "AQ", deviceId: "spoofed" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/background-authorization/respond",
        headers: { authorization: "Bearer ok", "content-type": "application/json" },
        payload,
      });
      expect([400, 413]).toContain(response.statusCode);
      if (response.statusCode === 400) {
        const body: unknown = response.json();
        expect(body).toEqual({
          responseVersion: 1,
          status: "malformed",
        });
      }
    }
    expect(respondCalls).toBe(0);
    await app.close();
  });

  test("rejects over-count and over-byte discovery pages before serialization", async () => {
    for (const requests of [
      Array.from({ length: 5 }, () => ({ requestBytes: Uint8Array.of(1) })),
      [
        { requestBytes: new Uint8Array(8) },
        { requestBytes: new Uint8Array(8) },
        { requestBytes: Uint8Array.of(1) },
      ],
    ]) {
      const { app } = fixture({ list: async () => ({ requests }) });
      const response = await app.inject({
        method: "POST",
        url: "/api/background-authorization/requests/list",
        headers: {
          authorization: "Bearer ok",
          "content-type": "application/json",
        },
        payload: { requestVersion: 1 },
      });
      expect(response.statusCode).toBe(500);
      await app.close();
    }
  });

  test("maps typed service refusals and propagates unknown failures", async () => {
    for (const [status, statusCode] of [
      ["malformed", 400],
      ["unauthorized", 403],
      ["superseded", 409],
    ] as const) {
      const { app } = fixture({
        respond: () => Promise.reject(
          new BackgroundAuthorizationDeviceServiceError(status),
        ),
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/background-authorization/respond",
        headers: { authorization: "Bearer ok", "content-type": "application/json" },
        payload: { requestVersion: 1, responseBytesBase64url: "AQ" },
      });
      expect(response.statusCode).toBe(statusCode);
      const body: unknown = response.json();
      expect(body).toEqual({ responseVersion: 1, status });
      await app.close();
    }
    const { app } = fixture({
      respond: () => Promise.reject(new Error("unexpected")),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/background-authorization/respond",
      headers: { authorization: "Bearer ok", "content-type": "application/json" },
      payload: { requestVersion: 1, responseBytesBase64url: "AQ" },
    });
    expect(response.statusCode).toBe(500);
    await app.close();
  });

  test("maps typed discovery service errors", async () => {
    for (const [status, statusCode] of [
      ["malformed", 400],
      ["unauthorized", 403],
      ["superseded", 409],
    ] as const) {
      const { app } = fixture({
        list: () => Promise.reject(
          new BackgroundAuthorizationDeviceServiceError(status),
        ),
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/background-authorization/requests/list",
        headers: { authorization: "Bearer ok", "content-type": "application/json" },
        payload: { requestVersion: 1 },
      });
      expect(response.statusCode).toBe(statusCode);
      const body: unknown = response.json();
      expect(body).toEqual({ responseVersion: 1, status });
      await app.close();
    }
  });
});
