import { describe, expect, test } from "bun:test";
import Fastify from "fastify";

import { createProductionLiveShadowMessageComposition } from "../../src/routes/live-shadow-message-composition";
import {
  liveShadowMessageRoutes,
  type LiveShadowMessagePlanComposition,
} from "../../src/routes/live-shadow-message";
import {
  LIVE_SHADOW_LARGE_REQUEST_BODY_LIMIT_BYTES,
} from "../../src/routes/live-shadow-request-boundary";

const USER = "00000000-0000-4000-8000-000000000001";
const HUMAN = "00000000-0000-4000-8000-000000000002";
const ROOM = "00000000-0000-4000-8000-000000000003";

function appWith(input: Readonly<{
  composition: LiveShadowMessagePlanComposition;
  surface: string | null;
  hasCapability?: (userId: string, capability: string) => Promise<boolean>;
}>) {
  const app = Fastify();
  app.addHook("preHandler", (request, _reply, done) => {
    const signedIn = request.headers.authorization === "Bearer ok";
    request.sessionUserId = signedIn ? USER : null;
    request.sessionActorId = signedIn ? HUMAN : null;
    request.policyContext = signedIn
      ? { actorRole: "member" } as typeof request.policyContext
      : null;
    done();
  });
  liveShadowMessageRoutes(app, {
    composition: input.composition,
    clientSessions: {
      inspect: () => input.surface === null
        ? null
        : { initiatingClientSurface: input.surface },
    },
    ...(input.hasCapability ? { hasCapability: input.hasCapability } : {}),
    now: () => 1_800_000_000_000,
  });
  return app;
}

function payload() {
  return {
    requestVersion: 1,
    clientActionSessionId: "browser-session",
    clientDeviceId: "browser-device",
    idempotencyKey: "send-1",
    requestShape: "text_only",
  };
}

