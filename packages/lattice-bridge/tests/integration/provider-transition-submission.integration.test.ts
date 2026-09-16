import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDomainId,
} from "@nautilo/lattice-crypto";
import { v2ProviderMatrix } from "@nautilo/lattice-crypto/testing";
import {
  decodeProviderRosterV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createProviderTransitionSubmission,
  verifyProviderTransitionSubmission,
} from "../../src/index.ts";

describe("real provider transition submissions", () => {
  for (const [index, row] of v2ProviderMatrix
    .filter((candidate) => candidate.id !== "dummy")
    .entries()) {
    test(`${row.id} device-add is accepted without provider state crossing the bridge`, async () => {
      const fixture = await row.create({
        seed: 0x7b10 + index,
        domainId: cryptoDomainId(`domain_bridge_transition_${row.id}`),
      });
      const prepared = await row.prepareSemanticTransition({
        fixture,
        semantic: "device-add",
        seed: 0x7b20 + index,
      });
      const transition = prepared.prepared.publicResult;
      const currentHead = fixture.provider.publicHead(fixture.active);
      const currentRosterBytes = fixture.provider.publicRoster(
        fixture.active,
      );
      const currentRoster = decodeProviderRosterV2(
        currentHead.providerId,
        currentRosterBytes,
      );
      const committer = currentRoster[0]!;
      const bridgeCrypto = new LatticeCrypto();
      const signing = bridgeCrypto.generateSigningKeyPair();
      const participantDigest = new Uint8Array(32).fill(0x71 + index);
      const operationId = `operation_real_${row.id}`;
      const submission = createProviderTransitionSubmission({
        crypto: bridgeCrypto,
        transition,
        operationId,
        committerDeviceId: committer.deviceId,
        expectedAuthorizationRevision: 9,
        expectedParticipantDigest: participantDigest,
        signingPrivateKey: signing.privateKey,
      });
      const verified = verifyProviderTransitionSubmission({
        crypto: bridgeCrypto,
        submission,
        expectation: {
          operationId,
          operationKind: "device_add",
          domainId: transition.domainId,
          targetHumanId: transition.targetHumanId,
          targetDeviceId: transition.targetDeviceId,
          expectedEpoch: transition.expectedHead.epoch,
          targetEpoch: transition.nextHead.epoch,
          expectedAuthorizationRevision: 9,
          expectedParticipantDigest: participantDigest,
          committerDeviceId: committer.deviceId,
        },
        currentProviderState: {
          head: currentHead,
          rosterBytes: currentRosterBytes,
        },
        resolveActiveCommitter: (deviceId) =>
          deviceId === committer.deviceId
            ? {
              state: "active",
              humanId: committer.humanId,
              signingPublicKey: signing.publicKey,
            }
            : null,
      });

      expect(verified.transition).toEqual(transition);
      expect(verified.nextRoster).toHaveLength(2);
      expect(
        verified.nextRoster.find(
          (entry) => entry.leafIndex === verified.targetLeafIndex,
        )?.deviceId,
      ).toBe(transition.targetDeviceId);
      expect(verified).not.toHaveProperty("localCandidate");
      expect(verified).not.toHaveProperty("providerState");
    });
  }
});
