import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import type { ReactNode } from "react";
import type { TaskDetail } from "@nautilo/types";
import { NautiloApiClient } from "@nautilo/api-client/browser";
import { apiClient } from "../../src/lib/api";
import type { RunningSubagent } from "../../src/modes/rooms/subagents/running-subagents-model";
import { RunningSubagentsContext } from "../../src/adapters/runtime-contexts";
import { useSubagentTranscript } from "../../src/modes/rooms/subagents/use-subagent-transcript";

beforeEach(() => {
  reapplyHappyDomGlobals();
});

const getTask = mock(async (_taskId: string): Promise<TaskDetail> => ({
  task: {
    id: "task-1",
    status: "running",
    preset: "default",
    prompt: "work",
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
    parentTaskId: null,
    depth: 0,
    selectionProfile: "balanced",
    selectionSpec: null,
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
  },
  runs: [
    {
      id: "run-1",
      status: "running",
      modelId: "claude",
      resultText: null,
      lastError: null,
      startedAt: "2026-06-15T11:00:00.000Z",
      completedAt: null,
      transcript: [
        {
          role: "user",
          content: "hello",
          toolName: null,
          toolCalls: null,
          createdAt: "2026-06-15T11:00:01.000Z",
        },
      ],
    },
  ],
}));

function subagent(partial: Partial<RunningSubagent> & Pick<RunningSubagent, "taskId" | "status">): RunningSubagent {
  return {
    taskRunId: "run-1",
    agentName: "Genie",
    modelId: "claude",
    kind: "in_background",
    prompt: "do work",
    line3: "working…",
    awaitingRoomId: null,
    startedAtMs: 1000,
    terminalAtMs: null,
    ...partial,
  };
}

describe("useSubagentTranscript", () => {
  let dockList: RunningSubagent[];
  let originalGetTask: typeof apiClient.getTask;

  beforeAll(() => {
    // An earlier test may have `mock.module`‑stubbed lib/api with a partial
    // apiClient (see room-switch-regression). Fall back to the real method so
    // afterAll can restore cleanly without assuming getTask already exists.
    originalGetTask =
      typeof apiClient.getTask === "function"
        ? apiClient.getTask.bind(apiClient)
        : new NautiloApiClient("").getTask.bind(apiClient);
  });

  afterAll(() => {
    apiClient.getTask = originalGetTask;
    reapplyHappyDomGlobals();
  });

  beforeEach(() => {
    getTask.mockClear();
    apiClient.getTask = getTask;
    dockList = [subagent({ taskId: "task-1", status: "running", line3: "step 1" })];
  });

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <RunningSubagentsContext.Provider value={{ list: dockList, heartbeat: { count: 1, line: "" } }}>
        {children}
      </RunningSubagentsContext.Provider>
    );
  }

  it("uses canonical running status when the task is absent from the dock", async () => {
    dockList = [];
    const { result } = renderHook(() => useSubagentTranscript("task-1"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBe("running");
  });

  it("does not fetch when taskId is null", async () => {
    const { result } = renderHook(() => useSubagentTranscript(null), { wrapper });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(getTask).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });

  it("does not fetch when enabled is false", async () => {
    const { result } = renderHook(() => useSubagentTranscript("task-1", { enabled: false }), { wrapper });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(getTask).not.toHaveBeenCalled();
  });

  it("fetches and maps transcript on enable", async () => {
    const { result } = renderHook(() => useSubagentTranscript("task-1", { enabled: true }), { wrapper });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.content).toBe("hello");
    expect(result.current.error).toBeNull();
  });

  it("re-fetches when dock snapshot refresh key changes", async () => {
    const { result, rerender } = renderHook(
      () => useSubagentTranscript("task-1", { enabled: true }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(getTask.mock.calls.length).toBe(1);

    dockList = [subagent({ taskId: "task-1", status: "running", line3: "step 2" })];
    rerender();

    await waitFor(() => {
      expect(getTask.mock.calls.length).toBe(2);
    });
  });

  it("surfaces fetch errors", async () => {
    getTask.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    const { result } = renderHook(() => useSubagentTranscript("task-1", { enabled: true }), { wrapper });
    await waitFor(() => {
      expect(result.current.error).toBe("network down");
    });
    expect(result.current.messages).toEqual([]);
  });
});
