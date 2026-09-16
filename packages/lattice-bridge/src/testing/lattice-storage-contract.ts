import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  LatticeCrypto,
  persistPublishedHumanRecoveryArchive,
  publishHumanRecoveryArchive,
  unixTimestamp,
  type AgentRuntimeAtomicStorageState,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  agentRuntimeConfigInventoryCommitmentV2,
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  recoveryKeyGenerationV2,
  recoveryPublicKeyDigestV2,
  serializeGrantV2,
  type ProviderPublicHeadV2,
} from "@nautilo/lattice-crypto/wire";
import {
  authorizeAgentRuntimeAuthorizationTransitionWriteForTesting,
  authorizeAgentRuntimeChallengeReservationWriteForTesting,
  authorizeAgentRuntimeInitializationWriteForTesting,
  authorizeAgentRuntimeRotationWriteForTesting,
  agentRuntimeSignerPublicationForTesting,
  authorizeProviderHeadWriteForTesting,
  manualClock,
  seededRng,
} from "@nautilo/lattice-crypto/testing";
import { runSyntheticSharedDomainScenario } from "./synthetic-composition.ts";

export const LATTICE_STORAGE_METHODS = Object.freeze([
  "findDomain",
  "createDomainIfAbsent",
  "putDomainProviderHeadIfAbsent",
  "getDomainProviderHead",
  "compareAndSwapDomainProviderHead",
  "getBinding",
  "getNamespaceHead",
  "compareAndSwapNamespaceBindingAndHead",
  "putObject",
  "getObject",
  "getObjectAccessState",
  "compareAndSwapObjectAccessState",
  "putAgentRuntimeAtomicStateIfAbsent",
  "getAgentRuntimeAtomicState",
  "getAgentRuntimeSignerPublication",
  "compareAndSwapAgentRuntimeChallengeReservations",
  "compareAndSwapAgentRuntimeRotation",
  "compareAndSwapAgentRuntimeAuthorizationTransition",
  "putGrant",
  "getGrant",
  "consumeGrant",
  "getRecoveryArchive",
  "compareAndSwapRecoveryArchive",
] as const satisfies readonly (keyof LatticeStorage)[]);

export interface LatticeStorageContractReport {
  readonly calledMethods: typeof LATTICE_STORAGE_METHODS;
  readonly statuses: Readonly<{
    readonly domainCreate: "created" | "existing";
    readonly domainReplay: "created" | "existing";
    readonly providerCreate: "inserted" | "existing";
    readonly providerReplay: "inserted" | "existing";
    readonly providerAdvance: "applied" | "duplicate" | "stale";
    readonly providerDuplicate: "applied" | "duplicate" | "stale";
    readonly providerStale: "applied" | "duplicate" | "stale";
    readonly namespaceDuplicate: "applied" | "duplicate" | "stale";
    readonly namespaceStale: "applied" | "duplicate" | "stale";
    readonly objectDuplicate: "applied" | "duplicate" | "stale";
    readonly objectStale: "applied" | "duplicate" | "stale";
    readonly runtimeCreate: "inserted" | "existing" | "stale";
    readonly runtimeReplay: "inserted" | "existing" | "stale";
    readonly challengeReserve: "applied" | "duplicate" | "stale";
    readonly challengeDuplicate: "applied" | "duplicate" | "stale";
    readonly challengeStale: "applied" | "duplicate" | "stale";
    readonly runtimeRotate: "applied" | "duplicate" | "stale";
    readonly runtimeRotateDuplicate: "applied" | "duplicate" | "stale";
    readonly runtimeRotateStale: "applied" | "duplicate" | "stale";
    readonly runtimeAuthorizationTransition:
      "applied" | "duplicate" | "stale";
    readonly runtimeAuthorizationTransitionDuplicate:
      "applied" | "duplicate" | "stale";
    readonly runtimeAuthorizationTransitionStale:
      "applied" | "duplicate" | "stale";
    readonly recoveryCreate: "applied" | "duplicate" | "stale";
    readonly recoveryReplay: "applied" | "duplicate" | "stale";
  }>;
  readonly grant: Readonly<{
    readonly beforeConsume: boolean;
    readonly firstConsume: boolean;
    readonly secondConsumeMissing: boolean;
  }>;
}

