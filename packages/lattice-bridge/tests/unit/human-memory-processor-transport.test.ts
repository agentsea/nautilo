import { describe, expect, test } from "bun:test";
import { NautiloApiClient } from "@nautilo/api-client/browser";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { createHumanMemoryProcessorTransport } from "../../src/client/memory/human-memory-processor-transport.ts";
import { createForegroundMemoryProcessorRecipient } from "../../src/memory/foreground-memory-processor-transport.ts";

describe("Human Memory protected HTTP adapter", () => {
  test("real API fetch receives ciphertext only; recipient refresh follows server restart", async () => {
    const crypto = new LatticeCrypto();
    let recipient = await createForegroundMemoryProcessorRecipient({ crypto });
    const bodies: string[] = [];
    const paths: string[] = [];
    const disclosed: (string | null)[] = [];
    const api = new NautiloApiClient("https://memory.example", {
      fetchImpl: async (url, init) => {
        const path = new URL(typeof url === "string" ? url
          : url instanceof URL ? url.href : url.url).pathname;
        paths.push(path);
        if (path === "/api/memory/processor-recipient") {
          return Response.json(recipient.descriptor);
        }
        if (typeof init?.body !== "string") throw new Error("Expected serialized protected request");
        bodies.push(init.body);
        const request = JSON.parse(init.body) as Record<string, unknown>;
        const fallback = "sealedContentEmbeddingRequest" in request;
        disclosed.push(await recipient.open(fallback
          ? request["sealedContentEmbeddingRequest"] : request["sealedQuery"], {
          purpose: fallback ? "memory.ordinary_fallback"
            : "memory.query_embedding", subjectId: "human-session",
        }));
        if (fallback) return Response.json({ dtoVersion: 1,
          status: "ordinary_fallback", operationId: "memory-create:fallback",
          memoryId: "11111111-1111-4111-8111-111111111111",
          contentRevision: 1, cryptoAccessRevision: 0,
          reason: "target_encryption_not_ready" });
        return Response.json({ dtoVersion: 1, status: "unavailable", reason: "embedding_unavailable" });
      },
    });
    api.setToken("test-only-session");
    const adapter = createHumanMemoryProcessorTransport({ api, crypto, subjectId: "human-session" });
    try {
      await adapter.searchProtectedMemories({ q: "private orchid query", mode: "semantic" });
      recipient.dispose();
      recipient = await createForegroundMemoryProcessorRecipient({ crypto });
      await adapter.searchProtectedMemories({ q: "private orchid query", mode: "semantic" });
      await adapter.createProtectedMemory({ requestVersion: 1,
        publicationKind: "ordinary_fallback",
        reason: "target_encryption_not_ready",
        memoryId: "11111111-1111-4111-8111-111111111111",
        operationId: "memory-create:fallback", expectedContentRevision: 0,
        nextContentRevision: 1, expectedCryptoAccessRevision: 0,
        requiredNamespaceIds: ["22222222-2222-4222-8222-222222222222"],
        signedOrdinaryFallbackRequestBytesBase64url:
          "cHJpdmF0ZS1vcmRpbmFyeS1pbnRlbnQ" });
      expect(disclosed).toEqual(["private orchid query", "private orchid query",
        "cHJpdmF0ZS1vcmRpbmFyeS1pbnRlbnQ"]);
      expect(paths).toEqual([
        "/api/memory/processor-recipient", "/api/memory/search",
        "/api/memory/processor-recipient", "/api/memory/search",
        "/api/memory/processor-recipient", "/api/memory/protected-create",
      ]);
      expect(bodies).toHaveLength(3);
      for (const body of bodies) {
        expect(body).not.toContain("private orchid query");
        expect(JSON.parse(body)).not.toHaveProperty("q");
        expect(body).not.toContain("cHJpdmF0ZS1vcmRpbmFyeS1pbnRlbnQ");
      }
      expect(bodies[0]).not.toEqual(bodies[1]);
    } finally { recipient.dispose(); }
  });
});
