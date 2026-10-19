import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { NautiloApiClient, type NautiloApiFetch } from "@nautilo/api-client";
import {
  encodeTaskPayloadV1,
  TASK_PAYLOAD_MAX_TEXT_BYTES_V1,
} from "@nautilo/lattice-bridge";
import {
  LATTICE_LIMITS,
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
} from "@nautilo/lattice-crypto/wire-limits";
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
const RUN = "91000000-0000-4000-8000-000000000009";
const HUMAN = "91000000-0000-4000-8000-000000000002";
const ACTOR = "91000000-0000-4000-8000-000000000003";
const AGENT = "91000000-0000-4000-8000-000000000004";
const OTHER_AGENT = "91000000-0000-4000-8000-000000000007";
const ROOM = "91000000-0000-4000-8000-000000000005";
const NAMESPACE = "91000000-0000-4000-8000-000000000006";
const DOMAIN = "task-domain:one";
const HASH = "A".repeat(43);
const OBJECT = `task:v1:${TASK}:1`;
const RESULT_OBJECT = `task-run-result:v1:${"a".repeat(64)}`;
const bearer = { authorization: "Bearer test-session" } as const;
const readAuthority = {
  sourceRoomId: ROOM, namespaceId: NAMESPACE, currentGeneration: 0,
  retainedGenerations: [{ generation: 0, accessRevision: 0,
    headDigestBase64url: HASH, publicationDigestBase64url: HASH,
    publicationSetDigestBase64url: HASH, audienceFingerprintBase64url: HASH }],
};

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

