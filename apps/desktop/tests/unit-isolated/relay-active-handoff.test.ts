/**
 * M161 Phase 2.3 — active-only relay handoff (stop-before-start).
 *
 * Asserts `setActiveRelay` (in `electron/relay.ts`) awaits `stopRelay`
 * BEFORE `startRelay`, that at most one relay start fires per handoff
 * (one client maximum), and that a background session's `relayActive`
 * flag is `false` after a handoff to another session. Uses the
 * `relayHandoffForTests` seam to inject mock start/stop hooks so the
 * ordering can be observed without a live relay connection.
 *
 * `electron/main.ts` cannot be imported under bun:test (Electron runtime
 * boot), so the handoff helper is exercised directly with electron
 * mocked, mirroring `relay-workstation-profile-advertisement.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RelayMcpHostHandle } from "@nautilo/mcp-client";
import type { RelayClient } from "@nautilo/relay";

import { DesktopRelaySession } from "../../electron/desktop-relay-session.ts";
import type { RelayCapabilityPublisher } from "../../electron/relay-capability-publisher.ts";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-test-userdata" },
}));

let setActiveRelay: typeof import("../../electron/relay").setActiveRelay;
let relayHandoffForTests: typeof import("../../electron/relay").relayHandoffForTests;
let relaySessionLifecycleForTests: typeof import("../../electron/relay").relaySessionLifecycleForTests;
let stopRelay: typeof import("../../electron/relay").stopRelay;
let ServerSessionRegistry: typeof import("../../electron/server-sessions/registry").ServerSessionRegistry;

beforeAll(async () => {
  ({
    setActiveRelay,
    relayHandoffForTests,
    relaySessionLifecycleForTests,
    stopRelay,
  } = await import("../../electron/relay"));
  ({ ServerSessionRegistry } = await import("../../electron/server-sessions/registry"));
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function candidate(log: string[]) {
  const session = new DesktopRelaySession({ serverUrl: "https://candidate.example" });
  const client = {
    disconnect: async () => {
      log.push("client:disconnect");
    },
  } as unknown as RelayClient;
  const mcpHost = {
    stop: async () => {
      log.push("mcp:stop");
    },
  } as unknown as RelayMcpHostHandle;
  const publisher = {
    close: () => log.push("publisher:close"),
  } as unknown as RelayCapabilityPublisher;
  session.attachMcpHost(mcpHost);
  session.attachTransport(client, publisher);
  return session;
}

const OPTS_A = {
  serverUrl: "https://a.example",
  userId: "user-a",
  token: "tok-a",
} as const;

const OPTS_B = {
  serverUrl: "https://b.example",
  userId: "user-b",
  token: "tok-b",
} as const;

describe("setActiveRelay — stop-before-start handoff (M161 Phase 2.3)", () => {
  let log: string[];
  let inFlightStarts: number;
  let maxConcurrentStarts: number;

  beforeEach(() => {
    log = [];
    inFlightStarts = 0;
    maxConcurrentStarts = 0;
    relayHandoffForTests.setStartStopHooks(
      (opts) => {
        inFlightStarts += 1;
        maxConcurrentStarts = Math.max(maxConcurrentStarts, inFlightStarts);
        log.push(`start:${opts.serverUrl}`);
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            inFlightStarts -= 1;
            resolve();
          }, 0);
        });
      },
      () => {
        log.push("stop:call");
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            log.push("stop:resolve");
            resolve();
          }, 0);
        });
      },
    );
  });

  test("awaits stopRelay before startRelay (ordering)", async () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    await setActiveRelay(r, a, { ...OPTS_A });
    // stop must fully resolve before start begins.
    expect(log).toEqual(["stop:call", "stop:resolve", "start:https://a.example"]);
  });

  test("at most one relay start is in flight at a time (one client maximum)", async () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    await setActiveRelay(r, a, { ...OPTS_A });
    expect(maxConcurrentStarts).toBe(1);
  });

  test("overlapping public handoffs are last-request-wins before either start", async () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    const stopA = deferred<void>();
    const stopB = deferred<void>();
    let stopCalls = 0;
    const starts: string[] = [];
    relayHandoffForTests.setStartStopHooks(
      async (opts) => {
        starts.push(opts.serverUrl);
      },
      () => {
        stopCalls += 1;
        return stopCalls === 1 ? stopA.promise : stopB.promise;
      },
    );

    const handoffA = setActiveRelay(r, a, { ...OPTS_A });
    const handoffB = setActiveRelay(r, b, { ...OPTS_B });
    await Promise.resolve();
    expect(stopCalls).toBe(1);

    stopA.resolve(undefined);
    await handoffA;
    await Promise.resolve();
    expect(stopCalls).toBe(2);
    expect(starts).toEqual([]);
    expect(a.relayActive).toBe(false);

    stopB.resolve(undefined);
    await handoffB;
    expect(starts).toEqual(["https://b.example"]);
    expect(a.relayActive).toBe(false);
    expect(b.relayActive).toBe(true);
  });

  test("target session is relayActive=true after handoff", async () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    expect(a.relayActive).toBe(false);
    expect(b.relayActive).toBe(false);
    await setActiveRelay(r, a, { ...OPTS_A });
    expect(a.relayActive).toBe(true);
    // The background session stays false.
    expect(b.relayActive).toBe(false);
  });

  test("background session relayActive=false after handoff to another session", async () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    // Hand relay to A first.
    await setActiveRelay(r, a, { ...OPTS_A });
    expect(a.relayActive).toBe(true);
    expect(b.relayActive).toBe(false);
    // Now hand off to B (Phase 3 switch simulation). A becomes background.
    await setActiveRelay(r, b, { ...OPTS_B });
    expect(b.relayActive).toBe(true);
    expect(a.relayActive).toBe(false);
  });

  test("handoff to another session stops the previous relay before starting the new one", async () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    await setActiveRelay(r, a, { ...OPTS_A });
    log.length = 0;
    await setActiveRelay(r, b, { ...OPTS_B });
    // The second handoff must stop (A's relay) before starting (B's relay).
    expect(log).toEqual(["stop:call", "stop:resolve", "start:https://b.example"]);
    expect(maxConcurrentStarts).toBe(1);
  });

  test("re-keying: start receives the TARGET session's serverUrl (no cross-server OAuth context leak)", async () => {
    const r = new ServerSessionRegistry();
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    await setActiveRelay(r, a, { ...OPTS_A });
    await setActiveRelay(r, b, { ...OPTS_B });
    // The last start must carry B's serverUrl, so startRelay captures B's
    // exact OAuth tuple (safety boundary #4).
    expect(log[log.length - 1]).toBe("start:https://b.example");
  });
});

describe("Desktop relay pending-candidate and bound-work races", () => {
  beforeEach(async () => {
    relayHandoffForTests.setStartStopHooks(null, null);
    await stopRelay();
  });

  afterEach(async () => {
    await stopRelay();
  });

  test("stop invalidates a deferred connect, cleans its exact handles, and prevents late activation", async () => {
    const log: string[] = [];
    const session = candidate(log);
    const generation = relaySessionLifecycleForTests.beginCandidate(session);
    const connect = deferred<void>();
    let activations = 0;
    const pending = relaySessionLifecycleForTests.connectAndActivate(
      session,
      generation,
      () => connect.promise,
      () => {
        activations += 1;
      },
    );

    await stopRelay();
    expect(log).toEqual([
      "publisher:close",
      "mcp:stop",
      "client:disconnect",
    ]);
    expect(session.closed).toBe(true);

    connect.resolve(undefined);
    expect(await pending).toBe(false);
    expect(activations).toBe(0);
  });

  test("a direct candidate cannot replace or orphan an already active session", async () => {
    const activeLog: string[] = [];
    const active = candidate(activeLog);
    const activeGeneration = relaySessionLifecycleForTests.beginCandidate(active);
    expect(await relaySessionLifecycleForTests.activateCandidate(
      active,
      activeGeneration,
    )).toBe(true);

    const replacement = new DesktopRelaySession({ serverUrl: "https://replacement.example" });
    expect(() => relaySessionLifecycleForTests.beginCandidate(replacement)).toThrow(
      "The active Desktop relay must be stopped before starting another.",
    );
    expect(active.closed).toBe(false);
    expect(activeLog).toEqual([]);

    await stopRelay();
    expect(active.closed).toBe(true);
    expect(activeLog).toEqual([
      "publisher:close",
      "mcp:stop",
      "client:disconnect",
    ]);
    expect(replacement.closed).toBe(false);
    replacement.retire();
    await replacement.finishRetirement();
  });

  test("replacement begins only after retired bound work settles and old work cannot commit", async () => {
    const log: string[] = [];
    const sessionA = candidate(log);
    relaySessionLifecycleForTests.beginCandidate(sessionA);
    const effect = deferred<void>();
    const boundEffect = sessionA.settleBoundWork(effect.promise.then(() => {
      sessionA.browserCoordinateScales.set("old-session", 2);
      log.push("effect:settled");
    }));
    let replacementBegan = false;
    let activeClients = 0;
    let maxActiveClients = 0;

    const replacement = (async () => {
      await stopRelay();
      replacementBegan = true;
      const sessionB = new DesktopRelaySession({ serverUrl: "https://b.example" });
      const generationB = relaySessionLifecycleForTests.beginCandidate(sessionB);
      const activated = await relaySessionLifecycleForTests.connectAndActivate(
        sessionB,
        generationB,
        async () => {},
        () => {
          activeClients += 1;
          maxActiveClients = Math.max(maxActiveClients, activeClients);
        },
      );
      return { activated, sessionB };
    })();

    for (let index = 0; index < 5 && log.length < 3; index += 1) {
      await Promise.resolve();
    }
    expect(log).toEqual([
      "publisher:close",
      "mcp:stop",
      "client:disconnect",
    ]);
    expect(replacementBegan).toBe(false);

    effect.resolve(undefined);
    await boundEffect;
    const { activated, sessionB } = await replacement;
    expect(activated).toBe(true);
    expect(replacementBegan).toBe(true);
    expect(sessionA.browserCoordinateScales.get("old-session")).toBeUndefined();
    expect(log.at(-1)).toBe("effect:settled");
    expect(maxActiveClients).toBe(1);

    activeClients -= 1;
    sessionB.retire();
    await sessionB.finishRetirement();
    expect(activeClients).toBe(0);
  });
});
