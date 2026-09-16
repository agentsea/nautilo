import { describe, expect, test } from "bun:test";

import {
  PROTECTED_EXECUTION_ADAPTERS,
  PROTECTED_EXECUTION_PATH_FAMILIES,
  SyntheticProtectedTaskAuthorization,
  createProtectedExecutionAdapter,
} from "../../src/protected-execution/entrypoint-adapters";
import {
  ProtectedExecutionBroker,
  type ProtectedExecutionContentPort,
  type ProtectedExecutionDurableCoordinates,
} from "../../src/protected-execution/broker";
import {
  ProtectedInvocationLeaseRegistry,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCapabilityDescription,
  type ProtectedInvocationCapabilityPort,
} from "../../src/protected-execution/lease-registry";

const NOW = 20_000;
const SECRET = "WAVE8-PROTECTED-EXECUTION-CANARY";

type FakeCapability = ProtectedInvocationCapability & {
  readonly description: ProtectedInvocationCapabilityDescription;
};

function coordinates(
  invocationId: string,
  recipientAgentId = "genie",
): ProtectedExecutionDurableCoordinates {
  return Object.freeze({
    invocationId,
    grantId: `grant-${invocationId}`,
    issuingHumanId: "alice",
    recipientAgentId,
    recipientKeyId: `recipient-${invocationId}`,
    issuingDeviceId: "alice-phone",
    namespaceIds: Object.freeze(["room-a"]),
    domainIds: Object.freeze(["domain-a"]),
    issuedAt: NOW - 100,
    expiresAt: NOW + 60_000,
  });
}

function fixture(options: Readonly<{
  readonly unavailable?: boolean;
  readonly block?: boolean;
  readonly plaintext?: string;
}> = {}) {
  const known = new WeakSet<object>();
  const destroyed: ProtectedInvocationCapability[] = [];
  let nextLease = 0;
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const capabilityPort: ProtectedInvocationCapabilityPort = {
    inspect: (candidate) =>
      known.has(candidate)
        ? (candidate as FakeCapability).description
        : null,
    destroy: (candidate) => {
      if (known.delete(candidate)) destroyed.push(candidate);
    },
  };
  const contentPort: ProtectedExecutionContentPort = {
    execute: async (input) => {
      if (options.unavailable === true) {
        return Object.freeze({
          status: "unavailable",
          reason: "authorization_unavailable",
        });
      }
      if (options.block === true) await blocked;
      if (input.signal?.aborted === true) {
        return Object.freeze({
          status: "unavailable",
          reason: "authorization_unavailable",
        });
      }
      const plaintext = new TextEncoder().encode(
        options.plaintext ?? SECRET,
      );
      try {
        return Object.freeze({
          status: "executed",
          value: await input.execute(plaintext),
        });
      } finally {
        plaintext.fill(0);
      }
    },
  };
  const registry = new ProtectedInvocationLeaseRegistry({
    capabilityPort,
    createLeaseId: () => `lease-${++nextLease}`,
    now: () => NOW,
    startSweep: false,
  });
  const broker = new ProtectedExecutionBroker({
    contentPort,
    registry,
  });

  return {
    broker,
    destroyed,
    unblock: () => unblock?.(),
    createCapability(value: ProtectedExecutionDurableCoordinates) {
      const created = Object.freeze({
        invocationId: value.invocationId,
        expiresAt: value.expiresAt,
        description: Object.freeze({
          invocationId: value.invocationId,
          grantId: value.grantId,
          expiresAt: value.expiresAt,
          issuedAt: value.issuedAt,
          issuingHumanId: value.issuingHumanId,
          issuingDeviceId: value.issuingDeviceId,
          recipientAgentId: value.recipientAgentId,
          recipientKeyId: value.recipientKeyId,
          namespaceIds: value.namespaceIds,
          domainIds: value.domainIds,
        }),
      }) as FakeCapability;
      known.add(created);
      return created;
    },
  };
}

