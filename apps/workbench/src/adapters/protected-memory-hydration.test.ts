import { describe, expect, test } from "bun:test";
import type { ProtectedMemoryDtoV1 } from "@nautilo/api-client/browser";

import {
  hydrateProtectedMemoriesV1,
  PROTECTED_MEMORY_BRIEF_MAX_BYTES_V1,
  PROTECTED_MEMORY_MAX_HYDRATION_ROWS_V1,
  renderProtectedMemoryBriefV1,
  type AuthorizedClientMemoryCryptoPortV1,
} from "./protected-memory-hydration";

const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NAMESPACE_ID = "11111111-1111-4111-8111-111111111111";

function encryptedMemory(
  memoryId = MEMORY_ID,
): ProtectedMemoryDtoV1 {
  return {
    dtoVersion: 1,
    projection: {
      memoryId,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      importance: 0.8,
      tier: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      namespaceIds: [NAMESPACE_ID],
      requiredNamespaceIds: [NAMESPACE_ID],
      readAuthorities: [{ namespaceId: NAMESPACE_ID,
        sourceRoomId: "22222222-2222-4222-8222-222222222222", currentGeneration: 0,
        retainedGenerations: [{ generation: 0, accessRevision: 0,
          headDigestBase64url: "A".repeat(43), publicationDigestBase64url: "A".repeat(43),
          publicationSetDigestBase64url: "A".repeat(43), audienceFingerprintBase64url: "A".repeat(43) }] }],
    },
    protectedPayload: {
      status: "encrypted",
      cryptoObjectId: `memory:v1:${memoryId}`,
      payloadVersion: 1,
      encryptedPayloadBytesBase64url: "YWJj",
      accessManifestBytesBase64url: "ZGVm",
      accessSignerEvidence: [],
      namespaceEnvelopes: [{
        namespaceId: NAMESPACE_ID,
        envelopeBytesBase64url: "Z2hp",
      }],
    },
  };
}

function opening(): AuthorizedClientMemoryCryptoPortV1 {
  return {
    open: () => ({
      status: "opened",
      payloadVersion: 1,
      content: "local confidential memory",
      type: "preference",
    }),
  };
}

describe("protected Workbench Memory hydration", () => {
  test("opens encrypted content only through the injected client port", async () => {
    const calls: string[] = [];
    const result = await hydrateProtectedMemoriesV1({
      items: [encryptedMemory()],
      crypto: {
        open: (memory) => {
          calls.push(memory.protectedPayload.cryptoObjectId);
          return opening().open(memory);
        },
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(calls).toEqual([`memory:v1:${MEMORY_ID}`]);
    expect(result.memories[0]?.content).toEqual({
      kind: "opened",
      content: "local confidential memory",
      type: "preference",
    });
  });

  test("renders pending and unavailable states without invoking crypto", async () => {
    for (const protectedPayload of [
      { status: "pending", reason: "shadow_pending" },
      { status: "unavailable", reason: "lost_key_material" },
      { status: "unavailable", reason: "incomplete_access_set" },
      { status: "unavailable", reason: "protected_representation_missing" },
      { status: "unavailable", reason: "target_encryption_not_ready" },
      { status: "unavailable", reason: "integrity_failure" },
    ] as const) {
      const result = await hydrateProtectedMemoriesV1({
        items: [{ ...encryptedMemory(), protectedPayload }],
        crypto: { open: () => {
          throw new Error("non-encrypted rows must not be opened");
        } },
      });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("Expected unavailable row");
      expect(result.memories[0]?.content).toMatchObject({ kind: "placeholder", reason: protectedPayload.reason });
    }
  });

  test("fails closed on plaintext DTO fields, duplicates, and oversized batches", async () => {
    const withPlaintext = { ...encryptedMemory(), content: "forbidden" };
    expect(await hydrateProtectedMemoriesV1({
      items: [withPlaintext],
      crypto: opening(),
    })).toEqual({ status: "rejected", reason: "corrupt" });
    expect(await hydrateProtectedMemoriesV1({
      items: [encryptedMemory(), encryptedMemory()],
      crypto: opening(),
    })).toEqual({ status: "rejected", reason: "corrupt" });
    expect(await hydrateProtectedMemoriesV1({
      items: Array.from(
        { length: PROTECTED_MEMORY_MAX_HYDRATION_ROWS_V1 + 1 },
        () => encryptedMemory(),
      ),
      crypto: opening(),
    })).toEqual({ status: "rejected", reason: "corrupt" });
  });

  test("turns thrown or structurally extended crypto output into a corrupt placeholder", async () => {
    for (const open of [
      () => Promise.reject(new Error("authentication failed")),
      () => ({
        status: "opened",
        payloadVersion: 1,
        content: "plaintext",
        type: "preference",
        serverFallback: true,
      }),
    ]) {
      const result = await hydrateProtectedMemoriesV1({
        items: [encryptedMemory()],
        crypto: { open },
      });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("expected ready");
      expect(result.memories[0]?.content).toEqual({
        kind: "placeholder",
        placeholder: "corrupt",
        reason: "corrupt",
      });
    }
  });

  test("renders a bounded tier-1 brief locally and excludes locked/archive rows", async () => {
    const ready = await hydrateProtectedMemoriesV1({
      items: [encryptedMemory()],
      crypto: opening(),
    });
    if (ready.status !== "ready") throw new Error("expected ready");
    const opened = ready.memories[0]!;
    const brief = renderProtectedMemoryBriefV1([
      opened,
      { ...opened, memoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tier: 3 },
      {
        ...opened,
        memoryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        content: {
          kind: "placeholder",
          placeholder: "locked",
          reason: "incomplete_access_set",
        },
      },
    ]);
    expect(brief).toBe("- [preference] local confidential memory");
    expect(new TextEncoder().encode(brief).length)
      .toBeLessThanOrEqual(PROTECTED_MEMORY_BRIEF_MAX_BYTES_V1);
  });
});