function trackedStorage(
  storage: LatticeStorage,
  called: Set<keyof LatticeStorage>,
): LatticeStorage {
  return {
    findDomain: (...args) => {
      called.add("findDomain");
      return storage.findDomain(...args);
    },
    createDomainIfAbsent: (...args) => {
      called.add("createDomainIfAbsent");
      return storage.createDomainIfAbsent(...args);
    },
    putDomainProviderHeadIfAbsent: (...args) => {
      called.add("putDomainProviderHeadIfAbsent");
      return storage.putDomainProviderHeadIfAbsent(...args);
    },
    getDomainProviderHead: (...args) => {
      called.add("getDomainProviderHead");
      return storage.getDomainProviderHead(...args);
    },
    compareAndSwapDomainProviderHead: (...args) => {
      called.add("compareAndSwapDomainProviderHead");
      return storage.compareAndSwapDomainProviderHead(...args);
    },
    getBinding: (...args) => {
      called.add("getBinding");
      return storage.getBinding(...args);
    },
    getNamespaceHead: (...args) => {
      called.add("getNamespaceHead");
      return storage.getNamespaceHead(...args);
    },
    compareAndSwapNamespaceBindingAndHead: (...args) => {
      called.add("compareAndSwapNamespaceBindingAndHead");
      return storage.compareAndSwapNamespaceBindingAndHead(...args);
    },
    putObject: (...args) => {
      called.add("putObject");
      return storage.putObject(...args);
    },
    getObject: (...args) => {
      called.add("getObject");
      return storage.getObject(...args);
    },
    getObjectAccessState: (...args) => {
      called.add("getObjectAccessState");
      return storage.getObjectAccessState(...args);
    },
    compareAndSwapObjectAccessState: (...args) => {
      called.add("compareAndSwapObjectAccessState");
      return storage.compareAndSwapObjectAccessState(...args);
    },
    putAgentRuntimeAtomicStateIfAbsent: (...args) => {
      called.add("putAgentRuntimeAtomicStateIfAbsent");
      return storage.putAgentRuntimeAtomicStateIfAbsent(...args);
    },
    getAgentRuntimeAtomicState: (...args) => {
      called.add("getAgentRuntimeAtomicState");
      return storage.getAgentRuntimeAtomicState(...args);
    },
    getAgentRuntimeSignerPublication: (...args) => {
      called.add("getAgentRuntimeSignerPublication");
      return storage.getAgentRuntimeSignerPublication(...args);
    },
    compareAndSwapAgentRuntimeChallengeReservations: (...args) => {
      called.add("compareAndSwapAgentRuntimeChallengeReservations");
      return storage.compareAndSwapAgentRuntimeChallengeReservations(...args);
    },
    compareAndSwapAgentRuntimeRotation: (...args) => {
      called.add("compareAndSwapAgentRuntimeRotation");
      return storage.compareAndSwapAgentRuntimeRotation(...args);
    },
    compareAndSwapAgentRuntimeAuthorizationTransition: (...args) => {
      called.add("compareAndSwapAgentRuntimeAuthorizationTransition");
      return storage.compareAndSwapAgentRuntimeAuthorizationTransition(
        ...args,
      );
    },
    putGrant: (...args) => {
      called.add("putGrant");
      return storage.putGrant(...args);
    },
    getGrant: (...args) => {
      called.add("getGrant");
      return storage.getGrant(...args);
    },
    consumeGrant: (...args) => {
      called.add("consumeGrant");
      return storage.consumeGrant(...args);
    },
    getRecoveryArchive: (...args) => {
      called.add("getRecoveryArchive");
      return storage.getRecoveryArchive(...args);
    },
    compareAndSwapRecoveryArchive: (...args) => {
      called.add("compareAndSwapRecoveryArchive");
      return storage.compareAndSwapRecoveryArchive(...args);
    },
  };
}

function providerHead(
  epochValue: number,
  marker: number,
): ProviderPublicHeadV2 {
  return {
    providerId: "provider-contract",
    domainId: cryptoDomainId("domain-shared-alice-bob"),
    epoch: domainEpoch(epochValue),
    stateHash: new Uint8Array(32).fill(marker),
  };
}

