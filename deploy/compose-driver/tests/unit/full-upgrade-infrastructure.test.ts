import { describe, expect, test } from "bun:test";
import { buildAuthContract } from "../../../contracts/auth.ts";
import { DEPENDENCY_PINS } from "../../../dependency-pins.ts";
import {
  assertFullUpgradeInfrastructureContract,
  recoveryLogtoVersion,
  refreshFullUpgradeInfrastructureEnv,
  resolveRecoveryImageReference,
} from "../../src/full-upgrade-infrastructure.ts";

const oldImage = `registry.example.org/auth@sha256:${"a".repeat(64)}`;
const newImage = `registry.example.org/auth@sha256:${"b".repeat(64)}`;

describe("full upgrade infrastructure inputs", () => {
  test("accepts the packaged baseline and refuses unrelated server contracts", () => {
    const contract = buildAuthContract();
    expect(() => assertFullUpgradeInfrastructureContract(contract)).not.toThrow();
    expect(() => assertFullUpgradeInfrastructureContract({
      ...contract, logtoEngine: { ...contract.logtoEngine, image: oldImage },
    })).toThrow("different authentication baseline");
    expect(() => assertFullUpgradeInfrastructureContract({
      ...contract, logtoEngine: { ...contract.logtoEngine, minimumVersion: "1.38.0" },
    })).toThrow("different authentication baseline");
  });

  test("refreshes only public image selections, preserving credentials and operator settings", () => {
    const current = "# preserved\r\nLOGTO_IMAGE=old:1.38.0\r\nLOGTO_IMAGE_TAG=1.38.0\r\n" +
      "POSTGRES_IMAGE=postgres:16\r\nPGVECTOR_IMAGE=pgvector/pgvector:pg17\r\n" +
      "LOGTO_DB_PASSWORD=fixture-secret\r\nNAUTILO_DEPLOY_LOGTO_PORT=4401\r\nCUSTOM_SETTING=preserved\r\n";
    const updated = refreshFullUpgradeInfrastructureEnv(current);
    expect(updated).toContain(`LOGTO_IMAGE=${DEPENDENCY_PINS.logto}\r\n`);
    expect(updated).toContain(`LOGTO_IMAGE_TAG=${DEPENDENCY_PINS.packagedLogtoImageTag}\r\n`);
    expect(updated).toContain(`POSTGRES_IMAGE=${DEPENDENCY_PINS.postgres}\r\n`);
    expect(updated).toContain(`PGVECTOR_IMAGE=${DEPENDENCY_PINS.pgvectorPg17}\r\n`);
    expect(updated).toContain("# preserved\r\n");
    expect(updated).toContain("LOGTO_DB_PASSWORD=fixture-secret\r\nNAUTILO_DEPLOY_LOGTO_PORT=4401\r\nCUSTOM_SETTING=preserved\r\n");
    expect(refreshFullUpgradeInfrastructureEnv(updated)).toBe(updated);
  });

  test("captures the actual old image despite an already-configured incoming digest", () => {
    expect(resolveRecoveryImageReference(oldImage, newImage, [oldImage])).toBe(oldImage);
    expect(resolveRecoveryImageReference("registry.example.org/auth:1.38.0", newImage, [oldImage])).toBe(oldImage);
  });

  test("keeps the actual namespace and resolves an archived local alias through its configured repository", () => {
    const alias = `registry.example.org/alias@sha256:${"a".repeat(64)}`;
    expect(resolveRecoveryImageReference(oldImage, alias, [alias, oldImage])).toBe(oldImage);
    expect(resolveRecoveryImageReference("local-recovery/auth:snapshot", oldImage, [oldImage])).toBe(oldImage);
  });

  test("refuses missing, malformed and ambiguous actual image identities", () => {
    for (const digests of [null, [], [42], ["registry.example.org/auth:latest"], [oldImage, "invalid"], [oldImage, newImage]]) {
      expect(() => resolveRecoveryImageReference("registry.example.org/auth:1.38.0", newImage, digests)).toThrow("backup:");
    }
  });

  test("freezes the actual authentication image version, never an incoming target", () => {
    expect(recoveryLogtoVersion("1.38.0\n")).toBe("1.38.0");
    for (const version of ["", "<no value>", "1.45.0-next", "latest"]) {
      expect(() => recoveryLogtoVersion(version)).toThrow("actual authentication image version");
    }
  });
});
