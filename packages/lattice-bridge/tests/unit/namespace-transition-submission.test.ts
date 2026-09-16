import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  prepareDomainEpochAdvance,
  sealNamespaceKeyring,
} from "@nautilo/lattice-crypto";
import {
  createNamespaceTransitionSubmission,
  decodeNamespaceTransitionSubmission,
  serializeNamespaceTransitionSubmission,
  verifyNamespaceTransitionSubmission,
  type DeviceFanoutDomainPlan,
} from "../../src/index.ts";

function root(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function fixture() {
  const crypto = new LatticeCrypto();
  const committer = crypto.generateSigningKeyPair();
  const committerDeviceId = cryptoDeviceId("device_alice_desktop");
  const domainId = cryptoDomainId("domain_alice_bob");
  const oldHumanRoot = root(0x31);
  const oldAiRoot = root(0x32);
  const resolveCommitter = () => committer.publicKey;
  const affected = ["namespace_room_1", "namespace_room_2"].map(
    (rawNamespaceId) => {
      const keyrings = createInitialNamespaceKeyrings(
        crypto,
        namespaceId(rawNamespaceId),
      );
      const metadata = {
        domainId,
        domainEpoch: domainEpoch(6),
        previousBindingHash: null,
        committerDeviceId,
      };
      const humanEnvelope = sealNamespaceKeyring({
        crypto,
        domainRoot: oldHumanRoot,
        keyring: keyrings.human,
        metadata,
        committerSigningPrivateKey: committer.privateKey,
        resolveCurrentCommitter: resolveCommitter,
      });
      const aiEnvelope = sealNamespaceKeyring({
        crypto,
        domainRoot: oldAiRoot,
        keyring: keyrings.ai,
        metadata,
        committerSigningPrivateKey: committer.privateKey,
        resolveCurrentCommitter: resolveCommitter,
      });
      const binding = createNamespaceBinding({
        crypto,
        humanEnvelope,
        aiEnvelope,
        committerSigningPrivateKey: committer.privateKey,
        resolveCurrentCommitter: resolveCommitter,
      });
      return {
        anchor: null,
        proof: [binding],
        humanEnvelope,
        aiEnvelope,
      };
    },
  );
  const prepared = prepareDomainEpochAdvance({
    crypto,
    reason: "device_add",
    domain: {
      domainId,
      oldEpoch: domainEpoch(6),
      nextEpoch: domainEpoch(7),
      oldHumanRoot,
      oldAiRoot,
      nextHumanRoot: root(0x41),
      nextAiRoot: root(0x42),
    },
    affected,
    committer: {
      deviceId: committerDeviceId,
      signingPrivateKey: committer.privateKey,
    },
    resolveHistoricalCommitter: resolveCommitter,
    resolveSourceCommitter: resolveCommitter,
    resolveTargetCommitter: resolveCommitter,
  });
  const operationId = "operation_device_add";
  const providerTransitionDigest = root(0x71);
  const plan: DeviceFanoutDomainPlan = {
    domainId,
    expectedEpoch: 6,
    targetEpoch: 7,
    expectedAuthorizationRevision: 11,
    expectedParticipantDigest: root(0x61),
    committerDeviceId,
    namespaces: prepared.namespaces.map((candidate) => ({
      namespaceId: candidate.expectedHead.namespaceId,
      expectedAccessRevision: candidate.expectedHead.accessRevision,
      expectedBindingHash: candidate.expectedHead.bindingHash,
    })),
  };
  const submission = createNamespaceTransitionSubmission({
    crypto,
    operationId,
    committerDeviceId,
    providerTransitionDigest,
    prepared,
    signingPrivateKey: committer.privateKey,
  });
  const verify = (
    candidate = submission,
    overrides: Partial<Parameters<
      typeof verifyNamespaceTransitionSubmission
    >[0]> = {},
  ) =>
    verifyNamespaceTransitionSubmission({
      crypto,
      submission: candidate,
      operationId,
      domainPlan: plan,
      providerTransitionDigest,
      resolveActiveCommitter: (deviceId) =>
        deviceId === committerDeviceId
          ? {
            state: "active",
            humanId: "human_alice",
            signingPublicKey: committer.publicKey,
          }
          : null,
      ...overrides,
    });
  return {
    crypto,
    committer,
    committerDeviceId,
    domainId,
    operationId,
    plan,
    prepared,
    providerTransitionDigest,
    submission,
    verify,
  };
}

describe("Namespace transition submission", () => {
  test("binds every exact Namespace consequence to one provider transition", () => {
    const setup = fixture();
    const verified = setup.verify();
    expect(verified.operationId).toBe(setup.operationId);
    expect(verified.domainId).toBe(setup.domainId);
    expect(verified.candidates).toHaveLength(2);
    expect(
      verified.candidates.map((candidate) => candidate.nextHead.namespaceId),
    ).toEqual(["namespace_room_1", "namespace_room_2"]);
    for (const [index, candidate] of verified.candidates.entries()) {
      expect(candidate.expectedHead).toEqual(
        setup.prepared.namespaces[index]!.expectedHead,
      );
      expect(candidate.nextHead).toEqual(
        setup.prepared.namespaces[index]!.nextHead,
      );
      expect(candidate.binding.namespaceId).toBe(
        candidate.nextHead.namespaceId,
      );
      expect(candidate.binding.bindingHash).toEqual(
        candidate.nextHead.bindingHash,
      );
    }
  });

  test("round-trips one canonical owned transport record", () => {
    const setup = fixture();
    const bytes = serializeNamespaceTransitionSubmission(setup.submission);
    const decoded = decodeNamespaceTransitionSubmission(bytes);
    expect(decoded).toEqual(setup.submission);
    expect(decoded).not.toBe(setup.submission);
    expect(decoded.candidates[0]).not.toBe(setup.submission.candidates[0]);
    expect(setup.verify(decoded).candidates).toHaveLength(2);

    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() =>
      decodeNamespaceTransitionSubmission(trailing)
    ).toThrow("trailing");
  });

  test("rejects stale plans, reordered candidates, and changed provider transitions", () => {
    const setup = fixture();
    expect(() =>
      setup.verify({
        ...setup.submission,
        candidates: [...setup.submission.candidates].reverse(),
      })
    ).toThrow();
    expect(() =>
      setup.verify(setup.submission, {
        domainPlan: {
          ...setup.plan,
          namespaces: setup.plan.namespaces.map((candidate, index) =>
            index === 0
              ? {
                ...candidate,
                expectedBindingHash: root(0x99),
              }
              : candidate
          ),
        },
      })
    ).toThrow("plan");
    expect(() =>
      setup.verify(setup.submission, {
        providerTransitionDigest: root(0x72),
      })
    ).toThrow("provider transition");
  });

  test("rejects unauthenticated outer, binding, and envelope bytes", () => {
    const setup = fixture();
    expect(() =>
      setup.verify(setup.submission, {
        resolveActiveCommitter: () => null,
      })
    ).toThrow("committer");

    const first = setup.submission.candidates[0]!;
    for (const field of [
      "signedBindingBytes",
      "humanKeyringEnvelopeBytes",
      "aiKeyringEnvelopeBytes",
    ] as const) {
      const changed = first.binding[field].slice();
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
      expect(() =>
        setup.verify({
          ...setup.submission,
          candidates: [
            {
              ...first,
              binding: {
                ...first.binding,
                [field]: changed,
              },
            },
            ...setup.submission.candidates.slice(1),
          ],
        })
      ).toThrow();
    }
  });
});
