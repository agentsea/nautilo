import { describe, expect, mock, test } from "bun:test";
import {
  createForegroundMemoryEffectRecovery,
  createPostgresForegroundMemoryEffectRecoveryStore,
  installForegroundMemoryEffectRecoveryLifecycle,
  type ForegroundMemoryEffectRecoveryStore,
} from "../../src/routes/foreground-memory-effect-recovery";

function receipt(sequence: number) {
  return Object.freeze({
    sequence,
    operationId: `operation:${sequence}`,
    memoryId: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    changeKind: "replace" as const,
    completion: "complete" as const,
    acknowledgedAt: null,
  });
}

function store(rows: ReturnType<typeof receipt>[]) {
  const acknowledged: number[] = [];
  const value: ForegroundMemoryEffectRecoveryStore = {
    snapshotMaximumSequence: async () => rows.at(-1)?.sequence ?? null,
    nextPending: async (after, maximum) =>
      rows.find((row) => row.sequence > after && row.sequence <= maximum) ?? null,
    acknowledge: async (row) => {
      acknowledged.push(row.sequence);
      rows = rows.filter((candidate) => candidate.sequence !== row.sequence);
      return "acknowledged";
    },
  };
  return {
    value,
    acknowledged,
    add: (row: ReturnType<typeof receipt>) => { rows.push(row); },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Recovery test condition was not reached");
}

function predicateColumnNames(value: unknown): string[] {
  const names = new Set<string>();
  const seen = new Set<object>();
  const visit = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null || seen.has(entry)) return;
    seen.add(entry);
    if ("name" in entry && typeof entry.name === "string" && "table" in entry) {
      names.add(entry.name);
    }
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return [...names].sort();
}

