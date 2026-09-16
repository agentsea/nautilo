import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  prepareAgentRuntimeManagerHandoffChallenge,
  prepareAgentRuntimeManagerHandoffResponse,
  prepareAgentRuntimeManagerHandoffTarget,
} from "../../src/agent-runtime/runtime-handoff-v2.ts";
import {
  authorizeAgentRuntimeInitializationWriteV2,
  consumeAuthorizedAgentRuntimeInitializationWriteV2,
} from "../../src/agent-runtime/initialization-authorized-write.ts";
import {
  authorizeAgentRuntimeChallengeReservationWriteV2,
  authorizeAgentRuntimeRotationWriteV2,
  consumeAuthorizedAgentRuntimeChallengeReservationWriteV2,
  consumeAuthorizedAgentRuntimeRotationWriteV2,
} from "../../src/agent-runtime/storage-authorized-write.ts";
import {
  aggregateAgentRuntimeRotationV2,
  agentRuntimeConfigDekAadV2,
  agentRuntimeConfigInventoryCommitmentV2,
  prepareAgentRuntimeRotationSourceV2,
  type AgentRuntimeAuthorizationPlanV2,
  type AgentRuntimeConfigObjectV2,
  type AtomicAgentRuntimeRotationCandidateV2,
} from "../../src/agent-runtime/runtime-rotation-v2.ts";
import {
  AgentRuntimeChallengeReservationOutcomeUnknownV2,
  AgentRuntimeRotationOutcomeUnknownV2,
  persistAgentRuntimeRotationV2,
  reserveAgentRuntimeRotationChallengesV2,
  type AgentRuntimeRotationPersistenceAuthorizationV2,
} from "../../src/agent-runtime/storage-coordinator.ts";
import {
  InMemoryV2Store,
  type AgentRuntimeAtomicStorageStateV2,
  type AgentRuntimeAtomicStorageWireV2,
  type AgentRuntimeRotationStorageExpectationV2,
} from "../../src/storage/v2-store.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  objectId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import {
  authenticatedAgentRuntimeConfigDekV2,
  opaqueBytes,
} from "../../src/v2-types/opaque.ts";
import {
  agentRuntimeSignerPublicationForTesting,
} from "../../src/testing/index.ts";

function bytes(fill: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function compareByteArrays(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function wireToOpaqueRuntimeState(
  state: AgentRuntimeAtomicStorageWireV2,
): AgentRuntimeAtomicStorageStateV2 {
  return {
    runtime: structuredClone(state.runtime),
    configInventory: structuredClone(state.configInventory),
    configObjects: state.configObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: object.wrappedDekHash.slice(),
      wrappedDek:
        authenticatedAgentRuntimeConfigDekV2(object.wrappedDekBytes),
    })),
    domainEnvelopes: state.domainEnvelopes.map((envelope) => ({
      agentId: envelope.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: envelope.runtimeGeneration,
      committerDeviceId: envelope.committerDeviceId,
      envelopeHash: envelope.envelopeHash.slice(),
      envelopeBytes: opaqueBytes(
        "agent-runtime-domain-envelope",
        envelope.envelopeBytes,
      ),
    })),
    challengeConsumptions: structuredClone(state.challengeConsumptions),
  };
}

function authorizeInitialRuntimeState(
  state: AgentRuntimeAtomicStorageStateV2,
) {
  const expectedDomains = state.domainEnvelopes.map((domain) => ({
    domainId: cryptoDomainId(domain.domainId),
    domainEpoch: domainEpoch(domain.domainEpoch),
    agentAuthorizationRevision:
      authorizationRevision(domain.agentAuthorizationRevision),
    committerDeviceId: cryptoDeviceId(domain.committerDeviceId),
  }));
  const signerPublication = agentRuntimeSignerPublicationForTesting({
    state: state.runtime,
    transitionKind:
      state.runtime.runtimeGeneration === 0
        ? "initialization"
        : "rotation",
  });
  return authorizeAgentRuntimeInitializationWriteV2({
    state,
    authorization: {
      context: {
        purpose: "persist-agent-runtime-initialization",
        operationId: signerPublication.operationId,
        expectedState: state.runtime,
        expectedManager: {
          managerHumanId: signerPublication.managerHumanId,
          managerAuthorizationRevision:
            signerPublication.managerAuthorizationRevision,
          managerDeviceId: signerPublication.managerDeviceId,
        },
        configInventory: state.configInventory,
        expectedDomains,
      },
      currentManager: {
        managerHumanId: signerPublication.managerHumanId,
        managerAuthorizationRevision:
          signerPublication.managerAuthorizationRevision,
        managerDeviceId: signerPublication.managerDeviceId,
      },
      currentManagerSigningPublicKey: bytes(0x72),
      authorizedDomains: expectedDomains.map((domain) => ({
        ...domain,
        committerSigningPublicKey: bytes(0x71),
      })),
    },
    signerPublication,
  });
}

function opaqueToWireRuntimeState(
  state: AgentRuntimeAtomicStorageStateV2,
): AgentRuntimeAtomicStorageWireV2 {
  return {
    runtime: structuredClone(state.runtime),
    configInventory: structuredClone(state.configInventory),
    configObjects: state.configObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: object.wrappedDekHash.slice(),
      wrappedDekBytes: object.wrappedDek.ciphertext.slice(),
    })),
    domainEnvelopes: state.domainEnvelopes.map((envelope) => ({
      agentId: envelope.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: envelope.runtimeGeneration,
      committerDeviceId: envelope.committerDeviceId,
      envelopeHash: envelope.envelopeHash.slice(),
      envelopeBytes: envelope.envelopeBytes.ciphertext.slice(),
    })),
    challengeConsumptions: structuredClone(state.challengeConsumptions),
  };
}

async function rejectedMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

async function setup() {
  const crypto = new LatticeCrypto(
    seededRng(0x225_57_0),
    manualClock(100_000),
  );
  const managerSigning = crypto.generateSigningKeyPair();
  const targetSigningA = crypto.generateSigningKeyPair();
  const targetSigningZ = crypto.generateSigningKeyPair();
  const currentRuntime = Object.freeze({
    agentId: agentId("agent-runtime-store"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(7),
    key: bytes(0x44),
  });
  const makeObject = (
    id: string,
    revision: number,
    fill: number,
  ): AgentRuntimeConfigObjectV2 => {
    const context = {
      agentId: currentRuntime.agentId,
      objectId: objectId(id),
      configRevision: authorizationRevision(revision),
      runtimeGeneration: currentRuntime.generation,
    };
    return Object.freeze({
      ...context,
      wrappedDek: crypto.aeadSeal(
        currentRuntime.key,
        bytes(fill),
        agentRuntimeConfigDekAadV2(context),
      ),
    });
  };
  const activeConfigObjects = [
    makeObject("config-a", 2, 0xa1),
    makeObject("config-z", 5, 0xa2),
  ] as const;
  const remainingDomains = [
    {
      domainId: cryptoDomainId("domain-a"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(12),
      committerDeviceId: cryptoDeviceId("device-a"),
    },
    {
      domainId: cryptoDomainId("domain-z"),
      domainEpoch: domainEpoch(6),
      agentAuthorizationRevision: authorizationRevision(14),
      committerDeviceId: cryptoDeviceId("device-z"),
    },
  ] as const;
  const plan: AgentRuntimeAuthorizationPlanV2 = {
    operationId: "operation-runtime-store-1",
    agentId: currentRuntime.agentId,
    oldAuthorizationRevision: authorizationRevision(20),
    newAuthorizationRevision: authorizationRevision(21),
    currentRuntimeGeneration: currentRuntime.generation,
    runtimeRotationRequired: true,
    currentManager: {
      managerHumanId: humanId("human-manager"),
      managerAuthorizationRevision: authorizationRevision(9),
      managerDeviceId: cryptoDeviceId("device-manager"),
    },
    activeConfigInventory: agentRuntimeConfigInventoryCommitmentV2({
      crypto,
      agentId: currentRuntime.agentId,
      runtimeGeneration: currentRuntime.generation,
      activeConfigObjects,
    }),
    remainingDomains,
  };
  const currentState = {
    agentId: plan.agentId,
    authorizationRevision: plan.oldAuthorizationRevision,
    runtimeGeneration: plan.currentRuntimeGeneration,
  };
  const managerAuthority = () => managerSigning.publicKey;
  const targetAuthority = ({ target }: { readonly target: {
    readonly committerDeviceId: string;
  } }) => target.committerDeviceId === "device-a"
    ? targetSigningA.publicKey
    : targetSigningZ.publicKey;
  const source = prepareAgentRuntimeRotationSourceV2({
    crypto,
    currentState,
    currentRuntime,
    plan,
    activeConfigObjects,
    resolveCurrentManagerAuthority: managerAuthority,
    managerSigningPrivateKey: managerSigning.privateKey,
  });
  if (source.kind !== "rotated") throw new Error("expected Runtime rotation");
  const authorization: AgentRuntimeRotationPersistenceAuthorizationV2 = {
    currentState,
    currentManager: plan.currentManager,
    currentManagerSigningPublicKey: managerSigning.publicKey,
    remainingDomains: remainingDomains.map((domain, index) => ({
      ...domain,
      committerSigningPublicKey:
        index === 0 ? targetSigningA.publicKey : targetSigningZ.publicKey,
    })),
  };
  const unreservedInitial: AgentRuntimeAtomicStorageStateV2 = {
    runtime: currentState,
    configInventory: plan.activeConfigInventory,
    configObjects: activeConfigObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: crypto.hash(object.wrappedDek),
      wrappedDek: opaqueBytes(
        "agent-runtime-config-dek",
        object.wrappedDek,
      ),
    })),
    domainEnvelopes: [],
    challengeConsumptions: [],
  };
  const store = new InMemoryV2Store();
  await store.putAgentRuntimeAtomicStateIfAbsent(
    authorizeInitialRuntimeState(unreservedInitial),
  );
  const challenges = [];
  for (let index = 0; index < source.publicCandidate.targetIntents.length; index += 1) {
    const intent = source.publicCandidate.targetIntents[index]!;
    const signing = index === 0 ? targetSigningA : targetSigningZ;
    const ephemeral = await crypto.generateEncryptionKeyPair();
    const challenge = prepareAgentRuntimeManagerHandoffChallenge({
      crypto,
      plan: intent,
      targetEphemeralPublicKey: ephemeral.publicKey,
      targetCommitterSigningPrivateKey: signing.privateKey,
      resolveCurrentTargetCommitter: targetAuthority,
      ttlMs: 60_000,
    });
    challenges.push({ intent, signing, ephemeral, challenge, index });
  }
  expect(await reserveAgentRuntimeRotationChallengesV2({
    storage: store,
    request: {
      operationId: plan.operationId,
      expectedState: currentState,
      currentManager: plan.currentManager!,
      remainingDomains,
      challengeHashes: challenges.map((entry) =>
        entry.challenge.challengeHash
      ),
    },
    resolveCurrentAuthorization: () => authorization,
  })).toBe("applied");
  const initialWire = await store.getAgentRuntimeAtomicState(
    currentState.agentId,
  );
  if (initialWire === null) throw new Error("missing reserved Runtime state");
  const initialOpaque = wireToOpaqueRuntimeState(initialWire);
  const completions = [];
  for (const entry of challenges) {
    const response = await prepareAgentRuntimeManagerHandoffResponse({
      crypto,
      challengeBytes: entry.challenge.challengeBytes,
      expectedPlan: entry.intent,
      freshRuntime: source.sourceLocal.runtime,
      managerSigningPrivateKey: managerSigning.privateKey,
      resolveCurrentManagerAuthority: managerAuthority,
      resolveCurrentTargetCommitter: targetAuthority,
    });
    completions.push(await prepareAgentRuntimeManagerHandoffTarget({
      crypto,
      challengeBytes: entry.challenge.challengeBytes,
      responseBytes: response,
      expectedPlan: entry.intent,
      trustedChallengeState: {
        challengeHash: entry.challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: entry.ephemeral.privateKey,
      targetDomainRoot: bytes(0x31 + entry.index),
      targetCommitterSigningPrivateKey: entry.signing.privateKey,
      resolveCurrentManagerAuthority: managerAuthority,
      resolveCurrentTargetCommitter: targetAuthority,
    }));
  }
  const candidate = aggregateAgentRuntimeRotationV2({
    crypto,
    publicCandidate: source.publicCandidate,
    completedTargets: completions,
    resolveCurrentManagerAuthority: managerAuthority,
    resolveCurrentTargetCommitter: targetAuthority,
  });
  return {
    crypto,
    candidate,
    authorization,
    unreservedInitial,
    initial: initialWire,
    initialOpaque,
    store,
    currentRuntime,
    source,
    completions,
    challenges,
    plan,
    managerSigning,
    targetSigningA,
    targetSigningZ,
    managerAuthority,
    targetAuthority,
  };
}

function cloneCandidate(
  candidate: AtomicAgentRuntimeRotationCandidateV2,
): AtomicAgentRuntimeRotationCandidateV2 {
  return structuredClone(candidate);
}

function structurallyMutateCandidate(
  candidate: AtomicAgentRuntimeRotationCandidateV2,
  path: readonly (string | number)[],
  mutation: "extra" | "missing" | "substituted",
): AtomicAgentRuntimeRotationCandidateV2 {
  const clone = structuredClone(candidate) as unknown;
  let target = clone;
  for (const segment of path) {
    if (typeof target !== "object" || target === null) {
      throw new Error(`invalid structural-mutation path ${path.join(".")}`);
    }
    target = (target as Record<string | number, unknown>)[segment];
  }
  if (
    typeof target !== "object"
    || target === null
    || target instanceof Uint8Array
  ) {
    throw new Error(`invalid structural-mutation target ${path.join(".")}`);
  }
  const record = target as Record<string, unknown>;
  const originalField = Object.keys(record)[0];
  if (originalField === undefined) {
    throw new Error(`empty structural-mutation target ${path.join(".")}`);
  }
  if (mutation === "extra") {
    record["unexpectedField"] = true;
  } else {
    const originalValue = record[originalField];
    delete record[originalField];
    if (mutation === "substituted") {
      record[`substituted${originalField}`] = originalValue;
    }
  }
  return clone as AtomicAgentRuntimeRotationCandidateV2;
}

