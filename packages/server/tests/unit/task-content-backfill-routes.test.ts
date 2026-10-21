import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { ClassifiedDataOperationError } from "@nautilo/lattice-bridge";

import {
  taskContentBackfillRoutes,
  type TaskContentBackfillRouteServices,
} from "../../src/routes/task-content-backfill-routes";

const USER = "40000000-0000-4000-8000-000000000001";
const HUMAN = "40000000-0000-4000-8000-000000000002";
const TASK = "40000000-0000-4000-8000-000000000003";
const CLAIM = "40000000-0000-4000-8000-000000000004";
const ROOM = "40000000-0000-4000-8000-000000000005";
const NAMESPACE = "40000000-0000-4000-8000-000000000006";
const NOW = 10_000;
const DIGEST = "A".repeat(43);

const candidate = Object.freeze({
  kind: "definition" as const,
  taskId: TASK,
  sourceCreatedAt: new Date(1_000),
  sourceUpdatedAt: new Date(2_000),
  sourceRevision: 0,
  sourceStatus: "paused",
});

const claim = Object.freeze({
  claimId: CLAIM,
  humanActorId: HUMAN,
  requesterUserId: USER,
  deviceId: "device.current",
  policyRevision: 7,
  expiresAt: new Date(NOW + 1_000),
  candidate,
});

const plan = Object.freeze({
  planVersion: 1 as const,
  claimId: CLAIM,
  operationId: `task-historical-publish:${"a".repeat(64)}`,
  coordinate: Object.freeze({
    kind: "definition" as const,
    taskId: TASK,
    contentRevision: 1 as const,
  }),
  objectId: `task-historical:v1:${"a".repeat(64)}`,
  namespaceId: NAMESPACE,
  domainId: "domain.current",
  requesterHumanId: HUMAN,
  deviceId: "device.current",
  hostAuthorizationRevision: 3,
  expectedAccessRevision: 0,
  expectedPolicyRevision: 7,
  keyGeneration: 0,
  bindingHashBase64url: DIGEST,
  sourceDigestBase64url: DIGEST,
  sourcePayloadHashBase64url: DIGEST,
  operationalFieldsDigestBase64url: DIGEST,
  planDigestBase64url: DIGEST,
  expiresAt: NOW + 1_000,
});

const admission = Object.freeze({
  deviceId: "device.current",
  deviceGeneration: 1,
  serverInstanceId: "server.current",
  lineageGeneration: 1,
  epoch: 2,
  securityRevision: 3,
  headDigest: new Uint8Array(32).fill(4),
  expiresAt: NOW + 1_000,
});

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

function fixture(overrides: Readonly<{
  authenticated?: boolean;
  admitted?: boolean;
  active?: boolean;
  services?: Partial<TaskContentBackfillRouteServices>;
}> = {}) {
  const calls: Array<Readonly<{ operation: string; args: readonly unknown[] }>> = [];
  let publishedReferences: readonly Uint8Array[] = [];
  let policyChecks = 0;
  const scan = {
    discover: async (...args: Parameters<TaskContentBackfillRouteServices["scan"]["discover"]>) => {
      calls.push({ operation: "discover", args });
      return { status: "ready" as const, value: {
        status: "candidate" as const,
        candidate,
        policyRevision: 7,
        requesterUserId: USER,
      } };
    },
    claim: async (...args: Parameters<TaskContentBackfillRouteServices["scan"]["claim"]>) => {
      calls.push({ operation: "claim", args });
      return { status: "ready" as const, value: { status: "claimed" as const, claim } };
    },
    progress: async (...args: Parameters<TaskContentBackfillRouteServices["scan"]["progress"]>) => {
      calls.push({ operation: "progress", args });
      return { status: "ready" as const, value: {
        eligibleDefinitions: 2,
        mappedDefinitions: 1,
        eligibleResults: 3,
        mappedResults: 1,
        claimedRepairing: 1,
        waiting: 1,
        unsupported: 0,
        failed: 0,
        noContent: 0,
        pending: 3,
      } };
    },
    release: async (...args: Parameters<TaskContentBackfillRouteServices["scan"]["release"]>) => {
      calls.push({ operation: "release", args });
      return { status: "ready" as const, value: false };
    },
    acknowledge: async (...args: Parameters<TaskContentBackfillRouteServices["scan"]["acknowledge"]>) => {
      calls.push({ operation: "ack", args });
      return { status: "ready" as const, value: "lease_lost" as const };
    },
  };
  const publication = {
    source: async (...args: Parameters<TaskContentBackfillRouteServices["publication"]["source"]>) => {
      calls.push({ operation: "source", args });
      return { status: "source" as const, sourceRoomId: ROOM, plan,
        payloadBytesBase64url: "e30" };
    },
    publish: async (...args: Parameters<TaskContentBackfillRouteServices["publication"]["publish"]>) => {
      calls.push({ operation: "publish", args });
      const upload = args[2];
      publishedReferences = Object.freeze(Object.values(upload));
      expect(upload).toEqual({
        payloadBytes: new Uint8Array([2]),
        manifestBytes: new Uint8Array([3]),
        envelopeBytes: new Uint8Array([4]),
        signedPublicationRequestBytes: new Uint8Array([1]),
      });
      return true;
    },
    recover: async (...args: Parameters<TaskContentBackfillRouteServices["publication"]["recover"]>) => {
      calls.push({ operation: "recover", args });
      return false;
    },
  };
  const services = {
    scan,
    publication,
    isActive: async () => {
      policyChecks += 1;
      return overrides.active !== false;
    },
    now: () => NOW,
    ...overrides.services,
  } as TaskContentBackfillRouteServices;
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("cryptoDeviceAdmission", null);
  app.addHook("preHandler", async request => {
    request.sessionUserId = overrides.authenticated === false ? null : USER;
    request.sessionActorId = overrides.authenticated === false ? null : HUMAN;
    request.cryptoDeviceAdmission = overrides.admitted === false ? null : admission;
  });
  taskContentBackfillRoutes(app, services);
  return { app, calls, publishedReferences: () => publishedReferences,
    policyChecks: () => policyChecks };
}

