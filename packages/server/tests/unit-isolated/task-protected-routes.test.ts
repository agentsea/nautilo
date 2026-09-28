import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { NautiloApiClient, type NautiloApiFetch } from "@nautilo/api-client";
import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
} from "@nautilo/api-client";

import {
  createProtectedTaskTestAuthority,
  createProtectedTaskTestComposition,
  ProtectedTaskRouteError,
  resolveOwnedProtectedTaskAuthority,
  type ProtectedTaskRouteAuthority,
  type ProtectedTaskRoutePorts,
} from "../../src/routes/task-protected-composition";
import { protectedTaskRoutes } from "../../src/routes/task-protected-routes";

const TASK = "91000000-0000-4000-8000-000000000001";
const HUMAN = "91000000-0000-4000-8000-000000000002";
const ACTOR = "91000000-0000-4000-8000-000000000003";
const AGENT = "91000000-0000-4000-8000-000000000004";
const OTHER_AGENT = "91000000-0000-4000-8000-000000000007";
const ROOM = "91000000-0000-4000-8000-000000000005";
const NAMESPACE = "91000000-0000-4000-8000-000000000006";
const DOMAIN = "task-domain:one";
const HASH = "A".repeat(43);
const OBJECT = `task:v1:${TASK}:1`;

const authority: ProtectedTaskRouteAuthority = Object.freeze({
  userId: HUMAN, subjectHumanId: HUMAN, actorId: ACTOR, agentId: AGENT,
  deviceId: "device:test", deviceGeneration: 1,
});

const summary = {
  id: TASK, parentTaskId: null, depth: 0, status: "pending", preset: "task",
  scheduleKind: "one_shot", nextFireAt: null, callingRoomId: null,
  content: { dtoVersion: 1 as const, status: "protected" as const,
    objectId: OBJECT, contentRevision: 1, cryptoAccessRevision: 0 },
};

function preparedCreate(): ProtectedTaskPreparedCreateRequestV1 {
  return {
    requestVersion: 1, operation: "create", operationId: "task:create:one",
    planDigestBase64url: HASH, taskId: TASK, expectedContentRevision: 0,
    nextContentRevision: 1, expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0, cryptoObjectId: OBJECT, payloadVersion: 1,
    requiredNamespaceIds: [NAMESPACE], encryptedPayloadBytesBase64url: "Y2lwaGVy",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{ namespaceId: NAMESPACE,
      envelopeBytesBase64url: "ZW52ZWxvcGU" }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    task: { scheduleKind: "one_shot", runAt: "2026-10-01T00:00:00.000Z" },
  };
}

