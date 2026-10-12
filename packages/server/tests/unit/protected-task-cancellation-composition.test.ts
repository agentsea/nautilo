import { expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { createProtectedTaskCancellationComposition } from
  "../../src/routes/protected-task-cancellation-composition";
import type { ProtectedTaskCancellationPlan } from "../../src/routes/protected-task-cancellation-plan";

type Input = Parameters<typeof createProtectedTaskCancellationComposition>[0];
type Dependencies = Required<NonNullable<Parameters<typeof createProtectedTaskCancellationComposition>[1]>>;
const NOW = 1_800_500_000_000;

function fixture() {
  const calls: string[] = [];
  const plan = { initialRecord: { snapshot: { requestId: "cancel:ready" } } } as ProtectedTaskCancellationPlan;
  const input = { db: {}, restricted: {}, crypto: new LatticeCrypto(), owner: {},
    serverScope: "http://localhost", recipients: {}, recipientTtlMs: 60_000, now: () => NOW,
  } as Input;
  const candidates = ["mapped", "denied", "waiting", "ready", "error", "later"].map(id => ({
    taskId: `task:${id}`, taskRunId: id, jobId: null, terminalAt: new Date(NOW - 1),
    bindingState: "cancellation" as const,
    resultState: id === "mapped" ? "mapped" as const : "unmapped" as const,
  }));
  let selected = "";
  const deps: Dependencies = {
    recover: async candidate => {
      if (candidate.taskRunId === "mapped") { calls.push("recover:mapped"); return "mapped"; }
      return "missing";
    },
    settle: async candidate => { calls.push(`settle:${candidate.taskRunId}`); return true; },
    list: async (_db, options) => {
      calls.push(`list:${options.limit}:${options.throughTime.getTime()}`);
      return { candidates, next: { throughTime: options.throughTime,
        terminalAt: new Date(NOW - 1), taskRunId: "last" } };
    },
    preparation: {
      prepare: async candidate => {
        selected = candidate.taskRunId;
        calls.push(`prepare:${selected}`);
        if (selected === "denied") return { status: "not_ready" };
        if (selected === "error") throw new Error("temporary storage failure");
        return { status: "exact_replay", plan };
      },
      resolvePlan: async () => null,
    },
    repository: (async () => ({ get: async () => ({ snapshot: {
      formatVersion: 3, credentialSubject: { kind: "runtime", runtimeKind: "task", runtimeVersion: 1 },
      state: selected === "waiting" ? "awaiting_recipient" : "grant_ready",
    }, workKind: "task.cancel_result", purpose: "task.cancel_result" }) })) as unknown as Dependencies["repository"],
    claim: async operation => {
      expect(operation.restricted).toBe(input.restricted);
      expect(operation.plan).toBe(plan);
      calls.push(`claim:${selected}`);
      return { ...operation.record, snapshot: { ...operation.record.snapshot, state: "completed" } };
    },
  };
  return { input, deps, calls };
}

test("cancellation observer claims only ready fresh work and continues past one failed run", async () => {
  const state = fixture();
  const service = createProtectedTaskCancellationComposition(state.input, state.deps);
  const result = await service.recoverPage({ limit: 6 });
  expect(result).toMatchObject({ attempted: 6, published: 3, pending: 2, failures: 1 });
  expect(state.calls).toEqual([
    `list:6:${NOW}`, "recover:mapped", "prepare:denied", "prepare:waiting", "prepare:ready", "claim:ready",
    "prepare:error", "prepare:later", "claim:later",
  ]);
  expect(result.next?.throughTime.getTime()).toBe(NOW);
});

test("cancellation observer preserves its snapshot and propagates abort without processing rows", async () => {
  const state = fixture();
  const controller = new AbortController();
  controller.abort(new Error("observer stopped"));
  const service = createProtectedTaskCancellationComposition(state.input, state.deps);
  let caught: unknown;
  try {
    await service.recoverPage({ limit: 6, signal: controller.signal,
      after: { throughTime: new Date(NOW - 100), terminalAt: new Date(NOW - 200), taskRunId: "cursor" },
    });
  } catch (error) { caught = error; }
  expect(caught).toBe(controller.signal.reason);
  expect(state.calls).toEqual([`list:6:${NOW - 100}`]);
});


test("existing cancellation reservations never enter fresh preparation", async () => {
  const state = fixture();
  const recover: Dependencies["recover"] = async candidate => {
    state.calls.push(`recover:${candidate.taskRunId}`);
    return candidate.taskRunId === "ready" ? "mapped" : "pending";
  };
  const result = await createProtectedTaskCancellationComposition(state.input, { ...state.deps, recover }).recoverPage({ limit: 6 });
  expect(result).toMatchObject({ published: 1, pending: 5, failures: 0 });
  expect(state.calls.some(call => call.startsWith("prepare:") || call.startsWith("claim:"))).toBe(false);
});

test("mapped cancellation with pruned authority reaches receipt recovery once", async () => {
  const state = fixture();
  const deps = { ...state.deps, list: async () => ({ candidates: [{ taskId: "task:mapped", taskRunId: "mapped", jobId: null,
    terminalAt: new Date(NOW - 1), bindingState: "cancellation" as const, resultState: "mapped" as const }], next: null }) };
  deps.settle = async () => { state.calls.push("settle"); return false; };
  deps.recover = async () => { state.calls.push("recover"); return "mapped"; };
  const result = await createProtectedTaskCancellationComposition(state.input, deps).recoverPage({ limit: 1 });
  expect(result).toMatchObject({ attempted: 1, published: 1, pending: 0, failures: 0 });
  expect(state.calls).toEqual(["recover"]);
});
