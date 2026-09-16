import { describe, expect, test } from "bun:test";

import {
  createMaintenanceReceipt,
  parseMaintenanceReceipt,
  validateMaintenanceReceiptTransition,
  type MaintenanceReceipt,
} from "../../src";

const t0 = "2026-08-11T08:00:00.000Z";
const t1 = "2026-08-11T08:01:00.000Z";
const t2 = "2026-08-11T08:02:00.000Z";
const t3 = "2026-08-11T08:03:00.000Z";
const t4 = "2026-08-11T08:04:00.000Z";
const t5 = "2026-08-11T08:05:00.000Z";
const t6 = "2026-08-11T08:06:00.000Z";
const t7 = "2026-08-11T08:07:00.000Z";

const backupSet = {
  backups: [
    { kind: "application-postgres", backupId: "backup-app-1" },
    { kind: "logto-postgres", backupId: "backup-logto-1" },
    { kind: "server-volume", backupId: "backup-volume-1" },
  ],
  completedAt: t3,
} as const;

const portableExport = {
  objectId: "export-opaque-1",
  sha256: "a".repeat(64),
  completedAt: t4,
} as const;

const completedBackupWorkflows = [
  {
    operation: "backup-application-postgres",
    workflowId: "createVolumeInstanceBackup/6933dffa-acca-4079-98ab-99985c844f46",
    state: "complete",
    completedAt: t3,
  },
  {
    operation: "backup-logto-postgres",
    workflowId: "workflow-logto-1",
    state: "complete",
    completedAt: t3,
  },
  {
    operation: "backup-server-volume",
    workflowId: "workflow-volume-1",
    state: "complete",
    completedAt: t3,
  },
] as const;

const completedRestoreWorkflows = [
  {
    operation: "restore-application-postgres",
    workflowId: "restore-app-1",
    state: "complete",
    completedAt: t7,
  },
  {
    operation: "restore-logto-postgres",
    workflowId: "restore-logto-1",
    state: "complete",
    completedAt: t7,
  },
  {
    operation: "restore-server-volume",
    workflowId: "restore-volume-1",
    state: "complete",
    completedAt: t7,
  },
] as const;

const completedPortableExportWorkflow = {
  operation: "export-portable",
  workflowId: "export-job-1",
  state: "complete",
  completedAt: t4,
} as const;

const completedPortableRestoreWorkflow = {
  operation: "restore-portable",
  workflowId: "restore-job-1",
  state: "complete",
  completedAt: t7,
} as const;

function initial(): MaintenanceReceipt {
  return createMaintenanceReceipt({
    maintenanceId: "maintenance-488",
    launchId: "launch-488",
    backend: "railway",
    sourceReleaseId: "release-source",
    targetReleaseId: "release-target",
    now: t0,
  });
}

function advance(
  previous: MaintenanceReceipt,
  next: MaintenanceReceipt,
): MaintenanceReceipt {
  expect(validateMaintenanceReceiptTransition(previous, next)).toEqual({ ok: true });
  return next;
}

