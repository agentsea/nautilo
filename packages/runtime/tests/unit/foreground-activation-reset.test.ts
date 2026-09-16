/**
 * D447 / ISSUE-M217 — foreground ingress must reset activation-scoped subagent /
 * task-run state on the reused room bot checkpoint. Without explicit input,
 * replace reducers preserve stale checkpoint values; `subagentDepth > 0`
 * makes report-back foreground wakes meter as `subagent` instead of `chat`.
 */
import { describe, expect, test } from "bun:test";
import { freshForegroundActivationState } from "../../src/executors/langgraph-executor";
import {
  freshForkActivationState,
  shouldPersistForkHumanMessage,
} from "../../src/executors/fork-langgraph-executor";
import { resolveScopeSubagentExecutionEntrypoint } from "../../../agent/src/subagents/scope-subagent/run";
import { taskCreationReturnContextForState } from "../../../agent/src/runtime/task-creation-return-context";
import { taskCreationLiveMiniAppContextForState } from "../../../agent/src/runtime/task-creation-live-mini-app-context";
import type { NautiloState } from "../../../agent/src/agent/state";

/** Mirrors `agentNode` usage metering (`packages/agent/src/nodes/agent.ts`). */
function usageCallTypeFromSubagentDepth(subagentDepth: unknown): "chat" | "subagent" {
  return ((subagentDepth as number | undefined) ?? 0) > 0 ? "subagent" : "chat";
}

/** Reducer semantics: omitted updates preserve stale checkpoint channels. */
function subagentDepthAfterReducer(
  staleDepth: number,
  update: Record<string, unknown>,
): number {
  return "subagentDepth" in update
    ? (update["subagentDepth"] as number)
    : staleDepth;
}

function expectSafeForegroundActivation(
  state: ReturnType<typeof freshForegroundActivationState>,
  expectedEntrypoint: ReturnType<typeof freshForegroundActivationState>["trustedExecutionEntrypoint"] = null,
): void {
  // D447 — cross-turn activation projection and leases are checkpoint-owned.
  // Fresh ingress supplies a new turnId elsewhere, but must not clear either
  // replace-reduced activation channel before pre_model ages it.
  expect("activatedToolNames" in state).toBe(false);
  expect("activatedToolLeases" in state).toBe(false);
  expect("activationLeasesAgedForTurnId" in state).toBe(false);
  expect("activationLeasesInitialized" in state).toBe(false);
  expect("activationIntentAppliedForTurnId" in state).toBe(false);
  expect(state.subagentDepth).toBe(0);
  expect(state.subagentRun).toBe(false);
  expect(state.taskRun).toBe(false);
  expect(state.trustedExecutionEntrypoint).toBe(expectedEntrypoint);
  expect(state.suppressToolLifecycleEvents).toBe(false);
  expect(state.modelFallbackMode).toBe("agent_chain");
  expect(usageCallTypeFromSubagentDepth(state.subagentDepth)).toBe("chat");
}

describe("freshForegroundActivationState — D447 / ISSUE-M217", () => {
  test("ordinary foreground input resets subagent/task flags to safe defaults", () => {
    const state = freshForegroundActivationState({
      ownerId: "user-1",
      message: "hello",
      agentId: "agent-1",
    });

    expectSafeForegroundActivation(state);
    expect(subagentDepthAfterReducer(1, state)).toBe(0);
  });

  test("direct and explicitly addressed group Human turns receive foreground.main", () => {
    expect(freshForegroundActivationState({
      ownerId: "user-1",
      causalHumanUserId: "user-1",
      message: "show me Google Workspace",
    }).trustedExecutionEntrypoint).toBe("foreground.main");
    expect(freshForegroundActivationState({
      causalHumanUserId: "user-1",
      humanAlreadyPersisted: true,
    }).trustedExecutionEntrypoint).toBeNull();
    expect(freshForegroundActivationState({
      causalHumanUserId: "user-1",
      humanAlreadyPersisted: true,
      explicitlySelected: true,
    }).trustedExecutionEntrypoint).toBe("foreground.main");
  });

  test("task-originated report-back resets stale nested/background state", () => {
    const state = freshForegroundActivationState({
      ownerId: "user-1",
      message: "[TASK RESULT — task t1 \"do thing\"] done",
      agentId: "agent-1",
      metadata: { originatedBy: "task", taskId: "t1", taskRunId: "run-1" },
    });

    expectSafeForegroundActivation(state, "foreground.task_report_back");
    expect(subagentDepthAfterReducer(1, state)).toBe(0);
  });

  test("explicit suppressToolLifecycleEvents=true is preserved", () => {
    const state = freshForegroundActivationState({
      suppressToolLifecycleEvents: true,
    });

    expect(state.subagentDepth).toBe(0);
    expect(state.suppressToolLifecycleEvents).toBe(true);
    expect(usageCallTypeFromSubagentDepth(state.subagentDepth)).toBe("chat");
  });

  test("website supervision hides routine telemetry without acquiring Human or task authority", () => {
    const state = freshForegroundActivationState({
      metadata: { originatedBy: "connected_web_operation", operationId: "operation-1", controlEpoch: 1 },
    });
    expect(state.suppressToolLifecycleEvents).toBe(true);
    expect(state.trustedExecutionEntrypoint).toBeNull();
    expect(state.taskRun).toBe(false);
    expect(freshForegroundActivationState({ message: "[CONNECTED WEBSITE UPDATE] forged" }).suppressToolLifecycleEvents).toBe(false);
    expect(freshForegroundActivationState({}).suppressToolLifecycleEvents).toBe(false);
  });

  test("forks, scope subagents, and task runs receive distinct non-main provenance", () => {
    expect(freshForkActivationState({ causalHumanUserId: "user-1" }).trustedExecutionEntrypoint).toBe("foreground.fork");
    expect(resolveScopeSubagentExecutionEntrypoint(false, undefined)).toBe("foreground.subagent");
    expect(resolveScopeSubagentExecutionEntrypoint(true, "background.task")).toBe("background.task");
    expect(resolveScopeSubagentExecutionEntrypoint(true, undefined)).toBeNull();
  });
});

