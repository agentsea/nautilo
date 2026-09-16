import { describe, expect, test } from "bun:test";
import type { NautiloState } from "../../src/agent/state";
import {
  effectiveLiveMiniAppSessionForState,
  runWithLiveMiniAppExecutionContext,
} from "../../src/runtime/live-mini-app-execution-context";

const checkpointSession = {
  appId: "nautilo-writer",
  sessionToken: "checkpoint-token",
  sessionId: "checkpoint-session",
  documentVersion: { kind: "artifact_revision" as const, revision: 1 },
  instructions: "checkpoint",
};
const ephemeralSession = { ...checkpointSession, sessionToken: "ephemeral-token", sessionId: "ephemeral-session" };

describe("D569 effective live mini-app session", () => {
  test("foreground retains its state-backed session", () => {
    const state = { trustedExecutionEntrypoint: "foreground.main", liveMiniAppSession: checkpointSession } as NautiloState;
    expect(effectiveLiveMiniAppSessionForState(state)).toEqual(checkpointSession);
  });

  test("background ignores checkpointed authority and uses only the ephemeral context", () => {
    const state = { trustedExecutionEntrypoint: "background.task", liveMiniAppSession: checkpointSession } as NautiloState;
    expect(effectiveLiveMiniAppSessionForState(state)).toBeNull();
    runWithLiveMiniAppExecutionContext({
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: ephemeralSession,
    }, () => {
      expect(effectiveLiveMiniAppSessionForState(state)).toEqual(ephemeralSession);
    });
  });
});
