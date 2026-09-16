import {
  DeviceProviderStateVault,
  LatticeCrypto,
  OpenMlsGroupProvider,
  accessRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceBindingHash,
  namespaceId,
  prepareHumanNamespaceRebind,
  sealNamespaceKeyring,
  type DomainRoots,
} from "@nautilo/lattice-crypto";
import {
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
  type ProviderPublicTransitionV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createDeviceJoinPackage,
  createHumanMembershipRebindSubmission,
  createHumanMembershipTargetDomainSubmission,
  createHumanMembershipTransition,
  createProviderTransitionSubmission,
} from "../../src/index.ts";

export const COLD_ALICE_ACTOR =
  "71000000-0000-4000-8000-000000000001";
export const COLD_CHARLIE_ACTOR =
  "71000000-0000-4000-8000-000000000002";
const COLD_ROOM = "71000000-0000-4000-8000-000000000003";
export const COLD_NAMESPACE = "71000000-0000-4000-8000-000000000004";
export const COLD_SOURCE_DOMAIN = "domain_cold_alice";
export const COLD_TARGET_DOMAIN = "domain_cold_alice_charlie";
export const COLD_OPERATION = "membership_cold_alice_charlie";
export const COLD_ALICE_DEVICE = "device_cold_alice_browser";
export const COLD_CHARLIE_DEVICE = "device_cold_charlie_browser";

function applied(
  result: ReturnType<OpenMlsGroupProvider["applyCandidate"]>,
) {
  if (result.status !== "applied") {
    throw new Error(`Provider candidate was not applied: ${result.status}`);
  }
  return result.active;
}

