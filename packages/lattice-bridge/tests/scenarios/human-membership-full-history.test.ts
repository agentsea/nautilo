import { describe, expect, test } from "bun:test";
import {
  createHumanMembershipTargetDomainDelivery,
  decodeHumanMembershipTargetDomainDeliveryArtifact,
  decodeHumanMembershipRebindSubmission,
  decodeOpaqueDeliveryArtifactChunk,
  reassembleOpaqueDeliveryArtifact,
  verifyHumanMembershipTargetDomainSubmission,
  verifyHumanMembershipRebindSubmission,
} from "../../src/index.ts";
import {
  LatticeCrypto,
  openNamespaceKeyring,
} from "@nautilo/lattice-crypto";
import {
  parseNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  COMMITTER_DEVICE,
  COMMITTER_HUMAN,
  createHumanMembershipRebindFixture,
} from "../unit/human-membership-rebind-fixture.ts";
import {
  createHumanMembershipRebindDelivery,
} from "../../src/delivery/human-membership-rebind-delivery.ts";
import {
  COLD_ALICE_ACTOR,
  COLD_ALICE_DEVICE,
  COLD_CHARLIE_ACTOR,
  COLD_CHARLIE_DEVICE,
  COLD_OPERATION,
  COLD_TARGET_DOMAIN,
  createColdHumanAddFixture,
} from "../fixtures/cold-human-add-fixture.ts";

function verifiedFixture(reason: "human_add" | "human_remove") {
  const fixture = createHumanMembershipRebindFixture(reason);
  const submission = verifyHumanMembershipRebindSubmission({
    crypto: fixture.crypto,
    submission: fixture.submission,
    expected: fixture.expected,
    resolveSourceCommitter: fixture.activeCommitter,
    resolveTargetCommitter: fixture.activeCommitter,
  });
  return { fixture, submission };
}

