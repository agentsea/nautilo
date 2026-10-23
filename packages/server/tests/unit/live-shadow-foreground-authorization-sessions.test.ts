import { describe, expect, test } from "bun:test";
import { authorizationRevision } from "@nautilo/lattice-crypto";

import {
  createDomainCompressedLiveShadowSessionCapability,
  inspectDomainCompressedLiveShadowSessionCapability,
  type AgentLiveShadowForegroundAuthorizationScope,
  type RuntimeLiveShadowForegroundAuthorizationScope,
} from "@nautilo/lattice-bridge/server";
import { LiveShadowForegroundAuthorizationSessions } from
  "../../src/routes/live-shadow-foreground-authorization-sessions.ts";

const scope: AgentLiveShadowForegroundAuthorizationScope = Object.freeze({
  subjectHumanId: "human-1",
  issuingDeviceId: "device-1",
  recipientAgentId: "agent-1",
  sessionId: "session-1",
  roomId: "room-1",
  policyRevision: 1,
  hostAuthorizationRevision: 1,
  agentAuthorizationRevision: 1,
  namespaceIds: Object.freeze(["namespace-1"]),
  grantDomainIds: Object.freeze(["domain-1"]),
  domainAuthoritySetDigest: new Uint8Array(32).fill(1),
});

const runtimeScope: RuntimeLiveShadowForegroundAuthorizationScope =
  Object.freeze({
    subjectHumanId: "human-1",
    issuingDeviceId: "device-1",
    recipientKind: "nautilo_foreground_runtime",
    browserSessionId: "browser-session-1",
    topLevelRoomId: "room-1",
    policyRevision: 1,
    hostAuthorizationRevision: 1,
    namespaceIds: Object.freeze(["namespace-1"]),
    grantDomainIds: Object.freeze(["domain-1"]),
    domainAuthoritySetDigest: new Uint8Array(32).fill(1),
  });

function capability(input: Readonly<{
  scope?: AgentLiveShadowForegroundAuthorizationScope;
  issuedAt?: number;
  expiresAt?: number;
  authorizationId?: string;
}> = {}) {
  const capabilityScope = input.scope ?? scope;
  const issuedAt = input.issuedAt ?? Date.now();
  return createDomainCompressedLiveShadowSessionCapability({
    description: {
      authorizationId: input.authorizationId ?? "authorization-1",
      subjectHumanId: capabilityScope.subjectHumanId,
      issuingDeviceId: capabilityScope.issuingDeviceId,
      recipientAgentId: capabilityScope.recipientAgentId,
      recipientKeyId: "recipient-key-1",
      sessionId: capabilityScope.sessionId,
      roomId: capabilityScope.roomId,
      policyRevision: capabilityScope.policyRevision,
      hostAuthorizationRevision: capabilityScope.hostAuthorizationRevision,
      agentAuthorizationRevision: capabilityScope.agentAuthorizationRevision,
      agentRuntimeGeneration: 0,
      namespaceIds: capabilityScope.namespaceIds,
      grantDomainIds: capabilityScope.grantDomainIds,
      issuedAt,
      expiresAt: input.expiresAt ?? issuedAt + 2 * 60 * 60_000,
      authorizationDigest: new Uint8Array(32).fill(2),
    },
    entries: [Object.freeze({
      grantDomainId: capabilityScope.grantDomainIds[0]!,
      participantDigest: new Uint8Array(32).fill(3),
      domainKeyGeneration: 1,
      headDigest: new Uint8Array(32).fill(4),
      publicationDigest: new Uint8Array(32).fill(5),
      publicationAuthorizationRevision: authorizationRevision(1),
      authorizationRevision: authorizationRevision(1),
      activeNamespaceBindingSetDigest: new Uint8Array(32).fill(6),
      activeNamespaceBindingCount: 1,
      domainAiGrantKey: new Uint8Array(32).fill(7),
    })],
  });
}

