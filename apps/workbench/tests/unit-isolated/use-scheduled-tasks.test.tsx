import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
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
const listProtected = mock(() => {
  const request = deferred<readonly ProtectedScheduledTaskProjection[]>();
  requests.push(request);
  return request.promise;
});
const createProtectedController = mock(() => controller);

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewerGeneration: 1,
    viewer: {
      isVerified: true,
      sessionUserId: "viewer-a",
      sessionActorId: "actor-a",
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
    refresh: async () => {},
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

describe("useScheduledTasks protected refresh", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    lastSuccessfulAtMs = null;
    ordinaryTasks = [];
    requests = [];
    listProtected.mockClear();
    createProtectedController.mockClear();
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

    lastSuccessfulAtMs = 100;
    view.rerender();
    expect(view.result.current.tasks).toEqual([task]);
    expect(createProtectedController).not.toHaveBeenCalled();
    expect(listProtected).not.toHaveBeenCalled();
  });
});
