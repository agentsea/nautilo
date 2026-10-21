import { describe, expect, test } from "bun:test";
import type { CodexRequestEvent } from "@nautilo/types";

import { recoverCurrentProtectedTaskExternalRequests } from "./protected-task-external-request-recovery";
import {
  initialCodexRequestLifecycleState,
  reduceCodexRequestLifecycle,
  type CodexRequestLifecycleAction,
} from "./runtime-contexts";

function event(requestId: string, overrides: Partial<CodexRequestEvent> = {}): CodexRequestEvent {
  return {
    type: "codex.request",
    ownerId: "owner-a",
    requestId,
    taskId: "task-a",
    jobId: "job-a",
    roomId: "room-a",
    expiresAt: "2026-10-13T12:00:00.000Z",
    request: {
      kind: "user_input_required",
      questions: [{
        id: "choice",
        header: "Choice",
        prompt: "Choose the exact action",
        secret: false,
        allowOther: false,
        options: null,
      }],
      autoResolutionMs: null,
    },
    ...overrides,
  };
}

describe("protected Task external request recovery", () => {
  test("retains admitted content when a same-scope refresh is temporarily unavailable", async () => {
    let state = reduceCodexRequestLifecycle(initialCodexRequestLifecycleState(), {
      kind: "arm",
      event: event("protected-a"),
    });
    const actions: CodexRequestLifecycleAction[] = [];
    const currentIds = new Set(["protected-a"]);
    const result = await recoverCurrentProtectedTaskExternalRequests({
      client: {
        recoverProtectedTaskExternalRequests: async request => {
          expect(request.requestId).toBeUndefined();
          return { status: "unavailable", entries: [] };
        },
        respondProtectedTaskExternalRequest: async () => ({ status: "unavailable" }),
      },
      clientActionSessionId: "session-a",
      signal: new AbortController().signal,
      isCurrent: () => true,
      previousRequestIds: currentIds,
      dispatch: action => {
        actions.push(action);
        state = reduceCodexRequestLifecycle(state, action);
      },
    });

    expect(result).toBeNull();
    expect(actions).toEqual([]);
    expect(state.byId["protected-a"]).toEqual(event("protected-a"));
    expect(currentIds).toEqual(new Set(["protected-a"]));
  });

  test("an unrelated ordinary event does not starve a ready protected recovery", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let state = initialCodexRequestLifecycleState();
    const recovery = recoverCurrentProtectedTaskExternalRequests({
      client: {
        recoverProtectedTaskExternalRequests: async () => {
          await wait;
          return { status: "ready", entries: [{ event: event("protected-a"), responseCapability: "capability" }] };
        },
        respondProtectedTaskExternalRequest: async () => ({ status: "unavailable" }),
      },
      clientActionSessionId: "session-a",
      signal: new AbortController().signal,
      isCurrent: () => true,
      previousRequestIds: new Set(),
      dispatch: action => { state = reduceCodexRequestLifecycle(state, action); },
    });
    state = reduceCodexRequestLifecycle(state, {
      kind: "arm",
      event: event("ordinary-a", { roomId: "room-b" }),
    });
    release();

    expect(await recovery).toEqual(new Set(["protected-a"]));
    expect(state.order).toEqual(["ordinary-a", "protected-a"]);
  });

  test("terminal facts observed during recovery prevent protected resurrection", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let state = initialCodexRequestLifecycleState();
    const recovery = recoverCurrentProtectedTaskExternalRequests({
      client: {
        recoverProtectedTaskExternalRequests: async () => {
          await wait;
          return { status: "ready", entries: [{ event: event("protected-a"), responseCapability: "capability" }] };
        },
        respondProtectedTaskExternalRequest: async () => ({ status: "unavailable" }),
      },
      clientActionSessionId: "session-a",
      signal: new AbortController().signal,
      isCurrent: () => true,
      previousRequestIds: new Set(),
      dispatch: action => { state = reduceCodexRequestLifecycle(state, action); },
    });
    state = reduceCodexRequestLifecycle(state, { kind: "clear_task", taskId: "task-a" });
    release();
    await recovery;

    expect(state.byId["protected-a"]).toBeUndefined();
    expect(state.terminalTaskIds).toContain("task-a");
  });
});
