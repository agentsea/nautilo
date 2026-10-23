import { expect, spyOn, test as bunTest } from "bun:test";
import { chmod, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { BolterConnectionOwner, type BolterNativeConnectionState } from "../../electron/bolter-bridge/connection-owner";
import { createManagedBolterConnectionFactory } from "../../electron/bolter-bridge/managed-connection";
import * as runtime from "../../electron/bolter-bridge/runtime";
import type { BolterInstalledRuntime } from "../../electron/bolter-bridge/runtime";

// Bolter is unsupported on Windows (the CLI contract refuses win32); managed
// connections rely on POSIX permission bits and the macOS runtime.
const test = bunTest.skipIf(process.platform === "win32");

const VERSION_A = "a".repeat(40);
const VERSION_B = "b".repeat(40);
const selection = { origin: "https://bolter.chat", agentId: "aaaaaaaa", cliSelector: "aaaaaaaa" } as const;
const cipher = { isAvailable: () => true,
  seal: (text: string) => Promise.resolve(Buffer.from(text).reverse()),
  open: (bytes: Uint8Array) => Promise.resolve(Buffer.from(bytes).reverse().toString()) };

function installed(version: string): BolterInstalledRuntime {
  return Object.freeze({ version, executable: `/opt/nautilo/bolter-${version}`,
    artifact: Object.freeze({ url: `https://cdn.bolter.chat/bolter-agent/${version}/darwin-arm64`,
      sha256: version.padEnd(64, version[0]), bytes: 4096 }) });
}
type OwnerInternals = { readonly runtime: { readonly version: string; readonly home: string }; readonly currentCallback: () => boolean };
type ReceiverOptions = Parameters<BolterConnectionOwner["startReceiver"]>[0];
type PreparedSend = NonNullable<Awaited<ReturnType<BolterConnectionOwner["prepareSend"]>>>;
type ProvisionInput = Parameters<typeof runtime.provisionLatestBolterRuntime>[0];
type OwnerInfo = { readonly owner: BolterConnectionOwner; readonly version: string; readonly home: string;
  confirmed: boolean; state: BolterNativeConnectionState; retirements: number; receiverStarts: number; receiverOptions?: ReceiverOptions };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for managed Bolter lifecycle transition.");
}

