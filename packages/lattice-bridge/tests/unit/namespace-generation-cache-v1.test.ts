import { describe, expect, test } from "bun:test";

import {
  MemoryClientNamespaceGenerationCacheVaultV1,
  destroyClientNamespaceGenerationCacheEntryV1,
  destroyPendingClientNamespaceGenerationPublicationV1,
  type ClientNamespaceGenerationCacheEntryV1,
} from "../../src/client-vault/namespace-generation-cache-v1.ts";
import type { ClientProfileCoordinates } from
  "../../src/client-vault/types.ts";

const COORDINATES: ClientProfileCoordinates = Object.freeze({
  serverScope: "https://cache.m290.test",
  userId: "10000000-0000-4000-8000-000000000290",
  humanActorId: "20000000-0000-4000-8000-000000000290",
  profileId: "profile_m290_cache",
  deviceId: "device_m290_cache",
  installationLineageDigest: "29".repeat(32),
});

function entry(seed = 1): ClientNamespaceGenerationCacheEntryV1 {
  return Object.freeze({
    namespaceId: "30000000-0000-4000-8000-000000000290",
    keyClass: "ai" as const,
    accessRevision: 2,
    generation: 1,
    headDigest: new Uint8Array(32).fill(seed),
    publicationDigest: new Uint8Array(32).fill(seed + 1),
    publicationSetDigest: new Uint8Array(32).fill(seed + 2),
    audienceFingerprint: new Uint8Array(32).fill(seed + 3),
    recipientKeyGeneration: 4,
    generationKey: new Uint8Array(32).fill(seed + 4),
  });
}

describe("client Namespace generation cache v1", () => {
  test("uses an exact current-plan cache hit and misses stale authority", async () => {
    const vault = new MemoryClientNamespaceGenerationCacheVaultV1();
    const current = entry();
    await vault.putEntries(COORDINATES, [current]);
    const hit = await vault.withEntries(
      COORDINATES,
      [current],
      (entries) => entries[0]!.generationKey.slice(),
    );
    expect(hit).toMatchObject({ status: "hit" });
    if (hit.status === "hit") {
      expect(Array.from(hit.value)).toEqual(Array.from(current.generationKey));
      hit.value.fill(0);
    }
    const stale = entry(9);
    expect(await vault.withEntries(COORDINATES, [stale], () => null))
      .toEqual({ status: "miss" });
    destroyClientNamespaceGenerationCacheEntryV1(current);
    destroyClientNamespaceGenerationCacheEntryV1(stale);
  });

  test("resumes identical staged publication bytes and activates once", async () => {
    const vault = new MemoryClientNamespaceGenerationCacheVaultV1();
    const ai = entry();
    const human = Object.freeze({ ...entry(), keyClass: "human" as const });
    const publication = Object.freeze({
      formatVersion: 1 as const,
      operationId: "namespace-publication:m290:1",
      namespaceId: ai.namespaceId,
      expiresAt: 1_800_000_030_000,
      publicationSetBytes: new Uint8Array([1, 2, 3, 4]),
      entries: Object.freeze([ai, human]),
    });
    await vault.stagePublication(COORDINATES, publication);
    await vault.stagePublication(COORDINATES, publication);
    const resumed = await vault.withPendingPublication(
      COORDINATES,
      publication.operationId,
      (pending) => pending.publicationSetBytes.slice(),
    );
    expect(resumed).toEqual({
      status: "present",
      value: publication.publicationSetBytes,
    });
    if (resumed.status === "present") resumed.value.fill(0);
    await vault.activatePublication(COORDINATES, publication.operationId);
    expect(await vault.withPendingPublication(
      COORDINATES,
      publication.operationId,
      () => null,
    )).toEqual({ status: "absent" });
    expect(await vault.withEntries(COORDINATES, [ai], () => "opened"))
      .toEqual({ status: "hit", value: "opened" });
    destroyClientNamespaceGenerationCacheEntryV1(ai);
    destroyClientNamespaceGenerationCacheEntryV1(human);
  });

  test("rejects changed staged bytes and key substitution", async () => {
    const vault = new MemoryClientNamespaceGenerationCacheVaultV1();
    const ai = entry();
    const human = Object.freeze({ ...entry(), keyClass: "human" as const });
    await vault.stagePublication(COORDINATES, {
      formatVersion: 1,
      operationId: "namespace-publication:m290:collision",
      namespaceId: ai.namespaceId,
      expiresAt: 1_800_000_030_000,
      publicationSetBytes: new Uint8Array([1]),
      entries: [ai, human],
    });
    expect(() => vault.stagePublication(COORDINATES, {
      formatVersion: 1,
      operationId: "namespace-publication:m290:collision",
      namespaceId: ai.namespaceId,
      expiresAt: 1_800_000_030_000,
      publicationSetBytes: new Uint8Array([2]),
      entries: [ai, human],
    })).toThrow("collided");
    const changed = entry();
    changed.generationKey[0] = changed.generationKey[0]! ^ 0xff;
    await vault.putEntries(COORDINATES, [ai]);
    expect(() => vault.putEntries(COORDINATES, [changed]))
      .toThrow("collided");
    destroyClientNamespaceGenerationCacheEntryV1(ai);
    destroyClientNamespaceGenerationCacheEntryV1(human);
    destroyClientNamespaceGenerationCacheEntryV1(changed);
  });

  test("eviction removes optimization only and permits a later refetch", async () => {
    const vault = new MemoryClientNamespaceGenerationCacheVaultV1();
    const current = entry();
    await vault.putEntries(COORDINATES, [current]);
    await vault.evict(COORDINATES, current.namespaceId);
    expect(await vault.withEntries(COORDINATES, [current], () => null))
      .toEqual({ status: "miss" });
    await vault.putEntries(COORDINATES, [current]);
    expect(await vault.withEntries(COORDINATES, [current], () => "refetched"))
      .toEqual({ status: "hit", value: "refetched" });
    destroyClientNamespaceGenerationCacheEntryV1(current);
  });

  test("prunes only expired staged publications before bounded restaging", async () => {
    const vault = new MemoryClientNamespaceGenerationCacheVaultV1();
    const ai = entry();
    const human = Object.freeze({ ...entry(), keyClass: "human" as const });
    const staged = Object.freeze({
      formatVersion: 1 as const,
      operationId: "namespace-cache:expired",
      namespaceId: ai.namespaceId,
      expiresAt: 1_800_000_030_000,
      publicationSetBytes: new Uint8Array([1]),
      entries: Object.freeze([ai, human]),
    });
    const current = Object.freeze({
      ...staged,
      operationId: "namespace-cache:current",
      expiresAt: 1_800_000_050_000,
    });
    try {
      await vault.stagePublication(COORDINATES, staged);
      await vault.stagePublication(COORDINATES, current);
      expect(await vault.pruneExpiredPublications(
        COORDINATES,
        1_800_000_040_000,
      )).toBe(1);
      expect(await vault.withPendingPublication(
        COORDINATES,
        staged.operationId,
        () => true,
      )).toEqual({ status: "absent" });
      expect(await vault.withPendingPublication(
        COORDINATES,
        current.operationId,
        () => true,
      )).toEqual({ status: "present", value: true });
    } finally {
      destroyPendingClientNamespaceGenerationPublicationV1(staged);
      destroyPendingClientNamespaceGenerationPublicationV1(current);
      destroyClientNamespaceGenerationCacheEntryV1(ai);
      destroyClientNamespaceGenerationCacheEntryV1(human);
    }
  });
});
