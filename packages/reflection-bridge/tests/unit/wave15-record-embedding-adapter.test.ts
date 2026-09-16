import { describe, expect, test } from "bun:test";

import type { ProtectedAgentMemoryEmbeddingPort } from "@nautilo/lattice-bridge";

import { createWave15RecordEmbeddingAdapter } from "../../src/server/wave15-record-embedding-adapter";

function vector(value = 0.25): readonly number[] {
  return Array.from({ length: 1_536 }, () => value);
}

describe("Wave-15 Record embedding adapter", () => {
  test("maps Record purposes without choosing a provider or model", async () => {
    const calls: unknown[] = [];
    const port: ProtectedAgentMemoryEmbeddingPort = {
      async embed(input) {
        calls.push(input);
        return {
          status: "success",
          value: {
            provider: "openai",
            canonicalModel: "text-embedding-3-small",
            dimensions: 1_536,
            contractVersion: 1,
            vector: vector(),
          },
        };
      },
    };
    const adapter = createWave15RecordEmbeddingAdapter(port);
    const statement = await adapter.embed({
      purpose: "record.statement_embedding",
      plaintext: "statement",
    });
    const query = await adapter.embed({
      purpose: "record.query_embedding",
      plaintext: "question",
    });

    expect(statement.status).toBe("available");
    expect(query.status).toBe("available");
    expect(calls).toEqual([
      { purpose: "memory.content_embedding", plaintext: "statement" },
      { purpose: "memory.query_embedding", plaintext: "question" },
    ]);
  });

  test("fails closed on an incompatible Wave-15 response", async () => {
    const adapter = createWave15RecordEmbeddingAdapter({
      async embed() {
        return {
          status: "success",
          value: {
            provider: "openai",
            canonicalModel: "model",
            dimensions: 1_536,
            contractVersion: 2,
            vector: vector(),
          },
        };
      },
    } as ProtectedAgentMemoryEmbeddingPort);

    expect(await adapter.embed({
      purpose: "record.query_embedding",
      plaintext: "question",
    })).toEqual({ status: "unavailable", reason: "invalid_response" });
  });
});
