import { describe, expect, test } from "bun:test";

import { EncryptedCheckpointSaver } from "@nautilo/agent";
import type { CreateEncryptedCheckpointSaverOptions } from "@nautilo/agent";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  readProtectedTaskCheckpointPhysicalManifest,
  withNativeProtectedTaskCheckpointManifest,
  withNativeProtectedTaskCheckpointSaver,
  withProtectedTaskCheckpointSaver,
} from "../../src/tasks/protected-task-checkpoint-saver";

type Input = Parameters<typeof withProtectedTaskCheckpointSaver>[0];
type NativeInput = Parameters<typeof withNativeProtectedTaskCheckpointSaver>[0];
type NativeManifestInput = Parameters<
  typeof withNativeProtectedTaskCheckpointManifest
>[0];
type DedicatedPool = CreateEncryptedCheckpointSaverOptions["dedicatedPool"];

function fixture() {
  let closeCalls = 0;
  let poolCalls = 0;
  const input = {
    crypto: new LatticeCrypto(),
    evidence: {},
    identity: {
      taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "20000000-0000-4000-8000-000000000002",
      graphThreadId: "subagent:task:protected",
      sourceRoomId: "30000000-0000-4000-8000-000000000003",
      namespaceId: "40000000-0000-4000-8000-000000000004",
      domainId: "50000000-0000-4000-8000-000000000005",
      expectedAccessRevision: 4,
      expectedPolicyRevision: 7,
    },
    namespace: {},
    signal: new AbortController().signal,
    now: () => 1_800_000_000_000,
    assertCurrentTaskAuthority: async () => undefined,
    createDedicatedPool: () => {
      poolCalls += 1;
      return {
        connect: async () => {
          throw new Error("not used");
        },
        end: async () => {
          closeCalls += 1;
        },
      } as unknown as DedicatedPool;
    },
    execute: async (_saver: EncryptedCheckpointSaver) => "finished",
  } as Input;
  return {
    input,
    closeCalls: () => closeCalls,
    poolCalls: () => poolCalls,
  };
}

