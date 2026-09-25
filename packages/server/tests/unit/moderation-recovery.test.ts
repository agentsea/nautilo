import { describe, expect, mock, test } from "bun:test";
import {
  createModerationEffectRecovery, createPostgresModerationRecoveryStore,
  installModerationEffectRecoveryLifecycle, type ModerationRecoveryCursor,
  type ModerationRecoveryStore,
} from "../../src/lib/moderation-recovery";

const effects = { appendAudit: async () => {} };
const row = (n: number): ModerationRecoveryCursor => ({ createdAt: "2026-01-01 00:00:00.000123+00", operationId: String(n) });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(done: () => boolean) {
  for (let n = 0; n < 50; n++) { if (done()) return; await tick(); }
  throw new Error("Recovery did not reach the test checkpoint");
}
function fixture(rows: ModerationRecoveryCursor[]) {
  const store: ModerationRecoveryStore = {
    snapshotMaximum: async () => rows.at(-1) ?? null,
    nextPending: async (after, max) => rows.find(value =>
      (after === null || value.operationId > after.operationId) && value.operationId <= max.operationId) ?? null,
  };
  return { rows, store };
}

describe("moderation receipt recovery", () => {
  test("constructing the database store stays lazy", () => {
    const database = mock(() => { throw new Error("No infrastructure allowed"); });
    createPostgresModerationRecoveryStore(database);
    expect(database).not.toHaveBeenCalled();
  });

  test("failed and partially delivered receipts cannot starve the rest of the snapshot", async () => {
    const f = fixture([row(1), row(2), row(3)]);
    const delivered: string[] = [];
    const failure = mock(() => {});
    const recovery = createModerationEffectRecovery({ store: f.store, effects, onPassFailure: failure,
      deliver: async id => {
        delivered.push(id);
        if (id === "1") throw new Error("private driver details");
        return { auditRecorded: id !== "2", converged: false };
      },
    });
    recovery.start();
    await until(() => delivered.length === 3);
    await recovery.stop();
    expect(delivered).toEqual(["1", "2", "3"]);
    expect(failure.mock.calls).toEqual([[], []]);
  });

  test("wakes coalesce, stop drains, and a later restart retries the same durable rows", async () => {
    const f = fixture([row(1)]);
    const delivered: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const recovery = createModerationEffectRecovery({ store: f.store, effects,
      deliver: async id => {
        delivered.push(id);
        await blocked;
        return { auditRecorded: true, converged: false };
      },
    });
    recovery.start();
    await until(() => delivered.length === 1);
    recovery.wake(); recovery.wake();
    f.rows.push(row(2));
    let stopped = false;
    const stopping = recovery.stop().then(() => { stopped = true; });
    await tick(); expect(stopped).toBe(false);
    release(); await stopping;
    recovery.wake();
    expect(delivered).toEqual(["1"]);
    const restarted = createModerationEffectRecovery({ store: f.store, effects,
      deliver: async id => { delivered.push(id); return { auditRecorded: true, converged: false }; },
    });
    restarted.start();
    await until(() => delivered.length === 3);
    await restarted.stop();
    expect(delivered).toEqual(["1", "1", "2"]);
  });

  test("snapshot excludes new rows until the coalesced next pass", async () => {
    const f = fixture([row(1)]);
    const snapshots: string[] = [];
    const snapshot = f.store.snapshotMaximum;
    f.store.snapshotMaximum = async () => { const max = await snapshot(); snapshots.push(max!.operationId); return max; };
    const delivered: string[] = [];
    const recovery = createModerationEffectRecovery({ store: f.store, effects,
      deliver: async id => {
        delivered.push(id);
        if (delivered.length === 1) f.rows.push(row(2));
        return { auditRecorded: true, converged: false };
      },
    });
    recovery.start(); recovery.wake(); recovery.wake();
    await until(() => delivered.length === 3);
    await recovery.stop();
    expect(snapshots).toEqual(["1", "2"]);
    expect(delivered).toEqual(["1", "1", "2"]);
  });

  test("a scan outage can recover on a subsequent wake", async () => {
    const f = fixture([row(1)]);
    let failed = true;
    const snapshot = f.store.snapshotMaximum;
    f.store.snapshotMaximum = async () => { if (failed) throw new Error("outage"); return snapshot(); };
    const failure = mock(() => {});
    const deliver = mock(async () => ({ auditRecorded: true, converged: true }));
    const recovery = createModerationEffectRecovery({ store: f.store, effects, deliver, onPassFailure: failure });
    recovery.start(); await until(() => failure.mock.calls.length === 1);
    failed = false; recovery.wake();
    await until(() => deliver.mock.calls.length === 1);
    await recovery.stop();
  });

  test("app lifecycle starts recovery only when listening and waits for shutdown", async () => {
    const recovery = { start: mock(() => {}), wake: mock(() => {}), stop: mock(async () => {}) };
    const hooks = new Map<string, () => unknown>();
    installModerationEffectRecoveryLifecycle({ addHook: (name, hook) => { hooks.set(name, hook); } }, recovery);
    expect(recovery.start).not.toHaveBeenCalled();
    hooks.get("onListen")!(); await hooks.get("onClose")!();
    expect(recovery.start).toHaveBeenCalledTimes(1);
    expect(recovery.stop).toHaveBeenCalledTimes(1);
  });
});
