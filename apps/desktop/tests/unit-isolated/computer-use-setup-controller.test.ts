import { describe, expect, test } from "bun:test";
import { ComputerUseLocalStore } from "../../electron/computer-use/local-store.ts";
import {
  createComputerUseSetupController,
  type ComputerUseRevocationFence,
  type ComputerUseSetupRuntime,
} from "../../electron/computer-use/setup-controller.ts";

const binding = "server-binding-aaaaaaaaaaaaaaaa";
const runtime: ComputerUseSetupRuntime = {
  instanceId: "",
  humanUserId: "human-1",
  serverBindingId: binding,
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "desktop-session-1",
};

function memoryStorage(initial: string | null = null) {
  let value = initial;
  let writes = 0;
  return {
    storage: {
      read: async () => value,
      writeAtomic: async (next: string) => { value = next; writes += 1; },
    },
    bytes: () => value,
    writes: () => writes,
  };
}

function makeStore(memory = memoryStorage()) {
  return {
    memory,
    store: new ComputerUseLocalStore({
      instanceId: runtime.instanceId,
      serverBindingId: runtime.serverBindingId,
      filePath: "/unused/computer-use-controller.json",
      storage: memory.storage,
      clock: () => new Date("2026-08-11T12:00:00.000Z"),
    }),
  };
}

function controller(options: {
  store: ComputerUseLocalStore;
  getRuntime?: () => ComputerUseSetupRuntime | null;
  verifyOwnPin?: (pin: string, humanUserId: string) => Promise<{ accessToken: string; humanUserId: string } | null>;
  resolveOwnedAgent?: (accessToken: string, humanUserId: string) => Promise<string | null>;
  attestActivation?: (expected: ComputerUseSetupRuntime) => Promise<ComputerUseSetupRuntime & { controlDesktop: boolean } | null>;
  cancelAndFenceOwnedWork?: (fence: ComputerUseRevocationFence) => void;
}) {
  return createComputerUseSetupController({
    store: options.store,
    getRuntime: options.getRuntime ?? (() => runtime),
    verifyOwnPin: options.verifyOwnPin ?? (async (_pin, humanUserId) => ({ accessToken: "fresh-bearer", humanUserId })),
    resolveOwnedAgent: options.resolveOwnedAgent ?? (async () => "agent-1"),
    attestActivation: options.attestActivation ?? (async (expected) => ({
      ...expected,
      controlDesktop: true,
    })),
    cancelAndFenceOwnedWork: options.cancelAndFenceOwnedWork ?? (() => undefined),
  });
}

