import { describe, expect, test } from "bun:test";

import {
  EncryptedCheckpointSaver,
  type CreateEncryptedCheckpointSaverOptions,
} from "@nautilo/agent";
import {
  ProtectedCheckpointCryptoError,
  type ProtectedCheckpointNamespaceSessionContentExecutor,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCapabilityDescription,
} from "@nautilo/lattice-bridge";

import {
  createProtectedTestCheckpointSaverProvider,
} from "../../src/conversation/protected-checkpoint-saver-provider";
import {
  createProtectedTestShadowAuthorityForTests,
} from "../../src/conversation/testing/protected-test-shadow-authority";
import {
  ForegroundAuthorizationSessionRegistry,
  foregroundAuthorizationChildWorkDescriptorDigest,
  type ForegroundAuthorizationContentPort,
} from "../../src/protected-execution/foreground-authorization-session";
import type {
  ProtectedInvocationCapabilityPort,
} from "../../src/protected-execution/lease-registry";

type DedicatedPool =
  CreateEncryptedCheckpointSaverOptions["dedicatedPool"];

class CapturingClient {
  readonly queries: Array<{ text: string; params?: unknown[] }> = [];
  releaseCalls = 0;
  queryError: Error | undefined;
  queryErrorPattern: RegExp | undefined;

  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push({
      text,
      ...(params === undefined ? {} : { params }),
    });
    if (
      this.queryError !== undefined
      && this.queryErrorPattern?.test(text)
    ) {
      return Promise.reject(this.queryError);
    }
    return Promise.resolve({ rows: [] });
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

class CapturingPool {
  readonly client = new CapturingClient();
  connectCalls = 0;
  endCalls = 0;

