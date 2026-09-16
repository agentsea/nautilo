import { describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  onRequestHookHandler,
  onSendAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify/types/hooks";
import {
  finalizeHandlerPhase,
  getActiveRequestTelemetry,
  markHandlerPhaseStart,
  runWithNewRequestTelemetry,
  shouldSkipRequestTelemetry,
} from "../../src/telemetry/request-telemetry";
import {
  formatServerTimingHeader,
  isValidServerTimingHeader,
} from "../../src/telemetry/server-timing";
import { routeSkipsTrustPreHandler } from "../../src/trust-bypass-routes";

/**
 * Mirrors the M213 hook wiring in app.ts without DB/trust. Regression guard
 * for the zero-byte hang when a sync preHandler follows an async preHandler.
 */
function wireM213Hooks(app: FastifyInstance): void {
  const onRequestHook: onRequestHookHandler = (request, _reply, done) => {
    if (
      shouldSkipRequestTelemetry(
        request.url,
        request.routeOptions?.url ?? request.url,
      )
    ) {
      done();
      return;
    }
    runWithNewRequestTelemetry(done);
  };
  app.addHook("onRequest", onRequestHook);

  const trustPreHandler: preHandlerAsyncHookHandler = async (request, _reply) => {
    const routePath = request.routeOptions?.url ?? request.url;
    if (routeSkipsTrustPreHandler(routePath)) return;
    await Promise.resolve();
  };
  app.addHook("preHandler", trustPreHandler);

  const telemetryPreHandler: preHandlerAsyncHookHandler = (request) => {
    if (
      shouldSkipRequestTelemetry(
        request.url,
        request.routeOptions?.url ?? request.url,
      )
    ) {
      return Promise.resolve();
    }
    if (getActiveRequestTelemetry()) {
      markHandlerPhaseStart();
    }
    return Promise.resolve();
  };
  app.addHook("preHandler", telemetryPreHandler);

  const onSendHook: onSendAsyncHookHandler = async (request, reply, payload) => {
    if (
      shouldSkipRequestTelemetry(
        request.url,
        request.routeOptions?.url ?? request.url,
      )
    ) {
      return payload;
    }

    finalizeHandlerPhase();
    const ctx = getActiveRequestTelemetry();
    if (!ctx) return payload;

    const timing = formatServerTimingHeader(ctx);
    if (timing !== null && isValidServerTimingHeader(timing)) {
      reply.header("Server-Timing", timing);
    }
    reply.header("X-Correlation-Id", ctx.correlationId);
    return payload;
  };
  app.addHook("onSend", onSendHook);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

describe("M213 request lifecycle — no hang over real HTTP", () => {
  test("GET /health and GET / respond within 2s (inject + listen/fetch)", async () => {
    const app = Fastify({ logger: false });
    wireM213Hooks(app);

    app.get("/health", async () => ({ status: "ok" }));
    app.get("/", async () => ({ status: "root" }));

    try {
      const injectHealth = await app.inject({ method: "GET", url: "/health" });
      expect(injectHealth.statusCode).toBe(200);

      const injectRoot = await app.inject({ method: "GET", url: "/" });
      expect(injectRoot.statusCode).toBe(200);
      expect(injectRoot.headers["x-correlation-id"]).toBeDefined();

      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const base = address.replace(/\/$/, "");

      const healthRes = await fetchWithTimeout(`${base}/health`, 2000);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.text()).toContain("ok");

      const rootRes = await fetchWithTimeout(`${base}/`, 2000);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toContain("root");
      expect(rootRes.headers.get("x-correlation-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    } finally {
      await app.close();
    }
  });
});