function installOwnerHarness(options: {
  provision: (input: ProvisionInput) => Promise<BolterInstalledRuntime>;
  conversations?: (info: OwnerInfo) => Promise<Awaited<ReturnType<BolterConnectionOwner["listConversations"]>>>;
  prepareSend?: (info: OwnerInfo) => Promise<PreparedSend | null>;
  flushInbox?: (info: OwnerInfo) => Promise<"accepted" | "blocked" | "unavailable">;
}) {
  const owners: OwnerInfo[] = [];
  const byOwner = new WeakMap<BolterConnectionOwner, OwnerInfo>();
  let provisions = 0;
  const info = (owner: BolterConnectionOwner): OwnerInfo => {
    const existing = byOwner.get(owner);
    if (existing) return existing;
    const internal = owner as unknown as OwnerInternals;
    const created: OwnerInfo = { owner, version: internal.runtime.version, home: internal.runtime.home,
      confirmed: false, state: "unavailable", retirements: 0, receiverStarts: 0 };
    byOwner.set(owner, created); owners.push(created); return created;
  };
  const current = (owner: BolterConnectionOwner) => {
    try { return (owner as unknown as OwnerInternals).currentCallback(); } catch { return false; }
  };
  const descriptors = { confirmedIdentity: Object.getOwnPropertyDescriptor(BolterConnectionOwner.prototype, "confirmedIdentity")!,
    state: Object.getOwnPropertyDescriptor(BolterConnectionOwner.prototype, "state")!,
    listening: Object.getOwnPropertyDescriptor(BolterConnectionOwner.prototype, "listening")! };
  Object.defineProperties(BolterConnectionOwner.prototype, {
    confirmedIdentity: { configurable: true, get(this: BolterConnectionOwner) {
      const value = info(this); return value.confirmed && current(this) && value.state !== "retired" ? selection : null;
    } },
    state: { configurable: true, get(this: BolterConnectionOwner) {
      const value = info(this); return current(this) || value.state === "retired" ? value.state : "unavailable";
    } },
    listening: { configurable: true, get(this: BolterConnectionOwner) {
      const value = info(this); return current(this) && value.confirmed && value.state === "receiver-running";
    } },
  });
  const confirm = async function(this: BolterConnectionOwner) {
    const value = info(this);
    if (!current(this) || value.state === "retired") return { status: "unavailable" as const, reason: "stale-authority" as const };
    value.confirmed = true;
    if (value.state !== "receiver-running") value.state = "connected";
    return { status: "confirmed" as const, identity: selection };
  };
  const spies = [
    spyOn(runtime, "productionBolterPlatform").mockReturnValue("darwin-arm64"),
    spyOn(runtime, "provisionLatestBolterRuntime").mockImplementation(async input => { provisions++; return options.provision(input); }),
    spyOn(runtime, "attestBolterRuntime").mockResolvedValue(true),
    spyOn(BolterConnectionOwner.prototype, "confirmDiscoveredIdentity").mockImplementation(confirm),
    spyOn(BolterConnectionOwner.prototype, "confirmIdentity").mockImplementation(confirm),
    spyOn(BolterConnectionOwner.prototype, "login").mockResolvedValue({ status: "unavailable", reason: "execution-failed" }),
    spyOn(BolterConnectionOwner.prototype, "listConversations").mockImplementation(function(this: BolterConnectionOwner) {
      return options.conversations?.(info(this)) ?? Promise.resolve({ status: "available", conversations: [] });
    }),
    spyOn(BolterConnectionOwner.prototype, "startReceiver").mockImplementation(async function(this: BolterConnectionOwner, receiverOptions) {
      const value = info(this); value.receiverStarts++; value.receiverOptions = receiverOptions;
      if (!current(this) || !value.confirmed || value.state === "retired") return false;
      value.state = "receiver-running"; return true;
    }),
    spyOn(BolterConnectionOwner.prototype, "pauseReceiver").mockImplementation(async function(this: BolterConnectionOwner) {
      const value = info(this); if (value.state !== "retired") value.state = value.confirmed ? "connected" : "unavailable";
    }),
    spyOn(BolterConnectionOwner.prototype, "flushInbox").mockImplementation(function(this: BolterConnectionOwner) {
      return options.flushInbox?.(info(this)) ?? Promise.resolve("accepted");
    }),
    spyOn(BolterConnectionOwner.prototype, "prepareSend").mockImplementation(function(this: BolterConnectionOwner) {
      const value = info(this);
      return options.prepareSend?.(value) ?? Promise.resolve({ send: async () => current(this) && value.state !== "retired"
        ? { status: "sent" as const, receipt: { messageId: "receipt", chatId: "chat", threadRootId: null } }
        : { status: "unavailable" as const, reason: "stale-authority" as const } });
    }),
    spyOn(BolterConnectionOwner.prototype, "retire").mockImplementation(async function(this: BolterConnectionOwner) {
      const value = info(this); value.retirements++; value.confirmed = false; value.state = "retired";
    }),
  ];
  return { owners, info, get provisions() { return provisions; }, restore() {
    for (const spy of spies.reverse()) spy.mockRestore();
    Object.defineProperties(BolterConnectionOwner.prototype, descriptors);
  } };
}

async function managedDirectory() {
  const appDataDirectory = await mkdtemp(join(await realpath("/tmp"), "nb-managed-"));
  await chmod(appDataDirectory, 0o700); return appDataDirectory;
}
function factory(appDataDirectory: string) {
  return createManagedBolterConnectionFactory({ appDataDirectory, serverId: "synthetic-server", userId: "synthetic-human", cipher,
    helper: { executable: "/opt/nautilo/synthetic-helper", attest: () => Promise.resolve(true) } });
}

