import { describe, expect, test } from "bun:test";
import type { NautiloState } from "../../src/agent/state";
import {
  getTaskCreationBackgroundTaskProvenance,
  getTaskCreationLiveMiniAppContext,
  runWithTaskCreationAmbientContext,
  taskCreationBackgroundTaskProvenanceForState,
  taskCreationLiveMiniAppContextForState,
} from "../../src/runtime/task-creation-live-mini-app-context";
import {
  getTaskCreationReturnContext,
  runWithTaskCreationReturnContext,
} from "../../src/runtime/task-creation-return-context";

const writerSession = {
  appId: "nautilo-writer",
  sessionToken: "writer-token",
  sessionId: "writer-session",
  documentVersion: { kind: "artifact_revision" as const, revision: 3 },
  instructions: "Use Writer tools.",
};

function state(overrides: Record<string, unknown> = {}): NautiloState {
  return {
    userId: "human-1",
    causalHumanUserId: "human-1",
    trustedExecutionEntrypoint: "foreground.main",
    activeMiniApp: { appId: "nautilo-writer", updatedAt: 1, summary: { title: "Draft" } },
    liveMiniAppSession: writerSession,
    ...overrides,
  } as NautiloState;
}

describe("D569 Task live mini-app capture", () => {
  test("captures only an exact direct Human foreground live-app turn", () => {
    const captured = taskCreationLiveMiniAppContextForState(state());
    expect(captured).toMatchObject({
      ownerId: "human-1",
      activeMiniApp: { appId: "nautilo-writer" },
      liveMiniAppSession: { sessionToken: "writer-token" },
    });
  });

  test("preserves the direct Human's own live session on a foreground fork", () => {
    const captured = taskCreationLiveMiniAppContextForState(state({
      trustedExecutionEntrypoint: "foreground.fork",
    }));
    expect(captured?.liveMiniAppSession).toEqual(writerSession);
    expect(captured?.liveMiniAppSession).not.toBe(writerSession);
  });

  test("copies advisory context but omits an absolute host document path", () => {
    const original = state({
      activeMiniApp: {
        appId: "nautilo-writer",
        updatedAt: 1,
        documentPath: "/Users/human/private/draft.md",
        summary: { title: "Draft" },
      },
    });
    const captured = taskCreationLiveMiniAppContextForState(original);
    expect(captured?.activeMiniApp.documentPath).toBeUndefined();
    expect(captured?.activeMiniApp.summary).toEqual({ title: "Draft" });
    expect(captured?.activeMiniApp.summary).not.toBe(original.activeMiniApp?.summary);
    expect(captured?.liveMiniAppSession.documentVersion)
      .not.toBe(original.liveMiniAppSession?.documentVersion);
  });

  test.each([
    ["report back", { trustedExecutionEntrypoint: "foreground.task_report_back" }],
    ["subagent", { trustedExecutionEntrypoint: "foreground.subagent" }],
    ["unattributed fork", { trustedExecutionEntrypoint: "foreground.fork", causalHumanUserId: "" }],
    ["fork without live authority", { trustedExecutionEntrypoint: "foreground.fork", liveMiniAppSession: null }],
    ["mismatched causal user", { causalHumanUserId: "other-human" }],
    ["mismatched active app", { activeMiniApp: { appId: "nautilo-design", updatedAt: 1 } }],
    ["different trusted session app", { liveMiniAppSession: { ...writerSession, appId: "nautilo-design" } }],
  ])("does not capture %s", (_label, overrides) => {
    expect(taskCreationLiveMiniAppContextForState(state(overrides))).toBeNull();
  });

  test("captures another matching live app without deciding its delegation policy", () => {
    const designSession = { ...writerSession, appId: "nautilo-design", sessionToken: "design-token" };
    const captured = taskCreationLiveMiniAppContextForState(state({
      activeMiniApp: { appId: "nautilo-design", updatedAt: 1 },
      liveMiniAppSession: designSession,
    }));
    expect(captured).toMatchObject({
      activeMiniApp: { appId: "nautilo-design" },
      liveMiniAppSession: { appId: "nautilo-design", sessionToken: "design-token" },
    });
  });

  test("captures only exact background Task provenance without live-app authority", () => {
    const backgroundState = state({
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "run-1",
    });
    expect(taskCreationBackgroundTaskProvenanceForState(backgroundState)).toEqual({
      ownerId: "human-1",
      taskId: "task-1",
      taskRunId: "run-1",
    });
    expect(taskCreationLiveMiniAppContextForState(backgroundState)).toBeNull();
  });

  test.each([
    ["foreground", {}],
    ["report back", { trustedExecutionEntrypoint: "foreground.task_report_back" }],
    ["missing Task", { trustedExecutionEntrypoint: "background.task", currentTaskRunId: "run-1" }],
    ["missing TaskRun", { trustedExecutionEntrypoint: "background.task", currentTaskId: "task-1" }],
  ])("does not manufacture background Task provenance for %s state", (_label, overrides) => {
    expect(taskCreationBackgroundTaskProvenanceForState(state(overrides))).toBeNull();
  });

  test("keeps live authority and background provenance in distinct slots of the existing ambient context", () => {
    const live = taskCreationLiveMiniAppContextForState(state());
    const provenance = taskCreationBackgroundTaskProvenanceForState(state({
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "run-1",
    }));
    expect(live).not.toBeNull();
    expect(provenance).not.toBeNull();

    runWithTaskCreationAmbientContext(live, provenance, () => {
      expect(getTaskCreationLiveMiniAppContext()).toBe(live);
      expect(getTaskCreationBackgroundTaskProvenance()).toBe(provenance);
    });

    expect(getTaskCreationLiveMiniAppContext()).toBeNull();
    expect(getTaskCreationBackgroundTaskProvenance()).toBeNull();
  });

  test("preserves the return slot while setting live task-creation facts", () => {
    const live = taskCreationLiveMiniAppContextForState(state());
    const provenance = taskCreationBackgroundTaskProvenanceForState(state({
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "run-1",
    }));
    const returnContext = {
      ownerId: "human-1",
      relayId: "relay-1",
      relaySessionId: "relay-session-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "generation-1",
      currentFolder: "/repo",
      workspacePath: "/workspace",
    };
    expect(live).not.toBeNull();
    expect(provenance).not.toBeNull();

    runWithTaskCreationReturnContext(returnContext, () => {
      runWithTaskCreationAmbientContext(live, provenance, () => {
        expect(getTaskCreationReturnContext()).toBe(returnContext);
        expect(getTaskCreationLiveMiniAppContext()).toBe(live);
        expect(getTaskCreationBackgroundTaskProvenance()).toBe(provenance);
      });
    });

    expect(getTaskCreationReturnContext()).toBeNull();
  });
});
