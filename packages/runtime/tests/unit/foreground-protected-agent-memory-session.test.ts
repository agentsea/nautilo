import { describe, expect, test } from "bun:test";
import {
  bindEncryptionDataOperationOwner,
  type AgentMemoryEmbedding,
  type AgentMemoryExactAccessPlan,
  type PreparedAgentMemoryExactAccess,
  type PreparedMemoryCryptoRevision,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedAgentMemorySessionContentPort,
  type ProtectedAgentMemoryExactAccessContentPort,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCapabilityDescription,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryCandidate,
  type ProtectedMemoryMutationPlan,
  type ProtectedMemoryMutationTarget,
} from "@nautilo/lattice-bridge";

import {
  createForegroundProtectedAgentMemoryAccessPort,
  createForegroundProtectedAgentMemoryCryptoSession,
  createForegroundProtectedAgentMemoryExactAccessPort,
  createForegroundProtectedAgentMemoryRepository,
} from "../../src/memory/foreground-protected-agent-memory-session.ts";
import type { ForegroundAuthorizationNamespaceSetPort } from "../../src/protected-execution/foreground-authorization-session.ts";
import {
  ForegroundAuthorizationSessionRegistry,
  foregroundAuthorizationChildWorkDescriptorDigest,
} from "../../src/protected-execution/foreground-authorization-session.ts";

function childWorkDigest(childExecutionId: string): Uint8Array {
  return foregroundAuthorizationChildWorkDescriptorDigest({
    parentInvocationId: "parent-memory-invocation",
    childExecutionId,
  });
}

const NOW = 1_820_000_000_000;
const NAMESPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NAMESPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NAMESPACE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";

function authority(): ProtectedMemoryAuthority {
  return Object.freeze({
    mode: "namespace" as const,
    subjectUserId: "alice",
    agentId: "genie",
    readableNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
    mutableNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
    writableNamespaceId: NAMESPACE_A,
  });
}

function candidate(
  namespaceIds: readonly string[] = [NAMESPACE_A, NAMESPACE_B],
): ProtectedMemoryCandidate {
  return Object.freeze({
    memoryId: MEMORY_ID,
    contentRevision: 1,
    cryptoAccessRevision: 0,
    expectedPriorAccessRevision: 0,
    cryptoObjectId: "memory:v1:candidate",
    readNamespaceId: NAMESPACE_A,
    requiredNamespaceIds: Object.freeze([...namespaceIds]),
    importance: 1,
    tier: 1,
    score: 0.8,
    createdAt: new Date(NOW),
  });
}

function target(
  namespaceIds: readonly string[] = [NAMESPACE_A, NAMESPACE_B],
): ProtectedMemoryMutationTarget {
  return Object.freeze({
    memoryId: MEMORY_ID,
    contentRevision: 2,
    cryptoAccessRevision: 0,
    cryptoObjectId: "memory:v1:target",
    requiredNamespaceIds: Object.freeze([...namespaceIds]),
  });
}

function plan(
  namespaceIds: readonly string[] = [NAMESPACE_A, NAMESPACE_B],
): ProtectedMemoryMutationPlan {
  return Object.freeze({
    operationId: "memory-plan",
    action: "updated" as const,
    mutationKind: "replace" as const,
    memoryId: MEMORY_ID,
    contentRevision: 2,
    cryptoAccessRevision: 0,
    expectedPriorAccessRevision: 0,
    cryptoObjectId: "memory:v1:target",
    requiredNamespaceIds: Object.freeze([...namespaceIds]),
    reservationDigest: new Uint8Array(32),
    mutationCommitment: new Uint8Array(32),
    importance: 0.6,
    createdAt: NOW,
  });
}

