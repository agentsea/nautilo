/**
 * M210 Phase 3 — pool shutdown registry unit tests.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  __getRegisteredPoolNamesForTests,
  __resetPoolShutdownRegistryForTests,
  closeRegisteredPools,
  registerPoolForShutdown,
} from "../../src/config/pool-shutdown-registry";

describe("pool shutdown registry (M210 Phase 3)", () => {
  afterEach(() => {
    __resetPoolShutdownRegistryForTests();
  });

  it("registers stable non-secret pool names", () => {
    registerPoolForShutdown({
      name: "direct:nautilo",
      close: async () => {},
    });
    expect(__getRegisteredPoolNamesForTests()).toEqual(["direct:nautilo"]);
  });

  it("deterministically replaces duplicate registrations by name", () => {
    let firstClosed = false;
    registerPoolForShutdown({
      name: "direct:nautilo",
      close: async () => {
        firstClosed = true;
      },
    });
    registerPoolForShutdown({
      name: "direct:nautilo",
      close: async () => {},
    });
    expect(__getRegisteredPoolNamesForTests()).toEqual(["direct:nautilo"]);
    void firstClosed;
  });

  it("unregister removes only the matching registration", async () => {
    const unregister = registerPoolForShutdown({
      name: "direct:nautilo-agent",
      close: async () => {},
    });
    unregister();
    expect(__getRegisteredPoolNamesForTests()).toEqual([]);
  });

  it("closeRegisteredPools is idempotent", async () => {
    let closeCount = 0;
    registerPoolForShutdown({
      name: "direct:nautilo",
      close: async () => {
        closeCount++;
      },
    });
    await closeRegisteredPools({ timeoutMs: 100 });
    await closeRegisteredPools({ timeoutMs: 100 });
    expect(closeCount).toBe(1);
  });

  it("attempts every closer even when one rejects", async () => {
    const closed: string[] = [];
    registerPoolForShutdown({
      name: "direct:nautilo",
      close: async () => {
        closed.push("direct:nautilo");
        throw new Error("boom");
      },
    });
    registerPoolForShutdown({
      name: "direct:nautilo-agent",
      close: async () => {
        closed.push("direct:nautilo-agent");
      },
    });
    const errors: string[] = [];
    await closeRegisteredPools({
      timeoutMs: 100,
      onError: (name) => errors.push(name),
    });
    expect(closed).toEqual(["direct:nautilo", "direct:nautilo-agent"]);
    expect(errors).toEqual(["direct:nautilo"]);
  });

  it("passes bounded timeoutMs to closers", async () => {
    let receivedTimeout = 0;
    registerPoolForShutdown({
      name: "direct:nautilo",
      close: async (timeoutMs) => {
        receivedTimeout = timeoutMs;
      },
    });
    await closeRegisteredPools({ timeoutMs: 250 });
    expect(receivedTimeout).toBe(250);
  });

  it("reports timeout failures via onError without stopping other pools", async () => {
    const closed: string[] = [];
    registerPoolForShutdown({
      name: "slow",
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    registerPoolForShutdown({
      name: "fast",
      close: async () => {
        closed.push("fast");
      },
    });
    const errors: string[] = [];
    await closeRegisteredPools({
      timeoutMs: 1,
      onError: (name) => errors.push(name),
    });
    expect(closed).toContain("fast");
    expect(errors).toContain("slow");
  });

  it("starts every closer before a hanging closer times out", async () => {
    const started: string[] = [];
    registerPoolForShutdown({
      name: "never",
      close: async () => {
        started.push("never");
        await new Promise<void>(() => {});
      },
    });
    registerPoolForShutdown({
      name: "fast",
      close: async () => {
        started.push("fast");
      },
    });
    registerPoolForShutdown({
      name: "also-fast",
      close: async () => {
        started.push("also-fast");
      },
    });

    const errors: string[] = [];
    await closeRegisteredPools({
      timeoutMs: 10,
      onError: (name) => errors.push(name),
    });

    expect(started).toEqual(["never", "fast", "also-fast"]);
    expect(errors).toEqual(["never"]);
  });

  it("reset clears registry state for tests", async () => {
    registerPoolForShutdown({
      name: "direct:nautilo",
      close: async () => {},
    });
    __resetPoolShutdownRegistryForTests();
    expect(__getRegisteredPoolNamesForTests()).toEqual([]);
    await closeRegisteredPools({ timeoutMs: 100 });
  });
});
