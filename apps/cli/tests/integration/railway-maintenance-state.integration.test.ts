import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMaintenanceReceipt } from "@nautilo/hosting";

import {
  RailwayMaintenanceStateStoreError,
  readRailwayMaintenanceState,
  writeRailwayMaintenanceState,
  type RailwayMaintenanceState,
} from "../../src/lib/railway-maintenance-state";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("bounds total directory entries including orphan temp files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "nautilo-maintenance-state-boundary-"));
  roots.push(parent);
  const root = join(parent, "root");
  const path = join(root, "maintenance-1");
  await writeRailwayMaintenanceState(root, path, state());

  for (let start = 0; start < 1024; start += 64) {
    await Promise.all(Array.from({ length: 64 }, (_, offset) => writeFile(
      join(path, `.revision-0000000001.${String(start + offset)}.deadbeef.tmp`),
      "x",
      { mode: 0o600 },
    )));
  }

  try {
    await readRailwayMaintenanceState(root, path);
    throw new Error("expected Railway maintenance state read to reject an oversized directory");
  } catch (error) {
    expect(error).toBeInstanceOf(RailwayMaintenanceStateStoreError);
    expect((error as RailwayMaintenanceStateStoreError).code).toBe("state-too-large");
  }
}, 15_000);

function state(): RailwayMaintenanceState {
  const now = "2026-08-11T08:00:00.000Z";
  return {
    schemaVersion: 1,
    revision: 0,
    maintenanceId: "maintenance-1",
    sourceLaunchId: "launch-1",
    authorityGenerationId: "authority-generation-1",
    sourceManagedWorkbenchHostname: "source.example.test",
    sourceLaunchState: {
      schemaVersion: 1,
      launchId: "launch-1",
      releaseId: "release-source",
      providers: [],
      target: {
        workspaceId: "workspace-1",
        projectName: "source-project",
        environmentName: "production",
      },
      reconcile: {
        receipt: {
          schemaVersion: 1,
          launchId: "launch-1",
          backend: "railway",
          revision: 1,
          stage: "authorized",
          resources: [
            { kind: "railway.project", id: "project-1", name: "source-project" },
            { kind: "railway.environment", id: "environment-1", name: "production" },
            { kind: "railway.service", id: "source-logto-service-1", name: "logto" },
            { kind: "railway.service", id: "nautilo-service-1", name: "nautilo-server" },
            { kind: "railway.volume", id: "source-volume-1", name: "nautilo-data" },
            { kind: "railway.domain", id: "source-domain-1", name: "nautilo-public" },
          ],
          cleanup: { state: "not-required" },
          createdAt: now,
          updatedAt: now,
        },
      },
    },
    maintenanceReceipt: createMaintenanceReceipt({
      maintenanceId: "maintenance-1",
      launchId: "launch-1",
      backend: "railway",
      sourceReleaseId: "release-source",
      targetReleaseId: "release-target",
      now,
    }),
  };
}