describe("Human membership full-history transition", () => {
  test("cold invited Human consumes a real Welcome and opens retained history", async () => {
    const crypto = new LatticeCrypto(seededRng(7_232));
    const aliceSigning = crypto.generateSigningKeyPair();
    const charlieSigning = crypto.generateSigningKeyPair();
    const cold = await createColdHumanAddFixture({
      crypto,
      aliceSigning,
      charlieSigning,
    });
    const verifiedTarget = verifyHumanMembershipTargetDomainSubmission({
      crypto,
      submission: cold.target.submission,
      expected: {
        operationId: COLD_OPERATION,
        targetDomainId: COLD_TARGET_DOMAIN,
        participants: [COLD_ALICE_ACTOR, COLD_CHARLIE_ACTOR],
        participantDigest: cold.membership.newParticipantDigest,
        committerDeviceId: COLD_ALICE_DEVICE,
        committerHumanId: COLD_ALICE_ACTOR,
        activeDevices: [
          {
            deviceId: COLD_ALICE_DEVICE,
            humanId: COLD_ALICE_ACTOR,
            generation: 1,
            signingPublicKey: aliceSigning.publicKey,
          },
          {
            deviceId: COLD_CHARLIE_DEVICE,
            humanId: COLD_CHARLIE_ACTOR,
            generation: 1,
            signingPublicKey: charlieSigning.publicKey,
          },
        ],
      },
      now: 20_000,
    });
    const targetDelivery = createHumanMembershipTargetDomainDelivery({
      crypto,
      verified: verifiedTarget,
      now: 20_000,
    });
    const charlieTargetMessage = targetDelivery.find(
      ({ recipientDeviceId }) =>
        recipientDeviceId === COLD_CHARLIE_DEVICE,
    )!;
    const charlieTargetArtifact =
      decodeHumanMembershipTargetDomainDeliveryArtifact(
        reassembleOpaqueDeliveryArtifact({
          crypto,
          chunks: [decodeOpaqueDeliveryArtifactChunk(
            charlieTargetMessage.payloadBytes,
            crypto,
          )],
        }),
      );
    expect(charlieTargetArtifact.providerSubmission.transition.welcomeBytes)
      .not.toHaveLength(0);

    const aliceTarget = await cold.target.activateAlice();
    const charlieTarget = await cold.target.activateCharlie(
      charlieTargetArtifact.providerSubmission.transition,
    );
    expect(charlieTarget.roots.human).toEqual(aliceTarget.roots.human);
    expect(charlieTarget.roots.ai).toEqual(aliceTarget.roots.ai);

    const rebind = cold.createRebind(aliceTarget.roots);
    const verifiedRebind = verifyHumanMembershipRebindSubmission({
      crypto,
      submission: rebind.submission,
      expected: {
        operationId: COLD_OPERATION,
        kind: "human_add",
        sourceDomainId: cold.membership.oldDomainId,
        targetDomainId: COLD_TARGET_DOMAIN,
        oldParticipantDigest: cold.membership.oldParticipantDigest,
        newParticipantDigest: cold.membership.newParticipantDigest,
        expectedHead: rebind.prepared.expectedHead,
      },
      resolveSourceCommitter: () => ({
        state: "active",
        deviceId: COLD_ALICE_DEVICE,
        humanId: COLD_ALICE_ACTOR,
        signingPublicKey: aliceSigning.publicKey,
      }),
      resolveTargetCommitter: () => ({
        state: "active",
        deviceId: COLD_ALICE_DEVICE,
        humanId: COLD_ALICE_ACTOR,
        signingPublicKey: aliceSigning.publicKey,
      }),
    });
    const rebindDelivery = createHumanMembershipRebindDelivery({
      crypto,
      submission: verifiedRebind,
      recipientDeviceIds: [COLD_ALICE_DEVICE, COLD_CHARLIE_DEVICE],
      requiredAcknowledgementDeviceId: COLD_CHARLIE_DEVICE,
      now: 21_000,
    });
    const deliveredRebind = decodeHumanMembershipRebindSubmission(
      reassembleOpaqueDeliveryArtifact({
        crypto,
        chunks: rebindDelivery.messages
          .filter(({ recipientDeviceId }) =>
            recipientDeviceId === COLD_CHARLIE_DEVICE
          )
          .map(({ payloadBytes }) =>
            decodeOpaqueDeliveryArtifactChunk(payloadBytes, crypto)
        ),
      }),
    );
    const deliveredHumanEnvelope = parseNamespaceKeyringEnvelopeV2(
      deliveredRebind.candidate.binding.humanKeyringEnvelopeBytes,
    );
    const retained = openNamespaceKeyring({
      crypto,
      domainRoot: charlieTarget.roots.human,
      envelope: deliveredHumanEnvelope,
      resolveHistoricalCommitter: () => aliceSigning.publicKey,
    });
    expect(retained.generations).toHaveLength(2);
    expect(retained.generations[0]).toEqual(
      cold.source.keyrings.human.generations[0],
    );
    expect(() =>
      openNamespaceKeyring({
        crypto,
        domainRoot: cold.source.roots.human,
        envelope: deliveredHumanEnvelope,
        resolveHistoricalCommitter: () => aliceSigning.publicKey,
      })
    ).toThrow("failed to decrypt");
  }, 60_000);

  test("delivers an authenticated add rebind whose target keyring retains old history", () => {
    const { fixture, submission } = verifiedFixture("human_add");
    const targetDeviceId = "device_charlie_browser";
    const delivery = createHumanMembershipRebindDelivery({
      crypto: fixture.crypto,
      submission,
      recipientDeviceIds: [
        COMMITTER_DEVICE,
        "device_bob_mobile",
        targetDeviceId,
      ],
      requiredAcknowledgementDeviceId: targetDeviceId,
      now: 40_000,
    });
    const chunks = delivery.messages
      .filter((message) => message.recipientDeviceId === targetDeviceId)
      .map((message) =>
        decodeOpaqueDeliveryArtifactChunk(
          message.payloadBytes,
          fixture.crypto,
        )
      );
    const deliveredBytes = reassembleOpaqueDeliveryArtifact({
      crypto: fixture.crypto,
      chunks,
    });
    const delivered = decodeHumanMembershipRebindSubmission(deliveredBytes);
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: delivered,
        expected: fixture.expected,
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).not.toThrow();

    const retained = openNamespaceKeyring({
      crypto: fixture.crypto,
      domainRoot: fixture.targetHumanRoot,
      envelope: fixture.prepared.humanEnvelope,
      resolveHistoricalCommitter: () => fixture.signing.publicKey,
    });
    expect(retained.generations).toHaveLength(2);
    expect(retained.generations[0]).toEqual(
      fixture.keyrings.human.generations[0],
    );
    expect(Number(retained.currentGeneration)).toBe(1);
    expect(() =>
      openNamespaceKeyring({
        crypto: fixture.crypto,
        domainRoot: fixture.sourceHumanRoot,
        envelope: fixture.prepared.humanEnvelope,
        resolveHistoricalCommitter: () => fixture.signing.publicKey,
      })
    ).toThrow("failed to decrypt");
  });

  test("rotates removal writes away from the removed Human while retaining history for remaining Humans", () => {
    const { fixture, submission } = verifiedFixture("human_remove");
    const delivery = createHumanMembershipRebindDelivery({
      crypto: fixture.crypto,
      submission,
      recipientDeviceIds: [COMMITTER_DEVICE, "device_charlie_browser"],
      requiredAcknowledgementDeviceId: COMMITTER_DEVICE,
      now: 50_000,
    });
    expect(delivery.messages.some((message) =>
      message.recipientDeviceId === "device_bob_removed"
    )).toBe(false);
    expect(delivery.requiredAcknowledgementDeviceId).toBe(COMMITTER_DEVICE);
    expect(submission.committerHumanId).toBe(COMMITTER_HUMAN);

    const retained = openNamespaceKeyring({
      crypto: fixture.crypto,
      domainRoot: fixture.targetHumanRoot,
      envelope: fixture.prepared.humanEnvelope,
      resolveHistoricalCommitter: () => fixture.signing.publicKey,
    });
    expect(retained.generations).toHaveLength(2);
    expect(retained.generations[0]).toEqual(
      fixture.keyrings.human.generations[0],
    );
    expect(retained.generations[1]).not.toEqual(
      fixture.keyrings.human.generations[0],
    );
    expect(() =>
      openNamespaceKeyring({
        crypto: fixture.crypto,
        domainRoot: fixture.sourceHumanRoot,
        envelope: fixture.prepared.humanEnvelope,
        resolveHistoricalCommitter: () => fixture.signing.publicKey,
      })
    ).toThrow("failed to decrypt");
  });
});
