import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT_TEST_SCRATCH_INSTANCE,
  routeRootTestProcessToScratch,
} from "../../../packages/db/tests/test-env-preload";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("repository-root test DB preload", () => {
  test("root and DB-owning packages preload the canonical guard in test scope only", () => {
    expect(readFileSync(resolve(repoRoot, "bunfig.toml"), "utf8")).toBe(
      '[test]\npreload = ["./packages/db/tests/test-env-preload.ts"]\n',
    );

    for (const packageName of ["agent", "db", "runtime", "server", "trust"]) {
      const bunfig = readFileSync(
        resolve(repoRoot, "packages", packageName, "bunfig.toml"),
        "utf8",
      );
      expect(bunfig).toBe('[test]\npreload = ["./tests/test-env-preload.ts"]\n');
    }

    for (const packageName of ["agent", "runtime", "server", "trust"]) {
      const preload = readFileSync(
        resolve(repoRoot, "packages", packageName, "tests/test-env-preload.ts"),
        "utf8",
      );
      expect(preload).toContain('import "../../db/tests/test-env-preload";');
    }
  });

  test("schema-only repository analysis opts into the non-routable Drizzle target", () => {
    const rootPackage = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(rootPackage.scripts?.["lint:unused"]).toBe(
      "NAUTILO_DRIZZLE_OFFLINE=1 knip --cache --no-progress",
    );
  });

  test("routes an unset process to scratch and clears inherited DB overrides", () => {
    const env: NodeJS.ProcessEnv = {
      DB_DIRECT_CONNECTION: "postgresql://localhost:5434/nautilo",
      DB_CONNECTION_STRING: "postgresql://localhost:5434/nautilo",
      DB_AGENT_DIRECT_CONNECTION: "postgresql://nautilo_agent@localhost:5434/nautilo",
      DB_AGENT_CONNECTION_STRING: "postgresql://nautilo_agent@localhost:5434/nautilo",
      NAUTILO_DB_PASSWORD: "protected-default-password",
      NAUTILO_AGENT_DB_PASSWORD: "protected-default-agent-password",
      NAUTILO_DB_PORT: "5434",
    };

    routeRootTestProcessToScratch(env);

    expect(env["NAUTILO_INSTANCE_ID"]).toBe(ROOT_TEST_SCRATCH_INSTANCE);
    expect(env["DB_DIRECT_CONNECTION"]).toBeUndefined();
    expect(env["DB_CONNECTION_STRING"]).toBeUndefined();
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBeUndefined();
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBeUndefined();
    expect(env["NAUTILO_DB_PASSWORD"]).toBeUndefined();
    expect(env["NAUTILO_AGENT_DB_PASSWORD"]).toBeUndefined();
    expect(env["NAUTILO_DB_PORT"]).toBeUndefined();
  });

  test("preserves an explicit named instance and its connection overrides", () => {
    const env: NodeJS.ProcessEnv = {
      NAUTILO_INSTANCE_ID: "qa-source",
      DB_DIRECT_CONNECTION: "postgresql://localhost:7000/nautilo",
      DB_AGENT_DIRECT_CONNECTION: "postgresql://nautilo_agent@localhost:7000/nautilo",
      NAUTILO_DB_PASSWORD: "qa-source-password",
      NAUTILO_AGENT_DB_PASSWORD: "qa-source-agent-password",
    };

    routeRootTestProcessToScratch(env);

    expect(env["NAUTILO_INSTANCE_ID"]).toBe("qa-source");
    expect(env["DB_DIRECT_CONNECTION"]).toBe(
      "postgresql://localhost:7000/nautilo",
    );
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent@localhost:7000/nautilo",
    );
    expect(env["NAUTILO_DB_PASSWORD"]).toBe("qa-source-password");
    expect(env["NAUTILO_AGENT_DB_PASSWORD"]).toBe("qa-source-agent-password");
  });

  test("refuses a named instance carrying the protected-default connection", () => {
    expect(() => routeRootTestProcessToScratch({
      NAUTILO_INSTANCE_ID: "qa-source",
      DB_DIRECT_CONNECTION: "postgresql://localhost:5434/nautilo",
    })).toThrow("named instance qa-source carries a protected-default database override");
  });

  test("refuses an explicit protected default without the opt-in", () => {
    expect(() =>
      routeRootTestProcessToScratch({ NAUTILO_INSTANCE_ID: "default" }),
    ).toThrow("Refusing root-level tests against (default)");
  });

  test("allows an explicitly opted-in protected default", () => {
    const env: NodeJS.ProcessEnv = {
      NAUTILO_INSTANCE_ID: "default",
      ALLOW_DEFAULT_DB_TESTS: "1",
    };
    expect(() => routeRootTestProcessToScratch(env)).not.toThrow();
  });
});
