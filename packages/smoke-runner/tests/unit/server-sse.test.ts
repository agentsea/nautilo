import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSmokeServer, type SmokeServer } from "../../src/server";
import type { RunnerConfig } from "../../src/run-registry";
import { makeExpectations, makeMockDriver, makeMockClient } from "../integration/mock-driver";

const TOKEN = "nsk_test-token-sse";
function auth() { return { Authorization: `Bearer ${TOKEN}` }; }

function buildConfig(): RunnerConfig {
  const driver = makeMockDriver({ platform: "linux" });
  const client = makeMockClient({
    // Two scan results so we get two test-end events.
    scanResults: [
      { layer: "command", level: "standard", blocked: true },
      { layer: "command", level: "standard", blocked: true },
    ],
    // Keep the run alive long enough for the test to attach its HTTP stream.
    // A completed run intentionally returns only final run-status + close, so
    // a short timing delay makes this live-event contract test race with that
    // separate, valid late-attach behavior on slower CI runners.
    scanDelayMs: 250,
  });
  return {
    expectations: makeExpectations({
      "A": { platforms: ["linux"], layer: "command-scanner", destructive_command: "echo a", modes_supported: ["destructive"], expect_blocked: true, security_levels: ["standard"] },
      "B": { platforms: ["linux"], layer: "command-scanner", destructive_command: "echo b", modes_supported: ["destructive"], expect_blocked: true, security_levels: ["standard"] },
    }),
    platforms: { linux: { driver, client } },
    watchdogIntervalMs: 100,
  };
}

/** Read an SSE stream until it closes or we hit maxWaitMs. Returns
 *  the list of parsed `event:` frames. */
async function readSseEvents(
  url: string,
  headers: Record<string, string>,
  maxWaitMs = 3000,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxWaitMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.body) return [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let buffer = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result: { done: boolean; value?: Uint8Array } = await reader.read();
        if (result.done) break;
        const value = result.value;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        // Split on double-newline frame separator.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseFrame(frame);
          if (parsed) events.push(parsed);
        }
      }
    } catch {
      // expected at abort / stream close
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

function parseFrame(frame: string): { event: string; data: Record<string, unknown> } | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // keepalive
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    return { event: eventName, data };
  } catch {
    return null;
  }
}

describe("GET /api/smoke/runs/:id/stream (SSE) — Phase 3.4", () => {
  let s: SmokeServer;
  let baseUrl: string;

  beforeAll(async () => {
    s = await createSmokeServer({
      runnerConfig: buildConfig(),
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      log: () => {},
    });
    baseUrl = `http://${s.host}:${s.port}`;
  });

  afterAll(async () => { await s.close(); });

  test("unknown run id → 404 (no SSE stream opened)", async () => {
    const res = await fetch(`${baseUrl}/api/smoke/runs/nope/stream`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  test("happy path: attach stream, receive run-start, test-start, test-end×N, run-end, close", async () => {
    const startRes = await fetch(`${baseUrl}/api/smoke/runs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "linux" }),
    });
    const { runId } = (await startRes.json()) as { runId: string };

    const events = await readSseEvents(`${baseUrl}/api/smoke/runs/${runId}/stream`, auth(), 5000);

    const types = events.map((e) => e.event);
    // Expect at minimum: run-status seed + run-start + test-start ×2 + test-end ×2 + run-end + close.
    expect(types).toContain("run-start");
    expect(types).toContain("test-start");
    expect(types).toContain("test-end");
    expect(types).toContain("run-end");
    expect(types).toContain("close");

    // test-end payload carries a result shape.
    const testEnd = events.find((e) => e.event === "test-end");
    expect(testEnd?.data).toHaveProperty("result");
  });

  test("stream attached AFTER the run finished → emits final run-status + close", async () => {
    // Start + wait for completion before attaching.
    const startRes = await fetch(`${baseUrl}/api/smoke/runs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "linux" }),
    });
    const { runId } = (await startRes.json()) as { runId: string };

    // Poll until complete.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const p = await fetch(`${baseUrl}/api/smoke/runs/${runId}`, { headers: auth() });
      if (((await p.json()) as { status: string }).status !== "running") break;
      await new Promise((r) => setTimeout(r, 30));
    }

    const events = await readSseEvents(`${baseUrl}/api/smoke/runs/${runId}/stream`, auth(), 2000);
    const types = events.map((e) => e.event);
    expect(types).toContain("run-status");
    const runStatus = events.find((e) => e.event === "run-status")!;
    expect(runStatus.data["status"]).toBe("completed");
    expect(types[types.length - 1]).toBe("close");
  });

  test("unauthenticated SSE attach → 401", async () => {
    const startRes = await fetch(`${baseUrl}/api/smoke/runs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "linux" }),
    });
    const { runId } = (await startRes.json()) as { runId: string };

    const res = await fetch(`${baseUrl}/api/smoke/runs/${runId}/stream`);
    expect(res.status).toBe(401);
  });
});
