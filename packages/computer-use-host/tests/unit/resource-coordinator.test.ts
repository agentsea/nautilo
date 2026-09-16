import { describe, expect, test } from "bun:test";

import {
  COMPUTER_USE_WORKSTATION_STATE_RESOURCE,
  ComputerUseResourceCoordinator,
} from "../../src/resource-coordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("computer use private resource coordinator", () => {
  test("overlaps readers and independent resources but drains conflicting work in FIFO order", async () => {
    const coordinator = new ComputerUseResourceCoordinator();
    const signal = new AbortController().signal;
    const first = deferred<void>();
    const second = deferred<void>();
    const events: string[] = [];
    const readOne = coordinator.withClaims([{ key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: "read" }], signal, async () => {
      events.push("read-one:start"); await first.promise; events.push("read-one:end");
    });
    const readTwo = coordinator.withClaims([{ key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: "read" }], signal, async () => {
      events.push("read-two:start"); await second.promise; events.push("read-two:end");
    });
    const write = coordinator.withClaims([{ key: COMPUTER_USE_WORKSTATION_STATE_RESOURCE, mode: "write" }], signal, async () => {
      events.push("write");
    });
    const unrelated = coordinator.withClaims([{ key: "browser:other-tab", mode: "write" }], signal, async () => {
      events.push("unrelated");
    });
    await Promise.resolve();
    expect(events).toEqual(["read-one:start", "read-two:start", "unrelated"]);
    first.resolve();
    await readOne;
    expect(events).not.toContain("write");
    second.resolve();
    await Promise.all([readTwo, write, unrelated]);
    expect(events.at(-1)).toBe("write");
  });

  test("acquires claim sets atomically and does not let a later conflicting reader pass a writer", async () => {
    const coordinator = new ComputerUseResourceCoordinator();
    const signal = new AbortController().signal;
    const release = deferred<void>();
    const events: string[] = [];
    const active = coordinator.withClaims([{ key: "window:a", mode: "read" }], signal, async () => {
      events.push("active"); await release.promise;
    });
    const writer = coordinator.withClaims([
      { key: "window:a", mode: "write" },
      { key: "window:b", mode: "write" },
    ], signal, async () => { events.push("writer"); });
    const lateReader = coordinator.withClaims([{ key: "window:a", mode: "read" }], signal, async () => { events.push("late"); });
    await Promise.resolve();
    expect(events).toEqual(["active"]);
    release.resolve();
    await Promise.all([active, writer, lateReader]);
    expect(events).toEqual(["active", "writer", "late"]);
  });

  test("queued cancellation never executes and cannot abort a healthy sibling", async () => {
    const coordinator = new ComputerUseResourceCoordinator();
    const release = deferred<void>();
    const running = coordinator.withClaims([{ key: "tab", mode: "write" }], new AbortController().signal,
      async () => { await release.promise; return "healthy"; });
    const controller = new AbortController();
    let dispatched = false;
    const queued = coordinator.withClaims([{ key: "tab", mode: "write" }], controller.signal, () => {
      dispatched = true; return "cancelled";
    });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatched).toBe(false);
    release.resolve();
    await expect(running).resolves.toBe("healthy");
  });

  test("cancellation at the granted-to-execution microtask boundary does not dispatch", async () => {
    const coordinator = new ComputerUseResourceCoordinator();
    const controller = new AbortController();
    let dispatched = false;
    const pending = coordinator.withClaims([{ key: "tab", mode: "write" }], controller.signal, () => {
      dispatched = true;
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatched).toBe(false);
  });

  test("holds claims until rejected execution settles and releases them afterward", async () => {
    const coordinator = new ComputerUseResourceCoordinator();
    const signal = new AbortController().signal;
    const release = deferred<void>();
    const events: string[] = [];
    const failed = coordinator.withClaims([{ key: "tab", mode: "write" }], signal, async () => {
      events.push("first"); await release.promise; throw new Error("failure");
    });
    const next = coordinator.withClaims([{ key: "tab", mode: "read" }], signal, () => { events.push("next"); });
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    release.resolve();
    await expect(failed).rejects.toThrow("failure");
    await next;
    expect(events).toEqual(["first", "next"]);
  });
});