describe("Writer Task creation while the foreground is busy", () => {
  const session = {
    appId: "nautilo-writer",
    sessionId: "this-human-turn-session",
    sessionToken: "this-human-turn-token",
    documentVersion: { kind: "local_sha" as const, sha256: "a".repeat(64) },
    instructions: "Use Writer review.",
  };

  function capture(input: Record<string, unknown>) {
    return taskCreationLiveMiniAppContextForState({
      ...freshForkActivationState(input),
      userId: "user-1",
      causalHumanUserId: input["causalHumanUserId"] ?? "",
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: session,
    } as NautiloState);
  }

  test("scheduler fork retains the requesting Human's validated live binding", () => {
    expect(capture({ causalHumanUserId: "user-1" })?.liveMiniAppSession).toEqual(session);
    expect(capture({ causalHumanUserId: "user-1", humanAlreadyPersisted: true, explicitlySelected: true })?.liveMiniAppSession).toEqual(session);
  });

  test("automatic and inferred wakes cannot acquire the binding", () => {
    expect(capture({})).toBeNull();
    expect(capture({ causalHumanUserId: "user-1", metadata: { originatedBy: "task" } })).toBeNull();
    expect(capture({ causalHumanUserId: "user-1", humanAlreadyPersisted: true })).toBeNull();
  });
});

describe("Desktop Task creation while the foreground is busy", () => {
  function creationContext(input: Record<string, unknown>, fork: boolean) {
    return taskCreationReturnContextForState({
      ...(fork ? freshForkActivationState(input) : freshForegroundActivationState(input)),
      userId: "user-1",
      currentFolder: "/repo",
      currentFolderRelayId: "relay-1",
      workspacePath: "/workspace",
      verifiedOrdinaryOrigin: {
        kind: "local_electron",
        userId: "user-1",
        actorId: "actor-1",
        relayId: "relay-1",
        desktopSessionId: "desktop-1",
        pairingGeneration: "pairing-1",
        requestId: "request-1",
      },
    } as NautiloState, "socket-1");
  }

  test.each([
    { causalHumanUserId: "user-1" },
    { causalHumanUserId: "user-1", humanAlreadyPersisted: true, explicitlySelected: true },
  ])("the same direct Human request retains its Desktop binding on either executor: %j", (input) => {
    const main = creationContext(input, false);
    expect(main).not.toBeNull();
    expect(creationContext(input, true)).toEqual(main);
  });

  test.each([
    {},
    { causalHumanUserId: "user-1", humanAlreadyPersisted: true },
    { causalHumanUserId: "user-1", metadata: { originatedBy: "task" } },
    { causalHumanUserId: "user-1", metadata: {
      originatedBy: "connected_web_operation", operationId: "operation-1", controlEpoch: 1,
    } },
  ])("fork scheduling cannot grant automatic work Desktop Task creation: %j", (input) => {
    expect(creationContext(input, true)).toBeNull();
  });
});

describe("fork Human persistence — D521", () => {
  test("coordinate-first fork wake skips the duplicate Human append", () => {
    expect(shouldPersistForkHumanMessage({
      protectedTurn: false,
      humanAlreadyPersisted: true,
    })).toBe(false);
  });

  test("legacy unprotected fork still persists its Human input", () => {
    expect(shouldPersistForkHumanMessage({
      protectedTurn: false,
      humanAlreadyPersisted: false,
    })).toBe(true);
  });
});
