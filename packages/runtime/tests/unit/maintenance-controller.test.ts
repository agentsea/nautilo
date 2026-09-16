/**
 * D420 — MaintenanceController runtime seam (Wave 2 task 2.1.1).
 *
 * Hermetic unit test: injects fake store ops + a controllable clock so
 * fail-closed propagation, lease/hard duration math, and the
 * complete/cancel alias can be asserted without a live DB. The live-DB
 * behavior of the store ops themselves is covered by the db integration
 * suite.
 */
import { describe, test, expect } from "bun:test";
import {
  MaintenanceController,
  MaintenanceTransitionError,
  DEFAULT_MAINTENANCE_LEASE_MS,
  DEFAULT_MAINTENANCE_HARD_MS,
  type MaintenanceOps,
} from "../../src/maintenance-controller";
import type { DirectDatabase, MaintenanceSnapshot } from "@nautilo/db";

const FAKE_HANDLE = {} as DirectDatabase;

function normalSnapshot(): MaintenanceSnapshot {
  const now = new Date("2026-07-14T12:00:00Z");
  return {
    singletonKey: "upgrade",
    state: "normal",
    operationId: null,
    leaseExpiresAt: null,
    hardExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

interface Recorded {
  enter: Array<{ operationId: string; leaseMs: number; hardMs: number; now: Date }>;
  applying: Array<{ operationId: string; now: Date }>;
  renew: Array<{ operationId: string; leaseMs: number; now: Date }>;
  clear: Array<{ operationId: string; now: Date }>;
  recover: Array<{ now: Date }>;
  getState: number;
}

function makeOps(opts?: {
  enterResult?: MaintenanceSnapshot | ((rec: Recorded["enter"][number]) => MaintenanceSnapshot);
  enterThrows?: MaintenanceTransitionError;
  getStateResult?: MaintenanceSnapshot;
}): { ops: MaintenanceOps; recorded: Recorded } {
  const recorded: Recorded = {
    enter: [],
    applying: [],
    renew: [],
    clear: [],
    recover: [],
    getState: 0,
  };
  const ops: MaintenanceOps = {
    enterDraining: async (_h, operationId, durations, now) => {
      recorded.enter.push({ operationId, ...durations, now: now ?? new Date() });
      if (opts?.enterThrows) throw opts.enterThrows;
      if (opts?.enterResult) {
        return typeof opts.enterResult === "function"
          ? opts.enterResult(recorded.enter[recorded.enter.length - 1]!)
          : opts.enterResult;
      }
      return {
        ...normalSnapshot(),
        state: "draining",
        operationId,
        leaseExpiresAt: new Date((now ?? new Date()).getTime() + durations.leaseMs),
        hardExpiresAt: new Date((now ?? new Date()).getTime() + durations.hardMs),
      };
    },
    transitionApplying: async (_h, operationId, now) => {
      recorded.applying.push({ operationId, now: now ?? new Date() });
      return { ...normalSnapshot(), state: "applying", operationId };
    },
    renewLease: async (_h, operationId, leaseMs, now) => {
      recorded.renew.push({ operationId, leaseMs, now: now ?? new Date() });
      return { ...normalSnapshot(), state: "draining", operationId };
    },
    clearMaintenance: async (_h, operationId, now) => {
      recorded.clear.push({ operationId, now: now ?? new Date() });
      return normalSnapshot();
    },
    recoverExpired: async (_h, now) => {
      recorded.recover.push({ now: now ?? new Date() });
      return { recovered: true, snapshot: normalSnapshot() };
    },
    getState: async () => {
      recorded.getState += 1;
      return opts?.getStateResult ?? normalSnapshot();
    },
  };
  return { ops, recorded };
}

describe("D420 MaintenanceController — defaults + duration math", () => {
  test("uses the default lease/hard durations when no override is given", async () => {
    const { ops, recorded } = makeOps();
    const clock = () => new Date("2026-07-14T12:00:00Z");
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops, now: clock });

    await c.enterDraining({ operationId: "op-1" });
    expect(recorded.enter).toHaveLength(1);
    expect(recorded.enter[0]!.operationId).toBe("op-1");
    expect(recorded.enter[0]!.leaseMs).toBe(DEFAULT_MAINTENANCE_LEASE_MS);
    expect(recorded.enter[0]!.hardMs).toBe(DEFAULT_MAINTENANCE_HARD_MS);
    expect(recorded.enter[0]!.now).toEqual(clock());
  });

  test("per-call lease/hard overrides win over defaults", async () => {
    const { ops, recorded } = makeOps();
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops });
    await c.enterDraining({ operationId: "op-1", leaseMs: 1_000, hardMs: 5_000 });
    expect(recorded.enter[0]!.leaseMs).toBe(1_000);
    expect(recorded.enter[0]!.hardMs).toBe(5_000);
  });

  test("constructor-level defaults override the package defaults", async () => {
    const { ops, recorded } = makeOps();
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops, leaseMs: 7_000, hardMs: 9_000 });
    await c.enterDraining({ operationId: "op-1" });
    expect(recorded.enter[0]!.leaseMs).toBe(7_000);
    expect(recorded.enter[0]!.hardMs).toBe(9_000);
  });

  test("enterDraining generates an operationId when omitted", async () => {
    const { ops, recorded } = makeOps();
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops });
    await c.enterDraining();
    expect(recorded.enter[0]!.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("D420 MaintenanceController — operation routing + clock", () => {
  test("transitionApplying forwards operationId + clock", async () => {
    const { ops, recorded } = makeOps();
    const clock = () => new Date("2026-07-14T12:00:00Z");
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops, now: clock });
    await c.transitionApplying("op-1");
    expect(recorded.applying[0]).toEqual({ operationId: "op-1", now: clock() });
  });

  test("renewLease forwards the per-call lease override (hard ceiling stays default)", async () => {
    const { ops, recorded } = makeOps();
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops });
    await c.renewLease("op-1", { leaseMs: 2_000 });
    expect(recorded.renew[0]!.leaseMs).toBe(2_000);
  });

  test("renewLease falls back to the default leaseMs when no override is given", async () => {
    const { ops, recorded } = makeOps();
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops });
    await c.renewLease("op-1");
    expect(recorded.renew[0]!.leaseMs).toBe(DEFAULT_MAINTENANCE_LEASE_MS);
  });

  test("complete and cancel are aliases (both call clearMaintenance)", async () => {
    const { ops, recorded } = makeOps();
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops });
    await c.complete("op-1");
    await c.cancel("op-2");
    expect(recorded.clear.map((r) => r.operationId)).toEqual(["op-1", "op-2"]);
  });

  test("recoverExpired forwards the clock and returns the recovered flag", async () => {
    const { ops, recorded } = makeOps();
    const clock = () => new Date("2026-07-14T13:00:00Z");
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops, now: clock });
    const res = await c.recoverExpired();
    expect(recorded.recover[0]!.now).toEqual(clock());
    expect(res.recovered).toBe(true);
  });

  test("getState reclaims a hard-expired active lease before returning", async () => {
    const clock = () => new Date("2026-07-14T13:00:00Z");
    const { ops, recorded } = makeOps({
      getStateResult: {
        ...normalSnapshot(),
        state: "applying",
        operationId: "abandoned-op",
        leaseExpiresAt: new Date("2026-07-14T12:30:00Z"),
        hardExpiresAt: new Date("2026-07-14T12:59:00Z"),
      },
    });
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops, now: clock });

    expect((await c.getState()).state).toBe("normal");
    expect(recorded.getState).toBe(1);
    expect(recorded.recover).toEqual([{ now: clock() }]);
  });

  test("getState does not recover an active lease before hard expiry", async () => {
    const { ops, recorded } = makeOps({
      getStateResult: {
        ...normalSnapshot(),
        state: "applying",
        operationId: "live-op",
        hardExpiresAt: new Date("2026-07-14T13:01:00Z"),
      },
    });
    const c = new MaintenanceController({
      db: FAKE_HANDLE,
      ops,
      now: () => new Date("2026-07-14T13:00:00Z"),
    });

    expect((await c.getState()).state).toBe("applying");
    expect(recorded.recover).toHaveLength(0);
  });

  test("isActive reflects the snapshot state", async () => {
    const { ops } = makeOps();
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops });
    expect(await c.isActive()).toBe(false);
  });
});

describe("D420 MaintenanceController — fail-closed propagation", () => {
  test("store-layer MaintenanceTransitionError surfaces unchanged", async () => {
    const { ops } = makeOps({
      enterThrows: new MaintenanceTransitionError("in progress", "in_progress"),
    });
    const c = new MaintenanceController({ db: FAKE_HANDLE, ops });
    let caught: unknown;
    try {
      await c.enterDraining({ operationId: "op-2" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MaintenanceTransitionError);
  });

  test("requires a db handle", () => {
    expect(
      () => new MaintenanceController({ db: undefined as unknown as DirectDatabase }),
    ).toThrow();
  });
});
