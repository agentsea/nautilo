import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { createMaintenanceReceipt, type MaintenanceReceipt } from "@nautilo/hosting";
import type { RailwayWholeManifestUpgradeCheckpoint } from "@nautilo/railway-hosting";

import { createRailwayPostUpgradeSourceState, readRailwayMaintenanceState, updateRailwayMaintenanceState, writeRailwayMaintenanceState, type RailwayMaintenanceState, type RailwayPortableOperationState } from "../../src/lib/railway-maintenance-state";
import { runRailwayUpgradeFromState, type RailwayUpgradeActivationStageContext, type RailwayUpgradeExportStageContext, type RailwayUpgradeRestoreStageContext, type RailwayUpgradeStageAdapters } from "../../src/lib/railway-upgrade-runner";

const now = "2026-08-12T08:00:00.000Z";
const operationId = "maintenance-1";
const digest = "a".repeat(64);
const image = (name: string) => `registry.example.test/${name}@sha256:${digest}`;

function advance(receipt: MaintenanceReceipt, stage: MaintenanceReceipt["stage"], more: Partial<MaintenanceReceipt> = {}): MaintenanceReceipt {
  return { ...receipt, ...more, revision: receipt.revision + 1, stage, updatedAt: now };
}
function launch(launchId: string, releaseId: string, project: string, environment: string, restore = false): RailwayMaintenanceState["sourceLaunchState"] {
  return { schemaVersion: 1, launchId, releaseId, providers: [], target: { workspaceId: "workspace", projectName: project, environmentName: "production" },
    reconcile: { receipt: { schemaVersion: 1, launchId, backend: "railway", revision: 1, stage: "authorized", cleanup: { state: "not-required" }, createdAt: now, updatedAt: now, resources: [
      { kind: "railway.project", id: project, name: project }, { kind: "railway.environment", id: environment, name: "production" },
      { kind: "railway.service", id: `${launchId}-logto`, name: "logto" }, { kind: "railway.service", id: `${launchId}-nautilo`, name: "nautilo-server" },
      { kind: "railway.domain", id: `${launchId}-domain`, name: "nautilo-public" },
      ...(!restore ? ["app-postgres", "logto-postgres", "logto", "nautilo-server"].map((name) => ({ kind: "railway.deployment", id: `old-${name}-deployment`, name })) : []),
      ...(restore ? [{ kind: "railway.domain", id: `${launchId}-logto-domain`, name: "logto-public" }] : []),
    ] } } };
}
function initial(): RailwayMaintenanceState {
  return { schemaVersion: 1, revision: 0, maintenanceId: operationId, sourceLaunchId: "launch-source", authorityGenerationId: "authority-1",
    sourceManagedWorkbenchHostname: "source.example.test", sourceLaunchState: launch("launch-source", "release-source", "project-source", "environment-source"),
    maintenanceReceipt: createMaintenanceReceipt({ maintenanceId: operationId, launchId: "launch-source", backend: "railway", sourceReleaseId: "release-source", targetReleaseId: "release-target", now }) };
}
function targetPreparation(): RailwayMaintenanceState["sourceLaunchState"] {
  const state = launch("launch-restore", "release-target", "project-restore", "environment-restore", true);
  return { ...state, reconcile: { receipt: { ...state.reconcile.receipt, resources: [] } } };
}
function completedTarget(): RailwayMaintenanceState["sourceLaunchState"] {
  const state = launch("launch-restore", "release-target", "project-restore", "environment-restore", true);
  return { ...state, reconcile: { receipt: { ...state.reconcile.receipt, revision: 4, stage: "claimable", claimableAt: now, resources: [
    ...state.reconcile.receipt.resources,
    ...["app-postgres", "logto-postgres"].flatMap((name) => [
      { kind: "railway.service", id: `restore-${name}-service`, name },
      { kind: "railway.variable-collection", id: `environment-restore:restore-${name}-service`, name: `variables-${name}` },
      { kind: "railway.service-image", id: `restore-${name}-service`, name },
      { kind: "railway.deployment", id: `restore-${name}-deployment`, name },
    ]),
    { kind: "railway.volume", id: "restore-app-postgres-volume", name: "app-postgres-data" },
    { kind: "railway.volume", id: "restore-logto-postgres-volume", name: "logto-postgres-data" },
  ] } }, databaseBootstrap: { schemaVersion: 1, projectId: "project-restore", environmentId: "environment-restore",
    serviceName: "nautilo-bootstrap", imageDigest: `sha256:${digest}`, serviceId: "restore-bootstrap-service",
    variablesApplied: true, deploymentId: "restore-bootstrap-deployment", successfulDeploymentId: "restore-bootstrap-deployment" } };
}
function transfer(direction: "export" | "restore", state: "prepared" | "started" = "prepared"): RailwayPortableOperationState {
  const restoring = direction === "restore"; const operation = restoring ? "restore-1" : "export-1"; const objectId = "object-1";
  const target = { state, attempt: 1, operationId: operation, direction, objectId, projectId: restoring ? "project-restore" : "project-source",
    environmentId: restoring ? "environment-restore" : "environment-source", serviceId: restoring ? "launch-restore-nautilo" : "launch-source-nautilo",
    image: image("nautilo"), sourceReleaseId: "release-source", command: `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts ${direction} ${operation} ${objectId}`,
    startEffect: "connect" as const, ...(state === "started" ? { jobId: `${direction}-job` } : {}) };
  return { target } as RailwayPortableOperationState;
}
async function finishCleanup(context: Pick<RailwayUpgradeExportStageContext, "loadState" | "persistPortableExport">
  | Pick<RailwayUpgradeRestoreStageContext, "loadState" | "persistPortableRestore">, slot: "export" | "restore"): Promise<void> {
  const state = await context.loadState(); const value = slot === "export" ? state.portableExport! : state.portableRestore!; const target = value.target;
  const write = slot === "export"
    ? (context as Pick<RailwayUpgradeExportStageContext, "persistPortableExport">).persistPortableExport
    : (context as Pick<RailwayUpgradeRestoreStageContext, "persistPortableRestore">).persistPortableRestore;
  const base = { schemaVersion: 1 as const, projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId,
    operationId: target.operationId, imageDigest: digest, commandSha256: createHash("sha256").update(target.command).digest("hex") };
  await write({ target, cleanup: { ...base, state: "deleting", completedDeletes: 0 } });
  for (let count = 0; count < 12; count += 1) {
    await write({ target, cleanup: { ...base, state: "delete-pending", completedDeletes: count, deleteIndex: count } });
    await write({ target, cleanup: { ...base, state: "deleting", completedDeletes: count + 1 } });
  }
  await write({ target, cleanup: { ...base, state: "reset-pending", completedDeletes: 12 } });
  await write({ target, cleanup: { ...base, state: "complete", completedDeletes: 12 } });
}
function candidateBase(): Omit<RailwayWholeManifestUpgradeCheckpoint, "stage" | "completedDeployments"> {
  const names = ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"] as const;
  return { schemaVersion: 1, releaseId: "release-target", projectId: "project-source", environmentId: "environment-source", migrationId: "migration-1", migrationExecutionId: "execution-1",
    services: names.map((name) => ({ name, serviceId: `${name}-service`, oldImage: image(`${name}-old`), newImage: image(name), kind: name === "logto-seed" ? "run-once" : "long-lived" })) };
}
function candidateChain(): RailwayWholeManifestUpgradeCheckpoint[] {
  const b = candidateBase(); const chain: RailwayWholeManifestUpgradeCheckpoint[] = []; let completedDeployments: RailwayWholeManifestUpgradeCheckpoint["completedDeployments"] = [];
  const add = (stage: RailwayWholeManifestUpgradeCheckpoint["stage"], extra: Partial<RailwayWholeManifestUpgradeCheckpoint> = {}, withMigration = false) => chain.push({
    ...b, completedDeployments, stage, ...(withMigration ? { migrationDeploymentId: "migration-deployment" } : {}), ...extra,
  });
  add("verify-old");
  const source = (index: number) => {
    const migrated = index >= 2;
    add("source-ready", { serviceIndex: index }, migrated); add("source-pending", { serviceIndex: index }, migrated); add("source-updated", { serviceIndex: index }, migrated);
    if (index !== 2) {
      add("start-ready", { serviceIndex: index, attempt: 1 }, migrated); add("start-pending", { serviceIndex: index, attempt: 1, baselineDeploymentIds: [] }, migrated);
      add("started", { serviceIndex: index, attempt: 1, deploymentId: `deployment-${index}` }, migrated);
      const service = b.services[index]!; completedDeployments = [...completedDeployments, { name: service.name as "app-postgres" | "logto-postgres" | "logto" | "nautilo-server", serviceId: service.serviceId, deploymentId: `deployment-${index}` }];
    }
  };
  source(0); source(1); add("migration-ready"); add("migration-source-pending"); add("migration-command-ready");
  add("migration-command-pending"); add("migration-start-ready"); add("migration-start-pending", { baselineDeploymentIds: [] });
  add("migration-started", {}, true); add("migration-reset-ready", {}, true); add("migration-reset-pending", {}, true); add("migration-proven", {}, true);
  source(2); source(3); source(4); add("verify-final", {}, true); add("complete", {}, true); return chain;
}
function candidateComplete(): RailwayWholeManifestUpgradeCheckpoint { return candidateChain().at(-1)!; }
function candidateAmbiguous(): RailwayWholeManifestUpgradeCheckpoint {
  const pending = candidateChain().find((entry) => entry.stage === "start-pending")!;
  return { ...pending, stage: "start-ambiguous", ambiguousDeploymentIds: ["ambiguous-deployment-1", "ambiguous-deployment-2"] };
}
function candidateUnresolved(): RailwayWholeManifestUpgradeCheckpoint {
  const pending = candidateChain().find((entry) => entry.stage === "migration-start-pending")!;
  return { ...pending, stage: "migration-start-unresolved", observations: 3 };
}
function receiptAtStage(stage: "portable-export" | "migration" | "verification" | "restore-verification") {
  const base = initial().maintenanceReceipt;
  const workflows = [
    { operation: "backup-application-postgres" as const, workflowId: "backup-application-postgres", state: "complete" as const, completedAt: now },
    { operation: "backup-logto-postgres" as const, workflowId: "backup-logto-postgres", state: "complete" as const, completedAt: now },
    { operation: "backup-server-volume" as const, workflowId: "backup-server-volume", state: "complete" as const, completedAt: now },
    { operation: "export-portable" as const, workflowId: "export-job", state: "complete" as const, completedAt: now },
  ];
  const receipt: MaintenanceReceipt = { ...base, revision: 4, stage: "portable-export", providerWorkflows: workflows,
    backupSet: { backups: [
      { kind: "application-postgres", backupId: "backup-application-postgres" }, { kind: "logto-postgres", backupId: "backup-logto-postgres" },
      { kind: "server-volume", backupId: "backup-server-volume" },
    ], completedAt: now }, portableExport: { objectId: "object-1", sha256: "b".repeat(64), completedAt: now } };
  if (stage === "portable-export") return receipt;
  const migrated: MaintenanceReceipt = { ...receipt, revision: 6, stage: "migration", release: { releaseId: "release-target", appliedAt: now }, migration: { migrationId: "migration-1", completedAt: now } };
  if (stage === "migration") return migrated;
  if (stage === "verification") return { ...migrated, revision: 7, stage, verification: { subject: "candidate", verifiedAt: now } } satisfies MaintenanceReceipt;
  return { ...receipt, revision: 8, stage, providerWorkflows: [...workflows, { operation: "restore-portable", workflowId: "restore-job", state: "complete", completedAt: now }],
    restoreTarget: { projectId: "project-restore", environmentId: "environment-restore", createdAt: now }, verification: { subject: "restore-target", verifiedAt: now } } satisfies MaintenanceReceipt;
}
function cleaned(direction: "export" | "restore"): RailwayPortableOperationState {
  const value = transfer(direction, "started"); const target = value.target;
  return { target, cleanup: { schemaVersion: 1, projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId,
    operationId: target.operationId, imageDigest: digest, commandSha256: createHash("sha256").update(target.command).digest("hex"), state: "complete", completedDeletes: 12 } };
}
function verifiedSourceState(stage: "migration" | "verification"): RailwayMaintenanceState {
  const value = initial(); const candidate = candidateComplete();
  return { ...value, maintenanceReceipt: receiptAtStage(stage), candidateUpgrade: candidate,
    postUpgradeSourceState: createRailwayPostUpgradeSourceState(value.sourceLaunchState, candidate, "release-target", now) };
}
function restoredVerifiedState(): RailwayMaintenanceState {
  const value = initial(); const target = completedTarget(); const exact = (serviceId: string) => ({ projectId: "project-restore", environmentId: "environment-restore", serviceId,
    image: image("nautilo"), effect: "connect" as const, startEffect: "connect" as const, attempt: 1, state: "complete" as const, jobId: `${serviceId}-deployment` });
  return { ...value, maintenanceReceipt: receiptAtStage("restore-verification"), candidateUpgrade: candidateAmbiguous(), restoreTargetState: target,
    targetNautiloHostname: "restore.example.test", targetLogtoHostname: "restore-logto.example.test", portableRestore: cleaned("restore"),
    logtoActivation: exact("launch-restore-logto"),
    restoredLogtoBootstrap: { lifecycle: { schemaVersion: 1, projectId: "project-restore", environmentId: "environment-restore", serviceName: "nautilo-bootstrap", imageDigest: `sha256:${digest}`,
      serviceId: "bootstrap-service", variablesApplied: true, deploymentId: "bootstrap-deployment", successfulDeploymentId: "bootstrap-deployment", handoffDomainId: "bootstrap-domain", handoffDomain: "bootstrap.example.test", handoffApplied: true }, exactActivation: exact("bootstrap-service") },
    nautiloActivation: exact("launch-restore-nautilo"),
    restoredTargetActivation: { schemaVersion: 1, releaseId: "release-target", projectId: "project-restore", environmentId: "environment-restore", logtoServiceId: "launch-restore-logto", nautiloServiceId: "launch-restore-nautilo",
      logtoImageDigest: digest, nautiloImageDigest: digest, bootstrapImageDigest: digest, authorityGenerationId: "authority-1", intentSha256: "d".repeat(64), effectSha256: "e".repeat(64), stage: "complete", logtoDeploymentId: "logto-deployment", nautiloDeploymentId: "nautilo-deployment" } };
}
async function persistActivationProof(context: RailwayUpgradeActivationStageContext, root: string, path: string): Promise<void> {
  const before = await context.loadState(); const target = before.restoreTargetState!;
  const exact = (serviceId: string) => ({ projectId: "project-restore", environmentId: "environment-restore", serviceId, image: image("nautilo"), effect: "connect" as const, startEffect: "connect" as const, attempt: 1, state: "complete" as const, jobId: `${serviceId}-deployment` });
  // This injected seam models the committed direct runner: its proof is written through the composite store, never returned as a boolean.
  await updateRailwayMaintenanceState(root, path, { expectedRevision: before.revision }, (state) => ({ ...state, revision: state.revision + 1,
    logtoActivation: exact("launch-restore-logto"),
    restoredLogtoBootstrap: { lifecycle: { schemaVersion: 1, projectId: "project-restore", environmentId: "environment-restore", serviceName: "nautilo-bootstrap", imageDigest: `sha256:${digest}`,
      serviceId: "bootstrap-service", variablesApplied: true, deploymentId: "bootstrap-deployment", successfulDeploymentId: "bootstrap-deployment", handoffDomainId: "bootstrap-domain", handoffDomain: "bootstrap.example.test", handoffApplied: true }, exactActivation: exact("bootstrap-service") },
    nautiloActivation: exact("launch-restore-nautilo"),
    restoredTargetActivation: { schemaVersion: 1, releaseId: "release-target", projectId: "project-restore", environmentId: "environment-restore", logtoServiceId: "launch-restore-logto", nautiloServiceId: "launch-restore-nautilo",
      logtoImageDigest: digest, nautiloImageDigest: digest, bootstrapImageDigest: digest, authorityGenerationId: "authority-1", intentSha256: "d".repeat(64), effectSha256: "e".repeat(64), stage: "complete", logtoDeploymentId: "logto-deployment", nautiloDeploymentId: "nautilo-deployment" },
  }));
  expect(target.launchId).toBe("launch-restore"); await context.assertRestoredActivationComplete();
}

