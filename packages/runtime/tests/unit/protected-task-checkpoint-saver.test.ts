import { describe, expect, test } from "bun:test";

import { EncryptedCheckpointSaver } from "@nautilo/agent";
import type { CreateEncryptedCheckpointSaverOptions } from "@nautilo/agent";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  withNativeProtectedTaskCheckpointSaver,
  withProtectedTaskCheckpointSaver,
} from "../../src/tasks/protected-task-checkpoint-saver";

type Input = Parameters<typeof withProtectedTaskCheckpointSaver>[0];
type NativeInput = Parameters<typeof withNativeProtectedTaskCheckpointSaver>[0];
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
});
