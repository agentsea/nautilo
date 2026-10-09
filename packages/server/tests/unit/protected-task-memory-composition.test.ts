import { describe, expect, test } from "bun:test";

import {
  bindEncryptionDataOperationOwner,
  createInvocationBoundProtectedAgentMemoryRepository,
  deriveMemoryCryptoObjectIdV1,
  type AgentMemoryEmbedding,
  type EncryptionDataOperationOwner,
  type PreparedMemoryCryptoRevision,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedAgentMemoryProductPort,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryCandidate,
  type ProtectedMemoryMutationPlan,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";
import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresHandle,
  ProtectedTaskMemoryReadPort,
  TaskMemoryReadBinding,
} from "@nautilo/lattice-bridge/server";

import {
  createProtectedTaskMemoryRepository,
  type ProtectedTaskMemoryRepositoryCompositionInput,
} from "../../src/routes/protected-task-memory-composition";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const MEMORY_A = "33333333-3333-4333-8333-333333333333";
const MEMORY_B = "44444444-4444-4444-8444-444444444444";
const MEMORY_C = "55555555-5555-4555-8555-555555555555";
const NS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NS_HIDDEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCOPE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROOM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TASK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }> = Object.freeze({
  mode: "namespace",
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([NS_A]),
  mutableNamespaceIds: Object.freeze([NS_A]),
  writableNamespaceId: NS_A,
});

const embedding: AgentMemoryEmbedding = Object.freeze({
  vector: Object.freeze(Array.from({ length: 1536 }, () => 0.25)),
  provider: "openai",
  canonicalModel: "text-embedding-3-small",
  dimensions: 1536,
  contractVersion: 1,
});

function success<Value>(value: Value): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "success", value });
}

function target(
  memoryId = MEMORY_A,
  contentRevision = 1,
  requiredNamespaceIds: readonly string[] = [NS_A, NS_HIDDEN],
): ProtectedMemoryMutationTarget {
  return Object.freeze({
    memoryId,
    contentRevision,
    cryptoAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision }),
    requiredNamespaceIds: Object.freeze([...requiredNamespaceIds]),
  });
}

function candidate(
  memoryId = MEMORY_A,
  score = 0.9,
): ProtectedMemoryCandidate {
  return Object.freeze({
    ...target(memoryId),
    readNamespaceId: NS_A,
    importance: 0.7,
    tier: 1,
    score,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  });
}

function plan(overrides: Partial<ProtectedMemoryMutationPlan> = {}) {
  const memoryId = overrides.memoryId ?? MEMORY_A;
  const contentRevision = overrides.contentRevision ?? 1;
  return Object.freeze({
    operationId: "operation-1",
    action: "created" as const,
    mutationKind: "save" as const,
    memoryId,
    contentRevision,
    cryptoAccessRevision: 0,
    expectedPriorAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision }),
    requiredNamespaceIds: Object.freeze([NS_A]),
    reservationDigest: new Uint8Array(32),
    mutationCommitment: new Uint8Array(32),
    importance: 0.5,
    createdAt: 2_000_000_000_000,
    ...overrides,
  });
}

function prepared(value: ProtectedMemoryMutationPlan): PreparedMemoryCryptoRevision {
  return Object.freeze({
    memoryId: value.memoryId,
    contentRevision: value.contentRevision,
    objectId: value.cryptoObjectId,
    objectType: "nautilo-memory-v1",
    payloadVersion: 1,
    requiredNamespaceIds: value.requiredNamespaceIds,
  });
}

function mutationProduct(
  overrides: Partial<ProtectedAgentMemoryProductPort> = {},
): ProtectedAgentMemoryProductPort {
  return {
    replayCompleted: async () => success(null),
    searchCandidates: async () => success([]),
    selectSaveCandidate: async () => success(null),
    planSave: async ({ mutationCommitment }) => success(plan({
      mutationCommitment,
    })),
    planReplace: async ({ mutationCommitment }) => success(Object.freeze({
      ...plan({
        action: "updated",
        mutationKind: "replace",
        contentRevision: 2,
        mutationCommitment,
      }),
      action: "updated" as const,
      previous: target(),
    })),
    publishPrepared: async () => "published",
    resolveTierTarget: async () => success(target()),
    commitTier: async () => "applied",
    ...overrides,
  };
}

