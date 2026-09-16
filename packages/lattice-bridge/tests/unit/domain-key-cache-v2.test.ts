import { describe, expect, test } from "bun:test";

import {
  createClientDomainKeyCacheVaultV2,
} from "../../src/client-vault/domain-key-cache-v2.ts";
import {
  MemoryClientNamespaceGenerationCacheVaultV1,
} from "../../src/client-vault/namespace-generation-cache-v1.ts";

const coordinates = {
  serverScope: "server:alpha",
  userId: "user:alpha",
  humanActorId: "human:alpha",
  profileId: "profile:alpha",
  deviceId: "device:alpha",
  installationLineageDigest: "lineage:alpha",
} as const;

function requirement(generation = 1) {
  return Object.freeze({
    serverId: "server:alpha",
    domainId: "domain:alpha-beta",
    participantDigest: new Uint8Array(32).fill(0x31),
    participantCount: 2,
    keyClass: "human" as const,
    domainKeyGeneration: generation,
    authorizationRevision: 1,
    headDigest: new Uint8Array(32).fill(0x32),
    recipientDeviceGeneration: 1,
  });
}

describe("M301 V2 Domain-key cache adapter", () => {
  test("persists an exact Domain generation and wipes callback bytes", async () => {
    const vault = createClientDomainKeyCacheVaultV2(
      new MemoryClientNamespaceGenerationCacheVaultV1(),
    );
    const domainKey = new Uint8Array(32).fill(0x41);
    await vault.putKey(coordinates, { ...requirement(), domainKey });
    let callbackBytes: Uint8Array | undefined;
    const result = await vault.withKey(coordinates, requirement(), (key) => {
      callbackBytes = key;
      return key.slice();
    });
    expect(result.status).toBe("hit");
    if (result.status === "hit") {
      expect(result.value).toEqual(domainKey);
      result.value.fill(0);
    }
    expect(callbackBytes).toEqual(new Uint8Array(32));
    expect(domainKey).toEqual(new Uint8Array(32).fill(0x41));
  });

  test("misses stale heads and supports one-Domain eviction", async () => {
    const vault = createClientDomainKeyCacheVaultV2(
      new MemoryClientNamespaceGenerationCacheVaultV1(),
    );
    await vault.putKey(coordinates, {
      ...requirement(),
      domainKey: new Uint8Array(32).fill(0x42),
    });
    expect((await vault.withKey(coordinates, {
      ...requirement(),
      headDigest: new Uint8Array(32).fill(0x99),
    }, () => "opened")).status).toBe("miss");
    await vault.evict(coordinates, requirement().domainId);
    expect((await vault.withKey(
      coordinates,
      requirement(),
      () => "opened",
    )).status).toBe("miss");
  });
});