function authorizeProvider(
  expected: ProviderPublicHeadV2,
  next: ProviderPublicHeadV2,
) {
  return authorizeProviderHeadWriteForTesting({
    expected,
    next,
    nextRosterBytes: new Uint8Array([0x41, 0x42, next.epoch]),
    authorization: {
      providerId: expected.providerId,
      domainId: expected.domainId,
      authorizationRevision: authorizationRevision(0),
      actorDeviceId: cryptoDeviceId("device-contract-provider"),
      operation: "update",
      targetHumanId: humanId("00000000-0000-4000-8000-00000000000a"),
      targetDeviceId: cryptoDeviceId("device-contract-target"),
      currentHead: expected,
      nextHead: next,
      candidateId: `candidate-contract-${String(next.stateHash[0])}`,
      publicTransitionDigest: new Uint8Array(32).fill(0x42),
    },
  });
}

function emptyRuntimeState(
  crypto: LatticeCrypto,
  agentValue: string,
  authorization: number,
  generation: number,
): AgentRuntimeAtomicStorageState {
  const targetAgent = agentId(agentValue);
  const targetGeneration = agentRuntimeGeneration(generation);
  return {
    runtime: {
      agentId: targetAgent,
      authorizationRevision: authorizationRevision(authorization),
      runtimeGeneration: targetGeneration,
    },
    configInventory: agentRuntimeConfigInventoryCommitmentV2({
      crypto,
      agentId: targetAgent,
      runtimeGeneration: targetGeneration,
      activeConfigObjects: [],
    }),
    configObjects: [],
    domainEnvelopes: [],
    challengeConsumptions: [],
  };
}

function authorizeRuntimeInitialization(
  state: AgentRuntimeAtomicStorageState,
) {
  const signerPublication = agentRuntimeSignerPublicationForTesting({
    state: state.runtime,
    transitionKind: "initialization",
  });
  return authorizeAgentRuntimeInitializationWriteForTesting({
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
        expectedDomains: [],
      },
      currentManager: {
        managerHumanId: signerPublication.managerHumanId,
        managerAuthorizationRevision:
          signerPublication.managerAuthorizationRevision,
        managerDeviceId: signerPublication.managerDeviceId,
      },
      currentManagerSigningPublicKey: new Uint8Array(32).fill(0x72),
      authorizedDomains: [],
    },
    signerPublication,
  });
}

function rotationExpectation(state: AgentRuntimeAtomicStorageState) {
  return {
    runtime: state.runtime,
    configInventory: state.configInventory,
    configObjects: state.configObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: object.wrappedDekHash,
    })),
    challengeConsumptions: state.challengeConsumptions,
  };
}

function runtimeManager() {
  return {
    managerHumanId: humanId(
      "00000000-0000-4000-8000-00000000000a",
    ),
    managerAuthorizationRevision: authorizationRevision(0),
    managerDeviceId: cryptoDeviceId("device-contract-runtime-manager"),
  };
}

function authorizeRuntimeRotation(
  expected: ReturnType<typeof rotationExpectation>,
  intended: AgentRuntimeAtomicStorageState,
  currentState: AgentRuntimeAtomicStorageState["runtime"],
) {
  const manager = runtimeManager();
  return authorizeAgentRuntimeRotationWriteForTesting({
    expected,
    intended,
    authorization: {
      context: {
        purpose: "persist-agent-runtime-rotation",
        operationId: "operation-contract-runtime-rotation",
        expectedState: expected.runtime,
        nextState: intended.runtime,
        expectedManager: manager,
      },
      currentState,
      currentManager: manager,
      currentManagerSigningPublicKey: new Uint8Array(32).fill(0x72),
      remainingDomains: [],
    },
    signerPublication: agentRuntimeSignerPublicationForTesting({
      state: intended.runtime,
      transitionKind: "rotation",
      operationId: "operation-contract-runtime-rotation",
    }),
  });
}

function authorizeRuntimeAuthorizationTransition(
  expected: AgentRuntimeAtomicStorageState,
  intended: AgentRuntimeAtomicStorageState,
  currentState = expected.runtime,
) {
  return authorizeAgentRuntimeAuthorizationTransitionWriteForTesting({
    expected,
    intended,
    authorization: {
      purpose: "persist-agent-runtime-authorization-transition",
      operationId: "operation-contract-runtime-authorization-transition",
      currentState,
      nextState: intended.runtime,
      remainingDomains: [],
      refreshedDomainIds: [],
    },
    signerPublication: agentRuntimeSignerPublicationForTesting({
      state: expected.runtime,
      transitionKind:
        expected.runtime.runtimeGeneration === 0
          ? "initialization"
          : "rotation",
    }),
  });
}

