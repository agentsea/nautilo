import { describe, expect, test } from "bun:test";

import type { CapabilityStatus, LaunchReceipt } from "@nautilo/hosting";

import { inspectRailwayDeployment, type RailwayInspectExecutor } from "../../src/inspect";

function receipt(resources: LaunchReceipt["resources"]): LaunchReceipt {
  return {
    schemaVersion: 1,
    launchId: "launch-1",
    backend: "railway",
    revision: 1,
    stage: "claimable",
    resources,
    cleanup: { state: "not-required" },
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:01.000Z",
    claimableAt: "2026-08-04T00:00:01.000Z",
  };
}

const capabilities: readonly CapabilityStatus[] = [
  "chat", "embeddings", "search", "tts", "stt",
].map((capability) => ({
  capability: capability as CapabilityStatus["capability"],
  experience: "baseline" as const,
  impact: "qualified",
  repairTarget: { kind: "admin-providers" as const },
}));

function executor(overrides: Partial<RailwayInspectExecutor> = {}): RailwayInspectExecutor {
  return {
    getProject: async ({ projectId }) => ({ id: projectId, name: "nautilo", workspaceId: "workspace-1" }),
    getEnvironment: async ({ environmentId }) => ({ id: environmentId, name: "production" }),
    listServices: async () => [{ id: "service-1", name: "nautilo-server" }],
    getVolume: async ({ volumeId }) => ({ id: volumeId, name: "volume", projectId: "project-1" }),
    listVolumeInstances: async () => [{ id: "instance-1", volumeId: "volume-1", serviceId: "service-1", mountPath: "/data" }],
    listDomains: async () => [{ id: "domain-1", domain: "nautilo.railway.app", targetPort: 3001 }],
    getDeployment: async ({ deploymentId }) => ({ id: deploymentId, status: "SUCCESS" }),
    ...overrides,
  };
}

const completeResources = [
  { kind: "railway.project", id: "project-1", name: "nautilo" },
  { kind: "railway.environment", id: "environment-1", name: "production" },
  { kind: "railway.service", id: "service-1", name: "nautilo-server" },
  { kind: "railway.volume", id: "volume-1", name: "nautilo-data" },
  { kind: "railway.domain", id: "domain-1", name: "nautilo-public" },
  { kind: "railway.deployment", id: "deployment-1", name: "nautilo-server" },
  { kind: "railway.variable-collection", id: "environment-1:service-1", name: "variables-nautilo-server" },
] as const;

describe("inspectRailwayDeployment", () => {
  test("keeps a claimable, degraded instance separate from optional enhancement warnings", async () => {
    const result = await inspectRailwayDeployment({
      receipt: receipt(completeResources),
      executor: executor(),
      readiness: {
        coreReadiness: "degraded",
        capabilities,
        notices: [{
          severity: "warning",
          code: "hosting.optional-enhancement-unavailable",
          message: "Optional voice enhancement is absent.",
          capability: "tts",
          repairTarget: { kind: "admin-providers", capability: "tts" },
        }],
      },
    });

    expect(result.snapshot.infrastructure).toBe("claimable");
    expect(result.snapshot.coreReadiness).toBe("degraded");
    expect(result.snapshot.notices.some((item) => item.code === "hosting.optional-enhancement-unavailable")).toBe(true);
    expect(result.resources.find((entry) => entry.resource.kind === "railway.variable-collection")).toMatchObject({ state: "not-observable" });
  });

  test("keeps optional enhancement warning from degrading a baseline-ready instance", async () => {
    const result = await inspectRailwayDeployment({
      receipt: receipt(completeResources),
      executor: executor(),
      readiness: {
        coreReadiness: "useful-ready",
        capabilities,
        notices: [{
          severity: "warning",
          code: "hosting.optional-enhancement-unavailable",
          message: "Optional search enhancement is absent.",
          capability: "search",
          repairTarget: { kind: "admin-providers", capability: "search" },
        }],
      },
    });

    expect(result.snapshot).toMatchObject({ infrastructure: "claimable", coreReadiness: "useful-ready" });
    expect(result.snapshot.notices.some((item) => item.code === "hosting.optional-enhancement-unavailable")).toBe(true);
    expect(result.resources.filter((entry) => entry.state === "present")).toHaveLength(6);
  });

  test("types missing and drifted resources without adopting a same-name resource", async () => {
    const result = await inspectRailwayDeployment({
      receipt: receipt(completeResources),
      executor: executor({
        listServices: async () => [{ id: "other-service", name: "nautilo-server" }],
        listVolumeInstances: async () => [],
        getDeployment: async () => null,
      }),
      readiness: { coreReadiness: "useful-ready", capabilities },
    });

    expect(result.snapshot.infrastructure).toBe("failed");
    expect(result.resources.find((item) => item.resource.kind === "railway.service" && item.resource.id === "service-1")?.state).toBe("missing");
    const volume = result.resources.find((item) => item.resource.kind === "railway.volume" && item.resource.id === "volume-1");
    expect(volume?.state).toBe("drifted");
    expect(volume?.drift).toEqual(["mount"]);
    expect(result.resources.find((item) => item.resource.kind === "railway.deployment" && item.resource.id === "deployment-1")?.state).toBe("missing");
  });
});