function adapters(events: string[], fallback = false, transientVerification = false,
  activationRunner: (context: RailwayUpgradeActivationStageContext) => Promise<void> = async () => { throw new Error("activation runner not injected"); }): RailwayUpgradeStageAdapters {
  return {
    quiesce: async (c) => { events.push("quiesce"); await c.persistReceipt(advance((await c.loadState()).maintenanceReceipt, "quiesced")); return { outcome: "complete" }; },
    backupExactlyThree: async (c) => { events.push("backup"); const receipt = (await c.loadState()).maintenanceReceipt; const kinds = ["application-postgres", "logto-postgres", "server-volume"] as const;
      await c.persistReceipt(advance(receipt, "provider-backup", { providerWorkflows: kinds.map((kind) => ({ operation: `backup-${kind}` as const, workflowId: `backup-${kind}`, state: "complete", completedAt: now })), backupSet: { backups: kinds.map((kind) => ({ kind, backupId: `backup-${kind}` })), completedAt: now } })); return { outcome: "complete" }; },
    exportPortable: async (c) => { events.push("export"); if ((await c.loadState()).portableExport === undefined) await c.persistPortableExport(transfer("export"));
      await c.persistPortableExport(transfer("export", "started")); const receipt = (await c.loadState()).maintenanceReceipt;
      await c.persistReceipt(advance(receipt, "portable-export", { providerWorkflows: [...receipt.providerWorkflows!, { operation: "export-portable", workflowId: "export-job", state: "complete", completedAt: now }], portableExport: { objectId: "object-1", sha256: "b".repeat(64), completedAt: now } })); return { outcome: "complete" }; },
    cleanupSourceMaintenance: async (c) => { events.push("source-cleanup"); await finishCleanup(c, "export"); return { outcome: "complete" }; },
    candidateUpgrade: async (c) => { events.push("candidate"); const chain = candidateChain();
      const intended = fallback ? chain.slice(0, chain.findIndex((entry) => entry.stage === "started") + 1) : chain;
      for (const checkpoint of intended) if (JSON.stringify((await c.loadState()).candidateUpgrade) !== JSON.stringify(checkpoint)) await c.persistCandidateUpgrade(checkpoint);
      if (fallback) return { outcome: "terminal-failure" };
      const state = await c.loadState(); await c.persistPostUpgradeSourceState(createRailwayPostUpgradeSourceState(state.sourceLaunchState, state.candidateUpgrade!, state.maintenanceReceipt.targetReleaseId, now)); return { outcome: "complete" }; },
    verifyCandidateHttps: async (c) => { events.push("verify-candidate"); if (transientVerification) throw new Error("transient"); const receipt = (await c.loadState()).maintenanceReceipt;
      await c.persistReceipt(advance(receipt, "verification", { verification: { subject: "candidate", verifiedAt: now } })); return { outcome: "complete" }; },
    prepareFreshRestoreTarget: async (c) => { events.push("prepare-restore"); if ((await c.loadState()).restoreTargetPreparation === undefined) await c.persistRestoreTargetPreparation(targetPreparation());
      if ((await c.loadState()).restoreTargetPreparation!.reconcile.receipt.resources.length === 0) {
        const complete = completedTarget(); const receipt = complete.reconcile.receipt;
        const { claimableAt: _claimableAt, ...provisioningReceipt } = receipt;
        const { databaseBootstrap: bootstrap, ...withoutBootstrap } = complete;
        if (bootstrap === undefined) throw new Error("missing bootstrap fixture");
        await c.persistRestoreTargetPreparation({ ...withoutBootstrap, reconcile: { receipt: {
          ...provisioningReceipt, revision: 2, stage: "provisioning",
        } } });
        await c.persistRestoreTargetPreparation({ ...(await c.loadState()).restoreTargetPreparation!, databaseBootstrap: {
          schemaVersion: 1, projectId: bootstrap.projectId, environmentId: bootstrap.environmentId,
          serviceName: bootstrap.serviceName, imageDigest: bootstrap.imageDigest, serviceId: bootstrap.serviceId,
        } });
        await c.persistRestoreTargetPreparation({ ...(await c.loadState()).restoreTargetPreparation!, databaseBootstrap: {
          ...(await c.loadState()).restoreTargetPreparation!.databaseBootstrap!, variablesApplied: true,
        } });
        await c.persistRestoreTargetPreparation({ ...(await c.loadState()).restoreTargetPreparation!, databaseBootstrap: {
          ...(await c.loadState()).restoreTargetPreparation!.databaseBootstrap!, deploymentId: bootstrap.deploymentId,
        } });
        await c.persistRestoreTargetPreparation({ ...(await c.loadState()).restoreTargetPreparation!, databaseBootstrap: bootstrap });
        await c.persistRestoreTargetPreparation({ ...(await c.loadState()).restoreTargetPreparation!, reconcile: { receipt: {
          ...(await c.loadState()).restoreTargetPreparation!.reconcile.receipt, revision: 3, stage: "bootstrapping",
        } } });
        await c.persistRestoreTargetPreparation(complete);
      }
      await c.completeRestoreTarget({ targetNautiloHostname: "restore.example.test", targetLogtoHostname: "restore-logto.example.test" }); return { outcome: "complete" }; },
    restorePortable: async (c) => { events.push("restore"); if ((await c.loadState()).portableRestore === undefined) await c.persistPortableRestore(transfer("restore"));
      await c.persistPortableRestore(transfer("restore", "started")); const receipt = (await c.loadState()).maintenanceReceipt;
      await c.persistReceipt(advance(receipt, "restore", { providerWorkflows: [...receipt.providerWorkflows!, { operation: "restore-portable", workflowId: "restore-job", state: "complete", completedAt: now }] })); return { outcome: "complete" }; },
    cleanupRestoreMaintenance: async (c) => { events.push("restore-cleanup"); await finishCleanup(c, "restore"); return { outcome: "complete" }; },
    activateRestoredTarget: async (c) => { events.push("activate"); await activationRunner(c); return { outcome: "complete" }; },
    verifyRestoredTargetHttps: async (c) => { events.push("verify-restore"); const receipt = (await c.loadState()).maintenanceReceipt;
      await c.persistReceipt(advance(receipt, "restore-verification", { verification: { subject: "restore-target", verifiedAt: now } })); return { outcome: "complete" }; },
  };
}
async function fixture(fallback = false, transient = false) {
  const root = await mkdtemp(join(tmpdir(), "nautilo-upgrade-runner-")); const path = join(root, "maintenance"); await writeRailwayMaintenanceState(root, path, initial());
  const events: string[] = []; const stages = adapters(events, fallback, transient, (context) => persistActivationProof(context, root, path));
  const run = () => runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId, authorityGenerationId: "authority-1", adapters: stages, now: () => now });
  return { root, path, events, run };
}
describe("Railway upgrade coordinator", () => {
  test("resumes an in-progress provider backup before portable export", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-upgrade-runner-")); const path = join(root, "maintenance");
    const value = initial();
    await writeRailwayMaintenanceState(root, path, { ...value, maintenanceReceipt: {
      ...value.maintenanceReceipt,
      revision: 2,
      stage: "provider-backup",
      providerWorkflows: [{
        operation: "backup-application-postgres",
        workflowId: "backup-application-postgres",
        state: "pending",
      }],
      updatedAt: now,
    } });
    const events: string[] = [];
    try {
      expect(await runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId,
        authorityGenerationId: "authority-1", adapters: adapters(events), now: () => now })).toEqual({
        outcome: "pending",
        stage: "provider-backup",
      });
      expect(events).toEqual(["backup"]);
      expect((await readRailwayMaintenanceState(root, path))?.maintenanceReceipt.backupSet?.backups).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("durably reports and retains a redacted terminal stage failure without re-running effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-upgrade-runner-terminal-")); const path = join(root, "maintenance");
    try {
      await writeRailwayMaintenanceState(root, path, initial()); const events: string[] = []; const stages = adapters(events);
      const terminalStages: RailwayUpgradeStageAdapters = { ...stages,
        quiesce: async () => { events.push("terminal-quiesce"); return { outcome: "terminal-failure" }; } };
      const run = () => runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId, authorityGenerationId: "authority-1", adapters: terminalStages, now: () => now });
      expect(await run()).toEqual({ outcome: "terminal-failure", stage: "planned" });
      expect(await run()).toEqual({ outcome: "terminal-failure", stage: "planned" });
      expect(events).toEqual(["terminal-quiesce"]);
      expect((await readRailwayMaintenanceState(root, path))?.maintenanceReceipt.lastFailure).toEqual({ operation: "quiesce", retryable: false, occurredAt: now });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("does not accept adapter completion without reloaded durable proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-upgrade-runner-fake-")); const path = join(root, "maintenance");
    try {
      await writeRailwayMaintenanceState(root, path, initial());
      const complete = async () => ({ outcome: "complete" as const });
      const fake: RailwayUpgradeStageAdapters = { quiesce: complete, backupExactlyThree: complete, exportPortable: complete,
        cleanupSourceMaintenance: complete, candidateUpgrade: complete, verifyCandidateHttps: complete, prepareFreshRestoreTarget: complete,
        restorePortable: complete, cleanupRestoreMaintenance: complete, activateRestoredTarget: complete, verifyRestoredTargetHttps: complete };
      expect(await runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId, authorityGenerationId: "authority-1", adapters: fake, now: () => now }))
        .toEqual({ outcome: "pending", stage: "planned" });
      expect((await readRailwayMaintenanceState(root, path))?.revision).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("resumes a started portable export to durable completion before cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-upgrade-runner-export-resume-")); const path = join(root, "maintenance");
    try {
      const receipt = receiptAtStage("portable-export");
      const incompleteReceipt: MaintenanceReceipt = {
        ...receipt,
        portableExport: undefined,
        providerWorkflows: receipt.providerWorkflows?.filter((workflow) => workflow.operation !== "export-portable"),
      };
      await writeRailwayMaintenanceState(root, path, {
        ...initial(), maintenanceReceipt: incompleteReceipt, portableExport: transfer("export", "started"),
      });
      const events: string[] = []; const stages = adapters(events);
      const run = () => runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId,
        authorityGenerationId: "authority-1", adapters: stages, now: () => now });
      expect(await run()).toEqual({ outcome: "pending", stage: "portable-export" });
      expect(events).toEqual(["export"]);
      expect((await readRailwayMaintenanceState(root, path))?.maintenanceReceipt.portableExport).toBeDefined();
      expect(await run()).toEqual({ outcome: "pending", stage: "portable-export" });
      expect(events).toEqual(["export", "source-cleanup"]);
      expect((await readRailwayMaintenanceState(root, path))?.portableExport?.cleanup?.state).toBe("complete");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);
  test("repairs a legacy terminalized descriptor observation only through exact export proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-upgrade-runner-export-observation-repair-")); const path = join(root, "maintenance");
    try {
      const providerReceipt = receiptAtStage("portable-export");
      const pendingWorkflow = providerReceipt.providerWorkflows!.map((workflow) => workflow.operation === "export-portable"
        ? { operation: workflow.operation, workflowId: workflow.workflowId, state: "pending" as const }
        : workflow);
      const legacyReceipt: MaintenanceReceipt = {
        ...providerReceipt,
        stage: "provider-backup",
        portableExport: undefined,
        providerWorkflows: pendingWorkflow,
        lastFailure: { operation: "portable-export", retryable: false, occurredAt: now },
      };
      await writeRailwayMaintenanceState(root, path, {
        ...initial(), maintenanceReceipt: legacyReceipt, portableExport: transfer("export", "started"),
      });
      const events: string[] = [];
      const base = adapters(events);
      const repaired: RailwayUpgradeStageAdapters = { ...base, exportPortable: async (context) => {
        events.push("repair-export");
        const receipt = (await context.loadState()).maintenanceReceipt;
        await context.persistReceipt(advance(receipt, "portable-export", {
          providerWorkflows: receipt.providerWorkflows!.map((workflow) => workflow.operation === "export-portable"
            ? { ...workflow, state: "complete" as const, completedAt: now } : workflow),
          portableExport: { objectId: "object-1", sha256: "b".repeat(64), completedAt: now },
          lastFailure: undefined,
        }));
        return { outcome: "complete" };
      } };
      expect(await runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId,
        authorityGenerationId: "authority-1", adapters: repaired, now: () => now }))
        .toEqual({ outcome: "pending", stage: "portable-export" });
      const current = await readRailwayMaintenanceState(root, path);
      expect(events).toEqual(["repair-export"]);
      expect(current?.maintenanceReceipt.lastFailure).toBeUndefined();
      expect(current?.maintenanceReceipt.portableExport?.sha256).toBe("b".repeat(64));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("uses exact durable proofs and atomically selects a complete post-upgrade source projection", async () => {
    const value = await fixture(); try { await rm(value.root, { recursive: true, force: true }); await writeRailwayMaintenanceState(value.root, value.path, verifiedSourceState("verification"));
      expect(await value.run()).toEqual({ outcome: "complete" }); const state = await readRailwayMaintenanceState(value.root, value.path);
      expect(state?.activeLaunch).toMatchObject({ kind: "source", releaseId: "release-target" }); expect(state?.postUpgradeSourceState?.releaseId).toBe("release-target");
      expect(state?.postUpgradeSourceState?.reconcile.receipt.resources.filter((item) => item.kind === "railway.deployment")).toEqual([
        { kind: "railway.deployment", id: "deployment-0", name: "app-postgres" }, { kind: "railway.deployment", id: "deployment-1", name: "logto-postgres" },
        { kind: "railway.deployment", id: "deployment-3", name: "logto" }, { kind: "railway.deployment", id: "deployment-4", name: "nautilo-server" },
      ]);
      expect(value.events).toEqual([]); expect(state?.maintenanceReceipt.stage).toBe("complete");
    } finally { await rm(value.root, { recursive: true, force: true }); } });
  test("terminal candidate failure creates one retained target, proves activation, and atomically owns source teardown", async () => {
    const value = await fixture(true); try { await rm(value.root, { recursive: true, force: true }); await writeRailwayMaintenanceState(value.root, value.path, {
      ...initial(), maintenanceReceipt: receiptAtStage("portable-export"), portableExport: cleaned("export"), candidateUpgrade: candidateAmbiguous(),
    });
      expect(await value.run()).toEqual({ outcome: "pending", stage: "portable-export" });
      expect(value.events).toEqual([]);
      expect(await value.run()).toEqual({ outcome: "pending", stage: "restore-target" });
      expect(value.events.filter((event) => event === "prepare-restore")).toHaveLength(1);
      await rm(value.root, { recursive: true, force: true }); await writeRailwayMaintenanceState(value.root, value.path, restoredVerifiedState());
      expect(await value.run()).toEqual({ outcome: "pending", stage: "cutover" }); expect(await value.run()).toEqual({ outcome: "complete" });
      const state = await readRailwayMaintenanceState(value.root, value.path);
      expect(state?.restoredTargetActivation?.stage).toBe("complete"); expect(state?.sourceTeardown?.receipt.launchId).toBe("launch-source"); expect(state?.activeLaunch?.kind).toBe("restore-target");
      expect(state?.sourceTeardown?.receipt.resources).toContainEqual({ kind: "railway.deployment", id: "ambiguous-deployment-1", name: "app-postgres-ambiguous-0" });
    } finally { await rm(value.root, { recursive: true, force: true }); } });
  test("fresh resume routes durable unresolved migration start to fallback without invoking candidate effects", async () => {
    const value = await fixture(true); try {
      await rm(value.root, { recursive: true, force: true });
      await writeRailwayMaintenanceState(value.root, value.path, {
        ...initial(), maintenanceReceipt: receiptAtStage("portable-export"), portableExport: cleaned("export"),
        candidateUpgrade: candidateUnresolved(),
      });
      expect(await value.run()).toEqual({ outcome: "pending", stage: "portable-export" });
      const state = await readRailwayMaintenanceState(value.root, value.path);
      expect(state?.fallbackDecision?.reason).toBe("candidate-upgrade");
      expect(state?.candidateUpgrade).toMatchObject({ stage: "migration-start-unresolved", observations: 3, baselineDeploymentIds: [] });
      expect(value.events).toEqual([]);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  test("transient verification exception remains pending without fallback", async () => {
    const value = await fixture(false, true); try { await rm(value.root, { recursive: true, force: true }); await writeRailwayMaintenanceState(value.root, value.path, verifiedSourceState("migration"));
      expect(await value.run()).toEqual({ outcome: "pending", stage: "migration" }); const state = await readRailwayMaintenanceState(value.root, value.path);
      expect(state?.maintenanceReceipt.stage).toBe("migration"); expect(state?.restoreTargetState).toBeUndefined(); expect(value.events).not.toContain("prepare-restore");
    } finally { await rm(value.root, { recursive: true, force: true }); } });
  test("fresh resume retains the fallback cause and never reruns effects after terminal target preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-upgrade-runner-preparation-terminal-")); const path = join(root, "maintenance");
    try {
      await writeRailwayMaintenanceState(root, path, verifiedSourceState("migration"));
      const firstEvents: string[] = []; const first = adapters(firstEvents);
      const terminal: RailwayUpgradeStageAdapters = { ...first,
        verifyCandidateHttps: async () => { firstEvents.push("terminal-verification"); return { outcome: "terminal-failure" }; },
        prepareFreshRestoreTarget: async () => { firstEvents.push("terminal-preparation"); return { outcome: "terminal-failure" }; } };
      expect(await runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId,
        authorityGenerationId: "authority-1", adapters: terminal, now: () => now }))
        .toEqual({ outcome: "pending", stage: "migration" });
      expect(firstEvents).toEqual(["terminal-verification"]);
      expect(await runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId,
        authorityGenerationId: "authority-1", adapters: terminal, now: () => now }))
        .toEqual({ outcome: "terminal-failure", stage: "migration" });
      expect(firstEvents).toEqual(["terminal-verification", "terminal-preparation"]);
      const failed = await readRailwayMaintenanceState(root, path);
      expect(failed?.fallbackDecision).toEqual({ reason: "candidate-verification", decidedAt: now });
      expect(failed?.maintenanceReceipt.lastFailure).toEqual({ operation: "restore-target-preparation", retryable: false, occurredAt: now });

      const resumedEffects: string[] = []; const resumed = adapters(resumedEffects);
      expect(await runRailwayUpgradeFromState({ stateRoot: root, statePath: path, operationId,
        authorityGenerationId: "authority-1", adapters: resumed, now: () => now }))
        .toEqual({ outcome: "terminal-failure", stage: "migration" });
      expect(resumedEffects).toEqual([]);
      expect(await readRailwayMaintenanceState(root, path)).toEqual(failed);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("an explicit fresh resume clears only the first absent project-create terminal and stays on fallback", async () => {
    const value = await fixture(true);
    try {
      await rm(value.root, { recursive: true, force: true });
      const preparation = targetPreparation();
      await writeRailwayMaintenanceState(value.root, value.path, {
        ...initial(),
        maintenanceReceipt: {
          ...receiptAtStage("portable-export"),
          lastFailure: { operation: "restore-target-preparation", retryable: false, occurredAt: now },
        },
        portableExport: cleaned("export"),
        candidateUpgrade: candidateAmbiguous(),
        fallbackDecision: { reason: "candidate-upgrade", decidedAt: now },
        restoreTargetPreparation: {
          ...preparation,
          reconcile: {
            ...preparation.reconcile,
            pending: { kind: "project-create", logicalName: preparation.target.projectName, attempt: 1 },
          },
        },
      });

      expect(await value.run()).toEqual({ outcome: "pending", stage: "portable-export" });
      expect(value.events).toEqual([]);
      expect((await readRailwayMaintenanceState(value.root, value.path))?.maintenanceReceipt.lastFailure)
        .toEqual({ operation: "candidate-upgrade", retryable: false, occurredAt: now });

      expect(await value.run()).toEqual({ outcome: "pending", stage: "restore-target" });
      expect(value.events).toEqual(["prepare-restore"]);
      expect((await readRailwayMaintenanceState(value.root, value.path))?.fallbackDecision?.reason).toBe("candidate-upgrade");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  test("a corrected binary re-enters only a retained pre-effect restore activation failure", async () => {
    const value = await fixture();
    try {
      await rm(value.root, { recursive: true, force: true });
      const completed = restoredVerifiedState();
      const {
        logtoActivation: _logtoActivation,
        restoredLogtoBootstrap: _restoredLogtoBootstrap,
        nautiloActivation: _nautiloActivation,
        restoredTargetActivation: _restoredTargetActivation,
        activeLaunch: _activeLaunch,
        sourceTeardown: _sourceTeardown,
        ...beforeActivation
      } = completed;
      const { verification: _verification, ...receiptBeforeVerification } = beforeActivation.maintenanceReceipt;
      await writeRailwayMaintenanceState(value.root, value.path, {
        ...beforeActivation,
        maintenanceReceipt: {
          ...receiptBeforeVerification,
          stage: "restore",
          lastFailure: { operation: "restore-activation", retryable: false, occurredAt: now },
        },
      });

      const events: string[] = [];
      const result = await runRailwayUpgradeFromState({
        stateRoot: value.root,
        statePath: value.path,
        operationId,
        authorityGenerationId: "authority-1",
        adapters: adapters(events, false, false, (context) => persistActivationProof(context, value.root, value.path)),
        now: () => now,
      });
      expect(result).toEqual({ outcome: "pending", stage: "restore" });
      expect(events).toEqual(["activate"]);
      expect((await readRailwayMaintenanceState(value.root, value.path))?.restoredTargetActivation?.stage).toBe("complete");
      expect((await readRailwayMaintenanceState(value.root, value.path))?.maintenanceReceipt.lastFailure).toBeUndefined();
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  test("a corrected binary re-enters a retained authenticated handoff before any Nautilo deployment", async () => {
    const value = await fixture();
    try {
      await rm(value.root, { recursive: true, force: true });
      const completed = restoredVerifiedState();
      const { activeLaunch: _activeLaunch, sourceTeardown: _sourceTeardown, nautiloActivation: _nautiloActivation, ...withoutTerminal } = completed;
      const { verification: _verification, ...receiptBeforeVerification } = withoutTerminal.maintenanceReceipt;
      const { handoffApplied: _handoffApplied, ...retainedLifecycle } = withoutTerminal.restoredLogtoBootstrap!.lifecycle;
      const { nautiloDeploymentId: _nautiloDeploymentId, ...activationBeforeNautilo } = withoutTerminal.restoredTargetActivation!;
      await writeRailwayMaintenanceState(value.root, value.path, {
        ...withoutTerminal,
        maintenanceReceipt: {
          ...receiptBeforeVerification,
          stage: "restore",
          lastFailure: { operation: "restore-activation", retryable: false, occurredAt: now },
        },
        restoredLogtoBootstrap: {
          ...withoutTerminal.restoredLogtoBootstrap!,
          lifecycle: retainedLifecycle,
        },
        restoredTargetActivation: {
          ...activationBeforeNautilo,
          stage: "bootstrap-nautilo-start",
        },
      });

      const events: string[] = [];
      const result = await runRailwayUpgradeFromState({
        stateRoot: value.root,
        statePath: value.path,
        operationId,
        authorityGenerationId: "authority-1",
        adapters: adapters(events, false, false, (context) => persistActivationProof(context, value.root, value.path)),
        now: () => now,
      });
      expect(result).toEqual({ outcome: "pending", stage: "restore" });
      expect(events).toEqual(["activate"]);
      expect((await readRailwayMaintenanceState(value.root, value.path))?.maintenanceReceipt.lastFailure).toBeUndefined();
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  test("clears a retained activation failure only after the exact activation proof is already durable", async () => {
    const value = await fixture();
    try {
      await rm(value.root, { recursive: true, force: true });
      const completed = restoredVerifiedState();
      const { activeLaunch: _activeLaunch, sourceTeardown: _sourceTeardown, ...withoutCutover } = completed;
      const { verification: _verification, ...receiptBeforeVerification } = withoutCutover.maintenanceReceipt;
      await writeRailwayMaintenanceState(value.root, value.path, {
        ...withoutCutover,
        maintenanceReceipt: {
          ...receiptBeforeVerification,
          stage: "restore",
          lastFailure: { operation: "restore-activation", retryable: false, occurredAt: now },
        },
      });
      const events: string[] = [];
      const result = await runRailwayUpgradeFromState({
        stateRoot: value.root,
        statePath: value.path,
        operationId,
        authorityGenerationId: "authority-1",
        adapters: adapters(events),
        now: () => now,
      });
      expect(result).toEqual({ outcome: "pending", stage: "restore" });
      expect(events).toEqual([]);
      expect((await readRailwayMaintenanceState(value.root, value.path))?.maintenanceReceipt.lastFailure).toBeUndefined();
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  test("rejects stale authority before every adapter effect", async () => {
    const value = await fixture(); try { await value.run(); let failure: unknown; try { await runRailwayUpgradeFromState({ stateRoot: value.root, statePath: value.path, operationId, authorityGenerationId: "stale", adapters: adapters(value.events), now: () => now }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "invalid-state" }); expect(value.events).toEqual(["quiesce"]);
    } finally { await rm(value.root, { recursive: true, force: true }); } });
});
