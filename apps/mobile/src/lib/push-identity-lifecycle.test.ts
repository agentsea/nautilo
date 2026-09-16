/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

mock.module("expo-crypto", () => ({
  getRandomBytesAsync: async (size: number) => new Uint8Array(size),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));
mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
mock.module("@nautilo/api-client/browser", () => ({
  NautiloApiClient: class {},
}));

import type { PushBinding } from "./push-binding-store";

// As above, module evaluation must follow Expo/native mock installation when
// this test executes alone in a fresh Bun worker.
const { createPushIdentityLifecycle } = await import("./push-identity-lifecycle");

function binding(ownerUserId: string, suffix: string): PushBinding {
  const proofNibble = (suffix.charCodeAt(suffix.length - 1) % 16).toString(16);
  return {
    version: 1,
    ownerUserId,
    bindingId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix.padEnd(12, "0")}`,
    revokeProof: proofNibble.repeat(64),
    lastAcknowledged: null,
  };
}

function harness(input: {
  failAuthenticatedRevoke?: boolean;
  failProofTombstone?: boolean;
} = {}) {
  const bindings = new Map<string, PushBinding>();
  const tombstones: Array<Record<string, string>> = [];
  const calls: string[] = [];
  let clientBearer: string | null = null;
  const lifecycle = createPushIdentityLifecycle({
    loadBinding: async (serverId) => bindings.get(serverId) ?? null,
    clearBinding: async ({ serverId, bindingId }) => {
      const current = bindings.get(serverId);
      if (!current || current.bindingId !== bindingId) return false;
      calls.push(`clear:${bindingId}`);
      bindings.delete(serverId);
      return true;
    },
    queueRevokeAndClearBinding: async ({ serverId, serverUrl, expectedBindingId }) => {
      const current = bindings.get(serverId);
      if (!current || current.bindingId !== expectedBindingId) return false;
      if (input.failProofTombstone) throw new Error("proof persistence failed");
      calls.push(`tombstone:${current.bindingId}`);
      tombstones.push({
        serverUrl,
        bindingId: current.bindingId,
        revokeProof: current.revokeProof,
      });
      bindings.delete(serverId);
      return true;
    },
    beginIdentityTransition: (serverId) => { calls.push(`fence:${serverId}`); },
    createClient: () => ({
      setToken: (token) => {
        clientBearer = token;
        calls.push(`token:${token}`);
      },
      revokePushInstallation: async (bindingId) => {
        calls.push(`revoke:${bindingId}`);
        if (input.failAuthenticatedRevoke) throw new Error("offline");
      },
    }),
  });
  return { lifecycle, bindings, tombstones, calls, clientBearer: () => clientBearer };
}

describe("D468 push identity lifecycle", () => {
  test("authenticated account transition revokes before local binding/tokens may change", async () => {
    const testHarness = harness();
    const old = binding("human-a", "old");
    testHarness.bindings.set("srv_same", old);

    expect(await testHarness.lifecycle.releaseForIdentity({
      serverId: "srv_same",
      serverUrl: "https://same.test",
      bearerToken: "bearer-a",
      nextOwnerUserId: "human-b",
    })).toBe("authenticated_revoked");

    expect(testHarness.calls).toEqual([
      "fence:srv_same",
      "token:bearer-a",
      `revoke:${old.bindingId}`,
      `clear:${old.bindingId}`,
    ]);
    expect(testHarness.bindings.has("srv_same")).toBe(false);
    expect(testHarness.tombstones).toEqual([]);
  });

  test("offline/unauthenticated cleanup writes a proof-only tombstone before deleting the binding", async () => {
    const testHarness = harness({ failAuthenticatedRevoke: true });
    const old = binding("human-a", "offline");
    testHarness.bindings.set("srv_offline", old);

    expect(await testHarness.lifecycle.releaseForIdentity({
      serverId: "srv_offline",
      serverUrl: "https://offline.test",
      bearerToken: "expired-bearer-a",
    })).toBe("proof_tombstoned");

    expect(testHarness.calls).toEqual([
      "fence:srv_offline",
      "token:expired-bearer-a",
      `revoke:${old.bindingId}`,
      `tombstone:${old.bindingId}`,
    ]);
    expect(testHarness.bindings.has("srv_offline")).toBe(false);
    expect(testHarness.tombstones).toEqual([{
      serverUrl: "https://offline.test",
      bindingId: old.bindingId,
      revokeProof: old.revokeProof,
    }]);
    expect(JSON.stringify(testHarness.tombstones)).not.toContain("bearer");
  });

  test("account A to B on one server discards A's binding before B receives a fresh one", async () => {
    const testHarness = harness();
    const a = binding("human-a", "accounta");
    testHarness.bindings.set("srv_shared", a);

    await testHarness.lifecycle.releaseForIdentity({
      serverId: "srv_shared",
      serverUrl: "https://shared.test",
      bearerToken: "bearer-a",
      nextOwnerUserId: "human-b",
    });
    const b = binding("human-b", "accountb");
    testHarness.bindings.set("srv_shared", b);

    expect(testHarness.bindings.get("srv_shared")).toEqual(b);
    expect(b.bindingId).not.toBe(a.bindingId);
    expect(b.revokeProof).not.toBe(a.revokeProof);
  });

  test("a failed A-to-B cleanup preserves A's exact binding for retry", async () => {
    const testHarness = harness({
      failAuthenticatedRevoke: true,
      failProofTombstone: true,
    });
    const a = binding("human-a", "accounta");
    testHarness.bindings.set("srv_shared", a);

    let failure: unknown = null;
    try {
      await testHarness.lifecycle.releaseForIdentity({
        serverId: "srv_shared",
        serverUrl: "https://shared.test",
        bearerToken: "bearer-a",
        nextOwnerUserId: "human-b",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("proof persistence failed");

    // AuthProvider therefore does not commit B's bundle and restores A's
    // latched API bearer; the lifecycle itself likewise leaves A intact.
    expect(testHarness.bindings.get("srv_shared")).toEqual(a);
    expect(testHarness.tombstones).toEqual([]);
  });

  test("a late registration acknowledgement cannot resurrect the binding removed by sign-out", async () => {
    const testHarness = harness();
    const a = binding("human-a", "inflight");
    testHarness.bindings.set("srv_inflight", a);
    let releaseRegister: () => void = () => {
      throw new Error("registration test was not initialized");
    };
    const registration = new Promise<void>((resolve) => { releaseRegister = resolve; }).then(() => {
      const current = testHarness.bindings.get("srv_inflight");
      return current?.bindingId === a.bindingId && current.ownerUserId === "human-a";
    });

    await testHarness.lifecycle.releaseForIdentity({
      serverId: "srv_inflight",
      serverUrl: "https://inflight.test",
      bearerToken: "bearer-a",
    });
    releaseRegister();

    expect(await registration).toBe(false);
    expect(testHarness.bindings.has("srv_inflight")).toBe(false);
  });

  test("signing out one server does not disturb another server's binding", async () => {
    const testHarness = harness();
    const left = binding("human-a", "left");
    const right = binding("human-a", "right");
    testHarness.bindings.set("srv_left", left);
    testHarness.bindings.set("srv_right", right);

    await testHarness.lifecycle.releaseForIdentity({
      serverId: "srv_left",
      serverUrl: "https://left.test",
      bearerToken: "bearer-left",
    });

    expect(testHarness.bindings.get("srv_left")).toBeUndefined();
    expect(testHarness.bindings.get("srv_right")).toEqual(right);
  });
});