async function persist(
  state: Awaited<ReturnType<typeof setup>>,
  overrides?: {
    readonly candidate?: AtomicAgentRuntimeRotationCandidateV2;
    readonly authorization?: AgentRuntimeRotationPersistenceAuthorizationV2;
    readonly resolveCurrentAuthorization?:
      Parameters<typeof persistAgentRuntimeRotationV2>[0][
        "resolveCurrentAuthorization"
      ];
    readonly storage?: {
      getAgentRuntimeAtomicState:
        InMemoryV2Store["getAgentRuntimeAtomicState"];
      compareAndSwapAgentRuntimeRotation:
        InMemoryV2Store["compareAndSwapAgentRuntimeRotation"];
    };
  },
) {
  return persistAgentRuntimeRotationV2({
    crypto: state.crypto,
    storage: overrides?.storage ?? state.store,
    candidate: overrides?.candidate ?? state.candidate,
    resolveCurrentAuthorization:
      overrides?.resolveCurrentAuthorization
      ?? (() => overrides?.authorization ?? state.authorization),
  });
}

function authorizeRotationWrite(
  state: Awaited<ReturnType<typeof setup>>,
  expected: AgentRuntimeRotationStorageExpectationV2,
  intended: AgentRuntimeAtomicStorageStateV2,
) {
  return authorizeAgentRuntimeRotationWriteV2({
    expected,
    intended,
    authorization: {
      context: {
        purpose: "persist-agent-runtime-rotation",
        operationId: state.candidate.operationId,
        expectedState: expected.runtime,
        nextState: intended.runtime,
        expectedManager: state.candidate.currentManager,
      },
      currentState: expected.runtime,
      currentManager: state.candidate.currentManager,
      currentManagerSigningPublicKey:
        state.managerSigning.publicKey,
      remainingDomains: intended.domainEnvelopes.map((domain, index) => ({
        domainId: cryptoDomainId(domain.domainId),
        domainEpoch: domainEpoch(domain.domainEpoch),
        agentAuthorizationRevision:
          authorizationRevision(domain.agentAuthorizationRevision),
        committerDeviceId: cryptoDeviceId(domain.committerDeviceId),
        committerSigningPublicKey: index === 0
          ? state.targetSigningA.publicKey
          : state.targetSigningZ.publicKey,
      })),
    },
    signerPublication:
      state.candidate.publicCandidate.signerPublication,
  });
}

function reservationRequest(
  state: Awaited<ReturnType<typeof setup>>,
  challengeHashes = state.candidate.domainEnvelopes.map((entry) =>
    entry.challengeConsumption.challengeHash
  ),
) {
  const remainingDomains = state.authorization.remainingDomains.map(
    ({
      domainId,
      domainEpoch,
      agentAuthorizationRevision,
      committerDeviceId,
    }) => ({
      domainId,
      domainEpoch,
      agentAuthorizationRevision,
      committerDeviceId,
    }),
  );
  return {
    operationId: state.candidate.operationId,
    expectedState: state.candidate.expectedState,
    currentManager: state.candidate.currentManager,
    remainingDomains,
    challengeHashes,
  };
}