function maximumPreparedCreate(dual: boolean) {
  const prepared = {
    ...preparedCreate(),
    encryptedPayloadBytesBase64url: "A".repeat(Math.ceil(
      MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2 * 4 / 3,
    )),
    accessManifestBytesBase64url: "A".repeat(Math.ceil(
      MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5 * 4 / 3,
    )),
    namespaceEnvelopes: [{
      namespaceId: NAMESPACE,
      envelopeBytesBase64url: "A".repeat(Math.ceil(
        MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2 * 4 / 3,
      )),
    }],
    signedPublicationRequestBytesBase64url: "A".repeat(Math.ceil(
      LATTICE_LIMITS.plaintextBytes * 4 / 3,
    )),
  };
  if (!dual) return prepared;
  const content = encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "x".repeat(TASK_PAYLOAD_MAX_TEXT_BYTES_V1),
    expectedOutput: null,
    protectedMetadata: {},
  });
  try {
    return { ...prepared, representation: "dual" as const,
      ordinaryPayloadBytesBase64url: Buffer.from(content).toString("base64url") };
  } finally { content.fill(0); }
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
        cryptoAccessRevision: input.cryptoAccessRevision,
        namespaceId: NAMESPACE, readAuthority,
        encryptedPayloadBytesBase64url: "Y2lwaGVy",
        accessManifestBytesBase64url: "bWFuaWZlc3Q",
        accessManifestProofBytesBase64url: Array.from(
          { length: input.cryptoAccessRevision }, () => "YQ",
        ),
        namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
        signerEvidence: [{ kind: "human_device", subjectHumanId: HUMAN,
          committerDeviceId: "device:one", hostAuthorizationRevision: 1,
          signingPublicKeyBase64url: HASH }],
      };
    },
    readRunResult: async (input) => {
      calls.push(input);
      return {
        readVersion: 1, status: "ready", taskId: input.taskId,
        taskRunId: input.taskRunId, objectId: RESULT_OBJECT,
        resultRevision: 1, cryptoAccessRevision: 0, namespaceId: NAMESPACE, readAuthority,
        encryptedPayloadBytesBase64url: "Y2lwaGVy",
        accessManifestBytesBase64url: "bWFuaWZlc3Q",
        accessManifestProofBytesBase64url: [],
        namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
        signerEvidence: [{ kind: "agent_runtime_publication",
          evidenceBytesBase64url: "ZXZpZGVuY2U" }],
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
    const result = await state.client.getProtectedTaskRunResultEnvelopeV1(
      TASK,
      RUN,
    );
    expect(result).toMatchObject({
      status: "ready", taskId: TASK, taskRunId: RUN,
      objectId: RESULT_OBJECT, resultRevision: 1,
      signerEvidence: [{ kind: "agent_runtime_publication" }],
    });
    expect((await state.client.createPreparedTaskV1(preparedCreate())).taskId).toBe(TASK);
    const update: ProtectedTaskPreparedUpdateRequestV1 = {
      ...preparedCreate(), operation: "update", expectedContentRevision: 1,
      nextContentRevision: 2, task: {},
    };
    expect((await state.client.updatePreparedTaskV1(TASK, update)).content)
      .toMatchObject({ status: "protected", contentRevision: 2 });
    expect(state.calls).toHaveLength(7);
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
        cryptoAccessRevision: 0, namespaceId: NAMESPACE, readAuthority,
        encryptedPayloadBytesBase64url: "YQ", accessManifestBytesBase64url: "YQ",
        accessManifestProofBytesBase64url: [], namespaceEnvelopeBytesBase64url: "YQ",
        signerEvidence: [],
      }),
    });
    expect((await state.app.inject({ method: "POST",
      url: "/api/protected/tasks/publication",
      headers: bearer,
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

  test("forwards a dynamic access head to the protected reader", async () => {
    const state = fixture();
    const result = await state.client.getProtectedTaskDefinitionEnvelopeV1(TASK, {
      ...summary.content,
      cryptoAccessRevision: 1,
    });
    expect(result).toMatchObject({
      status: "ready", taskId: TASK, objectId: OBJECT,
      contentRevision: 1, cryptoAccessRevision: 1,
      accessManifestProofBytesBase64url: ["YQ"],
    });
    expect(state.calls).toHaveLength(1);
  });

  test("returns waiting and unavailable TaskRun result states without plaintext", async () => {
    const waiting = fixture({
      readRunResult: async (input) => ({
        readVersion: 1, status: "waiting", taskId: input.taskId,
        taskRunId: input.taskRunId, objectId: RESULT_OBJECT,
        resultRevision: 1, cryptoAccessRevision: 0,
        reason: "result_not_mapped",
      }),
    });
    expect(await waiting.client.getProtectedTaskRunResultEnvelopeV1(TASK, RUN))
      .toMatchObject({ status: "waiting", reason: "result_not_mapped" });

    const unavailable = fixture({
      readRunResult: async (input) => ({
        readVersion: 1, status: "unavailable", taskId: input.taskId,
        taskRunId: input.taskRunId, objectId: RESULT_OBJECT,
        resultRevision: 1, cryptoAccessRevision: 0,
        reason: "authority_changed",
      }),
    });
    const response = await unavailable.app.inject({
      method: "GET",
      url: `/api/protected/tasks/${TASK}/runs/${RUN}/result`,
    });
    expect(response.json()).toMatchObject({
      status: "unavailable", reason: "authority_changed",
    });
    expect(response.body).not.toContain("resultText");
    expect(response.body).not.toContain("lastError");
  });

  test("rejects TaskRun result substitution and query-bearing reads", async () => {
    const state = fixture({
      readRunResult: async (input) => ({
        readVersion: 1, status: "waiting", taskId: input.taskId,
        taskRunId: "91000000-0000-4000-8000-000000000010",
        objectId: RESULT_OBJECT, resultRevision: 1, cryptoAccessRevision: 0,
        reason: "result_not_mapped",
      }),
    });
    expect((await state.app.inject({
      method: "GET",
      url: `/api/protected/tasks/${TASK}/runs/${RUN}/result?plaintext=true`,
    })).statusCode).toBe(400);
    expect((await state.app.inject({
      method: "GET",
      url: `/api/protected/tasks/${TASK}/runs/${RUN}/result`,
    })).statusCode).toBe(500);
  });

  test("marks authorized protected reads private and viewer-specific", async () => {
    const state = fixture();
    for (const url of [
      "/api/protected/tasks",
      `/api/protected/tasks/${TASK}/definition?objectId=${encodeURIComponent(OBJECT)}&contentRevision=1&cryptoAccessRevision=0`,
      `/api/protected/tasks/${TASK}/runs/${RUN}/result`,
    ]) {
      const response = await state.app.inject({ method: "GET", url });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.vary).toBe("Authorization");
    }
    const plan = await state.app.inject({
      method: "POST", url: `/api/protected/tasks/${TASK}/publication-plan`,
      headers: bearer,
      payload: { requestVersion: 1, operation: "update",
        operationId: "task:repair:private-plan", task: {} },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.headers["cache-control"]).toBe("private, no-store");
    expect(plan.headers.vary).toBe("Authorization");
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
      headers: bearer,
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

  test("admits maximum protected and dual create and update publications", async () => {
    const state = fixture();
    for (const dual of [false, true]) {
      const create = maximumPreparedCreate(dual);
      expect((await state.app.inject({ method: "POST",
        url: "/api/protected/tasks/publication", headers: bearer,
        payload: create })).statusCode).toBe(201);
      expect((await state.app.inject({ method: "PATCH",
        url: `/api/protected/tasks/${TASK}/publication`, headers: bearer,
        payload: { ...create, operation: "update",
          expectedContentRevision: 1, nextContentRevision: 2 } })).statusCode)
        .toBe(200);
    }
    expect(state.calls).toHaveLength(4);
  });

  test("admits maximum operational publication plans", async () => {
    const state = fixture();
    const empty = JSON.stringify({ cron: "" }).length;
    const task = { cron: "x".repeat(LATTICE_LIMITS.plaintextBytes - empty) };
    expect(JSON.stringify(task)).toHaveLength(LATTICE_LIMITS.plaintextBytes);
    for (const request of [
      { url: "/api/protected/tasks/publication-plan",
        payload: { requestVersion: 1, operation: "create",
          operationId: "task:create:maximum-plan", task } },
      { url: `/api/protected/tasks/${TASK}/publication-plan`,
        payload: { requestVersion: 1, operation: "update",
          operationId: "task:update:maximum-plan", task } },
    ]) expect((await state.app.inject({ method: "POST", headers: bearer,
      ...request })).statusCode).toBe(200);
    expect(state.calls).toHaveLength(2);
  });

  test("rejects a missing bearer before parsing a large publication or calling ports", async () => {
    const state = fixture();
    const response = await state.app.inject({ method: "POST",
      url: "/api/protected/tasks/publication",
      payload: maximumPreparedCreate(true) });
    expect(response.statusCode).toBe(401);
    expect(state.calls).toEqual([]);
  });
});
