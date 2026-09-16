import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createMaintenanceReceipt, parseMaintenanceReceipt, type MaintenanceReceipt } from "@nautilo/hosting";
import {
  destroyRailwayDeployment,
  type RailwayDestroyExecutor,
  RailwayExactServiceActivationCheckpoint,
  RailwayPortableMaintenanceCleanupCheckpoint,
  RailwayPortableMaintenanceTargetCheckpoint,
} from "@nautilo/railway-hosting";

import {
  createRailwayPostUpgradeSourceState,
  createRailwayRestoreTargetTeardownReceipt,
  createRailwaySourceTeardownReceipt,
  railwayRestoreTargetTeardownReceiptSha256,
  railwayRecoveryProjectName,
  RailwayMaintenanceStateStoreError,
  readRailwayMaintenanceState,
  updateRailwayMaintenanceState,
  writeRailwayMaintenanceState,
  type RailwayMaintenanceState,
  type RailwayMaintenanceStateStoreErrorCode,
} from "../../src/lib/railway-maintenance-state";
import {
  authorizeRailwayRestoreTargetDiscard,
  cleanupAuthorizedRailwayRestoreTarget,
  discoverRailwayMaintenanceStates,
  railwayFailedMaintenanceCleanupComplete,
} from "../../src/lib/railway-host-maintenance";

