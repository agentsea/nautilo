import { describe, expect, test } from "bun:test";

import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
  MemoryForegroundProcessorValidationError,
  createMemoryForegroundEmbeddingProcessor,
  validateMemoryForegroundEmbeddingRequest,
  type MemoryForegroundEmbeddingRequest,
} from "../../src/memory/foreground-embedding-processor.ts";

const now = 1_900_000_000_000;

function request(
  overrides: Partial<MemoryForegroundEmbeddingRequest> = {},
): MemoryForegroundEmbeddingRequest {
  return {
    contractVersion: MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
    purpose: "memory.content_embedding",
    subjectId: "human-alice",
    requestId: "request-1",
    plaintext: "A bounded personal memory",
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    issuedAt: now,
    deadlineAt: now + 10_000,
    publication: {
      objectId: "memory-object-1",
      expectedProductRevision: 3,
      idempotencyId: "memory-publication-1",
    },
    ...overrides,
  };
}

describe("Human foreground Memory embedding processor contract", () => {
  test("accepts one bounded purpose-bound content request", () => {
    const value = request();
    expect(validateMemoryForegroundEmbeddingRequest(value, now)).toEqual(value);
  });

  test("requires publication binding for content and forbids it for queries", () => {
    expect(() => validateMemoryForegroundEmbeddingRequest(
      request({ publication: null }),
      now,
    )).toThrow(MemoryForegroundProcessorValidationError);
    expect(() => validateMemoryForegroundEmbeddingRequest(request({
      purpose: "memory.query_embedding",
    }), now)).toThrow(MemoryForegroundProcessorValidationError);
    expect(validateMemoryForegroundEmbeddingRequest(request({
      purpose: "memory.query_embedding",
      publication: null,
    }), now).purpose).toBe("memory.query_embedding");
  });

  test("fails closed on deadline, byte, dimension, and revision drift", () => {
    const invalid = [
      request({ deadlineAt: now - 1 }),
      request({ deadlineAt: now + 30_001 }),
      request({ plaintext: "x".repeat(64 * 1024 + 1) }),
      { ...request(), dimensions: 3072 },
      request({ publication: {
        objectId: "memory-object-1",
        expectedProductRevision: -1,
        idempotencyId: "memory-publication-1",
      } }),
    ];
    for (const value of invalid) {
      expect(() => validateMemoryForegroundEmbeddingRequest(
        value as MemoryForegroundEmbeddingRequest,
        now,
      )).toThrow(MemoryForegroundProcessorValidationError);
    }
  });

  test("applies the narrower query bound and validates authority coordinates", () => {
    const invalid = [
      request({ subjectId: "" }),
      request({ requestId: "request with spaces" }),
      request({ model: "" }),
      request({ issuedAt: now + 1 }),
      request({ plaintext: "" }),
      request({
        purpose: "memory.query_embedding",
        plaintext: "q".repeat(4 * 1024 + 1),
        publication: null,
      }),
      request({ publication: {
        objectId: "object with spaces",
        expectedProductRevision: 0,
        idempotencyId: "memory-publication-1",
      } }),
    ];
    for (const value of invalid) {
      expect(() => validateMemoryForegroundEmbeddingRequest(value, now))
        .toThrow(MemoryForegroundProcessorValidationError);
    }
  });

  test("executes one authenticated purpose-bound disclosure without persistence", async () => {
    const calls: unknown[] = [];
    const processor = createMemoryForegroundEmbeddingProcessor({
      now: () => now,
      rateLimit: {
        admit: (input) => {
          calls.push({ kind: "admit", input });
          return true;
        },
      },
      provider: {
        embed: (input) => {
          calls.push({ kind: "provider", input });
          return Promise.resolve({
            provider: "openai" as const,
            canonicalModel: "text-embedding-3-small-2025-01",
            dimensions: MEMORY_EMBEDDING_DIMENSIONS,
            vector: Array.from(
              { length: MEMORY_EMBEDDING_DIMENSIONS },
              (_entry, index) => index / MEMORY_EMBEDDING_DIMENSIONS,
            ),
          });
        },
      },
    });

    const result = await processor.embed({
      request: request(),
      authenticatedSubjectId: "human-alice",
    });

    expect(result.status).toBe("embedded");
    if (result.status !== "embedded") throw new Error("expected embedding");
    expect(result.embedding).toMatchObject({
      provider: "openai",
      canonicalModel: "text-embedding-3-small-2025-01",
      dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      processorContractVersion: MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
    });
    expect(result.embedding.vector).toHaveLength(MEMORY_EMBEDDING_DIMENSIONS);
    expect(Object.isFrozen(result.embedding.vector)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      kind: "provider",
      input: {
        purpose: "memory.content_embedding",
        plaintext: "A bounded personal memory",
      },
    });
  });

  test("executes Venice content and query disclosures with exact provenance", async () => {
    const calls: unknown[] = [];
    const processor = createMemoryForegroundEmbeddingProcessor({
      now: () => now,
      provider: {
        embed: (input) => {
          calls.push(input);
          return Promise.resolve({
            provider: "venice" as const,
            canonicalModel: "text-embedding-3-small",
            dimensions: MEMORY_EMBEDDING_DIMENSIONS,
            vector: Array.from(
              { length: MEMORY_EMBEDDING_DIMENSIONS },
              (_entry, index) => (index + 1) / MEMORY_EMBEDDING_DIMENSIONS,
            ),
          });
        },
      },
    });

    for (const purpose of [
      "memory.content_embedding",
      "memory.query_embedding",
    ] as const) {
      const result = await processor.embed({
        request: request({
          purpose,
          provider: "venice",
          model: "text-embedding-3-small",
          publication: purpose === "memory.content_embedding"
            ? request().publication
            : null,
        }),
        authenticatedSubjectId: "human-alice",
      });

      expect(result.status).toBe("embedded");
      if (result.status !== "embedded") throw new Error("expected embedding");
      expect(result.embedding).toMatchObject({
        provider: "venice",
        canonicalModel: "text-embedding-3-small",
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        processorContractVersion: MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
      });
      expect(result.embedding.vector).toHaveLength(MEMORY_EMBEDDING_DIMENSIONS);
    }

    expect(calls).toEqual([
      {
        purpose: "memory.content_embedding",
        plaintext: "A bounded personal memory",
        requestedProvider: "venice",
        requestedModel: "text-embedding-3-small",
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      },
      {
        purpose: "memory.query_embedding",
        plaintext: "A bounded personal memory",
        requestedProvider: "venice",
        requestedModel: "text-embedding-3-small",
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      },
    ]);
  });

  test("rejects a response whose provider does not match the Venice request", async () => {
    const processor = createMemoryForegroundEmbeddingProcessor({
      now: () => now,
      provider: {
        embed: () => Promise.resolve({
          provider: "openai" as const,
          canonicalModel: "text-embedding-3-small",
          dimensions: MEMORY_EMBEDDING_DIMENSIONS,
          vector: new Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0.25),
        }),
      },
    });

    expect(await processor.embed({
      request: request({
        provider: "venice",
        model: "text-embedding-3-small",
      }),
      authenticatedSubjectId: "human-alice",
    })).toEqual({
      status: "unavailable",
      reason: "incompatible_embedding",
    });
  });

  test("fails before provider use on subject, rate, and request errors", async () => {
    let providerCalls = 0;
    let admit = true;
    const processor = createMemoryForegroundEmbeddingProcessor({
      now: () => now,
      rateLimit: { admit: () => admit },
      provider: {
        embed: () => {
          providerCalls += 1;
          throw new Error("must not run");
        },
      },
    });

    expect(await processor.embed({
      request: request(),
      authenticatedSubjectId: "human-mallory",
    })).toEqual({ status: "unavailable", reason: "subject_mismatch" });
    admit = false;
    expect(await processor.embed({
      request: request(),
      authenticatedSubjectId: "human-alice",
    })).toEqual({ status: "unavailable", reason: "rate_limited" });
    expect(await processor.embed({
      request: request({ plaintext: "" }),
      authenticatedSubjectId: "human-alice",
    })).toEqual({ status: "unavailable", reason: "invalid_request" });
    expect(providerCalls).toBe(0);
  });

  test("rejects forged provider provenance, malformed vectors, and late results", async () => {
    let clock = now;
    let advanceOnProvider = false;
    let output: Awaited<ReturnType<Parameters<
      typeof createMemoryForegroundEmbeddingProcessor
    >[0]["provider"]["embed"]>> = {
      provider: "openrouter",
      canonicalModel: "text-embedding-3-small",
      dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      vector: new Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0),
    };
    const processor = createMemoryForegroundEmbeddingProcessor({
      now: () => clock,
      rateLimit: { admit: () => true },
      provider: {
        embed: () => {
          if (advanceOnProvider) clock = now + 10_001;
          return Promise.resolve(output);
        },
      },
    });
    const run = () => processor.embed({
      request: request(),
      authenticatedSubjectId: "human-alice",
    });

    expect(await run()).toEqual({
      status: "unavailable",
      reason: "incompatible_embedding",
    });
    output = { ...output, provider: "openai", vector: [0] };
    expect(await run()).toEqual({
      status: "unavailable",
      reason: "incompatible_embedding",
    });
    output = {
      ...output,
      vector: new Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0),
    };
    advanceOnProvider = true;
    expect(await run()).toEqual({
      status: "unavailable",
      reason: "provider_unavailable",
    });
  });
});
