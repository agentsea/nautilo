import { describe, expect, test } from "bun:test";

import {
  createInvocationBoundProtectedAgentMemoryRepository,
  type AgentMemoryEmbedding,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentMemoryProductPort,
  type ProtectedMemoryCandidate,
  type ProtectedMemoryMutationPlan,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryReplacementPlan,
} from "../../src/memory/active-memory-composition.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  type PreparedMemoryCryptoRevision,
} from "../../src/memory/memory-repository.ts";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
} from "../../src/memory/active-memory-repository.ts";
import { bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError } from "../../src/transition/encryption-data-operation-owner.ts";

const owner = bindEncryptionDataOperationOwner({
  policy: {
    resolve: async () => ({
      policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
      revalidationToken: 1,
    }),
    revalidate: () => Promise.resolve(),
  },
});

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const MEMORY = "33333333-3333-4333-8333-333333333333";
const SECOND_MEMORY = "44444444-4444-4444-8444-444444444444";
const NS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NS_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const embedding: AgentMemoryEmbedding = Object.freeze({
  vector: Object.freeze(Array.from({ length: 1536 }, () => 0.25)),
  provider: "openai",
  canonicalModel: "text-embedding-3-small",
  dimensions: 1536,
  contractVersion: 1,
});

const authority: ProtectedMemoryAuthority = Object.freeze({
  mode: "namespace",
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([NS_A, NS_B]),
  mutableNamespaceIds: Object.freeze([NS_A, NS_B]),
  writableNamespaceId: NS_A,
});

function success<Value>(value: Value): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "success", value });
}

function target(
  memoryId = MEMORY,
  contentRevision = 1,
  requiredNamespaceIds: readonly string[] = [NS_A],
): ProtectedMemoryMutationTarget {
  return Object.freeze({
    memoryId,
    contentRevision,
    cryptoAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision }),
    requiredNamespaceIds: Object.freeze([...requiredNamespaceIds]),
  });
}

function plan(
  overrides: Partial<ProtectedMemoryMutationPlan> = {},
): ProtectedMemoryMutationPlan {
  const memoryId = overrides.memoryId ?? MEMORY;
  const contentRevision = overrides.contentRevision ?? 1;
  return Object.freeze({
    operationId: "operation-1",
    action: "created",
    mutationKind: "save",
    memoryId,
    contentRevision,
    cryptoAccessRevision: 0,
    expectedPriorAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision }),
    requiredNamespaceIds: Object.freeze([NS_A, NS_B]),
    reservationDigest: new Uint8Array(32),
    mutationCommitment: new Uint8Array(32),
    importance: 0.6,
    createdAt: 1_900_000_000_000,
    ...overrides,
  });
}

function prepared(
  value: ProtectedMemoryMutationPlan,
): PreparedMemoryCryptoRevision {
  return Object.freeze({
    memoryId: value.memoryId,
    contentRevision: value.contentRevision,
    objectId: value.cryptoObjectId,
    objectType: "nautilo-memory-v1",
    payloadVersion: 1,
    requiredNamespaceIds: value.requiredNamespaceIds,
  });
}

function candidate(
  overrides: Partial<ProtectedMemoryCandidate> = {},
): ProtectedMemoryCandidate {
  const memoryId = overrides.memoryId ?? MEMORY;
  const contentRevision = overrides.contentRevision ?? 1;
  return Object.freeze({
    memoryId,
    contentRevision,
    cryptoAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision }),
    readNamespaceId: NS_A,
    requiredNamespaceIds: Object.freeze([NS_A]),
    importance: 0.8,
    tier: 1,
    score: 0.95,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  });
}

function ports(
  overrides: Readonly<{
    embedding?: Partial<ProtectedAgentMemoryEmbeddingPort>;
    product?: Partial<ProtectedAgentMemoryProductPort>;
    crypto?: Partial<ProtectedAgentMemoryCryptoSessionPort>;
  }> = {},
): Readonly<{
  embedding: ProtectedAgentMemoryEmbeddingPort;
  product: ProtectedAgentMemoryProductPort;
  crypto: ProtectedAgentMemoryCryptoSessionPort;
}> {
  const defaultPlan = plan();
  return {
    embedding: {
      embed: async () => success(embedding),
      ...overrides.embedding,
    },
    product: {
      replayCompleted: async () => success(null),
      searchCandidates: async () => success([]),
      selectSaveCandidate: async () => success(null),
      planSave: async ({ mutationCommitment }) =>
        success(
          Object.freeze({
            ...defaultPlan,
            mutationCommitment,
          }),
        ),
      planReplace: async ({ mutationCommitment }) =>
        success(
          Object.freeze({
            ...plan({
              action: "updated",
              mutationKind: "replace",
              contentRevision: 2,
              mutationCommitment,
            }),
            action: "updated" as const,
            previous: target(),
          }),
        ),
      publishPrepared: async () => "published",
      resolveTierTarget: async () => success(target()),
      commitTier: async () => "applied",
      ...overrides.product,
    },
    crypto: {
      openMany: async () => success([]),
      prepare: async ({ plan: value }) => success(prepared(value)),
      authorizeCommit: async ({ commit }) => success(await commit()),
      ...overrides.crypto,
    },
  };
}

