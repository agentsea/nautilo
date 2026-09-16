import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
} from "@nautilo/lattice-crypto";
import {
  validateProviderPublicTransitionV2,
  type ProviderPublicHeadV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createDeviceJoinPackage,
  createHumanMembershipTargetDomainDelivery,
  createHumanMembershipTargetDomainSubmission,
  createProviderTransitionSubmission,
  decodeHumanMembershipTargetDomainDeliveryArtifact,
  decodeOpaqueDeliveryArtifactChunk,
  reassembleOpaqueDeliveryArtifact,
  verifyHumanMembershipTargetDomainSubmission,
} from "../../src/index.ts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";
const DOMAIN = cryptoDomainId("domain_alice_bob_charlie");
const OPERATION = "membership_operation_target_domain";
const ALICE_DEVICE = cryptoDeviceId("device_alice");
const BOB_DEVICE = cryptoDeviceId("device_bob");
const CHARLIE_DEVICE = cryptoDeviceId("device_charlie");

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

function roster(entries: readonly {
  readonly leafIndex: number;
  readonly humanId: string;
  readonly deviceId: string;
}[]): Uint8Array {
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
  const alice = crypto.generateSigningKeyPair();
  const bob = crypto.generateSigningKeyPair();
  const charlie = crypto.generateSigningKeyPair();
  const devices = [
    {
      deviceId: ALICE_DEVICE,
      humanId: ALICE,
      generation: 1,
      signingPublicKey: alice.publicKey,
    },
    {
      deviceId: BOB_DEVICE,
      humanId: BOB,
      generation: 1,
      signingPublicKey: bob.publicKey,
    },
    {
      deviceId: CHARLIE_DEVICE,
      humanId: CHARLIE,
      generation: 1,
      signingPublicKey: charlie.publicKey,
    },
  ] as const;
  const keys = new Map([
    [ALICE_DEVICE, alice],
    [BOB_DEVICE, bob],
    [CHARLIE_DEVICE, charlie],
  ]);
  const participantDigest = new Uint8Array(32).fill(0x41);
  let head: ProviderPublicHeadV2 = {
    providerId: "openmls-v2",
    domainId: DOMAIN,
    epoch: domainEpoch(0),
    stateHash: new Uint8Array(32).fill(0x51),
  };
  let currentRoster = roster([{
    leafIndex: 0,
    humanId: ALICE,
    deviceId: ALICE_DEVICE,
  }]);
  const initialHead = head;
  const initialRosterBytes = currentRoster;
  const additions = devices.slice(1).map((device, index) => {
    const key = keys.get(device.deviceId)!;
    const joinPackage = createDeviceJoinPackage({
      crypto,
      request: {
        formatVersion: 2,
        providerId: head.providerId,
        domainId: DOMAIN,
        humanId: device.humanId,
        deviceId: device.deviceId,
        expectedHead: head,
        keyPackageBytes: new Uint8Array([0x61, index]),
      },
      generation: 1,
      packageId: `package_${device.deviceId}`,
      createdAt: 1_000,
      expiresAt: 2_000,
      signingPrivateKey: key.privateKey,
    });
    const nextRoster = roster([
      {
        leafIndex: 0,
        humanId: ALICE,
        deviceId: ALICE_DEVICE,
      },
      ...devices.slice(1, index + 2).map((entry, addedIndex) => ({
        leafIndex: addedIndex + 1,
        humanId: entry.humanId,
        deviceId: entry.deviceId,
      })),
    ]);
    const welcomeBytes = new Uint8Array([0x71, index]);
    const transition = validateProviderPublicTransitionV2({
      formatVersion: 2,
      providerId: head.providerId,
      domainId: DOMAIN,
      operation: "add",
      targetHumanId: device.humanId,
      targetDeviceId: device.deviceId,
      expectedHead: head,
      nextHead: {
        ...head,
        epoch: domainEpoch(head.epoch + 1),
        stateHash: new Uint8Array(32).fill(0x52 + index),
      },
      commitBytes: new Uint8Array([0x81, index]),
      welcomeHash: crypto.hash(welcomeBytes),
      welcomeBytes,
      rosterBytes: nextRoster,
    });
    const providerSubmission = createProviderTransitionSubmission({
      crypto,
      transition,
      operationId: OPERATION,
      committerDeviceId: ALICE_DEVICE,
      expectedAuthorizationRevision: 0,
      expectedParticipantDigest: participantDigest,
      signingPrivateKey: alice.privateKey,
    });
    head = transition.nextHead;
    currentRoster = nextRoster;
    return { joinPackage, providerSubmission };
  });
  const submission = createHumanMembershipTargetDomainSubmission({
    crypto,
    operationId: OPERATION,
    targetDomainId: DOMAIN,
    participants: [ALICE, BOB, CHARLIE],
    participantDigest,
    committerDeviceId: ALICE_DEVICE,
    committerHumanId: ALICE,
    initialProviderHead: initialHead,
    initialRosterBytes,
    additions,
    signingPrivateKey: alice.privateKey,
  });
  return {
    crypto,
    alice,
    devices,
    participantDigest,
    submission,
    finalRosterBytes: currentRoster,
  };
}

