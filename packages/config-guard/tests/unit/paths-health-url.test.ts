import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import { resolveHealthCheckUrl } from "../../src/paths";

describe("resolveHealthCheckUrl", () => {
  let userHomeDir: string;

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-cg-health-"));
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  test("builds /health from resolveInstance().server.url", () => {
    const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: "" } as NodeJS.ProcessEnv;
    expect(resolveHealthCheckUrl(env)).toBe("http://localhost:3001/health");
  });

  test("NAUTILO_SERVER_URL overrides base", () => {
    const env = {
      HOME: userHomeDir,
      NAUTILO_INSTANCE_ID: "",
      NAUTILO_SERVER_URL: "http://127.0.0.1:4000/",
    } as NodeJS.ProcessEnv;
    expect(resolveHealthCheckUrl(env)).toBe("http://127.0.0.1:4000/health");
  });
});
