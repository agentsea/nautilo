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
  type AgentRuntimeAuthorizationPlan,
  type AgentRuntimeRotationPersistenceAuthorization,
  type Rng,
} from "@nautilo/lattice-crypto";
import type {
  AgentRuntimeConfigObjectV2,
} from "@nautilo/lattice-crypto/wire";

import {
  coordinateProtectedAgentRuntimeRotation,
  createProtectedAgentRuntimeRotationSourcePort,
  createProtectedAgentRuntimeRotationTargetPort,
} from "../../src/invocation/protected-agent-runtime-rotation";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage";

const NOW = 7_000_000;
const CONFIG_DEK = new Uint8Array(32).fill(0xc1);

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

async function fixture() {
  const crypto = new LatticeCrypto(
    seededRng(0x235_60),
    { now: () => NOW },
  );
  const managerSigning = crypto.generateSigningKeyPair();
  const targetSigningA = crypto.generateSigningKeyPair();
  const targetSigningB = crypto.generateSigningKeyPair();
  const initialRoot = new Uint8Array(32).fill(0x31);
  const targetRootA = new Uint8Array(32).fill(0x41);
  const targetRootB = new Uint8Array(32).fill(0x42);
  const currentManager = {
    managerHumanId: humanId("alice"),
    managerAuthorizationRevision: authorizationRevision(9),
    managerDeviceId: cryptoDeviceId("alice-phone"),
  } as const;
  const prepared = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-runtime-initialization",
    agentId: agentId("genie"),
    authorizationRevision: authorizationRevision(20),
    configObjects: [{
      objectId: objectId("config-a"),
      configRevision: authorizationRevision(2),
      plaintextDek: CONFIG_DEK,
    }],
    domains: [{
      domainId: cryptoDomainId("domain-old"),
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(20),
      committerDeviceId: cryptoDeviceId("alice-phone"),
      domainRoot: initialRoot,
      committerSigningPrivateKey: managerSigning.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () =>
      managerSigning.publicKey,
    manager: currentManager,
    managerSigningPrivateKey: managerSigning.privateKey,
    resolveCurrentManagerAuthority: () => managerSigning.publicKey,
  });
  const { storage } = createFakeLatticeStorage();
  expect(await persistAgentRuntimeInitialization({
    crypto,
    storage,
    prepared,
    resolveCurrentAuthorization: () => ({
      currentState: prepared.intended.runtime,
      currentManager,
      currentManagerSigningPublicKey: managerSigning.publicKey,
      domains: [{
        domainId: cryptoDomainId("domain-old"),
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(20),
        committerDeviceId: cryptoDeviceId("alice-phone"),
        committerSigningPublicKey: managerSigning.publicKey,
      }],
    }),
  })).toBe("inserted");

  const activeConfigObjects: readonly AgentRuntimeConfigObjectV2[] =
    prepared.intended.configObjects.map((record) =>
      Object.freeze({
        agentId: agentId(record.agentId),
        objectId: objectId(record.objectId),
        configRevision:
          authorizationRevision(record.configRevision),
        runtimeGeneration:
          agentRuntimeGeneration(record.runtimeGeneration),
        wrappedDek: record.wrappedDek.ciphertext.slice(),
      })
    );
  const remainingDomains = [{
    domainId: cryptoDomainId("domain-a"),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(21),
    committerDeviceId: cryptoDeviceId("device-a"),
  }, {
    domainId: cryptoDomainId("domain-b"),
    domainEpoch: domainEpoch(5),
    agentAuthorizationRevision: authorizationRevision(21),
    committerDeviceId: cryptoDeviceId("device-b"),
  }] as const;
  const plan: AgentRuntimeAuthorizationPlan = {
    operationId: "operation-global-rotation",
    agentId: agentId("genie"),
    oldAuthorizationRevision: authorizationRevision(20),
    newAuthorizationRevision: authorizationRevision(21),
    currentRuntimeGeneration: agentRuntimeGeneration(0),
    runtimeRotationRequired: true,
    currentManager,
    activeConfigInventory: prepared.intended.configInventory,
    remainingDomains,
  };
  const rotationManagerAuthority = () => managerSigning.publicKey;
  const handoffManagerAuthority = () => managerSigning.publicKey;
  const targetAuthority = ({ target }: {
    readonly target: { readonly committerDeviceId: string };
  }) =>
    target.committerDeviceId === "device-a"
      ? targetSigningA.publicKey
      : targetSigningB.publicKey;
  const currentAuthorization:
    AgentRuntimeRotationPersistenceAuthorization = {
      currentState: prepared.intended.runtime,
      currentManager,
      currentManagerSigningPublicKey: managerSigning.publicKey,
      remainingDomains: remainingDomains.map((domain) => ({
        ...domain,
        committerSigningPublicKey:
          domain.committerDeviceId === "device-a"
            ? targetSigningA.publicKey
            : targetSigningB.publicKey,
      })),
    };
  const source = createProtectedAgentRuntimeRotationSourcePort({
    crypto,
    currentState: prepared.intended.runtime,
    currentRuntime: prepared.runtime,
    plan,
    activeConfigObjects,
    resolveCurrentManagerAuthority: rotationManagerAuthority,
    resolveCurrentHandoffManagerAuthority:
      handoffManagerAuthority,
    resolveCurrentTargetCommitter: targetAuthority,
    managerSigningPrivateKey: managerSigning.privateKey,
  });
  const targetA =
    await createProtectedAgentRuntimeRotationTargetPort({
      crypto,
      domainId: "domain-a",
      targetDomainRoot: targetRootA,
      targetCommitterSigningPrivateKey: targetSigningA.privateKey,
      resolveCurrentManagerAuthority: handoffManagerAuthority,
      resolveCurrentTargetCommitter: targetAuthority,
      ttlMs: 60_000,
    });
  const targetB =
    await createProtectedAgentRuntimeRotationTargetPort({
      crypto,
      domainId: "domain-b",
      targetDomainRoot: targetRootB,
      targetCommitterSigningPrivateKey: targetSigningB.privateKey,
      resolveCurrentManagerAuthority: handoffManagerAuthority,
      resolveCurrentTargetCommitter: targetAuthority,
      ttlMs: 60_000,
    });

  return {
    crypto,
    currentAuthorization,
    handoffManagerAuthority,
    prepared,
    rotationManagerAuthority,
    source,
    storage,
    targetA,
    targetAuthority,
    targetB,
  };
}

