import { describe, expect, test } from "bun:test";
import type {
  RelayCodexHostPort,
  RelayCodexHostTransport,
  RelayCodexSession,
} from "@nautilo/relay";
import {
  ElectronCodexConnection,
  type ManagedElectronCodexHost,
} from "../../electron/codex-connection";

type Command = Parameters<NonNullable<RelayCodexHostPort["onCommand"]>>[0];
type Cancel = Parameters<NonNullable<RelayCodexHostPort["onCancel"]>>[0];
type Credit = Parameters<NonNullable<RelayCodexHostPort["onCredit"]>>[0];
type RequestResponse = Parameters<NonNullable<RelayCodexHostPort["onRequestResponse"]>>[0];

describe("ElectronCodexConnection", () => {
  test("is inert while disabled and never calls its lazy factory", async () => {
    let factories = 0;
    const connection = new ElectronCodexConnection({
      refreshRelay: async () => "acked",
    });
    expect(connection.isReady()).toBe(false);
    expect(connection.status()).toEqual({
      state: "disabled",
      ready: false,
      relayReconciliation: null,
    });
    await connection.onRegistered?.(session(), transport());
    await connection.onCommand?.({} as Command);
    connection.onDisconnected?.();
    expect(factories).toBe(0);
    await connection.shutdown();
    expect(factories).toBe(0);
  });

  test("enables lazily, refreshes once, and exposes only real host readiness", async () => {
    const host = new FakeHost(); const refreshes: string[] = []; let factories = 0;
    const createHost = () => { factories += 1; return host; };
    const connection = new ElectronCodexConnection({
      refreshRelay: async (reason) => { refreshes.push(reason); return "acked"; },
    });
    await connection.enable(createHost);
    expect(factories).toBe(1); expect(refreshes).toEqual(["codex connection enabled"]); expect(connection.isReady()).toBe(true);
    host.ready = false; expect(connection.isReady()).toBe(false);
    host.ready = true; await connection.enable(createHost); expect(factories).toBe(1); expect(refreshes).toHaveLength(1);
    expect(connection.status()).toEqual({
      state: "enabled",
      ready: true,
      relayReconciliation: "acked",
    });
  });

  test("exposes only a conservative read-only active-work answer", async () => {
    const host = new FakeHost();
    const connection = new ElectronCodexConnection({ refreshRelay: async () => "acked" });
    expect(await connection.hasActiveWork()).toBe(false);
    await connection.enable(() => host);
    host.activeWork = true;
    expect(await connection.hasActiveWork()).toBe(true);
    host.hasActiveWorkFailure = true;
    expect(await connection.hasActiveWork()).toBe(true);
  });

  test("projects synchronous lifecycle fences without leaking failure details", async () => {
    const created = deferred<ManagedElectronCodexHost>();
    const connection = new ElectronCodexConnection({ refreshRelay: async () => "acked" });
    const enabling = connection.enable(() => created.promise);
    expect(connection.status()).toEqual({
      state: "enabling",
      ready: false,
      relayReconciliation: null,
    });

    const disabling = connection.disable();
    expect(connection.status()).toEqual({
      state: "disabling",
      ready: false,
      relayReconciliation: null,
    });
    created.resolve(new FakeHost());
    await Promise.all([enabling, disabling]);
    expect(connection.status()).toEqual({
      state: "disabled",
      ready: false,
      relayReconciliation: null,
    });

    const faulted = new ElectronCodexConnection({ refreshRelay: async () => "failed" });
    await rejects(faulted.enable(() => new FakeHost()), "relay refresh failed");
    expect(faulted.status()).toEqual({
      state: "disabled",
      ready: false,
      relayReconciliation: "failed",
    });
  });

  test("accepts deferred enable reconciliation but rolls back a failed acknowledgement", async () => {
    const deferredHost = new FakeHost();
    const deferredConnection = new ElectronCodexConnection({
      refreshRelay: async () => "deferred",
    });
    await deferredConnection.enable(() => deferredHost);
    expect(deferredConnection.isReady()).toBe(true);

    const failedHost = new FakeHost();
    const failedConnection = new ElectronCodexConnection({
      refreshRelay: async () => "failed",
    });
    await rejects(failedConnection.enable(() => failedHost), "relay refresh failed");
    expect(failedConnection.isReady()).toBe(false);
    expect(failedHost.shutdowns).toBe(1);
  });

  test("fences immediately, refreshes off before shutdown, and retains only disconnect delegation", async () => {
    const host = new FakeHost(); const refreshed = deferred<void>(); const order: string[] = [];
    host.onShutdown = async () => { order.push("shutdown"); };
    const connection = new ElectronCodexConnection({
      refreshRelay: async (reason) => {
        order.push(reason);
        if (reason.endsWith("disabled")) await refreshed.promise;
        return "acked";
      },
    });
    await connection.enable(() => host); order.length = 0;
    const disabling = connection.disable();
    expect(connection.isReady()).toBe(false);
    await connection.onCommand?.({} as Command);
    connection.onDisconnected?.();
    expect(host.commands).toBe(0); expect(host.disconnects).toBe(1);
    await until(() => order.length === 1);
    expect(order).toEqual(["codex connection disabled"]);
    refreshed.resolve(); await disabling;
    expect(order).toEqual(["codex connection disabled", "shutdown"]); expect(host.shutdowns).toBe(1);
  });

  test("singleflights concurrent toggles and tears down a superseded lazy creation exactly once", async () => {
    const created = deferred<ManagedElectronCodexHost>(); const refreshes: string[] = []; let factories = 0;
    const createHost = async () => { factories += 1; return created.promise; };
    const connection = new ElectronCodexConnection({
      refreshRelay: async (reason) => { refreshes.push(reason); return "acked"; },
    });
    const first = connection.enable(createHost); const second = connection.enable(createHost);
    await until(() => factories === 1);
    const disableOne = connection.disable(); const disableTwo = connection.disable();
    expect(disableOne).toBe(disableTwo);
    const host = new FakeHost(); created.resolve(host);
    await Promise.all([first, second, disableOne, disableTwo]);
    expect(connection.isReady()).toBe(false); expect(factories).toBe(1); expect(host.shutdowns).toBe(1);
    expect(refreshes).toEqual([]);
    await connection.disable(); expect(host.shutdowns).toBe(1); expect(refreshes).toEqual([]);
  });

  test("a re-enable queued behind disable cannot resurrect the superseded pending factory", async () => {
    const firstCreated = deferred<ManagedElectronCodexHost>(); const first = new FakeHost(); const second = new FakeHost(); const refreshes: string[] = []; let firstStarted = false;
    const connection = new ElectronCodexConnection({ refreshRelay: async (reason) => { refreshes.push(reason); return "acked"; } });
    const enablingFirst = connection.enable(() => { firstStarted = true; return firstCreated.promise; });
    await until(() => firstStarted);
    const disabling = connection.disable();
    const enablingSecond = connection.enable(() => second);
    firstCreated.resolve(first);
    await Promise.all([enablingFirst, disabling, enablingSecond]);
    expect(first.shutdowns).toBe(1); expect(first.events).toEqual([]);
    expect(second.shutdowns).toBe(0); expect(connection.isReady()).toBe(true);
    expect(refreshes).toEqual(["codex connection enabled"]);
  });

  test("a stale factory rejection cannot cancel a newer queued enable", async () => {
    let rejectFirst!: (error: Error) => void; let firstStarted = false;
    const firstFactory = new Promise<ManagedElectronCodexHost>((_resolve, reject) => { rejectFirst = reject; });
    const second = new FakeHost(); const refreshes: string[] = [];
    const connection = new ElectronCodexConnection({ refreshRelay: async (reason) => { refreshes.push(reason); return "acked"; } });
    const enablingFirst = connection.enable(() => { firstStarted = true; return firstFactory; });
    await until(() => firstStarted);
    const disabling = connection.disable();
    const enablingSecond = connection.enable(() => second);
    rejectFirst(new Error("stale factory"));
    await rejects(enablingFirst, "stale factory");
    await Promise.all([disabling, enablingSecond]);
    expect(connection.isReady()).toBe(true); expect(second.shutdowns).toBe(0);
    expect(refreshes).toEqual(["codex connection enabled"]);
  });

  test("fails closed on factory or refresh failure and shutdown cannot resurrect or double-close", async () => {
    const factoryFailure = new ElectronCodexConnection({
      refreshRelay: async () => "acked",
    });
    await rejects(factoryFailure.enable(async () => { throw new Error("factory"); }), "factory"); expect(factoryFailure.isReady()).toBe(false);

    const host = new FakeHost();
    const refreshFailure = new ElectronCodexConnection({
      refreshRelay: async () => { throw new Error("refresh"); },
    });
    await rejects(refreshFailure.enable(() => host), "refresh");
    expect(refreshFailure.isReady()).toBe(false); expect(host.shutdowns).toBe(1);
    const closeOne = refreshFailure.shutdown(); const closeTwo = refreshFailure.shutdown();
    expect(closeOne).toBe(closeTwo); await closeOne; expect(host.shutdowns).toBe(1);
    await rejects(refreshFailure.enable(() => new FakeHost()), "shut down");
  });

  test("delegates every relay callback only to the current enabled generation across reconnects", async () => {
    const first = new FakeHost(); const second = new FakeHost(); const hosts = [first, second];
    const createHost = () => hosts.shift()!;
    const connection = new ElectronCodexConnection({
      refreshRelay: async () => "acked",
    });
    const registeredSession = session(); const registeredTransport = transport();
    await connection.enable(createHost);
    await connection.onRegistered?.(registeredSession, registeredTransport);
    await connection.onCommand?.({} as Command);
    await connection.onCancel?.({} as Cancel);
    await connection.onCredit?.({} as Credit);
    await connection.onRequestResponse?.({} as RequestResponse);
    connection.onDisconnected?.();
    await connection.onRegistered?.(registeredSession, registeredTransport);
    expect(first.events).toEqual(["registered", "command", "cancel", "credit", "request-response", "disconnected", "registered"]);

    await connection.disable(); await connection.enable(createHost);
    await connection.onRegistered?.(registeredSession, registeredTransport);
    await connection.onCommand?.({} as Command);
    expect(first.events).toHaveLength(7);
    expect(second.events).toEqual(["registered", "command"]);
  });

  test("disable still shuts down exactly once when capability refresh fails", async () => {
    const host = new FakeHost();
    host.onShutdown = async () => { throw new Error("shutdown failure"); };
    const connection = new ElectronCodexConnection({
      refreshRelay: async (reason) => {
        if (reason.endsWith("disabled")) throw new Error("disable refresh");
        return "acked";
      },
    });
    await connection.enable(() => host);
    await rejects(connection.disable(), "disable refresh");
    expect(connection.isReady()).toBe(false); expect(host.shutdowns).toBe(1);
    await rejects(connection.enable(() => new FakeHost()), "shutdown failure");
    await rejects(connection.shutdown(), "shutdown failure");
    expect(host.shutdowns).toBe(1);
  });

  test("a shutdown failure during enable rollback terminal-faults the lifecycle", async () => {
    const host = new FakeHost();
    host.onShutdown = async () => { throw new Error("uncertain rollback"); };
    const connection = new ElectronCodexConnection({
      refreshRelay: async () => "failed",
    });
    await rejects(connection.enable(() => host), "relay refresh failed");
    expect(host.shutdowns).toBe(1);
    await rejects(connection.enable(() => new FakeHost()), "uncertain rollback");
  });

  test("a final shutdown failure retains terminal uncertainty and never retries the host", async () => {
    const host = new FakeHost();
    host.onShutdown = async () => { throw new Error("uncertain final shutdown"); };
    const connection = new ElectronCodexConnection({
      refreshRelay: async () => "acked",
    });
    await connection.enable(() => host);
    await rejects(connection.shutdown(), "uncertain final shutdown");
    expect(connection.status()).toEqual({
      state: "faulted",
      ready: false,
      relayReconciliation: "acked",
    });
    expect(host.shutdowns).toBe(1);
    await rejects(connection.enable(() => new FakeHost()), "shut down");
    expect(host.shutdowns).toBe(1);
  });

  test("shutdown racing a queued disable joins teardown without closing twice", async () => {
    const host = new FakeHost(); const releaseShutdown = deferred<void>();
    host.onShutdown = async () => releaseShutdown.promise;
    const connection = new ElectronCodexConnection({ refreshRelay: async () => "acked" });
    await connection.enable(() => host);
    const disabling = connection.disable(); await until(() => host.shutdowns === 1);
    const shutdownOne = connection.shutdown(); const shutdownTwo = connection.shutdown();
    expect(shutdownOne).toBe(shutdownTwo); expect(host.shutdowns).toBe(1);
    releaseShutdown.resolve(); await Promise.all([disabling, shutdownOne]);
    expect(host.shutdowns).toBe(1); expect(connection.isReady()).toBe(false);
  });
});

