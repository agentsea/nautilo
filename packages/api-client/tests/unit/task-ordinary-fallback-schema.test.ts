import { describe, expect, test } from "bun:test";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto/wire-limits";
import { NautiloApiClient, type NautiloApiFetch } from "../../src/client.ts";
import {
  taskOrdinaryFallbackPlanCreateRequestV1Schema,
  taskOrdinaryFallbackCreatePlanV1Schema,
  taskOrdinaryFallbackPreparedCreateRequestV1Schema,
  taskOrdinaryFallbackUpdatePlanV1Schema,
  taskOrdinaryFallbackPreparedUpdateRequestV1Schema,
} from "../../src/schemas/task-ordinary-fallback.ts";

const TASK_ID = "81000000-0000-8000-8000-000000000001";
const DIGEST = "A".repeat(43);

function plan() {
  return {
    formatVersion: 1 as const,
    purpose: "task.ordinary_fallback.create" as const,
    reason: "target_encryption_not_ready" as const,
    operationId: "task-create:1",
    taskId: TASK_ID,
    sourceDigestBase64url: DIGEST,
    operationalFieldsDigestBase64url: DIGEST,
    expectedContentRevision: 0 as const,
    expectedCryptoAccessRevision: 0 as const,
    expectedUpdatedAt: null,
    policyRevision: 4,
    subjectHumanId: "human:1",
    committerDeviceId: "device:1",
    committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: 3,
    planIssuedAt: 1_000,
    planDeadlineAt: 31_000,
    planDigestBase64url: DIGEST,
  };
}

describe("Task ordinary fallback schemas", () => {
  test("accepts exact create and update plans", () => {
    expect(taskOrdinaryFallbackCreatePlanV1Schema.parse(plan()).taskId)
      .toBe(TASK_ID);
    expect(taskOrdinaryFallbackUpdatePlanV1Schema.parse({
      ...plan(),
      purpose: "task.ordinary_fallback.update",
      expectedContentRevision: 4,
      expectedCryptoAccessRevision: 2,
      expectedUpdatedAt: "2026-10-19T10:11:12.345Z",
    }).expectedContentRevision).toBe(4);
    expect(taskOrdinaryFallbackPlanCreateRequestV1Schema.parse({
      requestVersion: 1,
      operationId: "task-create:1",
      task: { scheduleKind: "now" },
    }).task).toEqual({ scheduleKind: "now" });
  });

  test("accepts exact create and update publications", () => {
    const request = {
      requestVersion: 1 as const,
      representation: "ordinary_fallback" as const,
      operationId: "task-create:1",
      taskId: TASK_ID,
      authenticatedRequestDigestBase64url: DIGEST,
      ordinaryPayloadBytesBase64url: "e30",
      signedOrdinaryFallbackRequestBytesBase64url: "c2lnbmVk",
      task: { scheduleKind: "now" as const },
    };
    expect(taskOrdinaryFallbackPreparedCreateRequestV1Schema.parse(request)).toEqual(request);
    expect(taskOrdinaryFallbackPreparedUpdateRequestV1Schema.parse({
      ...request,
      task: { resultDelivery: "wake" },
    }).task).toEqual({ resultDelivery: "wake" });
  });

  test("rejects substituted, malformed, and oversized values", () => {
    for (const candidate of [
      { ...plan(), purpose: "task.ordinary_fallback.update" },
      { ...plan(), planDeadlineAt: 1_000 },
      { ...plan(), taskId: "81000000-0000-8000-8000-00000000000A" },
      { ...plan(), sourceDigestBase64url: "A".repeat(42) },
      { ...plan(), extra: true },
    ]) expect(() => taskOrdinaryFallbackCreatePlanV1Schema.parse(candidate))
      .toThrow();

    expect(() => taskOrdinaryFallbackPreparedCreateRequestV1Schema.parse({
      requestVersion: 1,
      representation: "ordinary_fallback",
      operationId: "task-create:1",
      taskId: TASK_ID,
      authenticatedRequestDigestBase64url: DIGEST,
      ordinaryPayloadBytesBase64url: "A".repeat(
        Math.ceil(LATTICE_LIMITS.plaintextBytes * 4 / 3) + 1,
      ),
      signedOrdinaryFallbackRequestBytesBase64url: "c2lnbmVk",
      task: {},
    })).toThrow();
  });

  test("client methods use the four dedicated fallback endpoints", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url;
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (url.endsWith("ordinary-fallback-plan")) {
        return new Response(JSON.stringify(url.includes(`/${TASK_ID}/`)
          ? {
            ...plan(),
            purpose: "task.ordinary_fallback.update",
            expectedContentRevision: 1,
            expectedUpdatedAt: "2026-10-19T10:11:12.345Z",
          }
          : plan()), { headers: { "content-type": "application/json" } });
      }
      if (method === "POST") return new Response(JSON.stringify({
        taskId: TASK_ID,
        status: "pending",
        nextFireAt: null,
      }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        id: TASK_ID,
        parentTaskId: null,
        depth: 0,
        status: "pending",
        preset: "task",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        content: {
          dtoVersion: 1,
          status: "ordinary",
          promptPreview: "fallback",
          lastError: null,
        },
      }), { headers: { "content-type": "application/json" } });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("session-token");
    const prepared = {
      requestVersion: 1 as const,
      representation: "ordinary_fallback" as const,
      operationId: "task-create:1",
      taskId: TASK_ID,
      authenticatedRequestDigestBase64url: DIGEST,
      ordinaryPayloadBytesBase64url: "e30",
      signedOrdinaryFallbackRequestBytesBase64url: "c2lnbmVk",
      task: {},
    };
    await client.planTaskOrdinaryFallbackCreateV1({
      operationId: "task-create:1",
      task: {},
    });
    await client.planTaskOrdinaryFallbackUpdateV1(TASK_ID, {
      operationId: "task-create:1",
      task: {},
    });
    await client.createTaskOrdinaryFallbackV1(prepared);
    await client.updateTaskOrdinaryFallbackV1(TASK_ID, prepared);
    expect(calls).toEqual([
      { method: "POST", url:
        "https://nautilo.test/api/protected/tasks/ordinary-fallback-plan" },
      { method: "POST", url:
        `https://nautilo.test/api/protected/tasks/${TASK_ID}/ordinary-fallback-plan` },
      { method: "POST", url:
        "https://nautilo.test/api/protected/tasks/ordinary-fallback" },
      { method: "PATCH", url:
        `https://nautilo.test/api/protected/tasks/${TASK_ID}/ordinary-fallback` },
    ]);
  });
});
