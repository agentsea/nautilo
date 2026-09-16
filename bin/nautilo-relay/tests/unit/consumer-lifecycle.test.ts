import { describe, expect, test } from "bun:test";

import {
  createHeadlessTerminationCoordinator,
  type HeadlessTerminationPorts,
} from "../../src/index";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function subject(overrides: Partial<HeadlessTerminationPorts> = {}) {
  const events: string[] = [];
  const errors: unknown[][] = [];
  const ports: HeadlessTerminationPorts = {
    mcpHost: {
      stop: async () => {
        events.push("mcp:stop");
      },
    },
    client: {
      disconnect: async () => {
        events.push("client:disconnect");
      },
    },
    log: (message) => {
      events.push(`log:${message}`);
    },
    reportError: (...args) => {
      errors.push(args);
    },
    exit: (code) => {
      events.push(`exit:${code}`);
    },
    ...overrides,
  };
  return {
    events,
    errors,
    terminate: createHeadlessTerminationCoordinator(ports),
  };
}

describe("headless relay consumer termination", () => {
  test("simultaneous SIGINT and SIGTERM share one exact LIFO sequence and exit", async () => {
    const { events, errors, terminate } = subject();

    const interrupt = terminate({ kind: "signal", signal: "SIGINT" });
    const terminateSignal = terminate({ kind: "signal", signal: "SIGTERM" });

    expect(terminateSignal).toBe(interrupt);
    await Promise.all([interrupt, terminateSignal]);
    expect(events).toEqual([
      "log:[relay] SIGINT received, disconnecting...",
      "mcp:stop",
      "client:disconnect",
      "exit:0",
    ]);
    expect(errors).toEqual([]);
  });

  test("MCP failure preserves the exact first error, still disconnects, and exits one", async () => {
    const failure = new Error("mcp stop failed");
    const laterFailure = new Error("disconnect also failed");
    const events: string[] = [];
    const { errors, terminate } = subject({
      mcpHost: {
        stop: async () => {
          events.push("mcp:stop");
          throw failure;
        },
      },
      client: {
        disconnect: async () => {
          events.push("client:disconnect");
          throw laterFailure;
        },
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
    });

    await terminate({ kind: "signal", signal: "SIGTERM" });
    expect(events).toEqual(["mcp:stop", "client:disconnect", "exit:1"]);
    expect(errors).toEqual([["[relay] Failed to shut down:", failure]]);
  });

  test("disconnect failure follows MCP stop and exits one", async () => {
    const failure = new Error("disconnect failed");
    const events: string[] = [];
    const { errors, terminate } = subject({
      mcpHost: {
        stop: async () => {
          events.push("mcp:stop");
        },
      },
      client: {
        disconnect: async () => {
          events.push("client:disconnect");
          throw failure;
        },
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
    });

    await terminate({ kind: "signal", signal: "SIGINT" });
    expect(events).toEqual(["mcp:stop", "client:disconnect", "exit:1"]);
    expect(errors).toEqual([["[relay] Failed to shut down:", failure]]);
  });

  test("connect failure reports once, performs LIFO teardown, and exits one", async () => {
    const failure = new Error("connect failed");
    const { events, errors, terminate } = subject();

    await terminate({ kind: "connect_failure", error: failure });
    expect(events).toEqual([
      "mcp:stop",
      "client:disconnect",
      "exit:1",
    ]);
    expect(errors).toEqual([["[relay] Failed to connect:", failure]]);
  });

  test("rejected pairing reports only the repair action and exits without retry", async () => {
    const { events, errors, terminate } = subject();

    await terminate({ kind: "authentication_required" });
    expect(events).toEqual([
      "mcp:stop",
      "client:disconnect",
      "exit:1",
    ]);
    expect(errors).toEqual([[
      "[relay] Pairing is missing, invalid, or revoked. Run `nautilo-relay pair` to continue.",
    ]]);
  });

  test("signal during pending connect owns termination and suppresses the induced connect failure", async () => {
    const connect = deferred<void>();
    const events: string[] = [];
    const errors: unknown[][] = [];
    const terminate = createHeadlessTerminationCoordinator({
      mcpHost: {
        stop: async () => {
          events.push("mcp:stop");
        },
      },
      client: {
        disconnect: async () => {
          events.push("client:disconnect");
          connect.reject(new Error("connect cancelled by disconnect"));
        },
      },
      log: (message) => {
        events.push(`log:${message}`);
      },
      reportError: (...args) => {
        errors.push(args);
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
    });
    const connecting = connect.promise.catch((connectError) =>
      terminate({ kind: "connect_failure", error: connectError })
    );

    const signalTermination = terminate({ kind: "signal", signal: "SIGTERM" });
    await Promise.all([signalTermination, connecting]);
    expect(events).toEqual([
      "log:[relay] SIGTERM received, disconnecting...",
      "mcp:stop",
      "client:disconnect",
      "exit:0",
    ]);
    expect(errors).toEqual([]);
  });
});
