import { describe, expect, test } from "bun:test";
import {
  getTaskCreationReturnContext,
  runWithTaskCreationReturnContext,
  taskCreationReturnContextForState,
} from "../../src/runtime/task-creation-return-context";
import type { NautiloState } from "../../src/agent/state";

function state(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    userId: "owner-1",
    trustedExecutionEntrypoint: "foreground.main",
    currentFolder: "/repo",
    currentFolderRelayId: "relay-1",
    workspacePath: "/workspace",
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "owner-1",
      actorId: "owner-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      requestId: "request-1",
    },
    ...overrides,
  } as NautiloState;
}

describe("M286 Task creation return context", () => {
  test("captures only a direct Human Desktop turn with an exact Current Folder relay", () => {
    expect(taskCreationReturnContextForState(state(), "socket-1", "browser-1")).toEqual({
      ownerId: "owner-1",
      relayId: "relay-1",
      relaySessionId: "socket-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      currentFolder: "/repo",
      workspacePath: "/workspace",
      browserSessionId: "browser-1",
    });
    expect(taskCreationReturnContextForState(state({
      trustedExecutionEntrypoint: "foreground.task_report_back",
    }), "socket-1")).toBeNull();
    expect(taskCreationReturnContextForState(state({ currentFolderRelayId: "relay-2" }), "socket-1"))
      .toBeNull();
    expect(taskCreationReturnContextForState(state({ verifiedOrdinaryOrigin: null }), "socket-1"))
      .toBeNull();
    expect(taskCreationReturnContextForState(state(), null)).toBeNull();
  });

  test("is process-local across awaits and absent outside the invocation", async () => {
    const captured = taskCreationReturnContextForState(state(), "socket-1");
    expect(getTaskCreationReturnContext()).toBeNull();
    await runWithTaskCreationReturnContext(captured, async () => {
      await Promise.resolve();
      expect(getTaskCreationReturnContext()).toEqual(captured);
    });
    expect(getTaskCreationReturnContext()).toBeNull();
  });

  test("a Human foreground fork still requires the same owner, folder, and connected relay", () => {
    const fork = state({ trustedExecutionEntrypoint: "foreground.fork" });
    expect(taskCreationReturnContextForState(fork, "socket-1"))
      .toEqual(taskCreationReturnContextForState(state(), "socket-1"));
    for (const override of [
      { userId: "another-owner" },
      { currentFolder: "" },
      { currentFolderRelayId: "another-relay" },
      { verifiedOrdinaryOrigin: null },
    ]) {
      expect(taskCreationReturnContextForState({ ...fork, ...override }, "socket-1"))
        .toBeNull();
    }
    expect(taskCreationReturnContextForState(fork, null)).toBeNull();
  });
});
