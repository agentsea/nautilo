import { describe, expect, test } from "bun:test";

import {
  RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES,
  RailwayPortableMaintenanceCleanup,
  type RailwayPortableMaintenanceCleanupCheckpoint,
  type RailwayPortableMaintenanceCleanupExecutor,
} from "../../src/portable-maintenance-cleanup";
import type { RailwayServiceInstance } from "../../src/operations";

const image = `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`;
const command = "bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts export operation-1 object-1";
const FORBIDDEN = "postgres://owner:SECRET@example.test/private";

class FixtureExecutor implements RailwayPortableMaintenanceCleanupExecutor {
  readonly events: string[] = [];
  startCommand: string | null = command;
  source: RailwayServiceInstance["source"] = { image, repo: null };
  deleteResponseLossAt?: number;
  resetResponseLoss = false;
  deletes = 0;

  async getServiceInstance() {
    this.events.push(`instance:${this.startCommand ?? "null"}`);
    return { id: "instance-1", serviceId: "service-1", environmentId: "environment-1", source: this.source, startCommand: this.startCommand };
  }
  async deleteVariable(input: Parameters<RailwayPortableMaintenanceCleanupExecutor["deleteVariable"]>[0]) {
    this.events.push(`delete:${input.name}`);
    const index = this.deletes;
    this.deletes += 1;
    if (this.deleteResponseLossAt === index) throw new Error(FORBIDDEN);
  }
  async setServiceStartCommand() {
    this.events.push("reset");
    this.startCommand = null;
    if (this.resetResponseLoss) throw new Error(FORBIDDEN);
  }
}

function fixture(executor = new FixtureExecutor()) {
  let durable: RailwayPortableMaintenanceCleanupCheckpoint | undefined;
  let complete = true;
  let failPersistAfterDelete: number | undefined;
  let failedPersist = false;
  const cleanup = new RailwayPortableMaintenanceCleanup({
    binding: {
      projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", image,
      direction: "export", operationId: "operation-1", objectId: "object-1", command,
    },
    executor,
    durableTransferComplete: async ({ operationId }) => {
      executor.events.push(`proof:${operationId}`);
      return complete;
    },
    persistCheckpoint: async (checkpoint) => {
      executor.events.push(`persist:${checkpoint.state}:${checkpoint.completedDeletes}`);
      durable = structuredClone(checkpoint);
      if (!failedPersist && checkpoint.state === "deleting" && checkpoint.completedDeletes === failPersistAfterDelete) {
        failedPersist = true;
        throw new Error(FORBIDDEN);
      }
    },
  });
  return {
    cleanup, executor,
    durable: () => durable,
    setComplete: (value: boolean) => { complete = value; },
    failPersistAfterDelete: (index: number) => { failPersistAfterDelete = index; },
  };
}

