import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  createRequestTelemetryContext,
  finalizeHandlerPhase,
  getActiveRequestTelemetry,
  incrementDbStatementCountForActiveRequest,
  markHandlerPhaseStart,
  recordStageDuration,
  runWithRequestTelemetry,
  runWithNewRequestTelemetry,
  shouldSkipRequestTelemetry,
  snapshotRequestTelemetry,
  timeStage,
} from "../../src/telemetry/request-telemetry";
import {
  formatServerTimingHeader,
  isValidServerTimingHeader,
} from "../../src/telemetry/server-timing";
import { bindRuntimeStatementObserverToRequestTelemetry } from "../../src/telemetry/runtime-db-observer";
import { setRuntimeStatementObserver } from "@nautilo/db";

describe("request telemetry context isolation (M213 Phase 0)", () => {
  test("concurrent contexts do not share stage durations or DB counts", async () => {
    const ctxA = createRequestTelemetryContext();
    const ctxB = createRequestTelemetryContext();

    const [snapA, snapB] = await Promise.all([
      runWithRequestTelemetry(ctxA, async () => {
        recordStageDuration("jwt", 10);
        incrementDbStatementCountForActiveRequest();
        incrementDbStatementCountForActiveRequest();
        await timeStage("principal", async () => {
          await Promise.resolve();
        });
        return snapshotRequestTelemetry(getActiveRequestTelemetry()!);
      }),
      runWithRequestTelemetry(ctxB, async () => {
        recordStageDuration("rbac", 42);
        incrementDbStatementCountForActiveRequest();
        return snapshotRequestTelemetry(getActiveRequestTelemetry()!);
      }),
    ]);

    expect(snapA.stageDurationsMs.jwt).toBe(10);
    expect(snapA.stageDurationsMs.principal).toBeGreaterThanOrEqual(0);
    expect(snapA.stageDurationsMs.rbac).toBeUndefined();
    expect(snapA.dbStatementCount).toBe(2);

    expect(snapB.stageDurationsMs.rbac).toBe(42);
    expect(snapB.stageDurationsMs.jwt).toBeUndefined();
    expect(snapB.dbStatementCount).toBe(1);
    expect(snapA.correlationId).not.toBe(snapB.correlationId);
  });

  test("Fastify assigns isolated contexts to sequential and concurrent requests", async () => {
    const app = Fastify({ logger: false });
    const snapshots = new Map<string, ReturnType<typeof snapshotRequestTelemetry>>();

    app.addHook("onRequest", (_request, _reply, done) => {
      runWithNewRequestTelemetry(done);
    });
    app.addHook("preHandler", async (request) => {
      const duration = Number(request.headers["x-test-stage-duration"]);
      recordStageDuration("jwt", duration);
      incrementDbStatementCountForActiveRequest();
      markHandlerPhaseStart();
    });
    app.get("/telemetry", async (request) => {
      const delay = Number(request.headers["x-test-delay-ms"]);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return { ok: true };
    });
    app.addHook("onSend", async (_request, reply, payload) => {
      finalizeHandlerPhase();
      const context = getActiveRequestTelemetry();
      expect(context).not.toBeNull();
      const snapshot = snapshotRequestTelemetry(context!);
      snapshots.set(snapshot.correlationId, snapshot);
      reply.header("X-Correlation-Id", snapshot.correlationId);
      return payload;
    });

    try {
      const first = await app.inject({
        method: "GET",
        url: "/telemetry",
        headers: { "x-test-stage-duration": "11" },
      });
      const second = await app.inject({
        method: "GET",
        url: "/telemetry",
        headers: { "x-test-stage-duration": "22" },
      });
      const [third, fourth] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/telemetry",
          headers: { "x-test-stage-duration": "33", "x-test-delay-ms": "10" },
        }),
        app.inject({
          method: "GET",
          url: "/telemetry",
          headers: { "x-test-stage-duration": "44" },
        }),
      ]);

      const ids = [first, second, third, fourth].map((response) => {
        const header = response.headers["x-correlation-id"];
        if (typeof header === "string") return header;
        if (Array.isArray(header)) return header[0] ?? "";
        return header === undefined ? "" : String(header);
      });
      expect(ids.length).toBe(4);

      for (const [index, duration] of [
        [0, 11],
        [1, 22],
        [2, 33],
        [3, 44],
      ] as const) {
        const id = ids[index];
        expect(typeof id).toBe("string");
        if (typeof id !== "string") {
          continue;
        }
        const snapshot = snapshots.get(id);
        expect(snapshot?.stageDurationsMs.jwt).toBe(duration);
        expect(snapshot?.dbStatementCount).toBe(1);
        expect(snapshot?.stageDurationsMs.handler).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await app.close();
    }
  });

  test("snapshot never retains bearer-like fields", () => {
    const ctx = createRequestTelemetryContext();
    const snap = snapshotRequestTelemetry(ctx);
    const json = JSON.stringify(snap);

    expect(Object.keys(snap).sort()).toEqual([
      "correlationId",
      "dbStatementCount",
      "stageDurationsMs",
    ]);
    expect(json).not.toMatch(/bearer|authorization|sub|user_id|userid|sql|postgres/i);
  });
});