function dualPreparedCreate(): DualTaskPreparedCreateRequestV1 {
  return {
    ...preparedCreate(),
    representation: "dual",
    ordinaryPayloadBytesBase64url: "e30",
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(overrides: Partial<ProtectedTaskRoutePorts> = {}) {
  const calls: unknown[] = [];
  const ports: ProtectedTaskRoutePorts = {
    list: async (input) => { calls.push(input); return [summary]; },
    readDefinition: async (input) => {
      calls.push(input);
      return {
        readVersion: 1, status: "ready", taskId: input.taskId, objectId: input.objectId,
        contentRevision: input.contentRevision,
        cryptoAccessRevision: 0,
        namespaceId: NAMESPACE,
        encryptedPayloadBytesBase64url: "Y2lwaGVy",
        accessManifestBytesBase64url: "bWFuaWZlc3Q",
        accessManifestProofBytesBase64url: [],
        namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
        signerEvidence: [{ kind: "human_device", subjectHumanId: HUMAN,
          committerDeviceId: "device:one", hostAuthorizationRevision: 1,
          signingPublicKeyBase64url: HASH }],
      };
    },
    plan: async (input) => {
      calls.push(input);
      return {
        planVersion: 1, operation: input.request.operation,
        operationId: input.request.operationId, taskId: input.taskId ?? TASK,
        expectedContentRevision: input.taskId === null ? 0 : 1,
        nextContentRevision: input.taskId === null ? 1 : 2,
        expectedCryptoAccessRevision: 0, planDigestBase64url: HASH,
        authority: { requesterHumanId: HUMAN, sourceRoomId: ROOM,
          namespaceId: NAMESPACE, domainId: DOMAIN, expectedAccessRevision: 0,
          expectedPolicyRevision: 1, bindingHashBase64url: HASH, keyGeneration: 1 },
      };
    },
    publishCreate: async (input) => {
      calls.push(input);
      return { taskId: input.prepared.taskId, status: "pending", nextFireAt: null };
    },
    publishUpdate: async (input) => {
      calls.push(input);
      return { ...summary, content: { ...summary.content,
        contentRevision: input.prepared.nextContentRevision } };
    },
    ...overrides,
  };
  const app = Fastify();
  apps.push(app);
  protectedTaskRoutes(app, {
    composition: createProtectedTaskTestComposition({
      authority: createProtectedTaskTestAuthority(), target: authority, ports,
    }),
    resolveAuthorizedRequest: async () => authority,
  });
  const fetchImpl: NautiloApiFetch = async (target, init) => {
    const url = new URL(typeof target === "string" ? target
      : target instanceof URL ? target.href : target.url);
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (typeof value === "string") responseHeaders.set(name, value);
      else if (typeof value === "number") responseHeaders.set(name, String(value));
      else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
    }
    return new Response(response.body, { status: response.statusCode,
      headers: responseHeaders });
  };
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  client.setToken("test-session");
  return { app, client, calls };
}

describe("protected Task routes", () => {
  test("resolves an owner Task through its stored agent instead of the active agent", () => {
    const resolved = resolveOwnedProtectedTaskAuthority(authority, {
      ownerId: HUMAN,
      agentId: OTHER_AGENT,
    });
    expect(resolved).toEqual({ ...authority, agentId: OTHER_AGENT });
    expect(resolved?.subjectHumanId).toBe(authority.subjectHumanId);
    expect(resolved?.deviceId).toBe(authority.deviceId);
    expect(authority.agentId).toBe(AGENT);
  });

  test("keeps cross-owner Task agent resolution closed", () => {
    expect(resolveOwnedProtectedTaskAuthority(authority, {
      ownerId: "91000000-0000-4000-8000-000000000008",
      agentId: OTHER_AGENT,
    })).toBeNull();
    expect(resolveOwnedProtectedTaskAuthority(authority, {
      ownerId: HUMAN,
      agentId: AGENT,
    })).toBe(authority);
  });

  test("carries plans, exact ciphertext, and prepared publications through one authority", async () => {
    const state = fixture();
    const list = await state.client.listProtectedTaskContentV1({ includeTerminal: true });
    expect(list[0]?.content.status).toBe("protected");
    const plan = await state.client.planProtectedTaskCreateV1({
      operationId: "task:create:one",
      task: { scheduleKind: "one_shot", runAt: "2026-10-01T00:00:00.000Z" },
    });
    expect(plan).toMatchObject({ taskId: TASK, authority: { namespaceId: NAMESPACE } });
    expect((await state.client.planProtectedTaskUpdateV1(TASK, {
      operationId: "task:update:one", current: summary, task: {},
    })).nextContentRevision).toBe(2);
    const envelope = await state.client.getProtectedTaskDefinitionEnvelopeV1(
      TASK, summary.content,
    );
    expect(envelope.status).toBe("ready");
    if (envelope.status !== "ready") throw new Error("Expected a ready Task envelope");
    expect(envelope.signerEvidence).toHaveLength(1);
    expect(envelope.signerEvidence[0]).toMatchObject({
      kind: "human_device", subjectHumanId: HUMAN,
    });
    expect((await state.client.createPreparedTaskV1(preparedCreate())).taskId).toBe(TASK);
    const update: ProtectedTaskPreparedUpdateRequestV1 = {
      ...preparedCreate(), operation: "update", expectedContentRevision: 1,
      nextContentRevision: 2, task: {},
    };
    expect((await state.client.updatePreparedTaskV1(TASK, update)).content)
      .toMatchObject({ status: "protected", contentRevision: 2 });
    expect(state.calls).toHaveLength(6);
    expect(state.calls.every((call) =>
      (call as { authority: unknown }).authority === authority)).toBe(true);
  });

  test("keeps the route family absent unless explicitly registered and rejects substitution", async () => {
    const absent = Fastify();
    apps.push(absent);
    expect((await absent.inject({ method: "GET", url: "/api/protected/tasks" })).statusCode)
      .toBe(404);
    const state = fixture({
      readDefinition: async () => ({
        readVersion: 1, status: "ready", taskId: TASK, objectId: "substituted", contentRevision: 1,
        cryptoAccessRevision: 0, namespaceId: NAMESPACE,
        encryptedPayloadBytesBase64url: "YQ", accessManifestBytesBase64url: "YQ",
        accessManifestProofBytesBase64url: [], namespaceEnvelopeBytesBase64url: "YQ",
        signerEvidence: [],
      }),
    });
    expect((await state.app.inject({ method: "POST",
      url: "/api/protected/tasks/publication",
      payload: { ...preparedCreate(), plaintext: "secret" } })).statusCode).toBe(400);
    const substituted = await state.app.inject({ method: "GET",
      url: `/api/protected/tasks/${TASK}/definition?objectId=${encodeURIComponent(OBJECT)}&contentRevision=1&cryptoAccessRevision=0` });
    expect(substituted.statusCode).toBe(500);
    expect(substituted.body).not.toContain("secret");
  });

  test("publishes each dual body through one HTTP call and one route-port call", async () => {
    const state = fixture();
    expect((await state.client.createDualPreparedTaskV1(dualPreparedCreate())).taskId)
      .toBe(TASK);
    const update: DualTaskPreparedUpdateRequestV1 = {
      ...dualPreparedCreate(),
      operation: "update",
      expectedContentRevision: 1,
      nextContentRevision: 2,
      task: {},
    };
    expect((await state.client.updateDualPreparedTaskV1(TASK, update)).content)
      .toMatchObject({ status: "protected", contentRevision: 2 });
    expect(state.calls).toHaveLength(2);
    expect(state.calls[0]).toMatchObject({
      prepared: { representation: "dual", operation: "create" },
    });
    expect(state.calls[1]).toMatchObject({
      prepared: { representation: "dual", operation: "update" },
    });
  });

  test("rejects ordinary list content before serialization", async () => {
    const state = fixture({
      list: async () => [{
        ...summary,
        content: { dtoVersion: 1, status: "ordinary",
          promptPreview: "must-not-serialize", lastError: null },
      }],
    });
    const response = await state.app.inject({ method: "GET", url: "/api/protected/tasks" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("must-not-serialize");
  });

  test("returns typed unavailable without consulting the genesis reader", async () => {
    const state = fixture();
    const result = await state.client.getProtectedTaskDefinitionEnvelopeV1(TASK, {
      ...summary.content,
      cryptoAccessRevision: 1,
    });
    expect(result).toEqual({
      readVersion: 1,
      status: "unavailable",
      taskId: TASK,
      objectId: OBJECT,
      contentRevision: 1,
      cryptoAccessRevision: 1,
      reason: "unsupported_crypto_access_revision",
    });
    expect(state.calls).toHaveLength(0);
  });

  test("marks authorized protected reads private and viewer-specific", async () => {
    const state = fixture();
    for (const url of [
      "/api/protected/tasks",
      `/api/protected/tasks/${TASK}/definition?objectId=${encodeURIComponent(OBJECT)}&contentRevision=1&cryptoAccessRevision=0`,
    ]) {
      const response = await state.app.inject({ method: "GET", url });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.vary).toBe("Authorization");
    }
  });

  test("maps closed production failures without leaking ciphertext", async () => {
    const state = fixture({
      plan: async () => {
        throw new ProtectedTaskRouteError(
          409,
          "task_authority_unavailable",
          "Task authority is unavailable",
        );
      },
    });
    const response = await state.app.inject({
      method: "POST",
      url: "/api/protected/tasks/publication-plan",
      payload: {
        requestVersion: 1,
        operation: "create",
        operationId: "task:create:error",
        task: {},
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string; message: string }>()).toEqual({
      error: "task_authority_unavailable",
      message: "Task authority is unavailable",
    });
    expect(response.body).not.toContain("cipher");
  });
});
