import { describe, expect, test } from "bun:test";

import {
  ForegroundAuthorizationSessionRegistry,
  createForegroundAuthorizationCapabilityPort,
  type ForegroundAuthorizationBinding,
  type ForegroundAuthorizationCapabilityDescription,
  type ForegroundAuthorizationCapabilityPort,
} from "../../src/protected-execution/foreground-authorization-session";

const NOW = 8_000_000;
const FIVE_MINUTES_MS = 5 * 60 * 1_000;

declare const fakeDomainCapabilityBrand: unique symbol;

type FakeDomainCapability = Readonly<{
  readonly authorizationId: string;
  readonly expiresAt: number;
  readonly [fakeDomainCapabilityBrand]: true;
}>;

type FakeDomainState = {
  readonly description: ForegroundAuthorizationCapabilityDescription;
  readonly secret: Uint8Array;
};

function binding(
  overrides: Partial<ForegroundAuthorizationBinding> = {},
): ForegroundAuthorizationBinding {
  return Object.freeze({
    humanId: "human-alice",
    issuingDeviceId: "device-browser",
    recipientKind: "nautilo_foreground_runtime",
    browserSessionId: "browser-session",
    topLevelRoomId: "room-top-level",
    ...overrides,
  });
}

function fixture() {
  let now = NOW;
  let nextLeaseId = 0;
  const states = new WeakMap<object, FakeDomainState>();
  const destroyed: FakeDomainCapability[] = [];

  const capabilityPort: ForegroundAuthorizationCapabilityPort<
    FakeDomainCapability
  > = createForegroundAuthorizationCapabilityPort({
    inspect: (capability: FakeDomainCapability) =>
      states.get(capability)?.description ?? null,
    destroy: (capability: FakeDomainCapability) => {
      const state = states.get(capability);
      if (state === undefined) return;
      states.delete(capability);
      state.secret.fill(0);
      destroyed.push(capability);
    },
  });
  const createRegistry = () =>
    new ForegroundAuthorizationSessionRegistry<FakeDomainCapability>({
      capabilityPort,
      now: () => now,
      createSessionId: () => "opaque-runtime-session",
      createViewId: () => "opaque-runtime-view",
      createLeaseId: () => `opaque-runtime-lease-${++nextLeaseId}`,
      startSweep: false,
    });
  const createCapability = () => {
    const secret = new Uint8Array([7, 11, 13, 17]);
    const description: ForegroundAuthorizationCapabilityDescription =
      Object.freeze({
        authorizationId: "signed-device-authorization",
        issuedAt: NOW,
        expiresAt: NOW + 2 * 60 * 60 * 1_000,
        issuingHumanId: "human-alice",
        issuingDeviceId: "device-browser",
        recipientKind: "nautilo_foreground_runtime",
        browserSessionId: "browser-session",
        topLevelRoomId: "room-top-level",
        recipientKeyId: "recipient-process-key",
        namespaceIds: Object.freeze(["namespace-room"]),
        domainIds: Object.freeze(["grant-domain-participants"]),
      });
    const capability = Object.freeze({
      authorizationId: description.authorizationId,
      expiresAt: description.expiresAt,
    }) as FakeDomainCapability;
    states.set(capability, { description, secret });
    return { capability, secret };
  };

  return {
    capabilityPort,
    createCapability,
    createRegistry,
    destroyed,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("M298 foreground Runtime Domain capability adapter", () => {
  test("reuses one adapted capability for sequential operation leases", async () => {
    const state = fixture();
    const registry = state.createRegistry();
    const { capability } = state.createCapability();
    const registration = registry.register({
      capability,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt", "encrypt"]),
      sessionDeadline: NOW + FIVE_MINUTES_MS,
    });
    expect(registration.status).toBe("registered");
    if (registration.status !== "registered") return;

    expect(registration.sessionId).toBe("opaque-runtime-session");
    expect(registration.sessionId).not.toBe(capability.authorizationId);
    const borrowed: FakeDomainCapability[] = [];
    for (const expected of ["first-turn", "second-turn"] as const) {
      const leased = registry.leaseAuthorizationSetOperation({
        view: registration.rootView,
        entrypointId: "foreground.main",
        operations: Object.freeze(["decrypt", "encrypt"]),
        namespaceIds: Object.freeze(["namespace-room"]),
        domainIds: Object.freeze(["grant-domain-participants"]),
        executionDeadline: NOW + 30_000,
      });
      expect(leased.status).toBe("leased");
      if (leased.status !== "leased") return;
      expect(await registry.executeWithCapability(leased.lease, {
        execute: (operation) => {
          borrowed.push(operation.capability);
          expect(operation.operations).toEqual(["decrypt", "encrypt"]);
          expect(operation.namespaceIds).toEqual(["namespace-room"]);
          expect(operation.domainIds).toEqual([
            "grant-domain-participants",
          ]);
          return Object.freeze({
            status: "executed" as const,
            value: expected,
          });
        },
      })).toEqual({ status: "executed", value: expected });
    }

    expect(borrowed).toEqual([capability, capability]);
    expect(state.destroyed).toEqual([]);
  });

  test("honors a five-minute server deadline under the two-hour hard maximum", () => {
    const state = fixture();
    const registry = state.createRegistry();
    const { capability, secret } = state.createCapability();
    const registration = registry.register({
      capability,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt", "encrypt"]),
      sessionDeadline: NOW + FIVE_MINUTES_MS,
    });
    if (registration.status !== "registered") {
      throw new Error(`registration failed: ${registration.reason}`);
    }

    state.setNow(NOW + FIVE_MINUTES_MS - 1);
    expect(registry.resolve({
      sessionId: registration.sessionId,
      authenticatedBinding: binding(),
    }).status).toBe("resolved");
    state.setNow(NOW + FIVE_MINUTES_MS);
    expect(registry.resolve({
      sessionId: registration.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({ status: "unavailable", reason: "session_expired" });
    expect(state.destroyed).toEqual([capability]);
    expect(secret).toEqual(new Uint8Array(4));
  });

  test("does not refresh idle after a failed adapted operation", async () => {
    const state = fixture();
    const registry = state.createRegistry();
    const { capability, secret } = state.createCapability();
    const registration = registry.register({
      capability,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt", "encrypt"]),
    });
    if (registration.status !== "registered") {
      throw new Error(`registration failed: ${registration.reason}`);
    }
    state.setNow(NOW + 30 * 60 * 1_000 - 1);
    const leased = registry.leaseAuthorizationSetOperation({
      view: registration.rootView,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt", "encrypt"]),
      namespaceIds: Object.freeze(["namespace-room"]),
      domainIds: Object.freeze(["grant-domain-participants"]),
      executionDeadline: NOW + 30 * 60 * 1_000 + 1_000,
    });
    if (leased.status !== "leased") {
      throw new Error(`lease failed: ${leased.reason}`);
    }
    expect(await registry.executeWithCapability(leased.lease, {
      execute: () => Object.freeze({
        status: "unavailable" as const,
        reason: "content_unavailable" as const,
      }),
    })).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
    });

    state.setNow(NOW + 30 * 60 * 1_000);
    expect(registry.resolve({
      sessionId: registration.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_idle_expired",
    });
    expect(state.destroyed).toEqual([capability]);
    expect(secret).toEqual(new Uint8Array(4));
  });

  test("closes and wipes when adapted current-authority validation denies", async () => {
    const state = fixture();
    const registry = state.createRegistry();
    const { capability, secret } = state.createCapability();
    const registration = registry.register({
      capability,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt", "encrypt"]),
      sessionDeadline: NOW + FIVE_MINUTES_MS,
    });
    if (registration.status !== "registered") {
      throw new Error(`registration failed: ${registration.reason}`);
    }
    const leased = registry.leaseAuthorizationSetOperation({
      view: registration.rootView,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt", "encrypt"]),
      namespaceIds: Object.freeze(["namespace-room"]),
      domainIds: Object.freeze(["grant-domain-participants"]),
      executionDeadline: NOW + 30_000,
    });
    if (leased.status !== "leased") {
      throw new Error(`lease failed: ${leased.reason}`);
    }
    expect(await registry.executeWithCapability(leased.lease, {
      execute: () => Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_unavailable" as const,
      }),
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(registry.resolve({
      sessionId: registration.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_unavailable",
    });
    expect(state.destroyed).toEqual([capability]);
    expect(secret).toEqual(new Uint8Array(4));
  });

  test("fails closed if a generic registry uses the legacy content path", async () => {
    const state = fixture();
    const registry = state.createRegistry();
    const { capability, secret } = state.createCapability();
    const registration = registry.register({
      capability,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt"]),
      sessionDeadline: NOW + FIVE_MINUTES_MS,
    });
    if (registration.status !== "registered") {
      throw new Error(`registration failed: ${registration.reason}`);
    }
    const leased = registry.leaseOperation({
      view: registration.rootView,
      entrypointId: "foreground.main",
      operation: "decrypt",
      namespaceId: "namespace-room",
      domainId: "grant-domain-participants",
      executionDeadline: NOW + 30_000,
    });
    if (leased.status !== "leased") {
      throw new Error(`lease failed: ${leased.reason}`);
    }

    expect(await registry.execute(
      leased.lease,
      () => "must-not-run",
    )).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(state.destroyed).toEqual([capability]);
    expect(secret).toEqual(new Uint8Array(4));
  });

  test("rejects signed-id, opaque-reference, and binding substitution", () => {
    const state = fixture();
    const registry = state.createRegistry();
    const { capability } = state.createCapability();
    const registration = registry.register({
      capability,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt", "encrypt"]),
      sessionDeadline: NOW + FIVE_MINUTES_MS,
    });
    if (registration.status !== "registered") {
      throw new Error(`registration failed: ${registration.reason}`);
    }

    expect(registry.resolve({
      sessionId: capability.authorizationId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_unavailable",
    });
    expect(registry.resolve({
      sessionId: `${registration.sessionId}-substituted`,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_unavailable",
    });
    expect(registry.resolve({
      sessionId: registration.sessionId,
      authenticatedBinding: binding({ issuingDeviceId: "device-other" }),
    })).toEqual({
      status: "unavailable",
      reason: "binding_mismatch",
    });
    expect(state.destroyed).toEqual([]);
  });

  test("process loss wipes the capability and cannot resurrect its reference", () => {
    const state = fixture();
    const firstProcess = state.createRegistry();
    const { capability, secret } = state.createCapability();
    const registration = firstProcess.register({
      capability,
      authenticatedBinding: binding(),
      allowedOperations: Object.freeze(["decrypt", "encrypt"]),
      sessionDeadline: NOW + FIVE_MINUTES_MS,
    });
    if (registration.status !== "registered") {
      throw new Error(`registration failed: ${registration.reason}`);
    }

    firstProcess.close();
    expect(secret).toEqual(new Uint8Array(4));
    expect(state.destroyed).toEqual([capability]);

    const replacementProcess = state.createRegistry();
    expect(replacementProcess.resolve({
      sessionId: registration.sessionId,
      authenticatedBinding: binding(),
    })).toEqual({
      status: "unavailable",
      reason: "session_unavailable",
    });
    replacementProcess.close();
  });
});