describe("maintenance receipt", () => {
  test("creates the canonical non-secret planned receipt", () => {
    expect(initial()).toEqual({
      schemaVersion: 1,
      maintenanceId: "maintenance-488",
      launchId: "launch-488",
      backend: "railway",
      revision: 0,
      stage: "planned",
      sourceReleaseId: "release-source",
      targetReleaseId: "release-target",
      createdAt: t0,
      updatedAt: t0,
    });
  });

  test("accepts the exact upgrade checkpoint sequence", () => {
    let receipt = initial();
    receipt = advance(receipt, {
      ...receipt,
      revision: 1,
      stage: "quiesced",
      updatedAt: t1,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 2,
      stage: "provider-backup",
      providerWorkflows: [{
        operation: "backup-application-postgres",
        workflowId: "createVolumeInstanceBackup/6933dffa-acca-4079-98ab-99985c844f46",
        state: "pending",
      }],
      updatedAt: t2,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 3,
      providerWorkflows: completedBackupWorkflows,
      backupSet,
      updatedAt: t3,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 4,
      stage: "portable-export",
      providerWorkflows: [
        ...completedBackupWorkflows,
        completedPortableExportWorkflow,
      ],
      portableExport,
      updatedAt: t4,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 5,
      stage: "release",
      release: { releaseId: "release-target", appliedAt: t5 },
      updatedAt: t5,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 6,
      stage: "migration",
      migration: { migrationId: "migration-1", completedAt: t6 },
      updatedAt: t6,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 7,
      stage: "verification",
      verification: { subject: "candidate", verifiedAt: t7 },
      updatedAt: t7,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 8,
      stage: "complete",
      updatedAt: "2026-08-11T08:08:00.000Z",
    });

    expect(parseMaintenanceReceipt(receipt)).toEqual({ ok: true, receipt });
  });

  test("accepts recovery only through a fresh restore target and explicit cutover", () => {
    const base: MaintenanceReceipt = {
      ...initial(),
      revision: 4,
      stage: "portable-export",
      providerWorkflows: [
        ...completedBackupWorkflows,
        completedPortableExportWorkflow,
      ],
      backupSet,
      portableExport,
      updatedAt: t4,
    };
    expect(parseMaintenanceReceipt(base).ok).toBe(true);

    let receipt = advance(base, {
      ...base,
      revision: 5,
      stage: "release",
      release: { releaseId: "release-target", appliedAt: t5 },
      updatedAt: t5,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 6,
      stage: "restore-target",
      restoreTarget: {
        projectId: "project-recovery",
        environmentId: "environment-recovery",
        createdAt: t6,
      },
      lastFailure: {
        operation: "migration",
        retryable: false,
        occurredAt: t6,
      },
      updatedAt: t6,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 7,
      stage: "restore",
      providerWorkflows: [
        ...completedBackupWorkflows,
        completedPortableExportWorkflow,
        completedPortableRestoreWorkflow,
      ],
      updatedAt: t7,
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 8,
      stage: "restore-verification",
      verification: {
        subject: "restore-target",
        verifiedAt: "2026-08-11T08:08:00.000Z",
      },
      updatedAt: "2026-08-11T08:08:00.000Z",
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 9,
      stage: "cutover",
      cutover: { committedAt: "2026-08-11T08:09:00.000Z" },
      updatedAt: "2026-08-11T08:09:00.000Z",
    });
    receipt = advance(receipt, {
      ...receipt,
      revision: 10,
      stage: "complete",
      updatedAt: "2026-08-11T08:10:00.000Z",
    });

    expect(parseMaintenanceReceipt(receipt)).toEqual({ ok: true, receipt });
  });

  test("retains same-provider three-volume restore compatibility", () => {
    const receipt: MaintenanceReceipt = {
      ...initial(),
      revision: 8,
      stage: "restore-verification",
      providerWorkflows: [
        ...completedBackupWorkflows,
        completedPortableExportWorkflow,
        ...completedRestoreWorkflows,
      ],
      backupSet,
      portableExport,
      restoreTarget: {
        projectId: "project-recovery",
        environmentId: "environment-recovery",
        createdAt: t6,
      },
      verification: { subject: "restore-target", verifiedAt: t7 },
      updatedAt: t7,
    };
    expect(parseMaintenanceReceipt(receipt)).toEqual({ ok: true, receipt });
  });

  test("rejects skipped stages, stale revisions, identity drift, and checkpoint rewrites", () => {
    const planned = initial();
    expect(validateMaintenanceReceiptTransition(planned, {
      ...planned,
      revision: 1,
      stage: "provider-backup",
      providerWorkflows: [{
        operation: "backup-application-postgres",
        workflowId: "workflow-app-1",
        state: "pending",
      }],
      updatedAt: t1,
    })).toMatchObject({ ok: false, path: "$.stage" });

    expect(validateMaintenanceReceiptTransition(planned, {
      ...planned,
      maintenanceId: "maintenance-other",
      revision: 1,
      updatedAt: t1,
    })).toMatchObject({ ok: false, path: "$.maintenanceId" });

    expect(validateMaintenanceReceiptTransition(planned, {
      ...planned,
      revision: 2,
      updatedAt: t1,
    })).toMatchObject({ ok: false, path: "$.revision" });

    const exported: MaintenanceReceipt = {
      ...planned,
      revision: 4,
      stage: "portable-export",
      providerWorkflows: [
        ...completedBackupWorkflows,
        completedPortableExportWorkflow,
      ],
      backupSet,
      portableExport,
      updatedAt: t4,
    };
    expect(validateMaintenanceReceiptTransition(exported, {
      ...exported,
      revision: 5,
      portableExport: { ...portableExport, sha256: "b".repeat(64) },
      updatedAt: t5,
    })).toMatchObject({ ok: false, path: "$.portableExport" });
  });

  test("rejects incomplete or duplicated backup sets and fake terminal states", () => {
    const candidate = {
      ...initial(),
      revision: 3,
      stage: "provider-backup",
      providerWorkflows: completedBackupWorkflows,
      backupSet,
      updatedAt: t3,
    };
    const missing = {
      ...candidate,
      backupSet: { ...backupSet, backups: backupSet.backups.slice(0, 2) },
    };
    expect(parseMaintenanceReceipt(missing)).toMatchObject({
      ok: false,
      code: "missing-checkpoint",
      path: "$.backupSet.backups",
    });

    const duplicated = {
      ...candidate,
      backupSet: {
        ...backupSet,
        backups: [backupSet.backups[0], backupSet.backups[0], backupSet.backups[2]],
      },
    };
    expect(parseMaintenanceReceipt(duplicated)).toMatchObject({
      ok: false,
      code: "duplicate-backup",
    });

    expect(parseMaintenanceReceipt({
      ...candidate,
      stage: "complete",
    })).toMatchObject({ ok: false, code: "missing-checkpoint" });

    expect(parseMaintenanceReceipt({
      ...candidate,
      cutover: { committedAt: t4 },
    })).toMatchObject({
      ok: false,
      code: "conflicting-checkpoint",
      path: "$.cutover",
    });

    expect(parseMaintenanceReceipt({
      ...candidate,
      stage: "portable-export",
      portableExport,
    })).toMatchObject({
      ok: false,
      code: "conflicting-checkpoint",
      path: "$.portableExport",
    });

    for (const [field, checkpoint] of [
      ["portableExport", portableExport],
      ["release", { releaseId: "release-target", appliedAt: t4 }],
      ["migration", { migrationId: "migration-1", completedAt: t4 }],
      ["restoreTarget", {
        projectId: "project-recovery",
        environmentId: "environment-recovery",
        createdAt: t4,
      }],
      ["verification", { subject: "candidate", verifiedAt: t4 }],
    ] as const) {
      expect(parseMaintenanceReceipt({ ...initial(), [field]: checkpoint })).toEqual({
        ok: false,
        code: "conflicting-checkpoint",
        path: `$.${field}`,
      });
    }
  });

  test("rejects secret material, locations, raw errors, and unknown fields", () => {
    for (const [field, value] of [
      ["bootstrapToken", "not-serialized"],
      ["url", "https://storage.invalid/export"],
      ["path", "/tmp/export"],
      ["error", "provider response"],
    ] as const) {
      expect(parseMaintenanceReceipt({ ...initial(), [field]: value })).toEqual({
        ok: false,
        code: "secret-material",
        path: `$.${field}`,
      });
    }

    expect(parseMaintenanceReceipt({ ...initial(), harmlessExtra: true })).toEqual({
      ok: false,
      code: "unknown-field",
      path: "$.harmlessExtra",
    });

    expect(parseMaintenanceReceipt({
      ...initial(),
      providerWorkflows: [{
        operation: "backup-application-postgres",
        workflowId: "createVolumeInstanceBackup/../provider-secret",
        state: "pending",
      }],
    })).toEqual({
      ok: false,
      code: "invalid-value",
      path: "$.providerWorkflows[0].workflowId",
    });
  });
});
