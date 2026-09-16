import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  McpAuthNotAvailableError,
  McpEnvTokenMissingError,
  buildSpawnEnv,
  inspectEnvPassthrough,
  resolveEnvPassthrough,
  resolveMcpAuth,
} from "../../src/resolve-auth.ts";
import type { McpServerConfig } from "../../src/types.ts";

const baseConfig: McpServerConfig = {
  name: "test-server",
  host: "server",
  transportKind: "stdio",
  transport: { command: "echo" },
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clean any passthrough vars we use in tests so each test starts from
  // a known empty state.
  delete process.env["MCP_TEST_PT_FOO"];
  delete process.env["MCP_TEST_PT_BAR"];
  delete process.env["MCP_TEST_PT_FUNC"];
  delete process.env["MCP_TEST_TOKEN"];
});

afterEach(() => {
  // Restore env without nuking process.env entirely.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("resolveMcpAuth", () => {
  test("returns null when authRef is null or absent", () => {
    expect(resolveMcpAuth({ ...baseConfig, authRef: null })).toBeNull();
    // Omitted authRef is `undefined` at runtime — this covers the undefined
    // path without an explicit-undefined assignment (forbidden under
    // exactOptionalPropertyTypes).
    expect(resolveMcpAuth({ ...baseConfig })).toBeNull();
  });

  test("throws McpAuthNotAvailableError when authRef is set (bearer)", () => {
    const cfg: McpServerConfig = {
      ...baseConfig,
      authRef: { type: "bearer", vaultKey: "openai-key" },
    };
    expect(() => resolveMcpAuth(cfg)).toThrow(McpAuthNotAvailableError);
    try {
      resolveMcpAuth(cfg);
    } catch (e) {
      expect(e).toBeInstanceOf(McpAuthNotAvailableError);
      const err = e as McpAuthNotAvailableError;
      expect(err.serverName).toBe("test-server");
      expect(err.authRef).toEqual({ type: "bearer", vaultKey: "openai-key" });
      expect(err.message).toContain("vault wiring is not available");
      expect(err.message).toContain("bearer");
    }
  });

  test("throws McpAuthNotAvailableError when authRef is set (oauth)", () => {
    const cfg: McpServerConfig = {
      ...baseConfig,
      authRef: { type: "oauth", vaultKey: "github" },
    };
    expect(() => resolveMcpAuth(cfg)).toThrow(McpAuthNotAvailableError);
    try {
      resolveMcpAuth(cfg);
    } catch (e) {
      const err = e as McpAuthNotAvailableError;
      expect(err.authRef).toEqual({ type: "oauth", vaultKey: "github" });
      expect(err.message).toContain("oauth");
    }
  });

  test("does not throw when no env passthrough vars are declared (passthrough is not auth)", () => {
    process.env["MCP_TEST_PT_FOO"] = "bar";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO"],
    };
    expect(resolveMcpAuth(cfg)).toBeNull();
  });

  test("env-token authRef returns a Bearer header when the env var is set", () => {
    process.env["MCP_TEST_TOKEN"] = "sekret";
    const cfg: McpServerConfig = {
      ...baseConfig,
      authRef: { type: "env", envVar: "MCP_TEST_TOKEN" },
    };
    const auth = resolveMcpAuth(cfg, "headers");
    expect(auth?.bearerToken).toBe("sekret");
    expect(auth?.headers?.["Authorization"]).toBe("Bearer sekret");
  });

  test("env-token authRef throws McpEnvTokenMissingError when the env var is unset", () => {
    const cfg: McpServerConfig = {
      ...baseConfig,
      authRef: { type: "env", envVar: "MCP_TEST_TOKEN" },
    };
    expect(() => resolveMcpAuth(cfg)).toThrow(McpEnvTokenMissingError);
  });
});

