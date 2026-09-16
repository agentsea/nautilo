/**
 * Stack 198 — least-privilege checkpoint saver: split setup/runtime identities.
 *
 * `setupCheckpointSaver()` runs `PostgresSaver.setup()` + the narrow langchain
 * grant block over a SHORT-LIVED canonical privileged direct pool,
 * closes it, then constructs the long-lived saver on the `nautilo_agent`
 * runtime role. Only the runtime pool is registered for shutdown.
 *
 * These tests mock `pg` and `PostgresSaver` but use the real `@nautilo/db`
 * helpers (`resolveDirectDatabaseConnectionString`,
 * `resolveDirectAgentDatabaseConnectionString`,
 * `buildLangchainCheckpointRoleGrantsSql`, and the pool shutdown registry)
 * so the privileged setup and restricted runtime connection identities are
 * asserted against the canonical resolvers.
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
} from "bun:test";
import type pg from "pg";
import {
  __resetPoolShutdownRegistryForTests,
  __getRegisteredPoolNamesForTests,
  buildLangchainCheckpointRoleGrantsSql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

interface MockPool {
  on: ReturnType<typeof mock>;
  end: ReturnType<typeof mock>;
  query: ReturnType<typeof mock>;
}

interface CreatedPool {
  pool: MockPool;
  config: pg.PoolConfig;
}

const createdPools: CreatedPool[] = [];
let setupCallCount = 0;
let setupShouldFail = false;
let setupError: Error | null = null;

function resetState(): void {
  createdPools.length = 0;
  setupCallCount = 0;
  setupShouldFail = false;
  setupError = null;
}

let checkpointSaverModule: typeof import("../../src/checkpoints/checkpoint-saver");

beforeAll(() => {
  mock.module("pg", () => ({
    default: {
      Pool: mock((config: pg.PoolConfig) => {
        const pool: MockPool = {
          on: mock(() => {}),
          end: mock(async () => {}),
          query: mock(async () => ({ rows: [], rowCount: 0 })),
        };
        createdPools.push({ pool, config });
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
      },
      pool: MockPool,
    ) {
      this.pool = pool;
      this.setup = mock(async () => {
        setupCallCount += 1;
        if (setupShouldFail) throw setupError ?? new Error("setup failed");
      });
      this.put = mock(async (..._args: unknown[]) => "put-result");
      this.putWrites = mock(async (..._args: unknown[]) => undefined);
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
  resetState();
});

afterEach(async () => {
  await checkpointSaverModule.closeCheckpointSaver(0);
});

function setupPool(): CreatedPool | undefined {
  return createdPools[0];
}
function runtimePool(): CreatedPool | undefined {
  return createdPools[1];
}

describe("setupCheckpointSaver — Stack 198 split setup/runtime identities", () => {
  it("uses the canonical privileged direct resolver for setup and the agent direct resolver for runtime", async () => {
    await checkpointSaverModule.setupCheckpointSaver();

    expect(createdPools).toHaveLength(2);

    const setup = setupPool()!;
    const runtime = runtimePool()!;

    const setupUrl = new URL(setup.config.connectionString as string);
    expect(setupUrl.username).toBe("postgres");
    expect(setupUrl.hostname).toBe("localhost");
    expect(setupUrl.searchParams.get("application_name")).toBe("nautilo.checkpoint.setup");
    expect(setupUrl.searchParams.get("sslmode")).toBe("require");

    const runtimeUrl = new URL(runtime.config.connectionString as string);
    expect(runtimeUrl.username).toBe("nautilo_agent");
    expect(runtimeUrl.searchParams.get("application_name")).toBe("nautilo.checkpoint");

    // The app-role URL must never be used for setup, even when present.
    expect(setupUrl.username).not.toBe("nautilo");
    expect(setupUrl.hostname).not.toBe("db.localtest.me");
  });

  it("falls back to the resolved-instance privileged direct connection, never DB_CONNECTION_STRING", async () => {
    const direct = process.env["DB_DIRECT_CONNECTION"];
    delete process.env["DB_DIRECT_CONNECTION"];
    try {
      await checkpointSaverModule.setupCheckpointSaver();

      expect(createdPools).toHaveLength(2);
      const setupUrl = new URL(setupPool()!.config.connectionString as string);
      const runtimeUrl = new URL(runtimePool()!.config.connectionString as string);

      expect(setupUrl.username).toBe("postgres");
      expect(setupUrl.hostname).not.toBe("db.localtest.me");
      expect(setupUrl.searchParams.get("application_name")).toBe(
        "nautilo.checkpoint.setup",
      );
      expect(runtimeUrl.username).toBe("nautilo_agent");
      expect(runtimeUrl.searchParams.get("application_name")).toBe(
        "nautilo.checkpoint",
      );
    } finally {
      if (direct === undefined) delete process.env["DB_DIRECT_CONNECTION"];
      else process.env["DB_DIRECT_CONNECTION"] = direct;
    }
  });

  it("runs PostgresSaver.setup() once over the setup pool, then executes the grant SQL, then closes the setup pool", async () => {
    await checkpointSaverModule.setupCheckpointSaver();

    expect(setupCallCount).toBe(1);
    const setup = setupPool()!;
    // setup() is a mock on the PostgresSaver instance whose pool is the setup pool.
    expect(setup.pool.end).toHaveBeenCalledTimes(1);
    // grant SQL executed over the setup pool (not the runtime pool).
    expect(setup.pool.query).toHaveBeenCalledTimes(1);
    expect(runtimePool()!.pool.query).not.toHaveBeenCalled();
    const grantSql = setup.pool.query.mock.calls[0]![0] as string;
    expect(grantSql).toContain("GRANT USAGE ON SCHEMA langchain TO nautilo_agent");
  });

  it("executes the grant SQL only after setup() succeeds (ordering: setup before grant)", async () => {
    // Happy path: setup() ran (1) and the grant query ran (1) on the setup pool.
    await checkpointSaverModule.setupCheckpointSaver();
    expect(setupCallCount).toBe(1);
    expect(setupPool()!.pool.query).toHaveBeenCalledTimes(1);
    // The failed-setup test below proves the converse: when setup() throws,
    // the grant query never runs — so grant is gated on setup success.
  });

  it("registers only the long-lived runtime pool for shutdown (not the setup pool)", async () => {
    await checkpointSaverModule.setupCheckpointSaver();
    expect(__getRegisteredPoolNamesForTests()).toEqual(["checkpoint:langgraph"]);
  });

  it("does NOT grant checkpoint_migrations or ALTER DEFAULT PRIVILEGES (no broad grants)", async () => {
    await checkpointSaverModule.setupCheckpointSaver();
    const grantSql = setupPool()!.pool.query.mock.calls[0]![0] as string;
    expect(grantSql).not.toContain("checkpoint_migrations");
    expect(grantSql).not.toContain("ALTER DEFAULT PRIVILEGES");
    expect(grantSql).not.toContain("DROP ");
    expect(grantSql).not.toContain("CREATE SCHEMA");
    // Cross-check against the real narrow helper.
    expect(grantSql).toContain(buildLangchainCheckpointRoleGrantsSql());
  });

  it("propagates a failed setup and still closes the setup pool", async () => {
    setupShouldFail = true;
    setupError = new Error("boom: schema creation denied");
    let caught: unknown = null;
    try {
      await checkpointSaverModule.setupCheckpointSaver();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/boom: schema creation denied/);
    expect(setupPool()!.pool.end).toHaveBeenCalledTimes(1);
    // Grant SQL never ran because setup() threw before reaching it.
    expect(setupPool()!.pool.query).not.toHaveBeenCalled();
    // No runtime pool constructed when setup failed.
    expect(createdPools).toHaveLength(1);
    expect(__getRegisteredPoolNamesForTests()).toHaveLength(0);
    // A subsequent call retries from scratch.
    setupShouldFail = false;
    const saver = await checkpointSaverModule.setupCheckpointSaver();
    expect(saver).toBeDefined();
    expect(setupCallCount).toBe(2);
  });

  it("is concurrency-safe: concurrent callers share one setup pass and resolve to the same saver", async () => {
    const [a, b, c] = await Promise.all([
      checkpointSaverModule.setupCheckpointSaver(),
      checkpointSaverModule.setupCheckpointSaver(),
      checkpointSaverModule.setupCheckpointSaver(),
    ]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    // A follow-up call after the concurrent batch returns the same cached saver.
    const d = await checkpointSaverModule.setupCheckpointSaver();
    expect(d).toBe(a);
    expect(setupCallCount).toBe(1);
    expect(createdPools).toHaveLength(2);
    expect(__getRegisteredPoolNamesForTests()).toEqual(["checkpoint:langgraph"]);
  });

  it("is idempotent: a second call after success does not re-run setup", async () => {
    await checkpointSaverModule.setupCheckpointSaver();
    const second = await checkpointSaverModule.setupCheckpointSaver();
    expect(setupCallCount).toBe(1);
    expect(createdPools).toHaveLength(2);
    expect(second).toBeDefined();
  });
});

describe("createCheckpointSaver — long-lived agent-role saver", () => {
  it("returns the cached saver populated by setupCheckpointSaver() without a new pool", async () => {
    const setup = await checkpointSaverModule.setupCheckpointSaver();
    const runtime = checkpointSaverModule.createCheckpointSaver();
    expect(runtime).toBe(setup);
    expect(createdPools).toHaveLength(2);
  });

  it("constructs on demand over the agent-role connection when setup has not run", () => {
    const saver = checkpointSaverModule.createCheckpointSaver();
    expect(saver).toBeDefined();
    expect(createdPools).toHaveLength(1);
    const url = new URL(createdPools[0]!.config.connectionString as string);
    expect(url.username).toBe("nautilo_agent");
    expect(url.searchParams.get("application_name")).toBe("nautilo.checkpoint");
    expect(__getRegisteredPoolNamesForTests()).toEqual(["checkpoint:langgraph"]);
  });

  it("attaches resilience wrappers and a pool error listener on the runtime saver", () => {
    const saver = checkpointSaverModule.createCheckpointSaver() as unknown as {
      put: unknown;
      putWrites: unknown;
      pool: MockPool;
    };
    expect(saver.pool.on).toHaveBeenCalledTimes(1);
    expect(saver.put).toBeTypeOf("function");
    expect(saver.putWrites).toBeTypeOf("function");
  });
});

describe("closeCheckpointSaver — lifecycle", () => {
  it("ends the runtime pool once and allows setup to re-run after close", async () => {
    await checkpointSaverModule.setupCheckpointSaver();
    const runtime = runtimePool()!;
    await checkpointSaverModule.closeCheckpointSaver(100);
    await checkpointSaverModule.closeCheckpointSaver(100);
    expect(runtime.pool.end).toHaveBeenCalledTimes(1);

    // After close, setup can re-provision from scratch.
    const before = createdPools.length;
    await checkpointSaverModule.setupCheckpointSaver();
    expect(setupCallCount).toBe(2);
    expect(createdPools.length - before).toBe(2);
  });
});