describe("live Shadow Message plan route", () => {
  test("requires manage_rooms before planning an everyone notification", async () => {
    let planCalls = 0;
    const capabilityCalls: Array<[string, string]> = [];
    const app = appWith({
      surface: "workbench.browser",
      hasCapability: async (userId, capability) => {
        capabilityCalls.push([userId, capability]);
        return false;
      },
      composition: {
        plan: () => {
          planCalls++;
          return Promise.resolve({ status: "disabled", mode: "plaintext_only" });
        },
        verifyClient: () => Promise.resolve({ status: "conflict" }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${ROOM}/live-shadow/plan`,
        headers: { authorization: "Bearer ok" },
        payload: { ...payload(), mentionEveryone: true },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<Record<string, unknown>>()).toEqual({
        error: "manage_rooms_required",
        code: "manage_rooms_required",
        capability: "manage_rooms",
        message: "The manage_rooms permission is required to notify everyone in this room.",
      });
      expect(capabilityCalls).toEqual([[USER, "manage_rooms"]]);
      expect(planCalls).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("plans an everyone notification when manage_rooms is current", async () => {
    let seen: unknown;
    const app = appWith({
      surface: "workbench.browser",
      hasCapability: async () => true,
      composition: {
        plan: (input) => {
          seen = input;
          return Promise.resolve({ status: "planned", planBytes: new Uint8Array([1]) });
        },
        verifyClient: () => Promise.resolve({ status: "conflict" }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${ROOM}/live-shadow/plan`,
        headers: { authorization: "Bearer ok" },
        payload: { ...payload(), mentionEveryone: true },
      });
      expect(response.statusCode).toBe(200);
      expect(seen).toMatchObject({
        authority: { userId: USER, humanActorId: HUMAN },
        mentionEveryone: true,
      });
    } finally {
      await app.close();
    }
  });

  test("passes V2 opt-in and marker only on modern Browser/Desktop plans", async () => {
    let seen: unknown;
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: (input) => {
          seen = input;
          return Promise.resolve({ status: "planned", planBytes: new Uint8Array([1, 2, 3]),
            authorizationScheme: "human_ai_readable_v2" });
        },
        verifyClient: () => Promise.resolve({ status: "conflict" }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST", url: `/api/rooms/${ROOM}/live-shadow/plan`,
        headers: { authorization: "Bearer ok" },
        payload: { ...payload(), requestVersion: 2 },
      });
      expect(response.statusCode).toBe(200);
      expect(seen).toMatchObject({ requestVersion: 2,
        authority: { userId: USER, humanActorId: HUMAN } });
      expect(response.json<Record<string, unknown>>()).toEqual({ responseVersion: 1, status: "planned",
        authorizationScheme: "human_ai_readable_v2", planBytesBase64url: "AQID" });
    } finally {
      await app.close();
    }
  });
  test("admits the raised body budget only behind a valid bearer structure", async () => {
    let businessCalls = 0;
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({ status: "disabled", mode: "plaintext_only" }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
        admitRuntimeInvocationAuthorization: () => {
          businessCalls += 1;
          return Promise.resolve("authorized" as const);
        },
      },
    });
    const path = `/api/rooms/${ROOM}/live-shadow/runtime-invocation/m315/authorize`;
    for (const authorization of [undefined, "Basic no", "Bearer two tokens"]) {
      const result = await app.inject({
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        payload: "{",
      });
      expect(result.statusCode).toBe(401);
    }
    const parsed = await app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: "Bearer ok",
        "content-type": "application/json",
      },
      payload: "{",
    });
    expect(parsed.statusCode).toBe(400);
    const aboveFastifyDefault = await app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: "Bearer ok",
        "content-type": "application/json",
      },
      payload: {
        requestVersion: 1,
        status: "prepared",
        operationId: "m315",
        clientActionSessionId: "browser-session",
        authorizationScheme: "runtime_foreground_v1",
        authorizationPlanBytesBase64url: "A".repeat(1_100_000),
        authorizationBytesBase64url: "AQ",
      },
    });
    expect(aboveFastifyDefault.statusCode).toBe(200);
    const oversized = await app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: "Bearer ok",
        "content-type": "application/json",
        "content-length": String(
          LIVE_SHADOW_LARGE_REQUEST_BODY_LIMIT_BYTES + 1,
        ),
      },
      payload: "{}",
    });
    expect(oversized.statusCode).toBe(413);
    expect(businessCalls).toBe(1);
    expect(LIVE_SHADOW_LARGE_REQUEST_BODY_LIMIT_BYTES).toBe(42 * 1024 * 1024);
    await app.close();
  });

  test("leaves every retired authority endpoint unregistered", async () => {
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({
          status: "disabled",
          mode: "plaintext_only",
        }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
      },
    });
    const namespaceId = "00000000-0000-4000-8000-000000000004";
    const operationId = "retired-operation";
    const retiredPaths = [
      `/api/rooms/${ROOM}/live-shadow/namespace/plan`,
      `/api/rooms/${ROOM}/live-shadow/namespace/${operationId}/stage`,
      `/api/rooms/${ROOM}/live-shadow/namespace/${operationId}/deliveries`,
      `/api/rooms/${ROOM}/live-shadow/namespace/${operationId}/acknowledge`,
      `/api/rooms/${ROOM}/live-shadow/namespace-authority/${namespaceId}/plan`,
      `/api/rooms/${ROOM}/live-shadow/namespace-authority/${namespaceId}/publish`,
      `/api/rooms/${ROOM}/live-shadow/namespace-authority/${namespaceId}/fetch`,
      `/api/rooms/${ROOM}/live-shadow/namespace-authority/${namespaceId}/acknowledge`,
      `/api/rooms/${ROOM}/live-shadow/namespace-authority/${namespaceId}/recipient-sync/plan`,
      `/api/rooms/${ROOM}/live-shadow/namespace-authority/${namespaceId}/recipient-sync/authorize`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/plan`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/publish`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/recipient-sync/plan`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/recipient-sync/authorize`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/fetch`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/acknowledge`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/bundle/plan`,
      `/api/rooms/${ROOM}/live-shadow/grant-domain/${namespaceId}/bundle/publish`,
    ];
    for (const url of retiredPaths) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer ok" },
        payload: {},
      });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });

  test("tears down only the signed-in Human's foreground sessions", async () => {
    let seen: unknown;
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({ status: "disabled", mode: "plaintext_only" }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
        teardownForegroundAuthorizationSessions: (input) => {
          seen = input;
        },
      },
    });
    expect((await app.inject({
      method: "DELETE",
      url: "/api/live-shadow/foreground-authorization-sessions",
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "DELETE",
      url: "/api/live-shadow/foreground-authorization-sessions",
      headers: { authorization: "Bearer ok" },
    })).statusCode).toBe(204);
    expect(seen).toEqual({
      authority: { userId: USER, humanActorId: HUMAN },
    });
    await app.close();
  });

  test("returns only the signed-in Human's durable recovery result", async () => {
    let seen: unknown;
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({ status: "disabled", mode: "plaintext_only" }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
        recover: (input) => {
          seen = input;
          return Promise.resolve({
            status: "pending",
            state: "planned",
            jobId: null,
          });
        },
      },
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/rooms/${ROOM}/live-shadow/recovery-op/recovery`,
    })).statusCode).toBe(401);
    const result = await app.inject({
      method: "GET",
      url: `/api/rooms/${ROOM}/live-shadow/recovery-op/recovery`,
      headers: { authorization: "Bearer ok" },
    });
    expect(JSON.parse(result.body)).toEqual({
      responseVersion: 1,
      status: "pending",
      state: "planned",
      jobId: null,
    });
    expect(seen).toEqual({
      authority: { userId: USER, humanActorId: HUMAN },
      roomId: ROOM,
      operationId: "recovery-op",
    });
    await app.close();
  });

  test("authorizes shared-Agent output reads and acknowledgements for the signed-in Human", async () => {
    const seen: unknown[] = [];
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({ status: "disabled", mode: "plaintext_only" }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
        planSharedAgentOutputRead: (input) => {
          seen.push(input);
          return Promise.resolve({
            status: "ready" as const,
            subjectHumanId: HUMAN,
            clientDeviceId: "browser-device",
            clientDeviceSigningKeyGeneration: 2,
            hostAuthorizationRevision: 3,
          });
        },
        acknowledgeSharedAgentOutput: (input) => {
          seen.push({
            ...input,
            acknowledgementBytes: input.acknowledgementBytes.slice(),
          });
          return Promise.resolve("verified" as const);
        },
      },
    });
    const executionId = "shared-agent-execution";
    expect((await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/shared-agent-output/${executionId}/read-plan`,
      payload: {
        requestVersion: 1,
        operationId: executionId,
        clientDeviceId: "browser-device",
      },
    })).statusCode).toBe(401);
    const planned = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/shared-agent-output/${executionId}/read-plan`,
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        operationId: executionId,
        clientDeviceId: "browser-device",
      },
    });
    expect(JSON.parse(planned.body)).toMatchObject({
      responseVersion: 1,
      status: "ready",
      subjectHumanId: HUMAN,
    });
    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/shared-agent-output/${executionId}/ack`,
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        operationId: executionId,
        acknowledgementBytesBase64url: "AQ",
      },
    });
    expect(JSON.parse(acknowledged.body)).toEqual({
      responseVersion: 1,
      operationId: executionId,
      status: "verified",
    });
    expect(seen).toEqual([{
      userId: USER,
      actorId: HUMAN,
      roomId: ROOM,
      executionId,
      clientDeviceId: "browser-device",
    }, {
      userId: USER,
      actorId: HUMAN,
      roomId: ROOM,
      executionId,
      acknowledgementBytes: new Uint8Array([1]),
      now: 1_800_000_000_000,
    }]);
    await app.close();
  });

  test("admits only a signed-in Runtime authorization for the exact shared execution", async () => {
    let seen: unknown;
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({ status: "disabled", mode: "plaintext_only" }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
        admitSharedAgentRuntimeAuthorization: (input) => {
          seen = {
            ...input,
            authorizationPlanBytes: input.authorizationPlanBytes.slice(),
            authorizationBytes: input.authorizationBytes.slice(),
          };
          return Promise.resolve("authorized" as const);
        },
      },
    });
    const executionId = "runtime-execution";
    const request = {
      requestVersion: 1,
      status: "prepared",
      operationId: executionId,
      clientActionSessionId: "browser-session",
      authorizationScheme: "runtime_foreground_v1",
      authorizationPlanBytesBase64url: "AQI",
      authorizationBytesBase64url: "AwQ",
    } as const;
    expect((await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/shared-agent/${executionId}/authorize`,
      payload: request,
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/shared-agent/other-execution/authorize`,
      headers: { authorization: "Bearer ok" },
      payload: request,
    })).statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/shared-agent/${executionId}/authorize`,
      headers: { authorization: "Bearer ok" },
      payload: request,
    });
    expect(JSON.parse(response.body)).toEqual({
      responseVersion: 1,
      status: "authorized",
      executionId,
    });
    expect(seen).toEqual({
      operationId: executionId,
      roomId: ROOM,
      clientActionSessionId: "browser-session",
      userId: USER,
      actorId: HUMAN,
      authorizationPlanBytes: new Uint8Array([1, 2]),
      authorizationBytes: new Uint8Array([3, 4]),
      now: 1_800_000_000_000,
    });
    await app.close();
  });

  test("admits Agent-free Runtime authority only at the exact invocation coordinate", async () => {
    let seen: unknown;
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({ status: "disabled", mode: "plaintext_only" }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
        admitRuntimeInvocationAuthorization: (input) => {
          seen = {
            ...input,
            authorizationPlanBytes: input.authorizationPlanBytes.slice(),
            authorizationBytes: input.authorizationBytes.slice(),
          };
          return Promise.resolve("authorized" as const);
        },
      },
    });
    const invocationId = "runtime-invocation";
    const request = {
      requestVersion: 1,
      status: "prepared",
      operationId: invocationId,
      clientActionSessionId: "browser-session",
      authorizationScheme: "runtime_foreground_v1",
      authorizationPlanBytesBase64url: "AQI",
      authorizationBytesBase64url: "AwQ",
    } as const;
    const path = `/api/rooms/${ROOM}/live-shadow/runtime-invocation/${
      invocationId
    }/authorize`;
    expect((await app.inject({
      method: "POST",
      url: path,
      payload: request,
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/runtime-invocation/wrong/authorize`,
      headers: { authorization: "Bearer ok" },
      payload: request,
    })).statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer ok" },
      payload: request,
    });
    expect(JSON.parse(response.body)).toEqual({
      responseVersion: 1,
      status: "authorized",
      invocationId,
    });
    expect(seen).toEqual({
      invocationId,
      roomId: ROOM,
      clientActionSessionId: "browser-session",
      userId: USER,
      actorId: HUMAN,
      authorizationPlanBytes: new Uint8Array([1, 2]),
      authorizationBytes: new Uint8Array([3, 4]),
      now: 1_800_000_000_000,
    });
    await app.close();
  });

  test("registers production without eagerly opening either database", async () => {
    const app = Fastify();
    const composition = createProductionLiveShadowMessageComposition({
      wakeForegroundMemoryEffectRecovery: () => undefined,
    });
    liveShadowMessageRoutes(app, {
      composition,
      clientSessions: { inspect: () => null },
    });
    expect(app.printRoutes()).toContain("plan (POST)");
    expect(app.printRoutes()).toContain("verify (POST)");
    expect(app.printRoutes()).toContain("recovery (GET, HEAD)");
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = composition.runDispatchOnce({
      operationId: "dispatch-once",
      now: 1_800_000_000_000,
      work: async () => {
        calls++;
        await held;
        return "accepted";
      },
    });
    const replay = composition.runDispatchOnce({
      operationId: "dispatch-once",
      now: 1_800_000_000_001,
      work: async () => {
        calls++;
        return "duplicate";
      },
    });
    release();
    expect(await Promise.all([first, replay])).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(calls).toBe(1);
    await composition.shutdown();
    await app.close();
  });

  test("rejects anonymous, malformed, and unsupported-surface plans before composition", async () => {
    let calls = 0;
    const composition: LiveShadowMessagePlanComposition = {
      plan: () => {
        calls++;
        return Promise.resolve({ status: "disabled", mode: "plaintext_only" });
      },
      verifyClient: () => Promise.resolve({ status: "conflict" }),
    };
    const app = appWith({ composition, surface: "mobile.web" });
    expect((await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/plan`,
      payload: payload(),
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/plan`,
      headers: { authorization: "Bearer ok" },
      payload: { ...payload(), requestShape: "attachments" },
    })).statusCode).toBe(400);
    const ineligible = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/plan`,
      headers: { authorization: "Bearer ok" },
      payload: payload(),
    });
    expect(JSON.parse(ineligible.body)).toEqual({
      responseVersion: 1,
      status: "ineligible",
      reason: "client_not_browser",
    });
    expect(calls).toBe(0);
    await app.close();
  });

  test.each([
    "workbench.browser",
    "workbench.desktop",
  ])("passes only server session authority for %s and returns canonical plan bytes", async (surface) => {
    let seen: unknown;
    const app = appWith({
      surface,
      composition: {
        plan: (input) => {
          seen = input;
          return Promise.resolve({
            status: "planned",
            planBytes: new Uint8Array([1, 2, 3]),
          });
        },
        verifyClient: () => Promise.resolve({ status: "conflict" }),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/plan`,
      headers: { authorization: "Bearer ok" },
      payload: payload(),
    });
    expect(JSON.parse(response.body)).toEqual({
      responseVersion: 1,
      status: "planned",
      planBytesBase64url: "AQID",
    });
    expect(seen).toEqual({
      authority: { userId: USER, humanActorId: HUMAN },
      roomId: ROOM,
      clientActionSessionId: "browser-session",
      clientDeviceId: "browser-device",
      idempotencyKey: "send-1",
      now: 1_800_000_000_000,
    });
    await app.close();
  });

  test("marks a Full plan so the client prepares the V2 protected-only request", async () => {
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({ status: "planned",
          planBytes: new Uint8Array([1, 2, 3]),
          representationMode: "full_encryption" }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
      },
    });
    const result = await app.inject({ method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/plan`,
      headers: { authorization: "Bearer ok" }, payload: payload() });
    expect(JSON.parse(result.body)).toEqual({ responseVersion: 1,
      status: "planned", planBytesBase64url: "AQID",
      representationMode: "full_encryption" });
    await app.close();
  });

  test("returns the exact Namespace hint for recipient synchronization", async () => {
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({
          status: "unavailable",
          authorizationScheme: "human_peer_v1",
          reason: "recipient_sync_required",
          requiredNamespaceIds: ["40000000-0000-4000-8000-000000000295"],
        }),
        verifyClient: () => Promise.resolve({ status: "conflict" }),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/plan`,
      headers: { authorization: "Bearer ok" },
      payload: payload(),
    });
    expect(JSON.parse(response.body)).toEqual({
      responseVersion: 1,
      status: "unavailable",
      authorizationScheme: "human_peer_v1",
      reason: "recipient_sync_required",
      requiredNamespaceIds: ["40000000-0000-4000-8000-000000000295"],
    });
    await app.close();
  });

  test("binds signed verification bytes to the authenticated path operation", async () => {
    let seen: unknown;
    const app = appWith({
      surface: "workbench.browser",
      composition: {
        plan: () => Promise.resolve({
          status: "disabled",
          mode: "plaintext_only",
        }),
        verifyClient: (input) => {
          seen = {
            ...input,
            verificationBytes: input.verificationBytes.slice(),
          };
          return Promise.resolve({
            status: "verified",
            operationId: input.operationId,
          });
        },
      },
    });
    const substituted = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/operation-1/verify`,
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        operationId: "operation-2",
        verificationBytesBase64url: "AQ",
      },
    });
    expect(substituted.statusCode).toBe(400);
    expect(seen).toBeUndefined();

    const verified = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM}/live-shadow/operation-1/verify`,
      headers: { authorization: "Bearer ok" },
      payload: {
        requestVersion: 1,
        operationId: "operation-1",
        verificationBytesBase64url: "AQ",
      },
    });
    expect(JSON.parse(verified.body)).toEqual({
      responseVersion: 1,
      status: "verified",
      operationId: "operation-1",
    });
    expect(seen).toEqual({
      authority: { userId: USER, humanActorId: HUMAN },
      roomId: ROOM,
      operationId: "operation-1",
      verificationBytes: new Uint8Array([1]),
      now: 1_800_000_000_000,
    });
    await app.close();
  });

});