describe("resolveEnvPassthrough", () => {
  test("returns empty object when envPassthrough is null/undefined", () => {
    expect(resolveEnvPassthrough(baseConfig)).toEqual({});
    expect(resolveEnvPassthrough({ ...baseConfig, envPassthrough: null })).toEqual({});
  });

  test("resolves declared vars from process.env", () => {
    process.env["MCP_TEST_PT_FOO"] = "fooval";
    process.env["MCP_TEST_PT_BAR"] = "barval";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO", "MCP_TEST_PT_BAR"],
    };
    expect(resolveEnvPassthrough(cfg)).toEqual({
      MCP_TEST_PT_FOO: "fooval",
      MCP_TEST_PT_BAR: "barval",
    });
  });

  test("skips missing vars silently (matches SDK behavior)", () => {
    process.env["MCP_TEST_PT_FOO"] = "fooval";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO", "MCP_TEST_PT_MISSING"],
    };
    expect(resolveEnvPassthrough(cfg)).toEqual({ MCP_TEST_PT_FOO: "fooval" });
  });

  test("skips shell-function exports (security)", () => {
    process.env["MCP_TEST_PT_FUNC"] = "() { echo hi; }";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FUNC"],
    };
    expect(resolveEnvPassthrough(cfg)).toEqual({});
  });

  test("reads from a provided env object (does not touch process.env)", () => {
    const fakeEnv = { MCP_TEST_PT_FOO: "fromfake" } as unknown as NodeJS.ProcessEnv;
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO"],
    };
    expect(resolveEnvPassthrough(cfg, fakeEnv)).toEqual({
      MCP_TEST_PT_FOO: "fromfake",
    });
  });

  test("does not cache — each call re-reads env", () => {
    process.env["MCP_TEST_PT_FOO"] = "first";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO"],
    };
    expect(resolveEnvPassthrough(cfg)).toEqual({ MCP_TEST_PT_FOO: "first" });
    process.env["MCP_TEST_PT_FOO"] = "second";
    expect(resolveEnvPassthrough(cfg)).toEqual({ MCP_TEST_PT_FOO: "second" });
  });

  test("inspects child env readiness by name without returning values", () => {
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO", "MCP_TEST_PT_MISSING"],
    };
    const report = inspectEnvPassthrough(cfg, {
      MCP_TEST_PT_FOO: "secret-value-never-returned",
    } as NodeJS.ProcessEnv);
    expect(report).toEqual([
      { name: "MCP_TEST_PT_FOO", present: true },
      { name: "MCP_TEST_PT_MISSING", present: false },
    ]);
    expect(JSON.stringify(report)).not.toContain("secret-value-never-returned");
  });
});

describe("buildSpawnEnv", () => {
  test("merges SDK baseline + passthrough + literal (literal wins)", () => {
    process.env["PATH"] = "/usr/bin";
    process.env["MCP_TEST_PT_FOO"] = "ptval";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO", "PATH"],
      envLiteral: { MCP_TEST_PT_FOO: "literal-overrides-pt", EXTRA: "lit" },
    };
    const env = buildSpawnEnv(cfg);
    expect(env["MCP_TEST_PT_FOO"]).toBe("literal-overrides-pt");
    expect(env["EXTRA"]).toBe("lit");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  test("does not include undeclared passthrough vars", () => {
    process.env["MCP_TEST_PT_FOO"] = "fooval";
    process.env["SECRET"] = "should-not-leak";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO"],
    };
    const env = buildSpawnEnv(cfg);
    expect(env["MCP_TEST_PT_FOO"]).toBe("fooval");
    expect(env["SECRET"]).toBeUndefined();
  });

  test("spawnEnvBase (local tier): sits over SDK baseline, under passthrough + literal", () => {
    process.env["MCP_TEST_PT_FOO"] = "pt-wins";
    const cfg: McpServerConfig = {
      ...baseConfig,
      envPassthrough: ["MCP_TEST_PT_FOO"],
      envLiteral: { LIT: "lit-wins" },
    };
    const env = buildSpawnEnv(cfg, process.env, {
      JAVA_HOME: "/opt/homebrew/opt/openjdk@17",
      PATH: "/custom/bin:/usr/bin",
      MCP_TEST_PT_FOO: "base-loses",
      LIT: "base-loses",
    });
    // Toolchain vars from the base survive (the SDK safe-list alone drops them).
    expect(env["JAVA_HOME"]).toBe("/opt/homebrew/opt/openjdk@17");
    expect(env["PATH"]).toBe("/custom/bin:/usr/bin");
    // Explicit config still wins over the base.
    expect(env["MCP_TEST_PT_FOO"]).toBe("pt-wins");
    expect(env["LIT"]).toBe("lit-wins");
  });

  test("no spawnEnvBase (server tier): strict SDK baseline, no toolchain vars", () => {
    process.env["MCP_TEST_JAVA_HOME_PROBE"] = "/should/not/appear";
    const cfg: McpServerConfig = { ...baseConfig };
    const env = buildSpawnEnv(cfg);
    expect(env["MCP_TEST_JAVA_HOME_PROBE"]).toBeUndefined();
    delete process.env["MCP_TEST_JAVA_HOME_PROBE"];
  });
});
