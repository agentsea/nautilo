import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import Fastify from "fastify";
import * as operatorSecrets from "@nautilo/operator-secrets";
import { _resetBootstrapStateCacheForTests } from "@nautilo/trust";
import { operatorReleaseRoutes } from "../../src/routes/operator-release";

const ORIGINAL_TOKEN = process.env["NAUTILO_BOOTSTRAP_TOKEN"];
let restoreBootstrapUsedSpy: () => void = () => {};

beforeEach(() => {
  const spy = spyOn(operatorSecrets, "isBootstrapUsed").mockImplementation(() => false);
  restoreBootstrapUsedSpy = () => spy.mockRestore();
  _resetBootstrapStateCacheForTests();
});

afterEach(() => {
  restoreBootstrapUsedSpy();
  _resetBootstrapStateCacheForTests();
  if (ORIGINAL_TOKEN === undefined) delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
  else process.env["NAUTILO_BOOTSTRAP_TOKEN"] = ORIGINAL_TOKEN;
});

describe("GET /api/operator/release/readiness", () => {
  test("rejects a remote caller without deployment/bootstrap authorization", async () => {
    const app = Fastify({ logger: false });
    operatorReleaseRoutes(app, {
      getForegroundWorkSummary: () => ({
        runningJobs: 1,
        queuedTurns: 2,
        bufferedLanes: 3,
      }),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/operator/release/readiness",
        remoteAddress: "203.0.113.10",
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  test("returns aggregate counts only for a bootstrap-token operator", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "release-operator-token";
    const app = Fastify({ logger: false });
    operatorReleaseRoutes(app, {
      getForegroundWorkSummary: () => ({
        runningJobs: 1,
        queuedTurns: 2,
        bufferedLanes: 3,
      }),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/operator/release/readiness",
        headers: { authorization: "Bearer release-operator-token" },
        remoteAddress: "203.0.113.10",
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        runningJobs: 1,
        queuedTurns: 2,
        bufferedLanes: 3,
      });
      expect(response.body).not.toContain("prompt");
      expect(response.body).not.toContain("message");
    } finally {
      await app.close();
    }
  });

  test("admits a loopback deployment operator without a token", async () => {
    delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
    const app = Fastify({ logger: false });
    operatorReleaseRoutes(app, {
      getForegroundWorkSummary: () => ({
        runningJobs: 0,
        queuedTurns: 0,
        bufferedLanes: 0,
      }),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/operator/release/readiness",
        remoteAddress: "127.0.0.1",
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