const roots: string[] = [];
const t0 = "2026-08-11T08:00:00.000Z";
const t3 = "2026-08-11T08:03:00.000Z";
const t4 = "2026-08-11T08:04:00.000Z";
const image = `registry.example.test/nautilo@sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("maintenance discovery binds each directory to its internal maintenance identity", async () => {
  const place = await location();
  await writeRailwayMaintenanceState(place.root, place.path, state());
  await rename(place.path, join(place.root, "forged-maintenance"));
  expect(discoverRailwayMaintenanceStates(place.root)).rejects.toThrow("Railway maintenance discovery failed");
});

test("maintenance state freezes the target topology under its exact digest", async () => {
  const place = await location();
  const targetTopology = { schemaVersion: 1, releaseId: "release-target",
    finalServices: ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"].map((name) => ({
      name, image, ...(name === "nautilo-server" ? { healthcheck: { path: "/health" } } : {}),
    })),
    mounts: [], generatedPublicDomains: [], transientBootstrap: { image }, transientLogtoBootstrap: { image }, qualifications: [],
    railwayReferences: [{ variable: "RAILWAY_PRIVATE_DOMAIN" }, { variable: "RAILWAY_PUBLIC_DOMAIN" }],
  } as unknown as RailwayMaintenanceState["targetTopology"] & Record<string, unknown>;
  const targetTopologySha256 = createHash("sha256").update(JSON.stringify(targetTopology), "utf8").digest("hex");
  const targetTopologyMac = "c".repeat(64);
  await writeRailwayMaintenanceState(place.root, place.path, { ...state(), targetTopology, targetTopologySha256, targetTopologyMac });
  expect((await readRailwayMaintenanceState(place.root, place.path))?.targetTopologySha256).toBe(targetTopologySha256);
  const secretTopology = { ...targetTopology, railwayReferences: [{ variable: "railway_definitely-secret-credential" }] } as never;
  const secretTopologySha256 = createHash("sha256").update(JSON.stringify(secretTopology), "utf8").digest("hex");
  expect(writeRailwayMaintenanceState(place.root, join(place.root, "maintenance-secret"), {
    ...state(), maintenanceId: "maintenance-secret", maintenanceReceipt: { ...initialReceipt(), maintenanceId: "maintenance-secret" },
    targetTopology: secretTopology, targetTopologySha256: secretTopologySha256, targetTopologyMac,
  })).rejects.toThrow();
  const privatePathTopology = { ...targetTopology,
    finalServices: targetTopology.finalServices.map((service) => service.name === "nautilo-server"
      ? { ...service, healthcheck: { path: "/private/config" } } : service) } as never;
  const privatePathSha256 = createHash("sha256").update(JSON.stringify(privatePathTopology), "utf8").digest("hex");
  expect(writeRailwayMaintenanceState(place.root, join(place.root, "maintenance-private-path"), {
    ...state(), maintenanceId: "maintenance-private-path",
    maintenanceReceipt: { ...initialReceipt(), maintenanceId: "maintenance-private-path" },
    targetTopology: privatePathTopology, targetTopologySha256: privatePathSha256, targetTopologyMac,
  })).rejects.toThrow();
  const forged = { ...targetTopology, qualifications: [{ code: "forged", disposition: "blocking" }] } as never;
  expect(writeRailwayMaintenanceState(place.root, join(place.root, "maintenance-2"), {
    ...state(), maintenanceId: "maintenance-2", maintenanceReceipt: { ...initialReceipt(), maintenanceId: "maintenance-2" },
    targetTopology: forged, targetTopologySha256, targetTopologyMac,
  })).rejects.toThrow();
});

async function location() {
  const parent = await mkdtemp(join(tmpdir(), "nautilo-maintenance-state-")); roots.push(parent);
  return { parent, root: join(parent, "root"), path: join(parent, "root", "maintenance-1") };
}

function initialReceipt(): MaintenanceReceipt {
  return createMaintenanceReceipt({
    maintenanceId: "maintenance-1", launchId: "launch-1", backend: "railway",
    sourceReleaseId: "release-source", targetReleaseId: "release-target", now: t0,
  });
}

function portableReceipt(): MaintenanceReceipt {
  const receipt: MaintenanceReceipt = {
    ...initialReceipt(), revision: 4, stage: "portable-export", updatedAt: t4,
    providerWorkflows: [
      { operation: "backup-application-postgres", workflowId: "backup-app", state: "complete", completedAt: t3 },
      { operation: "backup-logto-postgres", workflowId: "backup-logto", state: "complete", completedAt: t3 },
      { operation: "backup-server-volume", workflowId: "backup-volume", state: "complete", completedAt: t3 },
      { operation: "export-portable", workflowId: "portable-job-1", state: "complete", completedAt: t4 },
    ],
    backupSet: {
      backups: [
        { kind: "application-postgres", backupId: "backup-app" },
        { kind: "logto-postgres", backupId: "backup-logto" },
        { kind: "server-volume", backupId: "backup-volume" },
      ],
      completedAt: t3,
    },
    portableExport: { objectId: "portable-object-1", sha256: "b".repeat(64), completedAt: t4 },
  };
  expect(parseMaintenanceReceipt(receipt).ok).toBe(true);
  return receipt;
}

function restoreReceipt(): MaintenanceReceipt {
  const base = portableReceipt();
  const receipt: MaintenanceReceipt = {
    ...base, revision: 7, stage: "restore", updatedAt: "2026-08-11T08:07:00.000Z",
    release: { releaseId: "release-target", appliedAt: "2026-08-11T08:05:00.000Z" },
    restoreTarget: { projectId: "restore-project-1", environmentId: "restore-environment-1", createdAt: "2026-08-11T08:06:00.000Z" },
    lastFailure: { operation: "migration", retryable: false, occurredAt: "2026-08-11T08:06:00.000Z" },
    providerWorkflows: [...base.providerWorkflows!, {
      operation: "restore-portable", workflowId: "restore-job-1", state: "complete", completedAt: "2026-08-11T08:07:00.000Z",
    }],
  };
  expect(parseMaintenanceReceipt(receipt).ok).toBe(true);
  return receipt;
}

function state(receipt = initialReceipt()): RailwayMaintenanceState {
  return {
    schemaVersion: 1, revision: 0, maintenanceId: "maintenance-1", sourceLaunchId: "launch-1",
    authorityGenerationId: "authority-generation-1", sourceManagedWorkbenchHostname: "source.example.test",
    sourceLaunchState: {
      schemaVersion: 1, launchId: "launch-1", releaseId: "release-source", providers: [],
      target: { workspaceId: "workspace-1", projectName: "source-project", environmentName: "production" },
      reconcile: { receipt: {
        schemaVersion: 1, launchId: "launch-1", backend: "railway", revision: 1, stage: "authorized",
        resources: [
          { kind: "railway.project", id: "project-1", name: "source-project" },
          { kind: "railway.environment", id: "environment-1", name: "production" },
          { kind: "railway.service", id: "source-logto-service-1", name: "logto" },
          { kind: "railway.service", id: "nautilo-service-1", name: "nautilo-server" },
          { kind: "railway.volume", id: "source-volume-1", name: "nautilo-data" },
          { kind: "railway.domain", id: "source-domain-1", name: "nautilo-public" },
        ],
        cleanup: { state: "not-required" }, createdAt: t0, updatedAt: t0,
      } },
    },
    maintenanceReceipt: receipt,
  };
}

function transfer(direction: "export" | "restore" = "export"): RailwayPortableMaintenanceTargetCheckpoint {
  const restoring = direction === "restore";
  const operationId = restoring ? "restore-operation-1" : "portable-operation-1";
  const objectId = "portable-object-1";
  return {
    state: "started", attempt: 1, operationId, direction, objectId,
    projectId: restoring ? "restore-project-1" : "project-1", environmentId: restoring ? "restore-environment-1" : "environment-1",
    serviceId: restoring ? "restore-service-1" : "nautilo-service-1", image, sourceReleaseId: "release-source",
    command: `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts ${direction} ${operationId} ${objectId}`,
    startEffect: "connect", jobId: restoring ? "restore-job-1" : "portable-job-1",
  };
}

function cleanup(target = transfer()): RailwayPortableMaintenanceCleanupCheckpoint {
  return {
    schemaVersion: 1, projectId: target.projectId, environmentId: target.environmentId,
    serviceId: target.serviceId, operationId: target.operationId,
    imageDigest: "a".repeat(64), commandSha256: createHash("sha256").update(target.command).digest("hex"), state: "complete", completedDeletes: 12,
  };
}

function activation(serviceId: string, stateValue: "prepared" | "complete" = "prepared"): RailwayExactServiceActivationCheckpoint {
  const binding = {
    projectId: "restore-project-1", environmentId: "restore-environment-1", serviceId, image,
    effect: "connect" as const, startEffect: "connect" as const, attempt: 1,
  };
  return stateValue === "complete"
    ? { ...binding, state: "complete", jobId: `${serviceId}-deployment-1` }
    : { ...binding, state: "prepared" };
}

function advancedState(): RailwayMaintenanceState {
  const exported = transfer("export"); const restored = transfer("restore");
  return {
    ...state(restoreReceipt()),
    restoreTargetState: {
      schemaVersion: 1, launchId: "restore-launch-1", releaseId: "release-target", providers: [],
      target: { workspaceId: "workspace-1", projectName: "restore-project", environmentName: "production" },
      reconcile: { receipt: {
        schemaVersion: 1, launchId: "restore-launch-1", backend: "railway", revision: 1, stage: "claimable",
        resources: [
          { kind: "railway.project", id: "restore-project-1", name: "restore-project" },
          { kind: "railway.environment", id: "restore-environment-1", name: "production" },
          ...["app-postgres", "logto-postgres"].flatMap((name) => [
            { kind: "railway.service", id: `restore-${name}-service-1`, name },
            { kind: "railway.variable-collection", id: `restore-environment-1:restore-${name}-service-1`, name: `variables-${name}` },
            { kind: "railway.service-image", id: `restore-${name}-service-1`, name },
            { kind: "railway.deployment", id: `restore-${name}-deployment-1`, name },
          ]),
          { kind: "railway.volume", id: "restore-app-postgres-volume-1", name: "app-postgres-data" },
          { kind: "railway.volume", id: "restore-logto-postgres-volume-1", name: "logto-postgres-data" },
          { kind: "railway.service", id: "restore-logto-service-1", name: "logto" },
          { kind: "railway.service", id: "restore-service-1", name: "nautilo-server" },
          { kind: "railway.domain", id: "restore-domain-1", name: "nautilo-public" },
          { kind: "railway.domain", id: "restore-logto-domain-1", name: "logto-public" },
        ],
        cleanup: { state: "not-required" }, createdAt: t0, updatedAt: t0, claimableAt: t0,
      } },
      databaseBootstrap: { schemaVersion: 1, projectId: "restore-project-1", environmentId: "restore-environment-1",
        serviceName: "nautilo-bootstrap", imageDigest: `sha256:${"a".repeat(64)}`, serviceId: "restore-bootstrap-service-1",
        variablesApplied: true, deploymentId: "restore-bootstrap-deployment-1", successfulDeploymentId: "restore-bootstrap-deployment-1" },
    },
    targetNautiloHostname: "target.example.test",
    targetLogtoHostname: "identity.example.test",
    portableExport: { target: exported, cleanup: cleanup(exported) },
    portableRestore: { target: restored, cleanup: cleanup(restored) },
  };
}

function restoredReadyState(): RailwayMaintenanceState {
  const base = advancedState();
  return {
    ...base,
    logtoActivation: activation("restore-logto-service-1", "complete"),
    restoredLogtoBootstrap: {
      lifecycle: {
        schemaVersion: 1, projectId: "restore-project-1", environmentId: "restore-environment-1",
        serviceName: "nautilo-bootstrap", imageDigest: `sha256:${"a".repeat(64)}`,
        serviceId: "bootstrap-service-1", variablesApplied: true, deploymentId: "bootstrap-deployment-1",
        successfulDeploymentId: "bootstrap-deployment-1", handoffDomainId: "bootstrap-domain-1",
        handoffDomain: "bootstrap.example.test",
      },
      exactActivation: activation("bootstrap-service-1", "complete"),
    },
  };
}

function outerCheckpoint() {
  return {
    schemaVersion: 1 as const, releaseId: "release-target", projectId: "restore-project-1", environmentId: "restore-environment-1",
    logtoServiceId: "restore-logto-service-1", nautiloServiceId: "restore-service-1",
    logtoImageDigest: "a".repeat(64), nautiloImageDigest: "a".repeat(64), bootstrapImageDigest: "a".repeat(64),
    authorityGenerationId: "authority-generation-1", intentSha256: "d".repeat(64), effectSha256: "e".repeat(64), stage: "gates" as const,
  };
}

function candidateCheckpoint(stage: "verify-old" | "complete" = "verify-old") {
  const names = ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"] as const;
  const completedNames = ["app-postgres", "logto-postgres", "logto", "nautilo-server"] as const;
  return {
    schemaVersion: 1 as const, releaseId: "release-target", projectId: "project-1", environmentId: "environment-1",
    migrationId: "migration-1", migrationExecutionId: "migration-execution-1", stage,
    services: names.map((name) => ({ name, serviceId: `${name}-service-1`, oldImage: image, newImage: image, kind: name === "logto-seed" ? "run-once" as const : "long-lived" as const })),
    completedDeployments: stage === "complete" ? completedNames.map((name) => ({ name, serviceId: `${name}-service-1`, deploymentId: `${name}-deployment-1` })) : [],
    ...(stage === "complete" ? { migrationDeploymentId: "nautilo-server-migration-deployment-1" } : {}),
  };
}

function ambiguousCandidate() {
  return { ...candidateCheckpoint(), stage: "start-ambiguous" as const, serviceIndex: 0, attempt: 1,
    baselineDeploymentIds: [], ambiguousDeploymentIds: ["ambiguous-deployment-1", "ambiguous-deployment-2"] };
}

function expectCode(error: unknown, code: RailwayMaintenanceStateStoreErrorCode): void {
  expect(error).toBeInstanceOf(RailwayMaintenanceStateStoreError);
  expect((error as RailwayMaintenanceStateStoreError).code).toBe(code);
}

async function expectRejected(promise: Promise<unknown>, expected: Readonly<Record<string, unknown>>): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toMatchObject(expected);
}

describe("Railway maintenance composite state", () => {
  test("repairs one exhausted overlong replacement identity without a provider effect", async () => {
    const place = await location();
    const base = state();
    const overlong = "nautilo-d488-qualification-recovery-cf6c45ac55f8";
    const preparation: RailwayMaintenanceState["restoreTargetPreparation"] = {
      schemaVersion: 1,
      launchId: "restore-maintenance-1",
      releaseId: "release-target",
      providers: [],
      target: { workspaceId: "workspace-1", projectName: overlong, environmentName: "production" },
      reconcile: {
        receipt: {
          schemaVersion: 1, launchId: "restore-maintenance-1", backend: "railway", revision: 1, stage: "authorized",
          resources: [], cleanup: { state: "not-required" }, createdAt: t0, updatedAt: t0,
        },
        pending: { kind: "project-create", logicalName: overlong, attempt: 2 },
      },
    };
    await writeRailwayMaintenanceState(place.root, place.path, { ...base, restoreTargetPreparation: preparation });
    const before = (await readRailwayMaintenanceState(place.root, place.path))!;
    const corrected = railwayRecoveryProjectName(before.maintenanceId);
    const after = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: before.revision }, (current) => ({
      ...current,
      revision: current.revision + 1,
      restoreTargetPreparation: {
        ...current.restoreTargetPreparation!,
        target: { ...current.restoreTargetPreparation!.target, projectName: corrected },
        reconcile: { ...current.restoreTargetPreparation!.reconcile,
          pending: { kind: "project-create", logicalName: corrected, attempt: 1 } },
      },
    }));
    expect(corrected).toBe("nautilo-recovery-maintenance1");
    expect(Buffer.byteLength(corrected)).toBeLessThanOrEqual(32);
    expect(after.restoreTargetPreparation?.reconcile.pending?.attempt).toBe(1);
  });

  test("rejects every terminal receipt without its atomic active projection and teardown", async () => {
    const candidate = candidateCheckpoint("complete"); const source = state(portableReceipt());
    const sourceReceipt: MaintenanceReceipt = { ...source.maintenanceReceipt, revision: 8, stage: "complete",
      release: { releaseId: "release-target", appliedAt: t4 }, migration: { migrationId: "migration-1", completedAt: t4 },
      verification: { subject: "candidate", verifiedAt: t4 } };
    const sourceTerminal: RailwayMaintenanceState = { ...source, maintenanceReceipt: sourceReceipt, candidateUpgrade: candidate,
      postUpgradeSourceState: createRailwayPostUpgradeSourceState(source.sourceLaunchState, candidate, "release-target", t4) };
    const sourcePlace = await location(); await expectRejected(writeRailwayMaintenanceState(sourcePlace.root, sourcePlace.path, sourceTerminal), { code: "invalid-state" });

    const restored = advancedState(); const restoreReceiptValue: MaintenanceReceipt = { ...restored.maintenanceReceipt, revision: 10, stage: "complete",
      verification: { subject: "restore-target", verifiedAt: t4 }, cutover: { committedAt: t4 } };
    const restorePlace = await location(); await expectRejected(writeRailwayMaintenanceState(restorePlace.root, restorePlace.path, {
      ...restored, maintenanceReceipt: restoreReceiptValue,
    }), { code: "invalid-state" });
  });

  test("owns every terminally ambiguous deployment under distinct exact teardown names", async () => {
    const place = await location(); const initial = state(); const candidate = ambiguousCandidate();
    const receipt = createRailwaySourceTeardownReceipt(initial.sourceLaunchState, candidate);
    expect(receipt.resources.filter((resource) => resource.name?.includes("-ambiguous-"))).toEqual([
      { kind: "railway.deployment", id: "ambiguous-deployment-1", name: "app-postgres-ambiguous-0" },
      { kind: "railway.deployment", id: "ambiguous-deployment-2", name: "app-postgres-ambiguous-1" },
    ]);
    const owned: RailwayMaintenanceState = { ...initial, candidateUpgrade: candidate,
      sourceTeardown: { schemaVersion: 1, receipt, stage: "validate" } };
    await writeRailwayMaintenanceState(place.root, place.path, owned);
    for (const mutate of [
      (value: RailwayMaintenanceState) => { const resources = value.sourceTeardown!.receipt.resources; (value.sourceTeardown!.receipt as { resources: typeof resources }).resources = resources.filter((resource) => resource.id !== "ambiguous-deployment-2"); },
      (value: RailwayMaintenanceState) => { const resource = value.sourceTeardown!.receipt.resources.find((entry) => entry.id === "ambiguous-deployment-2")!; (resource as { id: string }).id = "ambiguous-deployment-1"; },
      (value: RailwayMaintenanceState) => { const resource = value.sourceTeardown!.receipt.resources.find((entry) => entry.id === "ambiguous-deployment-2")!; (resource as { id: string }).id = "forged-deployment"; },
    ]) {
      const malformed = structuredClone(owned); mutate(malformed); const isolated = await location();
      await expectRejected(writeRailwayMaintenanceState(isolated.root, isolated.path, malformed), { code: "invalid-state" });
    }
    const migrationBase = candidateCheckpoint();
    const migrationCandidate = { ...migrationBase, stage: "migration-start-ambiguous" as const,
      completedDeployments: (["app-postgres", "logto-postgres"] as const).map((name) => ({
        name, serviceId: `${name}-service-1`, deploymentId: `${name}-deployment-1`,
      })), baselineDeploymentIds: [], ambiguousDeploymentIds: ["migration-deployment-1", "migration-deployment-2"] };
    expect(createRailwaySourceTeardownReceipt(initial.sourceLaunchState, migrationCandidate).resources.filter((resource) => resource.name?.includes("migration-ambiguous-"))).toEqual([
      { kind: "railway.deployment", id: "migration-deployment-1", name: "nautilo-server-migration-ambiguous-0" },
      { kind: "railway.deployment", id: "migration-deployment-2", name: "nautilo-server-migration-ambiguous-1" },
    ]);
  });

  test("owns every replacement maintenance deployment before failed-target teardown", async () => {
    const initial = restoredReadyState();
    const receipt = createRailwayRestoreTargetTeardownReceipt(initial);
    expect(receipt.resources).toContainEqual({ kind: "railway.deployment", id: "restore-job-1", name: "restore-maintenance-0" });
    expect(receipt.resources).toContainEqual({ kind: "railway.deployment", id: "restore-logto-service-1-deployment-1", name: "restore-maintenance-1" });
    expect(receipt.resources).toContainEqual({ kind: "railway.deployment", id: "bootstrap-service-1-deployment-1", name: "restore-maintenance-2" });
    expect(receipt.resources).toContainEqual({ kind: "railway.deployment", id: "bootstrap-deployment-1", name: "restore-maintenance-3" });
    expect(receipt.resources).toContainEqual({ kind: "railway.deployment", id: "restore-bootstrap-deployment-1", name: "restore-maintenance-4" });
    expect(receipt.resources).toContainEqual({ kind: "railway.service", id: "bootstrap-service-1", name: "nautilo-bootstrap" });
    expect(receipt.resources).toContainEqual({ kind: "railway.domain", id: "bootstrap-domain-1", name: "nautilo-bootstrap" });
    const owned: RailwayMaintenanceState = { ...initial,
      restoreTargetTeardown: { schemaVersion: 1, receipt, stage: "validate" } };
    const place = await location();
    await writeRailwayMaintenanceState(place.root, place.path, owned);
    const legacyReceipt = { ...receipt, resources: receipt.resources.filter((resource) => ![
      "bootstrap-service-1", "bootstrap-domain-1",
    ].includes(resource.id)) };
    const legacy: RailwayMaintenanceState = { ...initial,
      restoreTargetTeardown: { schemaVersion: 1, receipt: legacyReceipt, stage: "validate" } };
    const historicalPlace = await location();
    await writeRailwayMaintenanceState(historicalPlace.root, historicalPlace.path, initial);
    await writeFile(join(historicalPlace.path, "revision-0000000001.json"), `${JSON.stringify({ ...legacy, revision: 1 })}\n`, { mode: 0o600 });
    expect((await readRailwayMaintenanceState(historicalPlace.root, historicalPlace.path))?.restoreTargetTeardown?.receipt)
      .toEqual(legacyReceipt);
    const legacyPlace = await location();
    await writeRailwayMaintenanceState(legacyPlace.root, legacyPlace.path, legacy);
    const legacyAuthorized = await authorizeRailwayRestoreTargetDiscard({ stateRoot: legacyPlace.root,
      statePath: legacyPlace.path, operationId: legacy.maintenanceId, now: () => t4 });
    await updateRailwayMaintenanceState(legacyPlace.root, legacyPlace.path, { expectedRevision: legacyAuthorized.revision }, (current) => ({
      ...current,
      revision: current.revision + 1,
      restoreTargetTeardown: { schemaVersion: 1, receipt: createRailwayRestoreTargetTeardownReceipt(current), stage: "validate" },
    }));
    expect((await readRailwayMaintenanceState(legacyPlace.root, legacyPlace.path))?.restoreTargetTeardown?.receipt.resources)
      .toEqual(receipt.resources);
    for (const id of ["restore-job-1", "restore-bootstrap-deployment-1", "restore-logto-service-1-deployment-1",
      "bootstrap-service-1", "bootstrap-domain-1"]) {
      const malformed = structuredClone(owned);
      const resources = malformed.restoreTargetTeardown!.receipt.resources;
      (malformed.restoreTargetTeardown!.receipt as { resources: typeof resources }).resources = resources.filter((resource) => resource.id !== id);
      const isolated = await location();
      await expectRejected(writeRailwayMaintenanceState(isolated.root, isolated.path, malformed), { code: "invalid-state" });
    }
  });

  test("cleans a terminal replacement under exact inventory custody and then closes discovery", async () => {
    const run = async (foreignDeployment: boolean) => {
      const place = await location();
      const base = advancedState();
      const initial: RailwayMaintenanceState = {
        ...base,
        maintenanceReceipt: {
          ...base.maintenanceReceipt,
          lastFailure: { operation: "restore-portable", retryable: false, occurredAt: t4 },
        },
      };
      await writeRailwayMaintenanceState(place.root, place.path, initial);
      const expected = createRailwayRestoreTargetTeardownReceipt(initial);
      const present = new Set(expected.resources.map(({ kind, id }) => `${kind}:${id}`));
      const calls: string[] = [];
      const remove = (kind: string, id: string) => present.delete(`${kind}:${id}`);
      const executor: RailwayDestroyExecutor = {
        deleteDomain: async ({ domainId }) => { calls.push(`domain:${domainId}`); remove("railway.domain", domainId); },
        deleteVolume: async ({ volumeId }) => { calls.push(`volume:${volumeId}`); remove("railway.volume", volumeId); },
        deleteService: async ({ serviceId }) => { calls.push(`service:${serviceId}`); remove("railway.service", serviceId); },
        deleteProject: async ({ projectId }) => { calls.push(`project:${projectId}`); present.clear(); },
        getProject: async () => present.has("railway.project:restore-project-1")
          ? { id: "restore-project-1", name: "restore-project", workspaceId: "workspace-1" } : null,
        inventoryProjectResources: async () => [
          ...[...present].map((entry) => { const split = entry.indexOf(":"); return { kind: entry.slice(0, split), id: entry.slice(split + 1) }; }),
          ...(foreignDeployment ? [{ kind: "railway.deployment", id: "foreign-deployment-1" }] : []),
        ],
        inventoryReceiptResources: async ({ resources }) => resources.filter(({ kind, id }) => present.has(`${kind}:${id}`))
          .map(({ kind, id }) => ({ kind, id })),
      };
      await expectRejected(cleanupAuthorizedRailwayRestoreTarget({ stateRoot: place.root, statePath: place.path,
        operationId: "maintenance-1", executor, poll: { maxAttempts: 1 }, now: () => t4 }), {
        message: "Railway maintenance cleanup is unavailable",
      });
      expect(calls).toEqual([]);
      const authorized = await authorizeRailwayRestoreTargetDiscard({ stateRoot: place.root, statePath: place.path,
        operationId: "maintenance-1", now: () => t4 });
      expect(authorized.restoreTargetDisposition).toEqual({
        schemaVersion: 1,
        state: "discard-authorized",
        reason: "operator-discard",
        targetLaunchId: authorized.restoreTargetState!.launchId,
        targetProjectId: "restore-project-1",
        teardownReceiptSha256: railwayRestoreTargetTeardownReceiptSha256(authorized),
        authorizedAt: t4,
      });
      await expectRejected(updateRailwayMaintenanceState(place.root, place.path,
        { expectedRevision: authorized.revision }, (current) => ({
          ...current,
          revision: current.revision + 1,
          restoreTargetDisposition: { ...current.restoreTargetDisposition!, teardownReceiptSha256: "0".repeat(64) },
        })), { code: "invalid-transition" });
      await expectRejected(updateRailwayMaintenanceState(place.root, place.path,
        { expectedRevision: authorized.revision }, (current) => ({
          ...current,
          revision: current.revision + 1,
          restoredTargetActivation: outerCheckpoint(),
        })), { code: "invalid-transition" });
      const result = await cleanupAuthorizedRailwayRestoreTarget({ stateRoot: place.root, statePath: place.path,
        operationId: "maintenance-1", executor, poll: { maxAttempts: 1 }, now: () => t4 });
      return { result, calls, state: (await readRailwayMaintenanceState(place.root, place.path))! };
    };
    const fenced = await run(true);
    expect(fenced.result).toMatchObject({ outcome: "failure", code: "unknown-project-resource" });
    expect(fenced.calls).toEqual([]);
    expect(railwayFailedMaintenanceCleanupComplete(fenced.state)).toBe(false);
    const exact = await run(false);
    expect(exact.result.outcome).toBe("complete");
    expect(exact.calls.at(-1)).toBe("project:restore-project-1");
    expect(railwayFailedMaintenanceCleanupComplete(exact.state)).toBe(true);
    expect(exact.state.restoreTargetTeardown?.receipt.resources).toEqual([]);
  });

  test("publishes one exact discard decision across a concurrent CAS retry", async () => {
    const place = await location();
    const initial = advancedState();
    await writeRailwayMaintenanceState(place.root, place.path, initial);
    const authorize = () => authorizeRailwayRestoreTargetDiscard({ stateRoot: place.root, statePath: place.path,
      operationId: initial.maintenanceId, now: () => t4 });
    const [left, right] = await Promise.all([authorize(), authorize()]);
    expect(left.revision).toBe(1);
    expect(right.revision).toBe(1);
    expect(left.restoreTargetDisposition).toEqual(right.restoreTargetDisposition);
    expect((await readRailwayMaintenanceState(place.root, place.path))?.restoreTargetDisposition)
      .toEqual(left.restoreTargetDisposition);
  });

  test("persists append-only source recovery deployment custody and projects it into teardown", async () => {
    const place = await location();
    const initial = state();
    const recovery = [{ serviceName: "nautilo-server" as const, serviceId: "nautilo-service-1",
      deploymentId: "recovery-deployment-1", recordedAt: t4 }];
    await writeRailwayMaintenanceState(place.root, place.path, { ...initial, sourceRecoveryDeployments: recovery });
    const receipt = createRailwaySourceTeardownReceipt(initial.sourceLaunchState, undefined, recovery);
    expect(receipt.resources).toContainEqual({
      kind: "railway.deployment", id: "recovery-deployment-1", name: "nautilo-server-recovery-0",
    });

    const before = (await readRailwayMaintenanceState(place.root, place.path))!;
    const second = { serviceName: "logto" as const, serviceId: "source-logto-service-1",
      deploymentId: "recovery-deployment-2", recordedAt: t4 };
    await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: before.revision }, (current) => ({
      ...current, revision: current.revision + 1,
      sourceRecoveryDeployments: [...current.sourceRecoveryDeployments!, second],
    }));
    const after = (await readRailwayMaintenanceState(place.root, place.path))!;
    expect(after.sourceRecoveryDeployments).toEqual([...recovery, second]);

    const forged: RailwayMaintenanceState = {
      ...structuredClone(after), sourceRecoveryDeployments: after.sourceRecoveryDeployments!.slice(1),
    };
    await expectRejected(updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: after.revision }, () => ({
      ...forged, revision: after.revision + 1,
    })), { code: "invalid-transition" });

    const candidate = candidateCheckpoint("complete");
    const sourceBase = state(portableReceipt());
    const completedReceipt: MaintenanceReceipt = {
      ...sourceBase.maintenanceReceipt,
      revision: 8,
      stage: "complete",
      release: { releaseId: "release-target", appliedAt: t4 },
      migration: { migrationId: "migration-1", completedAt: t4 },
      verification: { subject: "candidate", verifiedAt: t4 },
    };
    const sourceComplete: RailwayMaintenanceState = {
      ...sourceBase,
      maintenanceReceipt: completedReceipt,
      candidateUpgrade: candidate,
      postUpgradeSourceState: createRailwayPostUpgradeSourceState(sourceBase.sourceLaunchState, candidate, "release-target", t4),
      activeLaunch: { kind: "source", launchId: sourceBase.sourceLaunchId, releaseId: "release-target", selectedAt: t4 },
    };
    await expectRejected(writeRailwayMaintenanceState(place.root, `${place.path}-source`, {
      ...sourceComplete,
      sourceRecoveryDeployments: recovery,
    }), { code: "invalid-state" });
  });

  test("fallback teardown hits the project billing fence before delete and proceeds only for exact custody", async () => {
    const initial = state(); const receipt = createRailwaySourceTeardownReceipt(initial.sourceLaunchState, ambiguousCandidate());
    for (const owned of [
      { kind: "railway.project", id: "project-1", name: "source-project" },
      { kind: "railway.service", id: "source-logto-service-1", name: "logto" },
      { kind: "railway.service", id: "nautilo-service-1", name: "nautilo-server" },
      { kind: "railway.volume", id: "source-volume-1", name: "nautilo-data" },
      { kind: "railway.domain", id: "source-domain-1", name: "nautilo-public" },
      { kind: "railway.deployment", id: "ambiguous-deployment-1", name: "app-postgres-ambiguous-0" },
      { kind: "railway.deployment", id: "ambiguous-deployment-2", name: "app-postgres-ambiguous-1" },
    ]) expect(receipt.resources).toContainEqual(owned);
    const run = async (foreign: false | "all" | "deployment", ownedReceipt = receipt) => {
      const calls: string[] = []; let checkpoint = { schemaVersion: 1 as const, receipt: ownedReceipt, stage: "validate" as const };
      const key = (kind: string, id: string) => `${kind}\u0000${id}`;
      const present = new Set(ownedReceipt.resources.map((resource) => key(resource.kind, resource.id)));
      const remove = (kind: string, id: string) => { present.delete(key(kind, id)); };
      const inventory = () => [...present].map((entry) => { const separator = entry.indexOf("\u0000");
        return { kind: entry.slice(0, separator), id: entry.slice(separator + 1) }; });
      const executor: RailwayDestroyExecutor = {
        deleteDomain: async ({ domainId }) => { calls.push(`domain:${domainId}`); remove("railway.domain", domainId); },
        deleteVolume: async ({ volumeId }) => { calls.push(`volume:${volumeId}`); remove("railway.volume", volumeId); },
        deleteService: async ({ serviceId }) => { calls.push(`service:${serviceId}`); remove("railway.service", serviceId); },
        deleteProject: async ({ projectId }) => { calls.push(`project:${projectId}`); present.clear(); },
        getProject: async () => present.has(key("railway.project", "project-1")) ? { id: "project-1", name: "source-project", workspaceId: "workspace-1" } : null,
        inventoryProjectResources: async () => [...inventory(), ...(foreign === "all" ? [
          { kind: "railway.service", id: "foreign-service" }, { kind: "railway.deployment", id: "foreign-deployment" },
          { kind: "railway.volume", id: "foreign-volume" }, { kind: "railway.domain", id: "foreign-domain" },
        ] : foreign === "deployment" ? [{ kind: "railway.deployment", id: "late-migration-deployment" }] : [])],
        inventoryReceiptResources: async ({ resources }) => resources.filter((resource) => present.has(key(resource.kind, resource.id)))
          .map(({ kind, id }) => ({ kind, id })),
      };
      const result = await destroyRailwayDeployment({ checkpoint, confirmProjectId: "project-1", executor, poll: { maxAttempts: 1 }, now: () => t4,
        persistCheckpoint: async (next) => { checkpoint = next as typeof checkpoint; } });
      return { result, calls };
    };
    const fenced = await run("all");
    expect(fenced.result).toMatchObject({ outcome: "failure", code: "unknown-project-resource" }); expect(fenced.calls).toEqual([]);
    if (fenced.result.outcome === "failure") expect(fenced.result.checkpoint.receipt.cleanup.state).not.toBe("verified");
    const exact = await run(false); expect(exact.result.outcome).toBe("complete"); expect(exact.calls).toEqual([
      "domain:source-domain-1", "service:source-logto-service-1", "service:nautilo-service-1", "volume:source-volume-1", "project:project-1",
    ]);
    const migrationBase = candidateCheckpoint();
    const unresolved = { ...migrationBase, stage: "migration-start-unresolved" as const, observations: 3, baselineDeploymentIds: [],
      completedDeployments: (["app-postgres", "logto-postgres"] as const).map((name) => ({
        name, serviceId: `${name}-service-1`, deploymentId: `${name}-deployment-1`,
      })) };
    const lateDeploymentFence = await run("deployment", createRailwaySourceTeardownReceipt(initial.sourceLaunchState, unresolved));
    expect(lateDeploymentFence.result).toMatchObject({ outcome: "failure", code: "unknown-project-resource" });
    expect(lateDeploymentFence.calls).toEqual([]);
  });

  test("binds the active source projection to all four exact completed deployments", async () => {
    const place = await location(); const base = state(portableReceipt()); const candidate = candidateCheckpoint("complete");
    (base.sourceLaunchState.reconcile.receipt as { resources: typeof base.sourceLaunchState.reconcile.receipt.resources }).resources = [
      ...base.sourceLaunchState.reconcile.receipt.resources,
      { kind: "railway.deployment", id: "old-seed", name: "logto-seed" },
      { kind: "railway.deployment", id: "old-unknown", name: "unknown-service" },
      { kind: "railway.deployment", id: "old-unnamed" },
    ];
    const projected = createRailwayPostUpgradeSourceState(base.sourceLaunchState, candidate, "release-target", t4);
    const exactState: RailwayMaintenanceState = { ...base, candidateUpgrade: candidate, postUpgradeSourceState: projected };
    await writeRailwayMaintenanceState(place.root, place.path, exactState);
    const malformed = structuredClone(exactState);
    const deployment = malformed.postUpgradeSourceState!.reconcile.receipt.resources.find((resource) => resource.kind === "railway.deployment")!;
    (deployment as { id: string }).id = "old-or-forged-deployment";
    const isolated = await location();
    await expectRejected(writeRailwayMaintenanceState(isolated.root, isolated.path, malformed), { code: "invalid-state" });
    expect(projected.reconcile.receipt.resources.filter((resource) => resource.kind === "railway.deployment")).toEqual(
      candidate.completedDeployments.map((entry) => ({ kind: "railway.deployment", id: entry.deploymentId, name: entry.name })),
    );
    expect(createRailwaySourceTeardownReceipt(base.sourceLaunchState, candidate).resources).toContainEqual({
      kind: "railway.deployment", id: "nautilo-server-migration-deployment-1", name: "nautilo-server-migration",
    });
  });
  test("enforces legal candidate progress and rejects teardown progress without explicit disposition", async () => {
    const place = await location(); const initial = advancedState();
    await writeRailwayMaintenanceState(place.root, place.path, initial);
    await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 0 }, (current) => ({
      ...current, revision: 1, candidateUpgrade: candidateCheckpoint(), sourceTeardown: {
        schemaVersion: 1, receipt: current.sourceLaunchState.reconcile.receipt, stage: "validate",
      },
    }));
    const nextCandidate = { ...candidateCheckpoint(), stage: "source-ready" as const, serviceIndex: 0 };
    const second = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 1 }, (current) => ({
      ...current, revision: 2, candidateUpgrade: nextCandidate,
      sourceTeardown: { ...current.sourceTeardown!, stage: "confirm", receipt: {
        ...current.sourceTeardown!.receipt, revision: current.sourceTeardown!.receipt.revision + 1,
      } },
    }));
    expect(second.restoreTargetTeardown).toBeUndefined(); expect(second.sourceTeardown?.stage).toBe("confirm");
    await expectRejected(updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 2 }, (current) => ({
      ...current, revision: 3,
      restoreTargetTeardown: { schemaVersion: 1, receipt: createRailwayRestoreTargetTeardownReceipt(current), stage: "validate" },
    })), { code: "invalid-transition" });
    await expectRejected(updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 2 }, (current) => ({
      ...current, revision: 3, candidateUpgrade: candidateCheckpoint("complete"),
    })), { code: "invalid-transition" });
    const malformed = structuredClone(second) as unknown as Record<string, unknown>;
    (malformed["candidateUpgrade"] as Record<string, unknown>)["latestDeploymentId"] = "latest";
    const isolated = await location();
    await expectRejected(writeRailwayMaintenanceState(isolated.root, isolated.path, malformed as unknown as RailwayMaintenanceState), { code: "invalid-state" });
  });
  test("creates, reads, and CAS-updates while preserving receipt revision and sibling child slots", async () => {
    const place = await location(); const initial = advancedState();
    await writeRailwayMaintenanceState(place.root, place.path, initial);
    const next = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 0 }, (current) => ({
      ...current, revision: 1, logtoActivation: activation("restore-logto-service-1"),
    }));
    expect(next.revision).toBe(1);
    expect(next.maintenanceReceipt.revision).toBe(7);
    expect(next.portableExport).toEqual(initial.portableExport);
    expect(next.portableRestore).toEqual(initial.portableRestore);
    expect(await readRailwayMaintenanceState(place.root, place.path)).toEqual(next);
    if (process.platform !== "win32") {
      expect((await lstat(place.root)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(place.path, "revision-0000000001.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("allows one concurrent writer for the same immutable revision", async () => {
    const place = await location(); await writeRailwayMaintenanceState(place.root, place.path, state());
    const write = () => updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 0 }, (current) => ({ ...current, revision: 1 }));
    const results = await Promise.allSettled([write(), write()]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expectCode(rejected?.status === "rejected" ? rejected.reason : undefined, "revision-conflict");
    expect((await readRailwayMaintenanceState(place.root, place.path))?.revision).toBe(1);
  });

  test("recovers known truth across interruption boundaries and ignores a kill-shaped orphan temp", async () => {
    const before = await location();
    await expectRejected(writeRailwayMaintenanceState(before.root, before.path, state(), {
      hooks: { afterTempSync: () => { throw new Error("never-leak-before"); } },
    }), { code: "io-failure" });
    expect(await readRailwayMaintenanceState(before.root, before.path)).toBeNull();

    const after = await location();
    await expectRejected(writeRailwayMaintenanceState(after.root, after.path, state(), {
      hooks: { afterPublish: () => { throw new Error("never-leak-after"); } },
    }), { code: "publish-unknown" });
    expect((await readRailwayMaintenanceState(after.root, after.path))?.revision).toBe(0);
    const orphan = join(after.path, ".revision-0000000001.999.deadbeef.tmp");
    await writeFile(orphan, "interrupted bytes", { mode: 0o600 });
    expect((await readRailwayMaintenanceState(after.root, after.path))?.revision).toBe(0);
  });

  test("rejects gaps, tampering, unknown fields, secrets, symlinks, and unsafe modes without reflection", async () => {
    const gap = await location(); await writeRailwayMaintenanceState(gap.root, gap.path, state());
    await rename(join(gap.path, "revision-0000000000.json"), join(gap.path, "revision-0000000001.json"));
    await expectRejected(readRailwayMaintenanceState(gap.root, gap.path), { code: "invalid-chain" });

    for (const mutation of [
      (value: Record<string, unknown>) => ({ ...value, unknown: true }),
      (value: Record<string, unknown>) => ({ ...value, password: "postgres://owner:never-leak@example.test/db" }),
    ]) {
      const place = await location(); await writeRailwayMaintenanceState(place.root, place.path, state());
      const file = join(place.path, "revision-0000000000.json"); const decoded = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify(mutation(decoded)), { mode: 0o600 });
      let failure: unknown; try { await readRailwayMaintenanceState(place.root, place.path); } catch (error) { failure = error; }
      expectCode(failure, "invalid-state"); expect(JSON.stringify(failure)).not.toContain("never-leak");
    }

    const unsafe = await location(); await mkdir(unsafe.root, { mode: 0o700 }); await chmod(unsafe.root, 0o755);
    await expectRejected(writeRailwayMaintenanceState(unsafe.root, unsafe.path, state()), { code: "unsafe-permissions" });
    const linked = await location(); const actualRoot = join(linked.parent, "actual"); await mkdir(actualRoot, { mode: 0o700 });
    await symlink(actualRoot, linked.root);
    await expectRejected(writeRailwayMaintenanceState(linked.root, linked.path, state()), { code: "unsafe-path" });
    await expectRejected(writeRailwayMaintenanceState(actualRoot, join(linked.parent, "escape"), state()), { code: "unsafe-path" });
  });

  test("read does not create a missing trusted root and store rejects invalid transitions", async () => {
    const place = await location(); expect(await readRailwayMaintenanceState(place.root, place.path)).toBeNull();
    await expectRejected(lstat(place.root), { code: "ENOENT" });
    await writeRailwayMaintenanceState(place.root, place.path, state());
    for (const update of [
      (current: RailwayMaintenanceState) => ({ ...current, revision: 2 }),
      (current: RailwayMaintenanceState) => ({ ...current, revision: 1, authorityGenerationId: "changed-generation" }),
      (current: RailwayMaintenanceState) => ({ ...current, revision: 1, maintenanceReceipt: { ...current.maintenanceReceipt, sourceReleaseId: "changed-release" } }),
    ]) await expectRejected(updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 0 }, update), { code: "invalid-transition" });
  });

  test("admits restore database bootstrap proof only through its exact durable prefix", async () => {
    const place = await location(); await writeRailwayMaintenanceState(place.root, place.path, state());
    const targetState = {
      schemaVersion: 1 as const, launchId: "restore-launch-1", releaseId: "release-target", providers: [],
      target: { workspaceId: "workspace-1", projectName: "Restore", environmentName: "restore" },
      reconcile: { receipt: {
        schemaVersion: 1 as const, launchId: "restore-launch-1", backend: "railway" as const, revision: 1,
        stage: "authorized" as const, resources: [], cleanup: { state: "not-required" as const }, createdAt: t0, updatedAt: t0,
      } },
    };
    await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 0 }, (current) => ({
      ...current, revision: 1, restoreTargetPreparation: targetState,
    }));
    const resources = [
      { kind: "railway.project", id: "restore-project-1", name: "Restore" },
      { kind: "railway.environment", id: "restore-environment-1", name: "restore" },
      ...["app-postgres", "logto-postgres"].flatMap((name) => [
        { kind: "railway.service", id: `${name}-service-1`, name },
        { kind: "railway.variable-collection", id: `restore-environment-1:${name}-service-1`, name: `variables-${name}` },
        { kind: "railway.service-image", id: `${name}-service-1`, name },
        { kind: "railway.deployment", id: `${name}-deployment-1`, name },
      ]),
      { kind: "railway.volume", id: "app-volume-1", name: "app-postgres-data" },
      { kind: "railway.volume", id: "logto-volume-1", name: "logto-postgres-data" },
    ];
    await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 1 }, (current) => ({
      ...current, revision: 2, restoreTargetPreparation: { ...current.restoreTargetPreparation!, reconcile: { receipt: {
        ...current.restoreTargetPreparation!.reconcile.receipt, revision: 2, stage: "provisioning", resources, updatedAt: t3,
      } } },
    }));
    await expectRejected(updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 2 }, (current) => ({
      ...current, revision: 3, restoreTargetPreparation: { ...current.restoreTargetPreparation!, reconcile: { receipt: {
        ...current.restoreTargetPreparation!.reconcile.receipt, revision: 3, stage: "bootstrapping", updatedAt: t4,
      } } },
    })), { code: "invalid-transition" });
    const base = { schemaVersion: 1 as const, projectId: "restore-project-1", environmentId: "restore-environment-1",
      serviceName: "nautilo-bootstrap" as const, imageDigest: `sha256:${"a".repeat(64)}`, serviceId: "bootstrap-service-1" };
    await expectRejected(updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 2 }, (current) => ({
      ...current, revision: 3, restoreTargetPreparation: { ...current.restoreTargetPreparation!,
        databaseBootstrap: { ...base, variablesApplied: true, deploymentId: "bootstrap-deployment-1", successfulDeploymentId: "bootstrap-deployment-1" } },
    })), { code: "invalid-transition" });
    const service = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 2 }, (current) => ({
      ...current, revision: 3, restoreTargetPreparation: { ...current.restoreTargetPreparation!, databaseBootstrap: base },
    }));
    const variables = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 3 }, (current) => ({
      ...current, revision: 4, restoreTargetPreparation: { ...current.restoreTargetPreparation!,
        databaseBootstrap: { ...current.restoreTargetPreparation!.databaseBootstrap!, variablesApplied: true } },
    }));
    const deployment = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 4 }, (current) => ({
      ...current, revision: 5, restoreTargetPreparation: { ...current.restoreTargetPreparation!,
        databaseBootstrap: { ...current.restoreTargetPreparation!.databaseBootstrap!, deploymentId: "bootstrap-deployment-1" } },
    }));
    const success = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 5 }, (current) => ({
      ...current, revision: 6, restoreTargetPreparation: { ...current.restoreTargetPreparation!,
        databaseBootstrap: { ...current.restoreTargetPreparation!.databaseBootstrap!, successfulDeploymentId: "bootstrap-deployment-1" } },
    }));
    expect([service.revision, variables.revision, deployment.revision, success.revision]).toEqual([3, 4, 5, 6]);
  });

  test("persists bootstrap lifecycle before exact child binding and permits connect-to-deploy attempt rollover", async () => {
    const place = await location(); const initial = { ...advancedState(), logtoActivation: activation("restore-logto-service-1", "complete") };
    await writeRailwayMaintenanceState(place.root, place.path, initial);
    const lifecycleOnly = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 0 }, (current) => ({
      ...current, revision: 1,
      restoredLogtoBootstrap: { lifecycle: { schemaVersion: 1, projectId: "restore-project-1", environmentId: "restore-environment-1", serviceName: "nautilo-bootstrap", imageDigest: `sha256:${"a".repeat(64)}` } },
    }));
    const child = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 1 }, (current) => ({
      ...current, revision: 2,
      restoredLogtoBootstrap: {
        lifecycle: { ...current.restoredLogtoBootstrap!.lifecycle, serviceId: "bootstrap-service-1", variablesApplied: true },
        exactActivation: { ...activation("bootstrap-service-1"), state: "start-unknown", baselineDeploymentIds: ["baseline-1"] },
      },
    }));
    const rollover = await updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 2 }, (current) => ({
      ...current, revision: 3,
      restoredLogtoBootstrap: {
        lifecycle: current.restoredLogtoBootstrap!.lifecycle,
        exactActivation: {
          projectId: "restore-project-1", environmentId: "restore-environment-1", serviceId: "bootstrap-service-1", image,
          effect: "connect", startEffect: "deploy", attempt: 2, state: "prepared",
        },
      },
    }));
    expect(lifecycleOnly.restoredLogtoBootstrap?.exactActivation).toBeUndefined();
    expect(child.restoredLogtoBootstrap?.exactActivation?.state).toBe("start-unknown");
    expect(rollover.restoredLogtoBootstrap?.exactActivation).toMatchObject({ attempt: 2, state: "prepared", startEffect: "deploy" });
  });

  test("keeps source export evidence separate and rejects activation authorized only by export cleanup", async () => {
    const place = await location(); const exported = transfer("export");
    const exportOnly: RailwayMaintenanceState = {
      ...state(portableReceipt()), portableExport: { target: exported, cleanup: cleanup(exported) },
    };
    await writeRailwayMaintenanceState(place.root, place.path, exportOnly);
    await expectRejected(updateRailwayMaintenanceState(place.root, place.path, { expectedRevision: 0 }, (current) => ({
      ...current, revision: 1, logtoActivation: activation("logto-service-1"),
    })), { code: "invalid-transition" });
    expect((await readRailwayMaintenanceState(place.root, place.path))?.portableExport).toEqual(exportOnly.portableExport);
  });

  test("allows outer bootstrap stage after exact Logto completion before bootstrap child creation", async () => {
    const place = await location();
    const value: RailwayMaintenanceState = {
      ...advancedState(), logtoActivation: activation("restore-logto-service-1", "complete"),
      restoredTargetActivation: { ...outerCheckpoint(), stage: "bootstrap-nautilo-start", logtoDeploymentId: "restore-logto-service-1-deployment-1" },
    };
    await writeRailwayMaintenanceState(place.root, place.path, value);
    expect((await readRailwayMaintenanceState(place.root, place.path))?.restoredLogtoBootstrap).toBeUndefined();
  });

  test("rejects every safe-ID cross-binding drift and unpaired target ownership", async () => {
    const variants: RailwayMaintenanceState[] = [];
    for (const key of ["projectId", "environmentId", "serviceId", "sourceReleaseId"] as const) {
      const changed = structuredClone(advancedState()); (changed.portableExport!.target as unknown as Record<string, unknown>)[key] = `wrong-${key}`; variants.push(changed);
      const restored = structuredClone(advancedState()); (restored.portableRestore!.target as unknown as Record<string, unknown>)[key] = `wrong-${key}`; variants.push(restored);
    }
    for (const key of ["projectId", "environmentId", "serviceId"] as const) {
      const logto = structuredClone(advancedState()); (logto as unknown as Record<string, unknown>)["logtoActivation"] = { ...activation("restore-logto-service-1"), [key]: `wrong-${key}` }; variants.push(logto);
      const nautilo = structuredClone(restoredReadyState()); (nautilo as unknown as Record<string, unknown>)["nautiloActivation"] = { ...activation("restore-service-1"), [key]: `wrong-${key}` }; variants.push(nautilo);
    }
    for (const key of ["projectId", "environmentId"] as const) {
      const lifecycle = structuredClone(restoredReadyState()); (lifecycle.restoredLogtoBootstrap!.lifecycle as unknown as Record<string, unknown>)[key] = `wrong-${key}`; variants.push(lifecycle);
    }
    for (const key of ["projectId", "environmentId", "logtoServiceId", "nautiloServiceId", "releaseId", "authorityGenerationId"] as const) {
      const outer = structuredClone(advancedState()); (outer as unknown as Record<string, unknown>)["restoredTargetActivation"] = { ...outerCheckpoint(), [key]: `wrong-${key}` }; variants.push(outer);
    }
    const sourceRelease = structuredClone(advancedState()); (sourceRelease.sourceLaunchState as unknown as Record<string, unknown>)["releaseId"] = "wrong-release"; variants.push(sourceRelease);
    const sourceResource = structuredClone(advancedState()); (sourceResource.sourceLaunchState.reconcile.receipt.resources[0] as unknown as Record<string, unknown>)["id"] = "wrong-project"; variants.push(sourceResource);
    const targetRelease = structuredClone(advancedState()); (targetRelease.restoreTargetState as unknown as Record<string, unknown>)["releaseId"] = "wrong-release"; variants.push(targetRelease);
    const targetResource = structuredClone(advancedState()); (targetResource.restoreTargetState!.reconcile.receipt.resources[0] as unknown as Record<string, unknown>)["id"] = "wrong-project"; variants.push(targetResource);
    const hostnameOnly = structuredClone(advancedState()); delete (hostnameOnly as unknown as Record<string, unknown>)["restoreTargetState"]; variants.push(hostnameOnly);
    const stateOnly = structuredClone(advancedState()); delete (stateOnly as unknown as Record<string, unknown>)["targetNautiloHostname"]; variants.push(stateOnly);
    const missingLogto = structuredClone(advancedState()); delete (missingLogto as unknown as Record<string, unknown>)["targetLogtoHostname"]; variants.push(missingLogto);
    const sameHosts = structuredClone(advancedState()); (sameHosts as unknown as Record<string, unknown>)["targetLogtoHostname"] = sameHosts.targetNautiloHostname; variants.push(sameHosts);
    for (const invalid of variants) {
      const place = await location();
      await expectRejected(writeRailwayMaintenanceState(place.root, place.path, invalid), { code: "invalid-state" });
    }
  });

});
