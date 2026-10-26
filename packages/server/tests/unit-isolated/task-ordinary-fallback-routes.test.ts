import { afterEach, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { NautiloApiClient, type NautiloApiFetch } from "@nautilo/api-client";
import {
  encodeTaskPayloadV1,
  TASK_PAYLOAD_MAX_TEXT_BYTES_V1,
} from "@nautilo/lattice-bridge";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto/wire-limits";
import { taskOrdinaryFallbackRoutes } from "../../src/routes/task-ordinary-fallback-routes";
import type { TaskOrdinaryFallbackPorts } from "../../src/routes/task-ordinary-fallback-composition";
import { ProtectedTaskRouteError, type ProtectedTaskRouteAuthority } from "../../src/routes/task-protected-composition";

const TASK = "81000000-0000-8000-8000-000000000001";
const authority: ProtectedTaskRouteAuthority = {
  userId: "owner", subjectHumanId: "human", actorId: "human", agentId: "genie", deviceId: "device", deviceGeneration: 1,
};
const digest = "A".repeat(43);
const bearer = { authorization: "Bearer test-only" } as const;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function fixture(authorized = true, failure = false) {
  const calls: string[] = [];
  const fields = { formatVersion: 1 as const, reason: "target_encryption_not_ready" as const,
    operationId: "task:fallback:one", taskId: TASK, sourceDigestBase64url: digest,
    operationalFieldsDigestBase64url: digest, expectedContentRevision: 0, expectedCryptoAccessRevision: 0,
    policyRevision: 25, subjectHumanId: "human", committerDeviceId: "device",
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 1,
    planIssuedAt: 1_000, planDeadlineAt: 31_000, planDigestBase64url: digest };
  const summary = { id: TASK, parentTaskId: null, depth: 0, status: "pending", preset: "task",
    scheduleKind: "one_shot", nextFireAt: null, callingRoomId: null,
    content: { dtoVersion: 1 as const, status: "ordinary" as const, promptPreview: "Task", lastError: null } };
  const ports: TaskOrdinaryFallbackPorts = {
    planCreate: async () => { calls.push("planCreate"); return { ...fields, purpose: "task.ordinary_fallback.create", expectedContentRevision: 0,
      expectedCryptoAccessRevision: 0, expectedUpdatedAt: null }; },
    planUpdate: async () => { calls.push("planUpdate"); return { ...fields, purpose: "task.ordinary_fallback.update", expectedUpdatedAt: "2026-10-19T00:00:00.000Z" }; },
    publishCreate: async () => { calls.push("create"); if (failure) throw new ProtectedTaskRouteError(409, "task_changed", "Task changed");
      return { taskId: TASK, status: "pending", nextFireAt: null }; },
    publishUpdate: async () => { calls.push("update"); return summary; },
  };
  const app = Fastify(); apps.push(app);
  taskOrdinaryFallbackRoutes(app, { ports, resolveAuthorizedRequest: async () => authorized ? authority : null });
  const fetchImpl: NautiloApiFetch = async (target, init) => {
    const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
    const response = await app.inject({ method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH",
      url: url.pathname, ...(typeof init?.body === "string" ? { payload: init.body } : {}),
      headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(response.body, { status: response.statusCode,
      headers: { "content-type": "application/json" } });
  };
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  client.setToken("test-only");
  return { app, client, calls };
}
const prepared = { requestVersion: 1 as const, representation: "ordinary_fallback" as const,
  operationId: "task:fallback:one", taskId: TASK, authenticatedRequestDigestBase64url: digest,
  ordinaryPayloadBytesBase64url: "YQ", signedOrdinaryFallbackRequestBytesBase64url: "YQ", task: {} };

test("typed Task fallback client reaches only the four explicit endpoints", async () => {
  const state = fixture();
  expect((await state.client.planTaskOrdinaryFallbackCreateV1({ operationId: prepared.operationId, task: {} })).taskId).toBe(TASK);
  expect((await state.client.planTaskOrdinaryFallbackUpdateV1(TASK, { operationId: prepared.operationId, task: {} })).taskId).toBe(TASK);
  expect((await state.client.createTaskOrdinaryFallbackV1(prepared)).taskId).toBe(TASK);
  expect((await state.client.updateTaskOrdinaryFallbackV1(TASK, prepared)).id).toBe(TASK);
  expect(state.calls).toEqual(["planCreate", "planUpdate", "create", "update"]);
  const ordinary = await state.app.inject({ method: "POST", url: "/api/tasks", payload: prepared });
  expect(ordinary.statusCode).toBe(404);
});

test("Task fallback rejects foreign coordinates and malformed legacy bodies before publication", async () => {
  const state = fixture();
  for (const request of [
    { method: "PATCH" as const, url: `/api/protected/tasks/81000000-0000-8000-8000-000000000002/ordinary-fallback`, payload: prepared },
    { method: "POST" as const, url: "/api/protected/tasks/ordinary-fallback", payload: { ...prepared, operation: "create" } },
    { method: "POST" as const, url: "/api/protected/tasks/ordinary-fallback-plan", payload: { requestVersion: 1, operationId: prepared.operationId, task: { prompt: "not operational" } } },
  ]) expect((await state.app.inject({ ...request, headers: bearer })).statusCode)
    .toBe(400);
  expect(state.calls).toEqual([]);
});

test("Task fallback requires the existing authenticated current Device authority", async () => {
  const state = fixture(false);
  const response = await state.app.inject({ method: "POST", url: "/api/protected/tasks/ordinary-fallback", headers: bearer, payload: prepared });
  expect(response.statusCode).toBe(403);
  expect(state.calls).toEqual([]);
  expect(response.headers["cache-control"]).toBe("private, no-store");
});

test("Task fallback preserves conflicts without sending an ordinary retry", async () => {
  const state = fixture(true, true);
  const failure = await state.client.createTaskOrdinaryFallbackV1(prepared)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(state.calls).toEqual(["create"]);
});

test("Task fallback admits the canonical one-MiB content boundary for create and update", async () => {
  const state = fixture();
  const content = encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "x".repeat(TASK_PAYLOAD_MAX_TEXT_BYTES_V1),
    expectedOutput: null,
    protectedMetadata: {},
  });
  expect(content).toHaveLength(LATTICE_LIMITS.plaintextBytes);
  const boundary = {
    ...prepared,
    ordinaryPayloadBytesBase64url: Buffer.from(content).toString("base64url"),
  };
  expect((await state.app.inject({ method: "POST",
    url: "/api/protected/tasks/ordinary-fallback", headers: bearer,
    payload: boundary })).statusCode).toBe(201);
  expect((await state.app.inject({ method: "PATCH",
    url: `/api/protected/tasks/${TASK}/ordinary-fallback`, headers: bearer,
    payload: boundary })).statusCode).toBe(200);
  expect(state.calls).toEqual(["create", "update"]);
  expect(() => encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "x".repeat(TASK_PAYLOAD_MAX_TEXT_BYTES_V1 + 1),
    expectedOutput: null,
    protectedMetadata: {},
  })).toThrow(/out of bounds|wire limit/u);
  content.fill(0);
});