export async function createColdHumanAddFixture(input: {
  readonly crypto: LatticeCrypto;
  readonly aliceSigning: {
    readonly publicKey: Uint8Array;
    readonly privateKey: Uint8Array;
  };
  readonly charlieSigning: {
    readonly publicKey: Uint8Array;
    readonly privateKey: Uint8Array;
  };
}) {
  const aliceDeviceId = cryptoDeviceId(COLD_ALICE_DEVICE);
  const charlieDeviceId = cryptoDeviceId(COLD_CHARLIE_DEVICE);
  const sourceDomainId = cryptoDomainId(COLD_SOURCE_DOMAIN);
  const targetDomainId = cryptoDomainId(COLD_TARGET_DOMAIN);
  const namespace = namespaceId(COLD_NAMESPACE);
  const aliceProvider = new OpenMlsGroupProvider(
    input.crypto,
    DeviceProviderStateVault.fromKey(
      input.crypto,
      aliceDeviceId,
      new Uint8Array(32).fill(0xa1),
    ),
  );
  const charlieProvider = new OpenMlsGroupProvider(
    input.crypto,
    DeviceProviderStateVault.fromKey(
      input.crypto,
      charlieDeviceId,
      new Uint8Array(32).fill(0xc1),
    ),
  );

  const sourceActive = await aliceProvider.createInitialState({
    domainId: sourceDomainId,
    humanId: humanId(COLD_ALICE_ACTOR),
  });
  const sourceHead = aliceProvider.publicHead(sourceActive);
  const sourceRosterBytes = aliceProvider.publicRoster(sourceActive);
  const sourceRoots = await aliceProvider.exportDomainRoots(sourceActive);
  const keyrings = createInitialNamespaceKeyrings(input.crypto, namespace);
  const metadata = {
    domainId: sourceDomainId,
    domainEpoch: sourceHead.epoch,
    previousBindingHash: null,
    committerDeviceId: aliceDeviceId,
  } as const;
  const sourceHumanEnvelope = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: sourceRoots.human,
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: input.aliceSigning.privateKey,
    resolveCurrentCommitter: () => input.aliceSigning.publicKey,
  });
  const sourceAiEnvelope = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: sourceRoots.ai,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: input.aliceSigning.privateKey,
    resolveCurrentCommitter: () => input.aliceSigning.publicKey,
  });
  const sourceBinding = createNamespaceBinding({
    crypto: input.crypto,
    humanEnvelope: sourceHumanEnvelope,
    aiEnvelope: sourceAiEnvelope,
    committerSigningPrivateKey: input.aliceSigning.privateKey,
    resolveCurrentCommitter: () => input.aliceSigning.publicKey,
  });
  const sourceBindingHash = namespaceBindingHash(sourceBinding);
  const sourceNamespacePrepared = Object.freeze({
    expectedHead: null,
    nextHead: Object.freeze({
      namespaceId: namespace,
      accessRevision: accessRevision(0),
      bindingHash: sourceBindingHash,
      domainId: sourceDomainId,
      domainEpoch: sourceHead.epoch,
    }),
    signedBindingBytes: serializeNamespaceBindingV2(sourceBinding),
    humanKeyringEnvelopeBytes:
      serializeNamespaceKeyringEnvelopeV2(sourceHumanEnvelope),
    aiKeyringEnvelopeBytes:
      serializeNamespaceKeyringEnvelopeV2(sourceAiEnvelope),
  });
  const membership = createHumanMembershipTransition({
    operationId: COLD_OPERATION,
    idempotencyKey: "membership/cold/alice-charlie",
    kind: "human_add",
    roomId: COLD_ROOM,
    namespaceId: COLD_NAMESPACE,
    targetHumanActorId: COLD_CHARLIE_ACTOR,
    oldParticipants: [COLD_ALICE_ACTOR],
    newParticipants: [COLD_ALICE_ACTOR, COLD_CHARLIE_ACTOR],
    oldDomainId: COLD_SOURCE_DOMAIN,
    targetDomainId: null,
    targetRoomRole: "member",
    expectedAccessRevision: sourceNamespacePrepared.nextHead.accessRevision,
    expectedBindingHash: sourceBindingHash,
    bootstrapDeviceId: null,
  });

  const targetAliceInitial = await aliceProvider.createInitialState({
    domainId: targetDomainId,
    humanId: humanId(COLD_ALICE_ACTOR),
  });
  const targetInitialHead = aliceProvider.publicHead(targetAliceInitial);
  const targetInitialRosterBytes = aliceProvider.publicRoster(
    targetAliceInitial,
  );
  const charlieJoin = await charlieProvider.createJoinRequest({
    domainId: targetDomainId,
    humanId: humanId(COLD_CHARLIE_ACTOR),
    expectedHead: targetInitialHead,
  });
  const preparedTargetAdd = await aliceProvider.prepareAdd({
    active: targetAliceInitial,
    joinRequest: charlieJoin.publicResult,
  });
  const joinPackage = createDeviceJoinPackage({
    crypto: input.crypto,
    request: charlieJoin.publicResult,
    generation: 1,
    packageId: "join_cold_charlie_target",
    createdAt: 10_000,
    expiresAt: 310_000,
    signingPrivateKey: input.charlieSigning.privateKey,
  });
  const providerSubmission = createProviderTransitionSubmission({
    crypto: input.crypto,
    transition: preparedTargetAdd.publicResult,
    operationId: COLD_OPERATION,
    committerDeviceId: aliceDeviceId,
    expectedAuthorizationRevision: 0,
    expectedParticipantDigest: membership.newParticipantDigest,
    signingPrivateKey: input.aliceSigning.privateKey,
  });
  const targetSubmission = createHumanMembershipTargetDomainSubmission({
    crypto: input.crypto,
    operationId: COLD_OPERATION,
    targetDomainId: COLD_TARGET_DOMAIN,
    participants: membership.newParticipants,
    participantDigest: membership.newParticipantDigest,
    committerDeviceId: COLD_ALICE_DEVICE,
    committerHumanId: COLD_ALICE_ACTOR,
    initialProviderHead: targetInitialHead,
    initialRosterBytes: targetInitialRosterBytes,
    additions: [{ joinPackage, providerSubmission }],
    signingPrivateKey: input.aliceSigning.privateKey,
  });

  const activateAliceTarget = async () => {
    const active = applied(aliceProvider.applyCandidate({
      active: targetAliceInitial,
      candidate: preparedTargetAdd.localCandidate,
    }));
    return {
      roots: await aliceProvider.exportDomainRoots(active),
    };
  };
  const activateCharlieTarget = async (
    transition: ProviderPublicTransitionV2,
  ) => {
    const candidate = await charlieProvider.prepareWelcome({
      joinState: charlieJoin.localState,
      publicResult: transition,
    });
    const result = charlieProvider.activateWelcome({
      candidate,
      joinState: charlieJoin.localState,
    });
    if (result.status !== "applied") {
      throw new Error(`Provider Welcome was not applied: ${result.status}`);
    }
    return {
      roots: await charlieProvider.exportDomainRoots(result.active),
    };
  };
  const createRebind = (targetRoots: DomainRoots) => {
    const prepared = prepareHumanNamespaceRebind({
      crypto: input.crypto,
      reason: "human_add",
      current: {
        anchor: null,
        proof: [sourceBinding],
        humanEnvelope: sourceHumanEnvelope,
        aiEnvelope: sourceAiEnvelope,
        oldHumanDomainRoot: sourceRoots.human,
        oldAiDomainRoot: sourceRoots.ai,
      },
      target: {
        domainId: targetDomainId,
        domainEpoch: preparedTargetAdd.publicResult.nextHead.epoch,
        humanDomainRoot: targetRoots.human,
        aiDomainRoot: targetRoots.ai,
      },
      committer: {
        deviceId: aliceDeviceId,
        signingPrivateKey: input.aliceSigning.privateKey,
      },
      resolveHistoricalCommitter: () => input.aliceSigning.publicKey,
      resolveSourceCommitter: () => input.aliceSigning.publicKey,
      resolveTargetCommitter: () => input.aliceSigning.publicKey,
    });
    return {
      prepared,
      submission: createHumanMembershipRebindSubmission({
        crypto: input.crypto,
        operationId: COLD_OPERATION,
        sourceDomainId,
        oldParticipantDigest: membership.oldParticipantDigest,
        newParticipantDigest: membership.newParticipantDigest,
        prepared,
        committer: {
          deviceId: aliceDeviceId,
          humanId: COLD_ALICE_ACTOR,
          signingPrivateKey: input.aliceSigning.privateKey,
        },
      }),
    };
  };

  return Object.freeze({
    crypto: input.crypto,
    membership,
    source: Object.freeze({
      head: sourceHead,
      rosterBytes: sourceRosterBytes,
      roots: sourceRoots,
      binding: sourceBinding,
      humanEnvelope: sourceHumanEnvelope,
      prepared: sourceNamespacePrepared,
      keyrings,
    }),
    target: Object.freeze({
      submission: targetSubmission,
      transition: preparedTargetAdd.publicResult,
      activateAlice: activateAliceTarget,
      activateCharlie: activateCharlieTarget,
    }),
    createRebind,
  });
}
