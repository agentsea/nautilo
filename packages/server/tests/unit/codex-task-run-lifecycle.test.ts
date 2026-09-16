import { describe, expect, test } from "bun:test";
import {
  CodexTaskRunLifecycleAdapter,
  CodexTaskRunLifecycleRejected,
  CodexUnavailableRequestTerminalizer,
  createCodexTaskRunReportBack,
  type CodexTaskRunLifecycleDeps,
} from "../../src/codex/task-run-lifecycle";
import type { DirectDatabase } from "@nautilo/db";
import type { reportBackTaskCompletion } from "@nautilo/runtime";

const TASK = "task";
const RUN = "run";
const JOB = "job";
const OWNER = "owner";
const facts = { taskId: TASK, taskRunId: RUN, parentTaskId: null, source: "room" as const };

async function rejected(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected Codex task-run lifecycle rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexTaskRunLifecycleRejected);
  }
}

function deps(input: {
  link?: "linked" | "already_linked" | "conflict";
  taskParent?: string | null;
  runJobId?: string | null;
  jobInput?: Record<string, unknown> | null;
} = {}) {
  const calls: string[] = [];
  const completions: unknown[] = [];
  const failures: unknown[] = [];
  const value: CodexTaskRunLifecycleDeps = {
    reader: {
      getTask: async () => ({
        id: TASK,
        ownerId: OWNER,
        parentTaskId: input.taskParent ?? null,
        scheduleKind: "now",
        status: "running",
      }),
      getTaskRun: async () => ({ id: RUN, taskId: TASK, jobId: input.runJobId ?? null, status: "running" }),
      getJob: async () => ({ id: JOB, input: input.jobInput ?? { taskId: TASK, taskRunId: RUN } }),
    },
    writer: {
      linkJob: async () => { calls.push("link"); return input.link ?? "linked"; },
      failUnavailableJob: async () => ({ status: "conflict" }),
    },
    reportBack: {
      complete: async (event) => { calls.push("complete"); completions.push(event); },
      fail: async (event) => { calls.push("fail"); failures.push(event); },
    },
  };
  return { value, calls, completions, failures };
}

describe("CodexTaskRunLifecycleAdapter", () => {
  test("links the persisted Job before work and accepts an exact idempotent repeat", async () => {
    const first = deps();
    await new CodexTaskRunLifecycleAdapter(first.value).linkJob({ ...facts, jobId: JOB });
    expect(first.calls).toEqual(["link"]);

    const repeat = deps({ link: "already_linked", runJobId: JOB });
    await new CodexTaskRunLifecycleAdapter(repeat.value).linkJob({ ...facts, jobId: JOB });
    expect(repeat.calls).toEqual(["link"]);
  });

  test("routes completion through canonical report-back after exact assertion", async () => {
    const harness = deps({ runJobId: JOB });
    await new CodexTaskRunLifecycleAdapter(harness.value).complete({
      ...facts,
      jobId: JOB,
      resultText: "Authoritative answer",
    });
    expect(harness.calls).toEqual(["complete"]);
    expect(harness.completions).toEqual([{
      taskId: TASK,
      taskRunId: RUN,
      scheduleKind: "now",
      resultText: "Authoritative answer",
    }]);
  });

  test("routes the stable error through canonical report-back", async () => {
    for (const code of ["CODEX_EXECUTION_FAILED", "CLAUDE_EXECUTION_FAILED"] as const) {
      const harness = deps({ runJobId: JOB });
      await new CodexTaskRunLifecycleAdapter(harness.value).fail({
        ...facts,
        jobId: JOB,
        code,
      });
      expect(harness.calls).toEqual(["fail"]);
      expect(harness.failures).toEqual([{
        taskId: TASK,
        taskRunId: RUN,
        scheduleKind: "now",
        code,
      }]);
    }
  });

  test("rejects swapped Task, TaskRun, Job, parent, and unknown failure code without a write", async () => {
    const badRun = deps({ runJobId: "other-job" });
    await rejected(new CodexTaskRunLifecycleAdapter(badRun.value).linkJob({ ...facts, jobId: JOB }));
    expect(badRun.calls).toEqual([]);

    const unlinked = deps();
    await rejected(new CodexTaskRunLifecycleAdapter(unlinked.value).complete({
      ...facts,
      jobId: JOB,
      resultText: "answer",
    }));
    expect(unlinked.calls).toEqual([]);

    const badInput = deps({ runJobId: JOB, jobInput: { taskId: TASK, taskRunId: "other-run" } });
    await rejected(new CodexTaskRunLifecycleAdapter(badInput.value).complete({
      ...facts,
      jobId: JOB,
      resultText: "answer",
    }));
    expect(badInput.calls).toEqual([]);

    const badCode = deps({ runJobId: JOB });
    await rejected(new CodexTaskRunLifecycleAdapter(badCode.value).fail({ ...facts, jobId: JOB, code: "raw upstream detail" }));
    expect(badCode.calls).toEqual([]);
  });
});

