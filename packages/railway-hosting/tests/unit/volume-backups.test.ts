import { describe, expect, test } from "bun:test";

import {
  createRailwayMaintenanceBackupSet,
  RailwayVolumeBackupExecutor,
  type RailwayExecutorTransport,
  type RailwayGraphqlVariables,
  type RailwayOperation,
  type RailwayOperationData,
  type RailwayOperationVariables,
  type RailwayTransportResult,
} from "../../src";

interface ScriptStep {
  readonly operation: string;
  readonly data?: unknown;
  readonly failure?: true;
}

class ScriptedTransport implements RailwayExecutorTransport {
  readonly calls: { readonly operation: string; readonly variables: unknown }[] = [];
  readonly #steps: ScriptStep[];

  constructor(steps: readonly ScriptStep[]) {
    this.#steps = [...steps];
  }

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ operation: operation.name, variables });
    const step = this.#steps.shift();
    if (step?.operation !== operation.name) {
      throw new Error(`expected ${step?.operation ?? "no operation"}, received ${operation.name}`);
    }
    if (step.failure) {
      return {
        outcome: "failure",
        failure: { kind: "network-failure", operation: operation.name },
      } as RailwayTransportResult<RailwayOperationData<Operation>>;
    }
    return {
      outcome: "success",
      data: step.data,
      metadata: { httpStatus: 200, rateLimit: {} },
    } as RailwayTransportResult<RailwayOperationData<Operation>>;
  }

  expectConsumed(): void {
    expect(this.#steps).toEqual([]);
  }
}

const backup = (id: string, name: string, expiresAt: string | null = null) => ({
  id,
  name,
  createdAt: "2026-08-11T08:00:00.000Z",
  expiresAt,
  usedMB: 10,
  referencedMB: 20,
});

const list = (backups: readonly unknown[]) => ({ volumeInstanceBackupList: backups });
const workflow = (status: "Complete" | "Error" | "NotFound" | "Running") => ({
  workflowStatus: {
    status,
    ...(status === "Error" ? { error: "provider detail must not escape" } : {}),
  },
});
const deployment = (id: string, stopped: boolean) => ({
  deployment: {
    id,
    status: "SUCCESS",
    deploymentStopped: stopped,
    instances: [],
  },
});
const persistWorkflow = async (): Promise<void> => undefined;

