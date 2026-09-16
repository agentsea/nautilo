import { describe, expect, test } from "bun:test";
import {
  AgentRuntimeAuthorizationTransitionOutcomeUnknownV2,
  aggregateAgentRuntimeAuthorizationTransitionV2,
  coordinateAgentRuntimeAuthorizationTransitionV2,
  destroyAgentRuntimeAuthorizationTransitionSourceLocalV2,
  persistAgentRuntimeAuthorizationTransitionV2,
  prepareAgentRuntimeAuthorizationTransitionSourceV2,
  type AgentRuntimeAuthorizationTransitionPlanV2,
} from "../../src/agent-runtime/authorization-transition-v2.ts";
import {
  authorizeAgentRuntimeInitializationWriteV2,
} from "../../src/agent-runtime/initialization-authorized-write.ts";
import {
  authorizeAgentRuntimeAuthorizationTransitionWriteV2,
  consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
} from "../../src/agent-runtime/storage-authorized-write.ts";
import {
  prepareAgentRuntimeManagerHandoffChallenge,
  prepareAgentRuntimeManagerHandoffResponse,
  prepareAgentRuntimeManagerHandoffTarget,
} from "../../src/agent-runtime/runtime-handoff-v2.ts";
import {
  agentRuntimeConfigDekAadV2,
  agentRuntimeConfigInventoryCommitmentV2,
} from "../../src/agent-runtime/runtime-rotation-v2.ts";
import {
  sealAgentRuntimeToDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import {
  serializeAgentRuntimeDomainEnvelope,
} from "../../src/format/agent-runtime-v2.ts";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
} from "../../src/crypto/index.ts";
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
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
import { InMemoryV2Store } from "../../src/storage/in-memory-v2-store.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import {
  agentRuntimeSignerPublicationForTesting,
} from "../../src/testing/agent-runtime-signer-publication.ts";