test("explicit connect and receiver restart check latest while credential and handover directories survive upgrade and process restart", async () => {
  const appDataDirectory = await managedDirectory();
  const runtimes = [installed(VERSION_A), installed(VERSION_A), installed(VERSION_B), installed(VERSION_B), installed(VERSION_B)];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B) });
  let first: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  let recovered: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    const create = factory(appDataDirectory);
    first = await create({ connectionId: "synthetic-connection", generation: 1, homeHandle: "synthetic-home", isCurrent: () => true });
    expect((await first.connect(() => undefined)).authentication).toBe("confirmed");
    await first.start(() => Promise.resolve(true));
    const firstHandover = harness.owners[0]?.receiverOptions?.directory;
    const durableBatch = await harness.owners[0]!.receiverOptions!.spool.store('{"type":"event"}\n');
    await first.pause(); await first.start(() => Promise.resolve(true));
    expect(harness.owners.map(owner => owner.version)).toEqual([VERSION_A, VERSION_B]);
    expect(harness.owners[0]?.home).toBe(harness.owners[1]?.home);
    expect(harness.owners[1]?.receiverOptions?.directory).toBe(firstHandover);
    expect(await harness.owners[1]!.receiverOptions!.spool.pending()).toContain(durableBatch.id);
    expect(harness.provisions).toBe(3);
    await first.retire();
    recovered = await create({ connectionId: "synthetic-connection", generation: 2, isCurrent: () => true });
    await recovered.connect(() => undefined); await recovered.start(() => Promise.resolve(true));
    expect(harness.owners[2]?.home).toBe(harness.owners[0]?.home);
    expect(harness.owners[2]?.receiverOptions?.directory).toBe(firstHandover);
    expect((await readdir(join(appDataDirectory, "bolter", "connections"))).filter(name => name.endsWith(".sealed"))).toHaveLength(1);
    expect(harness.provisions).toBe(5);
  } finally { await Promise.allSettled([first?.retire(), recovered?.retire()]); harness.restore();
    await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("a repeated connect upgrades and resumes a receiver that is still wanted", async () => {
  const appDataDirectory = await managedDirectory();
  const runtimes = [installed(VERSION_A), installed(VERSION_A), installed(VERSION_B)];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B) });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true });
    await driver.connect(() => undefined);
    await driver.start(() => Promise.resolve(true));
    await driver.connect(() => undefined);
    expect(harness.owners.map(owner => ({ version: owner.version, starts: owner.receiverStarts })))
      .toEqual([{ version: VERSION_A, starts: 1 }, { version: VERSION_B, starts: 1 }]);
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("a simultaneous ordinary check cannot swallow an explicit connect latest check", async () => {
  const appDataDirectory = await managedDirectory();
  const runtimes = [installed(VERSION_A), installed(VERSION_B)];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B) });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true });
    await driver.connect(() => undefined);
    const [checked, connected] = await Promise.all([driver.check(), driver.connect(() => undefined)]);
    expect(checked.authentication).toBe("confirmed");
    expect(connected.authentication).toBe("confirmed");
    expect(harness.provisions).toBe(2);
    expect(harness.owners.map(owner => owner.version)).toEqual([VERSION_A, VERSION_B]);
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("a failed read checks latest and retries exactly once only when the version changed", async () => {
  const appDataDirectory = await managedDirectory(); let reads = 0;
  const runtimes = [installed(VERSION_A), installed(VERSION_B)];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B),
    conversations: async owner => { reads++; return owner.version === VERSION_B
      ? { status: "available", conversations: [{ chatId: "chat", label: "Recovered", threadRootId: null }] }
      : { status: "unavailable", reason: "execution-failed" }; } });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true });
    expect(await driver.conversations()).toEqual({ kind: "conversations",
      conversations: [{ chatId: "chat", label: "Recovered", threadRootId: null }] });
    expect({ provisions: harness.provisions, reads, versions: harness.owners.map(owner => owner.version) })
      .toEqual({ provisions: 2, reads: 2, versions: [VERSION_A, VERSION_B] });
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

for (const nextVersion of [VERSION_A, VERSION_B] as const) {
  test(`a failed read is bounded when latest is ${nextVersion === VERSION_A ? "unchanged" : "newer but still failing"}`, async () => {
    const appDataDirectory = await managedDirectory(); let reads = 0;
    const runtimes = [installed(VERSION_A), installed(nextVersion)];
    const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(nextVersion),
      conversations: async () => { reads++; return { status: "unavailable", reason: "execution-failed" }; } });
    let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
    try {
      driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
        homeHandle: "synthetic-home", isCurrent: () => true });
      expect(await driver.conversations()).toEqual({ kind: "unavailable", reason: "identity_unconfirmed" });
      expect(harness.provisions).toBe(2); expect(reads).toBe(nextVersion === VERSION_A ? 1 : 2);
      expect(harness.owners).toHaveLength(nextVersion === VERSION_A ? 1 : 2);
    } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
  });
}