async function exerciseRuntime(
  storage: LatticeStorage,
  crypto: LatticeCrypto,
) {
  const challengeState = emptyRuntimeState(
    crypto,
    "agent-contract-challenge",
    0,
    0,
  );
  const runtimeCreate = await storage.putAgentRuntimeAtomicStateIfAbsent(
    authorizeRuntimeInitialization(challengeState),
  );
  const runtimeReplay = await storage.putAgentRuntimeAtomicStateIfAbsent(
    authorizeRuntimeInitialization(challengeState),
  );
  await storage.getAgentRuntimeAtomicState(
    challengeState.runtime.agentId,
  );
  await storage.getAgentRuntimeSignerPublication(
    challengeState.runtime.agentId,
    challengeState.runtime.runtimeGeneration,
  );

  const challengeExpected = {
    runtime: challengeState.runtime,
    challengeConsumptions: [],
  };
  const challengeAddition = {
    challengeHash: new Uint8Array(32).fill(0x81),
    consumed: false,
  } as const;
  const challengeAuthorization = (
    expected: typeof challengeExpected,
    addition: typeof challengeAddition,
  ) => {
    const manager = runtimeManager();
    return authorizeAgentRuntimeChallengeReservationWriteForTesting({
      expected,
      additions: [addition],
      authorization: {
        purpose: "reserve-agent-runtime-rotation-challenges",
        operationId: "operation-contract-runtime-challenge",
        expectedState: expected.runtime,
        expectedManager: manager,
        remainingDomains: [{
          domainId: cryptoDomainId("domain-shared-alice-bob"),
          domainEpoch: domainEpoch(0),
          agentAuthorizationRevision: authorizationRevision(0),
          committerDeviceId: cryptoDeviceId(
            "device-contract-runtime-domain",
          ),
        }],
        challengeHashes: [addition.challengeHash],
      },
    });
  };
  const challengeReserve =
    await storage.compareAndSwapAgentRuntimeChallengeReservations(
      challengeAuthorization(challengeExpected, challengeAddition),
    );
  const challengeDuplicate =
    await storage.compareAndSwapAgentRuntimeChallengeReservations(
      challengeAuthorization(challengeExpected, challengeAddition),
    );
  const concurrentChallengeReplays = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        storage.compareAndSwapAgentRuntimeChallengeReservations(
          challengeAuthorization(challengeExpected, challengeAddition),
        ),
    ),
  );
  if (concurrentChallengeReplays.some((status) => status !== "duplicate")) {
    throw new Error("Concurrent Runtime challenge replay did not converge");
  }
  const staleExpected = {
    runtime: {
      ...challengeState.runtime,
      runtimeGeneration: agentRuntimeGeneration(9),
    },
    challengeConsumptions: [],
  };
  const staleAddition = {
    challengeHash: new Uint8Array(32).fill(0x82),
    consumed: false,
  } as const;
  const challengeStale =
    await storage.compareAndSwapAgentRuntimeChallengeReservations(
      challengeAuthorization(staleExpected, staleAddition),
    );

  const rotationInitial = emptyRuntimeState(
    crypto,
    "agent-contract-rotation",
    0,
    0,
  );
  await storage.putAgentRuntimeAtomicStateIfAbsent(
    authorizeRuntimeInitialization(rotationInitial),
  );
  const rotationExpected = rotationExpectation(rotationInitial);
  const rotationIntended = emptyRuntimeState(
    crypto,
    rotationInitial.runtime.agentId,
    1,
    1,
  );
  const runtimeRotate = await storage.compareAndSwapAgentRuntimeRotation(
    authorizeRuntimeRotation(
      rotationExpected,
      rotationIntended,
      rotationExpected.runtime,
    ),
  );
  const runtimeRotateDuplicate =
    await storage.compareAndSwapAgentRuntimeRotation(
      authorizeRuntimeRotation(
        rotationExpected,
        rotationIntended,
        rotationIntended.runtime,
      ),
    );
  const concurrentRotationReplays = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        storage.compareAndSwapAgentRuntimeRotation(
          authorizeRuntimeRotation(
            rotationExpected,
            rotationIntended,
            rotationIntended.runtime,
          ),
        ),
    ),
  );
  if (concurrentRotationReplays.some((status) => status !== "duplicate")) {
    throw new Error("Concurrent Runtime rotation replay did not converge");
  }
  const staleRotationInitial = emptyRuntimeState(
    crypto,
    "agent-contract-rotation-stale",
    0,
    0,
  );
  const staleRotationExpected = rotationExpectation(staleRotationInitial);
  const staleRotationIntended = emptyRuntimeState(
    crypto,
    staleRotationInitial.runtime.agentId,
    1,
    1,
  );
  const runtimeRotateStale =
    await storage.compareAndSwapAgentRuntimeRotation(
      authorizeRuntimeRotation(
        staleRotationExpected,
        staleRotationIntended,
        staleRotationExpected.runtime,
      ),
    );

  const transitionInitial = emptyRuntimeState(
    crypto,
    "agent-contract-authorization-transition",
    0,
    0,
  );
  await storage.putAgentRuntimeAtomicStateIfAbsent(
    authorizeRuntimeInitialization(transitionInitial),
  );
  const transitionIntended = emptyRuntimeState(
    crypto,
    transitionInitial.runtime.agentId,
    1,
    0,
  );
  const runtimeAuthorizationTransition =
    await storage.compareAndSwapAgentRuntimeAuthorizationTransition(
      authorizeRuntimeAuthorizationTransition(
        transitionInitial,
        transitionIntended,
      ),
    );
  const runtimeAuthorizationTransitionDuplicate =
    await storage.compareAndSwapAgentRuntimeAuthorizationTransition(
      authorizeRuntimeAuthorizationTransition(
        transitionInitial,
        transitionIntended,
        transitionIntended.runtime,
      ),
    );
  const absentTransition = emptyRuntimeState(
    crypto,
    "agent-contract-authorization-transition-stale",
    0,
    0,
  );
  const absentTransitionIntended = emptyRuntimeState(
    crypto,
    absentTransition.runtime.agentId,
    1,
    0,
  );
  const runtimeAuthorizationTransitionStale =
    await storage.compareAndSwapAgentRuntimeAuthorizationTransition(
      authorizeRuntimeAuthorizationTransition(
        absentTransition,
        absentTransitionIntended,
      ),
    );

  return {
    runtimeCreate,
    runtimeReplay,
    challengeReserve,
    challengeDuplicate,
    challengeStale,
    runtimeRotate,
    runtimeRotateDuplicate,
    runtimeRotateStale,
    runtimeAuthorizationTransition,
    runtimeAuthorizationTransitionDuplicate,
    runtimeAuthorizationTransitionStale,
  };
}