async function prepareNextRotation(
  state: Awaited<ReturnType<typeof setup>>,
) {
  const stored = await state.store.getAgentRuntimeAtomicState(
    state.candidate.nextState.agentId,
  );
  if (stored === null) throw new Error("missing first rotated Runtime state");
  const activeConfigObjects = stored.configObjects.map((object) => ({
    agentId: agentId(object.agentId),
    objectId: objectId(object.objectId),
    configRevision: authorizationRevision(object.configRevision),
    runtimeGeneration:
      agentRuntimeGeneration(object.runtimeGeneration),
    wrappedDek: object.wrappedDekBytes,
  }));
  const plan: AgentRuntimeAuthorizationPlanV2 = {
    operationId: "operation-runtime-store-2",
    agentId: state.candidate.nextState.agentId,
    oldAuthorizationRevision:
      state.candidate.nextState.authorizationRevision,
    newAuthorizationRevision: authorizationRevision(
      state.candidate.nextState.authorizationRevision + 1,
    ),
    currentRuntimeGeneration:
      state.candidate.nextState.runtimeGeneration,
    runtimeRotationRequired: true,
    currentManager: state.candidate.currentManager,
    activeConfigInventory: agentRuntimeConfigInventoryCommitmentV2({
      crypto: state.crypto,
      agentId: state.candidate.nextState.agentId,
      runtimeGeneration:
        state.candidate.nextState.runtimeGeneration,
      activeConfigObjects,
    }),
    remainingDomains: state.authorization.remainingDomains.map(
      ({
        domainId,
        domainEpoch,
        agentAuthorizationRevision,
        committerDeviceId,
      }) => ({
        domainId,
        domainEpoch,
        agentAuthorizationRevision,
        committerDeviceId,
      }),
    ),
  };
  const source = prepareAgentRuntimeRotationSourceV2({
    crypto: state.crypto,
    currentState: state.candidate.nextState,
    currentRuntime: state.source.sourceLocal.runtime,
    plan,
    activeConfigObjects,
    resolveCurrentManagerAuthority: state.managerAuthority,
    managerSigningPrivateKey: state.managerSigning.privateKey,
  });
  if (source.kind !== "rotated") throw new Error("expected second rotation");
  const challenges = [];
  for (
    let index = 0;
    index < source.publicCandidate.targetIntents.length;
    index += 1
  ) {
    const intent = source.publicCandidate.targetIntents[index]!;
    const signing = index === 0
      ? state.targetSigningA
      : state.targetSigningZ;
    const ephemeral = await state.crypto.generateEncryptionKeyPair();
    const challenge = prepareAgentRuntimeManagerHandoffChallenge({
      crypto: state.crypto,
      plan: intent,
      targetEphemeralPublicKey: ephemeral.publicKey,
      targetCommitterSigningPrivateKey: signing.privateKey,
      resolveCurrentTargetCommitter: state.targetAuthority,
      ttlMs: 60_000,
    });
    challenges.push({ intent, signing, ephemeral, challenge, index });
  }
  const authorization: AgentRuntimeRotationPersistenceAuthorizationV2 = {
    currentState: state.candidate.nextState,
    currentManager: plan.currentManager,
    currentManagerSigningPublicKey: state.managerSigning.publicKey,
    remainingDomains: plan.remainingDomains.map((domain, index) => ({
      ...domain,
      committerSigningPublicKey: index === 0
        ? state.targetSigningA.publicKey
        : state.targetSigningZ.publicKey,
    })),
  };
  expect(await reserveAgentRuntimeRotationChallengesV2({
    storage: state.store,
    request: {
      operationId: plan.operationId,
      expectedState: state.candidate.nextState,
      currentManager: plan.currentManager!,
      remainingDomains: plan.remainingDomains,
      challengeHashes: challenges.map((entry) =>
        entry.challenge.challengeHash
      ),
    },
    resolveCurrentAuthorization: () => authorization,
  })).toBe("applied");
  const completions = [];
  for (const entry of challenges) {
    const response = await prepareAgentRuntimeManagerHandoffResponse({
      crypto: state.crypto,
      challengeBytes: entry.challenge.challengeBytes,
      expectedPlan: entry.intent,
      freshRuntime: source.sourceLocal.runtime,
      managerSigningPrivateKey: state.managerSigning.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    completions.push(await prepareAgentRuntimeManagerHandoffTarget({
      crypto: state.crypto,
      challengeBytes: entry.challenge.challengeBytes,
      responseBytes: response,
      expectedPlan: entry.intent,
      trustedChallengeState: {
        challengeHash: entry.challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: entry.ephemeral.privateKey,
      targetDomainRoot: bytes(0x51 + entry.index),
      targetCommitterSigningPrivateKey: entry.signing.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    }));
  }
  const candidate = aggregateAgentRuntimeRotationV2({
    crypto: state.crypto,
    publicCandidate: source.publicCandidate,
    completedTargets: completions,
    resolveCurrentManagerAuthority: state.managerAuthority,
    resolveCurrentTargetCommitter: state.targetAuthority,
  });
  return { candidate, authorization, source, challenges };
}

function collectFieldNames(
  value: unknown,
  names: Set<string>,
  seen = new Set<object>(),
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Uint8Array) return;
  for (const [key, nested] of Object.entries(value)) {
    names.add(key);
    collectFieldNames(nested, names, seen);
  }
}

describe("Agent Runtime rotation atomic storage coordinator", () => {
  test("preserves exact ambiguous-outcome error identity, message, and cause", () => {
    const cause = new Error("adapter outcome unknown");
    for (const [error, name, message] of [
      [
        new AgentRuntimeRotationOutcomeUnknownV2(cause),
        "AgentRuntimeRotationOutcomeUnknownV2",
        "Agent Runtime rotation storage outcome is ambiguous; retry must be explicit",
      ],
      [
        new AgentRuntimeChallengeReservationOutcomeUnknownV2(cause),
        "AgentRuntimeChallengeReservationOutcomeUnknownV2",
        "Agent Runtime challenge reservation storage outcome is ambiguous; retry must be explicit",
      ],
    ] as const) {
      expect(error.name).toBe(name);
      expect(error.message).toBe(message);
      expect(error.cause).toBe(cause);
    }
  });

  test("mutation contract: structural validators reject null, missing, and substituted fields exactly", async () => {
    const state = await setup();
    const valid = reservationRequest(state);
    const reject = (request: typeof valid) =>
      rejectedMessage(() =>
        reserveAgentRuntimeRotationChallengesV2({
          storage: state.store,
          request,
          resolveCurrentAuthorization: () => state.authorization,
        })
      );

    expect(await reject({
      ...valid,
      expectedState: null as never,
    })).toBe("Agent Runtime rotation state must be an object");
    expect(await reject({
      ...valid,
      expectedState: {
        agentId: valid.expectedState.agentId,
        authorizationRevision: valid.expectedState.authorizationRevision,
      } as never,
    })).toBe("Agent Runtime rotation state has an invalid field set");
    expect(await reject({
      ...valid,
      expectedState: {
        authorizationRevision: valid.expectedState.authorizationRevision,
        runtimeGeneration: valid.expectedState.runtimeGeneration,
        substitutedAgentId: valid.expectedState.agentId,
      } as never,
    })).toBe("Agent Runtime rotation state has an invalid field set");
    expect(await reject({
      ...valid,
      remainingDomains: [
        {
          domainEpoch: valid.remainingDomains[0]!.domainEpoch,
          agentAuthorizationRevision:
            valid.remainingDomains[0]!.agentAuthorizationRevision,
          committerDeviceId:
            valid.remainingDomains[0]!.committerDeviceId,
          substitutedDomainId: valid.remainingDomains[0]!.domainId,
        } as never,
        valid.remainingDomains[1]!,
      ],
    })).toBe(
      "Agent Runtime authorization Domain has an invalid field set",
    );
  });

  test("restart-safe rotation rejects every nested structural mutation before storage or authorization", async () => {
    const state = await setup();
    const nodes = [
      ["currentManager"],
      ["expectedConfigInventory"],
      ["configRewraps", 0],
      ["configRewraps", 0, "expected"],
      ["configRewraps", 0, "nextWrappedDek"],
      ["domainEnvelopes", 0],
      ["domainEnvelopes", 0, "expectedDomain"],
      ["domainEnvelopes", 0, "envelopeBytes"],
      ["domainEnvelopes", 0, "challengeConsumption"],
    ] as const;

    for (const path of nodes) {
      for (const mutation of ["extra", "missing", "substituted"] as const) {
        let storageCalls = 0;
        let resolverCalls = 0;
        const error = await rejectedMessage(() =>
          persist(state, {
            candidate: structurallyMutateCandidate(
              state.candidate,
              path,
              mutation,
            ),
            storage: {
              getAgentRuntimeAtomicState: async () => {
                storageCalls += 1;
                return state.initial;
              },
              compareAndSwapAgentRuntimeRotation: async () => {
                storageCalls += 1;
                return "applied";
              },
            },
            resolveCurrentAuthorization: () => {
              resolverCalls += 1;
              return state.authorization;
            },
          })
        );
        expect(error).toContain("invalid field set");
        expect({ storageCalls, resolverCalls }).toEqual({
          storageCalls: 0,
          resolverCalls: 0,
        });
      }
    }

    let storageCalls = 0;
    let resolverCalls = 0;
    const topLevelError = await rejectedMessage(() =>
      persistAgentRuntimeRotationV2({
        crypto: state.crypto,
        storage: {
          getAgentRuntimeAtomicState: async () => {
            storageCalls += 1;
            return state.initial;
          },
          compareAndSwapAgentRuntimeRotation: async () => {
            storageCalls += 1;
            return "applied";
          },
        },
        candidate: state.candidate,
        resolveCurrentAuthorization: () => {
          resolverCalls += 1;
          return state.authorization;
        },
        unexpectedField: true,
      } as never)
    );
    expect(topLevelError).toBe(
      "Agent Runtime rotation persistence input has an invalid field set",
    );
    expect({ storageCalls, resolverCalls }).toEqual({
      storageCalls: 0,
      resolverCalls: 0,
    });
  });

  test("orders portable Domain IDs by their exact UTF-8 bytes including prefixes", async () => {
    const state = await setup();
    const valid = reservationRequest(state);
    const prefixDomains = [
      {
        ...valid.remainingDomains[0]!,
        domainId: cryptoDomainId("a"),
      },
      {
        ...valid.remainingDomains[1]!,
        domainId: cryptoDomainId("aa"),
      },
    ] as const;
    const reserve = (
      remainingDomains: readonly typeof prefixDomains[number][],
    ) => reserveAgentRuntimeRotationChallengesV2({
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeChallengeReservations: async () => "applied",
      },
      request: { ...valid, remainingDomains },
      resolveCurrentAuthorization: () => ({
        ...state.authorization,
        remainingDomains: remainingDomains.map((domain, index) => ({
          ...domain,
          committerSigningPublicKey:
            state.authorization.remainingDomains[index]!
              .committerSigningPublicKey,
        })),
      }),
    });

    expect(await reserve(prefixDomains)).toBe("applied");
    expect(await rejectedMessage(() =>
      reserve([...prefixDomains].reverse())
    )).toBe(
      "Agent Runtime challenge reservation Domains must be sorted and unique",
    );
  });

  test("mutation contract: reservation rejects every hostile request and binds exact authority", async () => {
    const state = await setup();
    const valid = reservationRequest(state);
    const reserve = (
      request: typeof valid,
      overrides?: {
        read?: AgentRuntimeAtomicStorageWireV2 | null;
        authorization?: AgentRuntimeRotationPersistenceAuthorizationV2 | null;
      },
    ) => reserveAgentRuntimeRotationChallengesV2({
      storage: {
        getAgentRuntimeAtomicState: async () =>
          overrides && "read" in overrides
            ? overrides.read ?? null
            : state.initial,
        compareAndSwapAgentRuntimeChallengeReservations: async () => "applied",
      },
      request,
      resolveCurrentAuthorization: () =>
        overrides && "authorization" in overrides
          ? overrides.authorization ?? null
          : state.authorization,
    });
    const invalidRequests: readonly [
      request: typeof valid,
      message: string,
    ][] = [
      [
        { ...valid, unexpected: true } as typeof valid,
        "Agent Runtime challenge reservation request has an invalid field set",
      ],
      [
        { ...valid, operationId: "/" },
        "Agent Runtime challenge reservation operation ID must be 1-128 ASCII bytes using the portable identifier grammar",
      ],
      [
        {
          ...valid,
          currentManager: {
            ...valid.currentManager,
            unexpected: true,
          } as typeof valid.currentManager,
        },
        "Agent Runtime challenge reservation manager has an invalid field set",
      ],
      [
        { ...valid, remainingDomains: "domains" as never },
        "Agent Runtime challenge reservation Domains must be an array",
      ],
      [
        { ...valid, challengeHashes: "hashes" as never },
        "Agent Runtime challenge reservation hashes must be an array",
      ],
      [
        {
          ...valid,
          remainingDomains: Array.from(
            { length: V2_LIMITS.agentGrantDomains + 1 },
            () => valid.remainingDomains[0]!,
          ),
          challengeHashes: Array.from(
            { length: V2_LIMITS.agentGrantDomains + 1 },
            () => valid.challengeHashes[0]!,
          ),
        },
        `Agent Runtime challenge reservation Domain count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
      ],
      [
        {
          ...valid,
          challengeHashes: Array.from(
            { length: V2_LIMITS.agentGrantDomains + 1 },
            () => valid.challengeHashes[0]!,
          ),
        },
        `Agent Runtime challenge reservation hash count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
      ],
      [
        { ...valid, remainingDomains: [], challengeHashes: [] },
        "Agent Runtime challenge reservation must exactly cover remaining Domains",
      ],
      [
        {
          ...valid,
          challengeHashes: valid.challengeHashes.slice(1),
        },
        "Agent Runtime challenge reservation must exactly cover remaining Domains",
      ],
      [
        {
          ...valid,
          remainingDomains: [...valid.remainingDomains].reverse(),
        },
        "Agent Runtime challenge reservation Domains must be sorted and unique",
      ],
      [
        {
          ...valid,
          remainingDomains: [
            valid.remainingDomains[0]!,
            valid.remainingDomains[0]!,
          ],
        },
        "Agent Runtime challenge reservation Domains must be sorted and unique",
      ],
      [
        {
          ...valid,
          challengeHashes: [
            bytes(1, 31),
            valid.challengeHashes[1]!,
          ],
        },
        "Agent Runtime challenge reservation hash must contain exactly 32 bytes",
      ],
      [
        {
          ...valid,
          challengeHashes: [
            valid.challengeHashes[0]!,
            valid.challengeHashes[0]!,
          ],
        },
        "Agent Runtime challenge reservation hashes must be unique",
      ],
    ];
    for (const [request, message] of invalidRequests) {
      expect(await rejectedMessage(() => reserve(request))).toBe(message);
    }

    expect(await reserve(valid, { read: null })).toBe("stale");
    expect(reserve(valid, {
      read: {
        ...state.initial,
        runtime: {
          ...state.initial.runtime,
          agentId: agentId("agent-other"),
        },
      },
    })).rejects.toThrow("config object is inconsistent");
    expect(await reserve(valid, { authorization: null })).toBe("stale");

    for (const authorization of [
      {
        ...state.authorization,
        currentState: {
          ...state.authorization.currentState,
          agentId: agentId("agent-other"),
        },
      },
      {
        ...state.authorization,
        currentManager: {
          ...state.authorization.currentManager!,
          managerHumanId: humanId("human-other"),
        },
      },
      {
        ...state.authorization,
        remainingDomains: state.authorization.remainingDomains.slice(0, 1),
      },
      {
        ...state.authorization,
        remainingDomains: state.authorization.remainingDomains.map(
          (domain, index) => index === 0
            ? { ...domain, domainEpoch: domainEpoch(domain.domainEpoch + 1) }
            : domain,
        ),
      },
    ]) {
      expect(await reserve(valid, { authorization })).toBe("stale");
    }

    let context: unknown;
    let expected: unknown;
    let additions: unknown;
    const request = structuredClone(valid);
    expect(await reserveAgentRuntimeRotationChallengesV2({
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeChallengeReservations: async (
          authorized,
        ) => {
          expected = authorized.expected;
          additions = authorized.additions;
          return "applied";
        },
      },
      request,
      resolveCurrentAuthorization: (received) => {
        context = received;
        request.challengeHashes[0]!.fill(0);
        return state.authorization;
      },
    })).toBe("applied");
    expect(context).toEqual({
      purpose: "reserve-agent-runtime-rotation-challenges",
      operationId: valid.operationId,
      expectedState: valid.expectedState,
      expectedManager: valid.currentManager,
      remainingDomains: valid.remainingDomains,
      challengeHashes: [...valid.challengeHashes].sort((left, right) =>
        left.toHex().localeCompare(right.toHex())
      ),
    });
    expect(expected).toEqual({
      runtime: state.initial.runtime,
      challengeConsumptions: state.initial.challengeConsumptions,
    });
    expect(additions).toEqual(
      [...valid.challengeHashes]
        .sort((left, right) => left.toHex().localeCompare(right.toHex()))
        .map((challengeHash) => ({ challengeHash, consumed: false })),
    );
    expect(await rejectedMessage(() =>
      reserveAgentRuntimeRotationChallengesV2({
        storage: state.store,
        request: valid,
        resolveCurrentAuthorization: null as never,
      })
    )).toBe(
      "Current Agent Runtime challenge reservation authorization resolver is required",
    );
    const reservationCause = new Error("reservation write failed");
    const reservationError = await rejectedMessage(() =>
      reserveAgentRuntimeRotationChallengesV2({
        storage: {
          getAgentRuntimeAtomicState: async () => state.initial,
          compareAndSwapAgentRuntimeChallengeReservations: async () => {
            throw reservationCause;
          },
        },
        request: valid,
        resolveCurrentAuthorization: () => state.authorization,
      })
    );
    expect(reservationError).toBe(
      "Agent Runtime challenge reservation storage outcome is ambiguous; retry must be explicit",
    );
  });

  test("mutation contract: persistence compares every expected and intended field", async () => {
    const state = await setup();
    let context: unknown;
    let expected: AgentRuntimeRotationStorageExpectationV2 | undefined;
    let intended: AgentRuntimeAtomicStorageStateV2 | undefined;
    const captureStorage = {
      getAgentRuntimeAtomicState: async () => state.initial,
      compareAndSwapAgentRuntimeRotation: async (authorized:
        Parameters<
          InMemoryV2Store["compareAndSwapAgentRuntimeRotation"]
        >[0]
      ) => {
        expected = authorized.expected;
        intended = authorized.intended;
        return "applied" as const;
      },
    };
    expect(await persist(state, {
      storage: captureStorage,
      resolveCurrentAuthorization: (received) => {
        context = received;
        return state.authorization;
      },
    })).toBe("applied");
    expect(context).toEqual({
      purpose: "persist-agent-runtime-rotation",
      operationId: state.candidate.operationId,
      expectedState: state.candidate.expectedState,
      nextState: state.candidate.nextState,
      expectedManager: state.candidate.currentManager,
    });
    expect(expected?.runtime).toEqual(state.candidate.expectedState);
    expect(expected?.configObjects).toHaveLength(
      state.candidate.configRewraps.length,
    );
    expect(expected?.challengeConsumptions.every((item) => !item.consumed))
      .toBe(true);
    expect(intended?.runtime).toEqual(state.candidate.nextState);
    expect(intended?.configObjects).toHaveLength(
      state.candidate.configRewraps.length,
    );
    expect(intended?.domainEnvelopes).toHaveLength(
      state.candidate.domainEnvelopes.length,
    );
    expect(intended?.challengeConsumptions.every((item) => item.consumed))
      .toBe(true);
    expect(intended?.domainEnvelopes.map((entry) => ({
      agentId: entry.agentId,
      domainId: entry.domainId,
      domainEpoch: entry.domainEpoch,
      agentAuthorizationRevision: entry.agentAuthorizationRevision,
      runtimeGeneration: entry.runtimeGeneration,
      committerDeviceId: entry.committerDeviceId,
    }))).toEqual(state.authorization.remainingDomains.map((domain) => ({
      agentId: state.candidate.nextState.agentId,
      domainId: domain.domainId,
      domainEpoch: domain.domainEpoch,
      agentAuthorizationRevision: domain.agentAuthorizationRevision,
      runtimeGeneration: state.candidate.nextState.runtimeGeneration,
      committerDeviceId: domain.committerDeviceId,
    })));

    const expectedMutations: ((value: AgentRuntimeAtomicStorageWireV2) => void)[] = [
      (value) => {
        Object.assign(value, { runtime: {
          ...value.runtime,
          agentId: agentId("agent-other"),
        } });
      },
      (value) => {
        Object.assign(value, { runtime: {
          ...value.runtime,
          authorizationRevision:
            authorizationRevision(value.runtime.authorizationRevision + 1),
        } });
      },
      (value) => {
        Object.assign(value, { runtime: {
          ...value.runtime,
          runtimeGeneration:
            agentRuntimeGeneration(value.runtime.runtimeGeneration + 1),
        } });
      },
      (value) => {
        Object.assign(value, { configInventory: {
          ...value.configInventory,
          objectCount: value.configInventory.objectCount + 1,
        } });
      },
      (value) => value.configInventory.digest.fill(0),
      (value) => {
        Object.assign(value, {
          configObjects: value.configObjects.slice(1),
        });
      },
      (value) => {
        Object.assign(value.configObjects[0]!, {
          agentId: agentId("agent-other"),
        });
      },
      (value) => {
        Object.assign(value.configObjects[0]!, {
          objectId: objectId("config-other"),
        });
      },
      (value) => {
        Object.assign(value.configObjects[0]!, {
          configRevision:
            authorizationRevision(value.configObjects[0]!.configRevision + 1),
        });
      },
      (value) => {
        Object.assign(value.configObjects[0]!, {
          runtimeGeneration:
            agentRuntimeGeneration(
              value.configObjects[0]!.runtimeGeneration + 1,
            ),
        });
      },
      (value) => value.configObjects[0]!.wrappedDekHash.fill(0),
      (value) => {
        Object.assign(value, {
          challengeConsumptions: value.challengeConsumptions.slice(1),
        });
      },
      (value) => {
        Object.assign(value.challengeConsumptions[0]!, { consumed: true });
      },
      (value) => value.challengeConsumptions[0]!.challengeHash.fill(0),
    ];
    for (const mutate of expectedMutations) {
      const current = structuredClone(state.initial);
      mutate(current);
      const outcome = await persist(state, {
        storage: {
          getAgentRuntimeAtomicState: async () => current,
          compareAndSwapAgentRuntimeRotation: async () => "applied",
        },
      }).catch((error: unknown) => error);
      expect(outcome).not.toBe("applied");
    }

    await state.store.compareAndSwapAgentRuntimeRotation(
      authorizeRotationWrite(state, expected!, intended!),
    );
    const applied = await state.store.getAgentRuntimeAtomicState(
      state.candidate.nextState.agentId,
    );
    if (applied === null) throw new Error("missing applied state");
    const duplicateAuthorization = {
      ...state.authorization,
      currentState: state.candidate.nextState,
    };
    expect(await persist(state, {
      authorization: duplicateAuthorization,
    })).toBe("duplicate");
    const intendedMutations: ((
      value: AgentRuntimeAtomicStorageWireV2,
    ) => void)[] = [
      ...expectedMutations.slice(0, 11),
      (value) => value.configObjects[0]!.wrappedDekBytes.fill(0),
      (value) => {
        Object.assign(value, {
          domainEnvelopes: value.domainEnvelopes.slice(1),
        });
      },
      (value) => {
        Object.assign(value.domainEnvelopes[0]!, {
          agentId: agentId("agent-other"),
        });
      },
      (value) => {
        Object.assign(value.domainEnvelopes[0]!, {
          domainId: cryptoDomainId("domain-other"),
        });
      },
      (value) => {
        Object.assign(value.domainEnvelopes[0]!, {
          domainEpoch:
            domainEpoch(value.domainEnvelopes[0]!.domainEpoch + 1),
        });
      },
      (value) => {
        Object.assign(value.domainEnvelopes[0]!, {
          agentAuthorizationRevision: authorizationRevision(
            value.domainEnvelopes[0]!.agentAuthorizationRevision + 1,
          ),
        });
      },
      (value) => {
        Object.assign(value.domainEnvelopes[0]!, {
          runtimeGeneration: agentRuntimeGeneration(
            value.domainEnvelopes[0]!.runtimeGeneration + 1,
          ),
        });
      },
      (value) => {
        Object.assign(value.domainEnvelopes[0]!, {
          committerDeviceId: cryptoDeviceId("device-other"),
        });
      },
      (value) => value.domainEnvelopes[0]!.envelopeHash.fill(0),
      (value) => value.domainEnvelopes[0]!.envelopeBytes.fill(0),
      (value) => {
        Object.assign(value, {
          challengeConsumptions: value.challengeConsumptions.slice(1),
        });
      },
      (value) => {
        Object.assign(value.challengeConsumptions[0]!, { consumed: false });
      },
      (value) => value.challengeConsumptions[0]!.challengeHash.fill(0),
    ];
    for (const mutate of intendedMutations) {
      const current = structuredClone(applied);
      mutate(current);
      const outcome = await persist(state, {
        authorization: duplicateAuthorization,
        storage: {
          getAgentRuntimeAtomicState: async () => current,
          compareAndSwapAgentRuntimeRotation: async () => "duplicate",
        },
      }).catch((error: unknown) => error);
      expect(outcome).not.toBe("duplicate");
    }

    expect(persist(state, {
      authorization: {
        ...state.authorization,
        remainingDomains: state.authorization.remainingDomains.slice(1),
      },
      storage: captureStorage,
    })).rejects.toThrow("target is not currently authorized");
    for (const key of [
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
      "committerDeviceId",
    ] as const) {
      const domains = structuredClone(state.authorization.remainingDomains);
      const first = domains[0]!;
      if (key === "domainId") {
        Object.assign(first, { domainId: cryptoDomainId("domain-other") });
      }
      if (key === "domainEpoch") {
        Object.assign(first, {
          domainEpoch: domainEpoch(first.domainEpoch + 1),
        });
      }
      if (key === "agentAuthorizationRevision") {
        Object.assign(first, {
          agentAuthorizationRevision:
            authorizationRevision(first.agentAuthorizationRevision + 1),
        });
      }
      if (key === "committerDeviceId") {
        Object.assign(first, {
          committerDeviceId: cryptoDeviceId("device-other"),
        });
      }
    expect(persist(state, {
        authorization: {
          ...state.authorization,
          remainingDomains: domains,
        },
        storage: captureStorage,
      })).rejects.toThrow("target is not currently authorized");
    }
    expect(persistAgentRuntimeRotationV2({
      crypto: state.crypto,
      candidate: state.candidate,
      storage: captureStorage,
      resolveCurrentAuthorization: null as never,
    })).rejects.toThrow(
      "Current Agent Runtime persistence authorization resolver is required",
    );
    expect(await persist(state, {
      storage: {
        ...captureStorage,
        getAgentRuntimeAtomicState: async () => null,
      },
    })).toBe("stale");
    expect(await persist(state, {
      storage: captureStorage,
      resolveCurrentAuthorization: () => null,
    })).toBe("stale");

    for (const authorization of [
      {
        ...state.authorization,
        currentManager: {
          ...state.authorization.currentManager!,
          managerHumanId: humanId("human-other"),
        },
      },
      {
        ...state.authorization,
        currentManager: {
          ...state.authorization.currentManager!,
          managerAuthorizationRevision: authorizationRevision(10),
        },
      },
      {
        ...state.authorization,
        currentManager: {
          ...state.authorization.currentManager!,
          managerDeviceId: cryptoDeviceId("device-other"),
        },
      },
      {
        ...state.authorization,
        currentState: {
          ...state.authorization.currentState,
          agentId: agentId("agent-other"),
        },
      },
      {
        ...state.authorization,
        currentState: {
          ...state.authorization.currentState,
          authorizationRevision: authorizationRevision(
            state.candidate.nextState.authorizationRevision + 1,
          ),
        },
      },
      {
        ...state.authorization,
        currentState: {
          ...state.authorization.currentState,
          runtimeGeneration: agentRuntimeGeneration(
            state.candidate.nextState.runtimeGeneration + 1,
          ),
        },
      },
    ]) {
      expect(await persist(state, {
        authorization,
        storage: captureStorage,
      })).toBe("stale");
    }
    const rotationCause = new Error("rotation write failed");
    try {
      await persist(state, {
        storage: {
          ...captureStorage,
          compareAndSwapAgentRuntimeRotation: async () => {
            throw rotationCause;
          },
        },
      });
      throw new Error("expected ambiguous Runtime persistence outcome");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeRotationOutcomeUnknownV2);
      expect((error as Error & { cause?: unknown }).cause).toBe(rotationCause);
    }
  });

  test("detaches the intended inventory digest from the hash provider result", async () => {
    const state = await setup();
    const originalHash = state.crypto.hash.bind(state.crypto);
    let latestHashResult: Uint8Array | undefined;
    state.crypto.hash = (data) => {
      latestHashResult = originalHash(data);
      return latestHashResult;
    };

    expect(await persist(state, {
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeRotation: async (authorized) => {
          const expectedDigest =
            authorized.intended.configInventory.digest.slice();
          if (latestHashResult === undefined) {
            throw new Error("expected inventory hash result");
          }
          latestHashResult.fill(0);
          expect(authorized.intended.configInventory.digest)
            .toEqual(expectedDigest);
          return "applied";
        },
      },
    })).toBe("applied");
  });

  test("mutation contract: persistence rejects malformed fresh authorization exactly", async () => {
    const state = await setup();
    const malformed = [
      {
        authorization: 7,
        message:
          "Agent Runtime rotation persistence authorization must be an object",
      },
      {
        authorization: {
          ...state.authorization,
          unexpected: true,
        },
        message:
          "Agent Runtime rotation persistence authorization has an invalid field set",
      },
      {
        authorization: {
          ...state.authorization,
          remainingDomains: {},
        },
        message:
          "Agent Runtime remaining authorization Domains must be an array",
      },
      {
        authorization: {
          ...state.authorization,
          remainingDomains: Array.from(
            { length: V2_LIMITS.agentGrantDomains + 1 },
            () => state.authorization.remainingDomains[0]!,
          ),
        },
        message:
          `Agent Runtime remaining authorization Domain count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
      },
      {
        authorization: {
          ...state.authorization,
          currentManager: {
            ...state.authorization.currentManager!,
            unexpected: true,
          },
        },
        message:
          "Agent Runtime rotation persistence manager has an invalid field set",
      },
    ] as const;
    for (const entry of malformed) {
      expect(await rejectedMessage(() =>
        persist(state, {
          resolveCurrentAuthorization: () =>
            entry.authorization as never,
        })
      )).toBe(entry.message);
    }
    expect(await persist(state, {
      authorization: {
        ...state.authorization,
        currentManager: null,
      },
    })).toBe("stale");
  });

  test("mutation contract: storage snapshots reject every malformed inventory coordinate exactly", async () => {
    const state = await setup();
    const rejectStored = (current: unknown) =>
      rejectedMessage(() =>
        persist(state, {
          storage: {
            getAgentRuntimeAtomicState: async () => current as never,
            compareAndSwapAgentRuntimeRotation: async () => {
              throw new Error("malformed state reached CAS");
            },
          },
        })
      );
    const changed = (
      mutate: (current: AgentRuntimeAtomicStorageWireV2) => void,
    ) => {
      const current = structuredClone(state.initial);
      mutate(current);
      return current;
    };

    expect(await rejectStored(7)).toBe(
      "Stored Agent Runtime atomic state must be an object",
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current, { unexpected: true });
    }))).toBe("Stored Agent Runtime atomic state has an invalid field set");
    for (const field of [
      "configObjects",
      "domainEnvelopes",
      "challengeConsumptions",
    ] as const) {
      expect(await rejectStored(changed((current) => {
        Object.assign(current, { [field]: {} });
      }))).toBe("Stored Agent Runtime inventories must be arrays");
    }
    expect(await rejectStored(changed((current) => {
      Object.assign(current, {
        configObjects: Array.from(
          { length: V2_LIMITS.batchItems + 1 },
          () => current.configObjects[0]!,
        ),
      });
    }))).toBe(
      `Stored Agent Runtime config count exceeds the ${V2_LIMITS.batchItems} limit`,
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current, {
        domainEnvelopes: Array.from(
          { length: V2_LIMITS.agentGrantDomains + 1 },
          () => ({}),
        ),
      });
    }))).toBe(
      `Stored Agent Runtime Domain envelope count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current, {
        challengeConsumptions: Array.from(
          { length: V2_LIMITS.agentGrantDomains + 1 },
          () => current.challengeConsumptions[0]!,
        ),
      });
    }))).toBe(
      `Stored Agent Runtime challenge count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current.configInventory, { unexpected: true });
    }))).toBe(
      "Stored Agent Runtime config inventory has an invalid field set",
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current.configInventory, { digest: bytes(0, 31) });
    }))).toBe(
      "Stored Agent Runtime config inventory digest must contain exactly 32 bytes",
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current.configInventory, {
        objectCount: V2_LIMITS.batchItems + 1,
      });
    }))).toBe(
      `Stored Agent Runtime config inventory count exceeds the ${V2_LIMITS.batchItems} limit`,
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current.configObjects[0]!, { unexpected: true });
    }))).toBe("Stored Agent Runtime config object has an invalid field set");
    expect(await rejectStored(changed((current) => {
      Object.assign(current.configObjects[0]!, {
        wrappedDekBytes: { unexpected: true },
      });
    }))).toBe(
      "Stored Agent Runtime wrapped DEK must be bounded opaque ciphertext",
    );

    const invalidWrappedDeks = [
      {},
      bytes(0, 39),
      bytes(0, V2_LIMITS.wrappedDekBytes + 1),
    ];
    for (const replacement of invalidWrappedDeks) {
      expect(await rejectStored(changed((current) => {
        Object.assign(current.configObjects[0]!, {
          wrappedDekBytes: replacement,
        });
      }))).toBe(
        "Stored Agent Runtime wrapped DEK must be bounded opaque ciphertext",
      );
    }
    for (const length of [40, V2_LIMITS.wrappedDekBytes]) {
      const current = changed((value) => {
        const config = value.configObjects[0]!;
        Object.assign(config, {
          wrappedDekBytes: bytes(0, length),
          wrappedDekHash: state.crypto.hash(bytes(0, length)),
        });
        Object.assign(value, {
          configInventory: agentRuntimeConfigInventoryCommitmentV2({
            crypto: state.crypto,
            agentId: value.runtime.agentId,
            runtimeGeneration: value.runtime.runtimeGeneration,
            activeConfigObjects: value.configObjects.map((object) => ({
              agentId: agentId(object.agentId),
              objectId: objectId(object.objectId),
              configRevision:
                authorizationRevision(object.configRevision),
              runtimeGeneration:
                agentRuntimeGeneration(object.runtimeGeneration),
              wrappedDek: object.wrappedDekBytes,
            })),
          }),
        });
      });
      expect(await persist(state, {
        storage: {
          getAgentRuntimeAtomicState: async () => current,
          compareAndSwapAgentRuntimeRotation: async () => "applied",
        },
      })).toBe("stale");
    }
    expect(await rejectStored(changed((current) => {
      Object.assign(current.configObjects[0]!, {
        wrappedDekHash: bytes(0, 31),
      });
    }))).toBe(
      "Stored Agent Runtime wrapped-DEK hash must contain exactly 32 bytes",
    );

    const {
      committerSigningPublicKey: _unusedCommitterSigningPublicKey,
      ...authorizedDomain
    } = state.authorization.remainingDomains[0]!;
    const domainTemplate = {
      agentId: state.candidate.nextState.agentId,
      ...authorizedDomain,
      runtimeGeneration: state.candidate.nextState.runtimeGeneration,
      envelopeHash: state.crypto.hash(
        state.candidate.domainEnvelopes[0]!.envelopeBytes.ciphertext,
      ),
      envelopeBytes:
        state.candidate.domainEnvelopes[0]!.envelopeBytes.ciphertext.slice(),
    };
    const changedDomain = (
      mutate: (
        envelope: typeof domainTemplate,
        current: AgentRuntimeAtomicStorageWireV2,
      ) => void,
    ) => changed((current) => {
      const envelope = structuredClone(domainTemplate);
      mutate(envelope, current);
      Object.assign(current, { domainEnvelopes: [envelope] });
    });
    expect(await rejectStored(changedDomain((envelope) => {
      Object.assign(envelope, { unexpected: true });
    }))).toBe(
      "Stored Agent Runtime Domain envelope has an invalid field set",
    );
    for (const replacement of [
      {},
      "not-bytes",
    ]) {
      expect(await rejectStored(changedDomain((envelope) => {
        Object.assign(envelope, { envelopeBytes: replacement });
      }))).toBe(
        "Stored Agent Runtime Domain envelope must be opaque ciphertext",
      );
    }
    expect(await rejectStored(changedDomain((envelope) => {
      Object.assign(envelope, {
        envelopeBytes: bytes(0, V2_LIMITS.ciphertextBytes + 1),
      });
    }))).toBe(
      `Stored Agent Runtime Domain envelope bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
    );
    expect(await rejectStored(changedDomain((envelope) => {
      Object.assign(envelope, {
        envelopeBytes: bytes(0, V2_LIMITS.manifestEnvelopeBytes + 1),
      });
    }))).toBe(
      `Stored Agent Runtime aggregate Domain envelope bytes exceeds the ${V2_LIMITS.manifestEnvelopeBytes} limit`,
    );
    expect(await rejectStored(changedDomain((envelope) => {
      envelope.envelopeHash = bytes(0, 31);
    }))).toBe(
      "Stored Agent Runtime Domain envelope hash must contain exactly 32 bytes",
    );

    expect(await rejectStored(changed((current) => {
      Object.assign(current.challengeConsumptions[0]!, { unexpected: true });
    }))).toBe("Stored Agent Runtime challenge has an invalid field set");
    expect(await rejectStored(changed((current) => {
      Object.assign(current.challengeConsumptions[0]!, {
        challengeHash: bytes(0, 31),
      });
    }))).toBe(
      "Stored Agent Runtime challenge hash must contain exactly 32 bytes",
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current.challengeConsumptions[0]!, { consumed: 1 });
    }))).toBe(
      "Stored Agent Runtime challenge consumed state must be boolean",
    );
    expect(await rejectStored(changed((current) => {
      Object.assign(current.challengeConsumptions[1]!, {
        challengeHash:
          current.challengeConsumptions[0]!.challengeHash.slice(),
      });
    }))).toBe(
      "Stored Agent Runtime challenges must be sorted and unique",
    );
  });

  test("initializes before challenges and reserves issued hashes before target completion", async () => {
    const state = await setup();
    expect(state.unreservedInitial.challengeConsumptions).toEqual([]);
    expect(state.initial.challengeConsumptions).toHaveLength(2);
    expect(
      state.initial.challengeConsumptions.every((entry) => !entry.consumed),
    ).toBe(true);
    expect(
      state.challenges.map((entry) => entry.challenge.challengeHash)
        .every((hash) =>
          state.initial.challengeConsumptions.some((entry) =>
            entry.challengeHash.toHex() === hash.toHex()
          )
        ),
    ).toBe(true);
  });

  test("an authentic manager-handoff Domain envelope cannot bootstrap a structural Runtime state", async () => {
    const state = await setup();
    const completion = state.completions[0]!;
    const target = completion.plan.target;
    const rawState: AgentRuntimeAtomicStorageStateV2 = {
      runtime: {
        agentId: completion.plan.agentId,
        authorizationRevision: target.agentAuthorizationRevision,
        runtimeGeneration: completion.plan.runtimeGeneration,
      },
      configInventory: agentRuntimeConfigInventoryCommitmentV2({
        crypto: state.crypto,
        agentId: completion.plan.agentId,
        runtimeGeneration: completion.plan.runtimeGeneration,
        activeConfigObjects: [],
      }),
      configObjects: [],
      domainEnvelopes: [{
        agentId: completion.plan.agentId,
        domainId: target.domainId,
        domainEpoch: target.domainEpoch,
        agentAuthorizationRevision: target.agentAuthorizationRevision,
        runtimeGeneration: completion.plan.runtimeGeneration,
        committerDeviceId: target.committerDeviceId,
        envelopeHash: state.crypto.hash(
          completion.envelopeBytes.ciphertext,
        ),
        envelopeBytes: completion.envelopeBytes,
      }],
      challengeConsumptions: [],
    };
    const store = new InMemoryV2Store();
    expect(store.putAgentRuntimeAtomicStateIfAbsent(
      rawState as never,
    )).rejects.toThrow("authorized write capability");
    expect(await store.getAgentRuntimeAtomicState(
      completion.plan.agentId,
    )).toBeNull();
  });

  test("serializes competing reservations without losing unrelated pending challenges", async () => {
    const state = await setup();
    const store = new InMemoryV2Store();
    await store.putAgentRuntimeAtomicStateIfAbsent(
      authorizeInitialRuntimeState(state.unreservedInitial),
    );
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolverCalls = 0;
    const resolveCurrentAuthorization = async () => {
      resolverCalls += 1;
      if (resolverCalls === 2) release();
      await barrier;
      return state.authorization;
    };
    const hashesA = [bytes(0x71), bytes(0x72)];
    const hashesB = [bytes(0x81), bytes(0x82)];
    const [left, right] = await Promise.all([
      reserveAgentRuntimeRotationChallengesV2({
        storage: store,
        request: reservationRequest(state, hashesA),
        resolveCurrentAuthorization,
      }),
      reserveAgentRuntimeRotationChallengesV2({
        storage: store,
        request: reservationRequest(state, hashesB),
        resolveCurrentAuthorization,
      }),
    ]);
    expect([left, right].sort()).toEqual(["applied", "stale"]);
    const losingHashes = left === "stale" ? hashesA : hashesB;
    expect(await reserveAgentRuntimeRotationChallengesV2({
      storage: store,
      request: reservationRequest(state, losingHashes),
      resolveCurrentAuthorization: () => state.authorization,
    })).toBe("applied");
    const stored = await store.getAgentRuntimeAtomicState(
      state.candidate.expectedState.agentId,
    );
    expect(stored?.challengeConsumptions).toHaveLength(4);
    expect(stored?.challengeConsumptions.every((entry) => !entry.consumed))
      .toBe(true);
  });

  test("surfaces ambiguous challenge reservation once and resolves explicit retry as duplicate", async () => {
    const state = await setup();
    const store = new InMemoryV2Store();
    await store.putAgentRuntimeAtomicStateIfAbsent(
      authorizeInitialRuntimeState(state.unreservedInitial),
    );
    let attempts = 0;
    const storage = {
      getAgentRuntimeAtomicState:
        store.getAgentRuntimeAtomicState.bind(store),
      compareAndSwapAgentRuntimeChallengeReservations: async (authorized:
        Parameters<
          InMemoryV2Store["compareAndSwapAgentRuntimeChallengeReservations"]
        >[0]
      ) => {
        attempts += 1;
        await store.compareAndSwapAgentRuntimeChallengeReservations(
          authorized,
        );
        throw new Error("injected reservation response loss");
      },
    };
    expect(reserveAgentRuntimeRotationChallengesV2({
      storage,
      request: reservationRequest(state),
      resolveCurrentAuthorization: () => state.authorization,
    })).rejects.toBeInstanceOf(
      AgentRuntimeChallengeReservationOutcomeUnknownV2,
    );
    expect(attempts).toBe(1);
    expect(await reserveAgentRuntimeRotationChallengesV2({
      storage: store,
      request: reservationRequest(state),
      resolveCurrentAuthorization: () => state.authorization,
    })).toBe("duplicate");
  });

  test("rechecks reservation authority after deferred read and performs zero CAS after revocation", async () => {
    const state = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live:
      AgentRuntimeRotationPersistenceAuthorizationV2 | null =
        state.authorization;
    let writes = 0;
    const storage = {
      getAgentRuntimeAtomicState: async () => {
        await gate;
        return opaqueToWireRuntimeState(state.unreservedInitial);
      },
      compareAndSwapAgentRuntimeChallengeReservations: async () => {
        writes += 1;
        return "applied" as const;
      },
    };
    const pending = reserveAgentRuntimeRotationChallengesV2({
      storage,
      request: reservationRequest(state),
      resolveCurrentAuthorization: () => live,
    });
    live = null;
    release();
    expect(await pending).toBe("stale");
    expect(writes).toBe(0);
  });

  test("carries exact authorization expectations into both Runtime CAS boundaries", async () => {
    const state = await setup();
    let reservationContext: unknown;
    let rotationContext: unknown;

    expect(await reserveAgentRuntimeRotationChallengesV2({
      storage: {
        getAgentRuntimeAtomicState: async () =>
          opaqueToWireRuntimeState(state.unreservedInitial),
        compareAndSwapAgentRuntimeChallengeReservations:
          async (authorized) => {
            reservationContext = authorized.authorization;
            return "stale";
          },
      },
      request: reservationRequest(state),
      resolveCurrentAuthorization: () => state.authorization,
    })).toBe("stale");
    expect(reservationContext).toEqual({
      purpose: "reserve-agent-runtime-rotation-challenges",
      operationId: state.candidate.operationId,
      expectedState: state.candidate.expectedState,
      expectedManager: state.candidate.currentManager,
      remainingDomains: reservationRequest(state).remainingDomains,
      challengeHashes: [...reservationRequest(state).challengeHashes]
        .sort(compareByteArrays),
    });

    expect(await persist(state, {
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeRotation: async (authorized) => {
          rotationContext = authorized.authorization;
          return "stale";
        },
      },
    })).toBe("stale");
    expect(
      (rotationContext as {
        context: { purpose: string };
        currentManagerSigningPublicKey: Uint8Array;
      }).context.purpose,
    ).toBe("persist-agent-runtime-rotation");
    expect(
      (rotationContext as {
        currentManagerSigningPublicKey: Uint8Array;
      }).currentManagerSigningPublicKey,
    ).toEqual(state.managerSigning.publicKey);
  });

  test("isolates challenge hashes from resolver mutation before reservation CAS", async () => {
    const state = await setup();
    const request = reservationRequest(state);
    const expectedHashes = request.challengeHashes.map((hash) =>
      Uint8Array.from(hash)
    ).sort(compareByteArrays);
    let capturedAdditions: readonly {
      readonly challengeHash: Uint8Array;
    }[] = [];

    expect(await reserveAgentRuntimeRotationChallengesV2({
      storage: {
        getAgentRuntimeAtomicState: async () =>
          opaqueToWireRuntimeState(state.unreservedInitial),
        compareAndSwapAgentRuntimeChallengeReservations:
          async (authorized) => {
            capturedAdditions = authorized.additions;
            return "applied";
          },
      },
      request,
      resolveCurrentAuthorization: (context) => {
        context.challengeHashes.forEach((hash) => hash.fill(0));
        return state.authorization;
      },
    })).toBe("applied");
    expect(capturedAdditions.map((entry) => entry.challengeHash)).toEqual(
      expectedHashes,
    );
  });

  test("product-aware adapters reject authority changed after the resolver and before either CAS", async () => {
    const reservationState = await setup();
    let liveReservationManagerRevision =
      reservationState.candidate.currentManager.managerAuthorizationRevision;
    expect(await reserveAgentRuntimeRotationChallengesV2({
      storage: {
        getAgentRuntimeAtomicState: async () =>
          opaqueToWireRuntimeState(reservationState.unreservedInitial),
        compareAndSwapAgentRuntimeChallengeReservations:
          async (authorized) =>
            authorized.authorization.expectedManager
                .managerAuthorizationRevision
                === liveReservationManagerRevision
              ? "applied"
              : "stale",
      },
      request: reservationRequest(reservationState),
      resolveCurrentAuthorization: () => {
        const decision = reservationState.authorization;
        liveReservationManagerRevision = authorizationRevision(
          Number(liveReservationManagerRevision) + 1,
        );
        return decision;
      },
    })).toBe("stale");

    const rotationState = await setup();
    let liveRotationManagerRevision =
      rotationState.candidate.currentManager.managerAuthorizationRevision;
    expect(await persist(rotationState, {
      storage: {
        getAgentRuntimeAtomicState: async () => rotationState.initial,
        compareAndSwapAgentRuntimeRotation: async (authorized) =>
          authorized.authorization.currentManager.managerAuthorizationRevision
              === liveRotationManagerRevision
            ? "applied"
            : "stale",
      },
      resolveCurrentAuthorization: () => {
        const decision = rotationState.authorization;
        liveRotationManagerRevision = authorizationRevision(
          Number(liveRotationManagerRevision) + 1,
        );
        return decision;
      },
    })).toBe("stale");
  });

  test("consumed Runtime capabilities own their write sets across an async adapter yield", async () => {
    const state = await setup();
    const callerDigest = Buffer.from(
      state.unreservedInitial.configInventory.digest,
    );
    const originalDigest = Uint8Array.from(callerDigest);
    const callerState = {
      ...state.unreservedInitial,
      configInventory: {
        ...state.unreservedInitial.configInventory,
        digest: callerDigest,
      },
    };
    const initialization = authorizeInitialRuntimeState(
      callerState,
    );
    callerDigest.fill(0xff);
    const consumedInitialization =
      consumeAuthorizedAgentRuntimeInitializationWriteV2(initialization);
    expect(consumedInitialization.state.configInventory.digest).toEqual(
      originalDigest,
    );
    expect(
      Buffer.isBuffer(consumedInitialization.state.configInventory.digest),
    ).toBeFalse();
    const initializationBytes =
      consumedInitialization.state.configObjects[0]!.wrappedDek.ciphertext
        .slice();
    initialization.state.configObjects[0]!.wrappedDek.ciphertext.fill(0xee);
    await Promise.resolve();
    expect(
      consumedInitialization.state.configObjects[0]!.wrappedDek.ciphertext,
    ).toEqual(initializationBytes);

    const request = reservationRequest(state);
    const reservation = authorizeAgentRuntimeChallengeReservationWriteV2({
      expected: {
        runtime: state.unreservedInitial.runtime,
        challengeConsumptions: [],
      },
      additions: [...request.challengeHashes]
        .sort(compareByteArrays)
        .map((challengeHash) => ({
          challengeHash,
          consumed: false,
        })),
      authorization: {
        purpose: "reserve-agent-runtime-rotation-challenges",
        operationId: request.operationId,
        expectedState: request.expectedState,
        expectedManager: request.currentManager,
        remainingDomains: request.remainingDomains,
        challengeHashes: [...request.challengeHashes].sort(compareByteArrays),
      },
    });
    const consumedReservation =
      consumeAuthorizedAgentRuntimeChallengeReservationWriteV2(reservation);
    const reservationHash =
      consumedReservation.additions[0]!.challengeHash.slice();
    reservation.additions[0]!.challengeHash.fill(0xdd);
    await Promise.resolve();
    expect(consumedReservation.additions[0]!.challengeHash).toEqual(
      reservationHash,
    );

    let rotation: Parameters<
      typeof consumeAuthorizedAgentRuntimeRotationWriteV2
    >[0] | null = null;
    expect(await persist(state, {
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeRotation: async (authorized) => {
          rotation = authorized;
          return "stale";
        },
      },
    })).toBe("stale");
    if (rotation === null) throw new Error("missing rotation capability");
    const capturedRotation = rotation as unknown as Parameters<
      typeof consumeAuthorizedAgentRuntimeRotationWriteV2
    >[0];
    const consumedRotation =
      consumeAuthorizedAgentRuntimeRotationWriteV2(capturedRotation);
    const rotationBytes =
      consumedRotation.intended.configObjects[0]!.wrappedDek.ciphertext.slice();
    capturedRotation.intended.configObjects[0]!.wrappedDek.ciphertext.fill(
      0xcc,
    );
    await Promise.resolve();
    expect(
      consumedRotation.intended.configObjects[0]!.wrappedDek.ciphertext,
    ).toEqual(rotationBytes);
  });

  test("storage capability mints bind every independent reservation and rotation write-set axis", async () => {
    const reservationState = await setup();
    const request = reservationRequest(reservationState);
    type ReservationInput = Parameters<
      typeof authorizeAgentRuntimeChallengeReservationWriteV2
    >[0];
    const reservationInput: ReservationInput = {
      expected: {
        runtime: reservationState.unreservedInitial.runtime,
        challengeConsumptions: [],
      },
      additions: [...request.challengeHashes]
        .sort(compareByteArrays)
        .map((challengeHash) => ({ challengeHash, consumed: false })),
      authorization: {
        purpose: "reserve-agent-runtime-rotation-challenges",
        operationId: request.operationId,
        expectedState: request.expectedState,
        expectedManager: request.currentManager,
        remainingDomains: request.remainingDomains,
        challengeHashes: [...request.challengeHashes].sort(compareByteArrays),
      },
    };
    expect(() =>
      authorizeAgentRuntimeChallengeReservationWriteV2(reservationInput)
    ).not.toThrow();
    const reservationMutations: readonly ((value: ReservationInput) => void)[] = [
      (value) => {
        Object.assign(value.expected, {
          runtime: {
            ...value.expected.runtime,
            authorizationRevision: authorizationRevision(
              value.expected.runtime.authorizationRevision + 1,
            ),
          },
        });
      },
      (value) => {
        Object.assign(value.additions[0]!, {
          challengeHash: bytes(0xfa),
        });
      },
      (value) => {
        Object.assign(value.authorization, { remainingDomains: [] });
      },
    ];
    for (const mutate of reservationMutations) {
      const invalid = structuredClone(reservationInput);
      mutate(invalid);
      expect(() => authorizeAgentRuntimeChallengeReservationWriteV2(invalid))
        .toThrow("does not match its write set");
    }
    expect(() => authorizeAgentRuntimeChallengeReservationWriteV2({
      ...reservationInput,
      expected: null,
    } as never)).toThrow("expectation must be an object");
    expect(() => authorizeAgentRuntimeChallengeReservationWriteV2({
      ...reservationInput,
      additions: null,
    } as never)).toThrow("additions must be an array");

    const rotationState = await setup();
    type RotationInput = Parameters<
      typeof authorizeAgentRuntimeRotationWriteV2
    >[0];
    let captured: RotationInput | null = null;
    expect(await persist(rotationState, {
      storage: {
        getAgentRuntimeAtomicState: async () => rotationState.initial,
        compareAndSwapAgentRuntimeRotation: async (authorized) => {
          captured = authorized;
          return "stale";
        },
      },
    })).toBe("stale");
    if (captured === null) throw new Error("missing rotation write input");
    const rotationInput = captured as RotationInput;
    expect(() => authorizeAgentRuntimeRotationWriteV2(rotationInput))
      .not.toThrow();
    const rotationMutations: readonly ((value: RotationInput) => RotationInput)[] = [
      (value) => ({
        ...value,
        expected: {
          ...value.expected,
          runtime: {
            ...value.expected.runtime,
            authorizationRevision: authorizationRevision(
              value.expected.runtime.authorizationRevision + 1,
            ),
          },
        },
      }),
      (value) => ({
        ...value,
        intended: {
          ...value.intended,
          runtime: {
            ...value.intended.runtime,
            authorizationRevision: authorizationRevision(
              value.intended.runtime.authorizationRevision + 1,
            ),
          },
        },
      }),
      (value) => ({
        ...value,
        authorization: {
          ...value.authorization,
          currentState: {
            ...value.authorization.currentState,
            authorizationRevision: authorizationRevision(
              value.authorization.currentState.authorizationRevision + 2,
            ),
          },
        },
      }),
      (value) => ({
        ...value,
        authorization: {
          ...value.authorization,
          currentManager: {
            ...value.authorization.currentManager,
            managerAuthorizationRevision: authorizationRevision(
              value.authorization.currentManager.managerAuthorizationRevision
                + 1,
            ),
          },
        },
      }),
      (value) => ({
        ...value,
        authorization: {
          ...value.authorization,
          remainingDomains: value.authorization.remainingDomains.map(
            (domain, index) => index === 0
              ? { ...domain, domainId: cryptoDomainId("domain-other") }
              : domain,
          ),
        },
      }),
      (value) => ({
        ...value,
        authorization: {
          ...value.authorization,
          remainingDomains: value.authorization.remainingDomains.map(
            (domain, index) => index === 0
              ? { ...domain, domainEpoch: domainEpoch(domain.domainEpoch + 1) }
              : domain,
          ),
        },
      }),
      (value) => ({
        ...value,
        authorization: {
          ...value.authorization,
          remainingDomains: value.authorization.remainingDomains.map(
            (domain, index) => index === 0
              ? {
                ...domain,
                agentAuthorizationRevision: authorizationRevision(
                  domain.agentAuthorizationRevision + 1,
                ),
              }
              : domain,
          ),
        },
      }),
      (value) => ({
        ...value,
        authorization: {
          ...value.authorization,
          remainingDomains: value.authorization.remainingDomains.map(
            (domain, index) => index === 0
              ? {
                ...domain,
                committerDeviceId: cryptoDeviceId("device-other"),
              }
              : domain,
          ),
        },
      }),
    ];
    for (const mutate of rotationMutations) {
      const invalid = mutate(rotationInput);
      expect(() => authorizeAgentRuntimeRotationWriteV2(invalid))
        .toThrow("does not match its write set");
    }
    expect(() => authorizeAgentRuntimeRotationWriteV2({
      ...rotationInput,
      expected: null,
    } as never)).toThrow("expectation must be an object");
    expect(() => authorizeAgentRuntimeRotationWriteV2({
      ...rotationInput,
      intended: null,
    } as never)).toThrow("atomic state must be an object");
  });

  test("reservation and rotation stores reject structural, cloned, mutated, and replayed capabilities", async () => {
    const reservationState = await setup();
    const reservationHashes =
      reservationState.authorization.remainingDomains.map((_, index) =>
        bytes(0xe1 + index)
      );
    type ReservationWrite = Parameters<
      InMemoryV2Store[
        "compareAndSwapAgentRuntimeChallengeReservations"
      ]
    >[0];
    const captureReservation = async () => {
      let captured: ReservationWrite | null = null;
      expect(await reserveAgentRuntimeRotationChallengesV2({
        storage: {
          getAgentRuntimeAtomicState:
            reservationState.store.getAgentRuntimeAtomicState.bind(
              reservationState.store,
            ),
          compareAndSwapAgentRuntimeChallengeReservations:
            async (authorized) => {
              captured = authorized;
              return "applied";
            },
        },
        request: reservationRequest(reservationState, reservationHashes),
        resolveCurrentAuthorization: () =>
          reservationState.authorization,
      })).toBe("applied");
      return captured as unknown as ReservationWrite;
    };
    const clonedReservation = await captureReservation();
    expect(reservationState.store
      .compareAndSwapAgentRuntimeChallengeReservations(
        structuredClone(clonedReservation) as never,
    )).rejects.toThrow("authorized write capability");
    const mutatedReservation = await captureReservation();
    mutatedReservation.additions[0]!.challengeHash[0] =
      mutatedReservation.additions[0]!.challengeHash[0]! ^ 0xff;
    expect(reservationState.store
      .compareAndSwapAgentRuntimeChallengeReservations(
        mutatedReservation,
      )).rejects.toThrow("authorized write capability");
    const mutatedReservationAuthorization = await captureReservation();
    mutatedReservationAuthorization.authorization.challengeHashes[0]![0] =
      mutatedReservationAuthorization.authorization.challengeHashes[0]![0]!
      ^ 0xff;
    expect(reservationState.store
      .compareAndSwapAgentRuntimeChallengeReservations(
        mutatedReservationAuthorization,
      )).rejects.toThrow("authorized write capability");
    const replayedReservation = await captureReservation();
    expect(await reservationState.store
      .compareAndSwapAgentRuntimeChallengeReservations(
        replayedReservation,
      )).toBe("applied");
    expect(reservationState.store
      .compareAndSwapAgentRuntimeChallengeReservations(
        replayedReservation,
      )).rejects.toThrow("authorized write capability");
    expect(reservationState.store
      .compareAndSwapAgentRuntimeChallengeReservations({
        expected: replayedReservation.expected,
        additions: replayedReservation.additions,
      } as never)).rejects.toThrow("authorized write capability");

    const rotationState = await setup();
    type RotationWrite = Parameters<
      InMemoryV2Store["compareAndSwapAgentRuntimeRotation"]
    >[0];
    const captureRotation = async () => {
      let captured: RotationWrite | null = null;
      expect(await persist(rotationState, {
        storage: {
          getAgentRuntimeAtomicState:
            rotationState.store.getAgentRuntimeAtomicState.bind(
              rotationState.store,
            ),
          compareAndSwapAgentRuntimeRotation: async (authorized) => {
            captured = authorized;
            return "applied";
          },
        },
      })).toBe("applied");
      return captured as unknown as RotationWrite;
    };
    const clonedRotation = await captureRotation();
    expect(rotationState.store.compareAndSwapAgentRuntimeRotation(
      structuredClone(clonedRotation) as never,
    )).rejects.toThrow("authorized write capability");
    const mutatedRotation = await captureRotation();
    mutatedRotation.intended.configInventory.digest[0] =
      mutatedRotation.intended.configInventory.digest[0]! ^ 0xff;
    expect(rotationState.store.compareAndSwapAgentRuntimeRotation(
      mutatedRotation,
    )).rejects.toThrow("authorized write capability");
    const mutatedRotationAuthorization = await captureRotation();
    mutatedRotationAuthorization.authorization
      .currentManagerSigningPublicKey[0] =
        mutatedRotationAuthorization.authorization
          .currentManagerSigningPublicKey[0]! ^ 0xff;
    expect(rotationState.store.compareAndSwapAgentRuntimeRotation(
      mutatedRotationAuthorization,
    )).rejects.toThrow("authorized write capability");
    const replayedRotation = await captureRotation();
    expect(await rotationState.store.compareAndSwapAgentRuntimeRotation(
      replayedRotation,
    )).toBe("applied");
    expect(rotationState.store.compareAndSwapAgentRuntimeRotation(
      replayedRotation,
    )).rejects.toThrow("authorized write capability");
    expect(rotationState.store.compareAndSwapAgentRuntimeRotation({
      expected: replayedRotation.expected,
      intended: replayedRotation.intended,
    } as never)).rejects.toThrow("authorized write capability");
  });

  test("fails closed on invalid reservation and rotation adapter statuses without retrying", async () => {
    const state = await setup();
    let reservationCalls = 0;
    expect(reserveAgentRuntimeRotationChallengesV2({
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeChallengeReservations: async () => {
          reservationCalls += 1;
          return "invalid" as never;
        },
      },
      request: reservationRequest(state),
      resolveCurrentAuthorization: () => state.authorization,
    })).rejects.toThrow(
      "challenge reservation storage returned an invalid CAS status",
    );
    expect(reservationCalls).toBe(1);

    let rotationCalls = 0;
    expect(persist(state, {
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeRotation: async () => {
          rotationCalls += 1;
          return "invalid" as never;
        },
      },
    })).rejects.toThrow(
      "rotation storage returned an invalid CAS status",
    );
    expect(rotationCalls).toBe(1);
  });

  test("applies one complete detached Runtime/config/Domain/challenge write set", async () => {
    const state = await setup();
    expect(await persist(state)).toBe("applied");
    const stored = await state.store.getAgentRuntimeAtomicState(
      state.candidate.nextState.agentId,
    );
    expect(stored?.runtime).toEqual(state.candidate.nextState);
    expect(stored?.configObjects).toHaveLength(2);
    expect(stored?.configObjects.every((object) =>
      object.runtimeGeneration === state.candidate.nextState.runtimeGeneration
    )).toBe(true);
    expect(stored?.domainEnvelopes.map((envelope) => envelope.domainId))
      .toEqual(["domain-a", "domain-z"]);
    expect(stored?.challengeConsumptions.every((value) => value.consumed))
      .toBe(true);

    const snapshotBeforeMutation = structuredClone(stored);
    state.candidate.expectedConfigInventory.digest.fill(0);
    state.candidate.configRewraps[0]!.nextWrappedDek.ciphertext.fill(0);
    state.candidate.domainEnvelopes[0]!.envelopeBytes.ciphertext.fill(0);
    state.candidate.domainEnvelopes[0]!
      .challengeConsumption.challengeHash.fill(0);
    expect(
      await state.store.getAgentRuntimeAtomicState(
        state.candidate.nextState.agentId,
      ),
    ).toEqual(snapshotBeforeMutation);
  });

  test("resolves exact explicit replay as duplicate and forks/stale state as stale", async () => {
    const state = await setup();
    expect(await persist(state)).toBe("applied");
    const retryAuthorization = {
      ...state.authorization,
      currentState: state.candidate.nextState,
    };
    expect(await persist(state, { authorization: retryAuthorization }))
      .toBe("duplicate");

    const stale = await setup();
    const shadowStore = new InMemoryV2Store();
    await shadowStore.putAgentRuntimeAtomicStateIfAbsent(
      authorizeInitialRuntimeState(stale.initialOpaque),
    );
    expect(await persist(stale, { storage: shadowStore })).toBe("applied");
    const oracleIntended = await shadowStore.getAgentRuntimeAtomicState(
      stale.candidate.nextState.agentId,
    );
    if (oracleIntended === null) throw new Error("missing intended state");
    const forkCiphertext = oracleIntended.configObjects[0]!
      .wrappedDekBytes.slice();
    forkCiphertext[0] = forkCiphertext[0]! ^ 1;
    const forkConfigObjects = oracleIntended.configObjects.map(
      (object, index) => ({
        agentId: object.agentId,
        objectId: object.objectId,
        configRevision: object.configRevision,
        runtimeGeneration: object.runtimeGeneration,
        wrappedDekHash: index === 0
          ? stale.crypto.hash(forkCiphertext)
          : object.wrappedDekHash.slice(),
        wrappedDek: authenticatedAgentRuntimeConfigDekV2(
          index === 0
            ? forkCiphertext
            : object.wrappedDekBytes,
        ),
      }),
    );
    const forkInventory = agentRuntimeConfigInventoryCommitmentV2({
        crypto: stale.crypto,
        agentId: agentId(oracleIntended.runtime.agentId),
        runtimeGeneration:
          agentRuntimeGeneration(oracleIntended.runtime.runtimeGeneration),
        activeConfigObjects: forkConfigObjects.map((object) => ({
          agentId: agentId(object.agentId),
          objectId: objectId(object.objectId),
          configRevision: authorizationRevision(object.configRevision),
          runtimeGeneration:
            agentRuntimeGeneration(object.runtimeGeneration),
          wrappedDek: object.wrappedDek.ciphertext,
        })),
      });
    const forkIntended: AgentRuntimeAtomicStorageStateV2 = {
      ...wireToOpaqueRuntimeState(oracleIntended),
      configInventory: forkInventory,
      configObjects: forkConfigObjects,
    };
    expect(
      await stale.store.compareAndSwapAgentRuntimeRotation(
        authorizeRotationWrite(
          stale,
          {
            runtime: stale.initial.runtime,
            configInventory: stale.initial.configInventory,
            configObjects: stale.initial.configObjects.map((object) => ({
              agentId: object.agentId,
              objectId: object.objectId,
              configRevision: object.configRevision,
              runtimeGeneration: object.runtimeGeneration,
              wrappedDekHash: object.wrappedDekHash,
            })),
            challengeConsumptions: stale.initial.challengeConsumptions,
          },
          forkIntended,
        ),
      ),
    ).toBe("applied");
    expect(await persist(stale)).toBe("stale");
  });

  test("surfaces one ambiguous delivery and requires an explicit duplicate retry", async () => {
    const state = await setup();
    let attempts = 0;
    const ambiguousStorage = {
      getAgentRuntimeAtomicState:
        state.store.getAgentRuntimeAtomicState.bind(state.store),
      compareAndSwapAgentRuntimeRotation: async (authorized:
        Parameters<
          InMemoryV2Store["compareAndSwapAgentRuntimeRotation"]
        >[0]
      ) => {
        attempts += 1;
        await state.store.compareAndSwapAgentRuntimeRotation(
          authorized,
        );
        throw new Error("injected post-commit delivery loss");
      },
    };
    expect(persist(state, { storage: ambiguousStorage }))
      .rejects.toBeInstanceOf(AgentRuntimeRotationOutcomeUnknownV2);
    expect(attempts).toBe(1);
    expect(await persist(state, {
      authorization: {
        ...state.authorization,
        currentState: state.candidate.nextState,
      },
    })).toBe("duplicate");
  });

  test("detaches before await even when the caller mutates the candidate during CAS", async () => {
    const state = await setup();
    const originalConfig = state.candidate.configRewraps[0]!
      .nextWrappedDek.ciphertext.slice();
    const originalEnvelope = state.candidate.domainEnvelopes[0]!
      .envelopeBytes.ciphertext.slice();
    const mutationStorage = {
      getAgentRuntimeAtomicState:
        state.store.getAgentRuntimeAtomicState.bind(state.store),
      compareAndSwapAgentRuntimeRotation: async (authorized:
        Parameters<
          InMemoryV2Store["compareAndSwapAgentRuntimeRotation"]
        >[0]
      ) => {
        await Promise.resolve();
        state.candidate.configRewraps[0]!.nextWrappedDek.ciphertext.fill(0);
        state.candidate.domainEnvelopes[0]!.envelopeBytes.ciphertext.fill(0);
        const mutableAuthorization = state.authorization as unknown as {
          remainingDomains: { domainId: string }[];
        };
        mutableAuthorization.remainingDomains[0]!.domainId =
          "domain-mutated";
        return state.store.compareAndSwapAgentRuntimeRotation(
          authorized,
        );
      },
    };
    expect(await persist(state, { storage: mutationStorage })).toBe("applied");
    const stored = await state.store.getAgentRuntimeAtomicState(
      state.candidate.nextState.agentId,
    );
    expect(stored?.configObjects[0]!.wrappedDekBytes)
      .toEqual(originalConfig);
    expect(stored?.domainEnvelopes[0]!.envelopeBytes)
      .toEqual(originalEnvelope);
    expect(stored?.domainEnvelopes[0]!.domainId).toBe("domain-a");
  });

  test("authorized Runtime writes reject tag-evasive forged opaque fields", async () => {
    const state = await setup();
    const initialObject = state.unreservedInitial.configObjects[0]!;
    const forgedInitial: AgentRuntimeAtomicStorageStateV2 = {
      ...state.unreservedInitial,
      configObjects: [{
        ...initialObject,
        wrappedDek: {
          classification: "not-opaque",
          kind: "agent-runtime-config-dek",
          ciphertext: initialObject.wrappedDek.ciphertext.slice(),
        } as never,
      }, ...state.unreservedInitial.configObjects.slice(1)],
    };
    expect(() => authorizeInitialRuntimeState(forgedInitial)).toThrow(
      "Runtime config DEK must be opaque agent-runtime-config-dek ciphertext",
    );

    let expected: AgentRuntimeRotationStorageExpectationV2 | undefined;
    let intended: AgentRuntimeAtomicStorageStateV2 | undefined;
    expect(await persist(state, {
      storage: {
        getAgentRuntimeAtomicState: async () => state.initial,
        compareAndSwapAgentRuntimeRotation: async (authorized) => {
          expected = authorized.expected;
          intended = authorized.intended;
          return "applied";
        },
      },
    })).toBe("applied");
    const domainEnvelope = intended!.domainEnvelopes[0]!;
    const forgedRotation: AgentRuntimeAtomicStorageStateV2 = {
      ...intended!,
      domainEnvelopes: [{
        ...domainEnvelope,
        envelopeBytes: {
          classification: "not-opaque",
          kind: "agent-runtime-domain-envelope",
          ciphertext: domainEnvelope.envelopeBytes.ciphertext.slice(),
        } as never,
      }, ...intended!.domainEnvelopes.slice(1)],
    };
    expect(() =>
      authorizeRotationWrite(state, expected!, forgedRotation)
    ).toThrow(
      "Agent Runtime Domain envelope must be opaque agent-runtime-domain-envelope ciphertext",
    );
  });

  test("detaches every authentic candidate byte before the first storage await", async () => {
    const state = await setup();
    const expectedConfigDigest =
      state.candidate.expectedConfigInventory.digest.slice();
    const expectedWrappedDekHash =
      state.candidate.configRewraps[0]!.expected.wrappedDekHash.slice();
    const expectedConfigCiphertext =
      state.candidate.configRewraps[0]!.nextWrappedDek.ciphertext.slice();
    const expectedDomainCiphertext =
      state.candidate.domainEnvelopes[0]!.envelopeBytes.ciphertext.slice();
    const expectedChallengeHash =
      state.candidate.domainEnvelopes[0]!
        .challengeConsumption.challengeHash.slice();
    let intended: AgentRuntimeAtomicStorageStateV2 | undefined;
    const storage = {
      getAgentRuntimeAtomicState: async () => {
        await Promise.resolve();
        state.candidate.expectedConfigInventory.digest.fill(0);
        state.candidate.configRewraps[0]!.expected.wrappedDekHash.fill(0);
        state.candidate.configRewraps[0]!
          .nextWrappedDek.ciphertext.fill(0);
        state.candidate.domainEnvelopes[0]!
          .envelopeBytes.ciphertext.fill(0);
        state.candidate.domainEnvelopes[0]!
          .challengeConsumption.challengeHash.fill(0);
        return state.initial;
      },
      compareAndSwapAgentRuntimeRotation: async (authorized:
        Parameters<
          InMemoryV2Store["compareAndSwapAgentRuntimeRotation"]
        >[0]
      ) => {
        intended = authorized.intended;
        return "applied" as const;
      },
    };
    expect(await persist(state, { storage })).toBe("applied");
    if (intended === undefined) throw new Error("missing intended state");
    expect(intended.configInventory.digest.toHex()).not.toBe(
      state.candidate.expectedConfigInventory.digest.toHex(),
    );
    expect(expectedConfigDigest.toHex()).toBe(
      state.initial.configInventory.digest.toHex(),
    );
    expect(
      intended.configObjects[0]!.wrappedDek.ciphertext.toHex(),
    ).toBe(expectedConfigCiphertext.toHex());
    expect(
      intended.configObjects[0]!.wrappedDekHash.toHex(),
    ).toBe(state.crypto.hash(expectedConfigCiphertext).toHex());
    expect(expectedWrappedDekHash.toHex()).toBe(
      state.initial.configObjects[0]!.wrappedDekHash.toHex(),
    );
    expect(
      intended.domainEnvelopes[0]!.envelopeBytes.ciphertext.toHex(),
    ).toBe(expectedDomainCiphertext.toHex());
    expect(
      intended.domainEnvelopes[0]!.envelopeHash.toHex(),
    ).toBe(state.crypto.hash(expectedDomainCiphertext).toHex());
    expect(intended.challengeConsumptions.some((entry) =>
      entry.consumed
      && entry.challengeHash.every(
        (value, index) => value === expectedChallengeHash[index],
      )
    )).toBe(true);
    expect(intended.configObjects[0]!.wrappedDek.kind).toBe(
      "agent-runtime-config-dek",
    );
    expect(intended.domainEnvelopes[0]!.envelopeBytes.kind).toBe(
      "agent-runtime-domain-envelope",
    );
  });

  test("snapshots the storage read before awaiting fresh authorization", async () => {
    const state = await setup();
    const returned = structuredClone(state.initial);
    const originalChallenge = returned.challengeConsumptions[0]!
      .challengeHash.slice();
    expect(await persist(state, {
      storage: {
        getAgentRuntimeAtomicState: async () => returned,
        compareAndSwapAgentRuntimeRotation:
          state.store.compareAndSwapAgentRuntimeRotation.bind(state.store),
      },
      resolveCurrentAuthorization: async () => {
        await Promise.resolve();
        returned.challengeConsumptions[0]!.challengeHash.fill(0);
        (
          returned.runtime as { authorizationRevision: number }
        ).authorizationRevision += 10;
        return state.authorization;
      },
    })).toBe("applied");
    const stored = await state.store.getAgentRuntimeAtomicState(
      state.candidate.nextState.agentId,
    );
    expect(
      stored?.challengeConsumptions.some((entry) =>
        entry.challengeHash.toHex() === originalChallenge.toHex()
      ),
    ).toBe(true);
  });

  test("detaches every stored byte family before awaiting fresh authorization", async () => {
    const state = await setup();
    expect(await persist(state)).toBe("applied");
    const applied = await state.store.getAgentRuntimeAtomicState(
      state.candidate.nextState.agentId,
    );
    if (applied === null) throw new Error("missing applied Runtime state");
    const returned = structuredClone(applied);
    const duplicateAuthorization = {
      ...state.authorization,
      currentState: state.candidate.nextState,
    };
    expect(await persist(state, {
      authorization: duplicateAuthorization,
      storage: {
        getAgentRuntimeAtomicState: async () => returned,
        compareAndSwapAgentRuntimeRotation:
          state.store.compareAndSwapAgentRuntimeRotation.bind(state.store),
      },
      resolveCurrentAuthorization: async () => {
        await Promise.resolve();
        returned.configInventory.digest.fill(0);
        returned.configObjects[0]!.wrappedDekHash.fill(0);
        returned.configObjects[0]!.wrappedDekBytes.fill(0);
        returned.domainEnvelopes[0]!.envelopeHash.fill(0);
        returned.domainEnvelopes[0]!.envelopeBytes.fill(0);
        returned.challengeConsumptions[0]!.challengeHash.fill(0);
        return duplicateAuthorization;
      },
    })).toBe("duplicate");
  });

  test("rechecks Runtime, Domain committers, and manager after deferred storage read with zero CAS on revocation", async () => {
    const variants: Array<
      (
        authorization: AgentRuntimeRotationPersistenceAuthorizationV2,
      ) => AgentRuntimeRotationPersistenceAuthorizationV2 | null
    > = [
      () => null,
      (authorization) => ({
        ...authorization,
        currentState: {
          ...authorization.currentState,
          authorizationRevision: authorizationRevision(
            authorization.currentState.authorizationRevision + 2,
          ),
        },
      }),
      (authorization) => ({
        ...authorization,
        currentManager: {
          ...authorization.currentManager!,
          managerDeviceId: cryptoDeviceId("revoked-manager-device"),
        },
      }),
      (authorization) => ({
        ...authorization,
        remainingDomains: authorization.remainingDomains.map(
          (domain, index) => index === 0
            ? {
              ...domain,
              committerDeviceId: cryptoDeviceId("revoked-domain-committer"),
            }
            : domain,
        ),
      }),
    ];
    for (const mutate of variants) {
      const state = await setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let live:
        AgentRuntimeRotationPersistenceAuthorizationV2 | null =
          state.authorization;
      let writes = 0;
      const pending = persist(state, {
        storage: {
          getAgentRuntimeAtomicState: async () => {
            await gate;
            return structuredClone(state.initial);
          },
          compareAndSwapAgentRuntimeRotation: async () => {
            writes += 1;
            return "applied";
          },
        },
        resolveCurrentAuthorization: () => live,
      });
      live = mutate(state.authorization);
      release();
      const outcome = await pending.catch(() => "rejected" as const);
      expect(["stale", "rejected"]).toContain(outcome);
      expect(writes).toBe(0);
    }
  });

  test("rotation consumes only its exact challenges and preserves unrelated pending reservations", async () => {
    const state = await setup();
    const unrelated = [bytes(0x91), bytes(0x92)];
    expect(await reserveAgentRuntimeRotationChallengesV2({
      storage: state.store,
      request: reservationRequest(state, unrelated),
      resolveCurrentAuthorization: () => state.authorization,
    })).toBe("applied");
    expect(await persist(state)).toBe("applied");
    const stored = await state.store.getAgentRuntimeAtomicState(
      state.candidate.nextState.agentId,
    );
    expect(stored?.challengeConsumptions).toHaveLength(4);
    for (const challenge of stored?.challengeConsumptions ?? []) {
      const isUnrelated = unrelated.some((hash) =>
        hash.toHex() === challenge.challengeHash.toHex()
      );
      expect(challenge.consumed).toBe(!isUnrelated);
    }
  });

  test("completes two sequential full rotations and rejects replay of the old operation", async () => {
    const state = await setup();
    expect(await persist(state)).toBe("applied");
    const next = await prepareNextRotation(state);
    expect(await persistAgentRuntimeRotationV2({
      crypto: state.crypto,
      storage: state.store,
      candidate: next.candidate,
      resolveCurrentAuthorization: () => next.authorization,
    })).toBe("applied");
    const stored = await state.store.getAgentRuntimeAtomicState(
      next.candidate.nextState.agentId,
    );
    expect(stored?.runtime).toEqual(next.candidate.nextState);
    expect(stored?.challengeConsumptions).toHaveLength(2);
    expect(stored?.challengeConsumptions.every((entry) => entry.consumed))
      .toBe(true);
    expect(await persist(state, {
      resolveCurrentAuthorization: () => ({
        ...next.authorization,
        currentState: next.candidate.nextState,
      }),
    })).toBe("stale");
  });

  test("persists a detached rotation proof bundle after process-style structured cloning", async () => {
    const state = await setup();

    expect(await persist(state, {
      candidate: structuredClone(state.candidate),
    })).toBe("applied");
  });

  test("rejects missing, extra, duplicate, and tampered config/domain/challenge inventories", async () => {
    const variants: ((candidate: AtomicAgentRuntimeRotationCandidateV2) => void)[] = [
      (candidate) => {
        (candidate.configRewraps as unknown[]).pop();
      },
      (candidate) => {
        (candidate.configRewraps as unknown[]).push(
          structuredClone(candidate.configRewraps[0]),
        );
      },
      (candidate) => {
        (candidate.configRewraps as unknown[])[1] =
          structuredClone(candidate.configRewraps[0]);
      },
      (candidate) => {
        candidate.configRewraps[0]!.expected.wrappedDekHash.fill(0);
      },
      (candidate) => {
        (candidate.domainEnvelopes as unknown[]).pop();
      },
      (candidate) => {
        (candidate.domainEnvelopes as unknown[]).push(
          structuredClone(candidate.domainEnvelopes[0]),
        );
      },
      (candidate) => {
        const ciphertext =
          candidate.domainEnvelopes[0]!.envelopeBytes.ciphertext;
        ciphertext[10] = ciphertext[10]! ^ 1;
      },
      (candidate) => {
        candidate.domainEnvelopes[0]!
          .challengeConsumption.challengeHash.fill(0);
        candidate.domainEnvelopes[1]!
          .challengeConsumption.challengeHash.fill(0);
      },
      (candidate) => {
        (candidate.domainEnvelopes[0]!
          .challengeConsumption as { intendedConsumed: boolean })
          .intendedConsumed = false;
      },
    ];
    for (const [index, mutate] of variants.entries()) {
      const state = await setup();
      const candidate = cloneCandidate(state.candidate);
      mutate(candidate);
      const outcome = await persist(state, { candidate }).catch(
        (error: unknown) => error,
      );
      if (!(outcome instanceof Error)) {
        throw new Error(
          `forged Runtime candidate variant ${index} was accepted as ${
            String(outcome)
          }`,
        );
      }
      expect(await state.store.getAgentRuntimeAtomicState(
        state.candidate.expectedState.agentId,
      )).toEqual(state.initial);
    }
  });

  test("rejects post-aggregation proof and derived-write substitutions before CAS", async () => {
    for (const candidate of [
      await (async () => {
        const state = await setup();
        const ciphertext = state.candidate.configRewraps[0]!
          .nextWrappedDek.ciphertext;
        ciphertext[0] = ciphertext[0]! ^ 1;
        return { state, candidate: state.candidate };
      })(),
      await (async () => {
        const state = await setup();
        return {
          state,
          candidate: {
            ...state.candidate,
            operationId: "forged-operation",
          } as AtomicAgentRuntimeRotationCandidateV2,
        };
      })(),
      await (async () => {
        const state = await setup();
        return {
          state,
          candidate: {
            ...state.candidate,
            currentManager: {
              ...state.candidate.currentManager,
              managerDeviceId: cryptoDeviceId("forged-manager-device"),
            },
          } as AtomicAgentRuntimeRotationCandidateV2,
        };
      })(),
    ]) {
      let reads = 0;
      let writes = 0;
      const storage = {
        getAgentRuntimeAtomicState: async () => {
          reads += 1;
          return candidate.state.initial;
        },
        compareAndSwapAgentRuntimeRotation: async () => {
          writes += 1;
          return "applied" as const;
        },
      };
      const outcome = await persist(candidate.state, {
        candidate: candidate.candidate,
        storage,
      }).catch((error: unknown) => error);
      expect(outcome).not.toBe("applied");
      expect(reads).toBeLessThanOrEqual(1);
      expect(writes).toBe(0);
    }
  });

  test("returns stale for stale authorization/runtime/config/challenge state without partial writes", async () => {
    const staleAuthorization = await setup();
    expect(await persist(staleAuthorization, {
      authorization: {
        ...staleAuthorization.authorization,
        currentState: {
          ...staleAuthorization.authorization.currentState,
          authorizationRevision: authorizationRevision(
            staleAuthorization.authorization.currentState
              .authorizationRevision + 2,
          ),
        },
      },
    })).toBe("stale");

    for (const mutate of [
      (state: AgentRuntimeAtomicStorageWireV2) => {
        const runtime = state.runtime as unknown as {
          runtimeGeneration: number;
        };
        runtime.runtimeGeneration += 1;
      },
      (state: AgentRuntimeAtomicStorageWireV2) => {
        state.configObjects[0]!.wrappedDekHash.fill(0);
      },
      (state: AgentRuntimeAtomicStorageWireV2) => {
        const challenge = state.challengeConsumptions[0] as unknown as {
          consumed: boolean;
        };
        challenge.consumed = true;
      },
    ]) {
      const state = await setup();
      const current = await state.store.getAgentRuntimeAtomicState(
        state.initial.runtime.agentId,
      );
      if (current === null) throw new Error("missing initial Runtime state");
      mutate(current);
      const storage = {
        getAgentRuntimeAtomicState: async () => current,
        compareAndSwapAgentRuntimeRotation:
          state.store.compareAndSwapAgentRuntimeRotation.bind(state.store),
      };
      const outcome = await persist(state, { storage }).catch(
        (error: unknown) => error,
      );
      expect(outcome).not.toBe("applied");
      expect(await state.store.getAgentRuntimeAtomicState(
        state.initial.runtime.agentId,
      )).toEqual(state.initial);
    }
  });

  test("has exact no-secret key shapes and no competing generic Runtime write path", async () => {
    const state = await setup();
    expect(await persist(state)).toBe("applied");
    const storeKeys = Object.getOwnPropertyNames(
      Object.getPrototypeOf(state.store),
    );
    expect(storeKeys).not.toContain("putAgentRuntime");
    expect(storeKeys).not.toContain("getAgentRuntime");
    const stored = await state.store.getAgentRuntimeAtomicState(
      state.candidate.nextState.agentId,
    );
    const names = new Set<string>();
    collectFieldNames(stored, names);
    expect(names).not.toContain("key");
    expect(names).not.toContain("runtimeKey");
    expect(names).not.toContain("domainRoot");
    expect(names).not.toContain("privateKey");
    expect(names).not.toContain("plaintext");
    expect(Object.keys(stored ?? {})).toEqual([
      "runtime",
      "configInventory",
      "configObjects",
      "domainEnvelopes",
      "challengeConsumptions",
    ]);
    expect(state.store.snapshot().atomicRuntimeStates).toHaveLength(1);
  });

  test("rejects forged over-bound inventories before any storage call", async () => {
    const state = await setup();
    let reads = 0;
    let writes = 0;
    const storage = {
      getAgentRuntimeAtomicState: async () => {
        reads += 1;
        return state.initial;
      },
      compareAndSwapAgentRuntimeRotation: async () => {
        writes += 1;
        return "applied" as const;
      },
    };
    const tooMany = cloneCandidate(state.candidate);
    (tooMany.configRewraps as unknown[]).splice(
      0,
      tooMany.configRewraps.length,
      ...Array.from(
        { length: 257 },
        () => structuredClone(state.candidate.configRewraps[0]),
      ),
    );
    (tooMany.expectedConfigInventory as unknown as { objectCount: number })
      .objectCount = 257;
    expect(persist(state, { candidate: tooMany, storage }))
      .rejects.toThrow(
        "Atomic Agent Runtime rotation config rewrap count exceeds the 256 limit",
      );

    const oversized = cloneCandidate(state.candidate);
    const oversizedCiphertext =
      new Uint8Array(1024 * 1024 + 41);
    (oversized.domainEnvelopes[0]!.envelopeBytes as unknown as {
      ciphertext: Uint8Array;
    }).ciphertext = oversizedCiphertext;
    expect(persist(state, { candidate: oversized, storage }))
      .rejects.toThrow(
        "Atomic Agent Runtime rotation Domain envelope bytes exceeds",
      );
    expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });
  });

  test("direct store CAS rejects generic replacement, commitment lies, and partial challenge sets", async () => {
    const oracle = await setup();
    expect(await persist(oracle)).toBe("applied");
    const intended = await oracle.store.getAgentRuntimeAtomicState(
      oracle.candidate.nextState.agentId,
    );
    if (intended === null) throw new Error("missing intended Runtime state");
    const intendedOpaque = wireToOpaqueRuntimeState(intended);
    const expected: AgentRuntimeRotationStorageExpectationV2 = {
      runtime: oracle.initial.runtime,
      configInventory: oracle.initial.configInventory,
      configObjects: oracle.initial.configObjects.map((object) => ({
        agentId: object.agentId,
        objectId: object.objectId,
        configRevision: object.configRevision,
        runtimeGeneration: object.runtimeGeneration,
        wrappedDekHash: object.wrappedDekHash,
      })),
      challengeConsumptions: oracle.initial.challengeConsumptions,
    };
    const variants: {
      expected: AgentRuntimeRotationStorageExpectationV2;
      intended: AgentRuntimeAtomicStorageStateV2;
    }[] = [
      {
        expected,
        intended: {
          ...structuredClone(intendedOpaque),
          runtime: {
              ...intendedOpaque.runtime,
            authorizationRevision: authorizationRevision(
                intendedOpaque.runtime.authorizationRevision + 1,
            ),
          },
        },
      },
      {
        expected,
        intended: {
          ...structuredClone(intendedOpaque),
          configInventory: {
            ...intendedOpaque.configInventory,
            digest: new Uint8Array(32).fill(0xee),
          },
        },
      },
      {
        expected,
        intended: {
          ...structuredClone(intendedOpaque),
          challengeConsumptions:
            intendedOpaque.challengeConsumptions.slice(1),
        },
      },
      {
        expected: {
          ...structuredClone(expected),
          configInventory: {
            ...expected.configInventory,
            digest: new Uint8Array(32).fill(0xdd),
          },
        },
        intended: intendedOpaque,
      },
    ];
    for (const variant of variants) {
      const state = await setup();
      expect(
        state.store.compareAndSwapAgentRuntimeRotation(
          variant as never,
        ),
      ).rejects.toThrow("authorized write capability");
      expect(await state.store.getAgentRuntimeAtomicState(
        state.initial.runtime.agentId,
      )).toEqual(state.initial);
    }
  });
});