describe("CodexUnavailableRequestTerminalizer", () => {
  const request = { userId: OWNER, taskId: TASK, taskRunId: RUN, jobId: JOB };

  test("reports the controlled error after the exact Job CAS and retries idempotently", async () => {
    const calls: string[] = [];
    let attempt = 0;
    const terminalizer = new CodexUnavailableRequestTerminalizer(
      {
        linkJob: async () => "conflict",
        failUnavailableJob: async (input) => {
          calls.push(`job:${input.ownerId}:${input.code}`);
          attempt += 1;
          return { status: attempt === 1 ? "failed" : "already_failed", scheduleKind: "now" };
        },
      },
      {
        complete: async () => undefined,
        fail: async (input) => { calls.push(`report:${input.taskId}:${input.code}`); },
      },
      () => new Date("2026-08-01T12:00:00.000Z"),
    );

    await terminalizer.terminalize(request);
    await terminalizer.terminalize(request);

    expect(calls).toEqual([
      `job:${OWNER}:CODEX_REQUEST_UNAVAILABLE`,
      `report:${TASK}:CODEX_REQUEST_UNAVAILABLE`,
      `job:${OWNER}:CODEX_REQUEST_UNAVAILABLE`,
      `report:${TASK}:CODEX_REQUEST_UNAVAILABLE`,
    ]);
  });

  test("suppresses an owner or relation conflict before canonical report-back", async () => {
    let reported = false;
    const terminalizer = new CodexUnavailableRequestTerminalizer(
      {
        linkJob: async () => "conflict",
        failUnavailableJob: async () => ({ status: "conflict" }),
      },
      {
        complete: async () => undefined,
        fail: async () => { reported = true; },
      },
    );

    await terminalizer.terminalize(request);

    expect(reported).toBe(false);
  });
});

describe("createCodexTaskRunReportBack", () => {
  const input = {
    taskId: TASK,
    taskRunId: RUN,
    scheduleKind: "now" as const,
    resultText: "Authoritative answer",
  };

  test("retries one transient completion failure exactly once", async () => {
    let calls = 0;
    const complete = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return true;
    }) as typeof reportBackTaskCompletion;
    const port = createCodexTaskRunReportBack({} as DirectDatabase, { complete });

    await port.complete(input);

    expect(calls).toBe(2);
  });

  test("propagates a persistent second completion failure", async () => {
    let calls = 0;
    const complete = (async () => {
      calls += 1;
      throw new Error(`persistent-${calls}`);
    }) as typeof reportBackTaskCompletion;
    const port = createCodexTaskRunReportBack({} as DirectDatabase, { complete });

    let failure: unknown;
    try {
      await port.complete(input);
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(2);
    expect(failure).toMatchObject({ message: "persistent-2" });
  });
});