  connect(): Promise<CapturingClient> {
    this.connectCalls += 1;
    return Promise.resolve(this.client);
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return Promise.resolve();
  }
}

function fakeCrypto() {
  return {
    deriveKey: (
      input: Uint8Array,
      _label: string,
      length = 32,
    ) => Uint8Array.from({ length }, (_, index) =>
      input[index % input.length] ?? 0
    ),
    aeadSeal: (
      _key: Uint8Array,
      plaintext: Uint8Array,
      _aad?: Uint8Array,
    ) => {
      const sealed = new Uint8Array(plaintext.length + 1);
      sealed[0] = 0xa5;
      sealed.set(plaintext, 1);
      return sealed;
    },
    aeadOpen: (
      _key: Uint8Array,
      ciphertext: Uint8Array,
      _aad?: Uint8Array,
    ) => ciphertext[0] === 0xa5 ? ciphertext.slice(1) : null,
  };
}

function fixture() {
  const description: ProtectedInvocationCapabilityDescription = Object.freeze({
    invocationId: "invocation-checkpoint",
    grantId: "grant-checkpoint",
    issuedAt: 1_000,
    expiresAt: 1_000_000,
    issuingHumanId: "human-a",
    issuingDeviceId: "device-a",
    recipientAgentId: "agent-a",
    recipientKeyId: "recipient-a",
    namespaceIds: Object.freeze(["namespace-a"]),
    domainIds: Object.freeze(["domain-a"]),
  });
  const capability = Object.freeze({
    invocationId: description.invocationId,
    expiresAt: description.expiresAt,
  }) as ProtectedInvocationCapability;
  const capabilities = new WeakSet<object>([capability]);
  const capabilityPort: ProtectedInvocationCapabilityPort = {
    inspect: (value) => capabilities.has(value) ? description : null,
    destroy: (value) => {
      capabilities.delete(value);
    },
  };
  const unusedRuntimeContentPort: ForegroundAuthorizationContentPort = {
    execute: () => Promise.resolve({
      status: "unavailable",
      reason: "content_unavailable",
    }),
  };
  const observed: unknown[] = [];
  const namespaceContentPort:
    ProtectedCheckpointNamespaceSessionContentExecutor = {
      execute: async (request) => {
        observed.push({
          entrypointId: request.entrypointId,
          operation: request.operation,
          namespaceId: request.namespaceId,
          domainId: request.domainId,
          expectedAccessRevision: request.expectedAccessRevision,
          expectedPolicyRevision: request.expectedPolicyRevision,
        });
        const key = new Uint8Array(32).fill(0x42);
        try {
          return {
            status: "executed",
            value: await request.execute(
              {
                namespaceId: request.namespaceId,
                domainId: request.domainId,
                accessRevision: request.expectedAccessRevision,
                agentAuthorizationRevision:
                  request.expectedPolicyRevision,
                currentGeneration: 2,
                generations: Object.freeze([
                  Object.freeze({ generation: 2, key }),
                ]),
              },
              () => Promise.resolve(),
            ),
          };
        } finally {
          key.fill(0);
        }
      },
    };
  let leaseId = 0;
  let viewId = 0;
  const registry = new ForegroundAuthorizationSessionRegistry({
    capabilityPort,
    contentPort: unusedRuntimeContentPort,
    now: () => 2_000,
    createSessionId: () => "session-checkpoint",
    createViewId: () => `view-checkpoint-${++viewId}`,
    createLeaseId: () => `lease-${++leaseId}`,
    startSweep: false,
  });
  const registered = registry.register({
    capability,
    authenticatedBinding: {
      humanId: "human-a",
      issuingDeviceId: "device-a",
      recipientAgentId: "agent-a",
    },
    allowedOperations: ["decrypt", "encrypt"],
  });
  if (registered.status !== "registered") {
    throw new Error(registered.reason);
  }
  return {
    authorization: registered.rootView,
    namespaceContentPort,
    observed,
    registry,
  };
}

describe("protected checkpoint saver provider", () => {
  test("is non-production-only and lazily owns one saver/pool per invocation", async () => {
    const state = fixture();
    let pools = 0;
    const provider = createProtectedTestCheckpointSaverProvider({
      authority: createProtectedTestShadowAuthorityForTests(),
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: state.namespaceContentPort,
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () => {
        pools += 1;
        return new CapturingPool() as unknown as DedicatedPool;
      },
    });

    const first = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a",
      kind: "foreground.main",
      authorization: state.authorization,
    });
    const second = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a:fork:b",
      kind: "foreground.fork",
      authorization: state.authorization,
    });
    expect(first).toBeInstanceOf(EncryptedCheckpointSaver);
    expect(second).toBeInstanceOf(EncryptedCheckpointSaver);
    expect(second).not.toBe(first);
    expect(pools).toBe(0);
    await first.end();
    await second.end();
    expect(pools).toBe(0);