const FAMILY_ENTRYPOINTS = Object.freeze(
  Object.fromEntries(
    PROTECTED_EXECUTION_PATH_FAMILIES.map((family) => {
      const definition = PROTECTED_EXECUTION_ADAPTERS.find(
        (candidate) => candidate.family === family,
      );
      if (definition === undefined) {
        throw new Error(`missing protected adapter for ${family}`);
      }
      return [family, definition.entrypointId];
    }),
  ),
) as Readonly<Record<
  (typeof PROTECTED_EXECUTION_PATH_FAMILIES)[number],
  (typeof PROTECTED_EXECUTION_ADAPTERS)[number]["entrypointId"]
>>;

describe("Wave 8 central protected execution broker", () => {
  test("runs every execution-path family through the same one-shot broker contract", async () => {
    for (const family of PROTECTED_EXECUTION_PATH_FAMILIES) {
      const state = fixture();
      const value = coordinates(`success-${family}`);
      const capability = state.createCapability(value);
      const adapter = createProtectedExecutionAdapter(
        state.broker,
        FAMILY_ENTRYPOINTS[family],
      );
      const binding = adapter.bind({ coordinates: value, capability });
      expect(binding.status).toBe("ready");
      if (binding.status !== "ready") continue;

      const capture: { borrowed: Uint8Array | null } = { borrowed: null };
      const result = await adapter.execute(
        binding.handle,
        "decrypt",
        (plaintext) => {
          capture.borrowed = plaintext;
          expect(new TextDecoder().decode(plaintext)).toBe(SECRET);
          return `${family}-done`;
        },
      );

      expect(result).toEqual({
        status: "executed",
        value: `${family}-done`,
      });
      expect(capture.borrowed).toEqual(new Uint8Array(SECRET.length));
      expect(state.destroyed).toEqual([capability]);
      expect(adapter.snapshot(binding.handle)).toBeNull();
      expect(await adapter.execute(
        binding.handle,
        "decrypt",
        () => "must-not-run",
      )).toEqual({
        status: "unavailable",
        reason: "lease_unavailable",
      });
    }
  });

  test("denies stale authorization and wipes every path family without exposing the canary", async () => {
    for (const family of PROTECTED_EXECUTION_PATH_FAMILIES) {
      const state = fixture({ unavailable: true });
      const value = coordinates(`denied-${family}`);
      const capability = state.createCapability(value);
      const adapter = createProtectedExecutionAdapter(
        state.broker,
        FAMILY_ENTRYPOINTS[family],
      );
      const binding = adapter.bind({ coordinates: value, capability });
      if (binding.status !== "ready") throw new Error("binding failed");

      const result = await adapter.execute(
        binding.handle,
        "decrypt",
        () => SECRET,
      );
      expect(result).toEqual({
        status: "unavailable",
        reason: "authorization_unavailable",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(state.destroyed).toEqual([capability]);
    }
  });

  test("cancellation wipes every path family and a restarted broker cannot recover a handle", async () => {
    for (const family of PROTECTED_EXECUTION_PATH_FAMILIES) {
      const state = fixture({ block: true });
      const value = coordinates(`cancel-${family}`);
      const capability = state.createCapability(value);
      const adapter = createProtectedExecutionAdapter(
        state.broker,
        FAMILY_ENTRYPOINTS[family],
      );
      const binding = adapter.bind({ coordinates: value, capability });
      if (binding.status !== "ready") throw new Error("binding failed");
      const controller = new AbortController();
      let callbackRan = false;
      const running = adapter.execute(
        binding.handle,
        "decrypt",
        () => {
          callbackRan = true;
          return "must-not-run-after-cancel";
        },
        { signal: controller.signal },
      );
      controller.abort();
      state.unblock();
      expect(await running).toEqual({
        status: "unavailable",
        reason: "lease_cancelled",
      });
      expect(callbackRan).toBe(false);
      expect(state.destroyed).toEqual([capability]);

      const restarted = fixture();
      const restartedAdapter = createProtectedExecutionAdapter(
        restarted.broker,
        FAMILY_ENTRYPOINTS[family],
      );
      expect(await restartedAdapter.execute(
        binding.handle,
        "decrypt",
        () => "must-not-run",
      )).toEqual({
        status: "unavailable",
        reason: "lease_unavailable",
      });
    }
  });

  test("durable snapshots contain exact public coordinates and reject secret-shaped or forged input", () => {
    const state = fixture();
    const value = coordinates("durable");
    const capability = state.createCapability(value);
    const adapter = createProtectedExecutionAdapter(
      state.broker,
      "foreground.main",
    );
    const binding = adapter.bind({ coordinates: value, capability });
    if (binding.status !== "ready") throw new Error("binding failed");
    const snapshot = adapter.snapshot(binding.handle);

    expect(snapshot).toEqual({
      formatVersion: 1,
      entrypointId: "foreground.main",
      family: "foreground",
      coordinates: value,
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(Object.keys(snapshot?.coordinates ?? {}).sort()).toEqual([
      "domainIds",
      "expiresAt",
      "grantId",
      "invocationId",
      "issuedAt",
      "issuingDeviceId",
      "issuingHumanId",
      "namespaceIds",
      "recipientAgentId",
      "recipientKeyId",
    ]);

    const poisoned = {
      ...value,
      recipientPrivateKey: SECRET,
    } as typeof value;
    expect(adapter.bind({
      coordinates: poisoned,
      capability: state.createCapability(value),
    })).toEqual({
      status: "unavailable",
      reason: "coordinates_invalid",
    });
    expect(adapter.bind({
      coordinates: {
        ...value,
        grantId: "grant-swapped",
      },
      capability: state.createCapability(value),
    })).toEqual({
      status: "unavailable",
      reason: "coordinates_invalid",
    });
    expect(adapter.snapshot({ ...binding.handle })).toBeNull();
  });

  test("fork and subagent children cannot widen scope and parent release cascades", () => {
    const state = fixture();
    const parentCoordinates = coordinates("parent");
    const parentAdapter = createProtectedExecutionAdapter(
      state.broker,
      "foreground.main",
    );
    const parent = parentAdapter.bind({
      coordinates: parentCoordinates,
      capability: state.createCapability(parentCoordinates),
    });
    if (parent.status !== "ready") throw new Error("parent binding failed");

    const widerCoordinates = Object.freeze({
      ...coordinates("wider-child"),
      namespaceIds: Object.freeze(["room-a", "room-b"]),
    });
    const childAdapter = createProtectedExecutionAdapter(
      state.broker,
      "subagent.scope",
    );
    expect(childAdapter.bind({
      coordinates: widerCoordinates,
      capability: state.createCapability(widerCoordinates),
      parent: parent.handle,
    })).toEqual({
      status: "unavailable",
      reason: "child_scope_widened",
    });

    const childCoordinates = coordinates("child");
    const child = childAdapter.bind({
      coordinates: childCoordinates,
      capability: state.createCapability(childCoordinates),
      parent: parent.handle,
    });
    expect(child.status).toBe("ready");
    if (child.status !== "ready") return;
    expect(parentAdapter.release(parent.handle)).toBe(true);
    expect(childAdapter.snapshot(child.handle)).toBeNull();
  });

  test("background work cannot borrow a foreground authorization handle", () => {
    for (const entrypointId of [
      "stenographer.extraction",
      "stenographer.compaction",
      "memory.review",
      "memory.exit_flush",
      "task.dispatch",
      "task.execute",
      "task.approval_resume",
    ] as const) {
      const state = fixture();
      const parentCoordinates = coordinates(`parent-${entrypointId}`);
      const parentAdapter = createProtectedExecutionAdapter(
        state.broker,
        "foreground.main",
      );
      const parent = parentAdapter.bind({
        coordinates: parentCoordinates,
        capability: state.createCapability(parentCoordinates),
      });
      if (parent.status !== "ready") {
        throw new Error("foreground parent binding failed");
      }

      const childCoordinates = coordinates(`background-${entrypointId}`);
      const backgroundAdapter = createProtectedExecutionAdapter(
        state.broker,
        entrypointId,
      );
      expect(backgroundAdapter.bind({
        coordinates: childCoordinates,
        capability: state.createCapability(childCoordinates),
        parent: parent.handle,
      })).toEqual({
        status: "unavailable",
        reason: "parent_forbidden",
      });
      expect(parentAdapter.release(parent.handle)).toBe(true);
    }
  });

  test("models the synthetic Task authorization lifecycle without changing product Task state", () => {
    const task = new SyntheticProtectedTaskAuthorization("task-run-1");
    expect(task.snapshot()).toEqual({
      formatVersion: 1,
      runId: "task-run-1",
      state: "awaiting_device_grant",
    });
    expect(task.grantReady()).toBe("grant_ready");
    expect(task.start()).toBe("running");
    expect(task.complete()).toBe("terminal");
    expect(task.recur()).toBe("awaiting_device_grant");
    expect(task.grantReady()).toBe("grant_ready");
    expect(task.restart()).toBe("blocked_key_unavailable");
    expect(task.requestFreshGrant()).toBe("awaiting_device_grant");
    expect(task.grantReady()).toBe("grant_ready");
    expect(task.expire()).toBe("grant_expired");
    expect(task.requestFreshGrant()).toBe("awaiting_device_grant");
  });

  test("decodes Runtime configuration only inside the active broker segment", async () => {
    const runtimeCanary = "WAVE8-TRANSIENT-RUNTIME-CANARY";
    const state = fixture({
      plaintext: JSON.stringify({
        formatVersion: 1,
        soulFile: runtimeCanary,
        memoryBrief: "",
        skills: [],
        commands: [],
        onboardingAnswers: [],
      }),
    });
    const value = coordinates("runtime-config");
    const capability = state.createCapability(value);
    const adapter = createProtectedExecutionAdapter(
      state.broker,
      "foreground.main",
    );
    const binding = adapter.bind({ coordinates: value, capability });
    if (binding.status !== "ready") throw new Error("binding failed");
    const capture: {
      borrowed: Readonly<{ readonly soulFile: string }> | null;
    } = { borrowed: null };

    const result = await state.broker.executeRuntimeConfiguration(
      binding.handle,
      (configuration) => {
        capture.borrowed = configuration;
        return configuration.soulFile.length;
      },
    );
    expect(result).toEqual({
      status: "executed",
      value: runtimeCanary.length,
    });
    expect(capture.borrowed?.soulFile).toBe(runtimeCanary);
    expect(state.destroyed).toEqual([capability]);
  });

  test("isolates two Agents awakened by one Human turn through cleanup", async () => {
    const state = fixture();
    const genieCoordinates = coordinates("shared-turn-genie", "genie");
    const scoutCoordinates = coordinates("shared-turn-scout", "scout");
    const genieCapability = state.createCapability(genieCoordinates);
    const scoutCapability = state.createCapability(scoutCoordinates);
    const adapter = createProtectedExecutionAdapter(
      state.broker,
      "foreground.main",
    );
    const genie = adapter.bind({
      coordinates: genieCoordinates,
      capability: genieCapability,
    });
    const scout = adapter.bind({
      coordinates: scoutCoordinates,
      capability: scoutCapability,
    });
    if (genie.status !== "ready" || scout.status !== "ready") {
      throw new Error("Agent bindings failed");
    }

    expect(adapter.release(genie.handle)).toBe(true);
    expect(adapter.snapshot(genie.handle)).toBeNull();
    expect(adapter.snapshot(scout.handle)?.coordinates.recipientAgentId)
      .toBe("scout");
    expect(await adapter.execute(
      genie.handle,
      "decrypt",
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });
    expect(await adapter.execute(
      scout.handle,
      "decrypt",
      (plaintext) => new TextDecoder().decode(plaintext),
    )).toEqual({
      status: "executed",
      value: SECRET,
    });
    expect(state.destroyed).toEqual([
      genieCapability,
      scoutCapability,
    ]);
  });
});
