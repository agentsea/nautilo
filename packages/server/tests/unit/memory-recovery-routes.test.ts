import { describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type {
  MemoryRecoveryPreview,
  MemoryRecoveryRequest,
  MemoryRecoveryResult,
} from "@nautilo/types";
import { memoryRecoveryRoutes } from "../../src/routes/memory-recovery";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_JOB_ID = "22222222-2222-4222-8222-222222222222";
const VERSION = "A".repeat(43);

function previewFixture(): MemoryRecoveryPreview {
  return {
    roomId: ROOM_ID,
    generatedAt: "2026-11-27T12:00:00.000Z",
    journal: {
      generation: 7,
      cursor: 12,
      lastCompletedAt: "2026-11-27T11:00:00.000Z",
      target: 20,
      rebuild: "available",
    },
    reflection: { pending: 12, completed: 34 },
    memory: { pending: 2, covered: 8, latestOutcome: "no_change" },
    jobs: [{
      id: "reflection-job-1",
      lane: "reflection",
      version: VERSION,
      stage: "organization",
      reason: "provider_refused",
      modelId: "openai:rejected-model",
      action: "retry_with_model",
    }],
    hasMoreJobs: false,
    models: [{
      id: "anthropic:healthy-model",
      label: "Healthy model",
      lanes: ["reflection", "memory"],
    }],
  };
}

function buildApp(options?: Readonly<{
  preview?: (roomId: string) => Promise<MemoryRecoveryPreview | null>;
  run?: (
    input: MemoryRecoveryRequest,
    authorizedBy: string,
  ) => Promise<MemoryRecoveryResult>;
}>) {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const userId = request.headers["x-test-user"];
    request.sessionUserId = typeof userId === "string" ? userId : null;
  });
  const preview = mock(options?.preview ?? (async () => previewFixture()));
  const run = mock(options?.run ?? (async () => ({ status: "queued" as const })));
  memoryRecoveryRoutes(app, {
    preview,
    run,
    getCapabilities: async (userId) => {
      if (userId === "reader") return ["read_server_settings"];
      if (userId === "operator") return ["manage_server_operations"];
      if (userId === "administrator") {
        return ["read_server_settings", "manage_server_operations"];
      }
      return [];
    },
  });
  return { app, preview, run };
}

