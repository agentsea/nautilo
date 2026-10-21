import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createForegroundMemoryProcessorRecipient,
  decodeMemoryProcessorSearchQueryV2,
  encodeMemoryProcessorSearchQueryV2,
  sealForegroundMemoryProcessorRequest,
  sealForegroundMemoryProcessorSearchQueryV2,
} from "../../src/memory/foreground-memory-processor-transport.ts";

describe("foreground Memory processor carrier", () => {
  const marketplace = Object.freeze({
    contractVersion: 2 as const,
    canonicalSpace: Object.freeze({ provider: "venice" as const,
      model: "text-embedding-3-large", dimensions: 1536 as const }),
    processingRoute: Object.freeze({
      transport: "surplus_marketplace" as const,
      marketplacePolicyVersion: "surplus-embedding-marketplace-v1" as const,
      dataRecipientClasses: Object.freeze([
        "surplus", "marketplace_seller", "seller_upstream_processor",
      ] as const),
    }),
  });

  test("V2 query codec authenticates the full marketplace disclosure", () => {
    const encoded = encodeMemoryProcessorSearchQueryV2({
      formatVersion: 2,
      purpose: "memory.query_embedding",
      query: "private orchid",
      embeddingDisclosure: marketplace,
    });
    expect(decodeMemoryProcessorSearchQueryV2(encoded)).toEqual({
      formatVersion: 2,
      purpose: "memory.query_embedding",
      query: "private orchid",
      embeddingDisclosure: marketplace,
    });
    expect(() => decodeMemoryProcessorSearchQueryV2(encoded.replace(
      "surplus-embedding-marketplace-v1", "changed-policy",
    ))).toThrow();
  });

  test("V2 query carrier hides text and opens to the exact disclosed payload", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await createForegroundMemoryProcessorRecipient({ crypto });
    try {
      const descriptor = { ...recipient.descriptor, formatVersion: 2 as const,
        embedding: marketplace };
      const sealed = await sealForegroundMemoryProcessorSearchQueryV2({
        crypto, recipient: descriptor, subjectId: "human-a",
        query: "private orchid", embeddingDisclosure: marketplace,
      });
      expect(JSON.stringify(sealed)).not.toContain("private orchid");
      const opened = await recipient.open(sealed, {
        purpose: "memory.query_embedding", subjectId: "human-a",
      });
      expect(opened).not.toBeNull();
      expect(decodeMemoryProcessorSearchQueryV2(opened!)).toMatchObject({
        query: "private orchid", embeddingDisclosure: marketplace,
      });
    } finally { recipient.dispose(); }
  });
  test("actual wire ciphertext hides query and signed content, opens only for the exact subject/purpose", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await createForegroundMemoryProcessorRecipient({ crypto });
    try {
      for (const purpose of ["memory.query_embedding", "memory.content_embedding"] as const) {
        const sentinel = "Memory confidential sentinel: lab orchid 9304";
        const request = await sealForegroundMemoryProcessorRequest({
          crypto, recipient: recipient.descriptor,
          purpose, subjectId: "human-a", payload: sentinel,
        });
        expect(JSON.stringify(request)).not.toContain(sentinel);
        const ciphertext = atob(request.ciphertextBase64url
          .replaceAll("-", "+").replaceAll("_", "/"));
        expect(ciphertext).not.toContain(sentinel);
        expect(await recipient.open(request, { purpose, subjectId: "human-a" }))
          .toBe(sentinel);
        expect(await recipient.open(request, { purpose, subjectId: "human-b" }))
          .toBeNull();
        expect(await recipient.open(request, {
          purpose: purpose === "memory.query_embedding"
            ? "memory.content_embedding" : "memory.query_embedding",
          subjectId: "human-a",
        })).toBeNull();
      }
    } finally { recipient.dispose(); }
  });

  test("expiry, tampering, wrong recipient and closed custody fail without returning text", async () => {
    let time = 1_000;
    const crypto = new LatticeCrypto();
    const recipient = await createForegroundMemoryProcessorRecipient({ crypto, now: () => time });
    const other = await createForegroundMemoryProcessorRecipient({ crypto, now: () => time });
    const binding = { purpose: "memory.query_embedding", subjectId: "human-a" } as const;
    const request = await sealForegroundMemoryProcessorRequest({
      crypto, recipient: recipient.descriptor, ...binding, payload: "private", now: () => time,
    });
    try {
      expect(await other.open(request, binding)).toBeNull();
      expect(await recipient.open({ ...request,
        ciphertextBase64url: `${request.ciphertextBase64url[0] === "A" ? "B" : "A"}${request.ciphertextBase64url.slice(1)}`,
      }, binding)).toBeNull();
      expect(await recipient.open({ ...request, q: "ordinary escape" }, binding)).toBeNull();
      time = 31_000;
      expect(await recipient.open(request, binding)).toBeNull();
      time = 1_000;
      recipient.dispose();
      expect(await recipient.open(request, binding)).toBeNull();
    } finally { recipient.dispose(); other.dispose(); }
  });

  test("restart does not require re-preparation: seal the same signed input to the new recipient", async () => {
    const crypto = new LatticeCrypto();
    const before = await createForegroundMemoryProcessorRecipient({ crypto });
    const after = await createForegroundMemoryProcessorRecipient({ crypto });
    const binding = { purpose: "memory.content_embedding", subjectId: "human-a" } as const;
    const payload = "same signed operation bytes";
    try {
      const old = await sealForegroundMemoryProcessorRequest({
        crypto, recipient: before.descriptor, ...binding, payload,
      });
      before.dispose();
      expect(await after.open(old, binding)).toBeNull();
      const fresh = await sealForegroundMemoryProcessorRequest({
        crypto, recipient: after.descriptor, ...binding, payload,
      });
      expect(await after.open(fresh, binding)).toBe(payload);
      expect(fresh.recipientId).not.toBe(old.recipientId);
    } finally { before.dispose(); after.dispose(); }
  });

  test("recipient public key must match its advertised fingerprint", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await createForegroundMemoryProcessorRecipient({ crypto });
    try {
      let failure: unknown;
      try {
        await sealForegroundMemoryProcessorRequest({
          crypto,
          recipient: { ...recipient.descriptor, recipientId: "A".repeat(43) },
          purpose: "memory.query_embedding", subjectId: "human-a", payload: "secret",
        });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TypeError);
    } finally { recipient.dispose(); }
  });
});
