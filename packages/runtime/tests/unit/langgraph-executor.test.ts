import { beforeEach, describe, expect, test } from "bun:test";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";
import {
  getOrCreateAgentTurnContext,
  bindModelAttemptProgressSinkByKey,
  _resetAgentTurnContextsForTests,
} from "@nautilo/agent";
import {
  processStreamEvent,
  freshForegroundActivationState,
  freshForegroundRecordContextEligible,
  freshForegroundTurnScopedGraphContext,
  shouldGraphAbortOnStreamTimeout,
} from "../../src/executors/langgraph-executor";

describe("fresh foreground turn-scoped graph context", () => {
  test("preserves valid supplied context and explicitly clears omitted context", () => {
    const activeMiniApp = { appId: "writer", updatedAt: 1 };
    const liveMiniAppSession = {
      appId: "writer",
      sessionToken: "session-token",
      sessionId: "session-id",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
      instructions: "Review the Writer document.",
    };

    expect(
      freshForegroundTurnScopedGraphContext({
        activeMiniApp,
        liveMiniAppSession,
        artifactRefs: [{ artifactId: "artifact-1", path: "docs/a.md", mimeType: "text/markdown", size: 1 }],
        focusedResources: [{
          kind: "workspace-artifact",
          displayName: "a.md",
          location: "server",
          lifetime: "workspace",
          capabilities: ["read"],
          locator: { artifactId: "artifact-1" },
        }],
      }),
    ).toEqual({
      activeMiniApp,
      liveMiniAppSession,
      artifactRefs: [{ artifactId: "artifact-1", path: "docs/a.md", mimeType: "text/markdown", size: 1 }],
      focusedResources: [{
        kind: "workspace-artifact",
        displayName: "a.md",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        locator: { artifactId: "artifact-1" },
      }],
    });
    expect(freshForegroundTurnScopedGraphContext({})).toEqual({
      activeMiniApp: null,
      liveMiniAppSession: null,
      artifactRefs: [],
      focusedResources: [],
    });
  });
});

describe("D513/D574 foreground provenance", () => {
  test("recognizes direct and explicitly addressed group Human turns as foreground.main", () => {
    expect(freshForegroundActivationState({ causalHumanUserId: "user-1" }).trustedExecutionEntrypoint)
      .toBe("foreground.main");
    expect(freshForegroundActivationState({
      causalHumanUserId: "user-1",
      humanAlreadyPersisted: true,
    }).trustedExecutionEntrypoint).toBeNull();
    expect(freshForegroundActivationState({
      causalHumanUserId: "user-1",
      humanAlreadyPersisted: true,
      explicitlySelected: true,
    }).trustedExecutionEntrypoint).toBe("foreground.main");
    expect(freshForegroundActivationState({
      causalHumanUserId: "user-1",
      metadata: { originatedBy: "task" },
    }).trustedExecutionEntrypoint).toBe("foreground.task_report_back");
    expect(freshForegroundActivationState({}).trustedExecutionEntrypoint).toBeNull();
  });
});

describe("M277 foreground Record-context topology", () => {
  test("includes direct and already-persisted group Room turns", () => {
    expect(freshForegroundRecordContextEligible({ roomId: "room-1" })).toBe(true);
    expect(freshForegroundRecordContextEligible({
      roomId: "room-1",
      humanAlreadyPersisted: true,
    })).toBe(true);
  });

  test("excludes Task, Subtask/subagent, scope-only, and non-Room work", () => {
    expect(freshForegroundRecordContextEligible({
      roomId: "room-1",
      metadata: { originatedBy: "task" },
    })).toBe(false);
    expect(freshForegroundRecordContextEligible({ roomId: "room-1", taskRun: true })).toBe(false);
    expect(freshForegroundRecordContextEligible({ roomId: "room-1", subagentRun: true })).toBe(false);
    expect(freshForegroundRecordContextEligible({ roomId: "room-1", scopeId: "scope-1" })).toBe(false);
    expect(freshForegroundRecordContextEligible({})).toBe(false);
  });
});

describe("D563 Runtime model-attempt progress reporter", () => {
  beforeEach(() => _resetAgentTurnContextsForTests());

  test("reports only meaningful events for the exact active attempt", () => {
    const seen: string[] = [];
    const turnContextId = "turn-1::agent-1";
    bindModelAttemptProgressSinkByKey(turnContextId, {
      attemptId: "attempt-current",
      reportMeaningfulProgress: (attemptId) => {
        if (attemptId !== "attempt-current") return false;
        seen.push(attemptId);
        return true;
      },
    });
    const batcher = new TokenBatcher({ laneKey: "app:test" });
    const tracker = new ToolCallTracker();
    const context = { turnContextId };

    processStreamEvent(
      { event: "on_chat_model_start", metadata: { model_attempt_id: "attempt-current" } },
      batcher, tracker, context,
    );
    processStreamEvent(
      { event: "on_chat_model_stream", data: { chunk: { content: "" } } },
      batcher, tracker, context,
    );
    processStreamEvent(
      { event: "on_chat_model_stream", metadata: { model_attempt_id: "attempt-old" }, data: { chunk: { content: "late" } } },
      batcher, tracker, context,
    );
    processStreamEvent(
      { event: "on_chat_model_stream", data: { chunk: { reasoning_content: "thought" } } },
      batcher, tracker, context,
    );

    expect(seen).toEqual(["attempt-current"]);
    expect("streamTimeout" in context).toBe(false);
  });
});

describe("shouldGraphAbortOnStreamTimeout (D264)", () => {
  beforeEach(() => {
    _resetAgentTurnContextsForTests();
  });

  test("returns false until assistantVisibleOutput is set", () => {
    const turnId = "turn-abort-gate";
    expect(shouldGraphAbortOnStreamTimeout(turnId)).toBe(false);
    getOrCreateAgentTurnContext(turnId).assistantVisibleOutput = true;
    expect(shouldGraphAbortOnStreamTimeout(turnId)).toBe(true);
  });
});