test("Task fallback admits maximum operational plans after structural bearer admission", async () => {
  const state = fixture();
  const empty = JSON.stringify({ cron: "" }).length;
  const task = { cron: "x".repeat(LATTICE_LIMITS.plaintextBytes - empty) };
  expect(JSON.stringify(task)).toHaveLength(LATTICE_LIMITS.plaintextBytes);
  for (const url of [
    "/api/protected/tasks/ordinary-fallback-plan",
    `/api/protected/tasks/${TASK}/ordinary-fallback-plan`,
  ]) {
    expect((await state.app.inject({ method: "POST", url, headers: bearer,
      payload: { requestVersion: 1, operationId: prepared.operationId, task } }))
      .statusCode).toBe(200);
  }
  expect(state.calls).toEqual(["planCreate", "planUpdate"]);
});

test("Task fallback rejects a missing bearer before parsing a large body or calling ports", async () => {
  const state = fixture();
  const response = await state.app.inject({ method: "POST",
    url: "/api/protected/tasks/ordinary-fallback",
    payload: { ...prepared,
      ordinaryPayloadBytesBase64url: "A".repeat(
        Math.ceil(LATTICE_LIMITS.plaintextBytes * 4 / 3),
      ) } });
  expect(response.statusCode).toBe(401);
  expect(state.calls).toEqual([]);
});
