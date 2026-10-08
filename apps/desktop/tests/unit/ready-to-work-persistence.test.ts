import { describe, expect, test } from "bun:test";
import { ReadyToWorkPersistence } from "../../electron/ready-to-work-persistence";
import { ReadyToWorkPersistenceError, type ReadyToWorkInspection, type ReadyToWorkPersistenceStatus } from "../../electron/ready-to-work-store";
import { createReadyToWorkDesiredState, readyToWorkAggregateStatus, withReadyToWorkCodingHarnesses } from "../../electron/ready-to-work-contract";

const desired = createReadyToWorkDesiredState({ humanId: "human-fixture", authority: {
  scope: "https://fixture.example", revision: "revision-fixture", connectionAttemptId: "attempt-fixture", serverFingerprint: "fingerprint-fixture",
} }, { voice: true, auto_approve: true, workstation: true, computer_use: true, coding_connection: false });

function fixture() {
  let intent: ReadyToWorkInspection = { status: "ready", desired };
  let receipt: ReadyToWorkPersistenceStatus = "ready";
  let clearError: Error | null = null;
  const calls: string[] = [];
  const persistence = new ReadyToWorkPersistence({ desired: {
    inspect: () => intent,
    clear: () => {
      calls.push("clear-intent");
      if (clearError) throw clearError;
      if (intent.status !== "ready" && intent.status !== "missing") throw new ReadyToWorkPersistenceError(intent.status);
      intent = { status: "missing" }; return true;
    },
  }, receipt: {
    inspect: () => ({ status: receipt }),
    clear: () => {
      calls.push("clear-proof");
      if (receipt !== "ready" && receipt !== "missing") throw new ReadyToWorkPersistenceError(receipt);
      receipt = "missing"; return true;
    },
  } });
  return { persistence, calls, setIntent: (next: ReadyToWorkInspection) => { intent = next; },
    setReceipt: (next: ReadyToWorkPersistenceStatus) => { receipt = next; },
    failClear: (error: Error | null) => { clearError = error; } };
}