describe("protected Task checkpoint saver ownership", () => {
  test("closes the exact dedicated pool after a successful segment", async () => {
    const scenario = fixture();
    const result = await withProtectedTaskCheckpointSaver({
      ...scenario.input,
      execute: async (saver) => {
        expect(saver).toBeInstanceOf(EncryptedCheckpointSaver);
        return "completed";
      },
    });
    expect(result).toBe("completed");
    expect(scenario.poolCalls()).toBe(1);
    expect(scenario.closeCalls()).toBe(1);
  });

  test("closes the dedicated pool and preserves execution failure", async () => {
    const scenario = fixture();
    const failure = new Error("graph failed");
    const caught = await withProtectedTaskCheckpointSaver({
      ...scenario.input,
      execute: async () => {
        throw failure;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
    expect(scenario.poolCalls()).toBe(1);
    expect(scenario.closeCalls()).toBe(1);
  });

  test("refuses to share a checkpoint pool across Task-run segments", async () => {
    const scenario = fixture();
    const pool = scenario.input.createDedicatedPool();
    await withProtectedTaskCheckpointSaver({
      ...scenario.input,
      createDedicatedPool: () => pool,
    });
    let entered = false;
    const failure = await withProtectedTaskCheckpointSaver({
      ...scenario.input,
      createDedicatedPool: () => pool,
      execute: async () => {
        entered = true;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(entered).toBe(false);
    expect(scenario.closeCalls()).toBe(1);
  });

  test("native cells use a fresh Task-run saver and close its pool", async () => {
    const scenario = fixture();
    const native = {
      ...scenario.input,
      restricted: {},
      serverScope: "http://localhost:3001",
      domains: [],
      execute: async (saver: EncryptedCheckpointSaver) => {
        expect(saver).toBeInstanceOf(EncryptedCheckpointSaver);
        return "native-completed";
      },
    } as unknown as NativeInput;
    expect(await withNativeProtectedTaskCheckpointSaver(native)).toBe(
      "native-completed",
    );
    expect(scenario.poolCalls()).toBe(1);
    expect(scenario.closeCalls()).toBe(1);
  });

  test("native cells reject an already owned physical pool", async () => {
    const scenario = fixture();
    const pool = scenario.input.createDedicatedPool();
    const native = {
      ...scenario.input,
      restricted: {},
      serverScope: "http://localhost:3001",
      domains: [],
      createDedicatedPool: () => pool,
    } as unknown as NativeInput;
    await withNativeProtectedTaskCheckpointSaver(native);
    const failure = await withNativeProtectedTaskCheckpointSaver(native).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(scenario.closeCalls()).toBe(1);
  });

  test("native manifest owner proves authority around the quiesced physical read", async () => {
    const scenario = fixture();
    const calls: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          calls.push(text.startsWith("SELECT") ? "manifest-query" : text);
          return { rows: [] };
        },
        release: () => calls.push("manifest-release"),
      }),
      end: async () => calls.push("pool-end"),
    } as unknown as DedicatedPool;
    const native = {
      ...scenario.input,
      restricted: {},
      serverScope: "http://localhost:3001",
      domains: [],
      createDedicatedPool: () => pool,
      assertCurrentTaskAuthority: async () => {
        calls.push("authority");
      },
      execute: async (saver: EncryptedCheckpointSaver) => {
        calls.push("execute");
        expect(saver).toBeInstanceOf(EncryptedCheckpointSaver);
        return "native-completed";
      },
    } as unknown as NativeManifestInput;

    const result = await withNativeProtectedTaskCheckpointManifest(native);
    expect(result.value).toBe("native-completed");
    expect(result.manifest.contract).toBe("encrypted_langgraph_v1");
    expect(result.manifest.expectedCheckpointCount).toBe(0);
    expect(result.manifest.expectedBlobCount).toBe(0);
    expect(result.manifest.expectedPendingWriteCount).toBe(0);
    expect(result.manifest.checkpointOrderedDigest).toHaveLength(32);
    expect(calls).toEqual([
      "execute",
      "authority",
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "manifest-query",
      "manifest-query",
      "manifest-query",
      "COMMIT",
      "manifest-release",
      "authority",
      "pool-end",
    ]);
  });

  test("native manifest owner closes the pool and preserves authority failure", async () => {
    const scenario = fixture();
    const failure = new Error("authority changed after manifest");
    let assertions = 0;
    let closeCalls = 0;
    const pool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
      end: async () => {
        closeCalls += 1;
      },
    } as unknown as DedicatedPool;
    const native = {
      ...scenario.input,
      restricted: {},
      serverScope: "http://localhost:3001",
      domains: [],
      createDedicatedPool: () => pool,
      assertCurrentTaskAuthority: async () => {
        assertions += 1;
        if (assertions === 2) throw failure;
      },
    } as unknown as NativeManifestInput;

    const caught = await withNativeProtectedTaskCheckpointManifest(native).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
    expect(assertions).toBe(2);
    expect(closeCalls).toBe(1);
  });

  test("native manifest owner refuses a caught rejected saver operation", async () => {
    const scenario = fixture();
    let manifestReads = 0;
    let closeCalls = 0;
    const pool = {
      connect: async () => {
        manifestReads += 1;
        return {
          query: async () => ({ rows: [] }),
          release: () => undefined,
        };
      },
      end: async () => {
        closeCalls += 1;
      },
    } as unknown as DedicatedPool;
    const native = {
      ...scenario.input,
      restricted: {},
      serverScope: "http://localhost:3001",
      domains: [],
      createDedicatedPool: () => pool,
      execute: async (saver: EncryptedCheckpointSaver) => {
        await saver.getTuple({ configurable: {
          thread_id: scenario.input.identity.graphThreadId,
        } }).catch(() => undefined);
        return "caught";
      },
    } as unknown as NativeManifestInput;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun rejects matcher
    await expect(withNativeProtectedTaskCheckpointManifest(native)).rejects
      .toThrow("has rejected operations");
    expect(manifestReads).toBe(0);
    expect(closeCalls).toBe(1);
  });

  test("manifest-only owner closes its fresh pool before returning a detached manifest", async () => {
    const calls: string[] = [];
    let finishClose!: () => void;
    let closeStarted!: () => void;
    const closeHasStarted = new Promise<void>(resolve => {
      closeStarted = resolve;
    });
    const closeCanFinish = new Promise<void>(resolve => {
      finishClose = resolve;
    });
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          calls.push(text.startsWith("SELECT") ? "manifest-query" : text);
          return { rows: [] };
        },
        release: () => calls.push("manifest-release"),
      }),
      end: async () => {
        calls.push("pool-end-start");
        closeStarted();
        await closeCanFinish;
        calls.push("pool-end-finish");
      },
    } as unknown as DedicatedPool;
    let observable = false;
    const pending = readProtectedTaskCheckpointPhysicalManifest({
      logicalThreadId: "subagent:task:protected",
      createDedicatedPool: () => pool,
    }).then(manifest => {
      observable = true;
      return manifest;
    });

    await closeHasStarted;
    expect(observable).toBe(false);
    finishClose();
    const manifest = await pending;
    expect(observable).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Reflect.ownKeys(manifest).sort()).toEqual([
      "blobOrderedDigest",
      "checkpointOrderedDigest",
      "contract",
      "expectedBlobCount",
      "expectedCheckpointCount",
      "expectedPendingWriteCount",
      "pendingWriteOrderedDigest",
    ]);
    expect(manifest.contract).toBe("encrypted_langgraph_v1");
    expect(manifest.checkpointOrderedDigest).toHaveLength(32);
    expect(manifest.blobOrderedDigest).toHaveLength(32);
    expect(manifest.pendingWriteOrderedDigest).toHaveLength(32);
    expect(calls).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "manifest-query",
      "manifest-query",
      "manifest-query",
      "COMMIT",
      "manifest-release",
      "pool-end-start",
      "pool-end-finish",
    ]);
  });

  test("manifest-only owner never opens saver or secret inputs", async () => {
    let closeCalls = 0;
    const pool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
      end: async () => {
        closeCalls += 1;
      },
    } as unknown as DedicatedPool;
    const input: Record<string, unknown> = {
      logicalThreadId: "subagent:task:protected",
      createDedicatedPool: () => pool,
    };
    for (const name of ["crypto", "restricted", "evidence", "execute"]) {
      Object.defineProperty(input, name, {
        enumerable: true,
        get: () => {
          throw new Error(`${name} must not be opened`);
        },
      });
    }

    const manifest = await readProtectedTaskCheckpointPhysicalManifest(
      input as Parameters<typeof readProtectedTaskCheckpointPhysicalManifest>[0],
    );
    expect(manifest.expectedCheckpointCount).toBe(0);
    expect(closeCalls).toBe(1);
  });

  test("manifest-only owner closes after a read failure and preserves that failure", async () => {
    const failure = new Error("physical manifest unavailable");
    let closeCalls = 0;
    const pool = {
      connect: async () => {
        throw failure;
      },
      end: async () => {
        closeCalls += 1;
      },
    } as unknown as DedicatedPool;

    const caught = await readProtectedTaskCheckpointPhysicalManifest({
      logicalThreadId: "subagent:task:protected",
      createDedicatedPool: () => pool,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
    expect(closeCalls).toBe(1);
  });

  test("manifest-only owner refuses pool reuse without closing it twice", async () => {
    let closeCalls = 0;
    const pool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
      end: async () => {
        closeCalls += 1;
      },
    } as unknown as DedicatedPool;
    const input = {
      logicalThreadId: "subagent:task:protected",
      createDedicatedPool: () => pool,
    };
    await readProtectedTaskCheckpointPhysicalManifest(input);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun rejects matcher
    await expect(readProtectedTaskCheckpointPhysicalManifest(input)).rejects
      .toThrow("requires a fresh dedicated pool");
    expect(closeCalls).toBe(1);
  });

  test("manifest-only owner rejects pool-close failure before exposing a result", async () => {
    const failure = new Error("pool close failed");
    const pool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
      end: async () => {
        throw failure;
      },
    } as unknown as DedicatedPool;

    const caught = await readProtectedTaskCheckpointPhysicalManifest({
      logicalThreadId: "subagent:task:protected",
      createDedicatedPool: () => pool,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
  });
});