describe("Human membership target Domain", () => {
  test("permits a one-device target Domain without synthetic additions", () => {
    const setup = fixture();
    const participantDigest = new Uint8Array(32).fill(0x42);
    const submission = createHumanMembershipTargetDomainSubmission({
      crypto: setup.crypto,
      operationId: "membership_operation_remove_to_alice",
      targetDomainId: DOMAIN,
      participants: [ALICE],
      participantDigest,
      committerDeviceId: ALICE_DEVICE,
      committerHumanId: ALICE,
      initialProviderHead: setup.submission.initialProviderHead,
      initialRosterBytes: setup.submission.initialRosterBytes,
      additions: [],
      signingPrivateKey: setup.alice.privateKey,
    });
    const verified = verifyHumanMembershipTargetDomainSubmission({
      crypto: setup.crypto,
      submission,
      expected: {
        operationId: submission.operationId,
        targetDomainId: DOMAIN,
        participants: [ALICE],
        participantDigest,
        committerDeviceId: ALICE_DEVICE,
        committerHumanId: ALICE,
        activeDevices: [setup.devices[0]],
      },
      now: 1_500,
    });

    expect(verified.additions).toEqual([]);
    expect(Number(verified.finalHead.epoch)).toBe(0);
    expect(verified.finalRoster.map(({ deviceId }) => deviceId)).toEqual([
      ALICE_DEVICE,
    ]);
    expect(createHumanMembershipTargetDomainDelivery({
      crypto: setup.crypto,
      verified,
      now: 1_600,
    })).toEqual([]);
  });

  test("verifies a source-authorized sequential provider chain over the exact active roster", () => {
    const setup = fixture();
    const verified = verifyHumanMembershipTargetDomainSubmission({
      crypto: setup.crypto,
      submission: setup.submission,
      expected: {
        operationId: OPERATION,
        targetDomainId: DOMAIN,
        participants: [ALICE, BOB, CHARLIE],
        participantDigest: setup.participantDigest,
        committerDeviceId: ALICE_DEVICE,
        committerHumanId: ALICE,
        activeDevices: setup.devices,
      },
      now: 1_500,
    });

    expect(verified.initialRoster).toHaveLength(1);
    expect(verified.additions).toHaveLength(2);
    expect(verified.finalRoster.map(({ deviceId }) => String(deviceId))).toEqual([
      "device_alice",
      "device_bob",
      "device_charlie",
    ]);
    expect(Number(verified.finalHead.epoch)).toBe(2);

    const messages = createHumanMembershipTargetDomainDelivery({
      crypto: setup.crypto,
      verified,
      now: 1_600,
    });
    const charlieMessage = messages.find(
      ({ recipientDeviceId }) => recipientDeviceId === CHARLIE_DEVICE,
    )!;
    const charlieChunk = decodeOpaqueDeliveryArtifactChunk(
      charlieMessage.payloadBytes,
      setup.crypto,
    );
    const charlieArtifact =
      decodeHumanMembershipTargetDomainDeliveryArtifact(
        reassembleOpaqueDeliveryArtifact({
          crypto: setup.crypto,
          chunks: [charlieChunk],
        }),
      );
    expect(charlieChunk.kind).toBe("target_domain_bootstrap");
    expect(
      charlieArtifact.providerSubmission.transition.welcomeBytes.length,
    ).toBeGreaterThan(0);

    const aliceCharlieMessage = messages.find(({ recipientDeviceId, payloadBytes }) => {
      if (recipientDeviceId !== ALICE_DEVICE) return false;
      const chunk = decodeOpaqueDeliveryArtifactChunk(
        payloadBytes,
        setup.crypto,
      );
      const artifact = decodeHumanMembershipTargetDomainDeliveryArtifact(
        reassembleOpaqueDeliveryArtifact({
          crypto: setup.crypto,
          chunks: [chunk],
        }),
      );
      return artifact.providerSubmission.transition.targetDeviceId
        === CHARLIE_DEVICE;
    })!;
    const aliceArtifact = decodeHumanMembershipTargetDomainDeliveryArtifact(
      reassembleOpaqueDeliveryArtifact({
        crypto: setup.crypto,
        chunks: [decodeOpaqueDeliveryArtifactChunk(
          aliceCharlieMessage.payloadBytes,
          setup.crypto,
        )],
      }),
    );
    expect(aliceArtifact.providerSubmission.transition.welcomeBytes)
      .toHaveLength(0);
  });

  test("rejects an incomplete inventory and post-signature chain mutation", () => {
    const setup = fixture();
    expect(() => verifyHumanMembershipTargetDomainSubmission({
      crypto: setup.crypto,
      submission: setup.submission,
      expected: {
        operationId: OPERATION,
        targetDomainId: DOMAIN,
        participants: [ALICE, BOB, CHARLIE],
        participantDigest: setup.participantDigest,
        committerDeviceId: ALICE_DEVICE,
        committerHumanId: ALICE,
        activeDevices: setup.devices.slice(0, 2),
      },
      now: 1_500,
    })).toThrow();

    const digest =
      setup.submission.additions[0]!.providerSubmission.transitionDigest;
    digest[0] = digest[0]! ^ 1;
    expect(() => verifyHumanMembershipTargetDomainSubmission({
      crypto: setup.crypto,
      submission: setup.submission,
      expected: {
        operationId: OPERATION,
        targetDomainId: DOMAIN,
        participants: [ALICE, BOB, CHARLIE],
        participantDigest: setup.participantDigest,
        committerDeviceId: ALICE_DEVICE,
        committerHumanId: ALICE,
        activeDevices: setup.devices,
      },
      now: 1_500,
    })).toThrow("chain digest");
  });

  test("rejects non-portable signed coordinates before encoding them", () => {
    const setup = fixture();
    expect(() => createHumanMembershipTargetDomainSubmission({
      crypto: setup.crypto,
      operationId: "operation\u0000target-domain",
      targetDomainId: DOMAIN,
      participants: [ALICE, BOB, CHARLIE],
      participantDigest: setup.participantDigest,
      committerDeviceId: ALICE_DEVICE,
      committerHumanId: ALICE,
      initialProviderHead: setup.submission.initialProviderHead,
      initialRosterBytes: setup.submission.initialRosterBytes,
      additions: setup.submission.additions,
      signingPrivateKey: new Uint8Array(32),
    })).toThrow("operation");
  });
});
