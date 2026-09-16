import { describe, expect, test } from "bun:test";
import { ACP_EXECUTION_FAILED, HermesAcpTaskRunLifecycleAdapter, HermesAcpTaskRunLifecycleRejected, type HermesAcpLifecycleJob, type HermesAcpLifecycleRun, type HermesAcpLifecycleTask, type HermesAcpTaskRunLifecycleDeps, type HermesAcpTaskRunLifecyclePort } from "../../src/acp/task-run-lifecycle";

const facts = { taskId: "task", taskRunId: "run", parentTaskId: null, source: "room" as const, jobId: "job", authority: { ownerId: "owner", requestorId: "owner", agentId: "agent", roomId: "room" } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function task(overrides: Partial<HermesAcpLifecycleTask> = {}): HermesAcpLifecycleTask { return { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", parentTaskId: null, targetRoomId: "room", scheduleKind: "now", status: "running", ...overrides }; }
function run(overrides: Partial<HermesAcpLifecycleRun> = {}): HermesAcpLifecycleRun { return { id: "run", taskId: "task", jobId: "job", status: "running", ...overrides }; }
function job(overrides: Partial<HermesAcpLifecycleJob> = {}): HermesAcpLifecycleJob { return { id: "job", ownerId: "owner", requestorId: "owner", roomId: "room", status: "running", input: { taskId: "task", taskRunId: "run" }, ...overrides }; }
function build(input: Partial<{ task: HermesAcpLifecycleTask; run: HermesAcpLifecycleRun; job: HermesAcpLifecycleJob; linked: boolean; outcome: "linked" | "already_linked" | "conflict"; afterWrite: (replaceRun: (value: HermesAcpLifecycleRun) => void) => void; readerGate: boolean }> = {}) {
  const calls: string[] = []; const writerInputs: unknown[] = []; const completions: unknown[] = []; const failures: unknown[] = []; const gate = deferred<void>(); let state = { task: input.task ?? task(), run: input.run ?? run({ jobId: input.linked ? "job" : null }), job: input.job ?? job() };
  const read = async <T,>(value: () => T): Promise<T> => { if (input.readerGate) await gate.promise; return value(); };
  const deps: HermesAcpTaskRunLifecycleDeps = { reader: {
    getTask: async () => read(() => state.task), getTaskRun: async () => read(() => state.run), getJob: async () => read(() => state.job),
  }, writer: { linkJob: async (authority) => { writerInputs.push(authority); calls.push("link"); if ((input.outcome ?? "linked") === "linked") state = { ...state, run: { ...state.run, jobId: "job" } }; input.afterWrite?.((value) => { state = { ...state, run: value }; }); return input.outcome ?? "linked"; } }, reportBack: {
    complete: async (value) => { calls.push("complete"); completions.push(value); }, fail: async (value) => { calls.push("fail"); failures.push(value); },
  } };
  return { adapter: new HermesAcpTaskRunLifecycleAdapter(deps), calls, writerInputs, completions, failures, gate, mutate: (update: Partial<typeof state>) => { state = { ...state, ...update }; } };
}
async function rejected(promise: Promise<unknown>) { try { await promise; throw new Error("expected rejection"); } catch (error) { expect(error).toBeInstanceOf(HermesAcpTaskRunLifecycleRejected); } }

describe("HermesAcpTaskRunLifecycleAdapter", () => {
  test("requires authority facts for every Hermes lifecycle port operation", () => {
    const requireLinkAuthority = (_input: Parameters<HermesAcpTaskRunLifecyclePort["linkJob"]>[0]) => undefined;
    const requireCompleteAuthority = (_input: Parameters<HermesAcpTaskRunLifecyclePort["complete"]>[0]) => undefined;
    const requireFailAuthority = (_input: Parameters<HermesAcpTaskRunLifecyclePort["fail"]>[0]) => undefined;
    const requireCurrentAuthority = (_input: Parameters<HermesAcpTaskRunLifecyclePort["assertCurrent"]>[0]) => undefined;
    requireLinkAuthority(facts); requireCompleteAuthority({ ...facts, resultText: "answer" }); requireFailAuthority({ ...facts, code: ACP_EXECUTION_FAILED }); requireCurrentAuthority(facts);
    // @ts-expect-error Hermes lifecycle calls cannot fall back to generic authority-free facts.
    requireLinkAuthority({ taskId: "task", taskRunId: "run", parentTaskId: null, source: "room", jobId: "job" });
    // @ts-expect-error Completion cannot fall back to generic authority-free facts.
    requireCompleteAuthority({ taskId: "task", taskRunId: "run", parentTaskId: null, source: "room", jobId: "job", resultText: "answer" });
    // @ts-expect-error Failure cannot fall back to generic authority-free facts.
    requireFailAuthority({ taskId: "task", taskRunId: "run", parentTaskId: null, source: "room", jobId: "job", code: ACP_EXECUTION_FAILED });
    // @ts-expect-error Currentness cannot fall back to generic authority-free facts.
    requireCurrentAuthority({ taskId: "task", taskRunId: "run", parentTaskId: null, source: "room", jobId: "job" });
    expect(facts.authority).toEqual({ ownerId: "owner", requestorId: "owner", agentId: "agent", roomId: "room" });
  });

  test("links an exact live TaskRun/Job and permits same-job idempotency after a post-write reread", async () => {
    const first = build(); await first.adapter.linkJob(facts); expect(first.calls).toEqual(["link"]); expect(first.writerInputs).toEqual([facts]);
    const repeated = build({ linked: true, outcome: "already_linked" }); await repeated.adapter.linkJob(facts); expect(repeated.calls).toEqual(["link"]);
  });

  test("requires the canonical Job.execute transition from queued to running", async () => {
    const queued = build({ job: job({ status: "queued" }) }); await rejected(queued.adapter.linkJob(facts)); expect(queued.calls).toEqual([]);
    const running = build(); await running.adapter.linkJob(facts); expect(running.calls).toEqual(["link"]);
  });

  test("rejects every Task, Run, Job, authority, status, and input drift before writer or report-back", async () => {
    const fixtures = [
      build({ task: task({ id: "other" }) }), build({ run: run({ id: "other" }) }), build({ job: job({ id: "other" }) }),
      build({ task: task({ ownerId: "other" }) }), build({ task: task({ requestorId: "other" }) }), build({ task: task({ agentId: "other" }) }), build({ task: task({ targetRoomId: "other" }) }), build({ job: job({ ownerId: "other" }) }), build({ job: job({ requestorId: "other" }) }), build({ job: job({ roomId: "other" }) }),
      build({ task: task({ parentTaskId: "other" }) }), build({ task: task({ status: "paused" }) }), build({ run: run({ status: "completed" }) }), build({ job: job({ status: "queued" }) }), build({ job: job({ status: "completed" }) }), build({ job: job({ status: "failed" }) }), build({ job: job({ input: { taskId: "task", taskRunId: "other" } }) }),
    ];
    for (const fixture of fixtures) { await rejected(fixture.adapter.linkJob(facts)); expect(fixture.calls).toEqual([]); }
  });

  test("rejects a conditional-link reread race after its only write", async () => {
    const fixture = build({ afterWrite: (replaceRun) => replaceRun(run({ jobId: "sibling" })) });
    await rejected(fixture.adapter.linkJob(facts)); expect(fixture.calls).toEqual(["link"]);
  });

  test("completion and failure re-read deferred lifecycle state and never report back a stale terminal", async () => {
    for (const operation of ["complete", "fail"] as const) {
      const fixture = build({ linked: true, readerGate: true });
      const pending = operation === "complete" ? fixture.adapter.complete({ ...facts, resultText: "answer" }) : fixture.adapter.fail({ ...facts, code: ACP_EXECUTION_FAILED });
      fixture.mutate({ run: run({ status: "cancelled" }) }); fixture.gate.resolve(); await rejected(pending);
      expect(fixture.calls).toEqual([]);
    }
  });

  test("uses canonical report-back only for an exact linked active relation", async () => {
    const complete = build({ linked: true }); await complete.adapter.complete({ ...facts, resultText: "answer" }); expect(complete.calls).toEqual(["complete"]); expect(complete.completions).toEqual([{ taskId: "task", taskRunId: "run", scheduleKind: "now", resultText: "answer" }]);
    const fail = build({ linked: true }); await fail.adapter.fail({ ...facts, code: ACP_EXECUTION_FAILED }); expect(fail.calls).toEqual(["fail"]); expect(fail.failures).toEqual([{ taskId: "task", taskRunId: "run", scheduleKind: "now", code: ACP_EXECUTION_FAILED }]);
    const invalid = build({ linked: true }); await rejected(invalid.adapter.fail({ ...facts, code: "private detail" })); expect(invalid.calls).toEqual([]);
  });
});
