import { describe, expect, spyOn, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type {
  ProtectedAgentBackgroundMemoryWorkInput,
  ProtectedAgentMemoryEmbeddingPort,
} from "@nautilo/lattice-bridge";

import {
  deriveProtectedBackgroundMemoryToolMutationRequestId,
  runProtectedBackgroundMemoryReview,
} from "../../src/memory/protected-background-memory-review.ts";
import {
  createProtectedBackgroundMemoryStaging,
} from "../../src/memory/protected-background-memory-staging.ts";
import * as universal from "../../src/providers/universal.ts";

const NAMESPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HUMAN_ID = "background-human";
const AGENT_ID = "background-agent";
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NEW_MEMORY_ID = "22222222-2222-4222-8222-222222222222";

const authority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: HUMAN_ID,
  agentId: AGENT_ID,
  readableNamespaceIds: Object.freeze([NAMESPACE_A]),
  mutableNamespaceIds: Object.freeze([NAMESPACE_A]),
  writableNamespaceId: NAMESPACE_A,
});

const inputs: readonly ProtectedAgentBackgroundMemoryWorkInput[] = Object.freeze([
  Object.freeze({
    productKind: "memory" as const,
    productId: MEMORY_ID,
    productRevision: 2,
    cryptoAccessRevision: 0,
    accessKind: "namespace" as const,
    importance: 0.8,
    tier: 2 as const,
    createdAt: 1_800_000_000_000,
    embedding: embeddingValue(3),
    objectId: "memory-object-2",
    namespaceId: NAMESPACE_A,
    payload: Object.freeze({
      formatVersion: 1 as const,
      type: "preference",
      content: "Prefers concise answers",
    }),
  }),
  Object.freeze({
    productKind: "message" as const,
    productId: "message-7",
    productRevision: 0,
    objectId: "message-object-7",
    namespaceId: NAMESPACE_A,
    payload: Object.freeze({
      formatVersion: 2 as const,
      role: "user" as const,
      content: "Please remember I use metric units",
    }),
  }),
]);

function embeddingValue(seed: number) {
  return Object.freeze({
    provider: "test-provider",
    canonicalModel: "test-embedding-v1",
    dimensions: 1536 as const,
    contractVersion: 1,
    vector: Object.freeze(Array.from(
      { length: 1536 },
      (_unused, index) => ((seed + index) % 13) / 13,
    )),
  });
}

const metadata = Object.freeze([Object.freeze({
  memoryId: MEMORY_ID,
  contentRevision: 2,
  cryptoAccessRevision: 0,
  importance: 0.8,
  tier: 2,
  createdAt: 1_800_000_000_000,
  embedding: embeddingValue(3),
})]);

const slots = Object.freeze([
  Object.freeze({
    action: "create" as const,
    publicationIdempotencyId: "publication-new",
    memoryId: NEW_MEMORY_ID,
    expectedContentRevision: 0,
    expectedCryptoAccessRevision: 0,
    nextContentRevision: 1,
    requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    createdAt: 1_800_000_000_010,
  }),
  Object.freeze({
    action: "replace" as const,
    publicationIdempotencyId: "publication-replace",
    memoryId: MEMORY_ID,
    expectedContentRevision: 2,
    expectedCryptoAccessRevision: 0,
    nextContentRevision: 3,
    requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    createdAt: 1_800_000_000_020,
  }),
]);

const tierSlots = Object.freeze([Object.freeze({
  operationIdempotencyId: "tier-promote-existing",
  memoryId: MEMORY_ID,
  contentRevision: 2,
  cryptoAccessRevision: 0,
  action: "promote" as const,
  expectedTier: 2 as const,
  nextTier: 1 as const,
  requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
})]);

function embedding(onCall?: (plaintext: string) => void): ProtectedAgentMemoryEmbeddingPort {
  return Object.freeze({
    embed: async ({ plaintext }: Parameters<
      ProtectedAgentMemoryEmbeddingPort["embed"]
    >[0]) => {
      onCall?.(plaintext);
      return Object.freeze({
      status: "success" as const,
      value: embeddingValue(plaintext.length),
      });
    },
  });
}

