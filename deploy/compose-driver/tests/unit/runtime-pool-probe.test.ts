import { describe, expect, test } from "bun:test";

import {
  buildAgentRuntimePoolProbe,
  buildRestrictedRuntimePoolsProbe,
} from "../../src/runtime-pool-probe.ts";

describe("M215 runtime pool probe", () => {
  test("builds a postgres.js probe via nautilo-server exec", () => {
    const probe = buildAgentRuntimePoolProbe({
      composeBin: "docker",
      projectName: "nautilo-beta",
    });
    expect(probe.label).toContain("postgres.js");
    expect(probe.cmd).toContain("nautilo-beta-nautilo-server");
    expect(probe.cmd).toContain("DB_AGENT_CONNECTION_STRING");
    expect(probe.cmd).toContain('import postgres from "postgres"');
    expect(probe.cmd).not.toContain("db.localtest.me");
    expect(probe.cmd).not.toContain("/sql");
    expect(probe.cmd).not.toContain("Neon-Connection-String");
  });

  test("probes both restricted runtime pools and exact role identities", () => {
    const probe = buildRestrictedRuntimePoolsProbe({
      composeBin: "docker",
      projectName: "nautilo-beta",
    });
    expect(probe.label).toContain("nautilo_crypto");
    expect(probe.cmd).toContain("DB_AGENT_CONNECTION_STRING");
    expect(probe.cmd).toContain("DB_CRYPTO_CONNECTION_STRING");
    expect(probe.cmd).toContain("current_user");
    expect(probe.cmd).not.toContain("crypto-secret");
  });
});
