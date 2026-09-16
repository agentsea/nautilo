import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import {
  resolveDirectDatabaseConnectionString,
  resolveAppDatabaseConnectionString,
} from "../../src/config/direct-database";
import {
  assertDirectConnectionMatchesInstance,
  resolveExpectedDirectConnectionString,
} from "../../src/utils/db-identity-guard";

function isolatedHomeEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const home = join(tmpdir(), `nautilo-db-test-${randomUUID()}`);
  mkdirSync(join(home, ".nautilo"), { recursive: true });
  return { ...process.env, HOME: home, USERPROFILE: home, ...extra };
}

beforeEach(() => {
  __resetResolvedInstanceForTests();
});

afterEach(() => {
  __resetResolvedInstanceForTests();
});

describe("resolveDirectDatabaseConnectionString", () => {
  test("prefers DB_DIRECT_CONNECTION", () => {
    const env = isolatedHomeEnv({
      DB_DIRECT_CONNECTION: "postgresql://custom/db",
    });
    expect(resolveDirectDatabaseConnectionString(env)).toBe("postgresql://custom/db");
  });

  test("uses resolveInstance().db.directConnection when env unset", () => {
    const env = isolatedHomeEnv({ NAUTILO_DB_PORT: "5555" });
    expect(resolveDirectDatabaseConnectionString(env)).toContain(":5555/");
  });
});

describe("resolveAppDatabaseConnectionString", () => {
  test("prefers DB_CONNECTION_STRING", () => {
    const env = isolatedHomeEnv({
      DB_CONNECTION_STRING: "postgres://x/y",
    });
    expect(resolveAppDatabaseConnectionString(env)).toBe("postgres://x/y");
  });

  test("builds direct localhost URL with nautilo role from resolved postgres host port", () => {
    const env = isolatedHomeEnv({ NAUTILO_DB_PORT: "6000" });
    expect(resolveAppDatabaseConnectionString(env)).toBe(
      "postgres://nautilo:nautilo@localhost:6000/nautilo",
    );
  });

  test("uses NAUTILO_DB_PASSWORD in default localhost URL", () => {
    const env = isolatedHomeEnv({
      NAUTILO_DB_PORT: "6001",
      NAUTILO_DB_PASSWORD: "secret-full",
    });
    expect(resolveAppDatabaseConnectionString(env)).toBe(
      "postgres://nautilo:secret-full@localhost:6001/nautilo",
    );
  });
});

describe("assertDirectConnectionMatchesInstance", () => {
  test("refuses active direct connection that differs from resolved instance", () => {
    const env = isolatedHomeEnv({
      NAUTILO_INSTANCE_ID: "test-cruft",
    });

    expect(() =>
      assertDirectConnectionMatchesInstance(
        "postgresql://postgres:postgres@localhost:5434/nautilo",
        env,
      ),
    ).toThrow(/Refusing DB operation/);
  });

  test("refuses NAUTILO_DB_PORT cache-poisoned direct connection", () => {
    const env = isolatedHomeEnv({
      NAUTILO_INSTANCE_ID: "test-cruft",
      NAUTILO_DB_PORT: "5434",
    });
    const poisoned = resolveDirectDatabaseConnectionString(env);
    expect(poisoned).toContain(":5434/");

    expect(() => assertDirectConnectionMatchesInstance(poisoned, env)).toThrow(
      /Refusing DB operation/,
    );
  });
});

describe("resolveExpectedDirectConnectionString", () => {
  test("does not leave the sanitized env in the resolveInstance cache", () => {
    const env = isolatedHomeEnv({
      NAUTILO_INSTANCE_ID: "test-cruft",
      NAUTILO_DB_PORT: "5991",
    });

    // Guard computes expected from env WITHOUT the port override...
    const expected = resolveExpectedDirectConnectionString(env);
    expect(expected).not.toContain(":5991/");

    // ...but must not poison the process-wide cache: a later resolution
    // with the real env still honors the legitimate override.
    expect(resolveDirectDatabaseConnectionString(env)).toContain(":5991/");
  });
});
