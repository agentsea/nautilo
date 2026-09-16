import { describe, expect, test } from "bun:test";
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
  createDomainTransitionDelivery,
  createNamespaceTransitionSubmission,
  createProviderTransitionSubmission,
  decodeDomainTransitionDeliveryArtifact,
  decodeOpaqueDeliveryArtifactChunk,
  decodeProviderTransitionSubmission,
  reassembleOpaqueDeliveryArtifact,
  serializeProviderTransitionSubmission,
  verifyNamespaceTransitionSubmission,
  verifyProviderTransitionSubmission,
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

function fixture() {
  const crypto = new LatticeCrypto();
  const committer = crypto.generateSigningKeyPair();
  const operationId = "operation_device_add";
  const domainId = cryptoDomainId("domain_alice_bob");
  const targetHumanId = humanId("human_alice");
  const targetDeviceId = cryptoDeviceId("device_alice_phone");
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
  const nextRosterBytes = roster([
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
  const transition = validateProviderPublicTransitionV2({
    formatVersion: 2,
    providerId: currentProviderHead.providerId,
    domainId,
    operation: "add",
    targetHumanId,
    targetDeviceId,
    expectedHead: currentProviderHead,
    nextHead: {
      ...currentProviderHead,
      epoch: domainEpoch(8),
      stateHash: new Uint8Array(32).fill(0x42),
    },
    commitBytes: new Uint8Array([0x51, 0x52]),
    welcomeHash: crypto.hash(new Uint8Array([0x53, 0x54])),
    welcomeBytes: new Uint8Array([0x53, 0x54]),
    rosterBytes: nextRosterBytes,
  });
  const expectedParticipantDigest = new Uint8Array(32).fill(0x61);
  const expectation = {
    operationId,
    operationKind: "device_add" as const,
    domainId,
    targetHumanId,
    targetDeviceId,
    expectedEpoch: 7,
    targetEpoch: 8,
    expectedAuthorizationRevision: 11,
    expectedParticipantDigest,
    committerDeviceId,
  };
  const submission = createProviderTransitionSubmission({
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
  const preparedNamespaces = prepareDomainEpochAdvance({
    crypto,
    reason: "device_add",
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
    providerTransitionDigest: submission.transitionDigest,
    prepared: preparedNamespaces,
    signingPrivateKey: committer.privateKey,
  });
  const domainPlan = {
    domainId,
    expectedEpoch: 7,
    targetEpoch: 8,
    expectedAuthorizationRevision: 11,
    expectedParticipantDigest,
    committerDeviceId,
    namespaces: preparedNamespaces.namespaces.map((candidate) => ({
      namespaceId: candidate.expectedHead.namespaceId,
      expectedAccessRevision: candidate.expectedHead.accessRevision,
      expectedBindingHash: candidate.expectedHead.bindingHash,
    })),
  };
  const verify = (
    candidate = submission,
    overrides: Partial<Parameters<
      typeof verifyProviderTransitionSubmission
    >[0]> = {},
  ) =>
    verifyProviderTransitionSubmission({
      crypto,
      submission: candidate,
      expectation,
      currentProviderState: {
        head: currentProviderHead,
        rosterBytes: currentRosterBytes,
      },
      resolveActiveCommitter: (deviceId) =>
        deviceId === committerDeviceId
          ? {
            state: "active",
            humanId: "human_bob",
            signingPublicKey: committer.publicKey,
          }
          : null,
      ...overrides,
    });
  return {
    crypto,
    committer,
    submission,
    expectation,
    currentProviderHead,
    currentRosterBytes,
    transition,
    targetDeviceId,
    preparedNamespaces,
    domainPlan,
    namespaceSubmission,
    verifyNamespace: () =>
      verifyNamespaceTransitionSubmission({
        crypto,
        submission: namespaceSubmission,
        operationId,
        domainPlan,
        providerTransitionDigest: submission.transitionDigest,
        resolveActiveCommitter: (deviceId) =>
          deviceId === committerDeviceId
            ? {
              state: "active",
              humanId: "human_bob",
              signingPublicKey: committer.publicKey,
            }
            : null,
      }),
    verify,
  };
}

describe("provider transition submission", () => {
  test("binds one exact real-provider device-add delta to an active committer", () => {
    const setup = fixture();
    const verified = setup.verify();
    expect(verified.targetLeafIndex).toBe(2);
    expect(verified.transition).toEqual(setup.transition);
    expect(verified.previousRoster).toHaveLength(2);
    expect(verified.nextRoster).toHaveLength(3);
    expect(verified.transitionDigest).toEqual(
      setup.submission.transitionDigest,
    );
  });

  test("binds one exact device revocation with no Welcome material", () => {
    const setup = fixture();
    const removedDeviceId = cryptoDeviceId("device_alice_desktop");
    const transition = validateProviderPublicTransitionV2({
      formatVersion: 2,
      providerId: setup.currentProviderHead.providerId,
      domainId: setup.currentProviderHead.domainId,
      operation: "remove",
      targetHumanId: "human_alice",
      targetDeviceId: removedDeviceId,
      expectedHead: setup.currentProviderHead,
      nextHead: {
        ...setup.currentProviderHead,
        epoch: domainEpoch(8),
        stateHash: new Uint8Array(32).fill(0x52),
      },
      commitBytes: new Uint8Array([0x61, 0x62]),
      welcomeHash: setup.crypto.hash(new Uint8Array()),
      welcomeBytes: new Uint8Array(),
      rosterBytes: roster([{
        leafIndex: 1,
        humanId: "human_bob",
        deviceId: "device_bob_desktop",
      }]),
    });
    const submission = createProviderTransitionSubmission({
      crypto: setup.crypto,
      transition,
      operationId: "operation_device_revoke",
      committerDeviceId: setup.expectation.committerDeviceId,
      expectedAuthorizationRevision: 11,
      expectedParticipantDigest:
        setup.expectation.expectedParticipantDigest,
      signingPrivateKey: setup.committer.privateKey,
    });
    const verified = verifyProviderTransitionSubmission({
      crypto: setup.crypto,
      submission,
      expectation: {
        ...setup.expectation,
        operationId: "operation_device_revoke",
        operationKind: "device_revoke",
        targetDeviceId: removedDeviceId,
      },
      currentProviderState: {
        head: setup.currentProviderHead,
        rosterBytes: setup.currentRosterBytes,
      },
      resolveActiveCommitter: (deviceId) =>
        deviceId === setup.expectation.committerDeviceId
          ? {
            state: "active",
            humanId: "human_bob",
            signingPublicKey: setup.committer.publicKey,
          }
          : null,
    });
    expect(verified.targetLeafIndex).toBe(0);
    expect(verified.previousRoster).toHaveLength(2);
    expect(verified.nextRoster).toHaveLength(1);
    expect(verified.transition.welcomeBytes).toHaveLength(0);
  });

  test("fans a revocation only to the remaining authorized devices", () => {
    const setup = fixture();
    const removedDeviceId = cryptoDeviceId("device_alice_desktop");
    const operationId = "operation_device_revoke";
    const transition = validateProviderPublicTransitionV2({
      formatVersion: 2,
      providerId: setup.currentProviderHead.providerId,
      domainId: setup.currentProviderHead.domainId,
      operation: "remove",
      targetHumanId: "human_alice",
      targetDeviceId: removedDeviceId,
      expectedHead: setup.currentProviderHead,
      nextHead: {
        ...setup.currentProviderHead,
        epoch: domainEpoch(8),
        stateHash: new Uint8Array(32).fill(0x52),
      },
      commitBytes: new Uint8Array([0x61, 0x62]),
      welcomeHash: setup.crypto.hash(new Uint8Array()),
      welcomeBytes: new Uint8Array(),
      rosterBytes: roster([{
        leafIndex: 1,
        humanId: "human_bob",
        deviceId: setup.expectation.committerDeviceId,
      }]),
    });
    const providerSubmission = createProviderTransitionSubmission({
      crypto: setup.crypto,
      transition,
      operationId,
      committerDeviceId: setup.expectation.committerDeviceId,
      expectedAuthorizationRevision: 11,
      expectedParticipantDigest:
        setup.expectation.expectedParticipantDigest,
      signingPrivateKey: setup.committer.privateKey,
    });
    const resolveActiveCommitter = (deviceId: string) =>
      deviceId === setup.expectation.committerDeviceId
        ? {
          state: "active" as const,
          humanId: "human_bob",
          signingPublicKey: setup.committer.publicKey,
        }
        : null;
    const verifiedProvider = verifyProviderTransitionSubmission({
      crypto: setup.crypto,
      submission: providerSubmission,
      expectation: {
        ...setup.expectation,
        operationId,
        operationKind: "device_revoke",
        targetDeviceId: removedDeviceId,
      },
      currentProviderState: {
        head: setup.currentProviderHead,
        rosterBytes: setup.currentRosterBytes,
      },
      resolveActiveCommitter,
    });
    const namespaceSubmission = createNamespaceTransitionSubmission({
      crypto: setup.crypto,
      operationId,
      committerDeviceId: setup.expectation.committerDeviceId,
      providerTransitionDigest: providerSubmission.transitionDigest,
      prepared: setup.preparedNamespaces,
      signingPrivateKey: setup.committer.privateKey,
    });
    const verifiedNamespaces = verifyNamespaceTransitionSubmission({
      crypto: setup.crypto,
      submission: namespaceSubmission,
      operationId,
      domainPlan: setup.domainPlan,
      providerTransitionDigest: providerSubmission.transitionDigest,
      resolveActiveCommitter,
    });

    const delivery = createDomainTransitionDelivery({
      crypto: setup.crypto,
      providerSubmission,
      verifiedProvider,
      namespaceSubmission,
      verifiedNamespaces,
      now: 40_000,
    });

    expect(delivery.messages.map((message) => message.recipientDeviceId))
      .toEqual(["device_bob_desktop"]);
    expect(delivery.messages.some(
      (message) => message.recipientDeviceId === removedDeviceId,
    )).toBeFalse();
  });

  test("round-trips one canonical bounded transport record", () => {
    const setup = fixture();
    const bytes = serializeProviderTransitionSubmission(setup.submission);
    const decoded = decodeProviderTransitionSubmission(bytes);
    expect(decoded).toEqual(setup.submission);
    expect(decoded).not.toBe(setup.submission);
    expect(decoded.transition).not.toBe(setup.submission.transition);
    expect(setup.verify(decoded).targetLeafIndex).toBe(2);

    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() =>
      decodeProviderTransitionSubmission(trailing)
    ).toThrow("trailing");
  });

  test("fans public state to every device but the Welcome only to its target", () => {
    const setup = fixture();
    const verified = setup.verify();
    const delivery = createDomainTransitionDelivery({
      crypto: setup.crypto,
      providerSubmission: setup.submission,
      verifiedProvider: verified,
      namespaceSubmission: setup.namespaceSubmission,
      verifiedNamespaces: setup.verifyNamespace(),
      now: 40_000,
    });
    expect(delivery.messages).toHaveLength(3);
    expect(
      delivery.messages.map((message) => message.recipientDeviceId).sort(),
    ).toEqual([
      "device_alice_desktop",
      "device_alice_phone",
      "device_bob_desktop",
    ]);
    for (const message of delivery.messages) {
      expect(message.kind).toBe("public_state");
      const chunk = decodeOpaqueDeliveryArtifactChunk(
        message.payloadBytes,
        setup.crypto,
      );
      expect(chunk.kind).toBe("domain_transition");
      expect(chunk.recipientDeviceId).toBe(message.recipientDeviceId);
      const artifact = reassembleOpaqueDeliveryArtifact({
        crypto: setup.crypto,
        chunks: [chunk],
      });
      const domainArtifact = decodeDomainTransitionDeliveryArtifact(artifact);
      expect(domainArtifact.namespaceSubmission).toEqual(
        setup.namespaceSubmission,
      );
      const decoded = domainArtifact.providerSubmission;
      expect(decoded.transition.welcomeHash).toEqual(
        setup.submission.transition.welcomeHash,
      );
      if (message.recipientDeviceId === setup.targetDeviceId) {
        expect(decoded).toEqual(setup.submission);
      } else {
        expect(decoded.transition.welcomeBytes).toHaveLength(0);
        expect(
          setup.verify(decoded, {
            recipientDeviceId: message.recipientDeviceId,
          }).targetLeafIndex,
        ).toBe(2);
      }
    }
  });

  test("rejects changed transition bytes, stale heads, and a revoked committer", () => {
    const setup = fixture();
    expect(() =>
      setup.verify({
        ...setup.submission,
        serverTrusted: true,
      } as typeof setup.submission)
    ).toThrow("fields");
    expect(() =>
      setup.verify({
        ...setup.submission,
        transition: {
          ...setup.submission.transition,
          commitBytes: new Uint8Array([0xff]),
        },
      })
    ).toThrow("digest");
    expect(() =>
      setup.verify(setup.submission, {
        currentProviderState: {
          head: {
            ...setup.currentProviderHead,
            stateHash: new Uint8Array(32).fill(0x99),
          },
          rosterBytes: setup.currentRosterBytes,
        },
      })
    ).toThrow("head");
    expect(() =>
      setup.verify(setup.submission, {
        resolveActiveCommitter: () => null,
      })
    ).toThrow("committer");
  });

  test("rejects removal, mutation, duplication, or substitution in the roster delta", () => {
    const setup = fixture();
    for (const entries of [
      [
        {
          leafIndex: 1,
          humanId: "human_bob",
          deviceId: "device_bob_desktop",
        },
        {
          leafIndex: 2,
          humanId: "human_alice",
          deviceId: setup.targetDeviceId,
        },
      ],
      [
        {
          leafIndex: 0,
          humanId: "human_bob",
          deviceId: "device_alice_desktop",
        },
        {
          leafIndex: 1,
          humanId: "human_bob",
          deviceId: "device_bob_desktop",
        },
        {
          leafIndex: 2,
          humanId: "human_alice",
          deviceId: setup.targetDeviceId,
        },
      ],
      [
        {
          leafIndex: 0,
          humanId: "human_alice",
          deviceId: "device_alice_desktop",
        },
        {
          leafIndex: 1,
          humanId: "human_bob",
          deviceId: "device_bob_desktop",
        },
        {
          leafIndex: 2,
          humanId: "human_alice",
          deviceId: "device_other",
        },
      ],
    ]) {
      const changedTransition = validateProviderPublicTransitionV2({
        ...setup.transition,
        rosterBytes: roster(entries),
      });
      const changedSubmission = createProviderTransitionSubmission({
        crypto: setup.crypto,
        transition: changedTransition,
        operationId: setup.expectation.operationId,
        committerDeviceId: setup.expectation.committerDeviceId,
        expectedAuthorizationRevision:
          setup.expectation.expectedAuthorizationRevision,
        expectedParticipantDigest:
          setup.expectation.expectedParticipantDigest,
        signingPrivateKey: setup.committer.privateKey,
      });
      expect(() => setup.verify(changedSubmission)).toThrow("roster");
    }
  });
});