describe("Railway volume maintenance", () => {
  test("creates, polls, discovers, and locks one deterministically named backup", async () => {
    const workflowId = "createVolumeInstanceBackup/6933dffa-acca-4079-98ab-99985c844f46";
    const waits: number[] = [];
    const checkpoints: unknown[] = [];
    const transport = new ScriptedTransport([
      { operation: "RailwayVolumeInstanceBackupList", data: list([]) },
      {
        operation: "RailwayVolumeInstanceBackupCreate",
        data: { volumeInstanceBackupCreate: { workflowId } },
      },
      { operation: "RailwayWorkflowStatus", data: workflow("Running") },
      { operation: "RailwayWorkflowStatus", data: workflow("Complete") },
      {
        operation: "RailwayVolumeInstanceBackupList",
        data: list([backup("backup-app-1", "nautilo-maintenance-app")]),
      },
      {
        operation: "RailwayVolumeInstanceBackupLock",
        data: { volumeInstanceBackupLock: true },
      },
    ]);
    const executor = new RailwayVolumeBackupExecutor({
      transport,
      persistWorkflow: async (checkpoint) => { checkpoints.push(checkpoint); },
      scheduler: { async wait(milliseconds) { waits.push(milliseconds); } },
      poll: { intervalMs: 25, maxAttempts: 3 },
    });

    expect(await executor.createAndLock({
      volumeInstanceId: "volume-app-1",
      name: "nautilo-maintenance-app",
      workflowOperation: "backup-application-postgres",
    })).toEqual({
      outcome: "complete",
      value: backup("backup-app-1", "nautilo-maintenance-app"),
    });
    expect(waits).toEqual([25]);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toEqual({
      operation: "backup-application-postgres",
      workflowId,
      state: "pending",
    });
    expect(checkpoints[1]).toMatchObject({
      operation: "backup-application-postgres",
      workflowId,
      state: "complete",
    });
    expect(
      typeof checkpoints[1] === "object" && checkpoints[1] !== null
        && "completedAt" in checkpoints[1]
        ? checkpoints[1].completedAt
        : undefined,
    ).toBeString();
    expect(transport.calls[1]).toEqual({
      operation: "RailwayVolumeInstanceBackupCreate",
      variables: {
        volumeInstanceId: "volume-app-1",
        name: "nautilo-maintenance-app",
      },
    });
    transport.expectConsumed();
  });

  test("resumes from an existing named backup without replaying create", async () => {
    const existing = backup("backup-app-1", "nautilo-maintenance-app");
    const transport = new ScriptedTransport([
      { operation: "RailwayVolumeInstanceBackupList", data: list([existing]) },
      {
        operation: "RailwayVolumeInstanceBackupLock",
        data: { volumeInstanceBackupLock: true },
      },
    ]);
    const executor = new RailwayVolumeBackupExecutor({ transport, persistWorkflow });

    expect(await executor.createAndLock({
      volumeInstanceId: "volume-app-1",
      name: "nautilo-maintenance-app",
      workflowOperation: "backup-application-postgres",
    })).toEqual({ outcome: "complete", value: existing });
    expect(transport.calls.map((call) => call.operation)).toEqual([
      "RailwayVolumeInstanceBackupList",
      "RailwayVolumeInstanceBackupLock",
    ]);
  });

  test("resumes a persisted pending backup workflow without issuing another create", async () => {
    const checkpoints: unknown[] = [];
    const existing = backup("backup-app-1", "nautilo-maintenance-app");
    const transport = new ScriptedTransport([
      { operation: "RailwayWorkflowStatus", data: workflow("Complete") },
      { operation: "RailwayVolumeInstanceBackupList", data: list([existing]) },
      {
        operation: "RailwayVolumeInstanceBackupLock",
        data: { volumeInstanceBackupLock: true },
      },
    ]);
    const executor = new RailwayVolumeBackupExecutor({
      transport,
      persistWorkflow: async (checkpoint) => { checkpoints.push(checkpoint); },
    });

    expect(await executor.createAndLock({
      volumeInstanceId: "volume-app-1",
      name: "nautilo-maintenance-app",
      workflowOperation: "backup-application-postgres",
      workflowId: "workflow-app-1",
    })).toEqual({ outcome: "complete", value: existing });
    expect(transport.calls.map((call) => call.operation)).toEqual([
      "RailwayWorkflowStatus",
      "RailwayVolumeInstanceBackupList",
      "RailwayVolumeInstanceBackupLock",
    ]);
    expect(checkpoints[0]).toMatchObject({
      operation: "backup-application-postgres",
      workflowId: "workflow-app-1",
      state: "complete",
    });
  });

  test("recovers a persisted workflow from its exact named backup when status is unauthorized", async () => {
    const workflowId = "createVolumeInstanceBackup/6933dffa-acca-4079-98ab-99985c844f46";
    const checkpoints: unknown[] = [];
    const existing = backup("backup-app-1", "nautilo-maintenance-app");
    const transport = new ScriptedTransport([
      { operation: "RailwayWorkflowStatus", failure: true },
      { operation: "RailwayVolumeInstanceBackupList", data: list([existing]) },
      {
        operation: "RailwayVolumeInstanceBackupLock",
        data: { volumeInstanceBackupLock: true },
      },
    ]);
    const executor = new RailwayVolumeBackupExecutor({
      transport,
      persistWorkflow: async (checkpoint) => { checkpoints.push(checkpoint); },
    });

    expect(await executor.createAndLock({
      volumeInstanceId: "volume-app-1",
      name: "nautilo-maintenance-app",
      workflowOperation: "backup-application-postgres",
      workflowId,
    })).toEqual({ outcome: "complete", value: existing });
    expect(transport.calls.map((call) => call.operation)).toEqual([
      "RailwayWorkflowStatus",
      "RailwayVolumeInstanceBackupList",
      "RailwayVolumeInstanceBackupLock",
    ]);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      operation: "backup-application-postgres",
      workflowId,
      state: "complete",
    });
  });

  test("fails closed on ambiguous create, restore, and provider workflow errors", async () => {
    const createTransport = new ScriptedTransport([
      { operation: "RailwayVolumeInstanceBackupList", data: list([]) },
      { operation: "RailwayVolumeInstanceBackupCreate", failure: true },
    ]);
    const createExecutor = new RailwayVolumeBackupExecutor({
      transport: createTransport,
      persistWorkflow,
    });
    expect(await createExecutor.createAndLock({
      volumeInstanceId: "volume-app-1",
      name: "nautilo-maintenance-app",
      workflowOperation: "backup-application-postgres",
    })).toEqual({ outcome: "failure", code: "create-unknown" });
    expect(createTransport.calls).toHaveLength(2);

    const restoreTransport = new ScriptedTransport([
      {
        operation: "RailwayVolumeInstanceBackupList",
        data: list([backup("backup-app-1", "nautilo-maintenance-app")]),
      },
      { operation: "RailwayVolumeInstanceBackupRestore", failure: true },
    ]);
    const restoreExecutor = new RailwayVolumeBackupExecutor({
      transport: restoreTransport,
      persistWorkflow,
    });
    expect(await restoreExecutor.restore({
      volumeInstanceId: "volume-app-1",
      backupId: "backup-app-1",
      workflowOperation: "restore-application-postgres",
    })).toEqual({ outcome: "failure", code: "restore-unknown" });
    expect(restoreTransport.calls).toHaveLength(2);

    const workflowTransport = new ScriptedTransport([
      { operation: "RailwayVolumeInstanceBackupList", data: list([]) },
      {
        operation: "RailwayVolumeInstanceBackupCreate",
        data: { volumeInstanceBackupCreate: { workflowId: "workflow-app-1" } },
      },
      { operation: "RailwayWorkflowStatus", data: workflow("Error") },
    ]);
    const workflowExecutor = new RailwayVolumeBackupExecutor({
      transport: workflowTransport,
      persistWorkflow,
    });
    const result = await workflowExecutor.createAndLock({
      volumeInstanceId: "volume-app-1",
      name: "nautilo-maintenance-app",
      workflowOperation: "backup-application-postgres",
    });
    expect(result).toEqual({ outcome: "failure", code: "workflow-error" });
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  test("persists the provider workflow before polling or discovering its backup", async () => {
    const transport = new ScriptedTransport([
      { operation: "RailwayVolumeInstanceBackupList", data: list([]) },
      {
        operation: "RailwayVolumeInstanceBackupCreate",
        data: { volumeInstanceBackupCreate: { workflowId: "workflow-app-1" } },
      },
    ]);
    const executor = new RailwayVolumeBackupExecutor({
      transport,
      persistWorkflow: async () => { throw new Error("receipt unavailable"); },
    });

    expect(await executor.createAndLock({
      volumeInstanceId: "volume-app-1",
      name: "nautilo-maintenance-app",
      workflowOperation: "backup-application-postgres",
    })).toEqual({ outcome: "failure", code: "checkpoint-failed" });
    expect(transport.calls.map((call) => call.operation)).toEqual([
      "RailwayVolumeInstanceBackupList",
      "RailwayVolumeInstanceBackupCreate",
    ]);
    transport.expectConsumed();
  });

  test("restores only a backup observed on the exact volume and polls its workflow", async () => {
    const transport = new ScriptedTransport([
      {
        operation: "RailwayVolumeInstanceBackupList",
        data: list([backup("backup-app-1", "nautilo-maintenance-app")]),
      },
      {
        operation: "RailwayVolumeInstanceBackupRestore",
        data: { volumeInstanceBackupRestore: { workflowId: "restore-app-1" } },
      },
      { operation: "RailwayWorkflowStatus", data: workflow("Complete") },
    ]);
    const executor = new RailwayVolumeBackupExecutor({ transport, persistWorkflow });

    expect(await executor.restore({
      volumeInstanceId: "volume-app-1",
      backupId: "backup-app-1",
      workflowOperation: "restore-application-postgres",
    })).toEqual({ outcome: "complete", value: true });
    expect(transport.calls[1]).toEqual({
      operation: "RailwayVolumeInstanceBackupRestore",
      variables: {
        volumeInstanceBackupId: "backup-app-1",
        volumeInstanceId: "volume-app-1",
      },
    });
  });

  test("resumes a persisted pending restore workflow without restoring twice", async () => {
    const transport = new ScriptedTransport([
      {
        operation: "RailwayVolumeInstanceBackupList",
        data: list([backup("backup-app-1", "nautilo-maintenance-app")]),
      },
      { operation: "RailwayWorkflowStatus", data: workflow("Complete") },
    ]);
    const executor = new RailwayVolumeBackupExecutor({ transport, persistWorkflow });

    expect(await executor.restore({
      volumeInstanceId: "volume-app-1",
      backupId: "backup-app-1",
      workflowOperation: "restore-application-postgres",
      workflowId: "restore-app-1",
    })).toEqual({ outcome: "complete", value: true });
    expect(transport.calls.map((call) => call.operation)).toEqual([
      "RailwayVolumeInstanceBackupList",
      "RailwayWorkflowStatus",
    ]);
  });

  test("quiesces application then Logto before taking the three locked backups", async () => {
    const steps: ScriptStep[] = [
      { operation: "RailwayDeployment", data: deployment("deployment-app", false) },
      { operation: "RailwayDeploymentStop", data: { deploymentStop: true } },
      { operation: "RailwayDeployment", data: deployment("deployment-app", true) },
      { operation: "RailwayDeployment", data: deployment("deployment-logto", false) },
      { operation: "RailwayDeploymentStop", data: { deploymentStop: true } },
      { operation: "RailwayDeployment", data: deployment("deployment-logto", true) },
    ];
    const targets = [
      {
        kind: "application-postgres" as const,
        volumeInstanceId: "volume-app",
        backupName: "maintenance-app",
      },
      {
        kind: "logto-postgres" as const,
        volumeInstanceId: "volume-logto",
        backupName: "maintenance-logto",
      },
      {
        kind: "server-volume" as const,
        volumeInstanceId: "volume-server",
        backupName: "maintenance-server",
      },
    ];
    for (const target of targets) {
      steps.push(
        { operation: "RailwayVolumeInstanceBackupList", data: list([]) },
        {
          operation: "RailwayVolumeInstanceBackupCreate",
          data: { volumeInstanceBackupCreate: { workflowId: `workflow-${target.kind}` } },
        },
        { operation: "RailwayWorkflowStatus", data: workflow("Complete") },
        {
          operation: "RailwayVolumeInstanceBackupList",
          data: list([backup(`backup-${target.kind}`, target.backupName)]),
        },
        {
          operation: "RailwayVolumeInstanceBackupLock",
          data: { volumeInstanceBackupLock: true },
        },
      );
    }
    const transport = new ScriptedTransport(steps);
    const executor = new RailwayVolumeBackupExecutor({ transport, persistWorkflow });

    expect(await createRailwayMaintenanceBackupSet(executor, {
      applicationDeploymentId: "deployment-app",
      logtoDeploymentId: "deployment-logto",
      targets,
    })).toEqual({
      outcome: "complete",
      backups: [
        { kind: "application-postgres", backupId: "backup-application-postgres" },
        { kind: "logto-postgres", backupId: "backup-logto-postgres" },
        { kind: "server-volume", backupId: "backup-server-volume" },
      ],
    });
    expect(transport.calls.slice(0, 7).map((call) => call.operation)).toEqual([
      "RailwayDeployment",
      "RailwayDeploymentStop",
      "RailwayDeployment",
      "RailwayDeployment",
      "RailwayDeploymentStop",
      "RailwayDeployment",
      "RailwayVolumeInstanceBackupList",
    ]);
    transport.expectConsumed();
  });

  test("rejects an incomplete coordinated target set before provider mutation", async () => {
    const transport = new ScriptedTransport([]);
    const executor = new RailwayVolumeBackupExecutor({ transport, persistWorkflow });
    expect(await createRailwayMaintenanceBackupSet(executor, {
      applicationDeploymentId: "deployment-app",
      logtoDeploymentId: "deployment-logto",
      targets: [{
        kind: "application-postgres",
        volumeInstanceId: "volume-app",
        backupName: "maintenance-app",
      }],
    })).toEqual({
      outcome: "failure",
      boundary: "application-quiescence",
      code: "invalid-input",
    });
    expect(transport.calls).toEqual([]);
  });
});
