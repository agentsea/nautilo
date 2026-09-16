import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("task lifecycle HTTP contract (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("listActiveTasks — GET /api/tasks with no query params", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const payload = [
      {
        id: "task-1",
        parentTaskId: null,
        depth: 0,
        status: "running",
        preset: "default",
        prompt: "do work",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        updatedAt: "2026-06-15T10:01:00.000Z",
      },
    ];
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.listActiveTasks();
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/tasks");
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("task-1");
    expect(out[0]?.updatedAt).toBe("2026-06-15T10:01:00.000Z");
  });

  test("listTasks carries explicit bounded recent-terminal query parameters", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.listTasks({ includeTerminal: true, recentTerminalLimit: 5 });
    expect(seenUrl).toBe(
      "http://127.0.0.1:9/api/tasks?includeTerminal=true&recentTerminalLimit=5",
    );
  });

  test("listPendingTaskAttention reads the owner-scoped checkpoint projection", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = requestUrl(input);
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    expect(await client.listPendingTaskAttention()).toEqual([]);
    expect(seenUrl).toBe("http://127.0.0.1:9/api/tasks/pending-attention");
  });

  test("getTask — GET /api/tasks/:id", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const payload = {
      task: {
        id: "task-1",
        parentTaskId: null,
        depth: 0,
        status: "running",
        preset: "default",
        prompt: "do work",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        expectedOutput: null,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        scopeId: null,
        toolsMode: "all",
        toolsWhitelist: [],
        selectionProfile: "balanced",
        selectionSpec: null,
        createdAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T10:00:00.000Z",
      },
      runs: [],
    };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getTask("task-1");
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/tasks/task-1");
    expect(out.task.id).toBe("task-1");
  });

  test("stopTask — POST /api/tasks/:id/stop", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ taskId: "task-1", status: "stopped", message: "stopped" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.stopTask("task-1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/tasks/task-1/stop");
    expect(out.taskId).toBe("task-1");
  });

  test("pauseTask — POST /api/tasks/:id/pause", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ taskId: "task-1", status: "paused", message: "paused" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.pauseTask("task-1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/tasks/task-1/pause");
    expect(out.status).toBe("paused");
  });

  test("unpauseTask — POST /api/tasks/:id/unpause", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ taskId: "task-1", status: "pending", message: "unpaused" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.unpauseTask("task-1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/tasks/task-1/unpause");
    expect(out.status).toBe("pending");
  });

  // D429 Phase 3 — the response types carry requestedModelId (the requested
  // exact pin) alongside lastModelId (the actual run model). The client
  // passes the typed payloads through verbatim, so this asserts the field
  // survives the round-trip on both list and get.
  test("listActiveTasks surfaces requestedModelId separately from lastModelId", async () => {
    const payload = [
      {
        id: "task-1",
        parentTaskId: null,
        depth: 0,
        status: "pending",
        preset: "task",
        prompt: "pinned task",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        requestedModelId: "anthropic:claude-sonnet-4-6",
        lastModelId: null,
      },
    ];
    const mockFetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.listActiveTasks();
    expect(out[0]?.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
    expect(out[0]?.lastModelId).toBeNull();
  });

  test("getTask surfaces requestedModelId on the task (distinct from runs[].modelId)", async () => {
    const payload = {
      task: {
        id: "task-1",
        parentTaskId: null,
        depth: 0,
        status: "completed",
        preset: "task",
        prompt: "pinned task",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        expectedOutput: null,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        scopeId: null,
        toolsMode: "auto",
        toolsWhitelist: [],
        selectionProfile: "balanced",
        selectionSpec: null,
        requestedModelId: "anthropic:claude-sonnet-4-6",
        createdAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T10:00:00.000Z",
      },
      runs: [
        {
          id: "run-1",
          status: "completed",
          modelId: "anthropic:claude-sonnet-4-6",
          resultText: "done",
          lastError: null,
          startedAt: "2026-06-15T10:00:00.000Z",
          completedAt: "2026-06-15T10:05:00.000Z",
        },
      ],
    };
    const mockFetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.getTask("task-1");
    expect(out.task.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
    // The actual run model is surfaced separately on the run.
    expect(out.runs[0]?.modelId).toBe("anthropic:claude-sonnet-4-6");
  });
});