function runtimeCapability(input: Readonly<{
  issuedAt?: number;
  expiresAt?: number;
  authorizationId?: string;
}> = {}) {
  const issuedAt = input.issuedAt ?? Date.now();
  return createDomainCompressedLiveShadowSessionCapability({
    description: {
      authorizationId: input.authorizationId ?? "runtime-authorization-1",
      subjectHumanId: runtimeScope.subjectHumanId,
      issuingDeviceId: runtimeScope.issuingDeviceId,
      recipientKind: runtimeScope.recipientKind,
      browserSessionId: runtimeScope.browserSessionId,
      topLevelRoomId: runtimeScope.topLevelRoomId,
      recipientKeyId: "runtime-key-1",
      policyRevision: runtimeScope.policyRevision,
      hostAuthorizationRevision: runtimeScope.hostAuthorizationRevision,
      namespaceIds: runtimeScope.namespaceIds,
      grantDomainIds: runtimeScope.grantDomainIds,
      issuedAt,
      expiresAt: input.expiresAt ?? issuedAt + 2 * 60 * 60_000,
      authorizationDigest: new Uint8Array(32).fill(2),
    },
    entries: [Object.freeze({
      grantDomainId: runtimeScope.grantDomainIds[0]!,
      participantDigest: new Uint8Array(32).fill(3),
      domainKeyGeneration: 1,
      headDigest: new Uint8Array(32).fill(4),
      publicationDigest: new Uint8Array(32).fill(5),
      publicationAuthorizationRevision: authorizationRevision(1),
      authorizationRevision: authorizationRevision(1),
      activeNamespaceBindingSetDigest: new Uint8Array(32).fill(6),
      activeNamespaceBindingCount: 1,
      domainAiGrantKey: new Uint8Array(32).fill(7),
    })],
  });
}

