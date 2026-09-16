import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createForegroundMemoryProcessorRecipient,
  sealForegroundMemoryProcessorRequest,
} from "../../src/memory/foreground-memory-processor-transport.ts";

describe("foreground Memory processor carrier", () => {
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
