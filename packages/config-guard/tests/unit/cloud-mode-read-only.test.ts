import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGTO_REQUIRED_KEYS } from "../../src/mode-registry";
import {
  KEY_REGISTRY,
  getAllKeyDefinitions,
  isConfigWritable,
  reloadEnvAndStripRemovedRegistryKeys,
  reloadEnvOverlay,
  transaction,
} from "../../src";

function seedDummyLogtoEnv(): void {
  for (const k of LOGTO_REQUIRED_KEYS) {
    if (k === "LOGTO_M2M_APP_SECRET") {
      process.env[k] = "test-m2m-secret-placeholder";
    } else {
      process.env[k] = "http://127.0.0.1:9/placeholder";
    }
  }
}

describe("config-guard in cloud mode", () => {
  const orig = process.env["NAUTILO_HOSTING_MODE"];
  const prevHome = process.env["HOME"];
  const prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
  const prevOpenAi = process.env["OPENAI_API_KEY"];
  const prevOpenRouter = process.env["OPENROUTER_API_KEY"];
  const prevDeploymentMode = process.env["NAUTILO_DEPLOYMENT_MODE"];
  let tmpHome: string;

  beforeEach(() => {
    process.env["NAUTILO_HOSTING_MODE"] = "cloud";
    seedDummyLogtoEnv();
    tmpHome = mkdtempSync(join(tmpdir(), "nautilo-cloud-guard-"));
    mkdirSync(join(tmpHome, ".nautilo"), { recursive: true });
    const envPath = join(tmpHome, ".nautilo", "instance.env");
    process.env["HOME"] = tmpHome;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-existing-platform-key-value";
    delete process.env["OPENAI_API_KEY"];
  });
  afterEach(() => {
    if (orig === undefined) delete process.env["NAUTILO_HOSTING_MODE"];
    else process.env["NAUTILO_HOSTING_MODE"] = orig;
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    if (prevDotenv !== undefined) process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    else delete process.env["NAUTILO_DOTENV_PATH"];
    if (prevOpenAi !== undefined) process.env["OPENAI_API_KEY"] = prevOpenAi;
    else delete process.env["OPENAI_API_KEY"];
    if (prevOpenRouter !== undefined) process.env["OPENROUTER_API_KEY"] = prevOpenRouter;
    else delete process.env["OPENROUTER_API_KEY"];
    if (prevDeploymentMode !== undefined) process.env["NAUTILO_DEPLOYMENT_MODE"] = prevDeploymentMode;
    else delete process.env["NAUTILO_DEPLOYMENT_MODE"];
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("generic config remains non-writable despite the narrow provider-key path", () => {
    expect(isConfigWritable()).toBe(false);
    expect(getAllKeyDefinitions()).toBe(KEY_REGISTRY);
  });

  test("cloud Admin writes an override without freezing unrelated platform keys or snapshotting old secrets", async () => {
    const result = await transaction({
      operations: [{ type: "set", key: "OPENAI_API_KEY", value: "sk-new-cloud-provider-key-value" }],
      healthCheck: "none",
      overwrite: true,
      reason: "test",
      actor: "agent",
    });
    expect(result.success).toBe(true);
    expect(process.env["OPENAI_API_KEY"]).toBe("sk-new-cloud-provider-key-value");
    expect(process.env["OPENROUTER_API_KEY"]).toBe("sk-or-v1-existing-platform-key-value");
    const persisted = readFileSync(process.env["NAUTILO_DOTENV_PATH"]!, "utf8");
    expect(persisted).toContain("OPENAI_API_KEY=sk-new-cloud-provider-key-value");
    expect(persisted).not.toContain("OPENROUTER_API_KEY");
    expect(persisted).not.toContain("LOGTO_M2M_APP_SECRET");

    const changed = await transaction({
      operations: [{ type: "set", key: "OPENAI_API_KEY", value: "sk-rotated-cloud-provider-key-value" }],
      healthCheck: "none",
      overwrite: true,
      reason: "test rotation",
      actor: "agent",
    });
    expect(changed.success).toBe(true);
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-rotated-platform-key-value";
    reloadEnvOverlay(process.env["NAUTILO_DOTENV_PATH"]!);
    expect(process.env["OPENROUTER_API_KEY"]).toBe("sk-or-v1-rotated-platform-key-value");
    expect(process.env["OPENAI_API_KEY"]).toBe("sk-rotated-cloud-provider-key-value");

    const snapshots = readdirSync(join(tmpHome, ".nautilo", "config-snapshots"))
      .filter((name) => name.endsWith(".env"));
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(readFileSync(join(tmpHome, ".nautilo", "config-snapshots", snapshot), "utf8"))
        .toBe("");
    }
  });

  test("cloud Admin cannot mutate modes or remove provider authority", async () => {
    for (const operation of [
      { type: "set" as const, key: "NAUTILO_SEARCH_PROVIDER", value: "tavily" },
      { type: "remove" as const, key: "OPENAI_API_KEY" },
    ]) {
      const result = await transaction({
        operations: [operation],
        healthCheck: "none",
        overwrite: true,
        reason: "test",
        actor: "agent",
      });
      expect(result.success).toBe(false);
      expect(result.rejectedReason).toBe("provider_keys_only_in_cloud");
    }
  });

  test("cloud-managed instances cannot replace included keys or override them during reload", async () => {
    process.env["NAUTILO_DEPLOYMENT_MODE"] = "cloud-managed";
    const result = await transaction({
      operations: [{ type: "set", key: "OPENROUTER_API_KEY", value: "tenant-override" }],
      healthCheck: "none",
      overwrite: true,
      reason: "test",
      actor: "agent",
    });
    expect(result.success).toBe(false);
    expect(result.rejectedReason).toBe("managed_provider_key");

    const envPath = process.env["NAUTILO_DOTENV_PATH"]!;
    await Bun.write(envPath, "OPENROUTER_API_KEY=tenant-file-value\nOPENAI_API_KEY=personal-value\n");
    reloadEnvOverlay(envPath);
    expect(process.env["OPENROUTER_API_KEY"]).toBe("sk-or-v1-existing-platform-key-value");
    expect(process.env["OPENAI_API_KEY"]).toBe("personal-value");
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-platform-after-overlay";
    await reloadEnvAndStripRemovedRegistryKeys(envPath);
    expect(process.env["OPENROUTER_API_KEY"]).toBe("sk-or-v1-platform-after-overlay");
  });

  test("cloud provider writes fail closed without explicit persistent custody", async () => {
    delete process.env["NAUTILO_DOTENV_PATH"];
    const result = await transaction({
      operations: [{ type: "set", key: "OPENAI_API_KEY", value: "sk-new-cloud-provider-key-value" }],
      healthCheck: "none",
      overwrite: true,
      reason: "test",
      actor: "agent",
    });
    expect(result.success).toBe(false);
    expect(result.rejectedReason).toBe("read_only_in_cloud");
    expect(result.error).toContain("NAUTILO_DOTENV_PATH");
  });

  test("empty-operations transaction is a no-op (does not trip read-only)", async () => {
    const result = await transaction({
      operations: [],
      healthCheck: "none",
      overwrite: false,
      reason: "test",
      actor: "agent",
    });
    expect(result.success).toBe(true);
  });
});

describe("config-guard in local mode", () => {
  const orig = process.env["NAUTILO_HOSTING_MODE"];
  beforeEach(() => {
    process.env["NAUTILO_HOSTING_MODE"] = "local";
  });
  afterEach(() => {
    if (orig === undefined) delete process.env["NAUTILO_HOSTING_MODE"];
    else process.env["NAUTILO_HOSTING_MODE"] = orig;
  });

  test("isConfigWritable returns true", () => {
    expect(isConfigWritable()).toBe(true);
  });

  // Existing local-mode tests cover the write path; don't duplicate.
});
