import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";
import { ClassifiedDataOperationError } from "@nautilo/lattice-bridge";
import type { ReactNode } from "react";
import type { TaskSummary } from "@nautilo/types";
import type { ProtectedScheduledTaskProjection } from
  "../../src/lib/protected-human-task-controller";
import {
  ConversationEncryptionPolicyModeContext,
  type ConversationEncryptionPolicyMode,
} from
  "../../src/adapters/runtime-contexts";

const controller = Object.freeze({});
let lastSuccessfulAtMs: number | null = null;
let ordinaryTasks: TaskSummary[] = [];
let viewerGeneration = 1;
let viewerId: string | null = "viewer-a";
let actorId: string | null = "actor-a";
interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let requests: Deferred<readonly ProtectedScheduledTaskProjection[]>[] = [];
let historyRequests: Deferred<unknown>[] = [];
const listProtected = mock(() => {
  const request = deferred<readonly ProtectedScheduledTaskProjection[]>();
  requests.push(request);
  return request.promise;
});
const createProtectedController = mock(() => controller);
const readProtectedHistory = mock(() => {
  const request = deferred<unknown>();
  historyRequests.push(request);
  return request.promise;
});
const refreshTasks = mock(async () => {});

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewerGeneration,
    viewer: {
      isVerified: true,
      sessionUserId: viewerId,
      sessionActorId: actorId,
    },
  }),
}));

mock.module("../../src/contexts/task-state/task-state-context", () => ({
  useTaskState: () => ({
    tasks: ordinaryTasks,
    loading: false,
    error: null,
    lastSuccessfulAtMs,
    busyIds: new Set<string>(),
    refresh: refreshTasks,
    pauseTask: async () => {},
    unpauseTask: async () => {},
    stopTask: async () => {},
    setDashboardPollingEnabled: () => {},
  }),
}));

mock.module("../../src/lib/encryption-data-operation-policy", () => ({
  createWorkbenchDataOperationOwner: () => Object.freeze({}),
}));

mock.module("../../src/lib/protected-human-task-controller", () => ({
  createWorkbenchProtectedHumanTaskController: createProtectedController,
  listProtectedScheduledTasks: listProtected,
  readWorkbenchTaskForViewer: readProtectedHistory,
}));

const { useScheduledTasks } = await import(
  "../../src/pages/scheduled-tasks/use-scheduled-tasks"
);

function policyWrapper(mode: ConversationEncryptionPolicyMode) {
  return function PolicyWrapper({ children }: { children: ReactNode }) {
    return (
      <ConversationEncryptionPolicyModeContext.Provider value={mode}>
        {children}
      </ConversationEncryptionPolicyModeContext.Provider>
    );
  };
}

const fullWrapper = policyWrapper("encrypted_only");
const plainWrapper = policyWrapper("plaintext_only");
let dynamicPolicyMode: ConversationEncryptionPolicyMode = "encrypted_only";
function dynamicPolicyWrapper({ children }: { children: ReactNode }) {
  return (
    <ConversationEncryptionPolicyModeContext.Provider value={dynamicPolicyMode}>
      {children}
    </ConversationEncryptionPolicyModeContext.Provider>
  );
}

function unavailableRow(id: string): ProtectedScheduledTaskProjection {
  return {
    availability: "unavailable",
    task: {
      id,
      scheduleKind: "cron",
      status: "pending",
      content: {
        dtoVersion: 1,
        status: "unavailable",
        reason: "waiting_for_authorization",
      },
    } as ProtectedScheduledTaskProjection["task"],
    reason: "waiting_for_authorization",
  };
}

function openedRow(id: string): ProtectedScheduledTaskProjection {
  return {
    availability: "opened",
    task: {
      id,
      scheduleKind: "cron",
      status: "pending",
    } as ProtectedScheduledTaskProjection["task"],
    prompt: "Private weekly digest",
    expectedOutput: null,
    retainedHistoricalError: null,
  };
}

