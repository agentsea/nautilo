import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  discoverRailwayMaintenanceStates,
  latestRailwayMaintenanceStates,
  railwayFailedMaintenanceCleanupComplete,
  resolveRailwayMaintenanceDatabaseUrls,
  runRailwayHostMaintenance,
  verifyRailwayMaintenanceRecoveryBinding,
} from "../../src/lib/railway-host-maintenance";

describe("public Railway maintenance facade", () => {
  test("never treats failure history as discard authority but closes already absent legacy targets", () => {
    const base = {
      activeLaunch: undefined,
      restoreTargetState: { launchId: "restore-target" },
      maintenanceReceipt: {
        lastFailure: { operation: "candidate-upgrade", retryable: false, occurredAt: "2026-08-14T00:00:00.000Z" },
      },
    };
    expect(railwayFailedMaintenanceCleanupComplete(base as never)).toBe(false);
    expect(railwayFailedMaintenanceCleanupComplete({
      ...base,
      restoreTargetTeardown: { receipt: { cleanup: { state: "verified" }, resources: [] } },
    } as never)).toBe(true);
    expect(railwayFailedMaintenanceCleanupComplete({
      ...base,
      restoreTargetDisposition: { state: "discard-authorized" },
      restoreTargetTeardown: { receipt: { cleanup: { state: "verified" }, resources: [] } },
    } as never)).toBe(true);
  });

  test("selects only exact causal maintenance tips and preserves unlinked ambiguity", () => {
    const item = (maintenanceId: string, prior?: string) => ({
      maintenanceId,
      sourceLaunchId: "source-1",
      sourceLaunchState: { lifecycle: { state: "active", ...(prior === undefined ? {} : { maintenanceId: prior }) } },
    });
    expect(latestRailwayMaintenanceStates([
      item("first"), item("second", "first"), item("third", "second"),
    ] as never).map(({ maintenanceId }) => maintenanceId)).toEqual(["third"]);
    expect(latestRailwayMaintenanceStates([
      item("first"), item("second", "first"), item("parallel"),
    ] as never).map(({ maintenanceId }) => maintenanceId)).toEqual(["second", "parallel"]);
  });

  test("uses only the custodied PostgreSQL administrator roles for complete recovery dumps", () => {
    const base = { generatedSecrets: new Map([
      ["app-postgres-superuser-password", "app-admin"],
      ["logto-postgres-superuser-password", "logto-admin"],
      ["app-nautilo-db-password", "runtime-app-must-not-be-used"],
      ["logto-db-password", "runtime-logto-must-not-be-used"],
    ]) } as never;
    expect(resolveRailwayMaintenanceDatabaseUrls(base)).toEqual({
      app: "postgres://postgres:app-admin@${{app-postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/nautilo",
      logto: "postgres://postgres:logto-admin@${{logto-postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/logto_nautilo",
    });
    expect(() => resolveRailwayMaintenanceDatabaseUrls({ generatedSecrets: new Map([
      ["app-nautilo-db-password", "runtime-app"], ["logto-db-password", "runtime-logto"],
    ]) } as never)).toThrow("Railway maintenance custody is unavailable");
  });

  test("does not inspect custody, provider state, or create durable state before confirmation", async () => {
    const calls = 0;
    const result = await runRailwayHostMaintenance({ confirmed: false } as never);
    expect(result).toEqual({ outcome: "unconfirmed", phase: "confirmation" });
    expect(calls).toBe(0);
  });

  test("discovers no ambient maintenance outside the exact owner-only root", async () => {
    const root = await mkdtemp(join(tmpdir(), "railway-maintenance-public-"));
    try { expect(await discoverRailwayMaintenanceStates(join(root, "absent"))).toEqual([]); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects self-hashed completed topology under the wrong recovery MAC or authority before any effect", () => {
    const topology = { schemaVersion: 1, releaseId: "release-2" } as never;
    const bytes = JSON.stringify(topology);
    const encryptionKey = new Uint8Array(32).fill(7);
    const base = { targetTopology: topology,
      targetTopologySha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
      targetTopologyMac: createHmac("sha256", encryptionKey).update(bytes, "utf8").digest("hex"),
      authorityGenerationId: "authority-1", maintenanceReceipt: { targetReleaseId: "release-2" } };
    const recoveryConfig = { encryptionKey } as never;
    const effects = 0;
    expect(verifyRailwayMaintenanceRecoveryBinding({ state: base as never, recoveryConfig,
      authorityGenerationId: "authority-1" })).toEqual(topology);
    expect(() => verifyRailwayMaintenanceRecoveryBinding({ state: { ...base, targetTopologyMac: "0".repeat(64) } as never,
      recoveryConfig, authorityGenerationId: "authority-1" })).toThrow("target release is unavailable");
    expect(() => verifyRailwayMaintenanceRecoveryBinding({ state: base as never, recoveryConfig,
      authorityGenerationId: "authority-2" })).toThrow("target release is unavailable");
    expect(effects).toBe(0);
  });
});
