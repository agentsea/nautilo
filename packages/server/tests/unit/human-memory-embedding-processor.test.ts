import { describe, expect, test } from "bun:test";
import { createHumanMemoryEmbeddingProcessor } from "../../src/routes/human-memory-embedding-processor";

const configuration = { provider: "openrouter" as const,
  model: "openai/text-embedding-3-small", dimensions: 1536 as const };
const request = { contractVersion: 1 as const, purpose: "memory.query_embedding" as const,
  subjectId: "human:one", requestId: "query:one", plaintext: "a private query",
  provider: configuration.provider, model: configuration.model,
  dimensions: 1536 as const, issuedAt: 1_000, deadlineAt: 2_000, publication: null };

describe("Human Memory configured embedding boundary", () => {
  test("uses the configured provider without exposing credentials and passes exact disclosure expectations", async () => {
    const calls: unknown[][] = [];
    const instance = createHumanMemoryEmbeddingProcessor({
      now: () => 1_100, configuration: () => configuration,
      embed: async (...args) => {
        calls.push(args);
        return { provider: configuration.provider, canonicalModel: configuration.model,
          dimensions: 1536, vector: new Array<number>(1536).fill(0.1), contractVersion: 1 };
      },
    });
    expect(instance.descriptor()).toEqual(configuration);
    expect(await instance.processor.embed({ request, authenticatedSubjectId: "human:one" }))
      .toMatchObject({ status: "embedded", embedding: { provider: "openrouter" } });
    expect(calls).toEqual([[request.plaintext, undefined, configuration]]);
  });

  test("changed config and wrong subjects fail before provider disclosure", async () => {
    let calls = 0;
    const instance = createHumanMemoryEmbeddingProcessor({
      now: () => 1_100,
      configuration: () => ({ ...configuration, model: "changed-model" }),
      embed: async () => { calls++; throw new Error("must not disclose"); },
    });
    expect(await instance.processor.embed({ request, authenticatedSubjectId: "human:one" }))
      .toEqual({ status: "unavailable", reason: "provider_unavailable" });
    expect(await instance.processor.embed({ request, authenticatedSubjectId: "human:other" }))
      .toEqual({ status: "unavailable", reason: "subject_mismatch" });
    expect(calls).toBe(0);
  });
});
