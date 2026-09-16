import { describe, expect, test } from "bun:test";
import {
  createComputerUseLocalStorage,
  type ComputerUseLocalFileSystem,
} from "../../electron/computer-use/contracts.ts";
import { ComputerUseLocalStore } from "../../electron/computer-use/local-store.ts";

const now = () => new Date("2026-08-11T12:00:00.000Z");
const scope = { instanceId: "", serverBindingId: "server-binding-aaaaaaaaaaaaaaaa" };
const mint = {
  ...scope,
  humanUserId: "human-1",
  agentId: "agent-1",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
};

function memoryStorage(initial: string | null = null) {
  let bytes = initial;
  let writes = 0;
  return {
    storage: {
      read: async () => bytes,
      writeAtomic: async (next: string) => { bytes = next; writes += 1; },
    },
    bytes: () => bytes,
    writes: () => writes,
  };
}

function makeStore(
  memory = memoryStorage(),
  serverBindingId = scope.serverBindingId,
  installationEpoch = "computer-use-epoch-aaaaaaaaaaaaaaaa",
) {
  return {
    memory,
    store: new ComputerUseLocalStore({
      instanceId: scope.instanceId,
      serverBindingId,
      filePath: "/unused/computer-use-local.json",
      storage: memory.storage,
      clock: now,
      createInstallationEpoch: () => installationEpoch,
    }),
  };
}

