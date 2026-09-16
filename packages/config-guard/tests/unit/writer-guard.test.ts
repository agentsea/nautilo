import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigGuardRateLimitForTests, transaction } from "../../src";

describe("writer-guard forbidden keys (validateOperations + transaction)", () => {
  let dir: string;
  let envPath: string;
  const prevHome = process.env["HOME"];
  const prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
  const prevHosting = process.env["NAUTILO_HOSTING_MODE"];

  beforeEach(() => {
    resetConfigGuardRateLimitForTests();
    dir = mkdtempSync(join(tmpdir(), "nautilo-writer-guard-"));
    mkdirSync(join(dir, ".nautilo"), { recursive: true });
    envPath = join(dir, ".nautilo", "instance.env");
    writeFileSync(envPath, "OPENAI_API_KEY=sk-existing-placeholder\n", { mode: 0o600 });
    process.env["HOME"] = dir;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
    process.env["NAUTILO_HOSTING_MODE"] = "local";
  });

  afterEach(() => {
    resetConfigGuardRateLimitForTests();
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    if (prevDotenv !== undefined) process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    else delete process.env["NAUTILO_DOTENV_PATH"];
    if (prevHosting !== undefined) process.env["NAUTILO_HOSTING_MODE"] = prevHosting;
    else delete process.env["NAUTILO_HOSTING_MODE"];
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects setup-time-only and retired keys with remediation", async () => {
    const keys = [
      "NAUTILO_BOOTSTRAP_PIN_TEST_1",
      "NAUTILO_CLAIM_INVITE_BETA",
      "NAUTILO_ADMIN_PASSWORD",
      "AUTH_MODE",
      "NAUTILO_OWNER_ID",
    ];
    for (const key of keys) {
      const before = readFileSync(envPath, "utf8");
      const result = await transaction({
        operations: [{ type: "set", key, value: "12345" }],
        healthCheck: "none",
        overwrite: true,
        reason: "writer-guard test",
        actor: "test",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("forbidden in instance.env");
      if (key === "AUTH_MODE" || key === "NAUTILO_OWNER_ID") {
        expect(result.error).toContain("(retired)");
      } else {
        expect(result.error).toContain("(setup-time-only)");
      }
      expect(result.error).toMatch(/deploy\.toml|\.bootstrap|retired/i);
      expect(readFileSync(envPath, "utf8")).toBe(before);
    }
  });

  test("NAUTILO_BOOTSTRAP_TOKEN is not tripped by forbidden guard (fails as unknown key)", async () => {
    const before = readFileSync(envPath, "utf8");
    const result = await transaction({
      operations: [{ type: "set", key: "NAUTILO_BOOTSTRAP_TOKEN", value: "substrate-token" }],
      healthCheck: "none",
      overwrite: true,
      reason: "writer-guard test",
      actor: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error ?? "").not.toContain("forbidden in instance.env");
    expect(result.error).toContain("Unknown or disallowed environment variable");
    expect(readFileSync(envPath, "utf8")).toBe(before);
  });
});
