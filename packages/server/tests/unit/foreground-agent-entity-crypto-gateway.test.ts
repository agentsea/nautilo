import { describe, expect, test } from "bun:test";
import {
  authorizationRevision,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  createDomainCompressedLiveShadowSessionCapability,
  type AgentLiveShadowForegroundAuthorizationScope,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "@nautilo/lattice-bridge/server";

import {
  createForegroundAgentEntityCryptoGateway,
  createForegroundEntityCheckpointAuthorization,
  type ForegroundAgentEntityCryptoInvocation,
} from
  "../../src/routes/foreground-agent-entity-crypto-gateway.ts";
import { LiveShadowForegroundAuthorizationSessions } from
  "../../src/routes/live-shadow-foreground-authorization-sessions.ts";

const now = 1_800_000_000_000;
const namespaceId = "namespace-1";
const domainId = "domain-1";
const namespaceKey = new Uint8Array(32).fill(11);

const scope: AgentLiveShadowForegroundAuthorizationScope = Object.freeze({
  subjectHumanId: "human-1",
  issuingDeviceId: "device-1",
  recipientAgentId: "agent-1",
  sessionId: "session-1",
  roomId: "room-1",
  policyRevision: 1,
  hostAuthorizationRevision: 1,
  agentAuthorizationRevision: 1,
  namespaceIds: Object.freeze([namespaceId]),
  grantDomainIds: Object.freeze([domainId]),
  domainAuthoritySetDigest: new Uint8Array(32).fill(1),
});

function readyAuthority(): DomainForegroundNamespaceAuthorityInspectionV2 {
  return Object.freeze({
    status: "ready" as const,
    namespaceId,
    namespaceAccessRevision: 5,
    namespaceKeyGeneration: 4,
    namespaceHeadDigest: new Uint8Array(32).fill(2),
    namespacePublicationDigest: new Uint8Array(32).fill(3),
    namespacePublicationSetDigest: new Uint8Array(32).fill(4),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(5),
    domainId,
    domainKeyGeneration: 2,
    domainAuthorizationRevision: 3,
    domainHeadDigest: new Uint8Array(32).fill(6),
    bundleRevision: 7,
    bundleDigest: new Uint8Array(32).fill(8),
  });
}

function registeredSessions(input: Readonly<{
  grantedDomainId?: string;
  grantedDomainGeneration?: number;
  registeredScope?: AgentLiveShadowForegroundAuthorizationScope;
}> = {}) {
  const sessions = new LiveShadowForegroundAuthorizationSessions({
    now: () => now,
    startSweep: false,
  });
  const grantedDomainId = input.grantedDomainId ?? domainId;
  const registeredScope = input.registeredScope ?? scope;
  const capability = createDomainCompressedLiveShadowSessionCapability({
    description: {
      authorizationId: "grant-1",
      subjectHumanId: registeredScope.subjectHumanId,
      issuingDeviceId: registeredScope.issuingDeviceId,
      recipientAgentId: registeredScope.recipientAgentId,
      recipientKeyId: "recipient-key-1",
      sessionId: registeredScope.sessionId,
      roomId: registeredScope.roomId,
      policyRevision: registeredScope.policyRevision,
      hostAuthorizationRevision: registeredScope.hostAuthorizationRevision,
      agentAuthorizationRevision: registeredScope.agentAuthorizationRevision,
      agentRuntimeGeneration: 1,
      namespaceIds: registeredScope.namespaceIds,
      grantDomainIds: registeredScope.grantDomainIds,
      issuedAt: now,
      expiresAt: now + 300_000,
      authorizationDigest: new Uint8Array(32).fill(9),
    },
    entries: [Object.freeze({
      grantDomainId: grantedDomainId,
      participantDigest: new Uint8Array(32).fill(10),
      domainKeyGeneration: input.grantedDomainGeneration ?? 2,
      headDigest: new Uint8Array(32).fill(6),
      publicationDigest: new Uint8Array(32).fill(12),
      publicationAuthorizationRevision: authorizationRevision(3),
      authorizationRevision: authorizationRevision(3),
      activeNamespaceBindingSetDigest: new Uint8Array(32).fill(13),
      activeNamespaceBindingCount: 1,
      domainAiGrantKey: new Uint8Array(32).fill(14),
    })],
  });
  const registered = sessions.register({
    capability,
    scope: registeredScope,
    publicEvidence: {
      authorizationDigest: new Uint8Array(32).fill(9),
      authorizationPlanBytes: new Uint8Array([1]),
      authorizationPlanDigest: new Uint8Array(32).fill(15),
      recipientId: registeredScope.recipientAgentId,
      recipientKeyId: "recipient-key-1",
      recipientPublicKey: new Uint8Array(32).fill(16),
    },
    now,
  });
  if (registered === null) throw new Error("test grant did not register");
  return Object.freeze({ sessions, sessionReference: registered.sessionReference });
}

function namespaceKeys(input: Readonly<{
  authority?: ReturnType<typeof readyAuthority>;
  opened?: boolean;
}> = {}) {
  const authority = input.authority ?? readyAuthority();
  const calls: Array<Readonly<{
    keyGeneration: number | undefined;
    accessRevision: number | undefined;
    domainKey: Uint8Array;
  }>> = [];
  return Object.freeze({
    calls,
    port: {
      inspectForegroundNamespaceAuthority: async () => structuredClone(authority),
      withOpenedForegroundNamespaceKey: async <Value>(request: Readonly<{
        domainKey: Uint8Array;
        keyGeneration?: number;
        accessRevision?: number;
        use(key: Uint8Array): Value | Promise<Value>;
      }>): Promise<Value | null> => {
        calls.push(Object.freeze({
          keyGeneration: request.keyGeneration,
          accessRevision: request.accessRevision,
          domainKey: request.domainKey.slice(),
        }));
        if (input.opened === false) return null;
        return request.use(namespaceKey.slice());
      },
    },
  });
}

describe("foreground Agent entity crypto gateway", () => {
  test("retains current-set authority through asynchronous key use and wipes it afterward", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const authority = readyAuthority();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: {
        inspectForegroundNamespaceAuthority: async () => authority,
        withOpenedForegroundNamespaceKey: async (request) => {
          await Promise.resolve();
          expect(request.authority.domainHeadDigest).toEqual(
            new Uint8Array(32).fill(6),
          );
          return request.use(namespaceKey.slice());
        },
      },
    });
    try {
      expect(await gateway.execute({
        sessionReference,
        scope,
        entrypointId: "foreground.main",
        operations: ["encrypt"],
        execute: ({ entities }) => entities.useCurrentSet({
          operations: ["encrypt"],
          namespaceIds: [namespaceId],
          execute: async (opened) => {
            await Promise.resolve();
            expect(opened[0]!.authority.namespaceHeadDigest).toEqual(
              new Uint8Array(32).fill(2),
            );
            return "protected";
          },
        }),
      })).toEqual({
        status: "executed",
        value: { status: "executed", value: "protected" },
      });
      expect(authority.domainHeadDigest).toEqual(new Uint8Array(32));
      expect(authority.namespaceHeadDigest).toEqual(new Uint8Array(32));
    } finally {
      sessions.close();
    }
  });

  test("lets a complete invocation use the retained authorization deadline", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: namespaceKeys().port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt"]),
      execute: () => "within-grant",
    })).toEqual({ status: "executed", value: "within-grant" });
    sessions.close();
  });

  test("opens the exact retained Namespace generation hidden behind its Domain grant", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const keys = namespaceKeys();
    const callbackKeys: Uint8Array[] = [];
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    const result = await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt"]),
      execute: ({ entities, grant }) => {
        expect(grant.authorizationId).toBe("grant-1");
        return entities.use({
          operations: ["decrypt"],
          entity: {
            namespaceId,
            keyGeneration: 2,
            accessRevision: 3,
          },
          execute: ({ namespaceKey: openedKey, authority }) => {
            callbackKeys.push(openedKey.slice());
            expect(authority.namespaceId).toBe(namespaceId);
            return "opened";
          },
        });
      },
    });

    expect(result).toEqual({
      status: "executed",
      value: { status: "executed", value: "opened" },
    });
    expect(callbackKeys).toEqual([namespaceKey]);
    expect(keys.calls).toHaveLength(1);
    expect(keys.calls[0]).toMatchObject({
      keyGeneration: 2,
      accessRevision: 3,
    });
    expect(keys.calls[0]!.domainKey).toEqual(new Uint8Array(32).fill(14));
  });

  test("rejects another Namespace in the same Domain when it is outside the grant scope", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const crossRoomNamespaceId = "namespace-2";
    const keys = namespaceKeys({
      authority: Object.freeze({
        ...readyAuthority(),
        namespaceId: crossRoomNamespaceId,
      }),
    });
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt"]),
      execute: ({ entities }) => entities.use({
        operations: ["decrypt"],
        entity: {
          namespaceId: crossRoomNamespaceId,
          keyGeneration: 4,
          accessRevision: 5,
        },
        execute: () => "cross-room-opened",
      }),
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "content_unavailable" },
    });
    expect(keys.calls).toHaveLength(0);
  });

  test("rejects a Namespace whose current Domain is absent from the grant", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const keys = namespaceKeys({
      authority: Object.freeze({
        ...readyAuthority(),
        namespaceId: "namespace-foreign",
        domainId: "domain-foreign",
      }),
    });
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt"]),
      execute: ({ entities }) => entities.use({
        operations: ["decrypt"],
        entity: {
          namespaceId: "namespace-foreign",
          keyGeneration: 4,
          accessRevision: 5,
        },
        execute: () => "must-not-run",
      }),
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "content_unavailable" },
    });
    expect(keys.calls).toHaveLength(0);
  });

  test("allows historical decrypt but refuses stale encryption authority", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const keys = namespaceKeys();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt", "encrypt"]),
      execute: ({ entities }) => entities.use({
        operations: ["encrypt"],
        entity: {
          namespaceId,
          keyGeneration: 2,
          accessRevision: 3,
        },
        execute: () => "must-not-run",
      }),
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "content_unavailable" },
    });
    expect(keys.calls).toHaveLength(0);
  });

  test("fails closed when the grant does not carry the Namespace's current Domain", async () => {
    const { sessions, sessionReference } = registeredSessions({
      grantedDomainGeneration: 99,
    });
    const keys = namespaceKeys();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt"]),
      execute: ({ entities }) => entities.use({
        operations: ["decrypt"],
        entity: {
          namespaceId,
          keyGeneration: 4,
          accessRevision: 5,
        },
        execute: () => "must-not-run",
      }),
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "content_unavailable" },
    });
    expect(keys.calls).toHaveLength(0);
  });

  test("rejects empty, duplicate, or out-of-order operation sets", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: namespaceKeys().port,
    });
    const request = {
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main" as const,
      execute: () => "must-not-run",
    };

    expect(gateway.execute({ ...request, operations: [] })).rejects.toThrow(
      "Agent entity operations are not canonical",
    );
    expect(gateway.execute({
      ...request,
      operations: ["decrypt", "decrypt"],
    })).rejects.toThrow("Agent entity operations are not canonical");
    expect(gateway.execute({
      ...request,
      operations: ["encrypt", "decrypt"],
    })).rejects.toThrow("Agent entity operations are not canonical");
  });

  test("closes the entity gateway when the invocation callback returns", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: namespaceKeys().port,
    });
    const retained: ForegroundAgentEntityCryptoInvocation[] = [];
    expect(await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: ["decrypt"],
      execute: ({ entities }) => {
        retained.push(entities);
        return "done";
      },
    })).toEqual({ status: "executed", value: "done" });
    const closed = retained[0];
    if (closed === undefined) throw new Error("entity gateway was not retained");
    expect(await closed.use({
      operations: ["decrypt"],
      entity: { namespaceId, keyGeneration: 4, accessRevision: 5 },
      execute: () => "must-not-run",
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
  });

  test("resolves current Namespace coordinates for a new entity write", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const keys = namespaceKeys();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: ["encrypt"],
      execute: ({ entities }) => entities.useCurrentSet({
        operations: ["encrypt"],
        namespaceIds: [namespaceId],
        execute: (opened) => ({
          generation: opened[0]?.authority.namespaceKeyGeneration,
          revision: opened[0]?.authority.namespaceAccessRevision,
        }),
      }),
    })).toEqual({
      status: "executed",
      value: {
        status: "executed",
        value: { generation: 4, revision: 5 },
      },
    });
    expect(keys.calls).toHaveLength(1);
    expect(keys.calls[0]).toMatchObject({
      keyGeneration: 4,
      accessRevision: 5,
    });
  });

  test("resolves a cross-Room Namespace set only when the grant names it", async () => {
    const crossRoomNamespaceId = "namespace-2";
    const crossRoomScope = Object.freeze({
      ...scope,
      namespaceIds: Object.freeze([namespaceId, crossRoomNamespaceId].sort()),
    });
    const { sessions, sessionReference } = registeredSessions({
      registeredScope: crossRoomScope,
    });
    const keys = namespaceKeys({
      authority: Object.freeze({
        ...readyAuthority(),
        namespaceId: crossRoomNamespaceId,
      }),
    });
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope: crossRoomScope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: ["encrypt"],
      execute: ({ entities }) => entities.useCurrentSet({
        operations: ["encrypt"],
        namespaceIds: [crossRoomNamespaceId],
        execute: (opened) => opened[0]?.authority.namespaceId,
      }),
    })).toEqual({
      status: "executed",
      value: {
        status: "executed",
        value: crossRoomNamespaceId,
      },
    });
    expect(keys.calls).toHaveLength(1);
  });

  test("rejects an exact Namespace set containing an entry outside the grant", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const crossRoomNamespaceId = "namespace-2";
    const keys = namespaceKeys({
      authority: Object.freeze({
        ...readyAuthority(),
        namespaceId: crossRoomNamespaceId,
      }),
    });
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: keys.port,
    });

    expect(await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: ["encrypt"],
      execute: ({ entities }) => entities.useCurrentSet({
        operations: ["encrypt"],
        namespaceIds: [namespaceId, crossRoomNamespaceId].sort(),
        execute: () => "must-not-run",
      }),
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "content_unavailable" },
    });
    expect(keys.calls).toHaveLength(0);
  });

  test("seals and opens graph checkpoint cells inside the retained entity authority", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: namespaceKeys().port,
    });
    const crypto = new LatticeCrypto({
      bytes: (length) => new Uint8Array(length).fill(0x5a),
    });
    const plaintext = new TextEncoder().encode("verified foreground context");
    let useAfterClose: (() => Promise<unknown>) | undefined;
    const coordinate = Object.freeze({
      kind: "write" as const,
      threadId: "thread-1",
      checkpointNs: "checkpoint-ns-1",
      checkpointId: "checkpoint-1",
      taskId: "task-1",
      index: 0,
      channel: "messages",
    });

    const result = await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: ["decrypt", "encrypt"],
      execute: async ({ entities }) => {
        const checkpoint = createForegroundEntityCheckpointAuthorization({
          crypto,
          entities,
          namespaceId,
          namespaceAccessRevision: 5,
          namespaceKeyGeneration: 4,
          domainId,
          agentAuthorizationRevision: 1,
          authorizationDeadlineAt: now + 30_000,
          entrypointId: "foreground.main",
        });
        const checkpointScope = Object.freeze({
          logicalThreadId: "thread-1",
          namespaceId,
          keyClass: "ai" as const,
          expectedAccessRevision: 5,
          expectedPolicyRevision: 1,
          authorizationSession: checkpoint.authorizationSession,
        });
        let ciphertext: Uint8Array<ArrayBufferLike> = new Uint8Array();
        await checkpoint.crypto.executeAuthorizedOperation({
          operation: "write",
          scope: checkpointScope,
          execute: async (context) => {
            ciphertext = await checkpoint.crypto.seal({
              scope: checkpointScope,
              coordinate,
              plaintext,
              signal: context.signal,
            });
          },
        });
        expect(ciphertext).not.toEqual(plaintext);
        useAfterClose = () => checkpoint.crypto.executeAuthorizedOperation({
          operation: "read",
          scope: checkpointScope,
          execute: (context) => checkpoint.crypto.open({
            scope: checkpointScope,
            coordinate,
            ciphertext,
            signal: context.signal,
          }),
        });
        return checkpoint.crypto.executeAuthorizedOperation({
          operation: "read",
          scope: checkpointScope,
          execute: (context) => checkpoint.crypto.open({
            scope: checkpointScope,
            coordinate,
            ciphertext,
            signal: context.signal,
          }),
        });
      },
    });

    expect(result).toMatchObject({ status: "executed" });
    if (result.status !== "executed") throw new Error("checkpoint was denied");
    expect(new TextDecoder().decode(result.value)).toBe(
      "verified foreground context",
    );
    if (useAfterClose === undefined) throw new Error("checkpoint was not retained");
    expect(useAfterClose()).rejects.toMatchObject({
      code: "authorization_unavailable",
    });
  });

  test("allows overlapping checkpoint and pending-write operations in one foreground invocation", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: namespaceKeys().port,
    });
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let operationFailure: Error | undefined;
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    let assertFirstActive: (() => void) | undefined;
    let assertSecondActive: (() => void) | undefined;
    try {
      const result = await gateway.execute({
        sessionReference,
        scope,
        operationDeadline: now + 30_000,
        entrypointId: "foreground.main",
        operations: ["encrypt"],
        execute: async ({ entities }) => {
          const checkpoint = createForegroundEntityCheckpointAuthorization({
            crypto: new LatticeCrypto(),
            entities,
            namespaceId,
            namespaceAccessRevision: 5,
            namespaceKeyGeneration: 4,
            domainId,
            agentAuthorizationRevision: 1,
            authorizationDeadlineAt: now + 30_000,
            entrypointId: "foreground.main",
          });
          const checkpointScope = {
            logicalThreadId: "thread-concurrent",
            namespaceId,
            keyClass: "ai" as const,
            expectedAccessRevision: 5,
            expectedPolicyRevision: 1,
            authorizationSession: checkpoint.authorizationSession,
          };
          const plaintext = new TextEncoder().encode("synthetic graph state");
          const first = checkpoint.crypto.executeAuthorizedOperation({
            operation: "write",
            scope: checkpointScope,
            execute: async (context) => {
              firstSignal = context.signal;
              assertFirstActive = context.assertActive;
              expect(context.signal.aborted).toBeFalse();
              const ciphertext = await checkpoint.crypto.seal({
                scope: checkpointScope,
                coordinate: {
                  kind: "channel",
                  threadId: "shadow-thread-concurrent",
                  checkpointNs: "shadow-root",
                  channel: "__start__",
                  version: "1",
                },
                plaintext,
                signal: context.signal,
              });
              firstEntered.resolve();
              // Hold the checkpoint lease as a pending durable store.put would.
              await releaseFirst.promise;
              return ciphertext;
            },
          });
          await firstEntered.promise;
          try {
            // LangGraph can persist pending task writes while checkpoint put
            // is still outstanding; both calls have valid retained authority.
            const second = await checkpoint.crypto.executeAuthorizedOperation({
              operation: "write",
              scope: checkpointScope,
              execute: (context) => {
                secondSignal = context.signal;
                assertSecondActive = context.assertActive;
                expect(context.signal).not.toBe(firstSignal);
                return checkpoint.crypto.seal({
                scope: checkpointScope,
                coordinate: {
                  kind: "write",
                  threadId: "shadow-thread-concurrent",
                  checkpointNs: "shadow-root",
                  checkpointId: "checkpoint-concurrent",
                  taskId: "task-concurrent",
                  index: 0,
                  channel: "messages",
                },
                plaintext,
                signal: context.signal,
                });
              },
            });
            expect(second).not.toEqual(plaintext);
            expect(secondSignal?.aborted).toBeTrue();
            expect(firstSignal?.aborted).toBeFalse();
            expect(assertFirstActive).toBeDefined();
            expect(assertFirstActive!).not.toThrow();
            expect(assertSecondActive!).toThrow();
            return "both-protected";
          } catch (error) {
            operationFailure = error instanceof Error
              ? error : new Error("checkpoint operation failed", { cause: error });
            throw operationFailure;
          } finally {
            releaseFirst.resolve();
            expect(await first).not.toEqual(plaintext);
          }
        },
      });
      // The gateway maps callback errors to execution_failed; preserve the
      // originating error so this expected-success regression is diagnostic.
      if (operationFailure !== undefined) throw operationFailure;
      expect(result).toEqual({ status: "executed", value: "both-protected" });
      expect(firstSignal?.aborted).toBeTrue();
      expect(assertFirstActive!).toThrow();
    } finally {
      releaseFirst.resolve();
      sessions.close();
    }
  });

  test("cancels all overlapping checkpoint operations when their invocation is revoked", async () => {
    const { sessions, sessionReference } = registeredSessions();
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: namespaceKeys().port,
    });
    const entered = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const activeChecks: (() => void)[] = [];
    const execution = gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.main",
      operations: ["encrypt"],
      execute: async ({ entities }) => {
        const checkpoint = createForegroundEntityCheckpointAuthorization({
          crypto: new LatticeCrypto(),
          entities,
          namespaceId,
          namespaceAccessRevision: 5,
          namespaceKeyGeneration: 4,
          domainId,
          agentAuthorizationRevision: 1,
          authorizationDeadlineAt: now + 30_000,
          entrypointId: "foreground.main",
        });
        try {
          await Promise.allSettled([0, 1].map(() =>
            checkpoint.crypto.executeAuthorizedOperation({
              operation: "write",
              scope: {
                logicalThreadId: "thread-cancelled",
                namespaceId,
                keyClass: "ai",
                expectedAccessRevision: 5,
                expectedPolicyRevision: 1,
                authorizationSession: checkpoint.authorizationSession,
              },
              execute: async (context) => {
                signals.push(context.signal);
                activeChecks.push(context.assertActive);
                const aborted = new Promise<void>((resolve) =>
                  context.signal.addEventListener("abort", () => resolve(), { once: true })
                );
                if (signals.length === 2) entered.resolve();
                await aborted;
              },
            })
          ));
        } finally {
          drained.resolve();
        }
      },
    });
    try {
      await entered.promise;
      expect(signals[0]).not.toBe(signals[1]);
      sessions.cancelScope(scope);
      await drained.promise;
      await execution;
      expect(signals.every((signal) => signal.aborted)).toBeTrue();
      for (const assertActive of activeChecks) expect(assertActive).toThrow();
    } finally {
      sessions.close();
    }
  });

  test("invalidates entity access when the foreground operation deadline fires", async () => {
    const { sessions, sessionReference } = registeredSessions();
    let inspected = false;
    let resolveLateResult!: (
      result: Awaited<ReturnType<ForegroundAgentEntityCryptoInvocation["use"]>>,
    ) => void;
    const lateResult = new Promise<
      Awaited<ReturnType<ForegroundAgentEntityCryptoInvocation["use"]>>
    >((resolve) => {
      resolveLateResult = resolve;
    });
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: {
        inspectForegroundNamespaceAuthority: async () => {
          inspected = true;
          return readyAuthority();
        },
        withOpenedForegroundNamespaceKey: async () => null,
      },
    });

    const result = await gateway.execute({
      sessionReference,
      scope,
      operationDeadline: now + 5,
      entrypointId: "foreground.main",
      operations: ["decrypt"],
      execute: async ({ entities }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const opened = await entities.use({
          operations: ["decrypt"],
          entity: { namespaceId, keyGeneration: 4, accessRevision: 5 },
          execute: () => "must-not-run",
        });
        resolveLateResult(opened);
        return opened;
      },
    });

    expect(result).toEqual({ status: "unavailable", reason: "lease_expired" });
    expect(await lateResult).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(inspected).toBe(false);
  });
});