describe("useScheduledTasks protected refresh", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    lastSuccessfulAtMs = null;
    ordinaryTasks = [];
    viewerGeneration = 1;
    viewerId = "viewer-a";
    actorId = "actor-a";
    dynamicPolicyMode = "encrypted_only";
    requests = [];
    historyRequests = [];
    listProtected.mockClear();
    readProtectedHistory.mockClear();
    createProtectedController.mockClear();
    refreshTasks.mockClear();
  });

  test("rechecks after a successful ordinary refresh and fences the stale read", async () => {
    const view = renderHook(() => useScheduledTasks(), { wrapper: fullWrapper });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));

    lastSuccessfulAtMs = 100;
    view.rerender();
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(2));

    const current = unavailableRow("current-task");
    requests[1]?.resolve([current]);
    await waitFor(() => expect(view.result.current.protectedTasks).toEqual([current]));

    requests[0]?.resolve([unavailableRow("stale-task")]);
    await Promise.resolve();
    expect(view.result.current.protectedTasks).toEqual([current]);
  });

  test.each([
    ["Fallback Shadow", "shadow_encryption"],
    ["Strict Shadow", "shadow_encryption"],
    ["Full", "encrypted_only"],
  ] as const)("keeps the dormant route quiet in %s", async (_policy, clientMode) => {
    const task = {
      id: `ordinary-${clientMode}`,
      parentTaskId: null,
      depth: 0,
      status: "pending",
      preset: "schedule",
      prompt: "send weekly digest",
      scheduleKind: "cron",
      cron: "0 9 * * 1",
      nextFireAt: "2026-10-01T09:00:00.000Z",
      callingRoomId: null,
    } as TaskSummary;
    ordinaryTasks = [task];
    // Workbench intentionally projects both Shadow behaviors to the same
    // client mode; the server policy retains the Fallback/Strict distinction.
    const view = renderHook(() => useScheduledTasks(), {
      wrapper: policyWrapper(clientMode),
    });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));

    requests[0]?.reject(Object.assign(new Error("not mounted"), { status: 404 }));
    await waitFor(() => expect(view.result.current.protectedLoading).toBe(false));

    lastSuccessfulAtMs = 100;
    view.rerender();
    await Promise.resolve();
    expect(listProtected).toHaveBeenCalledTimes(1);
    expect(view.result.current.protectedTasks).toEqual([]);
    expect(view.result.current.tasks).toEqual([task]);
  });

  test("keeps loaded rows visible after a protected refresh failure and retries it", async () => {
    const view = renderHook(() => useScheduledTasks(), { wrapper: fullWrapper });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));

    const loaded = unavailableRow("loaded-task");
    requests[0]?.resolve([loaded]);
    await waitFor(() => expect(view.result.current.protectedTasks).toEqual([loaded]));

    lastSuccessfulAtMs = 100;
    view.rerender();
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(2));
    requests[1]?.reject(new ApiError(503, "temporarily unavailable"));

    await waitFor(() => {
      expect(view.result.current.protectedError).toBe("temporarily unavailable");
    });
    expect(view.result.current.protectedTasks).toEqual([loaded]);

    await act(async () => { await view.result.current.refresh(); });
    expect(refreshTasks).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(3));

    const recovered = unavailableRow("recovered-task");
    requests[2]?.resolve([recovered]);
    await waitFor(() => expect(view.result.current.protectedTasks).toEqual([recovered]));
    expect(view.result.current.protectedError).toBeNull();
  });

  test("clears decrypted rows when current server authorization is rejected", async () => {
    const view = renderHook(() => useScheduledTasks(), { wrapper: fullWrapper });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));

    const opened = openedRow("opened-task");
    requests[0]?.resolve([opened]);
    await waitFor(() => expect(view.result.current.protectedTasks).toEqual([opened]));

    lastSuccessfulAtMs = 100;
    view.rerender();
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(2));
    requests[1]?.reject(new ApiError(403, "Forbidden"));

    await waitFor(() => expect(view.result.current.protectedError).toBe("Forbidden"));
    expect(view.result.current.protectedTasks).toEqual([]);
  });

  test("clears decrypted rows when current device custody becomes unavailable", async () => {
    const view = renderHook(() => useScheduledTasks(), { wrapper: fullWrapper });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));

    const opened = openedRow("opened-task");
    requests[0]?.resolve([opened]);
    await waitFor(() => expect(view.result.current.protectedTasks).toEqual([opened]));

    lastSuccessfulAtMs = 100;
    view.rerender();
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(2));
    requests[1]?.reject(new ClassifiedDataOperationError(
      "key_waiting",
      "Protected Task device custody is unavailable",
    ));

    await waitFor(() => {
      expect(view.result.current.protectedError).toBe(
        "Protected Task device custody is unavailable",
      );
    });
    expect(view.result.current.protectedTasks).toEqual([]);
  });

  test("Plain schedules remain visible after refresh without protected custody", async () => {
    const task = {
      id: "plain-schedule",
      parentTaskId: null,
      depth: 0,
      status: "pending",
      preset: "schedule",
      prompt: "send weekly digest",
      scheduleKind: "cron",
      cron: "0 9 * * 1",
      nextFireAt: "2026-10-01T09:00:00.000Z",
      callingRoomId: null,
    } as TaskSummary;
    ordinaryTasks = [task];
    const view = renderHook(() => useScheduledTasks(), { wrapper: plainWrapper });
    expect(view.result.current.tasks).toEqual([task]);
    expect(view.result.current.protectedTasks).toEqual([]);
    expect(view.result.current.protectedLoading).toBe(false);
    expect(createProtectedController).not.toHaveBeenCalled();
    expect(listProtected).not.toHaveBeenCalled();
    expect(readProtectedHistory).not.toHaveBeenCalled();

    await act(async () => { await view.result.current.refresh(); });
    expect(refreshTasks).toHaveBeenCalledTimes(1);
    expect(view.result.current.tasks).toEqual([task]);
    expect(createProtectedController).not.toHaveBeenCalled();
    expect(listProtected).not.toHaveBeenCalled();
    expect(readProtectedHistory).not.toHaveBeenCalled();
  });

  test("loads exact stored run metadata only when protected history is opened", async () => {
    const view = renderHook(() => useScheduledTasks(), { wrapper: fullWrapper });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));
    requests[0]?.resolve([openedRow("scheduled-task")]);
    await waitFor(() => expect(view.result.current.protectedTasks).toHaveLength(1));

    act(() => view.result.current.openProtectedHistory("scheduled-task"));
    expect(view.result.current.protectedHistory).toEqual({
      taskId: "scheduled-task",
      state: "loading",
    });
    expect(readProtectedHistory).toHaveBeenCalledWith({
      owner: view.result.current.protectedOwner,
      taskId: "scheduled-task",
      protectedController: controller,
    });

    const runs = [{
      id: "stored-run",
      status: "completed",
      modelId: null,
      startedAt: "2026-10-08T10:00:00.000Z",
      completedAt: "2026-10-08T10:01:00.000Z",
      content: {
        dtoVersion: 1,
        status: "unavailable",
        reason: "waiting_for_authorization",
      },
    }];
    historyRequests[0]?.resolve({
      representation: "protected",
      opened: {},
      runs,
    });
    await waitFor(() => expect(view.result.current.protectedHistory).toEqual({
      taskId: "scheduled-task",
      state: "ready",
      runs,
    }));
  });

  test("clears history and fences its late read when the viewer changes", async () => {
    const view = renderHook(() => useScheduledTasks(), { wrapper: fullWrapper });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));
    act(() => view.result.current.openProtectedHistory("scheduled-task"));
    expect(view.result.current.protectedHistory?.state).toBe("loading");

    viewerGeneration = 2;
    viewerId = "viewer-b";
    actorId = "actor-b";
    view.rerender();
    expect(view.result.current.protectedHistory).toBeNull();

    historyRequests[0]?.resolve({
      representation: "protected",
      opened: {},
      runs: [{ id: "late-run" }],
    });
    await Promise.resolve();
    expect(view.result.current.protectedHistory).toBeNull();
  });

  test("clears history and fences its late read when policy mode changes", async () => {
    const view = renderHook(() => useScheduledTasks(), {
      wrapper: dynamicPolicyWrapper,
    });
    await waitFor(() => expect(listProtected).toHaveBeenCalledTimes(1));
    act(() => view.result.current.openProtectedHistory("scheduled-task"));
    expect(view.result.current.protectedHistory?.state).toBe("loading");

    dynamicPolicyMode = "plaintext_only";
    view.rerender();
    expect(view.result.current.protectedHistory).toBeNull();

    historyRequests[0]?.resolve({
      representation: "protected",
      opened: {},
      runs: [{ id: "late-run" }],
    });
    await Promise.resolve();
    expect(view.result.current.protectedHistory).toBeNull();
  });
});
