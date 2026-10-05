import { ApiError } from "@nautilo/api-client/browser";
import { describe, expect, jest, test } from "bun:test";
import {
  harnessTaskToolRenderers,
  harnessTaskFailureOutcome,
  harnessTaskCanonicalStatus,
  isHarnessTaskActive,
  nativeTaskControlState,
  nativeTaskResumeDisabled,
  nativeTaskFundingState,
  parseHarnessTaskResult,
  settleHarnessActivity,
  shouldMarkNativeTaskCancelled,
  startTaskDetailRefresh,
  taskActionScopeToken,
  taskFundingFailureFromApiError,
} from "../HarnessTaskToolCard";
import { harnessPresentation, harnessReceiptEmptyLabel } from "../harness-presentation";

describe("parseHarnessTaskResult", () => {
  test("routes both Codex dispatch tools through the live harness card", () => {
    expect(Object.keys(harnessTaskToolRenderers)).toEqual(["task", "in_background"]);
  });

  test("recognizes the deterministic external-harness task result", () => {
    expect(parseHarnessTaskResult(JSON.stringify({
      taskId: "task-1",
      status: "pending",
      execution: "codex",
      message: "Codex is working.",
    }))).toEqual({
      taskId: "task-1",
      status: "pending",
      execution: "codex",
      message: "Codex is working.",
    });
  });

  test("presents native in_background receipts with canonical Task Stop", () => {
    expect(parseHarnessTaskResult(JSON.stringify({
      taskId: "task-native",
      status: "pending",
      execution: "native",
      message: "The task is running in the background.",
    }))).toMatchObject({
      taskId: "task-native",
      execution: "native",
    });
    expect(harnessPresentation("native")).toMatchObject({
      displayName: "Background task",
      supportsPauseResume: true,
      supportsTaskStop: true,
    });
  });

  test("presents ACP harnesses with canonical Task Stop but no unsupported harness controls", () => {
    expect(parseHarnessTaskResult({
      taskId: "task-hermes",
      status: "pending",
      execution: "hermes-acp",
    })?.execution).toBe("hermes-acp");
    expect(parseHarnessTaskResult({
      taskId: "task-opencode",
      execution: "opencode-acp",
    })).toEqual({
      taskId: "task-opencode",
      execution: "opencode-acp",
    });
    expect(harnessPresentation("hermes-acp")).toMatchObject({
      displayName: "Hermes via ACP",
      supportsPauseResume: false,
      supportsTaskStop: true,
      supportsRequests: false,
    });
    expect(harnessPresentation("opencode-acp")).toMatchObject({
      displayName: "OpenCode via ACP",
      workingLabel: "OpenCode is working",
      taskLabel: "OpenCode task",
      failedLabel: "OpenCode failed",
      stoppedLabel: "OpenCode stopped",
      waitingLabel: "Waiting for OpenCode activity…",
      supportsPauseResume: false,
      supportsTaskStop: true,
      supportsRequests: false,
    });
    expect(harnessPresentation("codex")).toMatchObject({
      displayName: "Codex",
      supportsTaskStop: true,
      supportsRequests: true,
    });
    expect(harnessPresentation("unknown-harness")).toBeNull();
  });

  test("uses truthful provider-aware receipt copy when activity is not durable", () => {
    const hermes = harnessPresentation("hermes-acp");
    const codex = harnessPresentation("codex");
    const opencode = harnessPresentation("opencode-acp");
    if (!hermes || !codex || !opencode) throw new Error("expected reviewed harness presentations");

    expect(harnessReceiptEmptyLabel(hermes, "completed", "pending", false)).toBe(
      "Hermes completed this task. Its authoritative result is reported in this Room.",
    );
    expect(harnessReceiptEmptyLabel(hermes, "errored", "pending", false)).toBe(
      "Hermes failed this task. Its authoritative failure is reported in this Room.",
    );
    expect(harnessReceiptEmptyLabel(hermes, "cancelled", "pending", false)).toBe(
      "Hermes stopped this task. Its authoritative status is reported in this Room.",
    );
    expect(harnessReceiptEmptyLabel(hermes, "pending", "pending", false)).toBe(
      "Hermes accepted this task. Its authoritative result appears separately in this Room.",
    );
    expect(harnessReceiptEmptyLabel(hermes, "running", "pending", true)).toBe(
      "Waiting for Hermes activity…",
    );
    expect(harnessReceiptEmptyLabel(hermes, undefined, "pending", false)).toBe(
      "Hermes accepted this task. Its authoritative result appears separately in this Room.",
    );
    expect(harnessReceiptEmptyLabel(opencode, undefined, undefined, false)).toBe(
      "OpenCode accepted this task. Its authoritative result appears separately in this Room.",
    );
    expect(harnessReceiptEmptyLabel(codex, "completed", "pending", false)).toBe(
      "Codex completed this task. Its authoritative result is reported in this Room.",
    );
    expect(harnessReceiptEmptyLabel(opencode, "completed", "pending", false)).toBe(
      "OpenCode completed this task. Its authoritative result is reported in this Room.",
    );
    expect(harnessReceiptEmptyLabel(opencode, "errored", "pending", false)).toBe(
      "OpenCode failed this task. Its detailed outcome and recovery guidance are reported in this Room.",
    );
    expect(harnessReceiptEmptyLabel(opencode, "cancelled", "pending", false)).toBe(
      "OpenCode stopped this task. Its authoritative status is reported in this Room.",
    );
    expect(harnessReceiptEmptyLabel(opencode, "pending", "pending", false)).toBe(
      "OpenCode accepted this task. Its authoritative result appears separately in this Room.",
    );
    expect(harnessReceiptEmptyLabel(opencode, "running", "pending", true)).toBe(
      "Waiting for OpenCode activity…",
    );
  });

  test("reconciles a historical OpenCode receipt from durable TaskRun failure truth", () => {
    const opencode = harnessPresentation("opencode-acp");
    if (!opencode) throw new Error("expected OpenCode presentation");
    const detail = {
      task: { status: "errored" },
      runs: [{ resultText: "OpenCode failed because the paired desktop connection closed. Review the workspace before retrying." }],
    } as never;
    expect(harnessTaskFailureOutcome(opencode, detail)).toBe(
      "OpenCode failed because the paired desktop connection closed. Review the workspace before retrying.",
    );
    expect(harnessTaskFailureOutcome(opencode, { task: { status: "errored" }, runs: [{ resultText: null }] } as never)).toBe(
      "OpenCode via ACP failed. This older Task did not record a detailed failure outcome. Review the workspace before retrying.",
    );
    expect(harnessTaskFailureOutcome(opencode, { task: { status: "completed" }, runs: [] } as never)).toBeNull();
    expect(harnessTaskFailureOutcome(opencode, { task: { status: "errored" }, runs: [{ resultText: null }] } as never, "cancelled")).toBeNull();
  });

  test("rejects arbitrary task output instead of presenting it as a harness", () => {
    expect(parseHarnessTaskResult("not json")).toBeNull();
    expect(parseHarnessTaskResult({ status: "pending" })).toBeNull();
  });
});