test("concurrent failures share one upgrade", async () => {
  const appDataDirectory = await managedDirectory(); const upgrade = deferred<BolterInstalledRuntime>();
  const harness = installOwnerHarness({ provision: async () => harness.provisions === 1 ? installed(VERSION_A) : upgrade.promise,
    conversations: async owner => owner.version === VERSION_B ? { status: "available", conversations: [] }
      : { status: "unavailable", reason: "execution-failed" } });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true }); await driver.connect(() => undefined);
    const first = driver.conversations(); const second = driver.conversations();
    await waitFor(() => harness.provisions === 2); upgrade.resolve(installed(VERSION_B));
    expect((await Promise.all([first, second])).every(result => result.kind === "conversations")).toBeTrue();
    expect(harness.provisions).toBe(2); expect(harness.owners.map(owner => owner.version)).toEqual([VERSION_A, VERSION_B]);
  } finally { upgrade.resolve(installed(VERSION_B)); await driver?.retire(); harness.restore();
    await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("failed acquisition preserves the existing owner", async () => {
  const appDataDirectory = await managedDirectory(); let available = false;
  const harness = installOwnerHarness({ provision: async () => {
    if (harness.provisions === 1) return installed(VERSION_A); throw new Error("synthetic acquisition failure"); },
    conversations: async () => available ? { status: "available", conversations: [] }
      : { status: "unavailable", reason: "execution-failed" } });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true }); await driver.connect(() => undefined);
    const existing = harness.owners[0]!;
    let acquisitionError: unknown;
    try { await driver.conversations(); } catch (error) { acquisitionError = error; }
    expect(acquisitionError).toBeInstanceOf(Error);
    expect((acquisitionError as Error).message).toBe("synthetic acquisition failure");
    expect(existing.retirements).toBe(0); available = true;
    expect((await driver.conversations()).kind).toBe("conversations"); expect(harness.owners).toEqual([existing]);
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("an uncertain released send is never replayed and refreshes only future send authority", async () => {
  const appDataDirectory = await managedDirectory(); const runtimes = [installed(VERSION_A), installed(VERSION_B)];
  const sends: string[] = []; const prepares: string[] = [];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B),
    prepareSend: async owner => { prepares.push(owner.version); return { send: async () => {
      sends.push(owner.version); return owner.state === "retired" ? { status: "unavailable", reason: "stale-authority" }
        : { status: "uncertain", reason: "execution-failed" }; } }; } });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true }); await driver.connect(() => undefined);
    const released = await driver.prepareSend();
    expect(await released?.({ chatId: "chat", threadRootId: null, content: "send once" })).toEqual({ kind: "uncertain" });
    await waitFor(() => harness.owners.some(owner => owner.version === VERSION_B)); expect(sends).toEqual([VERSION_A]);
    expect(await driver.prepareSend()).not.toBeNull(); expect(prepares).toEqual([VERSION_A, VERSION_B]);
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("retiring an old owner invalidates its prepared send", async () => {
  const appDataDirectory = await managedDirectory(); const runtimes = [installed(VERSION_A), installed(VERSION_B)];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B),
    conversations: async owner => owner.version === VERSION_A ? { status: "unavailable", reason: "execution-failed" }
      : { status: "available", conversations: [] },
    prepareSend: async owner => ({ send: async () => owner.state === "unavailable" || owner.state === "retired"
      ? { status: "unavailable", reason: "stale-authority" }
      : { status: "sent", receipt: { messageId: "receipt", chatId: "chat", threadRootId: null } } }) });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true }); await driver.connect(() => undefined);
    const prepared = await driver.prepareSend(); await driver.conversations();
    expect(await prepared?.({ chatId: "chat", threadRootId: null, content: "stale" }))
      .toEqual({ kind: "unavailable", reason: "authority_changed" });
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("an unexpected receiver exit upgrades and restarts once", async () => {
  const appDataDirectory = await managedDirectory();
  const runtimes = [installed(VERSION_A), installed(VERSION_A), installed(VERSION_B)];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B) });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true }); await driver.connect(() => undefined);
    await driver.start(() => Promise.resolve(true)); const old = harness.owners[0]!; old.state = "unavailable";
    old.receiverOptions?.onStateChange?.(); old.receiverOptions?.onStateChange?.();
    await waitFor(() => harness.owners.some(owner => owner.version === VERSION_B && owner.receiverStarts === 1));
    expect(harness.provisions).toBe(3); expect(harness.owners[1]?.receiverStarts).toBe(1);
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("a healthy recovered receiver can update again after a later failure", async () => {
  const appDataDirectory = await managedDirectory();
  const versionC = "c".repeat(40);
  const runtimes = [installed(VERSION_A), installed(VERSION_A), installed(VERSION_B), installed(versionC)];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(versionC) });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true });
    await driver.connect(() => undefined); await driver.start(() => Promise.resolve(true));
    const first = harness.owners[0]!;
    first.state = "unavailable"; first.receiverOptions?.onStateChange?.();
    await waitFor(() => harness.owners[1]?.receiverStarts === 1);
    const second = harness.owners[1]!;
    second.receiverOptions?.onStateChange?.(); // A recognized packet makes the recovered receiver Listening.
    second.state = "unavailable"; second.receiverOptions?.onStateChange?.();
    await waitFor(() => harness.owners[2]?.receiverStarts === 1);
    expect(harness.provisions).toBe(4);
    expect(harness.owners.map(owner => owner.version)).toEqual([VERSION_A, VERSION_B, versionC]);
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("a blocked inbox drain checks latest and resumes intake once on a newer runtime", async () => {
  const appDataDirectory = await managedDirectory();
  const runtimes = [installed(VERSION_A), installed(VERSION_A), installed(VERSION_B)];
  const drains: string[] = [];
  const reasons: Array<string | undefined> = [];
  const harness = installOwnerHarness({ provision: async () => runtimes.shift() ?? installed(VERSION_B),
    flushInbox: async owner => { drains.push(owner.version); return owner.version === VERSION_A ? "blocked" : "accepted"; } });
  let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
  try {
    driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
      homeHandle: "synthetic-home", isCurrent: () => true });
    await driver.connect(() => undefined);
    await driver.start(() => Promise.resolve(true), observation => { reasons.push(observation.reason); });
    await waitFor(() => harness.owners.some(owner => owner.version === VERSION_B && owner.receiverStarts === 1));
    expect(harness.provisions).toBe(3);
    expect(drains).toEqual([VERSION_A, VERSION_B]);
    expect(reasons).toContain("receiver_unavailable");
    expect(reasons.at(-1)).toBeUndefined();
  } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
});

