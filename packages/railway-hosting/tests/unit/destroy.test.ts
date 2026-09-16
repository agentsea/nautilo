import { describe, expect, test } from "bun:test";

import type { LaunchReceipt } from "@nautilo/hosting";

import {
  destroyRailwayDeployment,
  isRailwayDestroyCheckpoint,
  isRailwayDestroyCheckpointTransition,
  RAILWAY_DESTROY_CHECKPOINT_SCHEMA_VERSION,
  type RailwayDestroyCheckpoint,
  type RailwayDestroyExecutor,
  type RailwayDestroyRequest,
} from "../../src/destroy";

const resources = [
  { kind: "railway.project", id: "project-1", name: "nautilo" },
  { kind: "railway.environment", id: "environment-1", name: "production" },
  { kind: "railway.service", id: "service-1", name: "nautilo-server" },
  { kind: "railway.volume", id: "volume-1", name: "nautilo-data" },
  { kind: "railway.domain", id: "domain-1", name: "nautilo-public" },
  { kind: "railway.variable-collection", id: "environment-1:service-1", name: "variables-nautilo-server" },
  { kind: "railway.deployment", id: "deployment-1", name: "nautilo-server" },
] as const;

function initialReceipt(): LaunchReceipt {
  return {
    schemaVersion: 1,
    launchId: "launch-1",
    backend: "railway",
    revision: 0,
    stage: "claimable",
    resources,
    cleanup: { state: "not-required" },
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    claimableAt: "2026-08-04T00:00:00.000Z",
  };
}

interface Harness {
  readonly request: () => RailwayDestroyRequest;
  readonly calls: string[];
  readonly checkpoints: RailwayDestroyCheckpoint[];
  readonly inventoryCalls: () => number;
}

function harness(options: {
  readonly projectPersists?: boolean;
  readonly foreign?: readonly { readonly kind: string; readonly id: string }[];
  readonly absentDomain?: boolean;
  readonly inventoryFailsOnce?: boolean;
  readonly persistFailsOnce?: boolean;
  readonly persistFailsAfterDomainDeleteOnce?: boolean;
} = {}): Harness {
  let checkpoint: RailwayDestroyCheckpoint = {
    schemaVersion: RAILWAY_DESTROY_CHECKPOINT_SCHEMA_VERSION,
    receipt: initialReceipt(),
    stage: "validate",
  };
  const key = (kind: string, id: string): string => `${kind}\u0000${id}`;
  const present = new Set(resources.map((resource) => key(resource.kind, resource.id)));
  const calls: string[] = [];
  const checkpoints: RailwayDestroyCheckpoint[] = [];
  let inventoryCalls = 0;
  let inventoryFailure = options.inventoryFailsOnce === true;
  let persistenceFailure = options.persistFailsOnce === true;
  let persistenceFailureAfterDomainDelete = options.persistFailsAfterDomainDeleteOnce === true;
  let tick = 0;
  const remove = (kind: string, id: string): void => { present.delete(key(kind, id)); };
  const executor: RailwayDestroyExecutor = {
    deleteDomain: async ({ domainId }) => {
      calls.push(`domain:${domainId}`);
      if (options.absentDomain) {
        remove("railway.domain", domainId);
        throw new Error("already absent");
      }
      remove("railway.domain", domainId);
      if (persistenceFailureAfterDomainDelete) {
        persistenceFailureAfterDomainDelete = false;
        persistenceFailure = true;
      }
    },
    deleteVolume: async ({ volumeId }) => { calls.push(`volume:${volumeId}`); remove("railway.volume", volumeId); },
    deleteService: async ({ serviceId }) => {
      calls.push(`service:${serviceId}`);
      remove("railway.service", serviceId);
      remove("railway.variable-collection", "environment-1:service-1");
      remove("railway.deployment", "deployment-1");
    },
    deleteProject: async ({ projectId }) => {
      calls.push(`project:${projectId}`);
      if (!options.projectPersists) present.clear();
    },
    getProject: async ({ projectId }) => present.has(key("railway.project", projectId))
      ? { id: projectId, name: "nautilo", workspaceId: "workspace-1" }
      : null,
    inventoryProjectResources: async () => {
      inventoryCalls += 1;
      if (inventoryFailure) { inventoryFailure = false; throw new Error("lost inventory response"); }
      return [...[...present].map((entry) => {
        const separator = entry.indexOf("\u0000");
        return { kind: entry.slice(0, separator), id: entry.slice(separator + 1) };
      }),
      ...(options.foreign ?? [])];
    },
    inventoryReceiptResources: async ({ resources: known }) => known
      .filter((resource) => present.has(key(resource.kind, resource.id)))
      .map((resource) => ({ kind: resource.kind, id: resource.id })),
  };
  return {
    calls,
    checkpoints,
    inventoryCalls: () => inventoryCalls,
    request: () => ({
      checkpoint,
      confirmProjectId: "project-1",
      executor,
      poll: { maxAttempts: 2 },
      now: () => `2026-08-04T00:00:${String(++tick).padStart(2, "0")}.000Z`,
      persistCheckpoint: async (next) => {
        if (persistenceFailure) { persistenceFailure = false; throw new Error("lost persistence response"); }
        checkpoint = next; checkpoints.push(next);
      },
    }),
  };
}