function crypto(
  overrides: Partial<ProtectedAgentMemoryCryptoSessionPort> = {},
): ProtectedAgentMemoryCryptoSessionPort {
  return {
    openMany: async () => success([]),
    prepare: async ({ plan: value }) => success(prepared(value)),
    authorizeCommit: async ({ commit }) => success(await commit()),
    ...overrides,
  };
}

function owner(
  mode: "shadow_encryption" | "encrypted_only" = "shadow_encryption",
  shadowBehavior: "fallback" | "strict" = "fallback",
): EncryptionDataOperationOwner {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: async () => ({
        policy: { mode, shadowBehavior },
        revalidationToken: 7,
      }),
      revalidate: async () => undefined,
    },
  });
}

function namespaceBinding(): TaskMemoryReadBinding {
  return Object.freeze({ mode: "namespace", authority });
}

function baseInput(
  readBinding: TaskMemoryReadBinding = namespaceBinding(),
): ProtectedTaskMemoryRepositoryCompositionInput {
  return {
    subjectUserId: USER,
    agentId: AGENT,
    entrypointId: "subagent.scope",
    read: {
      handle: {} as ConversationProductPostgresHandle,
      canonicalRunner: {} as ConversationProductCanonicalTransactionRunner,
      binding: readBinding,
      boundary: { withCurrentRead: async ({ use }) => use() },
    },
    mutationProduct: mutationProduct(),
    crypto: crypto(),
    owner: owner(),
    embedding: { embed: async () => success(embedding) },
    repairExactCandidate: async ({ selection }) => success(Object.freeze({
      memoryId: selection.memoryId,
      contentRevision: Math.max(1, selection.contentRevision),
    })),
    fallbackOrdinary: async ({ reason }) => ({
      status: "unavailable",
      reason,
    }),
  };
}

function reader(
  overrides: Partial<ProtectedTaskMemoryReadPort> = {},
): ProtectedTaskMemoryReadPort {
  return {
    searchProtectedCandidates: async () => success([]),
    searchCandidates: async () => success([]),
    loadExactProtectedSources: async () => success([]),
    loadExactOrdinary: async () => success([]),
    ...overrides,
  };
}

