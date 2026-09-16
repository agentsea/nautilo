import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  objectId,
  persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
  type AgentRuntimeAuthorizationTransitionPersistenceAuthorization,
  type AgentRuntimeAuthorizationTransitionPlan,
  type AgentRuntimeAuthorizationDomain,
  type AgentRuntimeRotationPersistenceAuthorization,
  type Rng,
} from "@nautilo/lattice-crypto";

import {
  coordinateProtectedAgentRuntimeAuthorizationTransition,
  createProtectedAgentRuntimeAuthorizationTransitionSourcePort,
} from "../../src/invocation/protected-agent-runtime-authorization-transition";
import {
  createProtectedAgentRuntimeRotationTargetPort,
} from "../../src/invocation/protected-agent-runtime-rotation";
import {
  createFakeLatticeStorage,
} from "../../src/testing/fake-lattice-storage";

const NOW = 7_235_000;
const CONFIG_DEK = new Uint8Array(32).fill(0xc8);

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(length: number): Uint8Array {
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

async function fixture(kind: "add" | "remove" = "add") {
  const crypto = new LatticeCrypto(
    seededRng(kind === "add" ? 0x235_81 : 0x235_82),
    { now: () => NOW },
  );
  const managerSigning = crypto.generateSigningKeyPair();
  const currentSigning = crypto.generateSigningKeyPair();
  const targetSigning = crypto.generateSigningKeyPair();
  const currentDomain = Object.freeze({
    domainId: cryptoDomainId("domain-a"),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(20),
    committerDeviceId: cryptoDeviceId("device-a"),
  });
  const targetDomain = Object.freeze({
    domainId: cryptoDomainId("domain-b"),
    domainEpoch: domainEpoch(5),
    agentAuthorizationRevision: authorizationRevision(21),
    committerDeviceId: cryptoDeviceId("device-b"),
  });
  const currentManager = Object.freeze({
    managerHumanId: humanId("alice"),
    managerAuthorizationRevision: authorizationRevision(9),
    managerDeviceId: cryptoDeviceId("alice-phone"),
  });
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: `operation-runtime-initialization-${kind}`,
    agentId: agentId("genie"),
    authorizationRevision: authorizationRevision(20),
    configObjects: [{
      objectId: objectId("config-a"),
      configRevision: authorizationRevision(2),
      plaintextDek: CONFIG_DEK,
    }],
    domains: [{
      ...currentDomain,
      domainRoot: new Uint8Array(32).fill(0x31),
      committerSigningPrivateKey: currentSigning.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () =>
      currentSigning.publicKey,
    manager: currentManager,
    managerSigningPrivateKey: managerSigning.privateKey,
    resolveCurrentManagerAuthority: () => managerSigning.publicKey,
  });
  const fake = createFakeLatticeStorage();
  expect(await persistAgentRuntimeInitialization({
    crypto,
    storage: fake.storage,
    prepared: initialized,
    resolveCurrentAuthorization: () => ({
      currentState: initialized.intended.runtime,
      currentManager,
      currentManagerSigningPublicKey: managerSigning.publicKey,
      domains: [{
        ...currentDomain,
        committerSigningPublicKey: currentSigning.publicKey,
      }],
    }),
  })).toBe("inserted");

  const remainingDomains =
    kind === "add"
      ? Object.freeze([currentDomain, targetDomain])
      : Object.freeze([]);
  const plan: AgentRuntimeAuthorizationTransitionPlan = Object.freeze({
    operationId: `operation-runtime-authorization-${kind}`,
    agentId: agentId("genie"),
    oldAuthorizationRevision: authorizationRevision(20),
    newAuthorizationRevision: authorizationRevision(21),
    currentRuntimeGeneration: agentRuntimeGeneration(0),
    currentManager,
    activeConfigInventory: initialized.intended.configInventory,
    currentDomains: Object.freeze([currentDomain]),
    remainingDomains,
    refreshedDomainIds:
      kind === "add" ? Object.freeze(["domain-b"]) : Object.freeze([]),
  });
  const managerAuthority = () => managerSigning.publicKey;
  const targetAuthority = ({ target }: {
    readonly target: { readonly committerDeviceId: string };
  }) =>
    target.committerDeviceId === "device-a"
      ? currentSigning.publicKey
      : targetSigning.publicKey;
  const source =
    createProtectedAgentRuntimeAuthorizationTransitionSourcePort({
      crypto,
      currentState: initialized.intended.runtime,
      currentRuntime: initialized.runtime,
      plan,
      resolveCurrentManagerAuthority: managerAuthority,
      resolveCurrentHandoffManagerAuthority: managerAuthority,
      resolveCurrentTargetCommitter: targetAuthority,
      managerSigningPrivateKey: managerSigning.privateKey,
    });
  const target = kind === "add"
    ? await createProtectedAgentRuntimeRotationTargetPort({
      crypto,
      domainId: targetDomain.domainId,
      targetDomainRoot: new Uint8Array(32).fill(0x32),
      targetCommitterSigningPrivateKey: targetSigning.privateKey,
      resolveCurrentManagerAuthority: managerAuthority,
      resolveCurrentTargetCommitter: targetAuthority,
      ttlMs: 60_000,
    })
    : null;

  const challengeAuthorization =
    async (
      context: Readonly<{
        readonly remainingDomains:
          readonly AgentRuntimeAuthorizationDomain[];
      }>,
    ): Promise<AgentRuntimeRotationPersistenceAuthorization | null> => {
      const current =
        await fake.storage.getAgentRuntimeAtomicState("genie");
      return current === null
        ? null
        : {
          currentState: current.runtime,
          currentManager,
          currentManagerSigningPublicKey: managerSigning.publicKey,
          remainingDomains: context.remainingDomains.map((domain) => ({
            ...domain,
            committerSigningPublicKey:
              domain.domainId === "domain-a"
                ? currentSigning.publicKey
                : targetSigning.publicKey,
          })),
        };
    };
  const transitionAuthorization =
    async (): Promise<
      AgentRuntimeAuthorizationTransitionPersistenceAuthorization | null
    > => {
      const current =
        await fake.storage.getAgentRuntimeAtomicState("genie");
      return current === null
        ? null
        : {
          currentState: current.runtime,
          currentManager,
          managerSigningPublicKey: managerSigning.publicKey,
          currentDomains: [{
            ...currentDomain,
            committerSigningPublicKey: currentSigning.publicKey,
          }],
          remainingDomains: remainingDomains.map((domain) => ({
            ...domain,
            committerSigningPublicKey:
              domain.domainId === "domain-a"
                ? currentSigning.publicKey
                : targetSigning.publicKey,
          })),
        };
    };

  return {
    challengeAuthorization,
    crypto,
    fake,
    initialized,
    source,
    target,
    transitionAuthorization,
  };
}

describe("Wave 8 protected Agent Runtime authorization transition", () => {
  test("keeps Runtime and signing custody out of the coordinator surface", async () => {
    const state = await fixture("add");
    expect(Object.keys(state.source)).toEqual([
      "publicCandidate",
      "respond",
      "close",
    ]);
    const serialized = JSON.stringify(state.source);
    expect(serialized).not.toContain(
      JSON.stringify([...state.initialized.runtime.key]),
    );
    expect(serialized).not.toContain(
      Buffer.from(CONFIG_DEK).toString("hex"),
    );
    state.source.close();
    state.target?.close();
  });

  test("installs a first Domain edge without rotating Runtime or config", async () => {
    const state = await fixture("add");
    const before =
      await state.fake.storage.getAgentRuntimeAtomicState("genie");
    expect(await coordinateProtectedAgentRuntimeAuthorizationTransition({
      crypto: state.crypto,
      storage: state.fake.storage,
      source: state.source,
      targets: [state.target!],
      resolveChallengeReservationAuthorization:
        state.challengeAuthorization,
      resolveTransitionPersistenceAuthorization:
        state.transitionAuthorization,
    })).toEqual({
      status: "completed",
      persistence: "applied",
    });
    const after =
      await state.fake.storage.getAgentRuntimeAtomicState("genie");
    expect(after?.runtime).toEqual({
      agentId: agentId("genie"),
      authorizationRevision: authorizationRevision(21),
      runtimeGeneration: agentRuntimeGeneration(0),
    });
    expect(after?.configInventory).toEqual(before?.configInventory);
    expect(after?.configObjects).toEqual(before?.configObjects);
    expect(after?.domainEnvelopes.map((record) => record.domainId))
      .toEqual(["domain-a", "domain-b"]);
    expect(after?.domainEnvelopes[0]?.envelopeBytes)
      .toEqual(before?.domainEnvelopes[0]?.envelopeBytes);
    expect(after?.challengeConsumptions).toEqual([
      expect.objectContaining({ consumed: true }),
    ]);
    expect(
      state.source.respond(
        new Uint8Array(),
        state.source.publicCandidate.targetIntents[0]!,
      ),
    ).rejects.toThrow("source is closed");
  });

  test("removes the final Domain edge with no target or challenge", async () => {
    const state = await fixture("remove");
    expect(await coordinateProtectedAgentRuntimeAuthorizationTransition({
      crypto: state.crypto,
      storage: state.fake.storage,
      source: state.source,
      targets: [],
      resolveChallengeReservationAuthorization:
        state.challengeAuthorization,
      resolveTransitionPersistenceAuthorization:
        state.transitionAuthorization,
    })).toEqual({
      status: "completed",
      persistence: "applied",
    });
    const after =
      await state.fake.storage.getAgentRuntimeAtomicState("genie");
    expect(after?.runtime.runtimeGeneration)
      .toBe(agentRuntimeGeneration(0));
    expect(after?.runtime.authorizationRevision)
      .toBe(authorizationRevision(21));
    expect(after?.domainEnvelopes).toEqual([]);
    expect(after?.challengeConsumptions).toEqual([]);
  });

  test("leaves old durable state current when a target or authority is unavailable", async () => {
    const missingTarget = await fixture("add");
    expect(await coordinateProtectedAgentRuntimeAuthorizationTransition({
      crypto: missingTarget.crypto,
      storage: missingTarget.fake.storage,
      source: missingTarget.source,
      targets: [],
      resolveChallengeReservationAuthorization:
        missingTarget.challengeAuthorization,
      resolveTransitionPersistenceAuthorization:
        missingTarget.transitionAuthorization,
    })).toEqual({
      status: "pending",
      reason: "target_unavailable",
      unavailableDomainIds: ["domain-b"],
    });
    expect(
      (await missingTarget.fake.storage.getAgentRuntimeAtomicState("genie"))
        ?.runtime.authorizationRevision,
    ).toBe(authorizationRevision(20));
    missingTarget.target?.close();

    const staleReservation = await fixture("add");
    expect(await coordinateProtectedAgentRuntimeAuthorizationTransition({
      crypto: staleReservation.crypto,
      storage: staleReservation.fake.storage,
      source: staleReservation.source,
      targets: [staleReservation.target!],
      resolveChallengeReservationAuthorization: () => null,
      resolveTransitionPersistenceAuthorization:
        staleReservation.transitionAuthorization,
    })).toEqual({
      status: "pending",
      reason: "challenge_reservation_stale",
      unavailableDomainIds: [],
    });
    expect(
      (await staleReservation.fake.storage
        .getAgentRuntimeAtomicState("genie"))
        ?.runtime.authorizationRevision,
    ).toBe(authorizationRevision(20));

    const stalePersistence = await fixture("add");
    expect(await coordinateProtectedAgentRuntimeAuthorizationTransition({
      crypto: stalePersistence.crypto,
      storage: stalePersistence.fake.storage,
      source: stalePersistence.source,
      targets: [stalePersistence.target!],
      resolveChallengeReservationAuthorization:
        stalePersistence.challengeAuthorization,
      resolveTransitionPersistenceAuthorization: () => null,
    })).toEqual({
      status: "pending",
      reason: "transition_persistence_stale",
      unavailableDomainIds: [],
    });
    expect(
      (await stalePersistence.fake.storage
        .getAgentRuntimeAtomicState("genie"))
        ?.runtime.authorizationRevision,
    ).toBe(authorizationRevision(20));
  });

  test("retries only the same reservation and transition after ambiguous commits", async () => {
    const state = await fixture("add");
    state.fake.faults.enqueue({
      operation: "compareAndSwapAgentRuntimeChallengeReservations",
      outcome: "unknown-after-commit",
    });
    state.fake.faults.enqueue({
      operation: "compareAndSwapAgentRuntimeAuthorizationTransition",
      outcome: "unknown-after-commit",
    });
    expect(await coordinateProtectedAgentRuntimeAuthorizationTransition({
      crypto: state.crypto,
      storage: state.fake.storage,
      source: state.source,
      targets: [state.target!],
      resolveChallengeReservationAuthorization:
        state.challengeAuthorization,
      resolveTransitionPersistenceAuthorization:
        state.transitionAuthorization,
    })).toEqual({
      status: "completed",
      persistence: "duplicate",
    });
    expect(state.fake.faults.pendingCount).toBe(0);
    expect(
      (await state.fake.storage.getAgentRuntimeAtomicState("genie"))
        ?.runtime.authorizationRevision,
    ).toBe(authorizationRevision(21));
  });
});