describe("destroyRailwayDeployment", () => {
  test("exports strict checkpoint and transition validation for durable teardown custody", async () => {
    const subject = harness();
    const initial = subject.request().checkpoint;
    const result = await destroyRailwayDeployment(subject.request());
    expect(result.outcome).toBe("complete");
    const chain = [initial, ...subject.checkpoints];
    expect(chain.every((checkpoint) => isRailwayDestroyCheckpoint(checkpoint, initial.receipt))).toBe(true);
    expect(chain.slice(1).every((checkpoint, index) => isRailwayDestroyCheckpointTransition(chain[index]!, checkpoint))).toBe(true);
    expect(isRailwayDestroyCheckpoint({ ...initial, unexpected: true }, initial.receipt)).toBe(false);
    expect(isRailwayDestroyCheckpoint({ ...initial, pending: {
      action: "volume-delete",
      resource: { kind: "railway.domain", id: "domain-1", name: "nautilo-public" },
    }, stage: "volume" }, initial.receipt)).toBe(false);
    expect(isRailwayDestroyCheckpointTransition(initial, result.checkpoint)).toBe(false);
  });
  test("requires exact project confirmation before it persists or deletes", async () => {
    const subject = harness();
    const result = await destroyRailwayDeployment({ ...subject.request(), confirmProjectId: "project-other" });

    expect(result).toMatchObject({ outcome: "failure", stage: "confirm", code: "confirmation-required" });
    expect(subject.calls).toEqual([]);
    expect(subject.checkpoints).toEqual([]);
  });

  test("uses receipt IDs in dependency order, checkpoints progress, and verifies zero survivors", async () => {
    const subject = harness();
    const result = await destroyRailwayDeployment(subject.request());

    expect(result.outcome).toBe("complete");
    expect(subject.calls).toEqual(["domain:domain-1", "service:service-1", "volume:volume-1", "project:project-1"]);
    const states = subject.checkpoints.map((entry) => entry.receipt.cleanup.state);
    expect(states.includes("pending")).toBe(true);
    expect(states.includes("in-progress")).toBe(true);
    expect(states.includes("verified")).toBe(true);
    if (result.outcome === "complete") {
      expect(result.checkpoint.receipt.resources).toEqual([]);
      expect(result.checkpoint.receipt.cleanup.state).toBe("verified");
    }
  });

  test("handles a receipt-owned resource already absent without name adoption", async () => {
    const subject = harness({ absentDomain: true });
    const result = await destroyRailwayDeployment(subject.request());

    expect(result.outcome).toBe("complete");
    expect(subject.calls[0]).toBe("domain:domain-1");
  });

  test("returns pending when asynchronous project deletion exceeds caller observation bounds", async () => {
    const subject = harness({ projectPersists: true });
    const result = await destroyRailwayDeployment({ ...subject.request(), poll: { maxAttempts: 1 } });

    expect(result).toMatchObject({ outcome: "pending", stage: "verify-project-absent" });
    expect(subject.calls).toContain("project:project-1");
  });

  test("fences every foreign billable child before deleting any exact owned resource", async () => {
    for (const foreign of [
      { kind: "railway.service", id: "foreign-service" },
      { kind: "railway.deployment", id: "foreign-deployment" },
      { kind: "railway.volume", id: "foreign-volume" },
      { kind: "railway.domain", id: "foreign-domain" },
    ]) {
      const subject = harness({ foreign: [foreign] });
      const result = await destroyRailwayDeployment(subject.request());
      expect(result).toMatchObject({ outcome: "failure", stage: "validate", code: "unknown-project-resource" });
      expect(subject.calls).toEqual([]);
      expect(subject.checkpoints).toEqual([]);
      expect(subject.inventoryCalls()).toBe(1);
    }
  });

  test("re-runs the complete billing fence after inventory or checkpoint persistence loss", async () => {
    const inventoryLoss = harness({ inventoryFailsOnce: true });
    expect(await destroyRailwayDeployment(inventoryLoss.request())).toMatchObject({ outcome: "failure", code: "executor-failure" });
    expect(inventoryLoss.calls).toEqual([]);
    expect((await destroyRailwayDeployment(inventoryLoss.request())).outcome).toBe("complete");
    expect(inventoryLoss.inventoryCalls()).toBeGreaterThanOrEqual(2);

    const persistenceLoss = harness({ persistFailsOnce: true });
    expect(await destroyRailwayDeployment(persistenceLoss.request())).toMatchObject({ outcome: "failure", code: "persistence-failure" });
    expect(persistenceLoss.calls).toEqual([]);
    expect((await destroyRailwayDeployment(persistenceLoss.request())).outcome).toBe("complete");
    expect(persistenceLoss.inventoryCalls()).toBeGreaterThanOrEqual(2);
  });

  test("resumes a failed action-specific delete checkpoint without producing an invalid stage", async () => {
    const subject = harness({ persistFailsAfterDomainDeleteOnce: true });
    const interrupted = await destroyRailwayDeployment(subject.request());
    expect(interrupted).toMatchObject({ outcome: "failure", stage: "domain", code: "persistence-failure" });
    expect(interrupted.checkpoint).toMatchObject({ stage: "domain", pending: { action: "domain-delete" }, receipt: { cleanup: { state: "failed" } } });

    const resumed = await destroyRailwayDeployment(subject.request());
    expect(resumed.outcome).toBe("complete");
    expect(subject.calls.filter((call) => call === "domain:domain-1")).toHaveLength(2);
    expect(subject.checkpoints.every((checkpoint) => isRailwayDestroyCheckpoint(checkpoint))).toBe(true);
  });
});
