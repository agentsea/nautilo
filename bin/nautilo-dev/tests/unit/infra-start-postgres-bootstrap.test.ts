import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPgBootstrapRoleProbeScript,
  assertInfraMigrationLedgerCompatible,
  assertInfraPendingMigrationsAllowed,
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

  test("guards only pending migrations on protected durable instances", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-infra-start-guard-"));
    const protectedRoot = join(root, "protected");
    mkdirSync(protectedRoot);
    writeFileSync(join(protectedRoot, ".protected-instance"), "protected-by=operator\n");
    const checkout: MigrationLineageEntry[] = [
      { index: 0, tag: "0000_first", createdAt: 100, sha256: "a".repeat(64) },
      { index: 1, tag: "0001_second", createdAt: 200, sha256: "b".repeat(64) },
    ];
    const pendingLedger = `100|${"a".repeat(64)}`;
    const exactLedger = `${pendingLedger}\n200|${"b".repeat(64)}`;
    const durableProfile = {
      classification: "local" as const,
      retention: "durable" as const,
      reason: "local profile owns this instance",
    };
    const disposableProfile = {
      classification: "local" as const,
      retention: "disposable" as const,
      reason: "local profile owns this disposable instance",
    };

    try {
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: pendingLedger,
        checkout,
        instanceRoot: protectedRoot,
        profileAuthority: null,
      })).toThrow(/protected durable instance/);
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: pendingLedger,
        checkout,
        instanceRoot: root,
        profileAuthority: durableProfile,
      })).toThrow(/protected durable instance/);
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: pendingLedger,
        checkout,
        instanceRoot: protectedRoot,
        profileAuthority: durableProfile,
        iKnowWhatIAmDoing: true,
      })).not.toThrow();
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: pendingLedger,
        checkout,
        instanceRoot: root,
        profileAuthority: disposableProfile,
      })).not.toThrow();
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: pendingLedger,
        checkout,
        instanceRoot: root,
        profileAuthority: null,
      })).not.toThrow();
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: "",
        checkout,
        instanceRoot: protectedRoot,
        profileAuthority: null,
      })).toThrow(/protected durable instance/);
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: "",
        checkout,
        instanceRoot: root,
        profileAuthority: disposableProfile,
      })).not.toThrow();
      expect(() => assertInfraPendingMigrationsAllowed({
        rawLedger: exactLedger,
        checkout,
        instanceRoot: protectedRoot,
        profileAuthority: durableProfile,
      })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses pending migrations when profile authority is remote or ambiguous", () => {
    const checkout: MigrationLineageEntry[] = [
      { index: 0, tag: "0000_first", createdAt: 100, sha256: "a".repeat(64) },
      { index: 1, tag: "0001_second", createdAt: 200, sha256: "b".repeat(64) },
    ];
    const base = {
      rawLedger: `100|${"a".repeat(64)}`,
      checkout,
      instanceRoot: "/tmp/nautilo-infra-start-authority-fixture",
      iKnowWhatIAmDoing: true,
    };

    expect(() => assertInfraPendingMigrationsAllowed({
      ...base,
      profileAuthority: {
        classification: "remote",
        retention: "unknown",
        reason: "remote profile owns this projection",
      },
    })).toThrow(/classifies this instance as remote/);
    expect(() => assertInfraPendingMigrationsAllowed({
      ...base,
      profileAuthority: {
        classification: "unknown",
        retention: "unknown",
        reason: "conflicting profile claims",
      },
    })).toThrow(/profile authority is ambiguous/);
    expect(() => assertInfraPendingMigrationsAllowed({
      ...base,
      rawLedger: "",
      profileAuthority: {
        classification: "remote",
        retention: "unknown",
        reason: "remote profile owns this projection",
      },
    })).toThrow(/classifies this instance as remote/);
    expect(() => assertInfraPendingMigrationsAllowed({
      ...base,
      rawLedger: "",
      profileAuthority: {
        classification: "unknown",
        retention: "unknown",
        reason: "conflicting profile claims",
      },
    })).toThrow(/profile authority is ambiguous/);
  });

  test("runs the migration safety preflight before any persisted service repair", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/commands/infra-start.ts"),
      "utf8",
    );
    const preflight = source.indexOf("await preflightInfraMigrationLedger(legacyPg");
    const serviceRepair = source.indexOf(
      'console.log("[infra:start] reconciling persisted Nautilo service roles...")',
    );
    const logtoBootstrap = source.indexOf(
      'console.log("[infra:start] running bootstrap-logto (idempotent)...")',
    );
    const migrations = source.indexOf(
      'console.log("[infra:start] applying nautilo DB migrations...")',
    );

    expect(source).not.toContain('if (ledgerTable === "") return;');
    expect(source).toContain('const rawLedger = ledgerTable === ""');
    expect(preflight).toBeGreaterThan(0);
    expect(serviceRepair).toBeGreaterThan(preflight);
    expect(logtoBootstrap).toBeGreaterThan(serviceRepair);
    expect(migrations).toBeGreaterThan(logtoBootstrap);
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