async function exerciseGrant(storage: LatticeStorage) {
  const targetGrantId = grantId("grant-contract");
  const bytes = serializeGrantV2({
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: targetGrantId,
    issuingDeviceId: cryptoDeviceId("device-contract-grant"),
    recipientAgentId: agentId("agent-contract-recipient"),
    recipientKeyId: "invocation-key",
    scope: [humanId("00000000-0000-4000-8000-00000000000a")],
    operations: ["decrypt"],
    issuedAt: 1,
    expiresAt: 2,
    coveredDomains: [{
      domainId: cryptoDomainId("domain-shared-alice-bob"),
      domainEpoch: domainEpoch(0),
      agentAuthorizationRevision: authorizationRevision(0),
    }],
    encryptedSecret: new Uint8Array(40).fill(0x91),
    scheme: GRANT_V2_SCHEME,
    signature: new Uint8Array(64).fill(0x92),
    singleUse: true,
    consumed: false,
  });
  await storage.putGrant(grantWriteRecord(bytes));
  await storage.putGrant(grantWriteRecord(bytes));
  const beforeConsume = await storage.getGrant(targetGrantId);
  const firstConsume = await storage.consumeGrant(targetGrantId);
  const secondConsume = await storage.consumeGrant(targetGrantId);
  return {
    beforeConsume: beforeConsume?.consumed ?? true,
    firstConsume: firstConsume?.consumed ?? false,
    secondConsumeMissing: secondConsume === null,
  };
}

