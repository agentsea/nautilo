import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCheckpointMaintenanceOperationRecord,
  parseCloneSeedOperationRecord,
  writeCheckpointMaintenanceOperationRecord,
  writeCloneSeedOperationRecord,
} from "../../src/lib/d489-operation-records";

const roots: string[] = [];
const SHA256 = "a".repeat(64);
const COMMIT = "b".repeat(40);
const TIME = "2026-08-03T00:00:00.000Z";

function metrics(rows = 18, bytes = 180): Record<string, number> {
  return {
    checkpointRows: rows,
    writeRows: rows,
    blobRows: rows,
    totalRows: rows * 3,
    checkpointLogicalBytes: bytes,
    writeLogicalBytes: bytes,
    blobLogicalBytes: bytes,
    totalLogicalBytes: bytes * 3,
    blobPayloadBytes: bytes,
  };
}

function seedRecord(): Record<string, unknown> {
  return {
    formatVersion: 1,
    kind: "clone-seed",
    status: "published",
    startedAt: TIME,
    updatedAt: TIME,
    source: {
      authority: "canonical-default",
      deploymentMode: "local-self-host",
      checkoutCommitSha: COMMIT,
      lineage: { appliedMigrationCount: 1, lastAppliedIndex: 0, sha256: SHA256 },
    },
    capture: {
      capturedAt: TIME,
      freshness: "fresh",
      manifestSha256: SHA256,
      artifactCount: 4,
      artifactBytes: 1234,
    },
    completedStages: ["captured", "verified", "published"],
    artifactPolicy: "current-plus-one-previous-or-failed",
    failure: null,
    recovery: { retryState: "not-needed", guidance: "none" },
  };
}