    expect(() => createProtectedTestCheckpointSaverProvider({
      authority: Object.freeze({}) as never,
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: state.namespaceContentPort,
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () => ({} as DedicatedPool),
    })).toThrow("recognized test authority");
  });

  test("routes the exact lease through the bridge Namespace port", async () => {
    const state = fixture();
    const leased = state.registry.leaseOperation({
      view: state.authorization,
      entrypointId: "foreground.main",
      operation: "encrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
    });
    if (leased.status !== "leased") throw new Error(leased.reason);

    let observedKey = -1;
    const result = await state.registry.executeCheckpointNamespace(
      leased.lease,
      {
        contentPort: state.namespaceContentPort,
        expectedAccessRevision: 5,
        expectedPolicyRevision: 8,
        execute: (material, context) => {
          context.assertActive();
          expect(context.remainingMs()).toBeGreaterThan(0);
          observedKey = material.generations[0]?.key[0] ?? -1;
          return "ok";
        },
      },
    );

    expect(result).toEqual({ status: "executed", value: "ok" });
    expect(observedKey).toBe(0x42);
    expect(state.registry.liveOperationCount).toBe(0);
    expect(state.observed).toEqual([{
      entrypointId: "foreground.main",
      operation: "encrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
    }]);
  });

  test("runs reserved pending writes through saver, provider, registry, and Namespace authority", async () => {
    const state = fixture();
    const pool = new CapturingPool();
    const provider = createProtectedTestCheckpointSaverProvider({
      authority: createProtectedTestShadowAuthorityForTests(),
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: state.namespaceContentPort,
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () => pool as unknown as DedicatedPool,
    });
    const saver = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a",
      kind: "foreground.main",
      authorization: state.authorization,
    });

    await saver.putWrites(
      {
        configurable: {
          thread_id: "room:a:bot:a",
          checkpoint_ns: "foreground",
          checkpoint_id: "checkpoint-1",
        },
      },
      [
        ["__error__", { private: "error" }],
        ["__scheduled__", { private: "scheduled" }],
        ["__interrupt__", { private: "interrupt" }],
        ["__resume__", { private: "resume" }],
      ],
      "task-1",
    );

    expect(pool.connectCalls).toBe(1);
    expect(pool.client.releaseCalls).toBe(1);
    const commands = pool.client.queries.map(({ text }) =>
      text.trim().toUpperCase()
    );
    expect(commands).toContain("BEGIN");
    expect(commands).toContain("COMMIT");
    expect(commands).not.toContain("ROLLBACK");
    expect(pool.client.queries.some(({ text }) =>
      text.includes("checkpoint_writes")
    )).toBeTrue();
    const parameters = pool.client.queries.flatMap(({ params }) => params ?? []);
    for (
      const channel of [
        "__error__",
        "__scheduled__",
        "__interrupt__",
        "__resume__",
      ]
    ) {
      expect(parameters).toContain(channel);
    }
    expect(state.observed).toEqual([{
      entrypointId: "foreground.main",
      operation: "encrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
    }]);

    await saver.end();
    expect(pool.endCalls).toBe(1);
  });

  test("binds a saver to its exact child authorization view", async () => {
    const state = fixture();
    const child = state.registry.createChildView({
      parent: state.authorization,
      namespaceIds: ["namespace-a"],
      domainIds: ["domain-a"],
      operations: ["encrypt"],
      workDescriptorDigest: foregroundAuthorizationChildWorkDescriptorDigest({
        parentInvocationId: "parent-checkpoint-invocation",
        childExecutionId: "child-checkpoint-execution",
      }),
    });
    if (child.status !== "created") throw new Error(child.reason);
    const provider = createProtectedTestCheckpointSaverProvider({
      authority: createProtectedTestShadowAuthorityForTests(),
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: state.namespaceContentPort,
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () =>
        new CapturingPool() as unknown as DedicatedPool,
    });
    const rootSaver = provider.createForInvocation({
      logicalThreadId: "room:a:bot:root",
      kind: "foreground.main",
      authorization: state.authorization,
    });
    const childSaver = provider.createForInvocation({
      logicalThreadId: "room:a:bot:child",
      kind: "subagent.scope",
      authorization: child.view,
    });
    expect(state.registry.releaseView(child.view)).toBeTrue();

    expect(childSaver.putWrites(
      {
        configurable: {
          thread_id: "room:a:bot:child",
          checkpoint_ns: "foreground",
          checkpoint_id: "checkpoint-child",
        },
      },
      [["messages", "child-private"]],
      "task-child",
    )).rejects.toThrow("view_unavailable");
    await rootSaver.putWrites(
      {
        configurable: {
          thread_id: "room:a:bot:root",
          checkpoint_ns: "foreground",
          checkpoint_id: "checkpoint-root",
        },
      },
      [["messages", "root-private"]],
      "task-root",
    );
    await childSaver.end();
    await rootSaver.end();
  });

  test("maps raw Namespace content-port rejection to typed content_unavailable with its cause", async () => {
    const state = fixture();
    const storageFailure = new Error("Namespace storage unavailable");
    let pools = 0;
    const provider = createProtectedTestCheckpointSaverProvider({
      authority: createProtectedTestShadowAuthorityForTests(),
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: {
        execute: () => Promise.reject(storageFailure),
      },
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () => {
        pools += 1;
        return new CapturingPool() as unknown as DedicatedPool;
      },
    });
    const saver = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a",
      kind: "foreground.main",
      authorization: state.authorization,
    });
    try {
      await saver.putWrites(
        {
          configurable: {
            thread_id: "room:a:bot:a",
            checkpoint_ns: "foreground",
            checkpoint_id: "checkpoint-a",
          },
        },
        [["messages", "private"]],
        "task-a",
      );
      throw new Error("expected Namespace storage failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtectedCheckpointCryptoError);
      expect((error as ProtectedCheckpointCryptoError).code).toBe(
        "content_unavailable",
      );
      expect((error as Error).cause).toBe(storageFailure);
    }
    expect(pools).toBe(0);
    await saver.end();
  });

  test("preserves an already-typed Namespace content failure unchanged", async () => {
    const state = fixture();
    const typedFailure = new ProtectedCheckpointCryptoError(
      "authorization_unavailable",
      "typed authority failure",
    );
    const provider = createProtectedTestCheckpointSaverProvider({
      authority: createProtectedTestShadowAuthorityForTests(),
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: {
        execute: () => Promise.reject(typedFailure),
      },
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () =>
        new CapturingPool() as unknown as DedicatedPool,
    });
    const saver = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a",
      kind: "foreground.main",
      authorization: state.authorization,
    });

    try {
      await saver.putWrites(
        {
          configurable: {
            thread_id: "room:a:bot:a",
            checkpoint_ns: "foreground",
            checkpoint_id: "checkpoint-a",
          },
        },
        [["messages", "private"]],
        "task-a",
      );
      throw new Error("expected typed Namespace failure");
    } catch (error) {
      expect(error).toBe(typedFailure);
    }
    await saver.end();
  });

  test("preserves checkpoint callback/storage failure unchanged", async () => {
    const state = fixture();
    const pool = new CapturingPool();
    const callbackFailure = new Error("checkpoint INSERT failed");
    pool.client.queryError = callbackFailure;
    pool.client.queryErrorPattern = /checkpoint_writes/i;
    const provider = createProtectedTestCheckpointSaverProvider({
      authority: createProtectedTestShadowAuthorityForTests(),
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: state.namespaceContentPort,
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () => pool as unknown as DedicatedPool,
    });
    const saver = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a",
      kind: "foreground.main",
      authorization: state.authorization,
    });

    try {
      await saver.putWrites(
        {
          configurable: {
            thread_id: "room:a:bot:a",
            checkpoint_ns: "foreground",
            checkpoint_id: "checkpoint-a",
          },
        },
        [["messages", "private"]],
        "task-a",
      );
      throw new Error("expected callback failure");
    } catch (error) {
      expect(error).toBe(callbackFailure);
    }
    await saver.end();
  });

  test("rejects pool reuse across invocation-owned savers", async () => {
    const state = fixture();
    const sharedPool = new CapturingPool() as unknown as DedicatedPool;
    const provider = createProtectedTestCheckpointSaverProvider({
      authority: createProtectedTestShadowAuthorityForTests(),
      crypto: fakeCrypto() as never,
      registry: state.registry,
      namespaceContentPort: state.namespaceContentPort,
      namespaceId: "namespace-a",
      domainId: "domain-a",
      expectedAccessRevision: 5,
      expectedPolicyRevision: 8,
      createDedicatedPool: () => sharedPool,
    });
    const first = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a",
      kind: "foreground.main",
      authorization: state.authorization,
    });
    const second = provider.createForInvocation({
      logicalThreadId: "room:a:bot:a:fork:b",
      kind: "foreground.fork",
      authorization: state.authorization,
    });
    const pendingWrites = [["messages", "private"]] as [string, unknown][];
    await first.putWrites({
      configurable: {
        thread_id: "room:a:bot:a",
        checkpoint_ns: "foreground",
        checkpoint_id: "checkpoint-a",
      },
    }, pendingWrites, "task-a");
    expect(second.putWrites({
      configurable: {
        thread_id: "room:a:bot:a:fork:b",
        checkpoint_ns: "foreground",
        checkpoint_id: "checkpoint-b",
      },
    }, pendingWrites, "task-b")).rejects.toThrow("fresh dedicated pool");
    await second.end();
    await first.end();
  });
});
