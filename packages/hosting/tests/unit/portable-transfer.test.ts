import { describe, expect, test } from "bun:test";

import {
  PortableTransferCoordinator,
  type MaintenanceProviderWorkflowCheckpoint,
  type PortableTransferJobObservation,
  type PortableTransferTarget,
} from "../../src";

const completedAt = "2026-08-11T10:00:00.000Z";
const digest = "a".repeat(64);
const authority = {
  endpoint: "https://objects.example.test",
  region: "test-1",
  bucket: "nautilo-recovery",
  accessKeyId: "request-only-access",
  secretAccessKey: "request-only-secret",
  encryptionKey: new Uint8Array(32).fill(7),
} as const;

class MemoryTarget implements PortableTransferTarget {
  readonly calls: string[] = [];
  readonly jobs = new Map<string, string>();
  readonly observations: PortableTransferJobObservation[] = [];
  failStartAfterCommit = false;

  async find(operationId: string) {
    this.calls.push(`find:${operationId}`);
    const jobId = this.jobs.get(operationId);
    return jobId === undefined ? undefined : { jobId };
  }

  async startExport(input: { readonly operationId: string }) {
    this.calls.push(`start-export:${input.operationId}`);
    this.jobs.set(input.operationId, "job-export-1");
    if (this.failStartAfterCommit) throw new Error("provider body must not escape");
    return { jobId: "job-export-1" };
  }

  async startRestore(input: { readonly operationId: string }) {
    this.calls.push(`start-restore:${input.operationId}`);
    this.jobs.set(input.operationId, "job-restore-1");
    return { jobId: "job-restore-1" };
  }

  async observe(jobId: string) {
    this.calls.push(`observe:${jobId}`);
    return this.observations.shift() ?? { state: "not-found" as const };
  }
}

function subject(target: MemoryTarget, checkpoints: MaintenanceProviderWorkflowCheckpoint[]) {
  return new PortableTransferCoordinator({
    target,
    persistWorkflow: (checkpoint) => {
      checkpoints.push(checkpoint);
      return Promise.resolve();
    },
    scheduler: { wait: () => Promise.resolve() },
    intervalMs: 0,
    maxAttempts: 3,
  });
}

describe("portable transfer coordinator", () => {
  test("exports target-to-object-storage and checkpoints before polling without persisting authority", async () => {
    const target = new MemoryTarget();
    const checkpoints: MaintenanceProviderWorkflowCheckpoint[] = [];
    target.observations.push(
      { state: "running" },
      { state: "complete", objectId: "object-1", sha256: digest, completedAt },
    );

    const result = await subject(target, checkpoints).export({
      operationId: "maintenance-1-export",
      objectId: "object-1",
      authority,
    });

    expect(result).toEqual({
      outcome: "complete",
      checkpoint: { objectId: "object-1", sha256: digest, completedAt },
    });
    expect(target.calls).toEqual([
      "find:maintenance-1-export",
      "start-export:maintenance-1-export",
      "observe:job-export-1",
      "observe:job-export-1",
    ]);
    expect(checkpoints).toEqual([
      { operation: "export-portable", workflowId: "job-export-1", state: "pending" },
      {
        operation: "export-portable",
        workflowId: "job-export-1",
        state: "complete",
        completedAt,
      },
    ]);
    expect(JSON.stringify({ result, checkpoints })).not.toContain("request-only");
    expect(JSON.stringify({ result, checkpoints })).not.toContain("objects.example");
  });

  test("resumes an exact persisted job without finding or starting another export", async () => {
    const target = new MemoryTarget();
    const checkpoints: MaintenanceProviderWorkflowCheckpoint[] = [];
    target.observations.push({
      state: "complete",
      objectId: "object-1",
      sha256: digest,
      completedAt,
    });

    const result = await subject(target, checkpoints).export({
      operationId: "maintenance-1-export",
      objectId: "object-1",
      authority,
    }, "job-export-persisted");

    expect(result.outcome).toBe("complete");
    expect(target.calls).toEqual(["observe:job-export-persisted"]);
  });

  test("reobserves an ambiguous start once and never replays the mutation", async () => {
    const target = new MemoryTarget();
    const checkpoints: MaintenanceProviderWorkflowCheckpoint[] = [];
    target.failStartAfterCommit = true;
    target.observations.push({
      state: "complete",
      objectId: "object-1",
      sha256: digest,
      completedAt,
    });

    const result = await subject(target, checkpoints).export({
      operationId: "maintenance-1-export",
      objectId: "object-1",
      authority,
    });

    expect(result.outcome).toBe("complete");
    expect(target.calls.filter((call) => call.startsWith("start-export:"))).toHaveLength(1);
    expect(target.calls.filter((call) => call.startsWith("find:"))).toHaveLength(2);
  });

  test("restores object-storage-to-target and verifies exact object digest", async () => {
    const target = new MemoryTarget();
    const checkpoints: MaintenanceProviderWorkflowCheckpoint[] = [];
    target.observations.push({
      state: "complete",
      objectId: "object-1",
      sha256: digest,
      completedAt,
    });

    const result = await subject(target, checkpoints).restore({
      operationId: "maintenance-1-restore",
      objectId: "object-1",
      expectedSha256: digest,
      authority,
    });

    expect(result).toEqual({ outcome: "complete", completedAt });
    expect(checkpoints.map((checkpoint) => checkpoint.operation)).toEqual([
      "restore-portable",
      "restore-portable",
    ]);
  });

  test("fails closed on digest drift, insecure endpoints, and checkpoint failure", async () => {
    const drift = new MemoryTarget();
    drift.observations.push({
      state: "complete",
      objectId: "object-1",
      sha256: "b".repeat(64),
      completedAt,
    });
    expect(await subject(drift, []).restore({
      operationId: "maintenance-1-restore",
      objectId: "object-1",
      expectedSha256: digest,
      authority,
    })).toEqual({ outcome: "failure", code: "result-mismatch" });

    expect(await subject(new MemoryTarget(), []).export({
      operationId: "maintenance-1-export",
      objectId: "object-1",
      authority: { ...authority, endpoint: "http://objects.example.test" },
    })).toEqual({ outcome: "failure", code: "invalid-input" });

    const checkpointTarget = new MemoryTarget();
    checkpointTarget.observations.push({ state: "running" });
    const checkpointFailure = new PortableTransferCoordinator({
      target: checkpointTarget,
      persistWorkflow: () => Promise.reject(new Error("disk detail must not escape")),
      scheduler: { wait: () => Promise.resolve() },
      intervalMs: 0,
      maxAttempts: 1,
    });
    expect(await checkpointFailure.export({
      operationId: "maintenance-1-export",
      objectId: "object-1",
      authority,
    })).toEqual({ outcome: "failure", code: "checkpoint-failed" });
    expect(checkpointTarget.calls.some((call) => call.startsWith("observe:"))).toBe(false);
  });
});
