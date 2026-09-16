import { describe, expect, test } from "bun:test";
import {
  buildPgBootstrapRoleProbeScript,
  assertInfraMigrationLedgerCompatible,
  bootstrapClaimInviteDepsForInfra,
  resolveInfraClaimInvitePaths,
  shouldPreserveProvisionedLogto,
  waitForPgBootstrapRoles,
} from "../../src/commands/infra-start";
import { CLONE_STAGES, type CloneOperationRecord } from "../../src/lib/clone-operation";
import type { MigrationLineageEntry } from "../../src/lib/migration-lineage";

describe("infra:start PostgreSQL bootstrap-role readiness (D475)", () => {
  test("rejects ahead, divergent, and backdated migration ledgers before mutation", () => {
    const checkout: MigrationLineageEntry[] = [
      { index: 0, tag: "0000_first", createdAt: 100, sha256: "a".repeat(64) },
      { index: 1, tag: "0001_second", createdAt: 200, sha256: "b".repeat(64) },
    ];
    expect(() => assertInfraMigrationLedgerCompatible("", checkout)).not.toThrow();
    expect(() => assertInfraMigrationLedgerCompatible(
      `100|${"a".repeat(64)}`,
      checkout,
    )).not.toThrow();
    expect(() => assertInfraMigrationLedgerCompatible(
      `100|${"a".repeat(64)}\n300|${"c".repeat(64)}`,
      checkout,
    )).toThrow(/source timestamp 300, branch timestamp 200/);
    expect(() => assertInfraMigrationLedgerCompatible(
      `100|${"a".repeat(64)}\n200|${"b".repeat(64)}\n300|${"c".repeat(64)}`,
      checkout,
    )).toThrow(/branch migration journal is older/);
  });
  test("persists cloned Logto preservation across ordinary target restarts", () => {
    const completeProvision: CloneOperationRecord = {
      formatVersion: 1,
      sourceInstanceId: "",
      targetInstanceId: "alpha",
      backupName: "canonical-default",
      startedAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:01:00.000Z",
      status: "complete",
      mode: "provision",
      completedStages: CLONE_STAGES.slice(
        0,
        CLONE_STAGES.indexOf("services-started"),
      ),
    };

    expect(shouldPreserveProvisionedLogto(false, null)).toBe(false);
    expect(shouldPreserveProvisionedLogto(true, null)).toBe(true);
    expect(shouldPreserveProvisionedLogto(false, completeProvision)).toBe(true);
  });

  test("refuses ordinary startup while clone provenance is incomplete", () => {
    const incomplete: CloneOperationRecord = {
      formatVersion: 1,
      sourceInstanceId: "",
      targetInstanceId: "alpha",
      backupName: "canonical-default",
      startedAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:30.000Z",
      status: "failed",
      mode: "provision",
      completedStages: ["topology-created"],
    };

    expect(() => shouldPreserveProvisionedLogto(false, incomplete)).toThrow(
      /incomplete clone operation/,
    );
  });

  test("forwards only an explicit disposable operator-home authority", () => {
    expect(bootstrapClaimInviteDepsForInfra({}, {})).toEqual({});
    expect(bootstrapClaimInviteDepsForInfra({}, { HOME: "/tmp/env-home" })).toEqual({
      operatorHomeDir: "/tmp/env-home",
    });
    expect(bootstrapClaimInviteDepsForInfra({ operatorHomeDir: "  /tmp/d489-home  " }))
      .toEqual({ operatorHomeDir: "/tmp/d489-home" });
    expect(bootstrapClaimInviteDepsForInfra({ operatorHomeDir: "   " }, {})).toEqual({});
    expect(resolveInfraClaimInvitePaths({ operatorHomeDir: "/tmp/d489-home" }, "", {})).toEqual({
      legacy: "/tmp/d489-home/.nautilo/claim-invite.txt",
      bootstrap: "/tmp/d489-home/.nautilo/.bootstrap/claim-invite",
    });
    expect(resolveInfraClaimInvitePaths({ operatorHomeDir: "/tmp/d489-home" }, "alpha", {})).toEqual({
      legacy: "/tmp/d489-home/.nautilo-alpha/claim-invite.txt",
      bootstrap: "/tmp/d489-home/.nautilo-alpha/.bootstrap/claim-invite",
    });
    expect(resolveInfraClaimInvitePaths({}, "beta", { HOME: "/tmp/env-home" })).toEqual({
      legacy: "/tmp/env-home/.nautilo-beta/claim-invite.txt",
      bootstrap: "/tmp/env-home/.nautilo-beta/.bootstrap/claim-invite",
    });
  });

  test("uses a read-only pg_roles probe for exactly the required service roles", () => {
    const script = buildPgBootstrapRoleProbeScript(["nautilo", "nautilo_agent"]);

    expect(script).toContain("FROM pg_roles");
    expect(script).toContain("'nautilo'");
    expect(script).toContain("'nautilo_agent'");
    expect(script).toContain("<> 2");
    expect(script).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i);
    expect(script).not.toContain("PASSWORD");
  });

  test("rejects empty, duplicate, and malformed role sets before probing", () => {
    expect(() => buildPgBootstrapRoleProbeScript([])).toThrow(/invalid required role set/);
    expect(() => buildPgBootstrapRoleProbeScript(["nautilo", "nautilo"])).toThrow(
      /invalid required role set/,
    );
    expect(() => buildPgBootstrapRoleProbeScript(["nautilo; drop role postgres"])).toThrow(
      /invalid required role set/,
    );
  });

  test("keeps polling the bootstrap condition until the roles exist", async () => {
    const calls: Array<{ container: string; roles: readonly string[] }> = [];
    let attempts = 0;

    await waitForPgBootstrapRoles(
      "nautilo-postgres",
      ["nautilo", "nautilo_agent"],
      100,
      {
        pollIntervalMs: 0,
        probe: async (input) => {
          calls.push(input);
          attempts++;
          return attempts === 2;
        },
      },
    );

    expect(calls).toEqual([
      { container: "nautilo-postgres", roles: ["nautilo", "nautilo_agent"] },
      { container: "nautilo-postgres", roles: ["nautilo", "nautilo_agent"] },
    ]);
  });
});