describe("D516 Electron-local Computer use state", () => {
  test("starts with no authority and mints an exact durable receipt", async () => {
    const { store, memory } = makeStore();
    expect(await store.get()).toEqual({
      ok: true,
      data: {
        receipt: null,
        grantGeneration: 0,
        installationEpoch: "computer-use-epoch-aaaaaaaaaaaaaaaa",
      },
    });
    const enabled = await store.mint(mint);
    expect(enabled).toMatchObject({ ok: true, data: { ...mint, version: 1, grantGeneration: 1, issuedAt: now().toISOString() } });
    const persisted = JSON.parse(memory.bytes() ?? "{}");
    expect(persisted).toMatchObject({ ...scope, version: 1, installationEpoch: "computer-use-epoch-aaaaaaaaaaaaaaaa", grantGeneration: 1 });
    expect(Object.keys(persisted.receipt).sort()).toEqual([
      "agentId", "grantGeneration", "humanUserId", "installationEpoch", "instanceId", "issuedAt", "pairingGeneration", "relayId", "serverBindingId", "version",
    ]);
    expect(JSON.stringify(persisted)).not.toMatch(/pin|secret|desktopSessionId/i);
  });

  test("PIN-free revoke deletes usable authority and a future grant receives a strictly higher generation", async () => {
    const { store, memory } = makeStore();
    const first = await store.mint(mint);
    if (!first.ok) throw new Error("first mint failed");
    expect(await store.revoke()).toMatchObject({
      ok: true,
      data: { revoked: true, recovered: false, grantGeneration: 2, previousReceipt: { grantGeneration: 1 } },
    });
    expect((await store.get()).data).toEqual({
      receipt: null,
      grantGeneration: 2,
      installationEpoch: "computer-use-epoch-aaaaaaaaaaaaaaaa",
    });
    const second = await store.mint(mint);
    expect(second).toMatchObject({ ok: true, data: { grantGeneration: 3 } });
    const restarted = makeStore(memoryStorage(memory.bytes()));
    expect((await restarted.store.get()).data).toMatchObject({ grantGeneration: 3, receipt: { grantGeneration: 3 } });
  });

  test("migrates an exact legacy provider preference without losing or widening its grant fence", async () => {
    const legacy = {
      version: 1,
      instanceId: scope.instanceId,
      serverBindingId: scope.serverBindingId,
      installationEpoch: "computer-use-epoch-legacy",
      grantGeneration: 7,
      policy: { primary: "peekaboo", fallback: "cua" },
      receipt: {
        version: 1,
        instanceId: scope.instanceId,
        humanUserId: "human-1",
        agentId: "agent-1",
        serverBindingId: scope.serverBindingId,
        installationEpoch: "computer-use-epoch-legacy",
        grantGeneration: 7,
        relayId: "relay-1",
        pairingGeneration: "pairing-1",
        issuedAt: "2026-08-11T11:00:00.000Z",
      },
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const memory = memoryStorage(JSON.stringify(legacy));
    const first = makeStore(memory);
    expect(await first.store.get()).toMatchObject({
      ok: true,
      data: {
        installationEpoch: "computer-use-epoch-legacy",
        grantGeneration: 7,
        receipt: { installationEpoch: "computer-use-epoch-legacy", grantGeneration: 7 },
      },
    });
    const migratedBytes = JSON.parse(memory.bytes() ?? "{}");
    expect(migratedBytes.policy).toBeUndefined();
    expect(migratedBytes).toMatchObject({
      installationEpoch: "computer-use-epoch-legacy",
      grantGeneration: 7,
      receipt: { installationEpoch: "computer-use-epoch-legacy", grantGeneration: 7 },
      updatedAt: "2026-08-11T12:00:00.000Z",
    });
    const restarted = makeStore(memoryStorage(memory.bytes()));
    expect(await restarted.store.get()).toMatchObject({
      ok: true,
      data: { installationEpoch: "computer-use-epoch-legacy", grantGeneration: 7 },
    });
    expect(await first.store.revoke()).toMatchObject({
      ok: true,
      data: { installationEpoch: "computer-use-epoch-legacy", grantGeneration: 8, revoked: true },
    });
    const rewritten = JSON.parse(memory.bytes() ?? "{}");
    expect(rewritten.policy).toBeUndefined();
    expect(rewritten).toMatchObject({ installationEpoch: "computer-use-epoch-legacy", grantGeneration: 8, receipt: null });
  });

  test("rejects malformed legacy policy and receipt/fence mismatches", async () => {
    const base = {
      version: 1,
      instanceId: scope.instanceId,
      serverBindingId: scope.serverBindingId,
      installationEpoch: "computer-use-epoch-legacy",
      grantGeneration: 7,
      policy: { primary: "peekaboo", fallback: "cua" },
      receipt: null,
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    expect(await makeStore(memoryStorage(JSON.stringify({
      ...base,
      policy: { primary: "peekaboo", fallback: "peekaboo" },
    }))).store.get()).toMatchObject({ ok: false, code: "store_corrupt" });
    expect(await makeStore(memoryStorage(JSON.stringify({
      ...base,
      receipt: {
        version: 1,
        instanceId: scope.instanceId,
        humanUserId: "human-1",
        agentId: "agent-1",
        serverBindingId: scope.serverBindingId,
        installationEpoch: "computer-use-epoch-legacy",
        grantGeneration: 6,
        relayId: "relay-1",
        pairingGeneration: "pairing-1",
        issuedAt: "2026-08-11T11:00:00.000Z",
      },
    }))).store.get()).toMatchObject({ ok: false, code: "store_corrupt" });
  });

  test("fails closed and does not overwrite corrupt, cross-instance, or cross-server state", async () => {
    const corrupt = makeStore(memoryStorage("not-json"));
    expect(await corrupt.store.mint(mint)).toMatchObject({ ok: false, code: "store_corrupt" });
    expect(corrupt.memory.writes()).toBe(0);

    const source = makeStore();
    const enabled = await source.store.mint(mint);
    if (!enabled.ok) throw new Error("mint failed");
    const serverChanged = makeStore(memoryStorage(source.memory.bytes()), "server-binding-bbbbbbbbbbbbbbbb");
    expect(await serverChanged.store.get()).toMatchObject({ ok: false, code: "store_server_mismatch" });
    const instanceChanged = new ComputerUseLocalStore({
      instanceId: "other-instance",
      serverBindingId: scope.serverBindingId,
      filePath: "/unused/computer-use-local.json",
      storage: memoryStorage(source.memory.bytes()).storage,
      clock: now,
    });
    expect(await instanceChanged.get()).toMatchObject({ ok: false, code: "store_instance_mismatch" });
  });

  test("explicit Off recovers corrupt bytes under a fresh installation epoch", async () => {
    const memory = memoryStorage("not-json");
    const recovered = makeStore(
      memory,
      scope.serverBindingId,
      "computer-use-epoch-bbbbbbbbbbbbbbbb",
    );
    expect(await recovered.store.revoke()).toEqual({
      ok: true,
      data: {
        revoked: true,
        recovered: true,
        recoveryCause: "store_corrupt",
        previousReceipt: null,
        installationEpoch: "computer-use-epoch-bbbbbbbbbbbbbbbb",
        grantGeneration: 0,
      },
    });
    expect(await recovered.store.get()).toMatchObject({
      ok: true,
      data: {
        receipt: null,
        installationEpoch: "computer-use-epoch-bbbbbbbbbbbbbbbb",
        grantGeneration: 0,
      },
    });
  });

  test("a real server switch reconstructs disabled state in a new epoch before any new grant", async () => {
    const shared = memoryStorage();
    const first = makeStore(shared, scope.serverBindingId, "computer-use-epoch-aaaaaaaaaaaaaaaa");
    const enabled = await first.store.mint(mint);
    if (!enabled.ok) throw new Error("initial mint failed");

    const serverB = "server-binding-bbbbbbbbbbbbbbbb";
    const switched = makeStore(shared, serverB, "computer-use-epoch-bbbbbbbbbbbbbbbb");
    expect(await switched.store.get()).toMatchObject({ ok: false, code: "store_server_mismatch" });
    expect(await switched.store.revoke()).toMatchObject({
      ok: true,
      data: {
        revoked: true,
        recovered: true,
        recoveryCause: "store_server_mismatch",
        installationEpoch: "computer-use-epoch-bbbbbbbbbbbbbbbb",
        grantGeneration: 0,
      },
    });
    const restarted = makeStore(shared, serverB, "computer-use-epoch-cccccccccccccccc");
    expect(await restarted.store.get()).toMatchObject({
      ok: true,
      data: { receipt: null, installationEpoch: "computer-use-epoch-bbbbbbbbbbbbbbbb", grantGeneration: 0 },
    });
    const next = await restarted.store.mint({ ...mint, serverBindingId: serverB });
    expect(next).toMatchObject({
      ok: true,
      data: { installationEpoch: "computer-use-epoch-bbbbbbbbbbbbbbbb", grantGeneration: 1 },
    });
    expect(next.ok && next.data.installationEpoch).not.toBe(enabled.data.installationEpoch);
  });

  test("serializes concurrent grants so generations cannot collide", async () => {
    const { store } = makeStore();
    const [first, second] = await Promise.all([store.mint(mint), store.mint(mint)]);
    expect([first, second].map((result) => result.ok ? result.data.grantGeneration : -1).sort())
      .toEqual([1, 2]);
    expect((await store.get()).data).toMatchObject({ grantGeneration: 2, receipt: { grantGeneration: 2 } });
  });

  test("uses an injected 0600 atomic filesystem discipline", async () => {
    const calls: string[] = [];
    const files = new Map<string, string>();
    const fs: ComputerUseLocalFileSystem = {
      mkdir: async (path, options) => { calls.push(`mkdir ${path} ${options.mode.toString(8)}`); },
      readFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) {
          const error = Object.assign(new Error("missing"), { code: "ENOENT" });
          throw error;
        }
        return value;
      },
      writeFile: async (path, data, options) => { calls.push(`write ${path} ${options.mode.toString(8)}`); files.set(path, data); },
      chmod: async (path, mode) => { calls.push(`chmod ${path} ${mode.toString(8)}`); },
      rename: async (from, to) => { calls.push(`rename ${from} ${to}`); files.set(to, files.get(from)!); files.delete(from); },
      rm: async () => undefined,
    };
    const storage = createComputerUseLocalStorage("/safe/local-state.json", { fs, randomHex: () => "fixed" });
    await storage.writeAtomic("state");
    expect(calls).toEqual([
      "mkdir /safe 700",
      "chmod /safe 700",
      "write /safe/.local-state.json.fixed.tmp 600",
      "chmod /safe/.local-state.json.fixed.tmp 600",
      "rename /safe/.local-state.json.fixed.tmp /safe/local-state.json",
      "chmod /safe/local-state.json 600",
    ]);
    expect(await storage.read()).toBe("state");
  });
});