for (const fence of ["pause", "retire"] as const) {
  test(`${fence} aborts a hanging receiver runtime acquisition without installing a successor`, async () => {
    const appDataDirectory = await managedDirectory();
    let acquisitionSignal: AbortSignal | undefined;
    let acquisitionSettled = false;
    const harness = installOwnerHarness({ provision: async input => {
      if (harness.provisions < 3) return installed(VERSION_A);
      acquisitionSignal = input.signal;
      try {
        return await new Promise<BolterInstalledRuntime>((_resolve, reject) => {
          const aborted = () => reject(new Error("synthetic acquisition aborted"));
          if (input.signal?.aborted) aborted();
          else input.signal?.addEventListener("abort", aborted, { once: true });
        });
      } finally { acquisitionSettled = true; }
    } });
    let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
    try {
      driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
        homeHandle: "synthetic-home", isCurrent: () => true });
      await driver.connect(() => undefined);
      await driver.start(() => Promise.resolve(true));
      const old = harness.owners[0]!;
      old.state = "unavailable";
      old.receiverOptions?.onStateChange?.();
      await waitFor(() => acquisitionSignal !== undefined);
      if (fence === "pause") await driver.pause();
      else await driver.retire();
      await waitFor(() => acquisitionSignal?.aborted === true && acquisitionSettled);
      expect(acquisitionSignal?.aborted).toBeTrue();
      expect(harness.owners).toEqual([old]);
      expect(harness.owners.some(owner => owner.version === VERSION_B || owner.receiverStarts > 1)).toBeFalse();
    } finally { await driver?.retire(); harness.restore(); await rm(appDataDirectory, { recursive: true, force: true }); }
  });
}

for (const fence of ["pause", "retire", "stale"] as const) {
  test(`${fence} while a receiver upgrade is downloading prevents restart`, async () => {
    const appDataDirectory = await managedDirectory(); const upgrade = deferred<BolterInstalledRuntime>(); let current = true;
    const harness = installOwnerHarness({ provision: async () => harness.provisions < 3 ? installed(VERSION_A) : upgrade.promise });
    let driver: Awaited<ReturnType<ReturnType<typeof factory>>> | undefined;
    try {
      driver = await factory(appDataDirectory)({ connectionId: "synthetic-connection", generation: 1,
        homeHandle: "synthetic-home", isCurrent: () => current }); await driver.connect(() => undefined);
      await driver.start(() => Promise.resolve(true)); const old = harness.owners[0]!; old.state = "unavailable";
      old.receiverOptions?.onStateChange?.(); await waitFor(() => harness.provisions === 3);
      let retirement: Promise<void> | undefined;
      if (fence === "pause") await driver.pause();
      if (fence === "retire") retirement = driver.retire();
      if (fence === "stale") current = false;
      upgrade.resolve(installed(VERSION_B)); await retirement; await new Promise<void>(resolve => setImmediate(resolve));
      expect(harness.owners.filter(owner => owner.version === VERSION_B).every(owner => owner.receiverStarts === 0)).toBeTrue();
    } finally { upgrade.resolve(installed(VERSION_B)); current = false; await driver?.retire(); harness.restore();
      await rm(appDataDirectory, { recursive: true, force: true }); }
  });
}