async function exerciseRecovery(
  storage: LatticeStorage,
  crypto: LatticeCrypto,
) {
  const recovery = await crypto.generateEncryptionKeyPair();
  const issuer = crypto.generateSigningKeyPair();
  const targetHuman = humanId(
    "00000000-0000-4000-8000-00000000000a",
  );
  const recoveryGeneration = recoveryKeyGenerationV2(1);
  const trustedRecoveryKey = {
    humanId: targetHuman,
    recoveryKeyId: "recovery-contract-1",
    recoveryGeneration,
    publicKeyDigest: recoveryPublicKeyDigestV2(recovery.publicKey),
  };
  const prepared = await publishHumanRecoveryArchive({
    crypto,
    humanId: targetHuman,
    recoveryKeyId: trustedRecoveryKey.recoveryKeyId,
    recoveryGeneration,
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey: () => trustedRecoveryKey,
    issuerDeviceId: cryptoDeviceId("device-contract-recovery"),
    createdAt: unixTimestamp(1_700_000_000_000),
    sources: [],
    issuerSigningPrivateKey: issuer.privateKey,
    resolveIssuerDevice: () => issuer.publicKey,
  });
  const persist = () =>
    persistPublishedHumanRecoveryArchive({
      crypto,
      storage,
      prepared,
      resolveTrustedCurrentRecoveryKey: () => trustedRecoveryKey,
      resolveIssuerDevice: () => issuer.publicKey,
    });
  const recoveryCreate = await persist();
  const recoveryReplay = await persist();
  const concurrentRecoveryReplays = await Promise.all(
    Array.from({ length: 4 }, persist),
  );
  if (concurrentRecoveryReplays.some((status) => status !== "duplicate")) {
    throw new Error("Concurrent recovery replay did not converge");
  }
  await storage.getRecoveryArchive(targetHuman);
  return { recoveryCreate, recoveryReplay };
}

export async function runLatticeStorageContract(
  storage: LatticeStorage,
): Promise<LatticeStorageContractReport> {
  const called = new Set<keyof LatticeStorage>();
  const tracked = trackedStorage(storage, called);
  const scenario = await runSyntheticSharedDomainScenario(tracked);
  const crypto = new LatticeCrypto(seededRng(0x231_21), manualClock(1));

  const initialProvider = providerHead(0, 0x11);
  const nextProvider = providerHead(1, 0x12);
  const staleProvider = providerHead(1, 0x13);
  const providerCreate = await tracked.putDomainProviderHeadIfAbsent(
    initialProvider,
    new Uint8Array([0x41, 0x42]),
  );
  const providerReplay = await tracked.putDomainProviderHeadIfAbsent(
    initialProvider,
    new Uint8Array([0x41, 0x42]),
  );
  await tracked.getDomainProviderHead(initialProvider.domainId);
  const providerAdvance = await tracked.compareAndSwapDomainProviderHead(
    authorizeProvider(initialProvider, nextProvider),
  );
  const providerDuplicate = await tracked.compareAndSwapDomainProviderHead(
    authorizeProvider(initialProvider, nextProvider),
  );
  const concurrentProviderReplays = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        tracked.compareAndSwapDomainProviderHead(
          authorizeProvider(initialProvider, nextProvider),
        ),
    ),
  );
  if (concurrentProviderReplays.some((status) => status !== "duplicate")) {
    throw new Error("Concurrent provider-head replay did not converge");
  }
  const providerStale = await tracked.compareAndSwapDomainProviderHead(
    authorizeProvider(initialProvider, staleProvider),
  );

  const runtime = await exerciseRuntime(tracked, crypto);
  const grant = await exerciseGrant(tracked);
  const recovery = await exerciseRecovery(tracked, crypto);
  const missing = LATTICE_STORAGE_METHODS.filter(
    (method) => !called.has(method),
  );
  if (missing.length > 0) {
    throw new Error(
      `LatticeStorage contract did not exercise: ${missing.join(", ")}`,
    );
  }

  return Object.freeze({
    calledMethods: LATTICE_STORAGE_METHODS,
    statuses: Object.freeze({
      domainCreate: scenario.domain.firstStatus,
      domainReplay: scenario.domain.secondStatus,
      providerCreate,
      providerReplay,
      providerAdvance,
      providerDuplicate,
      providerStale,
      namespaceDuplicate: scenario.casReplays.namespaceDuplicate,
      namespaceStale: scenario.casReplays.namespaceStale,
      objectDuplicate: scenario.casReplays.objectDuplicate,
      objectStale: scenario.casReplays.objectStale,
      ...runtime,
      ...recovery,
    }),
    grant: Object.freeze(grant),
  });
}