function bytes(fill: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function setup() {
  const crypto = new LatticeCrypto(seededRng(0x2358), manualClock(10_000));
  const managerSigning = crypto.generateSigningKeyPair();
  const signingA = crypto.generateSigningKeyPair();
  const signingB = crypto.generateSigningKeyPair();
  const runtime = Object.freeze({
    agentId: agentId("agent-genie"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(7),
    key: bytes(0x44),
  });
  const currentA = Object.freeze({
    domainId: cryptoDomainId("domain-a"),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(12),
    committerDeviceId: cryptoDeviceId("device-a"),
  });
  const configMetadata = Object.freeze({
    agentId: runtime.agentId,
    objectId: objectId("config-a"),
    configRevision: authorizationRevision(3),
    runtimeGeneration: runtime.generation,
  });
  const activeConfigObject = Object.freeze({
    ...configMetadata,
    wrappedDek: crypto.aeadSeal(
      runtime.key,
      bytes(0xa1),
      agentRuntimeConfigDekAadV2(configMetadata),
    ),
  });
  const nextB = Object.freeze({
    domainId: cryptoDomainId("domain-b"),
    domainEpoch: domainEpoch(5),
    agentAuthorizationRevision: authorizationRevision(13),
    committerDeviceId: cryptoDeviceId("device-b"),
  });
  const inventory = agentRuntimeConfigInventoryCommitmentV2({
    crypto,
    agentId: runtime.agentId,
    runtimeGeneration: runtime.generation,
    activeConfigObjects: [activeConfigObject],
  });
  const plan: AgentRuntimeAuthorizationTransitionPlanV2 = Object.freeze({
    operationId: "operation-runtime-authorization-1",
    agentId: runtime.agentId,
    oldAuthorizationRevision: authorizationRevision(20),
    newAuthorizationRevision: authorizationRevision(21),
    currentRuntimeGeneration: runtime.generation,
    currentManager: Object.freeze({
      managerHumanId: humanId("human-manager"),
      managerAuthorizationRevision: authorizationRevision(9),
      managerDeviceId: cryptoDeviceId("device-manager"),
    }),
    activeConfigInventory: inventory,
    currentDomains: Object.freeze([currentA]),
    remainingDomains: Object.freeze([currentA, nextB]),
    refreshedDomainIds: Object.freeze(["domain-b"]),
  });
  const managerAuthority = () => managerSigning.publicKey;
  const targetAuthority = ({ target }: { readonly target: {
    readonly committerDeviceId: string;
  } }) => target.committerDeviceId === "device-a"
    ? signingA.publicKey
    : signingB.publicKey;
  const envelopeAuthority = ({ committerDeviceId }: {
    readonly committerDeviceId: string;
  }) => committerDeviceId === "device-a"
    ? signingA.publicKey
    : signingB.publicKey;
  return {
    crypto,
    managerSigning,
    signingA,
    signingB,
    runtime,
    currentA,
    nextB,
    activeConfigObject,
    inventory,
    plan,
    managerAuthority,
    targetAuthority,
    envelopeAuthority,
  };
}

async function fixture() {
  const state = setup();
  const source = prepareAgentRuntimeAuthorizationTransitionSourceV2({
    crypto: state.crypto,
    currentState: {
      agentId: state.runtime.agentId,
      authorizationRevision: state.plan.oldAuthorizationRevision,
      runtimeGeneration: state.runtime.generation,
    },
    currentRuntime: state.runtime,
    plan: state.plan,
    resolveCurrentManagerAuthority: state.managerAuthority,
    managerSigningPrivateKey: state.managerSigning.privateKey,
  });
  const targetPlan = source.publicCandidate.targetIntents[0]!;
  const ephemeral = await state.crypto.generateEncryptionKeyPair();
  const challenge = prepareAgentRuntimeManagerHandoffChallenge({
    crypto: state.crypto,
    plan: targetPlan,
    targetEphemeralPublicKey: ephemeral.publicKey,
    targetCommitterSigningPrivateKey: state.signingB.privateKey,
    resolveCurrentTargetCommitter: state.targetAuthority,
    ttlMs: 60_000,
  });
  const response = await prepareAgentRuntimeManagerHandoffResponse({
    crypto: state.crypto,
    challengeBytes: challenge.challengeBytes,
    expectedPlan: targetPlan,
    freshRuntime: source.sourceLocal.runtime,
    managerSigningPrivateKey: state.managerSigning.privateKey,
    resolveCurrentManagerAuthority: state.managerAuthority,
    resolveCurrentTargetCommitter: state.targetAuthority,
  });
  const completion = await prepareAgentRuntimeManagerHandoffTarget({
    crypto: state.crypto,
    challengeBytes: challenge.challengeBytes,
    responseBytes: response,
    expectedPlan: targetPlan,
    trustedChallengeState: {
      challengeHash: challenge.challengeHash,
      consumed: false,
    },
    targetEphemeralPrivateKey: ephemeral.privateKey,
    targetDomainRoot: bytes(0x32),
    targetCommitterSigningPrivateKey: state.signingB.privateKey,
    resolveCurrentManagerAuthority: state.managerAuthority,
    resolveCurrentTargetCommitter: state.targetAuthority,
  });
  const currentEnvelope = sealAgentRuntimeToDomain({
    crypto: state.crypto,
    domainRoot: bytes(0x31),
    runtime: state.runtime,
    context: state.currentA,
    committerSigningPrivateKey: state.signingA.privateKey,
    currentCommitterAuthorized: () => true,
  });
  const currentEnvelopeBytes =
    serializeAgentRuntimeDomainEnvelope(currentEnvelope);
  const currentStorageState = {
    runtime: source.publicCandidate.expectedState,
    configInventory: state.inventory,
    configObjects: [{
      agentId: state.activeConfigObject.agentId,
      objectId: state.activeConfigObject.objectId,
      configRevision: state.activeConfigObject.configRevision,
      runtimeGeneration: state.activeConfigObject.runtimeGeneration,
      wrappedDekHash: state.crypto.hash(state.activeConfigObject.wrappedDek),
      wrappedDek: opaqueBytes(
        "agent-runtime-config-dek",
        state.activeConfigObject.wrappedDek,
      ),
    }],
    domainEnvelopes: [{
      agentId: state.runtime.agentId,
      ...state.currentA,
      runtimeGeneration: state.runtime.generation,
      envelopeHash: state.crypto.hash(currentEnvelopeBytes),
      envelopeBytes: opaqueBytes(
        "agent-runtime-domain-envelope",
        currentEnvelopeBytes,
      ),
    }],
    challengeConsumptions: [{
      challengeHash: challenge.challengeHash,
      consumed: false,
    }],
  };
  return { state, source, completion, currentStorageState };
}

describe("Agent Runtime authorization-only transition", () => {
  test("storage capability binds the complete authorization-transition write set", async () => {
    const { state, source, completion, currentStorageState } = await fixture();
    const candidate = aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets: [completion],
      currentStorageState,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
    });
    const signerPublication = agentRuntimeSignerPublicationForTesting({
      state: candidate.expected.runtime,
      transitionKind: "rotation",
    });
    type AuthorizationInput = Parameters<
      typeof authorizeAgentRuntimeAuthorizationTransitionWriteV2
    >[0];
    const authorizationInput: AuthorizationInput = {
      expected: candidate.expected,
      intended: candidate.intended,
      authorization: {
        purpose: "persist-agent-runtime-authorization-transition",
        operationId: state.plan.operationId,
        currentState: candidate.expected.runtime,
        nextState: candidate.intended.runtime,
        remainingDomains: candidate.intended.domainEnvelopes.map((domain) => ({
          domainId: domain.domainId,
          domainEpoch: domain.domainEpoch,
          agentAuthorizationRevision: domain.agentAuthorizationRevision,
          committerDeviceId: domain.committerDeviceId,
        })),
        refreshedDomainIds: state.plan.refreshedDomainIds,
      },
      signerPublication,
    };
    expect(() =>
      authorizeAgentRuntimeAuthorizationTransitionWriteV2(authorizationInput)
    ).not.toThrow();

    const mismatches: readonly ((
      value: AuthorizationInput,
    ) => AuthorizationInput)[] = [
      (value) => ({
        ...value,
        authorization: {
          ...value.authorization,
          purpose: "wrong-purpose" as never,
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
          nextState: {
            ...value.authorization.nextState,
            authorizationRevision: authorizationRevision(
              value.authorization.nextState.authorizationRevision + 1,
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
    ];
    for (const mismatch of mismatches) {
      expect(() =>
        authorizeAgentRuntimeAuthorizationTransitionWriteV2(
          mismatch(authorizationInput),
        )
      ).toThrow("does not match its write set");
    }

    for (const malformed of [
      { ...authorizationInput, expected: null },
      { ...authorizationInput, expected: "not-an-object" },
      { ...authorizationInput, intended: null },
      { ...authorizationInput, intended: "not-an-object" },
      { ...authorizationInput, authorization: null },
      {
        ...authorizationInput,
        authorization: {
          ...authorizationInput.authorization,
          unexpectedField: true,
        },
      },
      {
        ...authorizationInput,
        authorization: {
          ...authorizationInput.authorization,
          remainingDomains: null,
        },
      },
      {
        ...authorizationInput,
        authorization: {
          ...authorizationInput.authorization,
          refreshedDomainIds: null,
        },
      },
    ]) {
      expect(() =>
        authorizeAgentRuntimeAuthorizationTransitionWriteV2(
          malformed as never,
        )
      ).toThrow();
    }

    const capability =
      authorizeAgentRuntimeAuthorizationTransitionWriteV2(authorizationInput);
    expect(
      consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2(capability)
        .intended.runtime,
    ).toEqual(candidate.intended.runtime);
    expect(() =>
      consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2(capability)
    ).toThrow("authorized write capability");
    for (const forged of [null, "not-a-capability", {}, {
      expected: candidate.expected,
      intended: candidate.intended,
      authorization: authorizationInput.authorization,
      signerPublication,
    }]) {
      expect(() =>
        consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2(
          forged as never,
        )
      ).toThrow("authorized write capability");
    }
    const mutated =
      authorizeAgentRuntimeAuthorizationTransitionWriteV2(authorizationInput);
    Object.assign(mutated.authorization.remainingDomains[0]!, {
      domainId: cryptoDomainId("domain-mutated-after-mint"),
    });
    expect(() =>
      consumeAuthorizedAgentRuntimeAuthorizationTransitionWriteV2(mutated)
    ).toThrow("authorized write capability");
  });

  test("adds one Domain atomically without rotating Runtime or config", async () => {
    const { state, source, completion, currentStorageState } =
      await fixture();
    let envelopeAuthorityContext: unknown;
    const candidate = aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets: [completion],
      currentStorageState,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: (context) => {
        envelopeAuthorityContext = context;
        return state.envelopeAuthority(context);
      },
    });
    expect(envelopeAuthorityContext).toEqual({
      purpose: "agent-runtime-authorization-transition-envelope",
      operationId: state.plan.operationId,
      agentId: state.plan.agentId,
      runtimeGeneration: state.plan.currentRuntimeGeneration,
      ...state.currentA,
    });

    expect(candidate.intended.runtime).toEqual({
      agentId: state.runtime.agentId,
      authorizationRevision: authorizationRevision(21),
      runtimeGeneration: state.runtime.generation,
    });
    expect(candidate.intended.configObjects).toEqual(
      currentStorageState.configObjects,
    );
    expect(candidate.intended.domainEnvelopes.map((entry) => entry.domainId))
      .toEqual(["domain-a", "domain-b"]);
    expect(
      candidate.intended.domainEnvelopes[0]!.envelopeBytes.ciphertext,
    ).toEqual(
      currentStorageState.domainEnvelopes[0]!.envelopeBytes.ciphertext,
    );
    expect(candidate.intended.challengeConsumptions).toEqual([{
      challengeHash:
        currentStorageState.challengeConsumptions[0]!.challengeHash,
      consumed: true,
    }]);
    expect(hex(source.publicCandidate.manifestHash)).toBe(
      "ef61b85626b06bf650f4884beb09cd89a52727bb7259ab15f344c331b54e3d72",
    );
    expect(hex(source.publicCandidate.managerSignature)).toBe(
      "c0958753792c092e2c81d3a7d9b84a6bb15d06ecae91a6f45adb2f75efed78c2"
        + "58b9fb176250e0bf9f65d78599e64f86f60c34092910f913aca96e6dd7b73d0e",
    );
    destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
      source.sourceLocal,
    );
    expect(source.sourceLocal.runtime.key.every((byte) => byte === 0))
      .toBeTrue();
  });

  test("rejects an omitted refresh, tampered manifest, and unreserved challenge", async () => {
    const { state, source, completion, currentStorageState } =
      await fixture();
    const prepare = (overrides: Partial<Parameters<
      typeof prepareAgentRuntimeAuthorizationTransitionSourceV2
    >[0]> = {}) => prepareAgentRuntimeAuthorizationTransitionSourceV2({
      crypto: state.crypto,
      currentState: source.publicCandidate.expectedState,
      currentRuntime: state.runtime,
      plan: state.plan,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
      ...overrides,
    });
    for (const currentState of [
      {
        ...source.publicCandidate.expectedState,
        agentId: agentId("other-agent"),
      },
      {
        ...source.publicCandidate.expectedState,
        authorizationRevision: authorizationRevision(999),
      },
      {
        ...source.publicCandidate.expectedState,
        runtimeGeneration: agentRuntimeGeneration(999),
      },
    ]) {
      expect(() => prepare({ currentState })).toThrow(
        "state does not match its plan",
      );
    }
    for (const currentRuntime of [
      { ...state.runtime, agentId: agentId("other-agent") },
      {
        ...state.runtime,
        generation: agentRuntimeGeneration(999),
      },
    ]) {
      expect(() => prepare({ currentRuntime })).toThrow(
        "Current Agent Runtime does not match",
      );
    }
    expect(() => prepare({
      resolveCurrentManagerAuthority: () => null,
    })).toThrow("manager is not currently authorized");
    expect(() => prepare({
      resolveCurrentManagerAuthority: () => state.signingA.publicKey,
    })).toThrow("manager key does not match current authority");
    expect(() => prepare({
      plan: {
        ...state.plan,
        currentDomains: [],
        refreshedDomainIds: [state.currentA.domainId, "domain-c"],
      },
    })).toThrow("refresh set is not exact");
    let managerContext: unknown;
    const prepared = prepare({
      resolveCurrentManagerAuthority: (context) => {
        managerContext = context;
        return state.managerSigning.publicKey;
      },
    });
    expect(managerContext).toEqual({
      purpose: "agent-runtime-authorization-transition-source",
      operationId: state.plan.operationId,
      agentId: state.plan.agentId,
      oldAuthorizationRevision: state.plan.oldAuthorizationRevision,
      newAuthorizationRevision: state.plan.newAuthorizationRevision,
      runtimeGeneration: state.plan.currentRuntimeGeneration,
      ...state.plan.currentManager,
    });
    destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
      prepared.sourceLocal,
    );
    expect(() =>
      prepareAgentRuntimeAuthorizationTransitionSourceV2({
        crypto: state.crypto,
        currentState: source.publicCandidate.expectedState,
        currentRuntime: state.runtime,
        plan: {
          ...state.plan,
          refreshedDomainIds: [],
        },
        resolveCurrentManagerAuthority: state.managerAuthority,
        managerSigningPrivateKey: state.managerSigning.privateKey,
      })
    ).toThrow("refresh set is not exact");
    const preparePlan = (plan: unknown) => () =>
      prepareAgentRuntimeAuthorizationTransitionSourceV2({
        crypto: state.crypto,
        currentState: source.publicCandidate.expectedState,
        currentRuntime: state.runtime,
        plan: plan as AgentRuntimeAuthorizationTransitionPlanV2,
        resolveCurrentManagerAuthority: state.managerAuthority,
        managerSigningPrivateKey: state.managerSigning.privateKey,
      });
    const malformedPlans: readonly [unknown, string][] = [
      [null, "plan must be an object"],
      [{ ...state.plan, extra: true }, "invalid field set"],
      [{
        ...state.plan,
        newAuthorizationRevision: state.plan.oldAuthorizationRevision,
      }, "advance exactly once"],
      [{ ...state.plan, currentManager: null }, "manager must be an object"],
      [{ ...state.plan, currentDomains: null }, "bounded array"],
      [{
        ...state.plan,
        currentDomains: [state.currentA, state.currentA],
      }, "sorted and unique"],
      [{
        ...state.plan,
        remainingDomains: [state.nextB, state.currentA],
      }, "sorted and unique"],
      [{
        ...state.plan,
        refreshedDomainIds: [state.nextB.domainId, state.nextB.domainId],
      }, "sorted and unique"],
      [{ ...state.plan, refreshedDomainIds: null }, "must be bounded"],
      [{
        ...state.plan,
        refreshedDomainIds: Array.from(
          { length: V2_LIMITS.agentGrantDomains + 1 },
          (_, index) => `domain-${String(index).padStart(5, "0")}`,
        ),
      }, "must be bounded"],
      [{
        ...state.plan,
        refreshedDomainIds: [state.nextB.domainId, "domain-c"],
      }, "refresh set is not exact"],
      [{
        ...state.plan,
        currentDomains: Array.from(
          { length: V2_LIMITS.agentGrantDomains + 1 },
          (_, index) => ({
            ...state.currentA,
            domainId: cryptoDomainId(`domain-${String(index).padStart(5, "0")}`),
          }),
        ),
      }, "bounded array"],
      [{
        ...state.plan,
        activeConfigInventory: {
          ...state.inventory,
          objectCount: -1,
        },
      }, "inventory count is invalid"],
      [{
        ...state.plan,
        activeConfigInventory: {
          ...state.inventory,
          objectCount: V2_LIMITS.batchItems + 1,
        },
      }, "inventory count is invalid"],
      [{
        ...state.plan,
        activeConfigInventory: {
          ...state.inventory,
          digest: bytes(0x55, 31),
        },
      }, "digest must contain exactly 32 bytes"],
    ];
    for (const [plan, message] of malformedPlans) {
      expect(preparePlan(plan)).toThrow(message);
    }
    const maximumDomains = Object.freeze(Array.from(
      { length: V2_LIMITS.agentGrantDomains },
      (_, index) => Object.freeze({
        ...state.currentA,
        domainId: cryptoDomainId(
          `domain-${String(index).padStart(5, "0")}`,
        ),
      }),
    ));
    const emptyInventory = agentRuntimeConfigInventoryCommitmentV2({
      crypto: state.crypto,
      agentId: state.runtime.agentId,
      runtimeGeneration: state.runtime.generation,
      activeConfigObjects: [],
    });
    for (const plan of [
      {
        ...state.plan,
        currentDomains: maximumDomains,
        remainingDomains: maximumDomains,
        refreshedDomainIds: [],
      },
      {
        ...state.plan,
        currentDomains: [],
        remainingDomains: maximumDomains,
        refreshedDomainIds: maximumDomains.map((domain) => domain.domainId),
      },
      {
        ...state.plan,
        activeConfigInventory: {
          ...state.inventory,
          objectCount: V2_LIMITS.batchItems,
        },
      },
      {
        ...state.plan,
        activeConfigInventory: emptyInventory,
      },
    ]) {
      const boundarySource = prepare({ plan });
      destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
        boundarySource.sourceLocal,
      );
    }
    const prefixDomains = Object.freeze([
      Object.freeze({ ...state.currentA, domainId: cryptoDomainId("a") }),
      Object.freeze({ ...state.currentA, domainId: cryptoDomainId("aa") }),
    ]);
    const prefixSource = prepare({
      plan: {
        ...state.plan,
        currentDomains: prefixDomains,
        remainingDomains: prefixDomains,
        refreshedDomainIds: [],
      },
    });
    destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
      prefixSource.sourceLocal,
    );
    for (const changedCurrentDomain of [
      { ...state.currentA, domainEpoch: domainEpoch(5) },
      {
        ...state.currentA,
        agentAuthorizationRevision: authorizationRevision(13),
      },
      {
        ...state.currentA,
        committerDeviceId: cryptoDeviceId("device-other"),
      },
    ]) {
      const changedDomainSource = prepare({
        plan: {
          ...state.plan,
          remainingDomains: [changedCurrentDomain, state.nextB],
          refreshedDomainIds: [state.currentA.domainId, state.nextB.domainId],
        },
      });
      destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
        changedDomainSource.sourceLocal,
      );
    }
    const aggregate = (
      publicCandidate: typeof source.publicCandidate,
      resolveCurrentManagerAuthority: Parameters<
        typeof aggregateAgentRuntimeAuthorizationTransitionV2
      >[0]["resolveCurrentManagerAuthority"] = state.managerAuthority,
    ) => () => aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate,
      completedTargets: [completion],
      currentStorageState,
      resolveCurrentManagerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
    });
    for (const nextState of [
      {
        ...source.publicCandidate.nextState,
        agentId: agentId("other-agent"),
      },
      {
        ...source.publicCandidate.nextState,
        authorizationRevision: authorizationRevision(999),
      },
      {
        ...source.publicCandidate.nextState,
        runtimeGeneration: agentRuntimeGeneration(999),
      },
    ]) {
      expect(aggregate({
        ...source.publicCandidate,
        nextState,
      })).toThrow("next state is invalid");
    }
    expect(aggregate(source.publicCandidate, () => null)).toThrow(
      "manager signature is invalid",
    );
    expect(aggregate(source.publicCandidate, () =>
      state.signingA.publicKey)).toThrow("manager signature is invalid");
    expect(aggregate({
      ...source.publicCandidate,
      managerSignature: bytes(0xaa, V2_LIMITS.signatureBytes),
    })).toThrow("manager signature is invalid");
    for (const targetIntents of [
      [],
      null,
      [{
        ...source.publicCandidate.targetIntents[0]!,
        operationId: "other-operation",
      }],
    ]) {
      expect(aggregate({
        ...source.publicCandidate,
        targetIntents: targetIntents as never,
      })).toThrow("target intents are invalid");
    }
    const signingC = state.crypto.generateSigningKeyPair();
    const nextC = Object.freeze({
      ...state.nextB,
      domainId: cryptoDomainId("domain-c"),
      committerDeviceId: cryptoDeviceId("device-c"),
    });
    const twoTargetPlan = Object.freeze({
      ...state.plan,
      remainingDomains: Object.freeze([
        state.currentA,
        state.nextB,
        nextC,
      ]),
      refreshedDomainIds: Object.freeze([
        state.nextB.domainId,
        nextC.domainId,
      ]),
    });
    const twoTargetAuthority = ({ target }: { readonly target: {
      readonly committerDeviceId: string;
    } }) => target.committerDeviceId === state.nextB.committerDeviceId
      ? state.signingB.publicKey
      : signingC.publicKey;
    const twoTargetSource = prepare({
      plan: twoTargetPlan,
    });
    const prepareCompletion = async (
      targetPlan: typeof twoTargetSource.publicCandidate.targetIntents[number],
      signing: typeof signingC,
      rootFill: number,
    ) => {
      const ephemeral = await state.crypto.generateEncryptionKeyPair();
      const challenge = prepareAgentRuntimeManagerHandoffChallenge({
        crypto: state.crypto,
        plan: targetPlan,
        targetEphemeralPublicKey: ephemeral.publicKey,
        targetCommitterSigningPrivateKey: signing.privateKey,
        resolveCurrentTargetCommitter: twoTargetAuthority,
        ttlMs: 60_000,
      });
      const response = await prepareAgentRuntimeManagerHandoffResponse({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        expectedPlan: targetPlan,
        freshRuntime: twoTargetSource.sourceLocal.runtime,
        managerSigningPrivateKey: state.managerSigning.privateKey,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: twoTargetAuthority,
      });
      return prepareAgentRuntimeManagerHandoffTarget({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        responseBytes: response,
        expectedPlan: targetPlan,
        trustedChallengeState: {
          challengeHash: challenge.challengeHash,
          consumed: false,
        },
        targetEphemeralPrivateKey: ephemeral.privateKey,
        targetDomainRoot: bytes(rootFill),
        targetCommitterSigningPrivateKey: signing.privateKey,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: twoTargetAuthority,
      });
    };
    const twoCompletions = await Promise.all([
      prepareCompletion(
        twoTargetSource.publicCandidate.targetIntents[0]!,
        state.signingB,
        0x32,
      ),
      prepareCompletion(
        twoTargetSource.publicCandidate.targetIntents[1]!,
        signingC,
        0x33,
      ),
    ]);
    const twoTargetStorage = {
      ...currentStorageState,
      challengeConsumptions: twoCompletions.map((target) => ({
        challengeHash: target.challengeConsumption.challengeHash,
        consumed: false,
      })).sort((left, right) =>
        hex(left.challengeHash).localeCompare(hex(right.challengeHash))
      ),
    };
    const aggregateTwoTargets = (
      publicCandidate = twoTargetSource.publicCandidate,
      completedTargets = twoCompletions,
      storage = twoTargetStorage,
    ) => () => aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate,
      completedTargets,
      currentStorageState: storage,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: twoTargetAuthority,
      resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
    });
    expect(aggregateTwoTargets({
      ...twoTargetSource.publicCandidate,
      targetIntents: [
        twoTargetSource.publicCandidate.targetIntents[0]!,
        {
          ...twoTargetSource.publicCandidate.targetIntents[1]!,
          operationId: "other-operation",
        },
      ],
    })).toThrow("target intents are invalid");
    expect(aggregateTwoTargets(
      twoTargetSource.publicCandidate,
      [twoCompletions[1], twoCompletions[0]],
    )).toThrow("target order is invalid");
    const twoTargetCandidate = aggregateTwoTargets()();
    expect(twoTargetCandidate.intended.challengeConsumptions.every(
      (entry) => entry.consumed,
    )).toBeTrue();
    expect(aggregateTwoTargets(
      twoTargetSource.publicCandidate,
      twoCompletions,
      {
        ...twoTargetStorage,
        challengeConsumptions: twoTargetStorage.challengeConsumptions.map(
          (entry, index) => ({ ...entry, consumed: index === 0 }),
        ),
      },
    )).toThrow("challenge is not reserved");
    destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
      twoTargetSource.sourceLocal,
    );
    const inventoryCountSource = prepare({
      plan: {
        ...state.plan,
        activeConfigInventory: {
          ...state.inventory,
          objectCount: 2,
        },
        remainingDomains: [state.currentA],
        refreshedDomainIds: [],
      },
    });
    expect(() => aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate: inventoryCountSource.publicCandidate,
      completedTargets: [],
      currentStorageState,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
    })).toThrow("storage does not match the transition plan");
    destroyAgentRuntimeAuthorizationTransitionSourceLocalV2(
      inventoryCountSource.sourceLocal,
    );
    const aggregateStored = (
      storageState: typeof currentStorageState,
      completedTargets: Parameters<
        typeof aggregateAgentRuntimeAuthorizationTransitionV2
      >[0]["completedTargets"] = [completion],
    ) => () => aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets,
      currentStorageState: storageState,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
    });
    for (const currentStorageStateVariant of [
      {
        ...currentStorageState,
        runtime: {
          ...currentStorageState.runtime,
          agentId: agentId("other-agent"),
        },
        domainEnvelopes: currentStorageState.domainEnvelopes.map((record) => ({
          ...record,
          agentId: agentId("other-agent"),
        })),
      },
      {
        ...currentStorageState,
        runtime: {
          ...currentStorageState.runtime,
          authorizationRevision: authorizationRevision(999),
        },
      },
      {
        ...currentStorageState,
        runtime: {
          ...currentStorageState.runtime,
          runtimeGeneration: agentRuntimeGeneration(999),
        },
        domainEnvelopes: currentStorageState.domainEnvelopes.map((record) => ({
          ...record,
          runtimeGeneration: agentRuntimeGeneration(999),
        })),
      },
      { ...currentStorageState, domainEnvelopes: [] },
    ]) {
      expect(aggregateStored(currentStorageStateVariant)).toThrow();
    }
    const storageWithEnvelope = (
      runtime: typeof state.runtime,
      context: typeof state.currentA,
    ): typeof currentStorageState => {
      const configMetadata = {
        agentId: runtime.agentId,
        objectId: state.activeConfigObject.objectId,
        configRevision: state.activeConfigObject.configRevision,
        runtimeGeneration: runtime.generation,
      };
      const wrappedDek = state.crypto.aeadSeal(
        runtime.key,
        bytes(0xa1),
        agentRuntimeConfigDekAadV2(configMetadata),
      );
      const configObject = { ...configMetadata, wrappedDek };
      const sameRuntime = runtime.agentId === state.runtime.agentId
        && runtime.generation === state.runtime.generation;
      const envelope = sealAgentRuntimeToDomain({
        crypto: state.crypto,
        domainRoot: bytes(0x31),
        runtime,
        context,
        committerSigningPrivateKey: state.signingA.privateKey,
        currentCommitterAuthorized: () => true,
      });
      const envelopeBytes = serializeAgentRuntimeDomainEnvelope(envelope);
      return {
        ...currentStorageState,
        runtime: {
          agentId: runtime.agentId,
          authorizationRevision: state.plan.oldAuthorizationRevision,
          runtimeGeneration: runtime.generation,
        },
        configInventory: sameRuntime
          ? currentStorageState.configInventory
          : agentRuntimeConfigInventoryCommitmentV2({
            crypto: state.crypto,
            agentId: runtime.agentId,
            runtimeGeneration: runtime.generation,
            activeConfigObjects: [configObject],
          }),
        configObjects: sameRuntime
          ? currentStorageState.configObjects
          : [{
            agentId: configObject.agentId,
            objectId: configObject.objectId,
            configRevision: configObject.configRevision,
            runtimeGeneration: configObject.runtimeGeneration,
            wrappedDekHash: state.crypto.hash(wrappedDek),
            wrappedDek: opaqueBytes("agent-runtime-config-dek", wrappedDek),
          }],
        domainEnvelopes: [{
          agentId: runtime.agentId,
          ...context,
          runtimeGeneration: runtime.generation,
          envelopeHash: state.crypto.hash(envelopeBytes),
          envelopeBytes: opaqueBytes(
            "agent-runtime-domain-envelope",
            envelopeBytes,
          ),
        }],
      };
    };
    for (const [runtime, context] of [
      [state.runtime, {
        ...state.currentA,
        domainId: cryptoDomainId("other-domain"),
      }],
      [state.runtime, {
        ...state.currentA,
        domainEpoch: domainEpoch(999),
      }],
      [state.runtime, {
        ...state.currentA,
        agentAuthorizationRevision: authorizationRevision(999),
      }],
      [state.runtime, {
        ...state.currentA,
        committerDeviceId: cryptoDeviceId("other-device"),
      }],
      [{ ...state.runtime, agentId: agentId("other-agent") }, state.currentA],
      [{
        ...state.runtime,
        generation: agentRuntimeGeneration(999),
      }, state.currentA],
    ] as const) {
      expect(aggregateStored(storageWithEnvelope(runtime, context))).toThrow(
        "storage does not match the transition plan",
      );
    }
    for (const completedTargets of [[], null]) {
      expect(aggregateStored(
        currentStorageState,
        completedTargets as never,
      )).toThrow("target coverage is incomplete");
    }
    expect(() => aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets: [completion],
      currentStorageState,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: () => null,
    })).toThrow("envelope proof is invalid");
    expect(() => aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets: [completion],
      currentStorageState,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: () => state.signingB.publicKey,
    })).toThrow("envelope proof is invalid");
    expect(() =>
      aggregateAgentRuntimeAuthorizationTransitionV2({
        crypto: state.crypto,
        publicCandidate: {
          ...source.publicCandidate,
          manifestHash: bytes(0xff),
        },
        completedTargets: [completion],
        currentStorageState,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
        resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
      })
    ).toThrow("manifest hash is invalid");
    const partiallyMatchingManifestHash = bytes(0xff);
    partiallyMatchingManifestHash[0] = source.publicCandidate.manifestHash[0]!;
    expect(() =>
      aggregateAgentRuntimeAuthorizationTransitionV2({
        crypto: state.crypto,
        publicCandidate: {
          ...source.publicCandidate,
          manifestHash: partiallyMatchingManifestHash,
        },
        completedTargets: [completion],
        currentStorageState,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
        resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
      })
    ).toThrow("manifest hash is invalid");
    expect(() =>
      aggregateAgentRuntimeAuthorizationTransitionV2({
        crypto: state.crypto,
        publicCandidate: {
          ...source.publicCandidate,
          nextState: {
            ...source.publicCandidate.nextState,
            rawRuntimeKey: bytes(0xee),
          } as never,
        },
        completedTargets: [completion],
        currentStorageState,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
        resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
      })
    ).toThrow("invalid field set");
    expect(() =>
      aggregateAgentRuntimeAuthorizationTransitionV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [completion],
        currentStorageState: {
          ...currentStorageState,
          challengeConsumptions: [],
        },
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
        resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
      })
    ).toThrow("challenge is not reserved");
    expect(aggregateStored({
      ...currentStorageState,
      challengeConsumptions: currentStorageState.challengeConsumptions.map(
        (entry) => ({ ...entry, consumed: true }),
      ),
    })).toThrow("challenge is not reserved");
  });

  test("persists old-or-new state exactly and exposes ambiguous outcomes", async () => {
    const { state, source, completion, currentStorageState } =
      await fixture();
    const candidate = aggregateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets: [completion],
      currentStorageState,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
      resolveCurrentEnvelopeCommitter: state.envelopeAuthority,
    });
    const store = new InMemoryV2Store();
    const initialDomains = state.plan.currentDomains.map((domain) => ({
      ...domain,
      committerSigningPublicKey: state.signingA.publicKey,
    }));
    const initialSignerPublication =
      agentRuntimeSignerPublicationForTesting({
        state: candidate.expected.runtime,
        transitionKind:
          candidate.expected.runtime.runtimeGeneration === 0
            ? "initialization"
            : "rotation",
      });
    expect(await store.putAgentRuntimeAtomicStateIfAbsent(
      authorizeAgentRuntimeInitializationWriteV2({
        state: candidate.expected,
        authorization: {
          context: {
            purpose: "persist-agent-runtime-initialization",
            operationId: initialSignerPublication.operationId,
            expectedState: candidate.expected.runtime,
            expectedManager: {
              managerHumanId:
                initialSignerPublication.managerHumanId,
              managerAuthorizationRevision:
                initialSignerPublication.managerAuthorizationRevision,
              managerDeviceId:
                initialSignerPublication.managerDeviceId,
            },
            configInventory: candidate.expected.configInventory,
            expectedDomains: state.plan.currentDomains,
          },
          currentManager: {
            managerHumanId: initialSignerPublication.managerHumanId,
            managerAuthorizationRevision:
              initialSignerPublication.managerAuthorizationRevision,
            managerDeviceId: initialSignerPublication.managerDeviceId,
          },
          currentManagerSigningPublicKey: state.managerSigning.publicKey,
          authorizedDomains: initialDomains,
        },
        signerPublication: initialSignerPublication,
      }),
    )).toBe("inserted");
    let currentState = candidate.expected.runtime;
    const resolve = () => ({
      currentState,
      currentManager: state.plan.currentManager,
      managerSigningPublicKey: state.managerSigning.publicKey,
      currentDomains: initialDomains,
      remainingDomains: state.plan.remainingDomains.map((domain) => ({
        ...domain,
        committerSigningPublicKey:
          domain.domainId === "domain-a"
            ? state.signingA.publicKey
            : state.signingB.publicKey,
      })),
    });
    const persist = (
      storage: Parameters<
        typeof persistAgentRuntimeAuthorizationTransitionV2
      >[0]["storage"],
      resolveCurrentAuthorization: Parameters<
        typeof persistAgentRuntimeAuthorizationTransitionV2
      >[0]["resolveCurrentAuthorization"],
    ) => persistAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      storage,
      candidate,
      resolveCurrentAuthorization,
    });
    expect(await persist(new InMemoryV2Store(), () => {
      throw new Error("resolver must not run without storage state");
    })).toBe("stale");
    expect(await persist({
      getAgentRuntimeAtomicState:
        store.getAgentRuntimeAtomicState.bind(store),
      getAgentRuntimeSignerPublication: async () => null,
      compareAndSwapAgentRuntimeAuthorizationTransition: async () => {
        throw new Error("CAS must not run without signer publication");
      },
    }, resolve)).toBe("stale");
    expect(await persist(store, () => null)).toBe("stale");
    for (const changed of [
      {
        ...resolve(),
        currentState: {
          ...candidate.expected.runtime,
          authorizationRevision: authorizationRevision(998),
        },
      },
      {
        ...resolve(),
        currentManager: {
          ...state.plan.currentManager,
          managerDeviceId: cryptoDeviceId("stale-manager-device"),
        },
      },
      {
        ...resolve(),
        currentDomains: initialDomains.map((domain) => ({
          ...domain,
          domainId: cryptoDomainId("wrong-domain"),
        })),
      },
      { ...resolve(), currentDomains: [] },
      { ...resolve(), remainingDomains: [] },
    ]) {
      expect(await persist(store, () => changed)).toBe("stale");
    }
    const maximumAuthorizedDomains = Array.from(
      { length: V2_LIMITS.agentGrantDomains },
      (_, index) => ({
        ...initialDomains[0]!,
        domainId: cryptoDomainId(
          `domain-${String(index).padStart(5, "0")}`,
        ),
      }),
    );
    expect(await persist(store, () => ({
      ...resolve(),
      currentDomains: maximumAuthorizedDomains,
      remainingDomains: maximumAuthorizedDomains,
    }))).toBe("stale");
    for (const currentDomains of [
      [initialDomains[0]!, initialDomains[0]!],
      [...maximumAuthorizedDomains, {
        ...initialDomains[0]!,
        domainId: cryptoDomainId("domain-over-limit"),
      }],
    ]) {
      expect(persist(store, () => ({
        ...resolve(),
        currentDomains,
      }))).rejects.toThrow();
    }
    let invalidStatusError: unknown;
    try {
      await persist({
        getAgentRuntimeAtomicState:
          store.getAgentRuntimeAtomicState.bind(store),
        getAgentRuntimeSignerPublication:
          store.getAgentRuntimeSignerPublication.bind(store),
        compareAndSwapAgentRuntimeAuthorizationTransition: async () =>
          "invalid-status" as never,
      }, resolve);
    } catch (error) {
      invalidStatusError = error;
    }
    expect(invalidStatusError).toBeInstanceOf(TypeError);
    expect((invalidStatusError as Error).message).toContain(
      "invalid CAS status",
    );
    const storedExpected = await store.getAgentRuntimeAtomicState(
      state.runtime.agentId,
    );
    if (storedExpected === null) throw new Error("expected stored Runtime");
    let mismatchedSignerRead = false;
    expect(await persist({
      getAgentRuntimeAtomicState: async () => ({
        ...storedExpected,
        configInventory: {
          ...storedExpected.configInventory,
          digest: bytes(0xcc),
        },
      }),
      getAgentRuntimeSignerPublication: async () => {
        mismatchedSignerRead = true;
        return initialSignerPublication;
      },
      compareAndSwapAgentRuntimeAuthorizationTransition: async () => {
        throw new Error("CAS must not run for mismatched stored state");
      },
    }, resolve)).toBe("stale");
    expect(mismatchedSignerRead).toBeFalse();
    expect(await persist({
      getAgentRuntimeAtomicState:
        store.getAgentRuntimeAtomicState.bind(store),
      getAgentRuntimeSignerPublication:
        store.getAgentRuntimeSignerPublication.bind(store),
      compareAndSwapAgentRuntimeAuthorizationTransition: async () => "stale",
    }, resolve)).toBe("stale");
    expect(persistAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      storage: store,
      candidate,
      resolveCurrentAuthorization: () => ({
        ...resolve(),
        rawRuntimeKey: bytes(0xee),
      } as never),
    })).rejects.toThrow("invalid field set");
    expect(
      (await store.getAgentRuntimeAtomicState(state.runtime.agentId))?.runtime,
    ).toEqual(candidate.expected.runtime);
    expect(await persistAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      storage: store,
      candidate,
      resolveCurrentAuthorization: resolve,
    })).toBe("applied");
    currentState = candidate.intended.runtime;
    expect(await persistAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      storage: store,
      candidate,
      resolveCurrentAuthorization: resolve,
    })).toBe("duplicate");

    const ambiguousStore = new InMemoryV2Store();
    expect(await ambiguousStore.putAgentRuntimeAtomicStateIfAbsent(
      authorizeAgentRuntimeInitializationWriteV2({
        state: candidate.expected,
        authorization: {
          context: {
            purpose: "persist-agent-runtime-initialization",
            operationId: initialSignerPublication.operationId,
            expectedState: candidate.expected.runtime,
            expectedManager: {
              managerHumanId:
                initialSignerPublication.managerHumanId,
              managerAuthorizationRevision:
                initialSignerPublication.managerAuthorizationRevision,
              managerDeviceId:
                initialSignerPublication.managerDeviceId,
            },
            configInventory: candidate.expected.configInventory,
            expectedDomains: state.plan.currentDomains,
          },
          currentManager: {
            managerHumanId: initialSignerPublication.managerHumanId,
            managerAuthorizationRevision:
              initialSignerPublication.managerAuthorizationRevision,
            managerDeviceId: initialSignerPublication.managerDeviceId,
          },
          currentManagerSigningPublicKey: state.managerSigning.publicKey,
          authorizedDomains: initialDomains,
        },
        signerPublication: initialSignerPublication,
      }),
    )).toBe("inserted");
    currentState = candidate.expected.runtime;
    const uncertain = {
      getAgentRuntimeAtomicState:
        ambiguousStore.getAgentRuntimeAtomicState.bind(ambiguousStore),
      getAgentRuntimeSignerPublication:
        ambiguousStore.getAgentRuntimeSignerPublication.bind(ambiguousStore),
      compareAndSwapAgentRuntimeAuthorizationTransition:
        async (write: Parameters<
          InMemoryV2Store[
            "compareAndSwapAgentRuntimeAuthorizationTransition"
          ]
        >[0]) => {
          await ambiguousStore
            .compareAndSwapAgentRuntimeAuthorizationTransition(write);
          throw new Error("commit acknowledgement lost");
        },
    };
    let uncertainError: unknown;
    try {
      await persistAgentRuntimeAuthorizationTransitionV2({
        crypto: state.crypto,
        storage: uncertain,
        candidate,
        resolveCurrentAuthorization: resolve,
      });
    } catch (error) {
      uncertainError = error;
    }
    expect(uncertainError).toBeInstanceOf(
      AgentRuntimeAuthorizationTransitionOutcomeUnknownV2,
    );
    expect((uncertainError as Error).name).toBe(
      "AgentRuntimeAuthorizationTransitionOutcomeUnknownV2",
    );
    expect((uncertainError as Error).message).toBe(
      "Agent Runtime authorization transition storage outcome is unknown",
    );
    currentState = candidate.intended.runtime;
    expect(await persistAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      storage: ambiguousStore,
      candidate,
      resolveCurrentAuthorization: resolve,
    })).toBe("duplicate");

    const retryStore = new InMemoryV2Store();
    expect(await retryStore.putAgentRuntimeAtomicStateIfAbsent(
      authorizeAgentRuntimeInitializationWriteV2({
        state: candidate.expected,
        authorization: {
          context: {
            purpose: "persist-agent-runtime-initialization",
            operationId: initialSignerPublication.operationId,
            expectedState: candidate.expected.runtime,
            expectedManager: {
              managerHumanId: initialSignerPublication.managerHumanId,
              managerAuthorizationRevision:
                initialSignerPublication.managerAuthorizationRevision,
              managerDeviceId: initialSignerPublication.managerDeviceId,
            },
            configInventory: candidate.expected.configInventory,
            expectedDomains: state.plan.currentDomains,
          },
          currentManager: {
            managerHumanId: initialSignerPublication.managerHumanId,
            managerAuthorizationRevision:
              initialSignerPublication.managerAuthorizationRevision,
            managerDeviceId: initialSignerPublication.managerDeviceId,
          },
          currentManagerSigningPublicKey: state.managerSigning.publicKey,
          authorizedDomains: initialDomains,
        },
        signerPublication: initialSignerPublication,
      }),
    )).toBe("inserted");
    let retryCurrentState = candidate.expected.runtime;
    let casCalls = 0;
    const lostAcknowledgementStorage = {
      getAgentRuntimeAtomicState:
        retryStore.getAgentRuntimeAtomicState.bind(retryStore),
      getAgentRuntimeSignerPublication:
        retryStore.getAgentRuntimeSignerPublication.bind(retryStore),
      compareAndSwapAgentRuntimeAuthorizationTransition:
        async (write: Parameters<
          InMemoryV2Store[
            "compareAndSwapAgentRuntimeAuthorizationTransition"
          ]
        >[0]) => {
          casCalls += 1;
          const status = await retryStore
            .compareAndSwapAgentRuntimeAuthorizationTransition(write);
          retryCurrentState = candidate.intended.runtime;
          if (casCalls === 1) {
            throw new Error(`commit acknowledgement lost after ${status}`);
          }
          return status;
        },
    };
    const coordinate = (
      storage: Parameters<
        typeof coordinateAgentRuntimeAuthorizationTransitionV2
      >[0]["storage"],
      resolveCurrentAuthorization: Parameters<
        typeof coordinateAgentRuntimeAuthorizationTransitionV2
      >[0]["resolveCurrentAuthorization"],
    ) => coordinateAgentRuntimeAuthorizationTransitionV2({
      crypto: state.crypto,
      storage,
      publicCandidate: source.publicCandidate,
      completedTargets: [completion],
      resolveCurrentAuthorization,
    });
    expect(await coordinate(
      new InMemoryV2Store(),
      () => {
        throw new Error("resolver must not run without storage state");
      },
    )).toBe("stale");
    expect(await coordinate(retryStore, () => null)).toBe("stale");

    const currentAuthorization = () => ({
      ...resolve(),
      currentState: retryCurrentState,
    });
    for (const changed of [
      {
        ...currentAuthorization(),
        currentState: {
          ...candidate.expected.runtime,
          authorizationRevision: authorizationRevision(999),
        },
      },
      {
        ...currentAuthorization(),
        currentManager: {
          ...state.plan.currentManager,
          managerDeviceId: cryptoDeviceId("other-manager-device"),
        },
      },
      {
        ...currentAuthorization(),
        currentDomains: [],
      },
      {
        ...currentAuthorization(),
        remainingDomains: [],
      },
    ]) {
      expect(await coordinate(retryStore, () => changed)).toBe("stale");
    }
    expect(casCalls).toBe(0);

    let failingResolverCalls = 0;
    let resolverError: unknown;
    try {
      await coordinate(retryStore, () => {
        failingResolverCalls += 1;
        if (failingResolverCalls === 1) return currentAuthorization();
        throw new Error("authorization resolver unavailable");
      });
    } catch (error) {
      resolverError = error;
    }
    expect(resolverError).toBeInstanceOf(Error);
    expect((resolverError as Error).message).toBe(
      "authorization resolver unavailable",
    );
    expect(failingResolverCalls).toBe(2);
    expect(casCalls).toBe(0);

    let resolvedContexts = 0;
    const retryResolve: Parameters<
      typeof coordinateAgentRuntimeAuthorizationTransitionV2
    >[0]["resolveCurrentAuthorization"] = (context) => {
      resolvedContexts += 1;
      expect(context.purpose).toBe(
        "persist-agent-runtime-authorization-transition",
      );
      expect(context.operationId).toBe(state.plan.operationId);
      expect(context.expectedState).toEqual(candidate.expected.runtime);
      expect(context.nextState).toEqual(candidate.intended.runtime);
      expect(context.currentManager).toEqual(state.plan.currentManager);
      expect(context.currentDomains).toEqual(state.plan.currentDomains);
      expect(context.remainingDomains).toEqual(state.plan.remainingDomains);
      expect(context.refreshedDomainIds).toEqual(state.plan.refreshedDomainIds);
      return currentAuthorization();
    };
    expect(await coordinate(
      lostAcknowledgementStorage,
      retryResolve,
    )).toBe("duplicate");
    expect(casCalls).toBe(2);
    expect(resolvedContexts).toBe(3);
  });
});