describe("live Shadow foreground authorization sessions", () => {
  test("executes a transient child without replacing a concurrent reusable session", async () => {
    const now = 1_800_000_000_000;
    const sessions = new LiveShadowForegroundAuthorizationSessions({
      now: () => now,
      startSweep: false,
    });
    const primary = sessions.register({
      capability: runtimeCapability({ issuedAt: now, expiresAt: now + 60_000 }),
      scope: runtimeScope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "recipient-1",
        recipientKeyId: "recipient-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now,
    });
    expect(primary).not.toBeNull();
    const transientCapability = runtimeCapability({
      issuedAt: now,
      expiresAt: now + 60_000,
      authorizationId: "transient-authorization",
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const transient = sessions.executeTransient({
        capability: transientCapability,
        scope: runtimeScope,
        namespaceIds: runtimeScope.namespaceIds,
        domainIds: runtimeScope.grantDomainIds,
        operations: ["decrypt", "encrypt"],
        workDescriptorDigest: new Uint8Array(32).fill(0xaa),
        operationDeadline: now + 30_000,
        execute: async () => {
          entered.resolve();
          await release.promise;
          return Object.freeze({ status: "executed" as const, value: "transient" });
        },
      });
      await entered.promise;
      expect(sessions.inspectReusable(runtimeScope)?.sessionReference)
        .toBe(primary?.sessionReference);
      expect(await sessions.execute({
        sessionReference: primary!.sessionReference,
        scope: runtimeScope,
        execute: async () => Object.freeze({
          status: "executed" as const,
          value: "primary",
        }),
      })).toEqual({ status: "executed", value: "primary" });
      release.resolve();
      expect(await transient).toEqual({
        status: "executed",
        value: "transient",
      });
      expect(inspectDomainCompressedLiveShadowSessionCapability(
        transientCapability,
      )).toBeNull();
      expect(sessions.inspectReusable(runtimeScope)?.sessionReference)
        .toBe(primary?.sessionReference);
    } finally {
      release.resolve();
      sessions.close();
    }
  });

  test("destroys a transient session after callback failure", async () => {
    const now = 1_800_000_000_000;
    const sessions = new LiveShadowForegroundAuthorizationSessions({
      now: () => now,
      startSweep: false,
    });
    const transientCapability = capability({
      issuedAt: now,
      expiresAt: now + 60_000,
      authorizationId: "failing-transient-authorization",
    });
    try {
      expect(await sessions.executeTransient({
        capability: transientCapability,
        scope,
        namespaceIds: scope.namespaceIds,
        domainIds: scope.grantDomainIds,
        operations: ["decrypt", "encrypt"],
        workDescriptorDigest: new Uint8Array(32).fill(0xbb),
        execute: () => {
          throw new Error("publication failed");
        },
      })).toEqual({ status: "unavailable", reason: "execution_failed" });
      expect(inspectDomainCompressedLiveShadowSessionCapability(
        transientCapability,
      )).toBeNull();
    } finally {
      sessions.close();
    }
  });

  test("rejects expired, foreign, and widened transient admissions", async () => {
    const now = 1_800_000_000_000;
    const sessions = new LiveShadowForegroundAuthorizationSessions({
      now: () => now,
      startSweep: false,
    });
    let invoked = false;
    const execute = async () => {
      invoked = true;
      return Object.freeze({ status: "executed" as const, value: "unexpected" });
    };
    try {
      const expired = capability({
        issuedAt: now - 60_000,
        expiresAt: now,
        authorizationId: "expired-transient-authorization",
      });
      expect(await sessions.executeTransient({
        capability: expired,
        scope,
        namespaceIds: scope.namespaceIds,
        domainIds: scope.grantDomainIds,
        operations: ["decrypt", "encrypt"],
        workDescriptorDigest: new Uint8Array(32).fill(0xcc),
        execute,
      })).toEqual({ status: "unavailable", reason: "session_expired" });
      expect(inspectDomainCompressedLiveShadowSessionCapability(expired))
        .toBeNull();

      const foreign = capability({
        issuedAt: now,
        expiresAt: now + 60_000,
        authorizationId: "foreign-transient-authorization",
      });
      expect(await sessions.executeTransient({
        capability: foreign,
        scope: Object.freeze({ ...scope, subjectHumanId: "revoked-human" }),
        namespaceIds: scope.namespaceIds,
        domainIds: scope.grantDomainIds,
        operations: ["decrypt", "encrypt"],
        workDescriptorDigest: new Uint8Array(32).fill(0xdd),
        execute,
      })).toEqual({ status: "unavailable", reason: "session_cancelled" });
      expect(inspectDomainCompressedLiveShadowSessionCapability(foreign))
        .toBeNull();

      const widened = capability({
        issuedAt: now,
        expiresAt: now + 60_000,
        authorizationId: "widened-transient-authorization",
      });
      expect(await sessions.executeTransient({
        capability: widened,
        scope,
        namespaceIds: ["namespace-foreign"],
        domainIds: scope.grantDomainIds,
        operations: ["decrypt", "encrypt"],
        workDescriptorDigest: new Uint8Array(32).fill(0xee),
        execute,
      })).toEqual({ status: "unavailable", reason: "session_cancelled" });
      expect(inspectDomainCompressedLiveShadowSessionCapability(widened))
        .toBeNull();

      const invalidWork = capability({
        issuedAt: now,
        expiresAt: now + 60_000,
        authorizationId: "invalid-work-transient-authorization",
      });
      expect(await sessions.executeTransient({
        capability: invalidWork,
        scope,
        namespaceIds: scope.namespaceIds,
        domainIds: scope.grantDomainIds,
        operations: ["decrypt", "encrypt"],
        workDescriptorDigest: new Uint8Array(31).fill(0xff),
        execute,
      })).toEqual({ status: "unavailable", reason: "session_cancelled" });
      expect(inspectDomainCompressedLiveShadowSessionCapability(invalidWork))
        .toBeNull();
      expect(invoked).toBeFalse();
    } finally {
      sessions.close();
    }
  });

  test("declines near-expiry reuse without extending or cancelling the retained grant", () => {
    const issuedAt = 1_800_000_000_000;
    let currentTime = issuedAt;
    const expiresAt = issuedAt + 5 * 60_000;
    const sessions = new LiveShadowForegroundAuthorizationSessions({
      now: () => currentTime, startSweep: false,
    });
    const publicEvidence = {
      authorizationDigest: new Uint8Array(32).fill(2),
      authorizationPlanBytes: new Uint8Array([1]),
      authorizationPlanDigest: new Uint8Array(32).fill(8),
      recipientId: "recipient-1", recipientKeyId: "recipient-key-1",
      recipientPublicKey: new Uint8Array(32).fill(9),
    };
    try {
      const retained = sessions.register({
        capability: capability({ issuedAt, expiresAt }), scope, publicEvidence,
        now: issuedAt,
      });
      expect(retained).not.toBeNull();
      currentTime = expiresAt - 1_000;
      expect(sessions.inspectReusable(scope, expiresAt)?.sessionReference)
        .toBe(retained?.sessionReference);
      expect(sessions.inspectReusable(scope, currentTime + 5 * 60_000)).toBeNull();
      expect(sessions.inspectReusable(scope, Number.NaN)).toBeNull();
      expect(sessions.inspectReusable(scope)?.sessionReference)
        .toBe(retained?.sessionReference);
      currentTime = expiresAt;
      expect(sessions.inspectReusable(scope)).toBeNull();
      const fresh = sessions.register({
        capability: capability({ issuedAt: currentTime,
          expiresAt: currentTime + 5 * 60_000, authorizationId: "fresh-authorization" }),
        scope, publicEvidence, now: currentTime,
      });
      expect(fresh).not.toBeNull();
      expect(sessions.inspectReusable(scope, currentTime + 5 * 60_000)?.sessionReference)
        .toBe(fresh?.sessionReference);
    } finally {
      sessions.close();
    }
  });

  test("uses the retained authorization expiry when no narrower callback deadline is supplied", async () => {
    const issuedAt = 1_800_000_000_000;
    let currentTime = issuedAt;
    const sessions = new LiveShadowForegroundAuthorizationSessions({
      now: () => currentTime,
      startSweep: false,
    });
    const registered = sessions.register({
      capability: capability({
        issuedAt,
        expiresAt: issuedAt + 5 * 60_000,
      }),
      scope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "recipient-1",
        recipientKeyId: "recipient-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now: issuedAt,
    });
    expect(registered).not.toBeNull();

    expect(await sessions.execute({
      sessionReference: registered!.sessionReference,
      scope,
      execute: async () => {
        currentTime += 60_000;
        return Object.freeze({
          status: "executed" as const,
          value: "after-request-window",
        });
      },
    })).toEqual({ status: "executed", value: "after-request-window" });
    sessions.close();
  });

  test("reuses one Agent-free Runtime session for the exact Browser and Room scope", async () => {
    const now = Date.now();
    const sessions = new LiveShadowForegroundAuthorizationSessions({
      now: () => now,
      startSweep: false,
    });
    const runtimeSessionCapability = runtimeCapability({
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
    });
    const registered = sessions.register({
      capability: runtimeSessionCapability,
      scope: runtimeScope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "runtime-authorization-1",
        recipientKeyId: "runtime-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now,
    });
    expect(registered).not.toBeNull();
    expect(sessions.inspectReusable(runtimeScope)?.sessionReference)
      .toBe(registered?.sessionReference);
    expect(sessions.inspectReusable({
      ...runtimeScope,
      browserSessionId: "foreign-browser-session",
    })).toBeNull();
    expect(await sessions.execute({
      sessionReference: registered!.sessionReference,
      scope: runtimeScope,
      operationDeadline: now + 30_000,
      entrypointId: "foreground.fork",
      execute: async () => Object.freeze({
        status: "executed" as const,
        value: "shared-runtime",
      }),
    })).toEqual({ status: "executed", value: "shared-runtime" });
    expect(sessions.inspectReusable({
      ...runtimeScope,
      // A visibility change can replace the exact readable Namespace set while
      // retaining the same Domain set and cardinality.
      namespaceIds: Object.freeze(["namespace-after-visibility-change"]),
    })).toBeNull();
    expect(sessions.inspectReusable(runtimeScope)).toBeNull();
    sessions.close();
  });

  test("registers one opaque reusable session and closes it on authority drift", async () => {
    const sessions = new LiveShadowForegroundAuthorizationSessions();
    const registered = sessions.register({
      capability: capability(),
      scope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1, 2, 3]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "recipient-1",
        recipientKeyId: "recipient-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now: Date.now(),
    });
    expect(registered).not.toBeNull();
    expect(registered?.sessionReference).not.toBe("authorization-1");
    expect(sessions.inspectReusable(scope)?.sessionReference)
      .toBe(registered?.sessionReference);

    let borrowed = false;
    const result = await sessions.execute({
      sessionReference: registered!.sessionReference,
      scope,
      operationDeadline: Date.now() + 30_000,
      execute: async () => {
        borrowed = true;
        return Object.freeze({ status: "executed" as const, value: "ok" });
      },
    });
    expect(result).toEqual({ status: "executed", value: "ok" });
    expect(borrowed).toBeTrue();

    const drifted = Object.freeze({
      ...scope,
      domainAuthoritySetDigest: new Uint8Array(32).fill(99),
    });
    expect(sessions.inspectReusable(drifted)).toBeNull();
    expect(sessions.inspectReusable(scope)).toBeNull();
    sessions.close();
  });

  test("cancels explicit device and Human logout scopes", () => {
    const sessions = new LiveShadowForegroundAuthorizationSessions();
    expect(sessions.register({
      capability: capability(),
      scope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "recipient-1",
        recipientKeyId: "recipient-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now: Date.now(),
    })).not.toBeNull();
    expect(sessions.cancelForDevice({
      subjectHumanId: "human-other",
      issuingDeviceId: scope.issuingDeviceId,
    })).toBe(0);
    expect(sessions.cancelForDevice({
      subjectHumanId: scope.subjectHumanId,
      issuingDeviceId: scope.issuingDeviceId,
    })).toBe(1);
    expect(sessions.inspectReusable(scope)).toBeNull();

    expect(sessions.register({
      capability: capability(),
      scope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "recipient-2",
        recipientKeyId: "recipient-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now: Date.now(),
    })).not.toBeNull();
    expect(sessions.cancelForHuman("human-other")).toBe(0);
    expect(sessions.cancelScope({
      ...scope,
      domainAuthoritySetDigest: new Uint8Array(32).fill(0xff),
    })).toBeFalse();
    expect(sessions.cancelScope(scope)).toBeTrue();
    expect(sessions.inspectReusable(scope)).toBeNull();
    expect(sessions.register({
      capability: capability(),
      scope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "recipient-3",
        recipientKeyId: "recipient-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now: Date.now(),
    })).not.toBeNull();
    expect(sessions.cancelForHuman("human-other")).toBe(0);
    expect(sessions.cancelForHuman(scope.subjectHumanId)).toBe(1);
    sessions.close();
  });

  test("prunes expired side-index evidence and honors the signed deadline", () => {
    let now = 1_000_000;
    const sessions = new LiveShadowForegroundAuthorizationSessions({
      now: () => now,
      startSweep: false,
    });
    const makeScope = (
      index: number,
    ): AgentLiveShadowForegroundAuthorizationScope => Object.freeze({
      ...scope,
      subjectHumanId: `human-${index}`,
      sessionId: `session-${index}`,
      roomId: `room-${index}`,
      namespaceIds: Object.freeze([`namespace-${index}`]),
      grantDomainIds: Object.freeze([`domain-${index}`]),
    });
    for (let index = 0; index < 256; index++) {
      const indexedScope = makeScope(index);
      expect(sessions.register({
        capability: capability({
          scope: indexedScope,
          issuedAt: now,
          expiresAt: now + 1,
          authorizationId: `authorization-${index}`,
        }),
        scope: indexedScope,
        publicEvidence: {
          authorizationDigest: new Uint8Array(32).fill(2),
          authorizationPlanBytes: new Uint8Array([1]),
          authorizationPlanDigest: new Uint8Array(32).fill(8),
          recipientId: `recipient-${index}`,
          recipientKeyId: "recipient-key-1",
          recipientPublicKey: new Uint8Array(32).fill(9),
        },
        now,
      })).not.toBeNull();
    }

    now += 2;
    const promotedPolicyScope = makeScope(256);
    expect(sessions.register({
      capability: capability({
        scope: promotedPolicyScope,
        issuedAt: now,
        expiresAt: now + 10 * 60_000,
        authorizationId: "authorization-256",
      }),
      scope: promotedPolicyScope,
      publicEvidence: {
        authorizationDigest: new Uint8Array(32).fill(2),
        authorizationPlanBytes: new Uint8Array([1]),
        authorizationPlanDigest: new Uint8Array(32).fill(8),
        recipientId: "recipient-256",
        recipientKeyId: "recipient-key-1",
        recipientPublicKey: new Uint8Array(32).fill(9),
      },
      now,
    })).not.toBeNull();
    expect(sessions.cancelForHuman("human-0")).toBe(0);

    now += 5 * 60_000 + 1;
    expect(sessions.inspectReusable(promotedPolicyScope)).not.toBeNull();
    sessions.close();
  });
});
