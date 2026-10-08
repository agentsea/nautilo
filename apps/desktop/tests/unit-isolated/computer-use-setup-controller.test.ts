import { describe, expect, spyOn, test } from "bun:test";
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
  resolveOwnedAgent?: (accessToken: string, humanUserId: string, requestedAgentId: string) => Promise<string | null>;
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

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  return await operation.catch((error: unknown) => error);
}

describe("Computer use setup controller", () => {
  test("wrong PIN and foreign-Human proof never write local authority", async () => {
    for (const verifyOwnPin of [
      async () => null,
      async () => ({ accessToken: "foreign-bearer", humanUserId: "human-2" }),
    ]) {
      const { store, memory } = makeStore();
      const managed = controller({ store, verifyOwnPin });
      expect(await rejected(managed.enable("847291", "agent-1"))).toMatchObject({ message: expect.stringContaining("PIN could not be verified") as unknown });
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
    expect(await managed.enable("847291", "agent-personal")).toEqual({
      state: "enabled",
      reason: null,
      agentId: "agent-personal",
      grantGeneration: 1,
    });
    expect(calls).toEqual(["verify:847291:human-1", "agent:fresh-bearer:human-1:agent-personal"]);
    const persisted: unknown = JSON.parse(memory.bytes() ?? "{}");
    expect(persisted).toMatchObject({ receipt: {
      instanceId: "",
      humanUserId: "human-1",
      agentId: "agent-personal",
      serverBindingId: binding,
      relayId: "relay-1",
      pairingGeneration: "pairing-1",
    } });
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
      expect(await rejected(managed.enable("847291", "agent-1"))).toMatchObject({ message: expect.stringContaining(denied.message) as unknown });
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
    expect(await rejected(permissionDrift.enable("847291", "agent-1"))).toMatchObject({ message: expect.stringContaining("permission changed") as unknown });
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
      expect(await managed.status()).toMatchObject({
        state: "not-enabled",
        reason: expect.stringContaining(denied.reason) as unknown,
        grantGeneration: null,
      });
      expect(pinCalls).toBe(0);
      expect(fences).toEqual([expect.objectContaining({
        kind: "exact_grant",
        receipt: expect.objectContaining({ grantGeneration: 1 }) as unknown,
        grantGeneration: 2,
      }) as unknown]);
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
    expect(await managed.check()).toMatchObject({
      state: "not-enabled",
      reason: expect.stringContaining("control permission changed") as unknown,
      agentId: null,
      grantGeneration: null,
    });
    expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
    expect(fences).toEqual([expect.objectContaining({ kind: "exact_grant", grantGeneration: 2 }) as unknown]);
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
    expect(await managed.localStatus()).toMatchObject({ state: "enabled", agentId: "agent-1" });
    expect(await managed.disable()).toMatchObject({ state: "not-enabled" });
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
    expect(await rejected(beforeMint.enable("847291", "agent-1"))).toMatchObject({ message: expect.stringContaining("connection changed") as unknown });
    expect(before.memory.writes()).toBe(0);

    const after = makeStore();
    active = runtime;
    const originalMint = after.store.mint.bind(after.store);
    const mint = spyOn(after.store, "mint").mockImplementationOnce(async (input) => {
      const result = await originalMint(input);
      active = { ...runtime, desktopSessionId: "desktop-session-2" };
      return result;
    });
    const afterMint = controller({
      store: after.store,
      getRuntime: () => active,
    });
    try {
      expect(await rejected(afterMint.enable("847291", "agent-1"))).toMatchObject({ message: expect.stringContaining("was not enabled") as unknown });
      expect((await after.store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
    } finally {
      mint.mockRestore();
    }
  });

  test.each(["initial attestation", "PIN", "Agent resolution", "final attestation"])(
    "same-binding Off invalidates an enable awaiting %s before mint",
    async (stage) => {
      const { store } = makeStore();
      const entered = barrier();
      const resume = barrier();
      let attestations = 0;
      const pause = async () => { entered.release(); await resume.promise; };
      const managed = controller({
        store,
        attestActivation: async (expected) => {
          attestations++;
          if ((stage === "initial attestation" && attestations === 1) ||
            (stage === "final attestation" && attestations === 2)) await pause();
          return { ...expected, controlDesktop: true };
        },
        verifyOwnPin: async (_pin, humanUserId) => {
          if (stage === "PIN") await pause();
          return { accessToken: "fresh-bearer", humanUserId };
        },
        resolveOwnedAgent: async () => {
          if (stage === "Agent resolution") await pause();
          return "agent-1";
        },
      });
      const mint = spyOn(store, "mint");
      const enabling = managed.enable("847291", "agent-1").catch((error: unknown) => error);
      try {
        await entered.promise;
        expect(await managed.disable()).toMatchObject({ state: "not-enabled" });
        resume.release();
        expect(await enabling).toMatchObject({ message: expect.stringContaining("cancelled by a local Off") as unknown });
        expect(mint).not.toHaveBeenCalled();
        expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 0 });
        expect(await managed.enable("847291", "agent-1")).toMatchObject({ state: "enabled", grantGeneration: 1 });
      } finally {
        resume.release();
        await enabling;
        mint.mockRestore();
      }
    },
  );

  test("a failed Off still invalidates an older pending enable; a fresh explicit enable may recover", async () => {
    const { store } = makeStore();
    const entered = barrier();
    const resume = barrier();
    let pinChecks = 0;
    const managed = controller({
      store,
      verifyOwnPin: async (_pin, humanUserId) => {
        if (++pinChecks === 1) { entered.release(); await resume.promise; }
        return { accessToken: "fresh-bearer", humanUserId };
      },
    });
    const revoke = spyOn(store, "revoke").mockImplementationOnce(async () => { throw new Error("fixture unavailable"); });
    const enabling = managed.enable("847291", "agent-1").catch((error: unknown) => error);
    try {
      await entered.promise;
      const failure = await managed.disable().catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: "Nautilo could not turn off Computer use on this Mac." });
      resume.release();
      expect(await enabling).toMatchObject({ message: expect.stringContaining("cancelled by a local Off") as unknown });
      expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 0 });
      expect(await managed.enable("847291", "agent-1")).toMatchObject({ state: "enabled", grantGeneration: 1 });
    } finally {
      resume.release();
      await enabling;
      revoke.mockRestore();
    }
  });

  test("Off during an in-flight mint rolls back that exact grant without revoking a newer explicit enable", async () => {
    const { store } = makeStore();
    const entered = barrier();
    const resume = barrier();
    const originalMint = store.mint.bind(store);
    const mint = spyOn(store, "mint").mockImplementationOnce(async (input) => {
      const result = await originalMint(input);
      entered.release();
      await resume.promise;
      return result;
    });
    const fences: ComputerUseRevocationFence[] = [];
    const managed = controller({
      store,
      resolveOwnedAgent: async (_token, _human, requestedAgentId) => requestedAgentId,
      cancelAndFenceOwnedWork: (fence) => { fences.push(fence); },
    });
    const older = managed.enable("847291", "agent-1").catch((error: unknown) => error);
    await entered.promise;
    const off = managed.disable();
    const newer = managed.enable("847291", "agent-2");
    try {
      resume.release();
      expect(await older).toMatchObject({ message: expect.stringContaining("cancelled by a local Off") as unknown });
      await off;
      expect(await newer).toMatchObject({ state: "enabled", agentId: "agent-2", grantGeneration: 3 });
      expect((await store.get()).data).toMatchObject({ receipt: { agentId: "agent-2", grantGeneration: 3 } });
      expect(fences).toEqual([expect.objectContaining({
        kind: "exact_grant", receipt: expect.objectContaining({ agentId: "agent-1", grantGeneration: 1 }) as unknown, grantGeneration: 2,
      }) as unknown]);
    } finally {
      resume.release();
      await Promise.allSettled([older, off, newer]);
      mint.mockRestore();
    }
  });

  test("a late local status read cannot report enabled after same-binding Off completed", async () => {
    const { store } = makeStore();
    const entered = barrier();
    const resume = barrier();
    const originalGet = store.get.bind(store);
    const get = spyOn(store, "get").mockImplementationOnce(async () => {
      const result = await originalGet();
      entered.release();
      await resume.promise;
      return result;
    });
    const managed = controller({ store });
    const enabling = managed.enable("847291", "agent-1").catch((error: unknown) => error);
    try {
      await entered.promise;
      expect(await managed.disable()).toMatchObject({ state: "not-enabled" });
      resume.release();
      expect(await enabling).toMatchObject({ message: expect.stringContaining("cancelled by a local Off") as unknown });
      expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
    } finally {
      resume.release();
      await enabling;
      get.mockRestore();
    }
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
    expect(await disabling.disable()).toMatchObject({ state: "unavailable" });
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
    expect(await disabling.disable()).toMatchObject({ state: "not-enabled" });
    expect(fences).toEqual([{
      kind: "exact_grant",
      receipt: expect.objectContaining({
        humanUserId: "human-1",
        relayId: "relay-1",
        grantGeneration: 1,
      }) as unknown,
      installationEpoch: expect.any(String) as unknown,
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
    expect(await rejected(disabling.disable())).toMatchObject({ message: expect.stringContaining("Computer use is Off") as unknown });
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
    expect(await managed.disable()).toMatchObject({ state: "unavailable" });
    expect(fences).toEqual([expect.objectContaining({
      kind: "installation_epoch_reset",
      recoveryCause: "store_corrupt",
      grantGeneration: 0,
    }) as unknown]);
    expect(await damaged.store.get()).toMatchObject({ ok: true, data: { receipt: null, grantGeneration: 0 } });
  });

  test("a valid durable receipt survives restart without persisting desktopSessionId", async () => {
    const first = makeStore();
    await controller({ store: first.store }).enable("847291", "agent-1");
    const restarted = makeStore(memoryStorage(first.memory.bytes()));
    const nextLaunch = { ...runtime, desktopSessionId: "desktop-session-next-launch" };
    expect(await controller({ store: restarted.store, getRuntime: () => nextLaunch }).status()).toEqual({
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
      expect(status).toMatchObject({ state: "not-enabled", reason: expect.stringContaining("binding changed") as unknown });
      expect((await store.get()).data).toMatchObject({ receipt: null, grantGeneration: 2 });
    }
  });
});
