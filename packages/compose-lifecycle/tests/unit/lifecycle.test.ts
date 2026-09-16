import { describe, expect, test } from "bun:test";

import type {
  ComposeDriver,
  ComposeDriverProfile,
  ComposeStatusObservation,
} from "@nautilo/compose-driver";

import { createComposeLifecycleFromDriver } from "../../src/index.ts";

const profile = {
  name: "m269-test",
  lifecycle: "compose",
  transport: "local",
  instance_id: "m269-test",
} as ComposeDriverProfile;

const observation: ComposeStatusObservation = {
  composeProjectName: "nautilo-m269-test",
  serverUrl: "http://127.0.0.1:3001",
  compose: "present",
  health: "ready",
  setupState: "ready",
  claimRequired: false,
};

function fakeDriver(overrides: Record<string, unknown> = {}): ComposeDriver {
  return {
    deploy: async () => undefined,
    status: async () => observation,
    upgrade: async () => undefined,
    backup: async () => "/safe/backup",
    restore: async () => undefined,
    destroy: async () => undefined,
    inspectCleanup: async () => ({
      containersAbsent: true,
      networksAbsent: true,
      dataVolumesAbsent: true,
      preservedCertificateVolumes: [],
    }),
    ...overrides,
  } as unknown as ComposeDriver;
}

describe("Compose lifecycle", () => {
  test("returns bounded structured results without parsing driver output", async () => {
    const events: string[] = [];
    const lifecycle = createComposeLifecycleFromDriver({
      profile,
      driver: fakeDriver(),
      ports: { progress: (event) => events.push(`${event.operation}:${event.phase}`) },
    });

    expect(await lifecycle.deploy()).toEqual({
      operation: "deploy",
      target: lifecycle.target,
      readiness: "ready",
      recovery: "none",
    });
    expect(await lifecycle.inspect()).toEqual({
      operation: "inspect",
      target: lifecycle.target,
      observation,
    });
    expect(await lifecycle.backup()).toEqual({
      operation: "backup",
      target: lifecycle.target,
      backupPath: "/safe/backup",
    });
    expect(events).toEqual([
      "deploy:started", "deploy:completed",
      "inspect:started", "inspect:completed",
      "backup:started", "backup:completed",
    ]);
  });

  test("serializes operations across lifecycle objects", async () => {
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = createComposeLifecycleFromDriver({
      profile,
      driver: fakeDriver({
        deploy: async () => {
          order.push("first-start");
          await blocked;
          order.push("first-end");
        },
      }),
    });
    const second = createComposeLifecycleFromDriver({
      profile: { ...profile, name: "m269-next", instance_id: "m269-next" },
      driver: fakeDriver({ status: async () => {
        order.push("second");
        return observation;
      } }),
    });

    const deploying = first.deploy();
    await Promise.resolve();
    const inspecting = second.inspect();
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([deploying, inspecting]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  test("hard destroy clears custody only after Compose destruction", async () => {
    const order: string[] = [];
    const lifecycle = createComposeLifecycleFromDriver({
      profile,
      driver: fakeDriver({ destroy: async () => { order.push("compose"); } }),
      ports: { clearOwnerClaimCustody: async () => { order.push("custody"); } },
    });

    const result = await lifecycle.destroyHard({ keepCerts: true });
    expect(order).toEqual(["compose", "custody"]);
    expect(result.cleanup).toEqual({
      containersAbsent: true,
      networksAbsent: true,
      dataVolumesAbsent: true,
      ownerClaimCustodyCleared: true,
    });
  });

  test("progress events never contain operation inputs or thrown secrets", async () => {
    const canary = "provider-key-canary";
    const events: unknown[] = [];
    const lifecycle = createComposeLifecycleFromDriver({
      profile,
      driver: fakeDriver({ deploy: async () => { throw new Error(canary); } }),
      ports: { progress: (event) => events.push(event) },
    });

    let captured: unknown;
    try {
      await lifecycle.deploy();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe(
      "Compose deploy failed; inspect the exact target before retrying.",
    );
    expect(JSON.stringify(events)).not.toContain(canary);
    expect(JSON.stringify(captured)).not.toContain(canary);
    expect(events).toEqual([
      { operation: "deploy", phase: "started" },
      { operation: "deploy", phase: "failed" },
    ]);
  });

  test("uncertain hard-destroy cleanup preserves custody for exact recovery", async () => {
    let custodyClears = 0;
    const lifecycle = createComposeLifecycleFromDriver({
      profile,
      driver: fakeDriver({
        inspectCleanup: async () => ({
          containersAbsent: false,
          networksAbsent: true,
          dataVolumesAbsent: true,
          preservedCertificateVolumes: [],
        }),
      }),
      ports: { clearOwnerClaimCustody: async () => { custodyClears += 1; } },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(lifecycle.destroyHard()).rejects.toThrow(
      "Compose destroy failed; inspect the exact target before retrying.",
    );
    expect(custodyClears).toBe(0);
  });
});
