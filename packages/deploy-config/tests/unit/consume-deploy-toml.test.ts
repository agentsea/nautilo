import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGTO_REQUIRED_KEYS } from "@nautilo/config-guard";
import { resetConfigGuardRateLimitForTests } from "@nautilo/config-guard";

import {
  consumeDeployConfigProviders,
  DeployConfigV1,
  planAdminRedemption,
  resolveDeployConfig,
  type ResolvedDeployConfig,
} from "../../src/index.ts";

const tmpDirs: string[] = [];

function seedDummyLogtoEnv(): void {
  for (const k of LOGTO_REQUIRED_KEYS) {
    if (k === "LOGTO_M2M_APP_SECRET") {
      process.env[k] = "test-m2m-secret-placeholder";
    } else {
      process.env[k] = "http://127.0.0.1:9/placeholder";
    }
  }
}

function clearTmpDirs(): void {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
}

describe("consume-deploy-toml", () => {
  let home: string;
  let envPath: string;
  const prevHome = process.env["HOME"];
  const prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
  const prevHosting = process.env["NAUTILO_HOSTING_MODE"];

  beforeEach(() => {
    clearTmpDirs();
    home = mkdtempSync(join(tmpdir(), "nautilo-consume-"));
    tmpDirs.push(home);
    envPath = join(home, "instance.env");
    writeFileSync(envPath, "", "utf8");
    process.env["HOME"] = home;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
    delete process.env["NAUTILO_HOSTING_MODE"];
    seedDummyLogtoEnv();
    resetConfigGuardRateLimitForTests();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    if (prevDotenv !== undefined) process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    else delete process.env["NAUTILO_DOTENV_PATH"];
    if (prevHosting !== undefined) process.env["NAUTILO_HOSTING_MODE"] = prevHosting;
    else delete process.env["NAUTILO_HOSTING_MODE"];
    clearTmpDirs();
    resetConfigGuardRateLimitForTests();
  });

  function baseResolved(): ResolvedDeployConfig {
    const d = DeployConfigV1.parse({
      schemaVersion: 1,
      admin: {
        handle: "alice",
        displayName: "Alice",
        password: { value: "password-ok-8+" },
      },
      providers: [],
    });
    return resolveDeployConfig(d, () => undefined);
  }

  test("planAdminRedemption with pin includes all fields", () => {
    const d = DeployConfigV1.parse({
      schemaVersion: 1,
      admin: {
        handle: "alice",
        displayName: "Alice",
        password: { value: "password-ok-8+" },
        pin: { value: "123456" },
      },
      providers: [],
    });
    const r = resolveDeployConfig(d, () => undefined);
    const plan = planAdminRedemption(r);
    expect(plan.handle).toBe("alice");
    expect(plan.displayName).toBe("Alice");
    expect(plan.password).toBe("password-ok-8+");
    expect(plan.pin).toBe("123456");
    expect("forcePasswordChangeOnFirstSignIn" in plan).toBe(false);
  });

  test("planAdminRedemption without pin omits pin", () => {
    const plan = planAdminRedemption(baseResolved());
    expect(plan.pin).toBeUndefined();
  });

  test("consumeDeployConfigProviders writes then second call is unchanged", async () => {
    const key = "OPENAI_API_KEY";
    const val = "sk-proj-123456789012345678901234";
    const resolved: ResolvedDeployConfig = {
      ...baseResolved(),
      providers: [{ key, value: { value: val } }],
    };
    const a1 = await consumeDeployConfigProviders(resolved, { dotenvPath: envPath });
    expect(a1).toEqual([{ key, status: "written" }]);
    const a2 = await consumeDeployConfigProviders(resolved, { dotenvPath: envPath });
    expect(a2).toEqual([{ key, status: "unchanged" }]);
    expect(readFileSync(envPath, "utf8")).toContain(key);
  });

  test("consumeDeployConfigProviders skips empty value", async () => {
    const resolved: ResolvedDeployConfig = {
      ...baseResolved(),
      providers: [{ key: "ANTHROPIC_API_KEY", value: { value: "   " } }],
    };
    const audit: Array<{ key: string; status: string }> = [];
    const out = await consumeDeployConfigProviders(resolved, {
      dotenvPath: envPath,
      audit: (e) => audit.push(e),
    });
    expect(out).toEqual([{ key: "ANTHROPIC_API_KEY", status: "skipped-empty" }]);
    expect(audit).toEqual([{ key: "ANTHROPIC_API_KEY", status: "skipped-empty" }]);
    expect(readFileSync(envPath, "utf8").trim()).toBe("");
  });

  test("consumeDeployConfigProviders rejects forbidden keys before any write", async () => {
    const resolved: ResolvedDeployConfig = {
      ...baseResolved(),
      providers: [
        { key: "TAVILY_API_KEY", value: { value: "tvly-1234567890123456789012" } },
        { key: "LOGTO_FAKE", value: { value: "x" } },
      ],
    };
    try {
      await consumeDeployConfigProviders(resolved, { dotenvPath: envPath });
      expect.unreachable("expected consume to reject");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("LOGTO_FAKE");
      expect(msg).toContain("Unknown or disallowed environment variable");
    }
    expect(readFileSync(envPath, "utf8").trim()).toBe("");

    const cases: Array<{ key: string; value: string }> = [
      { key: "NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA", value: "secretsecret" },
      { key: "AUTH_MODE", value: "legacy" },
      { key: "NAUTILO_CLAIM_INVITE_LEGACY", value: "invite-token" },
    ];
    for (const { key, value } of cases) {
      writeFileSync(envPath, "", "utf8");
      const r: ResolvedDeployConfig = {
        ...baseResolved(),
        providers: [{ key, value: { value } }],
      };
      const p = consumeDeployConfigProviders(r, { dotenvPath: envPath });
      expect(p).rejects.toThrow(
        new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      expect(readFileSync(envPath, "utf8").trim()).toBe("");
    }
  });

  test("audit entries follow provider order with mixed outcomes", async () => {
    if (process.platform === "win32") return;
    chmodSync(envPath, 0o600);
    const v = "sk-proj-123456789012345678901234";
    const resolved: ResolvedDeployConfig = {
      ...baseResolved(),
      providers: [
        { key: "OPENAI_API_KEY", value: { value: v } },
        { key: "ANTHROPIC_API_KEY", value: { value: "  " } },
        { key: "TAVILY_API_KEY", value: { value: "tvly-1234567890123456789012" } },
      ],
    };
    const audit: Array<{ key: string; status: string }> = [];
    const out = await consumeDeployConfigProviders(resolved, {
      dotenvPath: envPath,
      audit: (e) => audit.push(e),
    });
    expect(out.map((o) => o.status)).toEqual(["written", "skipped-empty", "written"]);
    expect(audit.map((a) => `${a.key}:${a.status}`)).toEqual([
      `OPENAI_API_KEY:written`,
      `ANTHROPIC_API_KEY:skipped-empty`,
      `TAVILY_API_KEY:written`,
    ]);
  });
});
