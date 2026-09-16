/**
 * M212 PR1 / M210 — behavioral unit tests for runtime pool ownership.
 * No live Postgres; `postgres` is mocked and modules are loaded dynamically.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  __getRegisteredPoolNamesForTests,
  __resetPoolShutdownRegistryForTests,
} from "../../src/config/pool-shutdown-registry";

const FULL_RUNTIME_CONN =
  "postgresql://postgres:postgres@example.invalid:5432/nautilo";
const AGENT_RUNTIME_CONN =
  "postgresql://nautilo_agent:secret@example.invalid:5432/nautilo";
const CRYPTO_RUNTIME_CONN =
  "postgresql://nautilo_crypto:secret@example.invalid:5432/nautilo";
const FULL_DIRECT_CONN =
  "postgresql://postgres:postgres@direct.example.invalid:5432/nautilo";
const AGENT_DIRECT_CONN =
  "postgresql://nautilo_agent:secret@direct.example.invalid:5432/nautilo";

type PostgresCall = {
  connectionString: string;
  options: {
    max?: number;
    debug?: (
      connection: number,
      query: string,
      parameters: unknown[],
      paramTypes: unknown[],
    ) => void;
  };
  instanceId: number;
};

const postgresCalls: PostgresCall[] = [];
const endMocks = new Map<number, ReturnType<typeof mock>>();
let postgresInstanceCounter = 0;

function resetPostgresTracking(): void {
  postgresCalls.length = 0;
  postgresInstanceCounter = 0;
  endMocks.clear();
}

function applicationName(connectionString: string): string | null {
  return new URL(connectionString).searchParams.get("application_name");
}

function baseUrl(connectionString: string): string {
  return connectionString.split("?")[0]!;
}

function createMockPostgresClient(
  connectionString: string,
  options?: PostgresCall["options"],
): {
  end: ReturnType<typeof mock>;
  options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
} {
  const instanceId = ++postgresInstanceCounter;
  const endFn = mock(async (_closeOptions?: { timeout?: number }) => {});
  endMocks.set(instanceId, endFn);
  postgresCalls.push({
    connectionString,
    options: options ?? {},
    instanceId,
  });
  return {
    end: endFn,
    options: { parsers: {}, serializers: {} },
  };
}

mock.module("postgres", () => ({
  default: createMockPostgresClient,
}));

type DatabaseModule = typeof import("../../src/config/database");
type DirectDatabaseModule = typeof import("../../src/config/direct-database");
type AgentDatabaseModule = typeof import("../../src/config/agent-database");
type CryptoDatabaseModule = typeof import("../../src/config/crypto-database");
type RuntimeStatementObserverModule =
  typeof import("../../src/config/runtime-statement-observer");

let databaseMod: DatabaseModule;
let directDbMod: DirectDatabaseModule;
let agentDbMod: AgentDatabaseModule;
let cryptoDbMod: CryptoDatabaseModule;
let observerMod: RuntimeStatementObserverModule;
let savedEnv: {
  DB_CONNECTION_STRING: string | undefined;
  DB_AGENT_CONNECTION_STRING: string | undefined;
  DB_CRYPTO_CONNECTION_STRING: string | undefined;
  DB_DIRECT_CONNECTION: string | undefined;
  DB_AGENT_DIRECT_CONNECTION: string | undefined;
};

beforeAll(async () => {
  databaseMod = await import("../../src/config/database");
  directDbMod = await import("../../src/config/direct-database");
  agentDbMod = await import("../../src/config/agent-database");
  cryptoDbMod = await import("../../src/config/crypto-database");
  observerMod = await import("../../src/config/runtime-statement-observer");
});

beforeEach(() => {
  savedEnv = {
    DB_CONNECTION_STRING: process.env["DB_CONNECTION_STRING"],
    DB_AGENT_CONNECTION_STRING: process.env["DB_AGENT_CONNECTION_STRING"],
    DB_CRYPTO_CONNECTION_STRING: process.env["DB_CRYPTO_CONNECTION_STRING"],
    DB_DIRECT_CONNECTION: process.env["DB_DIRECT_CONNECTION"],
    DB_AGENT_DIRECT_CONNECTION: process.env["DB_AGENT_DIRECT_CONNECTION"],
  };
  process.env["DB_CONNECTION_STRING"] = FULL_RUNTIME_CONN;
  process.env["DB_AGENT_CONNECTION_STRING"] = AGENT_RUNTIME_CONN;
  process.env["DB_CRYPTO_CONNECTION_STRING"] = CRYPTO_RUNTIME_CONN;
  process.env["DB_DIRECT_CONNECTION"] = FULL_DIRECT_CONN;
  process.env["DB_AGENT_DIRECT_CONNECTION"] = AGENT_DIRECT_CONN;
  resetPostgresTracking();
});

afterEach(async () => {
  observerMod.setRuntimeStatementObserver(null);
  await databaseMod.__resetSharedDirectDbForTests();
  await agentDbMod.__resetSharedDirectAgentDbForTests();
  await cryptoDbMod.__resetSharedDirectCryptoDbForTests();
  __resetPoolShutdownRegistryForTests();

  for (const key of [
    "DB_CONNECTION_STRING",
    "DB_AGENT_CONNECTION_STRING",
    "DB_CRYPTO_CONNECTION_STRING",
    "DB_DIRECT_CONNECTION",
    "DB_AGENT_DIRECT_CONNECTION",
  ] as const) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("full-role runtime owner", () => {
  it("createDatabase, db, and getSharedDirectDb share one pool with max 5 and nautilo.direct", () => {
    const fromFactory = databaseMod.createDatabase();
    const fromShared = databaseMod.getSharedDirectDb();
    const fromDirectReexport = directDbMod.getSharedDirectDb();

    expect(fromFactory).toBe(fromShared);
    expect(fromShared).toBe(fromDirectReexport);

    void databaseMod.db.select;
    databaseMod.getSharedDirectDb();
    databaseMod.createDatabase();

    expect(postgresCalls).toHaveLength(1);
    expect(postgresCalls[0]?.options.max).toBe(5);
    expect(applicationName(postgresCalls[0]!.connectionString)).toBe("nautilo.direct");
    expect(baseUrl(postgresCalls[0]!.connectionString)).toBe(baseUrl(FULL_RUNTIME_CONN));
    expect(baseUrl(postgresCalls[0]!.connectionString)).not.toBe(baseUrl(FULL_DIRECT_CONN));
  });

  it("registers the full-role pool once for shutdown", () => {
    databaseMod.createDatabase();
    databaseMod.getSharedDirectDb();
    expect(__getRegisteredPoolNamesForTests()).toEqual(["direct:nautilo"]);
  });
});

describe("agent-role runtime owner", () => {
  it("createAgentDatabase, agentDb, and getSharedDirectAgentDb share one pool with max 5 and nautilo.agent-direct", () => {
    const fromFactory = agentDbMod.createAgentDatabase();
    const fromShared = agentDbMod.getSharedDirectAgentDb();

    expect(fromFactory).toBe(fromShared);

    void agentDbMod.agentDb.select;
    agentDbMod.getSharedDirectAgentDb();
    agentDbMod.createAgentDatabase();

    expect(postgresCalls).toHaveLength(1);
    expect(postgresCalls[0]?.options.max).toBe(5);
    expect(applicationName(postgresCalls[0]!.connectionString)).toBe(
      "nautilo.agent-direct",
    );
    expect(baseUrl(postgresCalls[0]!.connectionString)).toBe(baseUrl(AGENT_RUNTIME_CONN));
    expect(baseUrl(postgresCalls[0]!.connectionString)).not.toBe(
      baseUrl(AGENT_DIRECT_CONN),
    );
  });

  it("registers the agent-role pool once for shutdown", () => {
    agentDbMod.createAgentDatabase();
    agentDbMod.getSharedDirectAgentDb();
    expect(__getRegisteredPoolNamesForTests()).toEqual(["direct:nautilo-agent"]);
  });
});

describe("crypto-role runtime owner", () => {
  it("shares one restricted pool with max 5 and nautilo.crypto-direct", () => {
    const fromFactory = cryptoDbMod.createCryptoDatabase();
    const fromShared = cryptoDbMod.getSharedDirectCryptoDb();
    expect(fromFactory).toBe(fromShared);
    expect(postgresCalls).toHaveLength(1);
    expect(postgresCalls[0]?.options.max).toBe(5);
    expect(applicationName(postgresCalls[0]!.connectionString)).toBe(
      "nautilo.crypto-direct",
    );
    expect(baseUrl(postgresCalls[0]!.connectionString)).toBe(
      baseUrl(CRYPTO_RUNTIME_CONN),
    );
    expect(__getRegisteredPoolNamesForTests()).toEqual([
      "direct:nautilo-crypto",
    ]);
  });
});

describe("full-role and agent-role runtime pools", () => {
  it("use separate handles, connection strings, and shutdown registrations", () => {
    const full = databaseMod.getSharedDirectDb();
    const agent = agentDbMod.getSharedDirectAgentDb();

    expect(full).not.toBe(agent);
    expect(postgresCalls).toHaveLength(2);

    const fullCall = postgresCalls.find(
      (call) => applicationName(call.connectionString) === "nautilo.direct",
    );
    const agentCall = postgresCalls.find(
      (call) => applicationName(call.connectionString) === "nautilo.agent-direct",
    );

    expect(fullCall).toBeDefined();
    expect(agentCall).toBeDefined();
    expect(fullCall!.connectionString).not.toBe(agentCall!.connectionString);

    databaseMod.getSharedDirectDb();
    agentDbMod.getSharedDirectAgentDb();
    expect(postgresCalls).toHaveLength(2);
    expect(__getRegisteredPoolNamesForTests()).toEqual([
      "direct:nautilo",
      "direct:nautilo-agent",
    ]);
  });
});

describe("uncached direct factories", () => {
  it("createDirectDb constructs a new pool on every call using DB_DIRECT_CONNECTION", async () => {
    const first = directDbMod.createDirectDb();
    const second = directDbMod.createDirectDb();

    expect(first).not.toBe(second);
    expect(postgresCalls).toHaveLength(2);
    expect(postgresCalls.every((call) => call.options.max === 5)).toBe(true);
    expect(
      postgresCalls.every((call) => applicationName(call.connectionString) === null),
    ).toBe(true);
    expect(postgresCalls.every((call) => baseUrl(call.connectionString) === baseUrl(FULL_DIRECT_CONN))).toBe(
      true,
    );
    expect(
      postgresCalls.every(
        (call) => baseUrl(call.connectionString) !== baseUrl(FULL_RUNTIME_CONN),
      ),
    ).toBe(true);

    await first.end();
    await second.end();
  });

  it("createDirectAgentDb constructs a new pool on every call using DB_AGENT_DIRECT_CONNECTION", async () => {
    const first = agentDbMod.createDirectAgentDb();
    const second = agentDbMod.createDirectAgentDb();

    expect(first).not.toBe(second);
    expect(postgresCalls).toHaveLength(2);
    expect(postgresCalls.every((call) => call.options.max === 5)).toBe(true);
    expect(
      postgresCalls.every((call) => applicationName(call.connectionString) === null),
    ).toBe(true);
    expect(
      postgresCalls.every((call) => baseUrl(call.connectionString) === baseUrl(AGENT_DIRECT_CONN)),
    ).toBe(true);
    expect(
      postgresCalls.every(
        (call) => baseUrl(call.connectionString) !== baseUrl(AGENT_RUNTIME_CONN),
      ),
    ).toBe(true);

    await first.end();
    await second.end();
  });
});

describe("runtime pool test reset seams", () => {
  it("__resetSharedDirectDbForTests force-closes, unregisters, and allows reconstruction", async () => {
    const first = databaseMod.getSharedDirectDb();
    const firstInstanceId = postgresCalls[0]!.instanceId;

    await databaseMod.__resetSharedDirectDbForTests();

    expect(endMocks.get(firstInstanceId)).toHaveBeenCalledWith({ timeout: 1 });
    expect(__getRegisteredPoolNamesForTests()).toEqual([]);

    const second = databaseMod.getSharedDirectDb();
    expect(second).not.toBe(first);
    expect(postgresCalls).toHaveLength(2);
  });

  it("__resetSharedDirectAgentDbForTests force-closes, unregisters, and allows reconstruction", async () => {
    const first = agentDbMod.getSharedDirectAgentDb();
    const firstInstanceId = postgresCalls[0]!.instanceId;

    await agentDbMod.__resetSharedDirectAgentDbForTests();

    expect(endMocks.get(firstInstanceId)).toHaveBeenCalledWith({ timeout: 1 });
    expect(__getRegisteredPoolNamesForTests()).toEqual([]);

    const second = agentDbMod.getSharedDirectAgentDb();
    expect(second).not.toBe(first);
    expect(postgresCalls).toHaveLength(2);
  });

  it("reset is safe when no runtime pool was constructed", async () => {
    await databaseMod.__resetSharedDirectDbForTests();
    await agentDbMod.__resetSharedDirectAgentDbForTests();
    await cryptoDbMod.__resetSharedDirectCryptoDbForTests();
    expect(postgresCalls).toHaveLength(0);
  });
});

describe("runtime statement observer", () => {
  function invokeDebug(
    call: PostgresCall | undefined,
    query = "SELECT 1",
    parameters: unknown[] = ["secret"],
  ): void {
    expect(call?.options.debug).toBeTypeOf("function");
    call!.options.debug!(0, query, parameters, ["int4"]);
  }

  it("full-role runtime debug invokes observer with role full only", () => {
    const roles: Array<"full" | "agent" | "crypto"> = [];
    observerMod.setRuntimeStatementObserver((role) => {
      roles.push(role);
    });

    databaseMod.createDatabase();
    invokeDebug(postgresCalls[0]);

    expect(roles).toEqual(["full"]);
  });

  it("agent-role runtime debug invokes observer with role agent only", () => {
    const roles: Array<"full" | "agent" | "crypto"> = [];
    observerMod.setRuntimeStatementObserver((role) => {
      roles.push(role);
    });

    agentDbMod.createAgentDatabase();
    invokeDebug(postgresCalls[0]);

    expect(roles).toEqual(["agent"]);
  });

  it("crypto-role runtime debug invokes observer with role crypto only", () => {
    const roles: Array<"full" | "agent" | "crypto"> = [];
    observerMod.setRuntimeStatementObserver((role) => roles.push(role));
    cryptoDbMod.createCryptoDatabase();
    invokeDebug(postgresCalls[0]);
    expect(roles).toEqual(["crypto"]);
  });

  it("uncached direct factories do not register a debug callback", async () => {
    const firstDirect = directDbMod.createDirectDb();
    const secondDirect = agentDbMod.createDirectAgentDb();

    expect(postgresCalls).toHaveLength(2);
    expect(postgresCalls.every((call) => call.options.debug === undefined)).toBe(true);

    await firstDirect.end();
    await secondDirect.end();
  });

  it("stale cleanup does not remove a replacement observer", () => {
    const first = mock((_role: "full" | "agent" | "crypto") => {});
    const second = mock((_role: "full" | "agent" | "crypto") => {});

    const cleanupFirst = observerMod.setRuntimeStatementObserver(first);
    const cleanupSecond = observerMod.setRuntimeStatementObserver(second);
    cleanupFirst();

    databaseMod.createDatabase();
    invokeDebug(postgresCalls[0]);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("full");

    cleanupSecond();
  });
});

describe("compatibility wrappers delegate to shared accessors (static guard)", () => {
  it("server and agent trust paths use shared accessors, not uncached factories", () => {
    const server = readFileSync(
      join(import.meta.dir, "../../../server/src/lib/server-direct-db.ts"),
      "utf8",
    );
    const trust = readFileSync(
      join(import.meta.dir, "../../../agent/src/store/trust-agent-db.ts"),
      "utf8",
    );
    expect(server).toMatch(/getSharedDirectDb\(\)/);
    expect(server).not.toMatch(/createDirectDb/);
    expect(trust).toMatch(/getSharedDirectAgentDb\(\)/);
    expect(trust).toMatch(/_trustAgentDb = getSharedDirectAgentDb\(\)/);
  });
});