function fixture(options: Readonly<{ deny?: boolean }> = {}) {
  let now = NOW;
  const capability = Object.freeze({
    invocationId: "memory-invocation",
    expiresAt: NOW + 60_000,
  }) as ProtectedInvocationCapability;
  const description: ProtectedInvocationCapabilityDescription = Object.freeze({
    invocationId: "memory-invocation",
    grantId: "memory-grant",
    expiresAt: NOW + 60_000,
    issuedAt: NOW,
    issuingHumanId: "alice",
    issuingDeviceId: "alice-device",
    recipientAgentId: "genie",
    recipientKeyId: "genie-memory-key",
    namespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
    domainIds: Object.freeze(["domain-a", "domain-b"]),
  });
  const destroyed: ProtectedInvocationCapability[] = [];
  const genericExecutions: Array<Readonly<{
    operation: "decrypt" | "encrypt";
    namespaceIds: readonly string[];
    domainIds: readonly string[];
  }>> = [];
  const lowLevelCalls: Array<Readonly<{
    kind: "open" | "prepare" | "commit";
    value: unknown;
  }>> = [];
  const prepared = Object.freeze({
    memoryId: MEMORY_ID,
    contentRevision: 2,
    objectId: "memory:v1:target",
    objectType: "nautilo-memory-v1",
    payloadVersion: 1,
    requiredNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
  }) as PreparedMemoryCryptoRevision;
  const contentPort: ProtectedAgentMemorySessionContentPort = {
    async openMany(input) {
      genericExecutions.push(Object.freeze({
        operation: input.operation,
        namespaceIds: Object.freeze([...input.requestedNamespaceIds]),
        domainIds: Object.freeze([...input.allowedDomainIds]),
      }));
      if (options.deny === true) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      lowLevelCalls.push(Object.freeze({ kind: "open", value: input }));
      return Object.freeze({
        status: "executed" as const,
        value: Object.freeze({
          status: "success" as const,
          value: input.candidates.map((entry) => Object.freeze({
            memoryId: entry.memoryId,
            contentRevision: entry.contentRevision,
            type: "confidential-type",
            content: "opened content",
          })),
        }),
      });
    },
    async prepare(input) {
      genericExecutions.push(Object.freeze({
        operation: input.operation,
        namespaceIds: Object.freeze([...input.requestedNamespaceIds]),
        domainIds: Object.freeze([...input.allowedDomainIds]),
      }));
      if (options.deny === true) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      lowLevelCalls.push(Object.freeze({ kind: "prepare", value: input }));
      return Object.freeze({
        status: "executed" as const,
        value: Object.freeze({
          status: "success" as const,
          value: prepared,
        }),
      });
    },
    async authorizeCommit(input) {
      genericExecutions.push(Object.freeze({
        operation: input.operation,
        namespaceIds: Object.freeze([...input.requestedNamespaceIds]),
        domainIds: Object.freeze([...input.allowedDomainIds]),
      }));
      if (options.deny === true) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      lowLevelCalls.push(Object.freeze({ kind: "commit", value: input }));
      return Object.freeze({
        status: "executed" as const,
        value: Object.freeze({
          status: "success" as const,
          value: await input.commit(),
        }),
      });
    },
  };
  const registry = new ForegroundAuthorizationSessionRegistry({
    startSweep: false,
    now: () => now,
    createSessionId: () => "memory-session",
    createViewId: (() => {
      let next = 0;
      return () => `memory-view-${next++}`;
    })(),
    createLeaseId: (() => {
      let next = 0;
      return () => `memory-lease-${next++}`;
    })(),
    capabilityPort: {
      inspect: (value) => value === capability ? description : null,
      destroy: (value) => destroyed.push(value),
    },
    contentPort: {
      execute: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "content_unavailable" as const,
      }),
    },
  });
  const registered = registry.register({
    capability,
    authenticatedBinding: {
      humanId: "alice",
      issuingDeviceId: "alice-device",
      recipientAgentId: "genie",
    },
    allowedOperations: Object.freeze(["decrypt", "encrypt"]),
  });
  if (registered.status !== "registered") throw new Error("fixture failed");
  const session = createForegroundProtectedAgentMemoryCryptoSession({
    registry,
    view: registered.rootView,
    contentPort,
  });
  return {
    registry,
    rootView: registered.rootView,
    session,
    contentPort,
    genericExecutions,
    lowLevelCalls,
    destroyed,
    setNow(value: number) {
      now = value;
    },
  };
}