describe("Wave 8 protected global Agent Runtime rotation", () => {
  test("keeps source and target custody non-enumerable to the coordinator", async () => {
    const state = await fixture();
    expect(Object.keys(state.source)).toEqual([
      "publicCandidate",
      "respond",
      "close",
    ]);
    expect(Object.keys(state.targetA)).toEqual([
      "domainId",
      "challenge",
      "complete",
      "close",
    ]);
    const serialized = JSON.stringify({
      source: state.source,
      target: state.targetA,
    });
    expect(serialized).not.toContain(
      Buffer.from(new Uint8Array(32).fill(0x31)).toString("base64"),
    );
    expect(serialized).not.toContain(
      Buffer.from(new Uint8Array(32).fill(0x41)).toString("base64"),
    );
    state.source.close();
    state.targetA.close();
    state.targetB.close();
  });

  test("rejects duplicate or unrelated target ports and closes all custody", async () => {
    const duplicateState = await fixture();
    expect(coordinateProtectedAgentRuntimeRotation({
      crypto: duplicateState.crypto,
      storage: duplicateState.storage,
      source: duplicateState.source,
      targets: [
        duplicateState.targetA,
        duplicateState.targetA,
        duplicateState.targetB,
      ],
      resolveChallengeReservationAuthorization: () =>
        duplicateState.currentAuthorization,
      resolveRotationPersistenceAuthorization: () =>
        duplicateState.currentAuthorization,
      resolveCurrentRotationManagerAuthority:
        duplicateState.rotationManagerAuthority,
      resolveCurrentTargetCommitter: duplicateState.targetAuthority,
    })).rejects.toThrow(
      "targets must exactly match the candidate",
    );
    expect(
      duplicateState.source.respond(
        new Uint8Array(),
        duplicateState.source.publicCandidate.targetIntents[0]!,
      ),
    ).rejects.toThrow("source is closed");

    const extraState = await fixture();
    let extraClosed = false;
    const extraTarget = Object.freeze({
      domainId: "domain-unrelated",
      challenge: () => Promise.reject(new Error("must not run")),
      complete: () => Promise.reject(new Error("must not run")),
      close: () => {
        extraClosed = true;
      },
    });
    expect(coordinateProtectedAgentRuntimeRotation({
      crypto: extraState.crypto,
      storage: extraState.storage,
      source: extraState.source,
      targets: [extraState.targetA, extraState.targetB, extraTarget],
      resolveChallengeReservationAuthorization: () =>
        extraState.currentAuthorization,
      resolveRotationPersistenceAuthorization: () =>
        extraState.currentAuthorization,
      resolveCurrentRotationManagerAuthority:
        extraState.rotationManagerAuthority,
      resolveCurrentTargetCommitter: extraState.targetAuthority,
    })).rejects.toThrow(
      "targets must exactly match the candidate",
    );
    expect(extraClosed).toBe(true);
  });

  test("coordinates two client-held targets and atomically publishes one complete new generation", async () => {
    const state = await fixture();
    const result = await coordinateProtectedAgentRuntimeRotation({
      crypto: state.crypto,
      storage: state.storage,
      source: state.source,
      targets: [state.targetA, state.targetB],
      resolveChallengeReservationAuthorization: () =>
        state.currentAuthorization,
      resolveRotationPersistenceAuthorization: async () => {
        const current =
          await state.storage.getAgentRuntimeAtomicState("genie");
        return current === null
          ? null
          : {
            ...state.currentAuthorization,
            currentState: current.runtime,
          };
      },
      resolveCurrentRotationManagerAuthority:
        state.rotationManagerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    expect(result).toEqual({
      status: "completed",
      persistence: "applied",
    });
    const stored =
      await state.storage.getAgentRuntimeAtomicState("genie");
    expect(stored?.runtime).toEqual({
      agentId: agentId("genie"),
      authorizationRevision: authorizationRevision(21),
      runtimeGeneration: agentRuntimeGeneration(1),
    });
    expect(
      stored?.domainEnvelopes.map((record) => record.domainId),
    ).toEqual(["domain-a", "domain-b"]);
    expect(stored?.configObjects).toHaveLength(1);
    expect(stored?.configObjects[0]?.runtimeGeneration).toBe(1);
    expect(JSON.stringify(stored)).not.toContain(
      Buffer.from(CONFIG_DEK).toString("hex"),
    );
  });

  test("returns pending and closes custody when a required target is absent", async () => {
    const state = await fixture();
    const firstIntent =
      state.source.publicCandidate.targetIntents[0]!;
    expect(await coordinateProtectedAgentRuntimeRotation({
      crypto: state.crypto,
      storage: state.storage,
      source: state.source,
      targets: [state.targetA],
      resolveChallengeReservationAuthorization: () =>
        state.currentAuthorization,
      resolveRotationPersistenceAuthorization: async () => {
        const current =
          await state.storage.getAgentRuntimeAtomicState("genie");
        return current === null
          ? null
          : {
            ...state.currentAuthorization,
            currentState: current.runtime,
          };
      },
      resolveCurrentRotationManagerAuthority:
        state.rotationManagerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    })).toEqual({
      status: "pending",
      reason: "target_unavailable",
      unavailableDomainIds: ["domain-b"],
    });
    expect(
      state.source.respond(new Uint8Array(), firstIntent),
    ).rejects.toThrow("source is closed");
  });

  test("preserves the old complete generation when reservation or persistence authority is stale", async () => {
    const reservationState = await fixture();
    expect(await coordinateProtectedAgentRuntimeRotation({
      crypto: reservationState.crypto,
      storage: reservationState.storage,
      source: reservationState.source,
      targets: [reservationState.targetA, reservationState.targetB],
      resolveChallengeReservationAuthorization: () => null,
      resolveRotationPersistenceAuthorization: () => null,
      resolveCurrentRotationManagerAuthority:
        reservationState.rotationManagerAuthority,
      resolveCurrentTargetCommitter:
        reservationState.targetAuthority,
    })).toEqual({
      status: "pending",
      reason: "challenge_reservation_stale",
      unavailableDomainIds: [],
    });
    expect(
      (await reservationState.storage.getAgentRuntimeAtomicState(
        "genie",
      ))?.runtime,
    ).toEqual(reservationState.prepared.intended.runtime);

    const persistenceState = await fixture();
    expect(await coordinateProtectedAgentRuntimeRotation({
      crypto: persistenceState.crypto,
      storage: persistenceState.storage,
      source: persistenceState.source,
      targets: [persistenceState.targetA, persistenceState.targetB],
      resolveChallengeReservationAuthorization: () =>
        persistenceState.currentAuthorization,
      resolveRotationPersistenceAuthorization: () => null,
      resolveCurrentRotationManagerAuthority:
        persistenceState.rotationManagerAuthority,
      resolveCurrentTargetCommitter:
        persistenceState.targetAuthority,
    })).toEqual({
      status: "pending",
      reason: "rotation_persistence_stale",
      unavailableDomainIds: [],
    });
    const afterStalePersistence =
      await persistenceState.storage.getAgentRuntimeAtomicState(
        "genie",
      );
    expect(afterStalePersistence?.runtime)
      .toEqual(persistenceState.prepared.intended.runtime);
    expect(
      afterStalePersistence?.domainEnvelopes.map(
        (record) => record.domainId,
      ),
    ).toEqual(["domain-old"]);
  });

  test("retries the exact candidate after an outcome-unknown commit", async () => {
    const state = await fixture();
    let firstCommit = true;
    const storage = {
      getAgentRuntimeAtomicState:
        state.storage.getAgentRuntimeAtomicState.bind(state.storage),
      compareAndSwapAgentRuntimeChallengeReservations:
        state.storage.compareAndSwapAgentRuntimeChallengeReservations
          .bind(state.storage),
      compareAndSwapAgentRuntimeRotation: async (
        authorized: Parameters<
          typeof state.storage.compareAndSwapAgentRuntimeRotation
        >[0],
      ) => {
        const result =
          await state.storage.compareAndSwapAgentRuntimeRotation(
            authorized,
          );
        if (firstCommit) {
          firstCommit = false;
          throw new Error("synthetic connection loss after commit");
        }
        return result;
      },
    };
    expect(await coordinateProtectedAgentRuntimeRotation({
      crypto: state.crypto,
      storage,
      source: state.source,
      targets: [state.targetA, state.targetB],
      resolveChallengeReservationAuthorization: () =>
        state.currentAuthorization,
      resolveRotationPersistenceAuthorization: async () => {
        const current =
          await state.storage.getAgentRuntimeAtomicState("genie");
        return current === null
          ? null
          : {
            ...state.currentAuthorization,
            currentState: current.runtime,
          };
      },
      resolveCurrentRotationManagerAuthority:
        state.rotationManagerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    })).toEqual({
      status: "completed",
      persistence: "duplicate",
    });
    expect(
      (await state.storage.getAgentRuntimeAtomicState("genie"))
        ?.runtime.runtimeGeneration,
    ).toBe(agentRuntimeGeneration(1));
  });

  test("retries the exact challenge reservation after an outcome-unknown commit", async () => {
    const state = await fixture();
    let firstReservation = true;
    const storage = {
      getAgentRuntimeAtomicState:
        state.storage.getAgentRuntimeAtomicState.bind(state.storage),
      compareAndSwapAgentRuntimeChallengeReservations: async (
        authorized: Parameters<
          typeof state.storage
            .compareAndSwapAgentRuntimeChallengeReservations
        >[0],
      ) => {
        const result =
          await state.storage
            .compareAndSwapAgentRuntimeChallengeReservations(
              authorized,
            );
        if (firstReservation) {
          firstReservation = false;
          throw new Error(
            "synthetic connection loss after reservation",
          );
        }
        return result;
      },
      compareAndSwapAgentRuntimeRotation:
        state.storage.compareAndSwapAgentRuntimeRotation
          .bind(state.storage),
    };
    expect(await coordinateProtectedAgentRuntimeRotation({
      crypto: state.crypto,
      storage,
      source: state.source,
      targets: [state.targetA, state.targetB],
      resolveChallengeReservationAuthorization: () =>
        state.currentAuthorization,
      resolveRotationPersistenceAuthorization: async () => {
        const current =
          await state.storage.getAgentRuntimeAtomicState("genie");
        return current === null
          ? null
          : {
            ...state.currentAuthorization,
            currentState: current.runtime,
          };
      },
      resolveCurrentRotationManagerAuthority:
        state.rotationManagerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    })).toEqual({
      status: "completed",
      persistence: "applied",
    });
  });
});