describe("settleHarnessActivity", () => {
  test("lets durable terminal Task truth override a stale running overlay", () => {
    expect(isHarnessTaskActive("completed", "running")).toBe(false);
    expect(isHarnessTaskActive("errored", "running")).toBe(false);
    expect(isHarnessTaskActive("cancelled", "paused")).toBe(false);
    expect(isHarnessTaskActive("running", "running")).toBe(true);
    expect(isHarnessTaskActive(undefined, "awaiting")).toBe(true);
    expect(isHarnessTaskActive("paused", undefined)).toBe(true);
    expect(isHarnessTaskActive("awaiting", "running")).toBe(true);
  });

  test("preserves a stopped command and settles its live visual state", () => {
    expect(settleHarnessActivity([{
      id: "command-1",
      kind: "command",
      name: "run_command",
      status: "running",
      args: { command: "sleep 45" },
      result: "Command started\nsleep 45",
      startedAt: 100,
    }], "completed", 250)).toEqual([{
      id: "command-1",
      kind: "command",
      name: "run_command",
      status: "completed",
      args: { command: "sleep 45" },
      result: "Command started\nsleep 45",
      startedAt: 100,
      endedAt: 250,
    }]);
  });

  test("settles an unfinished activity as failed when the durable Task errored", () => {
    expect(settleHarnessActivity([{
      id: "tool-1",
      kind: "tool",
      name: "security_scan",
      status: "running",
      args: {},
      startedAt: 100,
    }], "errored", 150)).toEqual([{
      id: "tool-1",
      kind: "tool",
      name: "security_scan",
      status: "failed",
      args: {},
      startedAt: 100,
      endedAt: 150,
    }]);
  });

  test("parked activity is not rewritten as successfully completed", () => {
    const activity = [{ id: "unfinished", kind: "tool" as const, name: "file", status: "running" as const, args: {}, startedAt: 10 }];
    expect(settleHarnessActivity(activity, "paused", 20)).toEqual(activity);
    expect(settleHarnessActivity(activity, "awaiting", 20)).toEqual(activity);
  });
});

