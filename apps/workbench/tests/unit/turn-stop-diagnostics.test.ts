import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../");
const runtimeSource = readFileSync(
  join(repoRoot, "src/adapters/nautilo-runtime.tsx"),
  "utf8",
);
const contextSource = readFileSync(
  join(repoRoot, "src/adapters/runtime-contexts.ts"),
  "utf8",
);
const conversationSource = readFileSync(
  join(repoRoot, "src/components/conversation.tsx"),
  "utf8",
);

function slice(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Turn stop diagnostics", () => {
  test("VoiceControls exposes turn stop status separately from voice playback stop", () => {
    expect(contextSource).toMatch(/export type TurnStopFailureReason = "no-target" \| "request-failed" \| "not-live"/);
    expect(contextSource).toMatch(/export type TurnStopStatus =/);
    expect(contextSource).toMatch(/state: "stopped"/);
    expect(contextSource).toMatch(/turnStopStatus: TurnStopStatus/);
    expect(contextSource).toMatch(/turnStopStatus: \{ state: "idle", attemptId: 0 \}/);
  });

  test("runtime classifies stop failures into user-visible turn stop status", () => {
    const stopKnownJobIds = slice(
      runtimeSource,
      "const stopKnownJobIds = useCallback(",
      "const updateMessageReactions = useCallback(",
    );
    const stopActiveJobs = slice(
      runtimeSource,
      "const stopActiveJobs = useCallback(() => {",
      "const voiceControls: VoiceControls = {",
    );

    expect(stopKnownJobIds).toMatch(/setTurnStopStatus\(\{ state: "stopping", attemptId \}\)/);
    expect(stopKnownJobIds).toMatch(/failure = "request-failed"/);
    expect(stopKnownJobIds).toMatch(/failure = "not-live"/);
    expect(stopKnownJobIds).toMatch(/for \(const id of stoppedIds\) liveJobIdsRef\.current\.add\(id\)/);
    expect(stopKnownJobIds).toMatch(/setIsRunning\(hasLiveJobForActiveRoom\(\)\)/);
    expect(stopKnownJobIds).toMatch(/setTurnStopStatus\(\{ state: "failed", reason: failure, attemptId \}\)/);
    expect(stopKnownJobIds).toMatch(/setTurnStopStatus\(\{ state: "stopped", attemptId \}\)/);
    expect(stopActiveJobs).toMatch(/apiClient\.stopRoom\(activeRoom\)/);
    expect(stopActiveJobs).toMatch(/reason: "request-failed"/);
    expect(stopActiveJobs).toMatch(/setTurnStopFailed\("no-target"\)/);
    const roomStopBranch = stopActiveJobs.slice(
      stopActiveJobs.indexOf("if (activeRoom)"),
      stopActiveJobs.indexOf("if (stopKnownJobIds(ids)) return"),
    );
    expect(roomStopBranch).not.toMatch(/liveJobIdsRef\.current\.delete/);
    expect(roomStopBranch).not.toMatch(/setIsRunning\(false\)/);
    expect(roomStopBranch).toMatch(/setTurnStopStatus\(\{ state: "stopped", attemptId \}\)/);
    expect(runtimeSource).toMatch(
      /event\.status === "cancelled"[\s\S]*current\.state === "stopping" \|\| current\.state === "queued"[\s\S]*state: "stopped"/,
    );
  });

  test("composer shows toasts for failed turn stop attempts only", () => {
    const toastEffect = slice(
      conversationSource,
      "useEffect(() => {\n    const status = voice.turnStopStatus;",
      "const canSend",
    );

    expect(toastEffect).toMatch(/status\.state !== "failed"/);
    expect(toastEffect).toMatch(/lastTurnStopToastAttemptRef\.current === status\.attemptId/);
    expect(toastEffect).toMatch(/Stop couldn't find the running turn/);
    expect(toastEffect).toMatch(/Turn was not live/);
    expect(toastEffect).toMatch(/Stop request failed/);
    expect(toastEffect).not.toMatch(/success/);
  });

  test("composer exposes the terminal stopped state", () => {
    expect(conversationSource).toMatch(
      /voice\.turnStopStatus\.state === "stopped"[\s\S]*\? "Stopped"/,
    );
  });
});
