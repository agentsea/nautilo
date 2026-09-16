import {
  LatticeCrypto,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  prepareDomainEpochAdvance,
  sealNamespaceKeyring,
} from "@nautilo/lattice-crypto";
import {
  validateProviderPublicTransitionV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createNamespaceTransitionSubmission,
  createProviderTransitionSubmission,
  type DeviceFanoutDomainPlan,
} from "../../src/index.ts";

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function roster(
  entries: readonly {
    readonly leafIndex: number;
    readonly humanId: string;
    readonly deviceId: string;
  }[],
): Uint8Array {
  return concat([
    text("nautilo/lattice-crypto/openmls-roster/v2"),
    u32(entries.length),
    ...entries.flatMap((entry) => [
      u32(entry.leafIndex),
      text(entry.humanId),
      text(entry.deviceId),
    ]),
  ]);
}

export function createDomainTransitionFixture(
  options: {
    readonly operationKind?: "device_add" | "device_revoke";
  } = {},
) {
  const operationKind = options.operationKind ?? "device_add";
  const revocation = operationKind === "device_revoke";
  const crypto = new LatticeCrypto();
  const committer = crypto.generateSigningKeyPair();
  const operationId = revocation
    ? "operation_device_revoke"
    : "operation_device_add";
  const domainId = cryptoDomainId("domain_alice_bob");
  const targetHumanId = humanId("human_alice");
  const targetDeviceId = cryptoDeviceId(
    revocation ? "device_alice_desktop" : "device_alice_phone",
  );
  const committerDeviceId = cryptoDeviceId("device_bob_desktop");
  const currentRosterBytes = roster([
    {
      leafIndex: 0,
      humanId: "human_alice",
      deviceId: "device_alice_desktop",
    },
    {
      leafIndex: 1,
      humanId: "human_bob",
      deviceId: committerDeviceId,
    },
  ]);
  const nextRosterBytes = roster(revocation
    ? [{
      leafIndex: 1,
      humanId: "human_bob",
      deviceId: committerDeviceId,
    }]
    : [
      {
        leafIndex: 0,
        humanId: "human_alice",
        deviceId: "device_alice_desktop",
      },
      {
        leafIndex: 1,
        humanId: "human_bob",
        deviceId: committerDeviceId,
      },
      {
        leafIndex: 2,
        humanId: targetHumanId,
        deviceId: targetDeviceId,
      },
    ]);
  const currentProviderHead = {
    providerId: "openmls-v2",
    domainId,
    epoch: domainEpoch(7),
    stateHash: new Uint8Array(32).fill(0x41),
  } as const;
  const welcomeBytes = revocation
    ? new Uint8Array()
    : new Uint8Array([0x53, 0x54]);
  const transition = validateProviderPublicTransitionV2({
    formatVersion: 2,
    providerId: currentProviderHead.providerId,
    domainId,
    operation: revocation ? "remove" : "add",
    targetHumanId,
    targetDeviceId,
    expectedHead: currentProviderHead,
    nextHead: {
      ...currentProviderHead,
      epoch: domainEpoch(8),
      stateHash: new Uint8Array(32).fill(0x42),
    },
    commitBytes: new Uint8Array([0x51, 0x52]),
    welcomeHash: crypto.hash(welcomeBytes),
    welcomeBytes,
    rosterBytes: nextRosterBytes,
  });
  const expectedParticipantDigest = new Uint8Array(32).fill(0x61);
  const providerSubmission = createProviderTransitionSubmission({
    crypto,
    transition,
    operationId,
    committerDeviceId,
    expectedAuthorizationRevision: 11,
    expectedParticipantDigest,
    signingPrivateKey: committer.privateKey,
  });
  const oldHumanRoot = new Uint8Array(32).fill(0x81);
  const oldAiRoot = new Uint8Array(32).fill(0x82);
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId("namespace_room_1"),
  );
  const namespaceMetadata = {
    domainId,
    domainEpoch: domainEpoch(7),
    previousBindingHash: null,
    committerDeviceId,
  };
  const resolveNamespaceCommitter = () => committer.publicKey;
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: oldHumanRoot,
    keyring: keyrings.human,
    metadata: namespaceMetadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: resolveNamespaceCommitter,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: oldAiRoot,
    keyring: keyrings.ai,
    metadata: namespaceMetadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: resolveNamespaceCommitter,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: resolveNamespaceCommitter,
  });
  const prepared = prepareDomainEpochAdvance({
    crypto,
    reason: operationKind,
    domain: {
      domainId,
      oldEpoch: domainEpoch(7),
      nextEpoch: domainEpoch(8),
      oldHumanRoot,
      oldAiRoot,
      nextHumanRoot: new Uint8Array(32).fill(0x83),
      nextAiRoot: new Uint8Array(32).fill(0x84),
    },
    affected: [{
      anchor: null,
      proof: [binding],
      humanEnvelope,
      aiEnvelope,
    }],
    committer: {
      deviceId: committerDeviceId,
      signingPrivateKey: committer.privateKey,
    },
    resolveHistoricalCommitter: resolveNamespaceCommitter,
    resolveSourceCommitter: resolveNamespaceCommitter,
    resolveTargetCommitter: resolveNamespaceCommitter,
  });
  const namespaceSubmission = createNamespaceTransitionSubmission({
    crypto,
    operationId,
    committerDeviceId,
    providerTransitionDigest: providerSubmission.transitionDigest,
    prepared,
    signingPrivateKey: committer.privateKey,
  });
  const domainPlan: DeviceFanoutDomainPlan = {
    domainId,
    expectedEpoch: 7,
    targetEpoch: 8,
    expectedAuthorizationRevision: 11,
    expectedParticipantDigest,
    committerDeviceId,
    namespaces: prepared.namespaces.map((candidate) => ({
      namespaceId: candidate.expectedHead.namespaceId,
      expectedAccessRevision: candidate.expectedHead.accessRevision,
      expectedBindingHash: candidate.expectedHead.bindingHash,
    })),
  };
  return {
    crypto,
    committer,
    operationKind,
    operationId,
    domainId,
    targetHumanId,
    targetDeviceId,
    committerDeviceId,
    currentRosterBytes,
    nextRosterBytes,
    currentProviderHead,
    expectedParticipantDigest,
    providerSubmission,
    namespaceSubmission,
    domainPlan,
  };
}