describe("nativeTaskFundingState", () => {
  test("surfaces the admitted personal source and quota recovery from the latest run", () => {
    expect(nativeTaskFundingState("native", {
      task: { status: "paused", fundingFailure: null },
      runs: [{ fundingSource: "personal", fundingFailure: "personal_provider_unavailable" }],
    } as never, undefined)).toEqual({
      source: "personal",
      failure: "personal_provider_unavailable",
    });
  });

  test("uses a live refusal or stale-key failure when detail has not refreshed yet", () => {
    expect(nativeTaskFundingState("native", {
      task: { status: "paused", fundingFailure: null },
      runs: [{ fundingSource: "personal", fundingFailure: null }],
    } as never, { fundingFailure: "personal_credentials_forbidden" } as never)).toEqual({
      source: "personal",
      failure: "personal_credentials_forbidden",
    });
    expect(nativeTaskFundingState("native", null, {
      fundingFailure: "personal_credential_stale",
    } as never)).toEqual({
      source: null,
      failure: "personal_credential_stale",
    });
    expect(nativeTaskResumeDisabled("personal_credentials_forbidden")).toBe(false);
    expect(nativeTaskResumeDisabled("personal_credential_stale")).toBe(true);
    expect(nativeTaskResumeDisabled("funding_source_changed")).toBe(true);
  });

  test("does not project native funding state onto external harness cards", () => {
    expect(nativeTaskFundingState("codex", {
      task: { fundingFailure: "personal_credential_stale" },
      runs: [{ fundingSource: "personal", fundingFailure: "personal_credential_stale" }],
    } as never, undefined)).toBeNull();
  });

  test("offers native pause/resume controls and blocks stale runs from resuming", () => {
    expect(nativeTaskControlState("native", "running", null)).toEqual({
      showPause: true,
      showResume: false,
      resumeDisabled: false,
    });
    expect(nativeTaskControlState("native", "paused", "personal_provider_unavailable")).toEqual({
      showPause: false,
      showResume: true,
      resumeDisabled: false,
    });
    expect(nativeTaskControlState("native", "paused", "personal_credential_stale")).toEqual({
      showPause: false,
      showResume: true,
      resumeDisabled: true,
    });
    expect(nativeTaskControlState("codex", "paused", "personal_credential_stale")).toEqual({
      showPause: false,
      showResume: false,
      resumeDisabled: false,
    });
  });

  test("accepts only safe funding codes from lifecycle conflicts", () => {
    expect(taskFundingFailureFromApiError(new ApiError(409, "personal_credential_stale")))
      .toBe("personal_credential_stale");
    expect(taskFundingFailureFromApiError(new ApiError(409, "private detail"))).toBeNull();
    expect(taskFundingFailureFromApiError(new ApiError(500, "personal_credential_stale"))).toBeNull();
  });

  test("marks native Stop locally only from a canonical cancelled response", () => {
    expect(shouldMarkNativeTaskCancelled("cancelled")).toBe(true);
    expect(shouldMarkNativeTaskCancelled("completed")).toBe(false);
    expect(shouldMarkNativeTaskCancelled("errored")).toBe(false);
    expect(shouldMarkNativeTaskCancelled(undefined)).toBe(false);
  });

  test("fences lifecycle outcomes by both viewer scope and Task identity", () => {
    const current = taskActionScopeToken("server-a|viewer-1", "task-1");
    expect(taskActionScopeToken("server-a|viewer-1", "task-1")).toBe(current);
    expect(taskActionScopeToken("server-a|viewer-1", "task-2")).not.toBe(current);
    expect(taskActionScopeToken("server-a|viewer-2", "task-1")).not.toBe(current);
  });

  test("lets refreshed durable native status override a stale live summary", () => {
    expect(harnessTaskCanonicalStatus({
      execution: "native",
      durableStatus: "completed",
      protectedStatus: undefined,
      liveStatus: "paused",
    })).toBe("completed");
    expect(harnessTaskCanonicalStatus({
      execution: "native",
      durableStatus: undefined,
      protectedStatus: "completed",
      liveStatus: "pending",
    })).toBe("completed");
    expect(harnessTaskCanonicalStatus({
      execution: "codex",
      durableStatus: "completed",
      protectedStatus: undefined,
      liveStatus: "running",
    })).toBe("running");
  });

  test("refreshes active native detail until completion and stops its timer", async () => {
    jest.useFakeTimers();
    try {
      const values: Array<{ status: string; failure: string | null }> = [];
      const responses = [
        { status: "pending", failure: null },
        { status: "paused", failure: "personal_provider_unavailable" },
        { status: "completed", failure: null },
      ];
      let reads = 0;
      const stop = startTaskDetailRefresh({
        poll: true,
        initialStatus: "pending",
        read: async () => responses[reads++] ?? responses.at(-1)!,
        statusOf: (value) => value.status,
        onValue: (value) => values.push(value),
        onError: () => undefined,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(values).toEqual([{ status: "pending", failure: null }]);

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(values.at(-1)).toEqual({
        status: "paused",
        failure: "personal_provider_unavailable",
      });

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(values.at(-1)).toEqual({ status: "completed", failure: null });
      expect(reads).toBe(3);

      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
      expect(reads).toBe(3);
      stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("cancels the next active refresh on cleanup", async () => {
    jest.useFakeTimers();
    try {
      let reads = 0;
      const stop = startTaskDetailRefresh({
        poll: true,
        initialStatus: "paused",
        read: async () => {
          reads += 1;
          return { status: "paused" };
        },
        statusOf: (value) => value.status,
        onValue: () => undefined,
        onError: () => undefined,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(reads).toBe(1);
      stop();
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(reads).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