describe("RailwayPortableMaintenanceCleanup", () => {
  test("requires durable transfer completion, deletes all 12 exact variables, then observes the null reset", async () => {
    const value = fixture();
    const result = await value.cleanup.run();
    expect(result.outcome).toBe("complete");
    const deletes = value.executor.events.filter((event) => event.startsWith("delete:")).map((event) => event.slice("delete:".length));
    expect(deletes).toEqual([...RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES]);
    expect(value.executor.events.indexOf("proof:operation-1")).toBeLessThan(value.executor.events.indexOf(`delete:${RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES[0]}`));
    expect(value.executor.events.indexOf(`delete:${RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES[11]}`)).toBeLessThan(value.executor.events.indexOf("reset"));
    expect(value.executor.events).toContain("instance:null");
    expect(result.outcome === "complete" && value.cleanup.allowsContinuation(result.checkpoint)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("NAUTILO_RECOVERY_S3_SECRET_ACCESS_KEY");
    expect(JSON.stringify(result)).not.toContain(FORBIDDEN);
  });

  test("fails closed before any provider mutation when the durable coordinator proof is incomplete", async () => {
    const value = fixture(); value.setComplete(false);
    const result = await value.cleanup.run();
    expect(result).toEqual({ outcome: "failure", code: "transfer-incomplete" });
    expect(value.executor.events).toEqual(["proof:operation-1"]);
    expect(value.cleanup.allowsContinuation(undefined)).toBe(false);
  });

  test.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "resumes after the confirmed completion checkpoint for delete %i without replaying earlier deletes",
    async (completed) => {
      const value = fixture(); value.failPersistAfterDelete(completed);
      const interrupted = await value.cleanup.run();
      expect(interrupted).toMatchObject({ outcome: "failure", code: "cleanup-pending" });
      const checkpoint = value.durable();
      expect(checkpoint).toMatchObject({ state: "deleting", completedDeletes: completed });
      const resumed = await value.cleanup.run(checkpoint);
      expect(resumed.outcome).toBe("complete");
      const names = value.executor.events.filter((event) => event.startsWith("delete:")).map((event) => event.slice(7));
      for (const name of RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES) expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
    },
  );

  test("retains delete-pending after response loss and never resets or replays the uncertain delete", async () => {
    const executor = new FixtureExecutor(); executor.deleteResponseLossAt = 4;
    const value = fixture(executor);
    const first = await value.cleanup.run();
    expect(first).toMatchObject({ outcome: "failure", code: "cleanup-pending", checkpoint: { state: "delete-pending", deleteIndex: 4 } });
    const checkpoint = value.durable();
    const deletesBefore = executor.events.filter((event) => event.startsWith("delete:")).length;
    const resumed = await value.cleanup.run(checkpoint);
    expect(resumed).toMatchObject({ outcome: "failure", code: "cleanup-pending" });
    expect(executor.events.filter((event) => event.startsWith("delete:")).length).toBe(deletesBefore);
    expect(executor.events).not.toContain("reset");
    expect(value.cleanup.allowsContinuation(checkpoint)).toBe(false);
  });

  test("recovers a lost reset response only by observing the exact null command", async () => {
    const executor = new FixtureExecutor(); executor.resetResponseLoss = true;
    const value = fixture(executor);
    const result = await value.cleanup.run();
    expect(result.outcome).toBe("complete");
    expect(executor.events.filter((event) => event === "reset")).toHaveLength(1);
    expect(executor.events).toContain("instance:null");
  });

  test("rejects source or command drift before cleanup and persists only redacted identity", async () => {
    const sourceDrift = fixture(); sourceDrift.executor.source = { image: `ghcr.io/nautilo/server@sha256:${"b".repeat(64)}`, repo: null };
    const sourceResult = await sourceDrift.cleanup.run();
    expect(sourceResult).toMatchObject({ outcome: "failure", code: "identity-drift" });
    expect(sourceDrift.executor.events.some((event) => event.startsWith("delete:"))).toBe(false);

    const commandDrift = fixture(); commandDrift.executor.startCommand = `${command} changed`;
    const commandResult = await commandDrift.cleanup.run();
    expect(commandResult).toMatchObject({ outcome: "failure", code: "identity-drift" });
    expect(commandDrift.executor.events.some((event) => event.startsWith("delete:"))).toBe(false);
    expect(JSON.stringify(commandResult)).not.toContain(command);
    expect(JSON.stringify(commandResult)).not.toContain(FORBIDDEN);
  });

  test("rejects an injected complete checkpoint that does not match the constructor binding", async () => {
    const value = fixture();
    const completed = await value.cleanup.run();
    if (completed.outcome !== "complete") throw new Error("unexpected incomplete cleanup");
    const forged = { ...completed.checkpoint, operationId: "operation-other", secret: FORBIDDEN };
    const result = await value.cleanup.run(forged as unknown as RailwayPortableMaintenanceCleanupCheckpoint);
    expect(result).toEqual({ outcome: "failure", code: "invalid-checkpoint" });
    expect(JSON.stringify(result)).not.toContain(FORBIDDEN);
    expect(value.cleanup.allowsContinuation(forged)).toBe(false);
    expect(value.cleanup.allowsContinuation(completed.checkpoint)).toBe(true);
  });
});
