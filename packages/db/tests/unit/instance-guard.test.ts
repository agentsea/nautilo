import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetResolvedInstanceForTests,
  resolveInstance,
} from "@nautilo/config";
import { resolveDirectDatabaseConnectionString } from "../../src/config/direct-database";
import {
  RECOMMENDED_SCRATCH_INSTANCE,
  TEST_DB_AUTOHEAL_ENV,
  bootstrapTestDbInstance,
} from "../../src/testing/instance-guard";

beforeEach(() => __resetResolvedInstanceForTests());
afterEach(() => __resetResolvedInstanceForTests());

function isolatedHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("bootstrapTestDbInstance — D374 connection override sanitizer", () => {
  test("defaults to scratch and clears stale DB connection overrides", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/tmp/nautilo-d374-test-home",
      DB_DIRECT_CONNECTION: "postgresql://postgres:postgres@localhost:5434/nautilo",
      DB_CONNECTION_STRING: "postgresql://postgres:postgres@localhost:5434/nautilo",
      NAUTILO_DB_PORT: "5434",
    };

    const label = bootstrapTestDbInstance(env);

    expect(label).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    expect(env["NAUTILO_INSTANCE_ID"]).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    expect(env[TEST_DB_AUTOHEAL_ENV]).toBe("1");
    expect(env["DB_DIRECT_CONNECTION"]).toBeUndefined();
    expect(env["DB_CONNECTION_STRING"]).toBeUndefined();
    expect(env["NAUTILO_DB_PORT"]).toBeUndefined();
  });

  test("invalidates a default resolution cached before root-level test bootstrap", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: isolatedHome("nautilo-d374-cached-default-"),
    };

    __resetResolvedInstanceForTests();
    expect(resolveInstance(env).instanceId).toBe("");

    expect(bootstrapTestDbInstance(env)).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    expect(resolveInstance(env).instanceId).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    expect(new URL(resolveDirectDatabaseConnectionString(env)).port).not.toBe("5434");
  });

  test("invalidates a scratch resolution cached with a stale default port override", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: isolatedHome("nautilo-d374-cached-port-"),
      NAUTILO_INSTANCE_ID: RECOMMENDED_SCRATCH_INSTANCE,
      NAUTILO_DB_PORT: "5434",
    };

    __resetResolvedInstanceForTests();
    // This test exercises cache invalidation, not host-port allocation. Avoid
    // making its runtime depend on localhost bind-probe latency under CI load.
    resolveInstance(env, { skipHostBindProbe: true });
    expect(new URL(resolveDirectDatabaseConnectionString(env)).port).toBe("5434");

    bootstrapTestDbInstance(env);
    expect(env["NAUTILO_DB_PORT"]).toBeUndefined();
    expect(new URL(resolveDirectDatabaseConnectionString(env)).port).not.toBe("5434");
  });
});
