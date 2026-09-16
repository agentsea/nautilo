import { describe, expect, test } from "bun:test";

import type {
  ProtectedInvocationCapability,
  ProtectedInvocationCapabilityDescription,
} from "@nautilo/lattice-bridge";

import {
  MAX_LIVE_PROTECTED_INVOCATIONS,
  MAX_PROTECTED_CHILD_INVOCATIONS,
  ProtectedInvocationLeaseRegistry,
  type ProtectedInvocationCapabilityPort,
} from "../../src/protected-execution/lease-registry";

const NOW = 10_000;

type FakeCapability = ProtectedInvocationCapability & {
  readonly description: ProtectedInvocationCapabilityDescription;
};

function capability(
  invocationId: string,
  overrides: Partial<ProtectedInvocationCapabilityDescription> = {},
): FakeCapability {
  const description = Object.freeze({
    invocationId,
    grantId: `grant-${invocationId}`,
    expiresAt: NOW + 60_000,
    issuedAt: NOW - 1,
    issuingHumanId: "alice",
    issuingDeviceId: "alice-phone",
    recipientAgentId: "genie",
    recipientKeyId: `key-${invocationId}`,
    namespaceIds: Object.freeze(["room-a", "room-b"]),
    domainIds: Object.freeze(["domain-a", "domain-b"]),
    ...overrides,
  });
  return Object.freeze({
    invocationId,
    expiresAt: description.expiresAt,
    description,
  }) as FakeCapability;
}

