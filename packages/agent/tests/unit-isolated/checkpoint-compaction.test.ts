/**
 * Stack 208 P1 — shallow checkpoint compaction.
 *
 * `PostgresSaver` is wrapped so each successful `put` triggers best-effort
 * compaction for the just-written `(thread_id, checkpoint_ns)`: retain the
 * latest checkpoint, its pending writes, and referenced blobs; delete older
 * checkpoint rows, writes for deleted checkpoints, and unreferenced blobs.
 *
 * These tests pin the deterministic SQL/params, the best-effort contract
 * (compaction never throws; a failed durable put never triggers compaction),
 * per-thread serialization, and the scope guarantee (never touches another
 * thread or namespace). The pure SQL builder is tested without a database;
 * the integration path uses the same `pg` / `PostgresSaver` mocks as
 * `checkpoint-saver.test.ts` so this file is self-sufficient in its own
 * `bun test` process (run-unit.sh) and compatible when run alongside it
 * (acceptance command).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import {
  __resetCompactionLocksForTests,
  buildCompactionQueries,
  runCompaction,
  serializeCompaction,
} from "../../src/checkpoints/checkpoint-compaction";
import type pg from "pg";
import { __resetPoolShutdownRegistryForTests } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

interface FakeClient {
  query: ReturnType<typeof mock>;
  release: ReturnType<typeof mock>;
}

interface MockPool {
  on: ReturnType<typeof mock>;
  end: ReturnType<typeof mock>;
  query: ReturnType<typeof mock>;
  connect: ReturnType<typeof mock>;
}

interface RecordedCall {
  text: string;
  params: unknown[];
}

let checkpointSaverModule: typeof import("../../src/checkpoints/checkpoint-saver");

interface PutConfig {
  configurable: { thread_id: string; checkpoint_ns?: string; checkpoint_id: string };
}

let currentClient: FakeClient;
let clientQueries: RecordedCall[];
let putShouldThrowNonTransient: boolean;
let putShouldThrowTransient: boolean;
let putErrors: Array<Error | undefined>;
let putReturnConfig: PutConfig | undefined;
let putCallCount: number;
let putWritesErrors: Array<Error | undefined>;
let putWritesCallCount: number;
let deleteThreadCalls: string[];
let deleteThreadShouldThrow: boolean;

beforeAll(() => {
  mock.module("pg", () => ({
    default: {
      Pool: mock((_config: pg.PoolConfig) => {
        const pool: MockPool = {
          on: mock(() => {}),
          end: mock(async () => {}),
          query: mock(async () => ({ rows: [], rowCount: 0 })),
          connect: mock(async () => currentClient),
        };
        return pool;
      }),
    },
  }));

  mock.module("@langchain/langgraph-checkpoint-postgres", () => ({
    PostgresSaver: mock(function PostgresSaver(
      this: {
        pool: MockPool;
        setup: ReturnType<typeof mock>;
        put: ReturnType<typeof mock>;
        putWrites: ReturnType<typeof mock>;
        deleteThread: ReturnType<typeof mock>;
      },
      pool: MockPool,
    ) {
      this.pool = pool;
      this.setup = mock(async () => {});
      this.put = mock(async (..._args: unknown[]) => {
        putCallCount += 1;
        const scriptedError = putErrors.shift();
        if (scriptedError !== undefined) throw scriptedError;
        if (putShouldThrowNonTransient) {
          throw new Error("non-transient boom");
        }
        if (putShouldThrowTransient) {
          const err = new Error("Connection terminated unexpectedly");
          throw err;
        }
        return putReturnConfig;
      });
      this.putWrites = mock(async (..._args: unknown[]) => {
        putWritesCallCount += 1;
        const scriptedError = putWritesErrors.shift();
        if (scriptedError !== undefined) throw scriptedError;
      });
      this.deleteThread = mock(async (threadId: string) => {
        deleteThreadCalls.push(threadId);
        if (deleteThreadShouldThrow) {
          throw new Error("simulated deleteThread failure");
        }
      });
      return this;
    }),
  }));
});

beforeAll(async () => {
  bootstrapTestDbInstance();
  process.env["DB_DIRECT_CONNECTION"] =
    "postgresql://postgres:postgres@localhost:55432/nautilo?sslmode=require";
  process.env["DB_CONNECTION_STRING"] =
    "postgresql://nautilo:app-pw@db.localtest.me:5432/nautilo";
  process.env["DB_AGENT_DIRECT_CONNECTION"] =
    "postgresql://nautilo_agent:agent-pw@localhost:55432/nautilo";
  checkpointSaverModule = await import("../../src/checkpoints/checkpoint-saver");
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  __resetPoolShutdownRegistryForTests();
  __resetCompactionLocksForTests();
  clientQueries = [];
  currentClient = {
    query: mock(async (text: string, params?: unknown[]) => {
      clientQueries.push({ text, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }),
    release: mock(() => {}),
  };
  putShouldThrowNonTransient = false;
  putShouldThrowTransient = false;
  putErrors = [];
  putReturnConfig = undefined;
  putCallCount = 0;
  putWritesErrors = [];
  putWritesCallCount = 0;
  deleteThreadCalls = [];
  deleteThreadShouldThrow = false;
});

afterEach(async () => {
  await checkpointSaverModule.closeCheckpointSaver(0);
});

function makeClientThatFailsOn(failOn: RegExp): FakeClient {
  return {
    query: mock(async (text: string, params?: unknown[]) => {
      clientQueries.push({ text, params: params ?? [] });
      if (failOn.test(text)) {
        throw new Error("simulated compaction failure");
      }
      return { rows: [], rowCount: 0 };
    }),
    release: mock(() => {}),
  };
}

async function withImmediateRetryTimers<Value>(
  run: () => Promise<Value>,
): Promise<Value> {
  const timer = spyOn(globalThis, "setTimeout").mockImplementation((
    (callback: (...args: unknown[]) => void) => {
      callback();
      return callback as unknown as ReturnType<typeof setTimeout>;
    }
  ) as typeof setTimeout);
  try {
    return await run();
  } finally {
    timer.mockRestore();
  }
}

describe("buildCompactionQueries — pure SQL/params", () => {
  it("emits exactly three statements in deletion order: checkpoints, writes, blobs", () => {
    const stmts = buildCompactionQueries("t1", "", "cp-latest");
    expect(stmts).toHaveLength(3);
    expect(stmts[0]!.sql).toContain("DELETE FROM langchain.checkpoints");
    expect(stmts[1]!.sql).toContain("DELETE FROM langchain.checkpoint_writes");
    expect(stmts[2]!.sql).toContain("DELETE FROM langchain.checkpoint_blobs");
  });

  it("is fully schema-qualified to langchain (no unqualified table refs)", () => {
    const stmts = buildCompactionQueries("t1", "ns1", "cp-latest");
    for (const s of stmts) {
      // Every checkpoint-table reference is langchain-prefixed.
      expect(s.sql).not.toMatch(/\bcheckpoint_id\b(?!\b)/);
      // No bare "checkpoints" / "checkpoint_blobs" / "checkpoint_writes" without langchain.
      expect(s.sql).not.toMatch(/(?<!langchain\.)\bcheckpoints\b/);
      expect(s.sql).not.toMatch(/(?<!langchain\.)\bcheckpoint_blobs\b/);
      expect(s.sql).not.toMatch(/(?<!langchain\.)\bcheckpoint_writes\b/);
    }
  });

  it("parameterizes all values (no interpolated ids/threads in the SQL text)", () => {
    const stmts = buildCompactionQueries(
      "thread-secret",
      "ns-secret",
      "cp-secret",
    );
    for (const s of stmts) {
      expect(s.sql).not.toContain("thread-secret");
      expect(s.sql).not.toContain("ns-secret");
      expect(s.sql).not.toContain("cp-secret");
    }
    expect(stmts[0]!.params).toEqual(["thread-secret", "ns-secret", "cp-secret"]);
    expect(stmts[1]!.params).toEqual(["thread-secret", "ns-secret", "cp-secret"]);
    expect(stmts[2]!.params).toEqual(["thread-secret", "ns-secret"]);
  });

  it("scopes every delete to thread_id AND checkpoint_ns (never crosses threads/namespaces)", () => {
    const stmts = buildCompactionQueries("t1", "ns1", "cp-latest");
    for (const s of stmts) {
      expect(s.sql).toContain("thread_id = $1");
      expect(s.sql).toContain("checkpoint_ns = $2");
    }
  });

  it("retains the just-put checkpoint: deletes strictly older rows (< $3), never <= or <>", () => {
    const [cp, writes] = buildCompactionQueries("t1", "", "cp-latest");
    expect(cp!.sql).toContain("checkpoint_id < $3");
    expect(writes!.sql).toContain("checkpoint_id < $3");
    // The retained row (checkpoint_id = $3) is never matched by `< $3`.
  });

  it("blob delete keeps only blobs referenced by a surviving checkpoint via channel_versions", () => {
    const [, , blobs] = buildCompactionQueries("t1", "", "cp-latest");
    expect(blobs!.sql).toContain("NOT EXISTS");
    expect(blobs!.sql).toContain("channel_versions");
    expect(blobs!.sql).toContain("bl.channel");
    expect(blobs!.sql).toContain("bl.version");
  });
});

describe("runCompaction — best-effort transaction", () => {
  it("runs BEGIN, the three deletes, COMMIT in order with correct params", async () => {
    await runCompaction(currentClient, "t1", "ns1", "cp-latest");

    expect(clientQueries.map((c) => c.text)).toEqual([
      "BEGIN",
      expect.stringContaining("DELETE FROM langchain.checkpoints") as unknown as string,
      expect.stringContaining("DELETE FROM langchain.checkpoint_writes") as unknown as string,
      expect.stringContaining("DELETE FROM langchain.checkpoint_blobs") as unknown as string,
      "COMMIT",
    ]);
    expect(clientQueries[1]!.params).toEqual(["t1", "ns1", "cp-latest"]);
    expect(clientQueries[2]!.params).toEqual(["t1", "ns1", "cp-latest"]);
    expect(clientQueries[3]!.params).toEqual(["t1", "ns1"]);
    expect(currentClient.release).not.toHaveBeenCalled();
  });

  it("rolls back and swallows a mid-transaction error (never throws)", async () => {
    currentClient = makeClientThatFailsOn(/DELETE FROM langchain\.checkpoint_writes/);
    await runCompaction(currentClient, "t1", "", "cp-latest");
    const texts = clientQueries.map((c) => c.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts).toContain("ROLLBACK");
    expect(texts.some((t) => t === "COMMIT")).toBe(false);
  });

  it("never deletes another thread or namespace: params always carry the given thread/ns", async () => {
    await runCompaction(currentClient, "thread-A", "ns-A", "cp-A");
    for (const call of clientQueries) {
      if (call.text.startsWith("DELETE")) {
        // Every delete is parameterized with the same thread/ns we passed.
        expect(call.params[0]).toBe("thread-A");
        expect(call.params[1]).toBe("ns-A");
      }
    }
  });
});

describe("serializeCompaction — per-thread serialization", () => {
  it("serializes runs with the same key (no overlap)", async () => {
    let active = 0;
    let maxActive = 0;
    const run = () =>
      new Promise<void>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active -= 1;
          resolve();
        }, 5);
      });
    await Promise.all([
      serializeCompaction("k", run),
      serializeCompaction("k", run),
      serializeCompaction("k", run),
    ]);
    expect(maxActive).toBe(1);
  });

  it("runs different keys concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const run = () =>
      new Promise<void>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active -= 1;
          resolve();
        }, 5);
      });
    await Promise.all([
      serializeCompaction("k1", run),
      serializeCompaction("k2", run),
    ]);
    expect(maxActive).toBe(2);
  });

  it("a rejected predecessor does not block the next run", async () => {
    let observed = false;
    const failing = () => Promise.reject(new Error("boom"));
    const next = () => {
      observed = true;
      return Promise.resolve();
    };
    // serializeCompaction guards the chain so a rejected run still lets the
    // next one execute.
    await serializeCompaction("k", failing).catch(() => {});
    await serializeCompaction("k", next);
    expect(observed).toBe(true);
  });
});

describe("triggerCompaction via wrapped put — integration", () => {
  it("fires compaction after a successful put with the just-put checkpoint id", async () => {
    putReturnConfig = {
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-latest" },
    };
    const saver = checkpointSaverModule.createCheckpointSaver();
    const returned = await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-parent" } },
      // The real signature passes a checkpoint/metadata/versions; the mock put
      // ignores them.
      { v: 4, id: "cp-latest", ts: "", channel_values: {}, channel_versions: {}, versions_seen: {} } as never,
      {} as never,
      {} as never,
    );
    expect((returned as PutConfig).configurable.checkpoint_id).toBe("cp-latest");
    // Compaction is fire-and-forget; let it drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(putCallCount).toBe(1);
    expect(currentClient.query.mock.calls.length).toBeGreaterThanOrEqual(5);
    const texts = clientQueries.map((c) => c.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]).toContain("DELETE FROM langchain.checkpoints");
    expect(clientQueries[1]!.params).toEqual(["t1", "", "cp-latest"]);
    expect(clientQueries[2]!.params).toEqual(["t1", "", "cp-latest"]);
    expect(clientQueries[3]!.params).toEqual(["t1", ""]);
    expect(texts).toContain("COMMIT");
    expect(currentClient.release).toHaveBeenCalled();
  });

  it("does NOT fire compaction when put fails with a non-transient error (rethrown)", async () => {
    putShouldThrowNonTransient = true;
    const saver = checkpointSaverModule.createCheckpointSaver();
    let caught: unknown;
    try {
      await saver.put(
        { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-parent" } },
        {} as never,
        {} as never,
        {} as never,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/non-transient boom/);
    await new Promise((r) => setTimeout(r, 10));
    expect(clientQueries).toHaveLength(0);
    expect(currentClient.release).not.toHaveBeenCalled();
  });

  it("propagates the final transient put failure without returning a false checkpoint config or compacting", async () => {
    const finalError = new Error("ETIMEDOUT on final put attempt");
    putErrors = [
      new Error("Connection terminated unexpectedly"),
      new Error("ECONNRESET on retry 1"),
      finalError,
    ];
    const inputConfig = {
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-parent" },
    };
    const saver = checkpointSaverModule.createCheckpointSaver();
    const operation = withImmediateRetryTimers(() =>
      saver.put(inputConfig, {} as never, {} as never, {} as never)
    );
    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(finalError);
    await new Promise((r) => setTimeout(r, 10));
    expect(clientQueries).toHaveLength(0);
    expect(currentClient.release).not.toHaveBeenCalled();
    expect(putCallCount).toBe(3);
  });

  it("preserves transient put recovery and compacts only the durable result", async () => {
    putErrors = [
      new Error("Connection terminated unexpectedly"),
      new Error("ECONNRESET on retry 1"),
    ];
    putReturnConfig = {
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-latest" },
    };
    const saver = checkpointSaverModule.createCheckpointSaver();
    const returned = await withImmediateRetryTimers(() => saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-parent" } },
      {} as never,
      {} as never,
      {} as never,
    ));
    expect((returned as PutConfig).configurable.checkpoint_id).toBe("cp-latest");
    await new Promise((r) => setTimeout(r, 10));
    expect(putCallCount).toBe(3);
    expect(clientQueries.filter(({ text }) => text === "BEGIN")).toHaveLength(1);
    expect(clientQueries[1]!.params).toEqual(["t1", "", "cp-latest"]);
  });

  it("propagates the final transient putWrites failure after the existing retries", async () => {
    const finalError = new Error("ETIMEDOUT on final putWrites attempt");
    putWritesErrors = [
      new Error("Connection terminated unexpectedly"),
      new Error("ECONNRESET on retry 1"),
      finalError,
    ];
    const saver = checkpointSaverModule.createCheckpointSaver();
    const operation = withImmediateRetryTimers(() => saver.putWrites(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-latest" } },
      [["messages", { value: "pending" }]] as never,
      "task-1",
    ));
    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(finalError);
    expect(putWritesCallCount).toBe(3);
    expect(clientQueries).toHaveLength(0);
  });

  it("preserves transient putWrites recovery on the final retry", async () => {
    putWritesErrors = [
      new Error("Connection terminated unexpectedly"),
      new Error("ECONNRESET on retry 1"),
    ];
    const saver = checkpointSaverModule.createCheckpointSaver();
    await withImmediateRetryTimers(() => saver.putWrites(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-latest" } },
      [["messages", { value: "pending" }]] as never,
      "task-1",
    ));
    expect(putWritesCallCount).toBe(3);
    expect(clientQueries).toHaveLength(0);
  });

  it("swallows a compaction pool-connect failure (never turns a successful put into a failure)", async () => {
    putReturnConfig = {
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-latest" },
    };
    const saver = checkpointSaverModule.createCheckpointSaver();
    // Force pool.connect to throw.
    const pool = (saver as unknown as { pool: MockPool }).pool;
    pool.connect = mock(async () => {
      throw new Error("pool exhausted");
    });
    const returned = await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-parent" } },
      {} as never,
      {} as never,
      {} as never,
    );
    expect(returned).toBeDefined();
    await new Promise((r) => setTimeout(r, 10));
    // No client was checked out, so no compaction queries ran — but put still
    // succeeded and returned the durable config.
    expect(clientQueries).toHaveLength(0);
  });

  it("serializes compaction per thread/namespace across two successful puts", async () => {
    putReturnConfig = {
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-latest" },
    };
    const saver = checkpointSaverModule.createCheckpointSaver();
    await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-a" } },
      {} as never, {} as never, {} as never,
    );
    await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-b" } },
      {} as never, {} as never, {} as never,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Two compactions ran (two BEGIN..COMMIT cycles), each best-effort.
    const begins = clientQueries.filter((c) => c.text === "BEGIN").length;
    const commits = clientQueries.filter((c) => c.text === "COMMIT").length;
    expect(begins).toBe(2);
    expect(commits).toBe(2);
  });
});

describe("isEphemeralCheckpointThread — guard predicate", () => {
  it("accepts a fork checkpoint thread (`<parent>:fork:<turnId>:<suffix>`)", () => {
    expect(
      checkpointSaverModule.isEphemeralCheckpointThread(
        "room:r1:bot:a1:fork:turn-xyz:ab12",
      ),
    ).toBe(true);
  });

  it("accepts a task / subagent checkpoint thread (`subagent:…`)", () => {
    expect(
      checkpointSaverModule.isEphemeralCheckpointThread("subagent:room:r1:bot:a1:abc"),
    ).toBe(true);
  });

  it("rejects a canonical foreground room thread (`room:<roomId>:bot:<agentId>`)", () => {
    expect(
      checkpointSaverModule.isEphemeralCheckpointThread("room:r1:bot:a1"),
    ).toBe(false);
  });

  it("rejects empty / non-string / unknown shapes", () => {
    expect(checkpointSaverModule.isEphemeralCheckpointThread("")).toBe(false);
    expect(
      checkpointSaverModule.isEphemeralCheckpointThread(undefined as unknown as string),
    ).toBe(false);
    expect(checkpointSaverModule.isEphemeralCheckpointThread("task:t1")).toBe(false);
    expect(checkpointSaverModule.isEphemeralCheckpointThread("room:r1")).toBe(false);
  });
});

describe("deleteEphemeralCheckpointThread — best-effort terminal cleanup", () => {
  it("delegates to saver.deleteThread for an ephemeral fork thread", async () => {
    const saver = checkpointSaverModule.createCheckpointSaver();
    await checkpointSaverModule.deleteEphemeralCheckpointThread(
      saver,
      "room:r1:bot:a1:fork:t1:ab12",
    );
    expect(deleteThreadCalls).toEqual(["room:r1:bot:a1:fork:t1:ab12"]);
  });

  it("delegates to saver.deleteThread for an ephemeral subagent thread", async () => {
    const saver = checkpointSaverModule.createCheckpointSaver();
    await checkpointSaverModule.deleteEphemeralCheckpointThread(
      saver,
      "subagent:room:r1:bot:a1:xyz",
    );
    expect(deleteThreadCalls).toEqual(["subagent:room:r1:bot:a1:xyz"]);
  });

  it("refuses to touch a canonical foreground room thread (never calls deleteThread)", async () => {
    const saver = checkpointSaverModule.createCheckpointSaver();
    await checkpointSaverModule.deleteEphemeralCheckpointThread(saver, "room:r1:bot:a1");
    expect(deleteThreadCalls).toHaveLength(0);
  });

  it("refuses empty / unknown shapes (never calls deleteThread)", async () => {
    const saver = checkpointSaverModule.createCheckpointSaver();
    await checkpointSaverModule.deleteEphemeralCheckpointThread(saver, "");
    await checkpointSaverModule.deleteEphemeralCheckpointThread(saver, "task:t1");
    expect(deleteThreadCalls).toHaveLength(0);
  });

  it("swallows a deleteThread failure (never throws)", async () => {
    deleteThreadShouldThrow = true;
    const saver = checkpointSaverModule.createCheckpointSaver();
    // Must not reject — cleanup is best-effort.
    let threw = false;
    try {
      await checkpointSaverModule.deleteEphemeralCheckpointThread(
        saver,
        "subagent:room:r1:bot:a1:abc",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(deleteThreadCalls).toEqual(["subagent:room:r1:bot:a1:abc"]);
  });
});