class FakeHost implements ManagedElectronCodexHost {
  ready = true;
  shutdowns = 0;
  commands = 0;
  disconnects = 0;
  events: string[] = [];
  activeWork = false;
  hasActiveWorkFailure = false;
  onShutdown: (() => Promise<void>) | undefined;

  isReady() { return this.ready; }
  onRegistered(_session: RelayCodexSession, _transport: RelayCodexHostTransport) { this.events.push("registered"); }
  onCommand(_message: Command) { this.commands += 1; this.events.push("command"); }
  onCancel(_message: Cancel) { this.events.push("cancel"); }
  onCredit(_message: Credit) { this.events.push("credit"); }
  onRequestResponse(_message: RequestResponse) { this.events.push("request-response"); }
  onDisconnected() { this.disconnects += 1; this.events.push("disconnected"); }
  async hasActiveWork() {
    if (this.hasActiveWorkFailure) throw new Error("uninspectable local activity");
    return this.activeWork;
  }
  async shutdown() { this.shutdowns += 1; await this.onShutdown?.(); }
}

function session(): RelayCodexSession {
  return {
    relayId: "relay",
    relaySessionId: "relay-session",
    desktopSessionId: "desktop",
    pairingGenerationRef: "pairing",
    selectedProtocolVersion: 8,
    capabilityRevision: 1,
  };
}
function transport(): RelayCodexHostTransport { return { send: () => true }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition not reached");
}
async function rejects(work: Promise<unknown>, message: string) {
  try { await work; }
  catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message); return; }
  throw new Error(`Expected rejection containing ${message}`);
}
