import { describe, expect, mock, test } from "bun:test";
import { ComputerUseServerBindingLifecycle } from "../../electron/computer-use/server-binding-lifecycle.ts";

interface MemoryStore {
  readonly binding: string;
  receipt: boolean;
  revokeCalls: number;
  failRevoke?: boolean;
  revoke(): Promise<{ readonly ok: boolean }>;
}

function harness() {
  const stores = new Map<string, MemoryStore>();
  const adoptions: Array<{ binding: string | null; store: MemoryStore | null }> = [];
  const abortOwnedWork = mock(() => undefined);
  const failClosed = mock(async () => undefined);
  let createCalls = 0;
  const lifecycle = new ComputerUseServerBindingLifecycle<MemoryStore>({
    abortOwnedWork,
    createStore: (binding) => {
      createCalls += 1;
      const existing = stores.get(binding);
      if (existing !== undefined) return existing;
      const store: MemoryStore = {
        binding,
        receipt: false,
        revokeCalls: 0,
        async revoke() {
          this.revokeCalls += 1;
          if (this.failRevoke === true) return { ok: false };
          this.receipt = false;
          return { ok: true };
        },
      };
      stores.set(binding, store);
      return store;
    },
    adopt: (binding, store) => { adoptions.push({ binding, store }); },
    failClosed,
  });
  return { lifecycle, stores, adoptions, abortOwnedWork, failClosed, createCalls: () => createCalls };
}

describe("D516 server-scoped Computer use lifecycle", () => {
  test("same-server reconnect preserves the durable PIN grant and live store", async () => {
    const subject = harness();
    const first = await subject.lifecycle.configure("server-a");
    first!.receipt = true;
    const reconnect = await subject.lifecycle.configure("server-a");
    expect(reconnect).toBe(first);
    expect(reconnect!.receipt).toBe(true);
    expect(reconnect!.revokeCalls).toBe(0);
    expect(subject.createCalls()).toBe(1);
    expect(subject.abortOwnedWork).not.toHaveBeenCalled();
  });

  test("A to B aborts work and durably revokes A before adopting B", async () => {
    const subject = harness();
    const a = await subject.lifecycle.configure("server-a");
    a!.receipt = true;
    const b = await subject.lifecycle.configure("server-b");
    expect(subject.abortOwnedWork).toHaveBeenCalledTimes(1);
    expect(a!.revokeCalls).toBe(1);
    expect(a!.receipt).toBe(false);
    expect(b!.binding).toBe("server-b");
    expect(subject.adoptions.slice(-2).map((entry) => entry.binding)).toEqual([null, "server-b"]);
  });

  test("switching back cannot revive A without a new PIN grant", async () => {
    const subject = harness();
    const a = await subject.lifecycle.configure("server-a");
    a!.receipt = true;
    const b = await subject.lifecycle.configure("server-b");
    b!.receipt = true;
    const returnedA = await subject.lifecycle.configure("server-a");
    expect(returnedA).toBe(a);
    expect(returnedA!.receipt).toBe(false);
    expect(b!.receipt).toBe(false);
    expect(a!.revokeCalls).toBe(1);
  });

  test("failed durable revoke refuses adoption and retries before any reuse", async () => {
    const subject = harness();
    const a = await subject.lifecycle.configure("server-a");
    a!.receipt = true;
    a!.failRevoke = true;
    await expect(subject.lifecycle.configure("server-b")).rejects.toThrow("relay adoption was refused");
    expect(subject.adoptions.at(-1)).toEqual({ binding: null, store: null });
    expect(subject.failClosed).toHaveBeenCalledTimes(1);
    expect(subject.stores.has("server-b")).toBe(false);

    a!.failRevoke = false;
    const retried = await subject.lifecycle.configure("server-a");
    expect(retried).toBe(a);
    expect(a!.revokeCalls).toBe(2);
    expect(a!.receipt).toBe(false);
  });
});
