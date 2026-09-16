import { describe, expect, test } from "bun:test";

import type {
  OpenedClientDeviceProfileV2,
  RetainedClientNamespaceKeyringV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  restoreClientNamespaceKeyringsFromAcknowledgedDelivery,
  withClientNamespaceKeyring,
  writeClientNamespaceKeyrings,
} from "../../src/device/client-namespace-keyring.ts";

function keyring(input: {
  namespaceId: string;
  deliverySequence: number;
  accessRevision: number;
  marker: number;
  keyClass?: "human" | "ai";
}): RetainedClientNamespaceKeyringV2 {
  return Object.freeze({
    deliverySequence: input.deliverySequence,
    operationId: `operation_${input.deliverySequence}`,
    namespaceId: input.namespaceId,
    keyClass: input.keyClass ?? "human",
    domainId: "domain_alice",
    domainEpoch: input.accessRevision,
    accessRevision: input.accessRevision,
    bindingHash: new Uint8Array(32).fill(input.marker),
    currentGeneration: 2,
    generations: Object.freeze([1, 2].map((generation) => Object.freeze({
      generation,
      key: new Uint8Array(32).fill(input.marker + generation),
    }))),
  });
}

function profile(
  keyrings: readonly RetainedClientNamespaceKeyringV2[] = [],
  highWatermark = 0,
): OpenedClientDeviceProfileV2 {
  return Object.freeze({
    formatVersion: 2,
    deviceId: "device_alice_browser",
    signingPublicKey: new Uint8Array(32).fill(1),
    signingPrivateKey: new Uint8Array(32).fill(2),
    encryptionPublicKey: new Uint8Array(65).fill(3),
    encryptionPrivateKey: new Uint8Array(32).fill(4),
    trustedDeviceRevision: 4,
    trustedHostAuthorizationRevision: 9,
    deliveryHighWatermark: highWatermark,
    keyringDeliveries: Object.freeze(keyrings),
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to fail");
}

describe("client Namespace keyring custody", () => {
  test("opens current and historical generations only inside the callback", async () => {
    const retained = keyring({
      namespaceId: "namespace_room",
      deliverySequence: 1,
      accessRevision: 1,
      marker: 0x20,
    });
    let escaped: Uint8Array | undefined;
    const result = await withClientNamespaceKeyring({
      profile: profile([retained], 1),
      namespaceId: retained.namespaceId,
      keyClass: "human",
      requiredAccessRevision: 1,
      requiredGeneration: 1,
      operation: (opened) => {
        escaped = opened.generations[0]!.key;
        return opened.generations.map((entry) => entry.generation);
      },
    });
    expect(result).toEqual([1, 2]);
    expect(escaped?.every((byte) => byte === 0)).toBeTrue();
    expect(retained.generations[0]!.key.every((byte) => byte !== 0)).toBeTrue();
  });

  test("wipes opened keys after callback throw or abort", async () => {
    const retained = keyring({
      namespaceId: "namespace_room",
      deliverySequence: 1,
      accessRevision: 1,
      marker: 0x20,
    });
    let escaped: Uint8Array | undefined;
    expect(String(await captureError(() => withClientNamespaceKeyring({
      profile: profile([retained], 1),
      namespaceId: retained.namespaceId,
      keyClass: "human",
      operation: (opened) => {
        escaped = opened.generations[0]!.key;
        throw new Error("callback failed");
      },
    })))).toContain("callback failed");
    expect(escaped?.every((byte) => byte === 0)).toBeTrue();
    const controller = new AbortController();
    controller.abort();
    expect(String(await captureError(() => withClientNamespaceKeyring({
      profile: profile([retained], 1),
      namespaceId: retained.namespaceId,
      keyClass: "human",
      signal: controller.signal,
      operation: () => undefined,
    })))).toContain("aborted");
  });

  test("writes a detached canonical forward update and rejects rollback", () => {
    const current = keyring({
      namespaceId: "namespace_z",
      deliverySequence: 4,
      accessRevision: 4,
      marker: 0x20,
    });
    const next = keyring({
      namespaceId: "namespace_z",
      deliverySequence: 7,
      accessRevision: 5,
      marker: 0x30,
    });
    const another = keyring({
      namespaceId: "namespace_a",
      deliverySequence: 6,
      accessRevision: 1,
      marker: 0x40,
    });
    const updated = writeClientNamespaceKeyrings({
      profile: profile([current], 4),
      deliveryHighWatermark: 7,
      keyrings: [next, another],
    });
    expect(updated.keyringDeliveries.map((entry) => entry.namespaceId))
      .toEqual(["namespace_a", "namespace_z", "namespace_z"]);
    expect(updated.keyringDeliveries.map((entry) => entry.accessRevision))
      .toEqual([1, 4, 5]);
    updated.keyringDeliveries[2]!.generations[0]!.key[0] = 0;
    expect(next.generations[0]!.key[0]).not.toBe(0);
    expect(() => writeClientNamespaceKeyrings({
      profile: profile([current], 4),
      deliveryHighWatermark: 8,
      keyrings: [{ ...next, deliverySequence: 8, accessRevision: 3 }],
    })).toThrow("rollback");
  });

  test("retains Human and AI keyrings for the same Namespace independently", async () => {
    const human = keyring({
      namespaceId: "namespace_room",
      keyClass: "human",
      deliverySequence: 1,
      accessRevision: 1,
      marker: 0x20,
    });
    const ai = keyring({
      namespaceId: "namespace_room",
      keyClass: "ai",
      deliverySequence: 1,
      accessRevision: 1,
      marker: 0x40,
    });
    const retained = writeClientNamespaceKeyrings({
      profile: profile([], 0),
      deliveryHighWatermark: 1,
      keyrings: [human, ai],
    });
    expect(retained.keyringDeliveries.map((entry) => entry.keyClass))
      .toEqual(["ai", "human"]);
    const humanMarker = await withClientNamespaceKeyring({
      profile: retained,
      namespaceId: "namespace_room",
      keyClass: "human",
      operation: (opened) => opened.generations[0]!.key[0],
    });
    const aiMarker = await withClientNamespaceKeyring({
      profile: retained,
      namespaceId: "namespace_room",
      keyClass: "ai",
      operation: (opened) => opened.generations[0]!.key[0],
    });
    expect(humanMarker).toBe(0x21);
    expect(aiMarker).toBe(0x41);
  });

  test("recovers exact acknowledged keyrings without advancing the high-watermark", () => {
    const human = keyring({ namespaceId: "namespace_room", keyClass: "human",
      deliverySequence: 4, accessRevision: 0, marker: 0x20 });
    const ai = keyring({ namespaceId: "namespace_room", keyClass: "ai",
      deliverySequence: 4, accessRevision: 0, marker: 0x40 });
    const recovered = restoreClientNamespaceKeyringsFromAcknowledgedDelivery({
      profile: profile([], 7),
      keyrings: [human, ai],
    });
    expect(recovered.deliveryHighWatermark).toBe(7);
    expect(recovered.keyringDeliveries.map((entry) => entry.keyClass))
      .toEqual(["ai", "human"]);
    expect(() => restoreClientNamespaceKeyringsFromAcknowledgedDelivery({
      profile: recovered,
      keyrings: [{ ...human, bindingHash: new Uint8Array(32).fill(0x55) }],
    })).toThrow("conflicts");
    expect(() => restoreClientNamespaceKeyringsFromAcknowledgedDelivery({
      profile: profile([], 3),
      keyrings: [human],
    })).toThrow("not durable");
  });

  test("opens an old binding revision after a later delivery advances", async () => {
    const revision4 = keyring({
      namespaceId: "namespace_room",
      deliverySequence: 4,
      accessRevision: 4,
      marker: 0x20,
    });
    const revision5 = keyring({
      namespaceId: "namespace_room",
      deliverySequence: 5,
      accessRevision: 5,
      marker: 0x30,
    });
    const retained = writeClientNamespaceKeyrings({
      profile: profile([revision4], 4),
      deliveryHighWatermark: 5,
      keyrings: [revision5],
    });
    expect(await withClientNamespaceKeyring({
      profile: retained,
      namespaceId: "namespace_room",
      keyClass: "human",
      requiredAccessRevision: 4,
      requiredGeneration: 2,
      operation: (opened) => opened.generations[1]!.key[0],
    })).toBe(0x22);
    expect(await withClientNamespaceKeyring({
      profile: retained,
      namespaceId: "namespace_room",
      keyClass: "human",
      operation: (opened) => opened.accessRevision,
    })).toBe(5);
    const pruned = profile(
      retained.keyringDeliveries.filter((entry) => entry.accessRevision !== 4),
      5,
    );
    expect(String(await captureError(() => withClientNamespaceKeyring({
      profile: pruned,
      namespaceId: "namespace_room",
      keyClass: "human",
      requiredAccessRevision: 4,
      requiredGeneration: 2,
      operation: () => undefined,
    })))).toContain("unavailable");
  });
});
