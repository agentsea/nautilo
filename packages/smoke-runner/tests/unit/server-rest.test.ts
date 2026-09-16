import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSmokeServer, type SmokeServer } from "../../src/server";
import type { RunnerConfig } from "../../src/run-registry";
import { makeExpectations, makeMockDriver, makeMockClient } from "../integration/mock-driver";

const TOKEN = "nsk_test-token-rest";

function auth() {
  return { Authorization: `Bearer ${TOKEN}` };
}

function buildServerConfig(): RunnerConfig {
  const linuxDriver = makeMockDriver({ platform: "linux" });
  const linuxClient = makeMockClient({
    scanResults: [{ layer: "command", level: "standard", blocked: true, reason: "mock block" }],
  });
  return {
    expectations: makeExpectations({
      "SCAN-01": {
        platforms: ["linux", "macos"],
        layer: "command-scanner",
        destructive_command: "rm -rf /",
        modes_supported: ["destructive"],
        expect_blocked: true,
        security_levels: ["standard"],
      },
      "SCAN-02": {
        platforms: ["linux"],
        layer: "command-scanner",
        destructive_command: "sudo apt update",
        modes_supported: ["destructive"],
        expect_blocked: true,
        security_levels: ["standard"],
      },
    }),
    platforms: {
      linux: { driver: linuxDriver, client: linuxClient },
    },
    watchdogIntervalMs: 100,
  };
}

describe("SmokeServer REST endpoints", () => {
  let s: SmokeServer;
  let baseUrl: string;

  beforeAll(async () => {
    s = await createSmokeServer({
      runnerConfig: buildServerConfig(),
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      log: () => {},
    });
    baseUrl = `http://${s.host}:${s.port}`;
  });

  afterAll(async () => {
    await s.close();
  });

  // -------------------------------------------------------------------------
  // GET /api/smoke/tests
  // -------------------------------------------------------------------------

  describe("GET /api/smoke/tests", () => {
    test("returns catalog with metadata", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/tests`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tests: Array<{ id: string; platform: string }> };
      // SCAN-01 on both platforms + SCAN-02 linux-only = 3.
      expect(body.tests).toHaveLength(3);
      expect(body.tests[0]).toHaveProperty("id");
      expect(body.tests[0]).toHaveProperty("platform");
      expect(body.tests[0]).toHaveProperty("layer");
    });

    test("?platform=linux filters by platform", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/tests?platform=linux`, { headers: auth() });
      const body = (await res.json()) as { tests: Array<{ platform: string }> };
      expect(body.tests.every((t) => t.platform === "linux")).toBe(true);
    });

    test("?pattern=SCAN-01 filters by test id pattern", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/tests?pattern=SCAN-01`, { headers: auth() });
      const body = (await res.json()) as { tests: Array<{ id: string }> };
      expect(body.tests.every((t) => t.id === "SCAN-01")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/smoke/runs + GET /api/smoke/runs/:id + /report
  // -------------------------------------------------------------------------

  describe("POST /api/smoke/runs → poll → report", () => {
    test("happy path: start a run, poll, fetch report", async () => {
      const startRes = await fetch(`${baseUrl}/api/smoke/runs`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "SCAN-01", platform: "linux" }),
      });
      expect(startRes.status).toBe(200);
      const started = (await startRes.json()) as { runId: string; status: string };
      expect(started.status).toBe("running");
      expect(started.runId).toMatch(/\d{4}-\d{2}-\d{2}T/);

      // Poll until complete (mock scan returns fast).
      let finalStatus = "running";
      const startWait = Date.now();
      while (finalStatus === "running" && Date.now() - startWait < 3000) {
        const pollRes = await fetch(`${baseUrl}/api/smoke/runs/${started.runId}`, { headers: auth() });
        expect(pollRes.status).toBe(200);
        finalStatus = ((await pollRes.json()) as { status: string }).status;
        if (finalStatus === "running") await new Promise((r) => setTimeout(r, 50));
      }
      expect(finalStatus).toBe("completed");

      const reportRes = await fetch(`${baseUrl}/api/smoke/runs/${started.runId}/report`, { headers: auth() });
      expect(reportRes.status).toBe(200);
      const report = (await reportRes.json()) as { runId: string; results: Array<{ testId: string }> };
      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.testId).toBe("SCAN-01");
    });

    test("unknown run id → 404", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/runs/never-real`, { headers: auth() });
      expect(res.status).toBe(404);
    });

    test("report while still running → 409", async () => {
      const startRes = await fetch(`${baseUrl}/api/smoke/runs`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "SCAN-01", platform: "linux" }),
      });
      const { runId } = (await startRes.json()) as { runId: string };
      // Don't wait for completion — race-fast poll the report endpoint.
      const res = await fetch(`${baseUrl}/api/smoke/runs/${runId}/report`, { headers: auth() });
      // Either 409 (still running) or 200 (race won). Both acceptable;
      // this test asserts only the 409 shape when it DOES happen.
      if (res.status === 409) {
        const body = (await res.json()) as { error: string; status: string };
        expect(body.error).toBe("run not complete");
        expect(body.status).toBe("running");
      } else {
        // Race: run finished before we polled. Fine.
        expect(res.status).toBe(200);
      }
    });

    test("invalid platform → 400", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/runs`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "windows" }),
      });
      expect(res.status).toBe(400);
    });

    test("invalid mode → 400", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/runs`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "chaos" }),
      });
      expect(res.status).toBe(400);
    });

    test("invalid level → 400", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/runs`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ level: "superstrict" }),
      });
      expect(res.status).toBe(400);
    });

    test("malformed JSON body → 400", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/runs`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // VM endpoints
  // -------------------------------------------------------------------------

  describe("VM endpoints", () => {
    test("POST /api/smoke/vms/linux/snapshot takes a snapshot", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/vms/linux/snapshot`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-snap" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; name: string };
      expect(body.ok).toBe(true);
      expect(body.name).toBe("test-snap");
    });

    test("POST /api/smoke/vms/linux/restore restores", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/vms/linux/restore`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "baseline" }),
      });
      expect(res.status).toBe(200);
    });

    test("GET /api/smoke/vms/linux/health returns probe result", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/vms/linux/health`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(typeof body.ok).toBe("boolean");
    });

    test("unknown platform → 404", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/vms/windows/health`, { headers: auth() });
      expect(res.status).toBe(404);
    });

    test("unconfigured platform → 404 (macos not configured in this test)", async () => {
      const res = await fetch(`${baseUrl}/api/smoke/vms/macos/health`, { headers: auth() });
      expect(res.status).toBe(404);
    });
  });
});