describe("protected Task Memory composition", () => {
  test("passes Namespace and Scope bindings unchanged to the product-role reader", () => {
    const seen: TaskMemoryReadBinding[] = [];
    const bindings: TaskMemoryReadBinding[] = [
      namespaceBinding(),
      Object.freeze({
        mode: "scope",
        authority: Object.freeze({
          mode: "scope",
          subjectUserId: USER,
          agentId: AGENT,
          scopeId: SCOPE,
          originWritableNamespaceId: NS_A,
        }),
        coordinates: Object.freeze({
          taskId: TASK,
          requesterUserId: USER,
          agentId: AGENT,
          scopeId: SCOPE,
          memoryRoomId: ROOM,
          originWritableNamespaceId: NS_A,
        }),
        readableNamespaceIds: Object.freeze([NS_A]),
      }),
    ];
    const placeholder = {} as ReturnType<
      typeof createInvocationBoundProtectedAgentMemoryRepository
    >;

    for (const binding of bindings) {
      createProtectedTaskMemoryRepository(baseInput(binding), {
        createReader: input => {
          seen.push(input.binding);
          return reader();
        },
        createRepository: () => placeholder,
      });
    }

    expect(seen).toEqual(bindings);
  });

  test("routes protected search to the product reader and semantic mutations to the Agent product", async () => {
    const calls: string[] = [];
    let composed: Parameters<
      typeof createInvocationBoundProtectedAgentMemoryRepository
    >[0] | undefined;
    const current = candidate();
    const input = baseInput();
    input.mutationProduct.searchCandidates = async () => {
      calls.push("agent-search");
      return success([]);
    };
    input.mutationProduct.resolveTierTarget = async () => {
      calls.push("agent-mutation");
      return success(target());
    };
    const readPort = reader({
      searchProtectedCandidates: async () => {
        calls.push("product-read");
        return success([current]);
      },
    });

    createProtectedTaskMemoryRepository(input, {
      createReader: () => readPort,
      createRepository: value => {
        composed = value;
        return {} as ReturnType<
          typeof createInvocationBoundProtectedAgentMemoryRepository
        >;
      },
    });

    expect(composed?.fallbackSearch).toBe(readPort);
    await composed!.product.searchCandidates({
      authority,
      embedding,
      limit: 1,
      includeArchive: false,
    });
    await composed!.product.resolveTierTarget({
      operationId: "tier-1",
      authority,
      memoryId: MEMORY_A,
    });
    expect(calls).toEqual(["product-read", "agent-mutation"]);
  });

  test("uses the real repository and central owner for one mixed ranked Fallback read", async () => {
    const calls: string[] = [];
    const protectedOnly = Object.freeze({
      ...candidate(MEMORY_A, 0.9),
      representation: "protected_only" as const,
    });
    const dual = Object.freeze({
      ...candidate(MEMORY_B, 0.8),
      representation: "dual" as const,
    });
    const ordinaryOnly = Object.freeze({
      ...candidate(MEMORY_C, 0.7),
      representation: "ordinary_only" as const,
      cryptoObjectId: null,
    });
    const current = new Map<string, ProtectedMemoryCandidate>([
      [MEMORY_A, protectedOnly],
      [MEMORY_B, dual],
    ]);
    const readPort = reader({
      searchProtectedCandidates: async () => {
        calls.push("protected-selector");
        return success([]);
      },
      searchCandidates: async () => {
        calls.push("mixed-selector");
        return success([protectedOnly, dual, ordinaryOnly]);
      },
      loadExactProtectedSources: async ({ memoryIds }) => {
        calls.push(`current:${memoryIds.join(",")}`);
        return success(memoryIds.map(id => current.get(id)!));
      },
      loadExactOrdinary: async ({ candidates }) => {
        calls.push(`ordinary:${candidates.map(value => value.memoryId).join(",")}`);
        return success(candidates.map(value => Object.freeze({
          memoryId: value.memoryId,
          contentRevision: value.contentRevision,
          type: "fact",
          content: `ordinary:${value.memoryId}`,
        })));
      },
    });
    const repository = createProtectedTaskMemoryRepository({
      ...baseInput(),
      crypto: crypto({
        openMany: async ({ candidates }) => {
          calls.push(`crypto:${candidates.map(value => value.memoryId).join(",")}`);
          return success(candidates.map(value => Object.freeze({
            memoryId: value.memoryId,
            contentRevision: value.contentRevision,
            type: "fact",
            content: `protected:${value.memoryId}`,
          })));
        },
      }),
    }, { createReader: () => readPort });

    const result = await repository.search({
      authority,
      query: "ranked memories",
      limit: 3,
      includeArchive: false,
      mode: "vector",
    });

    expect(result.status).toBe("success");
    expect(result.status === "success"
      ? result.value.map(value => value.content)
      : []).toEqual([
        `protected:${MEMORY_A}`,
        `protected:${MEMORY_B}`,
        `ordinary:${MEMORY_C}`,
      ]);
    expect(calls[0]).toBe("mixed-selector");
    expect(calls).not.toContain("protected-selector");
    expect(calls.filter(value => value.startsWith("ordinary:"))).toEqual([
      `ordinary:${MEMORY_C}`,
    ]);
  });

  test.each([
    ["shadow strict", "shadow_encryption", "strict"],
    ["encrypted only", "encrypted_only", "fallback"],
  ] as const)("keeps %s reads off the mixed selector and ordinary loader", async (
    _label,
    mode,
    behavior,
  ) => {
    const calls: string[] = [];
    const selected = candidate();
    const readPort = reader({
      searchProtectedCandidates: async () => {
        calls.push("protected-selector");
        return success([selected]);
      },
      searchCandidates: async () => {
        calls.push("mixed-selector");
        return success([]);
      },
      loadExactProtectedSources: async () => success([selected]),
      loadExactOrdinary: async () => {
        calls.push("ordinary-loader");
        return success([]);
      },
    });
    const repository = createProtectedTaskMemoryRepository({
      ...baseInput(),
      owner: owner(mode, behavior),
      crypto: crypto({
        openMany: async () => success([Object.freeze({
          memoryId: MEMORY_A,
          contentRevision: 1,
          type: "fact",
          content: "protected",
        })]),
      }),
    }, { createReader: () => readPort });

    const result = await repository.search({
      authority,
      query: "protected only",
      limit: 1,
      includeArchive: false,
      mode: "vector",
    });

    expect(result.status).toBe("success");
    expect(calls).toEqual(["protected-selector"]);
  });

  test("hands the exact Task repair revision to Agent save planning", async () => {
    const selection = Object.freeze({
      memoryId: MEMORY_A,
      contentRevision: 1,
      score: 0.9,
      repairRequired: true,
      repair: Object.freeze({
        representation: "structural" as const,
        id: MEMORY_A,
        type: null,
        importance: 0.5,
        tier: 1,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        score: 0.9,
      }),
    });
    let plannedRevision: number | undefined;
    const input = {
      ...baseInput(),
      mutationProduct: mutationProduct({
        selectSaveCandidate: async () => success(selection),
        planSave: async ({ selectedCandidate, mutationCommitment }) => {
          plannedRevision = selectedCandidate?.contentRevision;
          return success(plan({
            operationId: "task-repair-revision",
            action: "updated",
            contentRevision: 3,
            mutationCommitment,
          }));
        },
      }),
      repairExactCandidate: async () => success(Object.freeze({
        memoryId: MEMORY_A,
        contentRevision: 2,
      })),
    };
    const repository = createProtectedTaskMemoryRepository(input, {
      createReader: () => reader(),
    });

    const result = await repository.save({
      operationId: "task-repair-revision",
      authority,
      type: "fact",
      content: "updated",
    });

    expect(result.status).toBe("success");
    expect(plannedRevision).toBe(2);
  });

  test("fails a protected open when its exact current source changes", async () => {
    const selected = candidate();
    let currentnessChecks = 0;
    let cryptoOpens = 0;
    const readPort = reader({
      searchProtectedCandidates: async () => success([selected]),
      loadExactProtectedSources: async () => {
        currentnessChecks += 1;
        return success([currentnessChecks === 1
          ? selected
          : Object.freeze({
              ...selected,
              contentRevision: 2,
              cryptoObjectId: deriveMemoryCryptoObjectIdV1({
                memoryId: MEMORY_A,
                contentRevision: 2,
              }),
            })]);
      },
    });
    const repository = createProtectedTaskMemoryRepository({
      ...baseInput(),
      owner: owner("encrypted_only"),
      crypto: crypto({
        openMany: async () => {
          cryptoOpens += 1;
          return success([Object.freeze({
            memoryId: MEMORY_A,
            contentRevision: 1,
            type: "fact",
            content: "stale after opening",
          })]);
        },
      }),
    }, { createReader: () => readPort });

    const result = await repository.search({
      authority,
      query: "current",
      limit: 1,
      includeArchive: false,
      mode: "vector",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "stale_revision",
    });
    expect({ currentnessChecks, cryptoOpens }).toEqual({
      currentnessChecks: 2,
      cryptoOpens: 1,
    });
  });

  test("revalidates only the replacement source coordinates during prepare", async () => {
    let composed: Parameters<
      typeof createInvocationBoundProtectedAgentMemoryRepository
    >[0] | undefined;
    const source = target();
    const outputPlan = plan({
      action: "updated",
      mutationKind: "replace",
      contentRevision: 2,
      requiredNamespaceIds: Object.freeze([NS_A]),
    });
    let checks = 0;
    const readPort = reader({
      loadExactProtectedSources: async ({ memoryIds }) => {
        checks += 1;
        expect(memoryIds).toEqual([MEMORY_A]);
        return success([candidate()]);
      },
    });
    const input = {
      ...baseInput(),
      crypto: crypto({
        prepare: async ({ plan: value }) => {
          expect(value.requiredNamespaceIds).toEqual([NS_A]);
          return success(prepared(value));
        },
      }),
    };
    createProtectedTaskMemoryRepository(input, {
      createReader: () => readPort,
      createRepository: value => {
        composed = value;
        return {} as ReturnType<
          typeof createInvocationBoundProtectedAgentMemoryRepository
        >;
      },
    });

    const result = await composed!.crypto.prepare({
      entrypointId: "subagent.scope",
      agentId: AGENT,
      authority,
      plan: outputPlan,
      content: {
        kind: "replacement",
        previous: source,
        content: "replacement",
      },
    });

    expect(result.status).toBe("success");
    expect(checks).toBe(2);
  });
});