function fixture() {
  let now = NOW;
  let nextLeaseId = 0;
  const destroyed: ProtectedInvocationCapability[] = [];
  const known = new WeakSet<object>();
  const port: ProtectedInvocationCapabilityPort = {
    inspect: (candidate) =>
      known.has(candidate)
        ? (candidate as FakeCapability).description
        : null,
    destroy: (candidate) => {
      if (!known.delete(candidate)) return;
      destroyed.push(candidate);
    },
  };
  const registry = new ProtectedInvocationLeaseRegistry({
    capabilityPort: port,
    createLeaseId: () => `lease-${++nextLeaseId}`,
    now: () => now,
    startSweep: false,
  });
  const create = (
    invocationId: string,
    overrides: Partial<ProtectedInvocationCapabilityDescription> = {},
  ) => {
    const created = capability(invocationId, overrides);
    known.add(created);
    return created;
  };

  return {
    create,
    destroyed,
    registry,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("Wave 8 protected invocation lease registry", () => {
  test("accepts only a bridge-recognized capability and rejects a forged lease clone", async () => {
    const state = fixture();
    const created = state.create("invocation-a");
    const registration = state.registry.register({ capability: created });
    expect(registration.status).toBe("registered");
    if (registration.status !== "registered") return;

    expect(Object.keys(registration.lease).sort()).toEqual([
      "invocationId",
      "leaseId",
    ]);
    expect(JSON.stringify(registration.lease)).toBe(
      '{"invocationId":"invocation-a","leaseId":"lease-1"}',
    );
    expect(await state.registry.run(
      { ...registration.lease } as typeof registration.lease,
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });

    const forgedCapability = { ...created } as typeof created;
    expect(state.registry.register({
      capability: forgedCapability,
    })).toEqual({
      status: "unavailable",
      reason: "capability_invalid",
    });
  });

  test("runs one segment with only the opaque lease ambient and wipes on success", async () => {
    const state = fixture();
    const created = state.create("invocation-a");
    const registration = state.registry.register({ capability: created });
    if (registration.status !== "registered") throw new Error("registration failed");

    const result = await state.registry.run(registration.lease, async () => {
      expect(state.registry.currentLease()).toBe(registration.lease);
      expect(state.registry.currentCapability()).toBe(created);
      await Promise.resolve();
      expect(state.registry.currentLease()).toBe(registration.lease);
      return "done";
    });

    expect(result).toEqual({ status: "executed", value: "done" });
    expect(state.registry.currentLease()).toBeNull();
    expect(state.registry.currentCapability()).toBeNull();
    expect(state.destroyed).toEqual([created]);
    expect(await state.registry.run(
      registration.lease,
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });
  });

  test("rejects concurrent reuse and wipes immediately when its signal aborts", async () => {
    const state = fixture();
    const created = state.create("invocation-a");
    const registration = state.registry.register({ capability: created });
    if (registration.status !== "registered") throw new Error("registration failed");
    const controller = new AbortController();
    let unblock: (() => void) | undefined;
    let capabilityAfterAbort: ProtectedInvocationCapability | null = created;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const running = state.registry.run(
      registration.lease,
      async () => {
        await blocked;
        capabilityAfterAbort = state.registry.currentCapability();
        return "done";
      },
      { signal: controller.signal },
    );

    expect(await state.registry.run(
      registration.lease,
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "lease_in_use",
    });
    controller.abort();
    expect(state.registry.currentCapability()).toBeNull();
    expect(state.destroyed).toEqual([created]);
    unblock?.();
    expect(await running).toEqual({
      status: "unavailable",
      reason: "lease_cancelled",
    });
    expect(capabilityAfterAbort).toBeNull();
  });

  test("wipes on callback failure, explicit cancellation, and expiry sweep", async () => {
    const state = fixture();
    const failed = state.create("invocation-failed");
    const failedRegistration = state.registry.register({ capability: failed });
    if (failedRegistration.status !== "registered") {
      throw new Error("registration failed");
    }
    const secretCanary = "WAVE8-OPENED-RUNTIME-SECRET-CANARY";
    const failure = await state.registry.run(
      failedRegistration.lease,
      () => {
        throw new Error(secretCanary);
      },
    );
    expect(failure).toEqual({
      status: "unavailable",
      reason: "execution_failed",
    });
    expect(JSON.stringify(failure)).not.toContain(secretCanary);

    const cancelled = state.create("invocation-cancelled");
    const cancelledRegistration = state.registry.register({
      capability: cancelled,
    });
    if (cancelledRegistration.status !== "registered") {
      throw new Error("registration failed");
    }
    expect(state.registry.release(cancelledRegistration.lease)).toBe(true);

    const expired = state.create("invocation-expired", {
      expiresAt: NOW + 10,
    });
    const expiredRegistration = state.registry.register({
      capability: expired,
    });
    if (expiredRegistration.status !== "registered") {
      throw new Error("registration failed");
    }
    state.setNow(NOW + 10);
    expect(state.registry.sweep()).toBe(1);

    expect(state.destroyed).toEqual([failed, cancelled, expired]);
  });

  test("uses the earliest Grant or execution deadline and refuses expired registration", () => {
    const state = fixture();
    const grantBound = state.create("invocation-grant", {
      expiresAt: NOW + 20,
    });
    const grantRegistration = state.registry.register({
      capability: grantBound,
      executionDeadline: NOW + 40,
    });
    expect(grantRegistration).toMatchObject({ status: "registered" });

    const executionBound = state.create("invocation-execution", {
      expiresAt: NOW + 40,
    });
    const executionRegistration = state.registry.register({
      capability: executionBound,
      executionDeadline: NOW + 15,
    });
    expect(executionRegistration).toMatchObject({ status: "registered" });

    state.setNow(NOW + 15);
    expect(state.registry.sweep()).toBe(1);
    expect(state.destroyed).toEqual([executionBound]);
    state.setNow(NOW + 20);
    expect(state.registry.sweep()).toBe(1);
    expect(state.destroyed).toEqual([executionBound, grantBound]);

    const stale = state.create("invocation-stale", { expiresAt: NOW + 20 });
    expect(state.registry.register({ capability: stale })).toEqual({
      status: "unavailable",
      reason: "capability_expired",
    });
    expect(state.destroyed).toEqual([executionBound, grantBound, stale]);
  });

  test("enforces the process bound without evicting live authority", () => {
    const state = fixture();
    for (let index = 0; index < MAX_LIVE_PROTECTED_INVOCATIONS; index += 1) {
      expect(state.registry.register({
        capability: state.create(`invocation-${index}`),
      }).status).toBe("registered");
    }

    const overflow = state.create("invocation-overflow");
    expect(state.registry.register({ capability: overflow })).toEqual({
      status: "unavailable",
      reason: "process_capacity",
    });
    expect(state.destroyed).toEqual([overflow]);
    expect(state.registry.size).toBe(MAX_LIVE_PROTECTED_INVOCATIONS);
  });

  test("enforces narrow independent children and cascades parent cancellation", async () => {
    const state = fixture();
    const parentCapability = state.create("parent");
    const parent = state.registry.register({ capability: parentCapability });
    if (parent.status !== "registered") throw new Error("registration failed");

    const widened = state.create("child-widened", {
      namespaceIds: Object.freeze(["room-a", "room-c"]),
      domainIds: Object.freeze(["domain-a"]),
    });
    expect(state.registry.register({
      capability: widened,
      parentLease: parent.lease,
    })).toEqual({
      status: "unavailable",
      reason: "child_scope_widened",
    });

    const children = [];
    for (let index = 0; index < MAX_PROTECTED_CHILD_INVOCATIONS; index += 1) {
      const childCapability = state.create(`child-${index}`, {
        namespaceIds: Object.freeze(["room-a"]),
        domainIds: Object.freeze(["domain-a"]),
        expiresAt: NOW + 30_000,
      });
      const child = state.registry.register({
        capability: childCapability,
        parentLease: parent.lease,
      });
      expect(child.status).toBe("registered");
      if (child.status === "registered") children.push(child);
    }

    const overflow = state.create("child-overflow", {
      namespaceIds: Object.freeze(["room-a"]),
      domainIds: Object.freeze(["domain-a"]),
    });
    expect(state.registry.register({
      capability: overflow,
      parentLease: parent.lease,
    })).toEqual({
      status: "unavailable",
      reason: "child_capacity",
    });

    expect(state.registry.release(parent.lease)).toBe(true);
    for (const child of children) {
      expect(await state.registry.run(
        child.lease,
        () => "must-not-run",
      )).toEqual({
        status: "unavailable",
        reason: "lease_unavailable",
      });
    }
    expect(state.registry.size).toBe(0);
  });

  test("child completion wipes independently without clearing its parent", async () => {
    const state = fixture();
    const parentCapability = state.create("parent");
    const parent = state.registry.register({ capability: parentCapability });
    if (parent.status !== "registered") throw new Error("registration failed");
    const childCapability = state.create("child", {
      namespaceIds: Object.freeze(["room-a"]),
      domainIds: Object.freeze(["domain-a"]),
    });
    const child = state.registry.register({
      capability: childCapability,
      parentLease: parent.lease,
    });
    if (child.status !== "registered") throw new Error("registration failed");

    expect(await state.registry.run(child.lease, () => "child-done")).toEqual({
      status: "executed",
      value: "child-done",
    });
    expect(state.destroyed).toEqual([childCapability]);
    expect(await state.registry.run(parent.lease, () => "parent-done")).toEqual({
      status: "executed",
      value: "parent-done",
    });
    expect(state.destroyed).toEqual([childCapability, parentCapability]);
  });

  test("close wipes all entries and permanently refuses new authority", () => {
    const state = fixture();
    const first = state.create("invocation-a");
    expect(state.registry.register({ capability: first }).status)
      .toBe("registered");

    state.registry.close();
    expect(state.destroyed).toEqual([first]);
    expect(state.registry.size).toBe(0);

    const afterClose = state.create("invocation-after-close");
    expect(state.registry.register({ capability: afterClose })).toEqual({
      status: "unavailable",
      reason: "registry_closed",
    });
    expect(state.destroyed).toEqual([first, afterClose]);
  });

  test("does not reconstruct authority after a fresh registry simulates restart", async () => {
    const state = fixture();
    const created = state.create("invocation-a");
    const registration = state.registry.register({ capability: created });
    if (registration.status !== "registered") throw new Error("registration failed");

    const restarted = fixture().registry;
    expect(await restarted.run(
      registration.lease,
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "lease_unavailable",
    });
  });
});