describe("Ready persistence owner composition", () => {
  test("unknown saved selection stays attention, denies enrollment, and fences live owners without deleting proof", async () => {
    const f = fixture(); f.setIntent({ status: "unsupported" });
    expect(f.persistence.attention()).toMatchObject({ mode: "needs_attention", persistence: { reason: "unsupported", liveAccess: "unchanged" } });
    expect(() => f.persistence.assertWritable()).toThrow("PERSISTENCE_UNSUPPORTED");
    let finish!: () => void;
    const cleanup = f.persistence.disable((selection, failed) => {
      expect(selection).toBeNull(); expect(failed).toBe(true); f.calls.push("fence-live");
      return new Promise<void>(resolve => { finish = resolve; });
    });
    expect(f.calls).toEqual(["clear-intent", "fence-live"]);
    expect(f.persistence.attention()).toMatchObject({ mode: "needs_attention", persistence: { reason: "unsupported", liveAccess: "stopping" } });
    finish(); await cleanup;
    expect(f.persistence.attention()?.mode).toBe("needs_attention");
  });

  test("known intent reduces before proof removal and local shutdown", async () => {
    const f = fixture();
    await f.persistence.disable(async (selection, failed) => {
      f.calls.push("fence-live"); expect(selection).toEqual(desired); expect(failed).toBe(false);
    });
    expect(f.calls).toEqual(["clear-intent", "clear-proof", "fence-live"]);
    expect(f.persistence.attention()).toBeNull();
  });

  test("failed disk reduction cannot auto-restore unchanged intent; explicit successful save clears only its latch", async () => {
    const f = fixture(); f.failClear(new Error("fixture write unavailable"));
    await f.persistence.disable(async () => { f.calls.push("fence-live"); });
    expect(f.persistence.attention()).toMatchObject({ mode: "needs_attention", persistence: { reason: "unavailable" } });
    f.failClear(null);
    f.persistence.retryStatus();
    expect(f.persistence.attention()?.mode).toBe("needs_attention");
    expect(f.persistence.mayRestore(true)).toBe(false);
    f.persistence.assertWritable(); // permits a new explicit proof/enrollment
    f.persistence.didSaveDesired();
    expect(f.persistence.attention()).toBeNull();
    f.setIntent({ status: "invalid" });
    f.persistence.didSaveDesired(); // never masks newly unreadable bytes
    expect(f.persistence.attention()?.persistence?.reason).toBe("invalid");
  });

  test("preserved incompatible proof after durable reduction remains visible and cannot become Standard", async () => {
    const f = fixture(); f.setReceipt("unsupported");
    await f.persistence.disable(async () => { f.calls.push("fence-live"); });
    expect(f.calls).toEqual(["clear-intent", "clear-proof", "fence-live"]);
    const status = f.persistence.attention()!;
    expect(status.mode).toBe("needs_attention");
    expect(withReadyToWorkCodingHarnesses(status, [{ id: "codex", state: "ready", reason: null, repairTarget: "coding_connection_settings" }]))
      .toMatchObject({ mode: "needs_attention", codingHarnesses: [] });
    expect(JSON.stringify(status)).not.toContain("human-fixture");
  });

  test("receipt false or typed refusal rolls back newly restored live authority exactly once", async () => {
    for (const save of [() => false, () => { throw new ReadyToWorkPersistenceError("changed"); }]) {
      const f = fixture(); let rollbacks = 0;
      expect(await f.persistence.saveReceiptOrRollback(save, async () => { rollbacks++; })).toBe("failed");
      expect(rollbacks).toBe(1);
      expect(f.persistence.attention()).toMatchObject({ mode: "needs_attention", persistence: { liveAccess: "stopping" } });
    }
    const f = fixture();
    expect(await f.persistence.saveReceiptOrRollback(() => true, async () => { throw new Error("must not rollback"); })).toBe("saved");
    expect(f.persistence.attention()).toBeNull();
  });

  test("a successful retry of Off clears a previous reduction failure", async () => {
    const f = fixture(); f.failClear(new Error("fixture unavailable"));
    await f.persistence.disable(async () => undefined);
    f.failClear(null);
    await f.persistence.disable(async () => undefined);
    expect(f.persistence.attention()).toBeNull();
  });

  test("healthy status retry clears a save warning without restoring rolled-back authority", async () => {
    const f = fixture(); let rollback!: () => void;
    const result = f.persistence.saveReceiptOrRollback(() => false, () => new Promise<void>(resolve => { rollback = resolve; }));
    f.persistence.retryStatus();
    expect(f.persistence.attention()?.mode).toBe("needs_attention");
    expect(f.persistence.mayRestore(true)).toBe(false);
    rollback(); await result;
    f.persistence.retryStatus();
    expect(f.persistence.attention()).toBeNull();
    expect(f.persistence.mayRestore(false)).toBe(false);
    expect(readyToWorkAggregateStatus(desired).components.every(component => component.state !== "ready")).toBe(true);
    expect(f.persistence.mayRestore(true)).toBe(true);
  });
  test("Off during activation prevents a late proof write without replacing the successful Off status", async () => {
    const f = fixture(); let generation = 0; let finishActivation!: () => void;
    const captured = generation; let saves = 0; let rollbacks = 0;
    const activation = new Promise<void>(resolve => { finishActivation = resolve; });
    const restoring = (async () => {
      await activation;
      return f.persistence.saveReceiptOrRollback(() => { saves++; return true; },
        async () => { rollbacks++; }, () => captured === generation);
    })();
    generation++;
    await f.persistence.disable(async () => undefined);
    finishActivation();
    expect(await restoring).toBe("stale");
    expect(saves).toBe(0);
    expect(rollbacks).toBe(1);
    expect(f.persistence.attention()).toBeNull();
  });

});

test("scoped component Off failure stays latched without rewriting Development proof", () => {
  const f = fixture();
  f.persistence.recordReductionFailure(new ReadyToWorkPersistenceError("changed"));
  f.persistence.retryStatus();
  expect(f.persistence.mayRestore(true)).toBe(false);
  expect(f.persistence.attention()).toMatchObject({ persistence: { reason: "changed", liveAccess: "stopping" } });
  expect(f.calls).toEqual([]);
});

test("retrying component Off clears its diagnostic but never clears a Development reduction failure", async () => {
  const f = fixture(); f.persistence.recordReductionFailure(new Error("disk unavailable"));
  f.persistence.didReduceComponents(); expect(f.persistence.attention()).toBeNull();
  f.failClear(new Error("Development Off failed")); await f.persistence.disable(async () => {});
  f.persistence.recordReductionFailure(new Error("component Off failed"));
  f.persistence.didReduceComponents(); expect(f.persistence.attention()).not.toBeNull();
  expect(f.persistence.mayRestore(true)).toBe(false);
});

test("successful component Off retry restores future component enrollment eligibility without clearing prior activation protection", () => {
  const fresh = fixture(); fresh.persistence.recordReductionFailure(new Error("disk failed"));
  expect(fresh.persistence.mayRestore(false)).toBe(false);
  fresh.persistence.didReduceComponents(); expect(fresh.persistence.mayRestore(false)).toBe(true);
  const prior = fixture(); prior.persistence.recordFailure(new Error("Development rollback"), true);
  prior.persistence.recordReductionFailure(new Error("component write")); prior.persistence.didReduceComponents();
  prior.persistence.retryStatus(); expect(prior.persistence.mayRestore(false)).toBe(false);
  const later = fixture(); later.persistence.recordReductionFailure(new Error("component write"));
  later.persistence.recordFailure(new Error("late activation rollback"), true); later.persistence.didReduceComponents();
  later.persistence.retryStatus(); expect(later.persistence.mayRestore(false)).toBe(false);
});
