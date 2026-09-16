import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertFullRestoreTarget, assertImportedRestoreLineage } from "../../src/lib/full-dev-restore";
import type { VerifiedFullBackup } from "../../src/lib/full-dev-backup";

const entry = { index: 0, tag: "0000_first", createdAt: 100, sha256: "a".repeat(64) };
const target = { instanceId: "restore-fixture", nautiloMajor: 17, logtoMajor: 16 };
function backup(): VerifiedFullBackup {
  const artifact = (file: string) => ({ file, bytes: 1, sha256: "b".repeat(64) });
  return { dir: "/unused/verified-fixture", manifest: {
    formatVersion: 2, name: "verified-fixture", createdAt: "2026-09-07T00:00:00Z",
    sourceInstanceId: target.instanceId, sourceDeploymentMode: "dev-multi-instance",
    capture: { consistency: "quiesced", nautiloWriterStopped: true, logtoWriterStopped: true },
    artifacts: { nautiloDatabase: artifact("database.sql.gz"), logtoDatabase: artifact("logto_nautilo.sql.gz"), instanceEnv: artifact("dot-env"), nautiloHome: artifact("nautilo-home.tar.gz") },
    drizzle: { lastAppliedIndex: 0, entries: [entry] }, postgres: { nautiloMajor: 17, logtoMajor: 16 },
    rowAnchors: {}, complete: true, cloneEligible: true, backupMode: "dump",
  } };
}

describe("full development restore admission", () => {
  test("accepts the same identity and exact migration prefix", () => {
    expect(() => assertFullRestoreTarget(backup(), target, [entry])).not.toThrow();
    expect(() => assertFullRestoreTarget(backup(), target, [entry, { ...entry, index: 1, createdAt: 101, tag: "0001_next", sha256: "c".repeat(64) }])).not.toThrow();
  });
  test("refuses another instance even with compatible schema", () => {
    expect(() => assertFullRestoreTarget(backup(), { ...target, instanceId: "another" }, [entry])).toThrow("same instance identity");
  });
  test("refuses incompatible database majors", () => {
    expect(() => assertFullRestoreTarget(backup(), { ...target, logtoMajor: 17 }, [entry])).toThrow("major versions");
  });
  test("refuses divergent or older checkout lineage", () => {
    expect(() => assertFullRestoreTarget(backup(), target, [{ ...entry, sha256: "c".repeat(64) }])).toThrow();
    expect(() => assertFullRestoreTarget(backup(), target, [])).toThrow();
  });
  test("refuses physical archives and mismatched member names", () => {
    const physical = backup(); physical.manifest.backupMode = "basebackup";
    expect(() => assertFullRestoreTarget(physical, target, [entry])).toThrow("logical database dump");
    const renamed = backup(); renamed.manifest.artifacts.nautiloDatabase.file = "other.sql.gz";
    expect(() => assertFullRestoreTarget(renamed, target, [entry])).toThrow("Unexpected full restore artifact");
  });
  test("compares the actual imported ledger exactly before migrations can run", () => {
    expect(() => assertImportedRestoreLineage([entry], [entry])).not.toThrow();
    expect(() => assertImportedRestoreLineage([], [entry])).toThrow("Imported migration ledger");
    expect(() => assertImportedRestoreLineage([{ ...entry, createdAt: 101 }], [entry])).toThrow("Imported migration ledger");
    expect(() => assertImportedRestoreLineage([{ ...entry, sha256: "c".repeat(64) }], [entry])).toThrow("Imported migration ledger");
  });
  test("preserves ledger insertion order even when historical timestamps are not monotonic", () => {
    const second = { ...entry, index: 1, createdAt: 99, sha256: "d".repeat(64) };
    expect(() => assertImportedRestoreLineage([entry, second], [entry, second])).not.toThrow();
    expect(() => assertImportedRestoreLineage([second, entry], [entry, second])).toThrow();
    const source = readFileSync(new URL("../../src/lib/docker-db.ts", import.meta.url), "utf8");
    expect(source).toContain("FROM drizzle.__drizzle_migrations ORDER BY id ASC;");
  });
});