function maintenanceRecord(): Record<string, unknown> {
  return {
    formatVersion: 1,
    kind: "checkpoint-maintenance",
    status: "complete",
    startedAt: TIME,
    updatedAt: TIME,
    target: "canonical-default",
    mode: "apply",
    consent: { apply: "explicit", defaultDangerAcknowledgment: "acknowledged" },
    backup: { status: "verified", manifestSha256: SHA256, artifactCount: 4, artifactBytes: 1234 },
    metrics: { before: metrics(), after: metrics(6, 60) },
    semanticCleanup: { status: "complete" },
    physicalReclamation: {
      intent: "not-requested",
      status: "not-requested",
      beforeRelationBytes: null,
      afterRelationBytes: null,
      reclaimedBytes: null,
    },
    completedStages: [
      "inventory-read", "consent-verified", "backup-verified", "writers-quiesced",
      "semantic-cleanup", "semantic-verified", "services-restored",
    ],
    serviceRestoration: { intent: "restore-paused-services", result: "restored" },
    interruption: "none",
    artifactPolicy: "current-plus-one-previous-or-failed",
    failure: null,
    recovery: { retryState: "not-needed", guidance: "none" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("D489 operation records", () => {
  test("parses bounded clone-seed provenance, freshness, hash, and lineage evidence", () => {
    expect(parseCloneSeedOperationRecord(seedRecord())).toMatchObject({
      kind: "clone-seed",
      status: "published",
      capture: { freshness: "fresh", artifactCount: 4 },
      source: { authority: "canonical-default", lineage: { appliedMigrationCount: 1 } },
    });
  });

  test("allows only the canonical empty-lineage count/index pair", () => {
    const empty = seedRecord();
    (empty["source"] as Record<string, unknown>)["lineage"] = {
      appliedMigrationCount: 0,
      lastAppliedIndex: -1,
      sha256: SHA256,
    };
    expect(parseCloneSeedOperationRecord(empty).source.lineage.lastAppliedIndex).toBe(-1);
    (empty["source"] as Record<string, unknown>)["lineage"] = {
      appliedMigrationCount: 0,
      lastAppliedIndex: 0,
      sha256: SHA256,
    };
    expect(() => parseCloneSeedOperationRecord(empty)).toThrow("inconsistent");
  });

  test("rejects malformed, stale, secret, connection, payload, and identifier evidence", () => {
    const malformed = seedRecord();
    malformed["completedStages"] = ["verified"];
    expect(() => parseCloneSeedOperationRecord(malformed)).toThrow("ordered stage prefix");
    expect(() => parseCloneSeedOperationRecord(seedRecord(), {
      now: new Date("2026-08-04T00:00:01.000Z"),
      maxAgeMs: 60_000,
    })).toThrow("stale");
    const secret = seedRecord();
    secret["credential"] = "operator-secret";
    expect(() => parseCloneSeedOperationRecord(secret)).toThrow("forbidden");
    const connection = seedRecord();
    (connection["source"] as Record<string, unknown>)["authority"] = "postgresql://user:password@host/db";
    expect(() => parseCloneSeedOperationRecord(connection)).toThrow("credential or connection");
    const identifier = seedRecord();
    identifier["checkpoint_id"] = "must-not-persist";
    expect(() => parseCloneSeedOperationRecord(identifier)).toThrow("forbidden");
    const nonStrictTime = seedRecord();
    nonStrictTime["startedAt"] = "2026-08-03T00:00:00Z";
    expect(() => parseCloneSeedOperationRecord(nonStrictTime)).toThrow("strict ISO");
    const normalizedImpossibleDate = seedRecord();
    normalizedImpossibleDate["startedAt"] = "2026-02-31T00:00:00.000Z";
    expect(() => parseCloneSeedOperationRecord(normalizedImpossibleDate)).toThrow("strict ISO");
    const futureCapture = seedRecord();
    (futureCapture["capture"] as Record<string, unknown>)["capturedAt"] = "2026-08-03T00:01:00.000Z";
    expect(() => parseCloneSeedOperationRecord(futureCapture, {
      now: new Date(TIME),
      maxAgeMs: 60_000,
    })).toThrow("future");
  });

  test("atomically replaces clone-seed evidence and keeps it owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-d489-operation-"));
    roots.push(root);
    const path = join(root, "clone-seed-operation.json");
    await writeCloneSeedOperationRecord(path, seedRecord());
    const replacement = seedRecord();
    (replacement["capture"] as Record<string, unknown>)["freshness"] = "reused";
    await writeCloneSeedOperationRecord(path, replacement);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ capture: { freshness: "reused" } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("requires seed status, failure code, and guidance to agree", () => {
    const failed = seedRecord();
    failed["status"] = "failed";
    failed["failure"] = { code: "seed-interrupted", guidance: "reuse-current-artifact" };
    failed["recovery"] = { retryState: "safe-to-retry", guidance: "reuse-current-artifact" };
    expect(() => parseCloneSeedOperationRecord(failed)).toThrow("cannot use the interrupted");

    const interrupted = seedRecord();
    interrupted["status"] = "interrupted";
    interrupted["failure"] = { code: "seed-capture-failed", guidance: "retry-capture" };
    interrupted["recovery"] = { retryState: "safe-to-retry", guidance: "retry-capture" };
    expect(() => parseCloneSeedOperationRecord(interrupted)).toThrow("interrupted failure code");

    const incompatibleGuidance = seedRecord();
    incompatibleGuidance["status"] = "failed";
    incompatibleGuidance["failure"] = { code: "seed-publication-failed", guidance: "retry-capture" };
    incompatibleGuidance["recovery"] = { retryState: "safe-to-retry", guidance: "retry-capture" };
    expect(() => parseCloneSeedOperationRecord(incompatibleGuidance)).toThrow("incompatible recovery guidance");
  });

  test("records semantic completion without falsely claiming physical reclamation", () => {
    const record = parseCheckpointMaintenanceOperationRecord(maintenanceRecord());
    expect(record.semanticCleanup.status).toBe("complete");
    expect(record.physicalReclamation).toEqual({
      intent: "not-requested",
      status: "not-requested",
      beforeRelationBytes: null,
      afterRelationBytes: null,
      reclaimedBytes: null,
    });
  });

  test("accepts payload-byte aggregates larger than composite logical bytes", () => {
    const record = maintenanceRecord();
    record["mode"] = "dry-run";
    record["consent"] = { apply: "not-requested", defaultDangerAcknowledgment: "not-required" };
    record["backup"] = { status: "not-required", manifestSha256: null, artifactCount: null, artifactBytes: null };
    record["metrics"] = {
      before: {
        checkpointRows: 1, writeRows: 1, blobRows: 1, totalRows: 3,
        checkpointLogicalBytes: 10, writeLogicalBytes: 10, blobLogicalBytes: 10,
        totalLogicalBytes: 30, blobPayloadBytes: 100,
      },
      after: null,
    };
    record["semanticCleanup"] = { status: "dry-run-projected" };
    record["completedStages"] = ["inventory-read"];
    record["serviceRestoration"] = { intent: "not-needed", result: "not-attempted" };
    expect(parseCheckpointMaintenanceOperationRecord(record).metrics.before.blobPayloadBytes).toBe(100);
  });

  test("requires explicit default consent and verified backup before semantic mutation", () => {
    const missingAcknowledgment = maintenanceRecord();
    (missingAcknowledgment["consent"] as Record<string, unknown>)["defaultDangerAcknowledgment"] = "not-required";
    expect(() => parseCheckpointMaintenanceOperationRecord(missingAcknowledgment)).toThrow("danger acknowledgment");
    const missingBackup = maintenanceRecord();
    missingBackup["backup"] = { status: "failed", manifestSha256: null, artifactCount: null, artifactBytes: null };
    expect(() => parseCheckpointMaintenanceOperationRecord(missingBackup)).toThrow("verified backup");
  });

  test("allows apply backup failure before mutation but rejects recovery/state inconsistencies", () => {
    const failedBeforeMutation = maintenanceRecord();
    failedBeforeMutation["status"] = "failed";
    failedBeforeMutation["backup"] = {
      status: "failed", manifestSha256: null, artifactCount: null, artifactBytes: null,
    };
    failedBeforeMutation["semanticCleanup"] = { status: "not-started" };
    failedBeforeMutation["completedStages"] = ["inventory-read", "consent-verified"];
    failedBeforeMutation["serviceRestoration"] = { intent: "not-needed", result: "not-attempted" };
    failedBeforeMutation["failure"] = {
      code: "backup-verification-failed", guidance: "retry-after-backup-verification",
    };
    failedBeforeMutation["recovery"] = {
      retryState: "safe-to-retry", guidance: "retry-after-backup-verification",
    };
    expect(parseCheckpointMaintenanceOperationRecord(failedBeforeMutation).backup.status).toBe("failed");

    const restoredWriterFailure = maintenanceRecord();
    restoredWriterFailure["status"] = "failed";
    restoredWriterFailure["metrics"] = { before: metrics(), after: null };
    restoredWriterFailure["semanticCleanup"] = { status: "not-started" };
    restoredWriterFailure["completedStages"] = [
      "inventory-read", "consent-verified", "backup-verified", "writers-quiesced", "services-restored",
    ];
    restoredWriterFailure["serviceRestoration"] = { intent: "restore-paused-services", result: "restored" };
    restoredWriterFailure["failure"] = {
      code: "writer-quiescence-failed", guidance: "retry-after-writer-quiescence",
    };
    restoredWriterFailure["recovery"] = {
      retryState: "safe-to-retry", guidance: "retry-after-writer-quiescence",
    };
    expect(parseCheckpointMaintenanceOperationRecord(restoredWriterFailure).recovery.retryState).toBe("safe-to-retry");

    const mismatchedRecovery = maintenanceRecord();
    mismatchedRecovery["status"] = "failed";
    mismatchedRecovery["failure"] = {
      code: "semantic-cleanup-failed", guidance: "restore-from-verified-backup",
    };
    mismatchedRecovery["recovery"] = { retryState: "safe-to-retry", guidance: "retry-capture" };
    expect(() => parseCheckpointMaintenanceOperationRecord(mismatchedRecovery)).toThrow("guidance");

    const incompatibleFailureGuidance = maintenanceRecord();
    incompatibleFailureGuidance["status"] = "failed";
    incompatibleFailureGuidance["failure"] = {
      code: "backup-verification-failed", guidance: "restore-from-verified-backup",
    };
    incompatibleFailureGuidance["recovery"] = {
      retryState: "safe-to-retry", guidance: "restore-from-verified-backup",
    };
    expect(() => parseCheckpointMaintenanceOperationRecord(incompatibleFailureGuidance)).toThrow("incompatible recovery guidance");

    const incompletePhysical = maintenanceRecord();
    (incompletePhysical["physicalReclamation"] as Record<string, unknown>)["intent"] = "explicit";
    (incompletePhysical["physicalReclamation"] as Record<string, unknown>)["status"] = "not-started";
    expect(() => parseCheckpointMaintenanceOperationRecord(incompletePhysical)).toThrow("rewrite completion");
  });

  test("accepts COMMIT-ambiguous semantic execution as interrupted manual re-inventory", () => {
    const ambiguous = maintenanceRecord();
    ambiguous["status"] = "interrupted";
    ambiguous["metrics"] = { before: metrics(), after: null };
    ambiguous["semanticCleanup"] = { status: "interrupted" };
    ambiguous["completedStages"] = [
      "inventory-read", "consent-verified", "backup-verified", "writers-quiesced", "services-restored",
    ];
    ambiguous["interruption"] = "during-semantic-cleanup";
    ambiguous["failure"] = {
      code: "operation-interrupted",
      guidance: "inspect-postgres-recovery-and-rerun-explicitly",
    };
    ambiguous["recovery"] = {
      retryState: "manual-recovery-required",
      guidance: "inspect-postgres-recovery-and-rerun-explicitly",
    };
    expect(parseCheckpointMaintenanceOperationRecord(ambiguous)).toMatchObject({
      status: "interrupted",
      metrics: { after: null },
      semanticCleanup: { status: "interrupted" },
      interruption: "during-semantic-cleanup",
      recovery: { retryState: "manual-recovery-required" },
    });
  });

  test("accepts committed semantic verification failure with manual inspection guidance", () => {
    const verificationFailure = maintenanceRecord();
    verificationFailure["status"] = "failed";
    verificationFailure["failure"] = {
      code: "semantic-verification-failed",
      guidance: "inspect-postgres-recovery-and-rerun-explicitly",
    };
    verificationFailure["recovery"] = {
      retryState: "manual-recovery-required",
      guidance: "inspect-postgres-recovery-and-rerun-explicitly",
    };
    expect(parseCheckpointMaintenanceOperationRecord(verificationFailure)).toMatchObject({
      status: "failed",
      metrics: { after: metrics(6, 60) },
      semanticCleanup: { status: "complete" },
      failure: { code: "semantic-verification-failed" },
      recovery: {
        retryState: "manual-recovery-required",
        guidance: "inspect-postgres-recovery-and-rerun-explicitly",
      },
    });
  });

  test("distinguishes physical interruption from semantic completion and records retry guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-d489-maintenance-"));
    roots.push(root);
    const path = join(root, "checkpoint-maintenance-operation.json");
    const interrupted = maintenanceRecord();
    interrupted["status"] = "interrupted";
    interrupted["physicalReclamation"] = {
      intent: "explicit",
      status: "interrupted",
      beforeRelationBytes: 1_000,
      afterRelationBytes: null,
      reclaimedBytes: null,
    };
    interrupted["completedStages"] = [
      "inventory-read", "consent-verified", "backup-verified", "writers-quiesced",
      "semantic-cleanup", "semantic-verified", "physical-reclamation", "services-restored",
    ];
    interrupted["interruption"] = "during-physical-reclamation";
    interrupted["failure"] = {
      code: "operation-interrupted",
      guidance: "inspect-postgres-recovery-and-rerun-explicitly",
    };
    interrupted["recovery"] = {
      retryState: "manual-recovery-required",
      guidance: "inspect-postgres-recovery-and-rerun-explicitly",
    };
    const record = await writeCheckpointMaintenanceOperationRecord(path, interrupted);
    expect(record.semanticCleanup.status).toBe("complete");
    expect(record.physicalReclamation.reclaimedBytes).toBeNull();
    expect(record.interruption).toBe("during-physical-reclamation");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("accepts measured running physical progress only after semantic verification", () => {
    const running = maintenanceRecord();
    running["status"] = "running";
    running["physicalReclamation"] = {
      intent: "explicit", status: "running",
      beforeRelationBytes: 10_000, afterRelationBytes: null, reclaimedBytes: null,
    };
    running["completedStages"] = [
      "inventory-read", "consent-verified", "backup-verified", "writers-quiesced",
      "semantic-cleanup", "semantic-verified", "physical-reclamation",
    ];
    running["serviceRestoration"] = { intent: "restore-paused-services", result: "not-attempted" };
    expect(parseCheckpointMaintenanceOperationRecord(running)).toMatchObject({
      status: "running",
      semanticCleanup: { status: "complete" },
      physicalReclamation: {
        intent: "explicit", status: "running", beforeRelationBytes: 10_000,
        afterRelationBytes: null, reclaimedBytes: null,
      },
    });
  });

  test("accepts physical completion only with exact measured reclaimed bytes", () => {
    const complete = maintenanceRecord();
    complete["physicalReclamation"] = {
      intent: "explicit", status: "complete",
      beforeRelationBytes: 10_000, afterRelationBytes: 4_000, reclaimedBytes: 6_000,
    };
    complete["completedStages"] = [
      "inventory-read", "consent-verified", "backup-verified", "writers-quiesced",
      "semantic-cleanup", "semantic-verified", "physical-reclamation", "services-restored",
    ];
    expect(parseCheckpointMaintenanceOperationRecord(complete).physicalReclamation).toEqual({
      intent: "explicit", status: "complete",
      beforeRelationBytes: 10_000, afterRelationBytes: 4_000, reclaimedBytes: 6_000,
    });
    (complete["physicalReclamation"] as Record<string, unknown>)["reclaimedBytes"] = 5_999;
    expect(() => parseCheckpointMaintenanceOperationRecord(complete)).toThrow("measured rewrite evidence");
  });
});
