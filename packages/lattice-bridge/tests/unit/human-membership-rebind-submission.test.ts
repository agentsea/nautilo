import { describe, expect, test } from "bun:test";
import {
  accessRevision,
  namespaceBindingHash,
  namespaceKeyringEnvelopeHash,
} from "@nautilo/lattice-crypto";
import {
  namespaceBindingSigningBytesV2,
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
  storageAdapterSupportV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createHumanMembershipRebindDelivery,
  decodeOpaqueDeliveryArtifactChunk,
} from "../../src/index.ts";
import {
  decodeHumanMembershipRebindSubmission,
  humanMembershipRebindCandidateDigest,
  humanMembershipRebindSubmissionSigningBytes,
  serializeHumanMembershipRebindSubmission,
  verifyHumanMembershipRebindSubmission,
  type HumanMembershipRebindSubmission,
} from "../../src/delivery/human-membership-rebind-submission.ts";
import {
  COMMITTER_DEVICE,
  SOURCE_DOMAIN,
  TARGET_ADD_DOMAIN,
  createHumanMembershipRebindFixture as setup,
  rebindDigest as digest,
} from "./human-membership-rebind-fixture.ts";

describe("Human membership Namespace-rebind submission", () => {
  test("round-trips and verifies one signed Human-add candidate across both exact-set Domains", () => {
    const fixture = setup();
    const decoded = decodeHumanMembershipRebindSubmission(
      serializeHumanMembershipRebindSubmission(fixture.submission),
    );
    const verified = verifyHumanMembershipRebindSubmission({
      crypto: fixture.crypto,
      submission: decoded,
      expected: fixture.expected,
      resolveSourceCommitter: fixture.activeCommitter,
      resolveTargetCommitter: fixture.activeCommitter,
    });

    expect(verified.kind).toBe("human_add");
    expect(verified.sourceDomainId).toBe(SOURCE_DOMAIN);
    expect(verified.targetDomainId).toBe(TARGET_ADD_DOMAIN);
    expect(verified.candidate.expectedHead).toEqual(
      fixture.prepared.expectedHead,
    );
    expect(verified.candidate.nextHead).toEqual(fixture.prepared.nextHead);
    expect(verified.candidate.binding).toEqual(
      storageAdapterSupportV2.validateNamespaceBinding(
        fixture.prepared.bindingRecord,
      ),
    );
  });

  test("packages and verifies Human removal through the same dual-Domain authorization", () => {
    const fixture = setup("human_remove");
    const decoded = decodeHumanMembershipRebindSubmission(
      serializeHumanMembershipRebindSubmission(fixture.submission),
    );
    expect(
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: decoded,
        expected: fixture.expected,
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      }).kind,
    ).toBe("human_remove");
  });

  test("fans one verified rebind artifact to every target device with one mandatory acknowledgement", () => {
    const fixture = setup();
    const verified = verifyHumanMembershipRebindSubmission({
      crypto: fixture.crypto,
      submission: fixture.submission,
      expected: fixture.expected,
      resolveSourceCommitter: fixture.activeCommitter,
      resolveTargetCommitter: fixture.activeCommitter,
    });
    const delivery = createHumanMembershipRebindDelivery({
      crypto: fixture.crypto,
      submission: verified,
      recipientDeviceIds: ["device_charlie_browser", COMMITTER_DEVICE],
      requiredAcknowledgementDeviceId: "device_charlie_browser",
      now: 10_000,
    });
    expect(delivery.messages.map((message) => message.recipientDeviceId))
      .toEqual([COMMITTER_DEVICE, "device_charlie_browser"]);
    expect(delivery.requiredAcknowledgementDeviceId)
      .toBe("device_charlie_browser");
    for (const message of delivery.messages) {
      expect(
        decodeOpaqueDeliveryArtifactChunk(
          message.payloadBytes,
          fixture.crypto,
        ).kind,
      ).toBe("membership_rebind");
    }

    verified.candidateDigest[0] = verified.candidateDigest[0]! ^ 1;
    expect(() =>
      createHumanMembershipRebindDelivery({
        crypto: fixture.crypto,
        submission: verified,
        recipientDeviceIds: [COMMITTER_DEVICE],
        requiredAcknowledgementDeviceId: COMMITTER_DEVICE,
        now: 10_000,
      })
    ).toThrow("not cryptographically verified");
  });

  test("rejects structural clones, altered outer signatures, and candidate-digest changes", () => {
    const fixture = setup();
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: structuredClone(fixture.submission),
        expected: fixture.expected,
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).toThrow("canonical creator or decoder");

    const alteredSignature = decodeHumanMembershipRebindSubmission(
      serializeHumanMembershipRebindSubmission(fixture.submission),
    );
    alteredSignature.signature[0] = alteredSignature.signature[0]! ^ 1;
    const canonicalAlteredSignature = decodeHumanMembershipRebindSubmission(
      serializeHumanMembershipRebindSubmission(alteredSignature),
    );
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: canonicalAlteredSignature,
        expected: fixture.expected,
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).toThrow("outer signature");

    const alteredDigest = decodeHumanMembershipRebindSubmission(
      serializeHumanMembershipRebindSubmission(fixture.submission),
    );
    alteredDigest.candidateDigest[0] = alteredDigest.candidateDigest[0]! ^ 1;
    const canonicalAlteredDigest = decodeHumanMembershipRebindSubmission(
      serializeHumanMembershipRebindSubmission(alteredDigest),
    );
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: canonicalAlteredDigest,
        expected: fixture.expected,
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).toThrow("candidate digest");
  });

  test("rejects stale heads and authoritative participant-digest changes", () => {
    const fixture = setup();
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: fixture.submission,
        expected: {
          ...fixture.expected,
          expectedHead: {
            ...fixture.expected.expectedHead,
            accessRevision: accessRevision(
              Number(fixture.expected.expectedHead.accessRevision) + 1,
            ),
          },
        },
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).toThrow("authoritative transition");
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: fixture.submission,
        expected: {
          ...fixture.expected,
          newParticipantDigest: digest(0xee),
        },
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).toThrow("authoritative transition");
  });

  test("requires one identical active committer key and Human in source and target Domains", () => {
    const fixture = setup();
    const otherKey = fixture.crypto.generateSigningKeyPair().publicKey;
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: fixture.submission,
        expected: fixture.expected,
        resolveSourceCommitter: () => ({
          ...fixture.activeCommitter(),
          state: "revoked" as const,
        }),
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).toThrow("same active committer");
    for (const resolveTargetCommitter of [
      () => ({
        ...fixture.activeCommitter(),
        state: "revoked" as const,
      }),
      () => ({
        ...fixture.activeCommitter(),
        humanId: "human_mallory",
      }),
      () => ({
        ...fixture.activeCommitter(),
        signingPublicKey: otherKey,
      }),
    ]) {
      expect(() =>
        verifyHumanMembershipRebindSubmission({
          crypto: fixture.crypto,
          submission: fixture.submission,
          expected: fixture.expected,
          resolveSourceCommitter: fixture.activeCommitter,
          resolveTargetCommitter,
        })
      ).toThrow("same active committer");
    }
  });

  test("authenticates the binding and both keyring envelopes independently of the outer signature", () => {
    const fixture = setup();
    const signed = parseNamespaceBindingV2(
      fixture.submission.candidate.binding.signedBindingBytes,
    );
    const badBinding = {
      ...signed,
      signature: signed.signature.slice(),
    };
    badBinding.signature[0] = badBinding.signature[0]! ^ 1;
    const badBindingBytes = serializeNamespaceBindingV2(badBinding);
    const badWire = storageAdapterSupportV2.validateNamespaceBinding({
      ...fixture.submission.candidate.binding,
      signedBindingBytes: badBindingBytes,
      bindingHash: namespaceBindingHash(badBinding),
    });
    const candidate = {
      ...fixture.submission.candidate,
      nextHead: {
        ...fixture.submission.candidate.nextHead,
        bindingHash: badWire.bindingHash,
      },
      binding: badWire,
    };
    const candidateDigest = humanMembershipRebindCandidateDigest(
      fixture.crypto,
      candidate,
    );
    const unsigned = {
      ...fixture.submission,
      candidate,
      candidateDigest,
    };
    const forged: HumanMembershipRebindSubmission = {
      ...unsigned,
      signature: fixture.crypto.sign(
        fixture.signing.privateKey,
        humanMembershipRebindSubmissionSigningBytes(unsigned),
      ),
    };
    const decoded = decodeHumanMembershipRebindSubmission(
      serializeHumanMembershipRebindSubmission(forged),
    );
    expect(() =>
      verifyHumanMembershipRebindSubmission({
        crypto: fixture.crypto,
        submission: decoded,
        expected: {
          ...fixture.expected,
          expectedHead: decoded.candidate.expectedHead,
        },
        resolveSourceCommitter: fixture.activeCommitter,
        resolveTargetCommitter: fixture.activeCommitter,
      })
    ).toThrow("binding signature");
  });

  test("authenticates both keyring-envelope signatures independently", () => {
    for (const keyClass of ["human", "ai"] as const) {
      const fixture = setup();
      const wire = fixture.submission.candidate.binding;
      const envelopeField = keyClass === "human"
        ? "humanKeyringEnvelopeBytes"
        : "aiKeyringEnvelopeBytes";
      const hashField = keyClass === "human"
        ? "humanKeyringEnvelopeHash"
        : "aiKeyringEnvelopeHash";
      const envelope = parseNamespaceKeyringEnvelopeV2(wire[envelopeField]);
      const invalidEnvelope = {
        ...envelope,
        signature: envelope.signature.slice(),
      };
      invalidEnvelope.signature[0] = invalidEnvelope.signature[0]! ^ 1;
      const invalidEnvelopeBytes = serializeNamespaceKeyringEnvelopeV2(
        invalidEnvelope,
      );
      const binding = parseNamespaceBindingV2(wire.signedBindingBytes);
      const reboundUnsigned = {
        ...binding,
        [hashField]: namespaceKeyringEnvelopeHash(invalidEnvelope),
      };
      const rebound = {
        ...reboundUnsigned,
        signature: fixture.crypto.sign(
          fixture.signing.privateKey,
          namespaceBindingSigningBytesV2(reboundUnsigned),
        ),
      };
      const reboundBytes = serializeNamespaceBindingV2(rebound);
      const reboundHash = namespaceBindingHash(rebound);
      const candidate = {
        ...fixture.submission.candidate,
        nextHead: {
          ...fixture.submission.candidate.nextHead,
          bindingHash: reboundHash,
        },
        binding: storageAdapterSupportV2.validateNamespaceBinding({
          ...wire,
          bindingHash: reboundHash,
          signedBindingBytes: reboundBytes,
          [envelopeField]: invalidEnvelopeBytes,
        }),
      };
      const candidateDigest = humanMembershipRebindCandidateDigest(
        fixture.crypto,
        candidate,
      );
      const unsigned = {
        ...fixture.submission,
        candidate,
        candidateDigest,
      };
      const forged = {
        ...unsigned,
        signature: fixture.crypto.sign(
          fixture.signing.privateKey,
          humanMembershipRebindSubmissionSigningBytes(unsigned),
        ),
      };
      const decoded = decodeHumanMembershipRebindSubmission(
        serializeHumanMembershipRebindSubmission(forged),
      );
      expect(() =>
        verifyHumanMembershipRebindSubmission({
          crypto: fixture.crypto,
          submission: decoded,
          expected: fixture.expected,
          resolveSourceCommitter: fixture.activeCommitter,
          resolveTargetCommitter: fixture.activeCommitter,
        })
      ).toThrow(
        `${keyClass === "human" ? "Human" : "AI"} keyring envelope signature`,
      );
    }
  });

  test("rejects truncated, trailing, and over-limit codec inputs", () => {
    const fixture = setup();
    const bytes = serializeHumanMembershipRebindSubmission(fixture.submission);
    expect(() =>
      decodeHumanMembershipRebindSubmission(bytes.subarray(0, bytes.length - 1))
    ).toThrow();
    expect(() =>
      decodeHumanMembershipRebindSubmission(
        new Uint8Array([...bytes, 0]),
      )
    ).toThrow("trailing");
    expect(() =>
      decodeHumanMembershipRebindSubmission(new Uint8Array(67_108_865))
    ).toThrow("limit");
  });
});
