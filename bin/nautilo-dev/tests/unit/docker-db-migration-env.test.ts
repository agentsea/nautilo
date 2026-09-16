import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import { buildRestoreMigrationEnv } from "../../src/lib/docker-db";

function isolatedHomeEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const home = join(tmpdir(), `nautilo-docker-db-test-${randomUUID()}`);
  mkdirSync(join(home, ".nautilo"), { recursive: true });
  return { ...process.env, HOME: home, USERPROFILE: home, ...extra };
}

beforeEach(() => {
  __resetResolvedInstanceForTests();
});

afterEach(() => {
  __resetResolvedInstanceForTests();
});

describe("buildRestoreMigrationEnv", () => {
  test("uses the selected instance credentials even when ambient credentials belong elsewhere", () => {
    const parent = isolatedHomeEnv({ NAUTILO_INSTANCE_ID: "restore-fixture", NAUTILO_DB_PASSWORD: "wrong-ambient" });
    const root = join(parent["HOME"]!, ".nautilo-restore-fixture");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "instance.env"), "NAUTILO_DB_PASSWORD=selected@secret\nNAUTILO_AGENT_DB_PASSWORD=agent\nLOGTO_DB_PASSWORD=logto\n");
    const env = buildRestoreMigrationEnv(parent);
    expect(new URL(env["DB_DIRECT_CONNECTION"]!).password).toBe("selected%40secret");
    expect(parent["NAUTILO_DB_PASSWORD"]).toBe("wrong-ambient");
    expect(env["DB_CONNECTION_STRING"]).toBe(env["DB_DIRECT_CONNECTION"]);
  });

  test("refuses incomplete selected credentials rather than using an ambient password", () => {
    const parent = isolatedHomeEnv({ NAUTILO_INSTANCE_ID: "restore-fixture", NAUTILO_DB_PASSWORD: "wrong-ambient" });
    const root = join(parent["HOME"]!, ".nautilo-restore-fixture");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "instance.env"), "LOGTO_DB_PASSWORD=logto\n");
    expect(() => buildRestoreMigrationEnv(parent)).toThrow("incomplete instance.env");
  });

  test("sets DB_DIRECT_CONNECTION and DB_CONNECTION_STRING to the admin owner URL", () => {
    const parent = isolatedHomeEnv({
      NAUTILO_DB_PORT: "6123",
      NAUTILO_DB_PASSWORD: "restore-secret",
      DB_DIRECT_CONNECTION: "postgres://nautilo:runtime@db.localtest.me:4445/nautilo",
      DB_CONNECTION_STRING: "postgres://nautilo:runtime@db.localtest.me:4445/nautilo",
      UNRELATED: "keep-me",
    });

    const env = buildRestoreMigrationEnv(parent);
    const expectedAdmin =
      "postgresql://nautilo:restore-secret@localhost:6123/nautilo";

    expect(env["DB_DIRECT_CONNECTION"]).toBe(expectedAdmin);
    expect(env["DB_CONNECTION_STRING"]).toBe(expectedAdmin);
    expect(env["UNRELATED"]).toBe("keep-me");
  });

  test("overrides inherited runtime direct URL during restore", () => {
    const inheritedDirect =
      "postgresql://nautilo:inherited-runtime@db.localtest.me:7652/nautilo";
    const parent = isolatedHomeEnv({
      NAUTILO_DB_PORT: "7652",
      DB_DIRECT_CONNECTION: inheritedDirect,
      DB_CONNECTION_STRING: inheritedDirect,
    });

    const env = buildRestoreMigrationEnv(parent);

    expect(env["DB_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo:nautilo@localhost:7652/nautilo",
    );
    expect(env["DB_DIRECT_CONNECTION"]).not.toBe(inheritedDirect);
    expect(env["DB_CONNECTION_STRING"]).toBe(env["DB_DIRECT_CONNECTION"]);
  });
});