describe("runtime statement observer bridge (M213 Phase 0)", () => {
  test("increments only the active request context when debug handler fires", async () => {
    const observerMod = await import(
      "../../../db/src/config/runtime-statement-observer.ts"
    );
    const cleanupBridge = bindRuntimeStatementObserverToRequestTelemetry();
    const ctx = createRequestTelemetryContext();
    const debug = observerMod.createRuntimeStatementDebugHandler("full");

    runWithRequestTelemetry(ctx, () => {
      debug(0, "SELECT secret FROM users WHERE id = $1", ["user-123"], ["uuid"]);
      expect(getActiveRequestTelemetry()?.dbStatementCount).toBe(1);
    });

    debug(0, "SELECT 1", [], []);
    expect(ctx.dbStatementCount).toBe(1);

    cleanupBridge();
    setRuntimeStatementObserver(null);
  });

  test("observer outside request context does not mutate a context", async () => {
    const observerMod = await import(
      "../../../db/src/config/runtime-statement-observer.ts"
    );
    const cleanupBridge = bindRuntimeStatementObserverToRequestTelemetry();
    const ctx = createRequestTelemetryContext();
    const debug = observerMod.createRuntimeStatementDebugHandler("agent");

    debug(0, "SELECT 1", [], []);
    expect(ctx.dbStatementCount).toBe(0);
    expect(getActiveRequestTelemetry()).toBeNull();

    cleanupBridge();
    setRuntimeStatementObserver(null);
  });
});

describe("Server-Timing header privacy and format (M213 Phase 0)", () => {
  test("formats stage durations with valid syntax", () => {
    const ctx = createRequestTelemetryContext();
    runWithRequestTelemetry(ctx, () => {
      recordStageDuration("jwt", 12.345);
      recordStageDuration("handler", 3);
      const header = formatServerTimingHeader(getActiveRequestTelemetry()!);
      expect(header).toBe("jwt;dur=12.3, handler;dur=3.0");
      expect(isValidServerTimingHeader(header!)).toBe(true);
    });
  });

  test("header contains stage names and numeric durations only", () => {
    const ctx = createRequestTelemetryContext();
    ctx.stageDurationsMs.jwt = 1;
    ctx.stageDurationsMs.policy = 2.5;
    const header = formatServerTimingHeader(ctx)!;

    expect(header).toBe("jwt;dur=1.0, policy;dur=2.5");
    expect(header).not.toMatch(/[A-Z]/);
    expect(header).not.toContain("Bearer");
    expect(header).not.toContain("user");
    expect(header).not.toContain(ctx.correlationId);
  });

  test("returns null when any duration is invalid", () => {
    const ctx = createRequestTelemetryContext();
    ctx.stageDurationsMs.jwt = Number.NaN;
    expect(formatServerTimingHeader(ctx)).toBeNull();
  });

  test("correlation id is opaque uuid, not included in Server-Timing", () => {
    const ctx = createRequestTelemetryContext();
    ctx.stageDurationsMs.policy = 2;
    const header = formatServerTimingHeader(ctx);

    expect(header).toBe("policy;dur=2.0");
    expect(header).not.toContain(ctx.correlationId);
    expect(ctx.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("shouldSkipRequestTelemetry (M213 Phase 0)", () => {
  test("skips trust-bypass and engine prefixes", () => {
    expect(shouldSkipRequestTelemetry("/health", "/health")).toBe(true);
    expect(shouldSkipRequestTelemetry("/wopi/files/x", "/wopi/files/:id")).toBe(true);
    expect(shouldSkipRequestTelemetry("/office-engine/bundle.js", "/office-engine/*")).toBe(
      true,
    );
    expect(shouldSkipRequestTelemetry("/api/chat", "/api/chat")).toBe(false);
  });
});
