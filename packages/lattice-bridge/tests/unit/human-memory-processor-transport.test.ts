import { describe, expect, test } from "bun:test";
import { NautiloApiClient } from "@nautilo/api-client/browser";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { createHumanMemoryProcessorTransport } from "../../src/client/memory/human-memory-processor-transport.ts";
import { createForegroundMemoryProcessorRecipient } from "../../src/memory/foreground-memory-processor-transport.ts";
import { decodeMemoryProcessorSearchQueryV2 } from "../../src/memory/foreground-memory-processor-transport.ts";

describe("Human Memory protected HTTP adapter", () => {
  test("does not reinterpret V2 availability failures as legacy direct consent", async () => {
    const paths: string[] = [];
    const api = new NautiloApiClient("https://memory.example", {
      fetchImpl: (url) => {
        const path = new URL(typeof url === "string" ? url
          : url instanceof URL ? url.href : url.url).pathname;
        paths.push(path);
        return Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
      },
    });
    api.setToken("test-only-session");
    let failure: unknown;
    try {
      await createHumanMemoryProcessorTransport({ api, crypto: new LatticeCrypto(),
        subjectId: "human-session" }).searchProtectedMemories({
        q: "private orchid", mode: "semantic",
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(paths).toEqual(["/api/memory/processor-recipient/v2"]);
  });

  test("V2 search sends the disclosed marketplace route inside ciphertext", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await createForegroundMemoryProcessorRecipient({ crypto });
    const embedding = {
      contractVersion: 2 as const,
      canonicalSpace: { provider: "venice" as const,
        model: "text-embedding-3-large", dimensions: 1536 as const },
      processingRoute: {
        transport: "surplus_marketplace" as const,
        marketplacePolicyVersion: "surplus-embedding-marketplace-v1" as const,
        dataRecipientClasses: [
          "surplus", "marketplace_seller", "seller_upstream_processor",
        ] as const,
      },
    };
    let disclosed: ReturnType<typeof decodeMemoryProcessorSearchQueryV2> | undefined;
    const api = new NautiloApiClient("https://memory.example", {
      fetchImpl: async (url, init) => {
        const path = new URL(typeof url === "string" ? url
          : url instanceof URL ? url.href : url.url).pathname;
        if (path === "/api/memory/processor-recipient/v2") {
          return Response.json({ ...recipient.descriptor, formatVersion: 2, embedding });
        }
        if (typeof init?.body !== "string") throw new Error("Expected serialized body");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        expect(body).toHaveProperty("sealedQueryV2");
        expect(body).not.toHaveProperty("sealedQuery");
        const opened = await recipient.open(body["sealedQueryV2"], {
          purpose: "memory.query_embedding", subjectId: "human-session",
        });
        disclosed = decodeMemoryProcessorSearchQueryV2(opened!);
        return Response.json({ dtoVersion: 1, status: "unavailable",
          reason: "embedding_unavailable" });
      },
    });
    api.setToken("test-only-session");
    try {
      await createHumanMemoryProcessorTransport({ api, crypto,
        subjectId: "human-session",
        resolveEmbeddingDisclosure: () => embedding,
      }).searchProtectedMemories({
        q: "private orchid", mode: "semantic",
      });
      expect(disclosed).toEqual({ formatVersion: 2,
        purpose: "memory.query_embedding", query: "private orchid",
        embeddingDisclosure: embedding });
    } finally { recipient.dispose(); }
  });

  test("rejects policy drift instead of replacing the disclosure approved by the human", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await createForegroundMemoryProcessorRecipient({ crypto });
    const approved = {
      contractVersion: 2 as const,
      canonicalSpace: { provider: "venice" as const,
        model: "text-embedding-3-large", dimensions: 1536 as const },
      processingRoute: { transport: "direct" as const },
    };
    const current = { ...approved, processingRoute: {
      transport: "surplus_marketplace" as const,
      marketplacePolicyVersion: "surplus-embedding-marketplace-v1" as const,
      dataRecipientClasses: [
        "surplus", "marketplace_seller", "seller_upstream_processor",
      ] as const,
    } };
    let searches = 0;
    const api = new NautiloApiClient("https://memory.example", {
      fetchImpl: async (url) => {
        const path = new URL(typeof url === "string" ? url
          : url instanceof URL ? url.href : url.url).pathname;
        if (path === "/api/memory/processor-recipient/v2") {
          return Response.json({ ...recipient.descriptor, formatVersion: 2,
            embedding: current });
        }
        searches += 1;
        return Response.json({ dtoVersion: 1, status: "unavailable",
          reason: "embedding_unavailable" });
      },
    });
    api.setToken("test-only-session");
    try {
      let failure: unknown;
      try {
        await createHumanMemoryProcessorTransport({ api, crypto,
          subjectId: "human-session",
          resolveEmbeddingDisclosure: () => approved,
        }).searchProtectedMemories({ q: "private orchid", mode: "semantic" });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toContain("embedding disclosure changed");
      expect(searches).toBe(0);
    } finally { recipient.dispose(); }
  });

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
        if (path === "/api/memory/processor-recipient/v2") {
          return Response.json({ error: "unsupported" }, { status: 404 });
        }
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
        "/api/memory/processor-recipient/v2",
        "/api/memory/processor-recipient", "/api/memory/search",
        "/api/memory/processor-recipient/v2",
        "/api/memory/processor-recipient", "/api/memory/search",
        "/api/memory/processor-recipient/v2",
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
