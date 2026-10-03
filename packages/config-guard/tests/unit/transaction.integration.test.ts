import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAllKeyDefinitions } from "../../src/key-registry";
import { LOGTO_REQUIRED_KEYS } from "../../src/mode-registry";
import { resetConfigGuardRateLimitForTests, transaction } from "../../src/transaction";

const originalFetch = globalThis.fetch;

function clearRegistryEnvVars(): void {
  for (const def of getAllKeyDefinitions()) {
    delete process.env[def.envVar];
  }
}

/** M072 — cross-key invariant requires every LOGTO_* registry key in merged env. */
function seedDummyLogtoEnv(): void {
  for (const k of LOGTO_REQUIRED_KEYS) {
    if (k === "LOGTO_M2M_APP_SECRET") {
      process.env[k] = "test-m2m-secret-placeholder";
    } else {
      process.env[k] = "http://127.0.0.1:9/placeholder";
    }
  }
}

describe("transaction integration", () => {
  let home: string;
  let envPath: string;
  const prevUserHome = process.env["HOME"];
  const prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
  const prevServerUrl = process.env["NAUTILO_SERVER_URL"];
  const prevInstanceId = process.env["NAUTILO_INSTANCE_ID"];

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    clearRegistryEnvVars();
    seedDummyLogtoEnv();
    home = await mkdtemp(join(tmpdir(), "cg-tx-"));
    envPath = join(home, "project.env");
    await writeFile(envPath, "", "utf-8");
    process.env["HOME"] = home;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
    process.env["NAUTILO_SERVER_URL"] = "http://127.0.0.1:9";
    resetConfigGuardRateLimitForTests();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (prevUserHome !== undefined) {
      process.env["HOME"] = prevUserHome;
    } else {
      delete process.env["HOME"];
    }
    if (prevDotenv !== undefined) {
      process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    } else {
      delete process.env["NAUTILO_DOTENV_PATH"];
    }
    if (prevServerUrl !== undefined) {
      process.env["NAUTILO_SERVER_URL"] = prevServerUrl;
    } else {
      delete process.env["NAUTILO_SERVER_URL"];
    }
    if (prevInstanceId !== undefined) {
      process.env["NAUTILO_INSTANCE_ID"] = prevInstanceId;
    } else {
      delete process.env["NAUTILO_INSTANCE_ID"];
    }
    await rm(home, { recursive: true, force: true });
    clearRegistryEnvVars();
    resetConfigGuardRateLimitForTests();
  });

  test("rejects unknown env var", async () => {
    const r = await transaction({
      operations: [{ type: "set", key: "PATH", value: "x" }],
      healthCheck: "none",
      reason: "t",
      actor: "test",
    });
    expect(r.success).toBe(false);
    expect(r.rolledBack).toBe(false);
    expect(r.error).toContain("Unknown");
  });

  test("applies valid key with healthCheck none", async () => {
    if (process.platform !== "win32") {
      await chmod(envPath, 0o644);
    }
    const r = await transaction({
      operations: [{ type: "set", key: "TAVILY_API_KEY", value: "tvly-12345678901" }],
      healthCheck: "none",
      reason: "t",
      actor: "test",
    });
    expect(r.success).toBe(true);
    expect(r.applied).toBe(1);
    const body = await readFile(envPath, "utf-8");
    expect(body).toContain("TAVILY_API_KEY");
    expect(body).toContain("tvly-");
    if (process.platform !== "win32") {
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("empty operations returns success with no snapshot", async () => {
    const r = await transaction({
      operations: [],
      healthCheck: "none",
      reason: "t",
      actor: "test",
    });
    expect(r.success).toBe(true);
    expect(r.snapshot).toBeNull();
    expect(r.applied).toBe(0);
  });

  test("rolls back .env when server health check fails", async () => {
    await writeFile(envPath, "KEEP=1\n", "utf-8");
    clearRegistryEnvVars();
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r = await transaction({
      operations: [{ type: "set", key: "TAVILY_API_KEY", value: "tvly-12345678901" }],
      healthCheck: "server",
      reason: "t",
      actor: "test",
    });
    expect(r.success).toBe(false);
    expect(r.rolledBack).toBe(true);
    const body = await readFile(envPath, "utf-8");
    expect(body).toBe("KEEP=1\n");
  });

  test("concurrent transactions are serialized and both succeed", async () => {
    const [a, b] = await Promise.all([
      transaction({
        operations: [],
        healthCheck: "none",
        reason: "a",
        actor: "test",
      }),
      transaction({
        operations: [],
        healthCheck: "none",
        reason: "b",
        actor: "test",
      }),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });

  test("validation failures do not consume rate limit slots", async () => {
    resetConfigGuardRateLimitForTests();
    for (let i = 0; i < 15; i++) {
      const r = await transaction({
        operations: [{ type: "set", key: "NOT_A_REGISTRY_KEY", value: "x" }],
        healthCheck: "none",
        reason: `bad${i}`,
        actor: "test",
      });
      expect(r.success).toBe(false);
    }
    const ok = await transaction({
      operations: [{ type: "set", key: "TAVILY_API_KEY", value: "tvly-12345678901" }],
      healthCheck: "none",
      reason: "after-invalid-batch",
      actor: "test",
    });
    expect(ok.success).toBe(true);
  });

  test("rate limit after 10 applying transactions in window", async () => {
    resetConfigGuardRateLimitForTests();
    for (let i = 0; i < 10; i++) {
      const r = await transaction({
        operations: [{ type: "set", key: "TAVILY_API_KEY", value: "tvly-12345678901" }],
        healthCheck: "none",
        overwrite: true,
        reason: `t${i}`,
        actor: "test",
      });
      expect(r.success).toBe(true);
    }
    return expect(
      transaction({
        operations: [{ type: "set", key: "TAVILY_API_KEY", value: "tvly-12345678901" }],
        healthCheck: "none",
        overwrite: true,
        reason: "overflow",
        actor: "test",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });
});