function open(
  session: ProtectedAgentMemoryCryptoSessionPort,
  candidates: readonly ProtectedMemoryCandidate[] = [candidate()],
  signal?: AbortSignal,
) {
  return session.openMany({
    entrypointId: "foreground.main",
    agentId: "genie",
    authority: authority(),
    candidates,
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("foreground protected Agent Memory crypto session", () => {
  test("revalidates injected foreground tool callbacks at each exact Namespace operation", async () => {
    const state = fixture();
    const executions: Array<Readonly<{
      operation: "decrypt" | "encrypt";
      namespaceIds: readonly string[];
    }>> = [];
    const contentPort: ForegroundAuthorizationNamespaceSetPort = {
      execute: async (input) => {
        executions.push({
          operation: input.operation,
          namespaceIds: [...input.namespaceIds],
        });
        return { status: "executed", value: await input.execute() };
      },
    };
    const access = createForegroundProtectedAgentMemoryAccessPort({
      registry: state.registry,
      view: state.rootView,
      entrypointId: "foreground.main",
      contentPort,
      prepareApproval: async (request) => ({ status: "success", value: {
        reference: { referenceVersion: 1, referenceId: "ref-1",
          toolCallId: request.toolCallId,
          requesterUserId: request.authority.subjectUserId,
          agentId: request.authority.agentId },
        preview: { type: "fact", content: "private" },
      } }),
      change: async (request, revalidate) => revalidate.run({
        operation: "decrypt",
        namespaceIds: [NAMESPACE_A, NAMESPACE_B],
        execute: async () => revalidate.run({
          operation: "encrypt",
          namespaceIds: [NAMESPACE_A, NAMESPACE_B],
          execute: async () => ({
            status: "success",
            value: { status: "updated", memoryId: request.memoryId },
          }),
        }),
      }),
    });
    await access.prepareApproval!({ operationId: "approval-1", toolCallId: "tool-1",
      authority: authority(), memoryId: MEMORY_ID,
      action: { kind: "grant_user", userHandle: "bob" } });
    expect(await access.change({
      operationId: "access-1",
      authority: authority(),
      memoryId: MEMORY_ID,
      action: { kind: "grant_user", userHandle: "bob" },
    })).toEqual({
      status: "success",
      value: { status: "updated", memoryId: MEMORY_ID },
    });
    expect(executions).toEqual([
      { operation: "decrypt", namespaceIds: [NAMESPACE_A, NAMESPACE_B] },
      { operation: "encrypt", namespaceIds: [NAMESPACE_A, NAMESPACE_B] },
    ]);
    expect(await access.change({
      operationId: "access-wrong-approved-action",
      authority: authority(),
      memoryId: MEMORY_ID,
      action: { kind: "grant_user", userHandle: "mallory" },
    })).toEqual({ status: "unavailable", reason: "authorization_required" });

    const narrowed = createForegroundProtectedAgentMemoryAccessPort({
      registry: state.registry,
      view: state.rootView,
      entrypointId: "foreground.main",
      contentPort,
      prepareApproval: async (request) => ({ status: "success", value: {
        reference: { referenceVersion: 1, referenceId: "ref-2",
          toolCallId: request.toolCallId,
          requesterUserId: request.authority.subjectUserId,
          agentId: request.authority.agentId },
        preview: { type: "fact", content: "private" },
      } }),
      change: async (_request, revalidate) => revalidate.run({
        operation: "encrypt",
        namespaceIds: [NAMESPACE_C],
        execute: async () => {
          throw new Error("widened callback executed");
        },
      }),
    });
    await narrowed.prepareApproval!({ operationId: "approval-2", toolCallId: "tool-2",
      authority: authority(), memoryId: MEMORY_ID,
      action: { kind: "grant_user", userHandle: "charlie" } });
    expect(await narrowed.change({
      operationId: "access-2",
      authority: authority(),
      memoryId: MEMORY_ID,
      action: { kind: "grant_user", userHandle: "charlie" },
    })).toEqual({
      status: "unavailable",
      reason: "incomplete_access_set",
    });
  });

  test("leases retained source decrypt plus added target encrypt authority twice", async () => {
    const state = fixture();
    const exactPlan: AgentMemoryExactAccessPlan = Object.freeze({
      operationId: "access-mixed-1",
      memoryId: MEMORY_ID,
      cryptoObjectId: "memory:v1:exact",
      expectedContentRevision: 1,
      expectedCryptoAccessRevision: 2,
      nextCryptoAccessRevision: 3,
      anchorNamespaceId: NAMESPACE_A,
      currentNamespaceIds: Object.freeze([NAMESPACE_A]),
      targetNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
      addedNamespaceIds: Object.freeze([NAMESPACE_B]),
      removedNamespaceIds: Object.freeze([]),
      currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x11),
      targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x22),
      currentBindings: Object.freeze([]),
      targetBindings: Object.freeze([]),
      productMutation: Object.freeze({
        kind: "grant_namespace" as const,
        namespaceId: NAMESPACE_B,
      }),
    });
    const prepared = Object.freeze({}) as PreparedAgentMemoryExactAccess;
    const calls: string[] = [];
    const contentPort: ProtectedAgentMemoryExactAccessContentPort = {
      prepare: async (input) => {
        calls.push(
          `prepare:${input.plan.operationId}:${input.requestedNamespaceIds.join(",")}`,
        );
        return {
          status: "executed",
          value: { status: "success", value: prepared },
        };
      },
      authorizeCommit: async (input) => {
        calls.push(
          `commit:${input.plan.operationId}:${input.requestedNamespaceIds.join(",")}`,
        );
        return { status: "executed", value: await input.commit() };
      },
    };
    const access = createForegroundProtectedAgentMemoryExactAccessPort({
      registry: state.registry,
      view: state.rootView,
      entrypointId: "foreground.main",
      contentPort: {
        execute: async () => ({
          status: "unavailable",
          reason: "content_unavailable",
        }),
      },
      exactAccessContentPort: contentPort,
      agentId: "genie",
      plan: async () => ({
        status: "success",
        value: { status: "prepared", sourceNamespaceId: NAMESPACE_A, plan: exactPlan },
      }),
      commit: async ({ request }) => ({
        status: "success",
        value: { status: "updated", memoryId: request.memoryId },
      }),
    });
    expect(await access.change({
      operationId: exactPlan.operationId,
      authority: authority(),
      memoryId: MEMORY_ID,
      action: { kind: "grant_user", userHandle: "bob" },
    })).toEqual({
      status: "success",
      value: { status: "updated", memoryId: MEMORY_ID },
    });
    expect(calls).toEqual([
      `prepare:access-mixed-1:${NAMESPACE_A},${NAMESPACE_B}`,
      `commit:access-mixed-1:${NAMESPACE_A},${NAMESPACE_B}`,
    ]);
    expect(state.registry.liveOperationCount).toBe(0);

    const child = state.registry.createChildView({
      parent: state.rootView,
      namespaceIds: [NAMESPACE_A, NAMESPACE_B],
      domainIds: ["domain-a", "domain-b"],
      operations: ["encrypt"],
      workDescriptorDigest: childWorkDigest("write-child"),
    });
    if (child.status !== "created") throw new Error("child unavailable");
    const narrowed = createForegroundProtectedAgentMemoryExactAccessPort({
      registry: state.registry,
      view: child.view,
      entrypointId: "foreground.main",
      contentPort: {
        execute: async () => ({
          status: "unavailable",
          reason: "content_unavailable",
        }),
      },
      exactAccessContentPort: contentPort,
      agentId: "genie",
      plan: async () => ({
        status: "success",
        value: { status: "prepared", sourceNamespaceId: NAMESPACE_A, plan: exactPlan },
      }),
      commit: async () => {
        throw new Error("narrowed exact access committed");
      },
    });
    expect(await narrowed.change({
      operationId: "access-mixed-2",
      authority: authority(),
      memoryId: MEMORY_ID,
      action: { kind: "grant_user", userHandle: "bob" },
    })).toEqual({
      status: "unavailable",
      reason: "incomplete_access_set",
    });
  });

  test("composes an invocation-bound repository without exposing its capability", async () => {
    const state = fixture();
    const embedded: AgentMemoryEmbedding = Object.freeze({
      vector: Object.freeze(new Array<number>(1536).fill(0.25)),
      provider: "openai",
      canonicalModel: "text-embedding-3-small",
      dimensions: 1536,
      contractVersion: 1,
    });
    const repository = createForegroundProtectedAgentMemoryRepository({
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({ policy: { mode: "shadow_encryption",
          shadowBehavior: "fallback" }, revalidationToken: 1 }),
        revalidate: async () => {},
      } }),
      repairExactCandidate: async () => ({ status: "success", value: undefined }),
      fallbackOrdinary: async ({ reason }) => ({ status: "unavailable", reason }),
      registry: state.registry,
      view: state.rootView,
      contentPort: state.contentPort,
      subjectUserId: "alice",
      agentId: "genie",
      entrypointId: "foreground.main",
      embedding: { embed: async () => ({ status: "success", value: embedded }) },
      product: {
        selectSaveCandidate: async () => ({ status: "success", value: null }),
        replayCompleted: async () => ({ status: "success", value: null }),
        searchCandidates: async () => ({ status: "success", value: [] }),
        planSave: async () => ({ status: "unavailable", reason: "stale_revision" }),
        planReplace: async () => ({ status: "unavailable", reason: "stale_revision" }),
        publishPrepared: async () => "stale",
        resolveTierTarget: async () => ({ status: "unavailable", reason: "stale_revision" }),
        commitTier: async () => "stale",
      },
    });

    expect(await repository.search({
      authority: authority(),
      query: "bounded query",
      limit: 2,
      includeArchive: false,
      mode: "vector",
    })).toEqual({ status: "success", value: [] });
    expect(Object.keys(repository).sort()).toEqual([
      "replace",
      "save",
      "search",
      "setTier",
    ]);
  });

  test("leases and revalidates every open, prepare, and fresh commit", async () => {
    const state = fixture();
    expect("execute" in state.contentPort).toBeFalse();
    expect((await open(state.session)).status).toBe("success");
    const prepared = await state.session.prepare({
      entrypointId: "foreground.main",
      agentId: "genie",
      authority: authority(),
      plan: plan(),
      content: Object.freeze({
        kind: "complete" as const,
        payload: Object.freeze({
          formatVersion: 1 as const,
          type: "preference",
          content: "explicit new content",
        }),
      }),
    });
    expect(prepared.status).toBe("success");
    let commits = 0;
    const committed = await state.session.authorizeCommit({
      entrypointId: "foreground.main",
      agentId: "genie",
      authority: authority(),
      target: target(),
      operation: "publish",
      commit: () => ++commits,
    });
    expect(committed).toEqual({ status: "success", value: 1 });
    expect(commits).toBe(1);
    expect(state.genericExecutions).toEqual([
      { operation: "decrypt", namespaceIds: [NAMESPACE_A], domainIds: ["domain-a", "domain-b"] },
      { operation: "encrypt", namespaceIds: [NAMESPACE_A, NAMESPACE_B], domainIds: ["domain-a", "domain-b"] },
      { operation: "encrypt", namespaceIds: [NAMESPACE_A, NAMESPACE_B], domainIds: ["domain-a", "domain-b"] },
    ]);
    expect(state.registry.liveOperationCount).toBe(0);
  });

  test("leases selected read keys and rejects missing or noncanonical inputs", async () => {
    const state = fixture();
    expect((await open(state.session, [
      candidate([NAMESPACE_A]),
      Object.freeze({
        ...candidate([NAMESPACE_B]),
        memoryId: "22222222-2222-4222-8222-222222222222",
        readNamespaceId: NAMESPACE_B,
      }),
    ])).status).toBe("success");
    expect(state.genericExecutions[0]?.namespaceIds).toEqual([
      NAMESPACE_A,
      NAMESPACE_B,
    ]);
    expect((await open(
      state.session,
      [candidate([NAMESPACE_A, NAMESPACE_C])],
    )).status).toBe("success");
    expect(await open(state.session, [candidate([NAMESPACE_B])]))
      .toEqual({ status: "unavailable", reason: "incomplete_access_set" });
    expect(await open(state.session, [candidate([NAMESPACE_B, NAMESPACE_A])]))
      .toEqual({ status: "unavailable", reason: "incomplete_access_set" });
    expect(state.lowLevelCalls).toHaveLength(2);
  });

  test("cannot widen a child view and maps expiry, revocation, and cancellation", async () => {
    const childState = fixture();
    const child = childState.registry.createChildView({
      parent: childState.rootView,
      namespaceIds: Object.freeze([NAMESPACE_A]),
      domainIds: Object.freeze(["domain-a"]),
      operations: Object.freeze(["decrypt", "encrypt"]),
      workDescriptorDigest: childWorkDigest("lifecycle-child"),
    });
    if (child.status !== "created") throw new Error("child unavailable");
    const childSession = createForegroundProtectedAgentMemoryCryptoSession({
      registry: childState.registry,
      view: child.view,
      contentPort: childState.contentPort,
    });
    expect((await open(childSession)).status).toBe("success");
    expect(await open(childSession, [Object.freeze({
      ...candidate(),
      readNamespaceId: NAMESPACE_B,
    })])).toEqual({
      status: "unavailable",
      reason: "incomplete_access_set",
    });

    const expired = fixture();
    expired.setNow(NOW + 60_000);
    expect(await open(expired.session)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });

    const revoked = fixture({ deny: true });
    expect(await open(revoked.session)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    let unauthorizedCommits = 0;
    expect(await revoked.session.authorizeCommit({
      entrypointId: "foreground.main",
      agentId: "genie",
      authority: authority(),
      target: target(),
      operation: "publish",
      commit: () => ++unauthorizedCommits,
    })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(unauthorizedCommits).toBe(0);

    const cancelled = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await open(cancelled.session, [candidate()], controller.signal))
      .toEqual({
        status: "unavailable",
        reason: "authorization_required",
      });
  });

  test("opens canonically retained seed Memories in scope mode", async () => {
    const state = fixture();
    const scopeAuthority: ProtectedMemoryAuthority = Object.freeze({
      mode: "scope",
      subjectUserId: "alice",
      agentId: "genie",
      scopeId: "task-scope",
      originWritableNamespaceId: NAMESPACE_C,
    });
    const result = await state.session.openMany({
      entrypointId: "foreground.main",
      agentId: "genie",
      authority: scopeAuthority,
      candidates: [candidate([NAMESPACE_A, NAMESPACE_B])],
    });
    expect(result.status).toBe("success");
    expect(state.genericExecutions[0]?.namespaceIds).toEqual([NAMESPACE_A]);
  });

  test("passes replacement content without inventing or retaining its confidential type", async () => {
    const state = fixture();
    const changedSetPrevious = Object.freeze({
      ...target([NAMESPACE_A]),
      contentRevision: 1,
      cryptoObjectId: "memory:v1:previous",
    });
    expect(await state.session.prepare({
      entrypointId: "foreground.main",
      agentId: "genie",
      authority: authority(),
      plan: plan([NAMESPACE_B]),
      content: Object.freeze({
        kind: "replacement" as const,
        previous: changedSetPrevious,
        content: "must not cross Namespace sets",
      }),
    })).toEqual({
      status: "unavailable",
      reason: "incomplete_access_set",
    });
    expect(state.lowLevelCalls).toHaveLength(0);
    const previous = Object.freeze({
      ...target([NAMESPACE_A, NAMESPACE_B]),
      contentRevision: 1,
      cryptoObjectId: "memory:v1:previous",
    });
    const result = await state.session.prepare({
      entrypointId: "foreground.main",
      agentId: "genie",
      authority: authority(),
      plan: plan([NAMESPACE_A, NAMESPACE_B]),
      content: Object.freeze({
        kind: "replacement" as const,
        previous,
        content: "explicit replacement content",
      }),
    });
    expect(result.status).toBe("success");
    expect(state.genericExecutions[0]?.namespaceIds).toEqual([
      NAMESPACE_A,
      NAMESPACE_B,
    ]);
    const observed = state.lowLevelCalls[0]?.value as Parameters<
      ProtectedAgentMemoryCryptoSessionPort["prepare"]
    >[0];
    expect(observed.content).toEqual({
      kind: "replacement",
      previous,
      content: "explicit replacement content",
    });
    expect("type" in observed.content).toBeFalse();
  });
});