describe("protected background Memory Agent staging", () => {
  test("default model creator opts into the Responses transport", async () => {
    const model = {
      bindTools() { return this; },
      async invoke() { return new AIMessage("Nothing to save"); },
    };
    const createModel = spyOn(universal, "createUniversalModel")
      .mockResolvedValue(model as never);
    try {
      await runProtectedBackgroundMemoryReview({
        kind: "memory.review",
        authority,
        inputs,
        outputSlots: slots,
        tierSlots: [],
        embedding: embedding(),
        modelId: "openai:gpt-6-sol",
        roomId: "room-background-default-model",
        maximumIterations: 1,
        mutationRequestId: "background-request-default-model",
      });

      expect(createModel).toHaveBeenCalledWith("openai:gpt-6-sol", {
        useOpenAIResponsesApi: true,
      });
    } finally {
      createModel.mockRestore();
    }
  });

  test("derives stable per-tool replay identities from trusted tool calls", () => {
    const first = deriveProtectedBackgroundMemoryToolMutationRequestId(
      "background-request-1",
      "tool-call-1",
      "manage_memory",
      0,
    );
    expect(first).toBe(
      deriveProtectedBackgroundMemoryToolMutationRequestId(
        "background-request-1",
        "tool-call-1",
        "manage_memory",
        7,
      ),
    );
    expect(first).not.toBe(
      deriveProtectedBackgroundMemoryToolMutationRequestId(
        "background-request-1",
        "tool-call-2",
        "manage_memory",
        0,
      ),
    );
    expect(first).toMatch(/^background-memory-tool:v1:[0-9a-f]{64}$/);
  });

  test("searches only opened inputs and stages signed create/update slots", async () => {
    const embeddedPlaintexts: string[] = [];
    const staging = createProtectedBackgroundMemoryStaging({
      authority,
      inputs,
      candidateMetadata: metadata,
      outputSlots: slots,
      tierSlots: [],
      embedding: embedding((plaintext) => embeddedPlaintexts.push(plaintext)),
    });
    const searched = await staging.repository.search({
      authority,
      query: "answer style",
      limit: 10,
      includeArchive: false,
      mode: "vector",
    });
    expect(searched.status).toBe("success");
    if (searched.status !== "success") throw new Error("expected search");
    expect(searched.value.map((entry) => entry.content))
      .toEqual(["Prefers concise answers"]);
    expect(embeddedPlaintexts).toEqual(["answer style"]);

    expect(await staging.repository.save({
      operationId: "model-save",
      authority,
      type: "preference",
      content: "Uses metric units",
    })).toEqual({
      status: "success",
      value: { id: NEW_MEMORY_ID, action: "created" },
    });
    expect(await staging.repository.replace({
      operationId: "model-replace",
      authority,
      memoryId: MEMORY_ID,
      content: "Prefers extremely concise answers",
    })).toEqual({ status: "success", value: undefined });
    expect(staging.outputs().map((entry) => entry.kind === "content_revision"
      ? entry.publicationIdempotencyId
      : entry.operationIdempotencyId
    )).toEqual(["publication-new", "publication-replace"]);
    expect(embeddedPlaintexts).toEqual([
      "answer style",
      "Uses metric units",
      "Prefers extremely concise answers",
    ]);
  });

  test("fails metadata and scope mutations closed without staging output", async () => {
    const staging = createProtectedBackgroundMemoryStaging({
      authority,
      inputs,
      candidateMetadata: metadata,
      outputSlots: slots,
      tierSlots: [],
      embedding: embedding(),
    });
    expect(await staging.repository.setTier({
      operationId: "metadata-op",
      authority,
      memoryId: MEMORY_ID,
      action: "promote",
    })).toEqual({ status: "unavailable", reason: "incomplete_access_set" });
    expect(staging.outputs()).toEqual([]);
    expect(() => createProtectedBackgroundMemoryStaging({
      authority: {
        mode: "scope",
        subjectUserId: HUMAN_ID,
        agentId: AGENT_ID,
        scopeId: "scope-1",
        originWritableNamespaceId: NAMESPACE_A,
      },
      inputs,
      candidateMetadata: metadata,
      outputSlots: slots,
      tierSlots: [],
      embedding: embedding(),
    })).toThrow("inventory is incomplete");
    expect(() => createProtectedBackgroundMemoryStaging({
      authority,
      inputs,
      candidateMetadata: [{ ...metadata[0]!, contentRevision: 1 }],
      outputSlots: slots,
      tierSlots: [],
      embedding: embedding(),
    })).toThrow("inventory is incomplete");
  });

  test("stages only an exact signed tier transition", async () => {
    const staging = createProtectedBackgroundMemoryStaging({
      authority,
      inputs,
      candidateMetadata: metadata,
      outputSlots: slots,
      tierSlots,
      embedding: embedding(),
    });
    expect(await staging.repository.setTier({
      operationId: "tool-tier",
      authority,
      memoryId: MEMORY_ID,
      action: "promote",
    })).toEqual({ status: "success", value: undefined });
    expect(staging.outputs()).toEqual([{
      kind: "tier_transition",
      operationIdempotencyId: "tier-promote-existing",
      memoryId: MEMORY_ID,
      action: "promote",
    }]);
  });

  test("allows scope seed search but only origin-bound create", async () => {
    const scopeAuthority = Object.freeze({
      mode: "scope" as const,
      subjectUserId: HUMAN_ID,
      agentId: AGENT_ID,
      scopeId: "scope-1",
      originWritableNamespaceId: NAMESPACE_A,
    });
    const scopeInputs = inputs.map((entry) => entry.productKind === "memory"
      ? Object.freeze({ ...entry, accessKind: "scope_seed" as const })
      : entry
    );
    const staging = createProtectedBackgroundMemoryStaging({
      authority: scopeAuthority,
      inputs: scopeInputs,
      candidateMetadata: metadata,
      outputSlots: slots,
      tierSlots,
      embedding: embedding(),
    });
    expect((await staging.repository.search({
      authority: scopeAuthority,
      query: "preferences",
      limit: 5,
      includeArchive: false,
      mode: "vector",
    })).status).toBe("success");
    expect((await staging.repository.replace({
      operationId: "scope-replace-seed",
      authority: scopeAuthority,
      memoryId: MEMORY_ID,
      content: "must not replace seed",
    })).status).toBe("unavailable");
    expect((await staging.repository.setTier({
      operationId: "scope-tier-seed",
      authority: scopeAuthority,
      memoryId: MEMORY_ID,
      action: "promote",
    })).status).toBe("unavailable");
    expect((await staging.repository.save({
      operationId: "scope-create",
      authority: scopeAuthority,
      type: "preference",
      content: "scope-authored Memory",
    })).status).toBe("success");
    expect(staging.outputs()[0]?.kind).toBe("content_revision");
  });

  test("runs model tools over decoded inputs and returns only signed outputs", async () => {
    let calls = 0;
    const outputs = await runProtectedBackgroundMemoryReview({
      kind: "memory.review",
      authority,
      inputs,
      outputSlots: slots,
      tierSlots: [],
      embedding: embedding(),
      modelId: "review-model",
      roomId: "room-background-1",
      maximumIterations: 2,
      mutationRequestId: "background-request-1",
      createModel: async () => ({
        async invoke() {
          calls += 1;
          if (calls === 1) {
            return new AIMessage({
              content: "",
              tool_calls: [{
                id: "save-1",
                name: "manage_memory",
                args: {
                  action: "save",
                  type: "preference",
                  content: "Uses metric units",
                },
              }],
            });
          }
          return new AIMessage("Nothing else to save");
        },
      }),
    });
    expect(calls).toBe(2);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.kind).toBe("content_revision");
    if (outputs[0]?.kind !== "content_revision") {
      throw new Error("expected content output");
    }
    expect(outputs[0].publicationIdempotencyId).toBe("publication-new");
    expect(outputs[0]?.memoryId).toBe(NEW_MEMORY_ID);
    expect(outputs[0]?.payload.content).toBe("Uses metric units");
  });

  test("requires a real Room identity for Namespace background work", async () => {
    let error: unknown;
    try {
      await runProtectedBackgroundMemoryReview({
        kind: "memory.review",
        authority,
        inputs,
        outputSlots: slots,
        tierSlots: [],
        embedding: embedding(),
        modelId: "review-model",
        roomId: "",
        maximumIterations: 1,
        mutationRequestId: "background-request-1",
        createModel: async () => ({
          invoke: async () => new AIMessage("Nothing to save"),
        }),
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toContain("model bound is invalid");
  });
});