describe("D516 Computer use setup controller", () => {
  test("wrong PIN and foreign-Human proof never write local authority", async () => {
    for (const verifyOwnPin of [
      async () => null,
      async () => ({ accessToken: "foreign-bearer", humanUserId: "human-2" }),
    ]) {
      const { store, memory } = makeStore();
      const managed = controller({ store, verifyOwnPin });
      await expect(managed.enable("847291", "agent-1")).rejects.toThrow("PIN could not be verified");
      expect(memory.writes()).toBe(0);
      expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 0 });
    }
  });

  test("own proof resolves the Agent server-side and enables the exact runtime receipt", async () => {
    const { store, memory } = makeStore();
    const calls: string[] = [];
    const managed = controller({
      store,
      verifyOwnPin: async (pin, humanUserId) => {
        calls.push(`verify:${pin}:${humanUserId}`);
        return { accessToken: "fresh-bearer", humanUserId };
      },
      resolveOwnedAgent: async (accessToken, humanUserId, requestedAgentId) => {
        calls.push(`agent:${accessToken}:${humanUserId}:${requestedAgentId}`);
        return "agent-personal";
      },
    });
    await expect(managed.enable("847291", "agent-personal")).resolves.toEqual({
      state: "enabled",
      reason: null,
      agentId: "agent-personal",
      grantGeneration: 1,
    });
    expect(calls).toEqual(["verify:847291:human-1", "agent:fresh-bearer:human-1:agent-personal"]);
    const persisted = JSON.parse(memory.bytes() ?? "{}");
    expect(persisted.receipt).toMatchObject({
      instanceId: "",
      humanUserId: "human-1",
      agentId: "agent-personal",
      serverBindingId: binding,
      relayId: "relay-1",
      pairingGeneration: "pairing-1",
    });
    expect(JSON.stringify(persisted)).not.toMatch(/847291|fresh-bearer|pin|desktop-session/i);
  });

  test("requires live Human control_desktop authority before and after PIN verification", async () => {
    for (const denied of [
      { controlDesktop: false, message: "does not currently have permission" },
    ]) {
      const { store, memory } = makeStore();
      let pinCalls = 0;
      const managed = controller({
        store,
        verifyOwnPin: async (_pin, humanUserId) => {
          pinCalls += 1;
          return { accessToken: "must-not-be-used", humanUserId };
        },
        attestActivation: async (expected) => ({
          ...expected,
          controlDesktop: denied.controlDesktop,
        }),
      });
      await expect(managed.enable("847291", "agent-1")).rejects.toThrow(denied.message);
      expect(pinCalls).toBe(0);
      expect(memory.writes()).toBe(0);
    }

    const drift = makeStore();
    let attestations = 0;
    const permissionDrift = controller({
      store: drift.store,
      attestActivation: async (expected) => {
        attestations += 1;
        return {
          ...expected,
          controlDesktop: attestations === 1,
        };
      },
    });
    await expect(permissionDrift.enable("847291", "agent-1")).rejects.toThrow("permission changed");
    expect(attestations).toBe(2);
    expect(drift.memory.writes()).toBe(0);
  });

  test("status revokes and fences a durable receipt when live Human control is lost", async () => {
    for (const denied of [
      { controlDesktop: false, reason: "control permission changed" },
    ]) {
      const { store } = makeStore();
      await controller({ store }).enable("847291", "agent-1");
      const fences: ComputerUseRevocationFence[] = [];
      let pinCalls = 0;
      const managed = controller({
        store,
        verifyOwnPin: async () => { pinCalls += 1; return null; },
        attestActivation: async (expected) => ({ ...expected, ...denied }),
        cancelAndFenceOwnedWork: (fence) => { fences.push(fence); },
      });
      await expect(managed.status()).resolves.toMatchObject({
        state: "not-enabled",
        reason: expect.stringContaining(denied.reason),
        grantGeneration: null,
      });
      expect(pinCalls).toBe(0);
      expect(fences).toEqual([expect.objectContaining({
        kind: "exact_grant",
        receipt: expect.objectContaining({ grantGeneration: 1 }),
        grantGeneration: 2,
      })]);
      expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
    }
  });

  test("a full check turns an already-enabled receipt Off when live Human control is lost", async () => {
    const { store } = makeStore();
    await controller({ store }).enable("847291", "agent-1");
    const fences: ComputerUseRevocationFence[] = [];
    const managed = controller({
      store,
      attestActivation: async (expected) => ({
        ...expected,
        controlDesktop: false,
      }),
      cancelAndFenceOwnedWork: (fence) => { fences.push(fence); },
    });
    await expect(managed.check()).resolves.toMatchObject({
      state: "not-enabled",
      reason: expect.stringContaining("control permission changed"),
      agentId: null,
      grantGeneration: null,
    });
    expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
    expect(fences).toEqual([expect.objectContaining({ kind: "exact_grant", grantGeneration: 2 })]);
  });

  test("local status and PIN-free Off never wait for live authority attestation", async () => {
    const { store } = makeStore();
    await controller({ store }).enable("847291", "agent-1");
    let attestations = 0;
    const managed = controller({
      store,
      attestActivation: async () => {
        attestations += 1;
        return await new Promise<never>(() => undefined);
      },
    });
    await expect(managed.localStatus()).resolves.toMatchObject({ state: "enabled", agentId: "agent-1" });
    await expect(managed.disable()).resolves.toMatchObject({ state: "not-enabled" });
    expect(attestations).toBe(0);
    expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
  });

  test("detects runtime drift before mint and rolls back drift after mint", async () => {
    const before = makeStore();
    let active: ComputerUseSetupRuntime | null = runtime;
    const beforeMint = controller({
      store: before.store,
      getRuntime: () => active,
      resolveOwnedAgent: async () => {
        active = { ...runtime, pairingGeneration: "pairing-2" };
        return "agent-1";
      },
    });
    await expect(beforeMint.enable("847291", "agent-1")).rejects.toThrow("connection changed");
    expect(before.memory.writes()).toBe(0);

    const after = makeStore();
    active = runtime;
    let runtimeReads = 0;
    const afterMint = controller({
      store: after.store,
      getRuntime: () => {
        runtimeReads += 1;
        return runtimeReads >= 4 ? { ...runtime, desktopSessionId: "desktop-session-2" } : active;
      },
    });
    await expect(afterMint.enable("847291", "agent-1")).rejects.toThrow("was not enabled");
    expect((await after.store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
  });

  test("Off is PIN-free and works while the Desktop runtime is disconnected", async () => {
    const { store } = makeStore();
    const enabling = controller({ store });
    await enabling.enable("847291", "agent-1");
    let pinCalls = 0;
    const disabling = controller({
      store,
      getRuntime: () => null,
      verifyOwnPin: async () => { pinCalls += 1; return null; },
    });
    await expect(disabling.disable()).resolves.toMatchObject({ state: "unavailable" });
    expect(pinCalls).toBe(0);
    expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
  });

  test("Off advances the fence and synchronously cancels the exact old grant", async () => {
    const { store } = makeStore();
    await controller({ store }).enable("847291", "agent-1");
    const fences: ComputerUseRevocationFence[] = [];
    const disabling = controller({
      store,
      cancelAndFenceOwnedWork: (fence) => { fences.push(fence); },
    });
    await expect(disabling.disable()).resolves.toMatchObject({ state: "not-enabled" });
    expect(fences).toEqual([{
      kind: "exact_grant",
      receipt: expect.objectContaining({
        humanUserId: "human-1",
        relayId: "relay-1",
        grantGeneration: 1,
      }),
      installationEpoch: expect.any(String),
      grantGeneration: 2,
    }]);
    expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
  });

  test("reports cancellation failure only after authority is durably Off", async () => {
    const { store } = makeStore();
    await controller({ store }).enable("847291", "agent-1");
    const disabling = controller({
      store,
      cancelAndFenceOwnedWork: () => { throw new Error("cancel failed"); },
    });
    await expect(disabling.disable()).rejects.toThrow("Computer use is Off");
    expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
  });

  test("Off explicitly recovers corrupt authority and emits an installation-epoch reset fence", async () => {
    const damaged = makeStore(memoryStorage("not-json"));
    const fences: ComputerUseRevocationFence[] = [];
    const managed = controller({
      store: damaged.store,
      getRuntime: () => null,
      cancelAndFenceOwnedWork: (fence) => { fences.push(fence); },
    });
    await expect(managed.disable()).resolves.toMatchObject({ state: "unavailable" });
    expect(fences).toEqual([expect.objectContaining({
      kind: "installation_epoch_reset",
      recoveryCause: "store_corrupt",
      grantGeneration: 0,
    })]);
    expect(await damaged.store.get()).toMatchObject({ ok: true, data: { receipt: null, grantGeneration: 0 } });
  });

  test("a valid durable receipt survives restart without persisting desktopSessionId", async () => {
    const first = makeStore();
    await controller({ store: first.store }).enable("847291", "agent-1");
    const restarted = makeStore(memoryStorage(first.memory.bytes()));
    const nextLaunch = { ...runtime, desktopSessionId: "desktop-session-next-launch" };
    await expect(controller({ store: restarted.store, getRuntime: () => nextLaunch }).status())
      .resolves.toEqual({
        state: "enabled",
        reason: null,
        agentId: "agent-1",
        grantGeneration: 1,
      });
  });

  test("binding drift fails closed and revokes the stale receipt", async () => {
    for (const changed of [
      { ...runtime, humanUserId: "human-2" },
      { ...runtime, relayId: "relay-2" },
      { ...runtime, pairingGeneration: "pairing-2" },
      { ...runtime, serverBindingId: "server-binding-bbbbbbbbbbbbbbbb" },
    ]) {
      const { store } = makeStore();
      await controller({ store }).enable("847291", "agent-1");
      const status = await controller({ store, getRuntime: () => changed }).status();
      expect(status).toMatchObject({ state: "not-enabled", reason: expect.stringContaining("binding changed") });
      expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
    }
  });
});