describe("memory recovery routes", () => {
  test("enforces authentication and separate read and operations capabilities", async () => {
    const { app, preview, run } = buildApp();
    try {
      expect((await app.inject({
        method: "GET",
        url: `/api/admin/memory-recovery/${ROOM_ID}`,
      })).statusCode).toBe(401);
      expect((await app.inject({
        method: "GET",
        url: `/api/admin/memory-recovery/${ROOM_ID}`,
        headers: { "x-test-user": "operator" },
      })).statusCode).toBe(403);
      expect((await app.inject({
        method: "POST",
        url: "/api/admin/memory-recovery",
        headers: { "x-test-user": "reader" },
        payload: {
          roomId: ROOM_ID,
          action: "rebuild_journal",
          generation: 7,
          cursor: 12,
          confirmBillableWork: true,
        },
      })).statusCode).toBe(403);
      expect(preview).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("returns the exact preview and GET never invokes mutation", async () => {
    const { app, preview, run } = buildApp();
    try {
      const malformed = await app.inject({
        method: "GET",
        url: "/api/admin/memory-recovery/not-a-room-id",
        headers: { "x-test-user": "reader" },
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: "A valid Room ID is required" });
      expect(preview).not.toHaveBeenCalled();

      const response = await app.inject({
        method: "GET",
        url: `/api/admin/memory-recovery/${ROOM_ID}`,
        headers: { "x-test-user": "reader" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(previewFixture());
      expect(preview).toHaveBeenCalledTimes(1);
      expect(preview).toHaveBeenCalledWith(ROOM_ID);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("rejects malformed, unconfirmed, or widened actions before mutation", async () => {
    const { app, run } = buildApp();
    const invalidPayloads = [
      {},
      {
        roomId: ROOM_ID,
        action: "rebuild_journal",
        generation: 7,
        cursor: 12,
        confirmBillableWork: false,
      },
      {
        roomId: ROOM_ID,
        action: "rebuild_journal",
        generation: 7,
        cursor: 12,
        confirmBillableWork: true,
        unexpected: "field",
      },
      {
        roomId: ROOM_ID,
        action: "retry_with_model",
        lane: "reflection",
        jobId: "reflection-job-1",
        version: VERSION,
      },
      {
        roomId: ROOM_ID,
        action: "retry_review",
        jobId: "not-a-uuid",
        version: VERSION,
      },
      {
        roomId: ROOM_ID,
        action: "reconcile_review",
        jobId: REVIEW_JOB_ID,
        version: VERSION,
      },
    ];
    try {
      for (const payload of invalidPayloads) {
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/memory-recovery",
          headers: { "x-test-user": "operator" },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: "Exact recovery coordinates are required",
        });
      }
      expect(run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("forwards every exact action and maps queued versus current statuses", async () => {
    const requests: readonly MemoryRecoveryRequest[] = [{
      roomId: ROOM_ID,
      action: "rebuild_journal",
      generation: 7,
      cursor: 12,
      confirmBillableWork: true,
    }, {
      roomId: ROOM_ID,
      action: "retry_with_model",
      lane: "reflection",
      jobId: "reflection-job-1",
      version: VERSION,
      modelId: "anthropic:healthy-model",
    }, {
      roomId: ROOM_ID,
      action: "retry_review",
      jobId: REVIEW_JOB_ID,
      version: VERSION,
    }, {
      roomId: ROOM_ID,
      action: "reconcile_review",
      jobId: REVIEW_JOB_ID,
      version: VERSION,
      confirmBillableWork: true,
    }];
    const statuses: readonly MemoryRecoveryResult["status"][] = [
      "queued",
      "already_queued",
      "stale",
      "blocked",
    ];
    let call = 0;
    const { app, preview, run } = buildApp({
      run: async () => ({ status: statuses[call++]! }),
    });
    try {
      for (const [index, payload] of requests.entries()) {
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/memory-recovery",
          headers: { "x-test-user": "operator" },
          payload,
        });
        expect(response.statusCode).toBe(index === 0 ? 202 : 200);
        expect(response.json()).toEqual({ status: statuses[index] });
      }
      expect(run).toHaveBeenCalledTimes(requests.length);
      expect(run.mock.calls).toEqual(requests.map((request) => [request, "operator"]));
      expect(preview).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("rejects non-contract preview and result data without leaking it", async () => {
    const privateValue = "private-provider-detail";
    const invalidPreview = {
      ...previewFixture(),
      unexpected: privateValue,
    } as unknown as MemoryRecoveryPreview;
    const previewHarness = buildApp({ preview: async () => invalidPreview });
    try {
      const response = await previewHarness.app.inject({
        method: "GET",
        url: `/api/admin/memory-recovery/${ROOM_ID}`,
        headers: { "x-test-user": "reader" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(privateValue);
      expect(previewHarness.run).not.toHaveBeenCalled();
    } finally {
      await previewHarness.app.close();
    }

    const invalidResult = {
      status: "queued",
      unexpected: privateValue,
    } as unknown as MemoryRecoveryResult;
    const resultHarness = buildApp({ run: async () => invalidResult });
    try {
      const response = await resultHarness.app.inject({
        method: "POST",
        url: "/api/admin/memory-recovery",
        headers: { "x-test-user": "operator" },
        payload: {
          roomId: ROOM_ID,
          action: "rebuild_journal",
          generation: 7,
          cursor: 12,
          confirmBillableWork: true,
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(privateValue);
    } finally {
      await resultHarness.app.close();
    }
  });
});