describe("Task content backfill routes", () => {
  test("derives identity from the authenticated current device and normalizes structural dates", async () => {
    const f = fixture();
    const discover = await f.app.inject({
      method: "POST",
      url: "/api/tasks/content/backfill/discover",
      payload: {},
    });
    expect(discover.statusCode).toBe(200);
    expect(discover.json<unknown>()).toEqual({ status: "ready", value: {
      status: "candidate",
      candidate: {
        kind: "definition",
        taskId: TASK,
        sourceCreatedAt: 1_000,
        sourceUpdatedAt: 2_000,
        sourceRevision: 0,
        sourceStatus: "paused",
      },
      policyRevision: 7,
    } });
    expect(discover.body).not.toContain(USER);

    const claimed = await f.app.inject({
      method: "POST",
      url: "/api/tasks/content/backfill/claim",
      payload: {
        candidate: {
          kind: "definition",
          taskId: TASK,
          sourceCreatedAt: 1_000,
          sourceUpdatedAt: 2_000,
          sourceRevision: 0,
          sourceStatus: "paused",
        },
        policyRevision: 7,
      },
    });
    expect(claimed.json<unknown>()).toMatchObject({ status: "ready", value: {
      status: "claimed",
      claim: { claimId: CLAIM, expiresAt: NOW + 1_000 },
    } });
    const claimCall = f.calls.find(({ operation }) => operation === "claim");
    expect(claimCall?.args[0]).toMatchObject({
      userId: USER,
      humanActorId: HUMAN,
      admission: { deviceId: "device.current" },
    });
    expect(claimCall?.args[1]).toMatchObject({
      candidate: { sourceCreatedAt: new Date(1_000), sourceUpdatedAt: new Date(2_000) },
    });
  });

  test("carries source, publication, recovery, progress, release, and acknowledgement", async () => {
    const f = fixture();
    expect((await f.app.inject({ method: "POST", url: "/api/tasks/content/backfill/source",
      payload: { claimId: CLAIM } })).json<unknown>()).toMatchObject({
      status: "source",
      sourceRoomId: ROOM,
      plan: { claimId: CLAIM },
      payloadBytesBase64url: "e30",
    });
    expect((await f.app.inject({ method: "POST", url: "/api/tasks/content/backfill/publish",
      payload: { claimId: CLAIM, requestBytesBase64url: "AQ",
        payloadBytesBase64url: "Ag", manifestBytesBase64url: "Aw",
        envelopeBytesBase64url: "BA" },
      headers: { authorization: "Bearer session" } })).json<unknown>())
      .toEqual({ status: "published" });
    expect(f.publishedReferences().every(bytes => bytes.every(value => value === 0))).toBeTrue();
    expect((await f.app.inject({ method: "POST", url: "/api/tasks/content/backfill/recover",
      payload: { claimId: CLAIM } })).json<unknown>()).toEqual({ status: "pending" });
    expect((await f.app.inject({ method: "GET", url: "/api/tasks/content/backfill/progress" }))
      .json<unknown>()).toMatchObject({ status: "ready", value: { pending: 3 } });
    expect((await f.app.inject({ method: "POST", url: "/api/tasks/content/backfill/release",
      payload: { claimId: CLAIM, advance: false } })).json<unknown>())
      .toEqual({ status: "ready", value: false });
    expect((await f.app.inject({ method: "POST", url: "/api/tasks/content/backfill/ack",
      payload: { claimId: CLAIM, outcome: "no_content" } })).json<unknown>())
      .toEqual({ status: "ready", value: "lease_lost" });
    expect(f.calls.map(({ operation }) => operation)).toEqual([
      "source", "publish", "recover", "progress", "release", "ack",
    ]);
  });

  test("requires authentication and a nonexpired current device before service access", async () => {
    const unauthenticated = fixture({ authenticated: false });
    expect((await unauthenticated.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/discover", payload: {} })).statusCode).toBe(401);
    expect(unauthenticated.calls).toEqual([]);
    expect(unauthenticated.policyChecks()).toBe(0);

    const unadmitted = fixture({ admitted: false });
    expect((await unadmitted.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/discover", payload: {} })).statusCode).toBe(428);
    expect(unadmitted.calls).toEqual([]);
    expect(unadmitted.policyChecks()).toBe(1);
  });

  test("returns inactive before current-device admission or repair service access", async () => {
    const f = fixture({ admitted: false, active: false });
    const requests = [
      ["POST", "/api/tasks/content/backfill/discover", {}],
      ["POST", "/api/tasks/content/backfill/claim", { arbitrary: true }],
      ["POST", "/api/tasks/content/backfill/source", { arbitrary: true }],
      ["POST", "/api/tasks/content/backfill/publish", { arbitrary: true }],
      ["POST", "/api/tasks/content/backfill/recover", { arbitrary: true }],
      ["GET", "/api/tasks/content/backfill/progress", undefined],
      ["POST", "/api/tasks/content/backfill/release", { arbitrary: true }],
      ["POST", "/api/tasks/content/backfill/ack", { arbitrary: true }],
    ] as const;
    for (const [method, url, payload] of requests) {
      const response = await f.app.inject({ method, url,
        ...(payload === undefined ? {} : { payload }),
        ...(url.endsWith("/publish")
          ? { headers: { authorization: "Bearer session" } } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(200);
      expect(response.json<unknown>(), `${method} ${url}`).toEqual({ status: "inactive" });
    }
    expect(f.policyChecks()).toBe(requests.length);
    expect(f.calls).toEqual([]);
  });

  test("rejects unknown authority fields and oversized publication framing", async () => {
    const f = fixture();
    expect((await f.app.inject({ method: "POST", url: "/api/tasks/content/backfill/claim",
      payload: { candidate: {
        kind: "definition", taskId: TASK, sourceCreatedAt: 1_000,
        sourceUpdatedAt: 2_000, sourceRevision: 0, sourceStatus: "paused",
      }, policyRevision: 7, requesterUserId: USER } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: "/api/tasks/content/backfill/source",
      payload: { claimId: CLAIM, deviceId: "device.other" } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/source?deviceId=device.other",
      payload: { claimId: CLAIM } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/discover",
      payload: [] })).statusCode).toBe(400);
    expect(f.calls).toEqual([]);

    const oversized = await f.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/publish",
      payload: "x".repeat(5_000_000),
      headers: { "content-type": "application/json", authorization: "Bearer session" },
    });
    expect(oversized.statusCode).toBe(413);
    expect(f.calls).toEqual([]);
  });

  test("normalizes only canonical availability failures and preserves inactive scan status", async () => {
    const waiting = fixture({ services: {
      isActive: async () => true,
      publication: {
        source: async () => {
          throw new ClassifiedDataOperationError("authority", "current authority unavailable");
        },
        publish: async () => {
          throw new ClassifiedDataOperationError("integrity", "publication is invalid");
        },
        recover: async () => null,
      },
      scan: {
        discover: async () => ({ status: "inactive" }),
        claim: async () => ({ status: "inactive" }),
        progress: async () => ({ status: "inactive" }),
        release: async () => ({ status: "inactive" }),
        acknowledge: async () => ({ status: "inactive" }),
      },
    } });
    expect((await waiting.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/discover", payload: {} })).json<unknown>())
      .toEqual({ status: "inactive" });
    expect((await waiting.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/source", payload: { claimId: CLAIM } })).json<unknown>())
      .toEqual({ status: "waiting_for_authority", resumeAt: null });
    expect((await waiting.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/publish", payload: {
        claimId: CLAIM, requestBytesBase64url: "AQ", payloadBytesBase64url: "Ag",
        manifestBytesBase64url: "Aw", envelopeBytesBase64url: "BA",
      }, headers: { authorization: "Bearer session" } })).json<unknown>())
      .toEqual({ status: "integrity" });
    expect((await waiting.app.inject({ method: "POST",
      url: "/api/tasks/content/backfill/recover", payload: { claimId: CLAIM } })).json<unknown>())
      .toEqual({ status: "waiting_for_authority" });
  });
});