function repository(value: ReturnType<typeof ports>) {
  return createInvocationBoundProtectedAgentMemoryRepository({
    owner,
    subjectUserId: USER,
    agentId: AGENT,
    entrypointId: "foreground.main",
    repairExactCandidate: async () => success(undefined),
    fallbackOrdinary: async ({ reason }) => ({ status: "unavailable", reason }),
    ...value,
  });
}

describe("invocation-bound protected Agent Memory repository", () => {
  test("embeds the query before product search and opens every exact candidate", async () => {
    const seenProductInputs: unknown[] = [];
    const first = candidate();
    const second = candidate({
      memoryId: SECOND_MEMORY,
      readNamespaceId: NS_B,
      requiredNamespaceIds: [NS_A, NS_B],
      score: 0.8,
    });
    const value = ports({
      product: {
        searchCandidates: async (input) => {
          seenProductInputs.push(input);
          return success([first, second]);
        },
      },
      crypto: {
        openMany: async () =>
          success([
            {
              memoryId: MEMORY,
              contentRevision: 1,
              type: "fact",
              content: "one",
            },
            {
              memoryId: SECOND_MEMORY,
              contentRevision: 1,
              type: "preference",
              content: "two",
            },
          ]),
      },
    });

    const result = await repository(value).search({
      authority,
      query: "remembered topic",
      limit: 2,
      includeArchive: false,
      mode: "vector",
    });

    expect(result.status).toBe("success");
    expect(
      result.status === "success" && result.value.map((item) => item.content),
    ).toEqual(["one", "two"]);
    expect(seenProductInputs).toHaveLength(1);
    expect(Object.keys(seenProductInputs[0] as object).sort()).toEqual([
      "authority",
      "embedding",
      "includeArchive",
      "limit",
    ]);
    expect(JSON.stringify(seenProductInputs[0])).not.toContain(
      "remembered topic",
    );
  });

  test("fails the whole read when crypto omits or reorders a candidate", async () => {
    const candidates = [candidate(), candidate({ memoryId: SECOND_MEMORY })];
    const value = ports({
      product: { searchCandidates: async () => success(candidates) },
      crypto: {
        openMany: async () =>
          success([
            {
              memoryId: SECOND_MEMORY,
              contentRevision: 1,
              type: "fact",
              content: "two",
            },
          ]),
      },
    });

    const result = await repository(value).search({
      authority,
      query: "topic",
      limit: 2,
      includeArchive: false,
      mode: "vector",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "integrity_failure",
    });
  });

  test("Fallback loads ordinary bodies for the exact selected candidate revisions", async () => {
    const selected = candidate();
    let exactCandidates: readonly ProtectedMemoryCandidate[] = [];
    const value = ports({
      product: { searchCandidates: async () => success([selected]) },
      crypto: { openMany: async () => ({ status: "unavailable",
        reason: "encryption_pending" }) },
    });
    const result = await createInvocationBoundProtectedAgentMemoryRepository({
      owner, subjectUserId: USER, agentId: AGENT,
      entrypointId: "foreground.main", ...value,
      repairExactCandidate: async () => success(undefined),
      fallbackOrdinary: async ({ reason }) => ({ status: "unavailable", reason }),
      loadExactOrdinary: async ({ candidates }) => {
        exactCandidates = candidates;
        return success([{ memoryId: selected.memoryId,
          contentRevision: selected.contentRevision, type: "fact",
          content: "exact ordinary body" }]);
      },
    }).search({ authority, query: "topic", limit: 1,
      includeArchive: false, mode: "vector" });
    expect(exactCandidates).toEqual([selected]);
    expect(result).toMatchObject({ status: "success",
      value: [{ id: selected.memoryId, content: "exact ordinary body" }] });
  });

  test("policy cancellation is rethrown instead of becoming an invalid unavailable reason", async () => {
    const selected = candidate();
    const cancellingOwner = bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode: "shadow_encryption",
        shadowBehavior: "fallback" }, revalidationToken: 9 }),
      revalidate: async () => {
        throw new ClassifiedDataOperationError("cancelled", "policy changed now");
      },
    } });
    const value = ports({ product: {
      searchCandidates: async () => success([selected]),
    } });
    const repository = createInvocationBoundProtectedAgentMemoryRepository({
      owner: cancellingOwner, subjectUserId: USER, agentId: AGENT,
      entrypointId: "foreground.main", ...value,
      repairExactCandidate: async () => success(undefined),
      fallbackOrdinary: async ({ reason }) => ({ status: "unavailable", reason }),
    });
    const error = await repository.search({ authority, query: "topic", limit: 1,
      includeArchive: false, mode: "vector" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failureClass: "cancelled",
      message: "policy changed now" });
  });

  test("keeps a scope seed Memory on its canonical Namespace", async () => {
    const scopeAuthority: ProtectedMemoryAuthority = Object.freeze({
      mode: "scope",
      subjectUserId: USER,
      agentId: AGENT,
      scopeId: "55555555-5555-4555-8555-555555555555",
      originWritableNamespaceId: NS_A,
    });
    const value = ports({
      product: {
        searchCandidates: async () =>
          success([
            candidate({ readNamespaceId: NS_B, requiredNamespaceIds: [NS_B] }),
          ]),
      },
      crypto: {
        openMany: async ({ candidates }) => {
          expect(candidates[0]?.readNamespaceId).toBe(NS_B);
          return success([
            {
              memoryId: MEMORY,
              contentRevision: 1,
              type: "fact",
              content: "seed",
            },
          ]);
        },
      },
    });

    const result = await repository(value).search({
      authority: scopeAuthority,
      query: "seed",
      limit: 1,
      includeArchive: false,
      mode: "vector",
    });

    expect(result.status).toBe("success");
  });

  test("prepares every required Namespace then freshly authorizes product publication", async () => {
    const calls: string[] = [];
    const value = ports({
      product: {
        planSave: async (input) => {
          calls.push("plan");
          expect(Object.keys(input)).not.toContain("content");
          expect(Object.keys(input)).not.toContain("type");
          return success(
            plan({ mutationCommitment: input.mutationCommitment }),
          );
        },
        publishPrepared: async () => {
          calls.push("publish");
          return "published";
        },
      },
      crypto: {
        prepare: async ({ plan: value, content }) => {
          calls.push("prepare");
          expect(content).toEqual({
            kind: "complete",
            payload: { formatVersion: 1, type: "preference", content: "tea" },
          });
          return success(prepared(value));
        },
        authorizeCommit: async ({ commit }) => {
          calls.push("authorize");
          return success(await commit());
        },
      },
    });

    const result = await repository(value).save({
      operationId: "operation-1",
      authority,
      type: "preference",
      content: "tea",
    });

    expect(result.status).toBe("success");
    expect(calls).toEqual(["plan", "prepare", "authorize", "publish"]);
  });

  test("repairs the exact selected ordinary semantic candidate before planning its update", async () => {
    const calls: string[] = [];
    const selection = Object.freeze({
      memoryId: MEMORY,
      contentRevision: 1,
      score: 0.95,
      repairRequired: true,
      repair: Object.freeze({
        representation: "structural" as const,
        id: MEMORY,
        type: null,
        importance: 0.5,
        tier: 1,
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
        score: 0.95,
      }),
    });
    const value = ports({
      product: {
        selectSaveCandidate: async () => {
          calls.push("select");
          return success(selection);
        },
        planSave: async (request) => {
          calls.push("plan");
          expect(request.selectedCandidate).toBe(selection);
          return success(
            plan({
              operationId: "operation-repair-1",
              action: "updated",
              contentRevision: 2,
              similarity: 0.95,
              mutationCommitment: request.mutationCommitment,
            }),
          );
        },
      },
    });
    const result = await createInvocationBoundProtectedAgentMemoryRepository({
      owner,
      subjectUserId: USER,
      agentId: AGENT,
      entrypointId: "foreground.main",
      ...value,
      repairExactCandidate: async (request) => {
        calls.push("repair");
        expect(request.selection).toBe(selection);
        return success(undefined);
      },
      fallbackOrdinary: async ({ reason }) => ({
        status: "unavailable",
        reason,
      }),
    }).save({
      operationId: "operation-repair-1",
      authority,
      type: "preference",
      content: "tea",
    });
    expect(result.status).toBe("success");
    expect(calls.slice(0, 3)).toEqual(["select", "repair", "plan"]);
  });

  test("uses only the explicit ordinary fallback after a reserved crypto-unavailable save", async () => {
    let fallbackPlan: ProtectedMemoryMutationPlan | undefined;
    const value = ports({
      crypto: {
        prepare: async () => ({
          status: "unavailable",
          reason: "encryption_pending",
        }),
      },
    });
    const result = await createInvocationBoundProtectedAgentMemoryRepository({
      owner,
      subjectUserId: USER,
      agentId: AGENT,
      entrypointId: "foreground.main",
      ...value,
      repairExactCandidate: async () => success(undefined),
      fallbackOrdinary: async ({ plan: reserved, reason }) => {
        fallbackPlan = reserved;
        return {
          status: "success",
          fallbackReason: reason,
          value: { id: reserved.memoryId, action: reserved.action },
        };
      },
    }).save({
      operationId: "operation-1",
      authority,
      type: "preference",
      content: "tea",
    });
    expect(fallbackPlan?.operationId).toBe("operation-1");
    expect(result).toMatchObject({
      status: "success",
      fallbackReason: "encryption_pending",
    });
  });

  test("never retries an ordinary fallback after protected publication begins", async () => {
    let fallbackCalls = 0;
    const value = ports({
      product: {
        publishPrepared: async () => {
          throw new Error("ambiguous protected publication");
        },
      },
    });
    const repository = createInvocationBoundProtectedAgentMemoryRepository({
      owner,
      subjectUserId: USER,
      agentId: AGENT,
      entrypointId: "foreground.main",
      ...value,
      repairExactCandidate: async () => success(undefined),
      fallbackOrdinary: async ({ reason }) => {
        fallbackCalls += 1;
        return { status: "unavailable", reason };
      },
    });
    const publicationFailure = await repository.save({
        operationId: "operation-1",
        authority,
        type: "preference",
        content: "tea",
      }).then(() => null, (error: unknown) => error);
    expect(publicationFailure).toBeInstanceOf(Error);
    expect((publicationFailure as Error).message).toContain("ambiguous protected publication");
    expect(fallbackCalls).toBe(0);
  });

  test("replays a completed save before embedding, preparation, or publication", async () => {
    const calls: string[] = [];
    const value = ports({
      embedding: {
        embed: async () => {
          calls.push("embed");
          return success(embedding);
        },
      },
      product: {
        replayCompleted: async ({ mutationKind, mutationCommitment }) => {
          calls.push("replay");
          expect(mutationKind).toBe("save");
          expect(mutationCommitment).toBeInstanceOf(Uint8Array);
          return success({
            mutationKind: "save",
            memoryId: MEMORY,
            action: "updated",
            similarity: 0.94,
          });
        },
        planSave: async () => {
          calls.push("plan");
          return success(plan());
        },
        publishPrepared: async () => {
          calls.push("publish");
          return "published";
        },
      },
      crypto: {
        prepare: async ({ plan: value }) => {
          calls.push("prepare");
          return success(prepared(value));
        },
      },
    });

    expect(
      await repository(value).save({
        operationId: "operation-1",
        authority,
        type: "preference",
        content: "tea",
        importance: 0.6,
      }),
    ).toEqual({
      status: "success",
      value: { id: MEMORY, action: "updated", similarity: 0.94 },
    });
    expect(calls).toEqual(["replay"]);
  });

  test("replays completed replace and tier outcomes before providers or target reads", async () => {
    const calls: string[] = [];
    const value = ports({
      embedding: {
        embed: async () => {
          calls.push("embed");
          return success(embedding);
        },
      },
      product: {
        replayCompleted: async ({ mutationKind }) =>
          success({
            mutationKind,
            memoryId: MEMORY,
            action: "updated",
          }),
        planReplace: async () => {
          calls.push("plan");
          throw new Error("must not plan");
        },
        resolveTierTarget: async () => {
          calls.push("resolve");
          return success(target());
        },
      },
      crypto: {
        authorizeCommit: async ({ commit }) => {
          calls.push("authorize");
          return success(await commit());
        },
      },
    });

    expect(
      await repository(value).replace({
        operationId: "operation-1",
        authority,
        memoryId: MEMORY,
        content: "changed",
      }),
    ).toEqual({ status: "success", value: undefined });
    expect(
      await repository(value).setTier({
        operationId: "operation-2",
        authority,
        memoryId: MEMORY,
        action: "promote",
      }),
    ).toEqual({ status: "success", value: undefined });
    expect(calls).toEqual([]);
  });

  test("preserves replacement type inside crypto without disclosing it to product", async () => {
    const replacement: ProtectedMemoryReplacementPlan = Object.freeze({
      ...plan({
        action: "updated",
        mutationKind: "replace",
        contentRevision: 2,
      }),
      action: "updated",
      previous: target(),
    });
    let productInput: unknown;
    const value = ports({
      product: {
        planReplace: async (input) => {
          productInput = input;
          return success(
            Object.freeze({
              ...replacement,
              mutationCommitment: input.mutationCommitment,
            }),
          );
        },
      },
      crypto: {
        prepare: async ({ plan: value, content }) => {
          expect(content).toEqual({
            kind: "replacement",
            previous: replacement.previous,
            content: "new body",
          });
          expect(JSON.stringify(content)).not.toContain('"type":"replacement"');
          return success(prepared(value));
        },
      },
    });

    const result = await repository(value).replace({
      operationId: "operation-1",
      authority,
      memoryId: MEMORY,
      content: "new body",
    });

    expect(result).toEqual({ status: "success", value: undefined });
    expect(Object.keys(productInput as object).sort()).toEqual([
      "authority",
      "embedding",
      "memoryId",
      "mutationCommitment",
      "operationId",
    ]);
    expect(JSON.stringify(productInput)).not.toContain("new body");
  });

  test("rejects an incomplete or unauthorized mutation set before crypto", async () => {
    let prepareCalls = 0;
    const value = ports({
      product: {
        planSave: async (input) =>
          success(
            plan({
              requiredNamespaceIds: [NS_A, NS_C],
              mutationCommitment: input.mutationCommitment,
            }),
          ),
      },
      crypto: {
        prepare: async ({ plan: value }) => {
          prepareCalls += 1;
          return success(prepared(value));
        },
      },
    });

    const result = await repository(value).save({
      operationId: "operation-1",
      authority,
      type: "fact",
      content: "body",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "incomplete_access_set",
    });
    expect(prepareCalls).toBe(0);
  });

  test("rejects out-of-range importance before embedding or product access", async () => {
    let calls = 0;
    const value = ports({
      embedding: {
        embed: async () => {
          calls += 1;
          return success(embedding);
        },
      },
      product: {
        planSave: async () => {
          calls += 1;
          return success(plan());
        },
      },
    });

    for (const importance of [-0.01, 1.01]) {
      expect(
        await repository(value).save({
          operationId: `operation-${importance}`,
          authority,
          type: "fact",
          content: "body",
          importance,
        }),
      ).toEqual({
        status: "unavailable",
        reason: "authorization_required",
      });
    }
    expect(calls).toBe(0);
  });

  test("commits exact save body and authored type even when embeddings are identical", async () => {
    const commitments: Uint8Array[] = [];
    const value = ports({
      product: {
        planSave: async ({ mutationCommitment }) => {
          commitments.push(mutationCommitment.slice());
          return { status: "unavailable", reason: "stale_revision" };
        },
      },
    });
    for (const [type, content] of [
      ["fact", "same body"],
      ["goal", "same body"],
      ["fact", "changed body"],
    ] as const) {
      await repository(value).save({
        operationId: "same-operation",
        authority,
        type,
        content,
      });
    }
    expect(commitments).toHaveLength(3);
    expect(commitments[0]).not.toEqual(commitments[1]);
    expect(commitments[0]).not.toEqual(commitments[2]);
  });

  test("runs tier CAS only inside a fresh exact-set authorization", async () => {
    const calls: string[] = [];
    const value = ports({
      product: {
        resolveTierTarget: async () => {
          calls.push("resolve");
          return success(target(MEMORY, 4, [NS_A, NS_B]));
        },
        commitTier: async () => {
          calls.push("commit");
          return "applied";
        },
      },
      crypto: {
        authorizeCommit: async ({ operation, commit }) => {
          calls.push(`authorize:${operation}`);
          return success(await commit());
        },
      },
    });

    const result = await repository(value).setTier({
      operationId: "operation-1",
      authority,
      memoryId: MEMORY,
      action: "demote",
    });

    expect(result).toEqual({ status: "success", value: undefined });
    expect(calls).toEqual(["resolve", "authorize:set-tier", "commit"]);
  });

  test("rejects invocation identity mismatch before embedding or product access", async () => {
    let calls = 0;
    const value = ports({
      embedding: {
        embed: async () => {
          calls += 1;
          return success(embedding);
        },
      },
      product: {
        searchCandidates: async () => {
          calls += 1;
          return success([]);
        },
      },
    });

    const result = await repository(value).search({
      authority: { ...authority, subjectUserId: "other-user" },
      query: "topic",
      limit: 1,
      includeArchive: false,
      mode: "vector",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(calls).toBe(0);
  });
});
