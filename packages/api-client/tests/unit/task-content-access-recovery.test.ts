import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";

const TASK_ID = "task-1";
const coordinate = {
  taskId: TASK_ID,
  taskRunId: "run-1",
  checkpointId: "checkpoint-1",
  toolCallId: "tool-1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected request to reject");
}

describe("Task content access recovery API", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("reads and submits only the exact server-issued Task coordinate", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      jsonResponse({ recovery: coordinate }),
      jsonResponse({ outcome: "completed" }),
    ];
    globalThis.fetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        ...(init === undefined ? {} : { init }),
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    expect(await client.getTaskContentAccessRecovery(TASK_ID)).toEqual({ recovery: coordinate });
    expect(await client.recoverTaskContentAccess(TASK_ID, coordinate)).toEqual({ outcome: "completed" });
    expect(requests.map(({ url, init }) => ({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    }))).toEqual([
      { url: `http://127.0.0.1:9/api/tasks/${TASK_ID}/content-access-recovery`, method: "GET", body: undefined },
      { url: `http://127.0.0.1:9/api/tasks/${TASK_ID}/content-access-recovery`, method: "POST", body: coordinate },
    ]);
  });

  test("rejects coordinate substitution before dispatch", async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls += 1;
      return jsonResponse({ outcome: "completed" });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    expect(await caughtFrom(client.recoverTaskContentAccess("task-2", coordinate))).toBeDefined();
    expect(calls).toBe(0);
  });

  test("accepts only truthful outcomes, null discovery, and forwards cancellation", async () => {
    const responses = [
      jsonResponse({ recovery: null }),
      ...["completed", "busy", "unavailable", "retry_required"].map((outcome) => jsonResponse({ outcome })),
      jsonResponse({ outcome: "accepted" }),
    ];
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = Object.assign(async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      signals.push(init?.signal);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const controller = new AbortController();
    expect(await client.getTaskContentAccessRecovery(TASK_ID, { signal: controller.signal }))
      .toEqual({ recovery: null });
    for (const outcome of ["completed", "busy", "unavailable", "retry_required"] as const) {
      expect(await client.recoverTaskContentAccess(TASK_ID, coordinate, { signal: controller.signal }))
        .toEqual({ outcome });
    }
    expect(await caughtFrom(client.recoverTaskContentAccess(TASK_ID, coordinate)))
      .toBeDefined();
    expect(signals.slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () => controller.signal),
    );
  });

  test("surfaces safe server failure without accepting a fabricated state", async () => {
    globalThis.fetch = Object.assign(
      async () => jsonResponse({ error: "recovery unavailable" }, 503),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const error = await caughtFrom(client.getTaskContentAccessRecovery(TASK_ID));
    expect(error).toMatchObject({ status: 503 });
  });
});