function drizzleFixture(input: Readonly<{
  selects: (readonly unknown[])[];
  updates: (readonly unknown[])[];
}>) {
  const selectedFields: string[][] = [];
  const whereColumns: string[][] = [];
  const updatedFields: string[][] = [];
  const isolationLevels: string[] = [];
  const query = (rows: readonly unknown[]) => {
    const chain = {
      from: () => chain,
      where: (predicate: unknown) => {
        whereColumns.push(predicateColumnNames(predicate));
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: (
        resolve: (value: readonly unknown[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };
  interface FixtureDatabase {
    select(fields: Record<string, unknown>): ReturnType<typeof query>;
    update(): Readonly<{
      set(fields: Record<string, unknown>): unknown;
      where(predicate: unknown): unknown;
      returning(): Promise<readonly unknown[]>;
    }>;
    transaction<Result>(
      callback: (transaction: FixtureDatabase) => Promise<Result>,
      options: { isolationLevel: string },
    ): Promise<Result>;
  }
  const database: FixtureDatabase = {
    select: (fields: Record<string, unknown>) => {
      selectedFields.push(Object.keys(fields));
      return query(input.selects.shift() ?? []);
    },
    update: () => {
      const rows = input.updates.shift() ?? [];
      const chain = {
        set: (fields: Record<string, unknown>) => {
          updatedFields.push(Object.keys(fields));
          return chain;
        },
        where: (predicate: unknown) => {
          whereColumns.push(predicateColumnNames(predicate));
          return chain;
        },
        returning: () => Promise.resolve(rows),
      };
      return chain;
    },
    transaction: async <Result>(
      callback: (transaction: FixtureDatabase) => Promise<Result>,
      options: { isolationLevel: string },
    ): Promise<Result> => {
      isolationLevels.push(options.isolationLevel);
      return callback(database);
    },
  };
  return { database, selectedFields, whereColumns, updatedFields, isolationLevels };
}

describe("foreground Memory effect recovery", () => {
  test("registration does not open a database or require live infrastructure", () => {
    const database = mock(() => { throw new Error("must remain lazy"); });
    createPostgresForegroundMemoryEffectRecoveryStore(database);
    expect(database).not.toHaveBeenCalled();
  });
  test("Postgres store uses exact pending predicates and proves concurrent acknowledgement", async () => {
    const current = receipt(7);
    const fixture = drizzleFixture({
      selects: [
        [{ sequence: 7 }],
        [current],
        [{ acknowledgedAt: new Date("2027-01-15T08:00:00Z") }],
      ],
      updates: [[]],
    });
    const postgres = createPostgresForegroundMemoryEffectRecoveryStore(
      () => fixture.database as never,
    );
    expect(await postgres.snapshotMaximumSequence()).toBe(7);
    expect(await postgres.nextPending(3, 7)).toEqual(current);
    expect(await postgres.acknowledge(current)).toBe("already_acknowledged");
    expect(fixture.selectedFields).toEqual([
      ["sequence"],
      ["sequence", "operationId", "memoryId", "changeKind", "completion", "acknowledgedAt"],
      ["acknowledgedAt"],
    ]);
    for (const column of [
      "completion", "semantic_change_kind", "semantic_change_acknowledged_at",
    ]) {
      expect(fixture.whereColumns[0]).toContain(column);
      expect(fixture.whereColumns[1]).toContain(column);
    }
    for (const column of [
      "sequence", "operation_id", "memory_id", "completion",
      "semantic_change_kind", "semantic_change_acknowledged_at",
    ]) expect(fixture.whereColumns[2]).toContain(column);
    expect(fixture.updatedFields).toEqual([["semanticChangeAcknowledgedAt"]]);
    expect(fixture.isolationLevels).toEqual(["serializable"]);
  });

  test("drains the startup snapshot in sequence without an arbitrary batch cap", async () => {
    const fixture = store([receipt(2), receipt(5), receipt(9)]);
    const delivered: number[] = [];
    const recovery = createForegroundMemoryEffectRecovery({
      store: fixture.value,
      deliver: async ({ receipt: current, acknowledge }) => {
        delivered.push((current as ReturnType<typeof receipt>).sequence);
        await acknowledge({
          operationId: current.operationId,
          memoryId: current.memoryId,
          changeKind: current.changeKind,
        });
        return "acknowledged";
      },
    });
    recovery.start();
    await waitUntil(() => delivered.length === 3);
    await recovery.stop();
    expect(delivered).toEqual([2, 5, 9]);
    expect(fixture.acknowledged).toEqual([2, 5, 9]);
  });

  test("leaves a failed pass pending for a later wake", async () => {
    const fixture = store([receipt(3)]);
    const failures: unknown[] = [];
    let fail = true;
    const delivered: string[] = [];
    const recovery = createForegroundMemoryEffectRecovery({
      store: fixture.value,
      onPassFailure: () => failures.push("failed"),
      deliver: async ({ receipt: current, acknowledge }) => {
        delivered.push(current.operationId);
        if (fail) throw new Error("sink unavailable");
        await acknowledge({
          operationId: current.operationId,
          memoryId: current.memoryId,
          changeKind: current.changeKind,
        });
        return "acknowledged";
      },
    });
    recovery.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(failures).toHaveLength(1);
    fail = false;
    recovery.wake();
    await waitUntil(() => fixture.acknowledged.length === 1);
    await recovery.stop();
    expect(delivered).toEqual(["operation:3", "operation:3"]);
    expect(fixture.acknowledged).toEqual([3]);
  });

  test("continues past one thrown receipt and delivers higher sequences", async () => {
    const fixture = store([receipt(3), receipt(4)]);
    const failures: unknown[] = [];
    const delivered: number[] = [];
    const recovery = createForegroundMemoryEffectRecovery({
      store: fixture.value,
      onPassFailure: () => failures.push("failed"),
      deliver: async ({ receipt: current, acknowledge }) => {
        const sequence = (current as ReturnType<typeof receipt>).sequence;
        delivered.push(sequence);
        if (sequence === 3) throw new Error("receipt 3 unavailable");
        await acknowledge({
          operationId: current.operationId,
          memoryId: current.memoryId,
          changeKind: current.changeKind,
        });
        return "acknowledged";
      },
    });
    recovery.start();
    await waitUntil(() => delivered.length === 2);
    await recovery.stop();
    expect(delivered).toEqual([3, 4]);
    expect(fixture.acknowledged).toEqual([4]);
    expect(failures).toHaveLength(1);
  });

  test("coalesces wakes and excludes receipts arriving after the pass snapshot", async () => {
    const fixture = store([receipt(1)]);
    let snapshots = 0;
    const originalSnapshot = fixture.value.snapshotMaximumSequence;
    fixture.value.snapshotMaximumSequence = async () => {
      snapshots += 1;
      return originalSnapshot();
    };
    const delivered: number[] = [];
    const recovery = createForegroundMemoryEffectRecovery({
      store: fixture.value,
      deliver: async ({ receipt: current, acknowledge }) => {
        delivered.push((current as ReturnType<typeof receipt>).sequence);
        if (delivered.length === 1) fixture.add(receipt(2));
        await acknowledge({
          operationId: current.operationId,
          memoryId: current.memoryId,
          changeKind: current.changeKind,
        });
        return "acknowledged";
      },
    });
    recovery.start();
    recovery.wake();
    recovery.wake();
    await waitUntil(() => delivered.length === 2);
    await recovery.stop();
    expect(delivered).toEqual([1, 2]);
    expect(snapshots).toBe(2);
  });

  test("stop waits for the owned delivery and cancels before the next receipt", async () => {
    const fixture = store([receipt(1), receipt(2)]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const recovery = createForegroundMemoryEffectRecovery({
      store: fixture.value,
      deliver: async ({ receipt: current }) => {
        delivered.push((current as ReturnType<typeof receipt>).sequence);
        await blocked;
        return "pending";
      },
    });
    recovery.start();
    await waitUntil(() => delivered.length === 1);
    const stopping = recovery.stop();
    release();
    await stopping;
    expect(delivered).toEqual([1]);
  });

  test("lifecycle starts asynchronously and close awaits the one owned pass", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const recovery = {
      start: mock(() => undefined),
      wake: mock(() => undefined),
      stop: mock(async () => blocked),
    };
    const hooks = new Map<string, () => unknown>();
    installForegroundMemoryEffectRecoveryLifecycle({
      addHook: (name, hook) => { hooks.set(name, hook); },
    }, recovery);
    expect(hooks.get("onListen")?.()).toBeUndefined();
    expect(recovery.start).toHaveBeenCalledTimes(1);
    const closing = hooks.get("onClose")?.() as Promise<void>;
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });
});
