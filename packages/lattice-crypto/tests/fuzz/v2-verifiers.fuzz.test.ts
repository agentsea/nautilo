import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  sealAgentRuntimeToDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import {
  prepareAgentRuntimeHandoffChallenge,
  prepareAgentRuntimeHandoffResponse,
  prepareAgentRuntimeHandoffTarget,
  type AgentRuntimeHandoffPlanV1,
  type CurrentAgentRuntimeHandoffCommitterResolverV1,
} from "../../src/agent-runtime/runtime-handoff-v2.ts";
import {
  createNamespaceBinding,
  verifyNamespaceBinding,
} from "../../src/namespace/bindings.ts";
import {
  createInitialNamespaceKeyrings,
  sealNamespaceKeyring,
  verifyNamespaceKeyringEnvelope,
} from "../../src/namespace/keyrings.ts";
import {
  parseNamespaceBinding,
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  parseNamespaceKeyringEnvelope,
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  createObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  verifyObjectAccessManifestChainV2,
} from "../../src/object/access-manifest.ts";
import {
  prepareRecoveryDeviceActivationChallengeV2,
  recoveryReadinessDigest,
  serializeRecoveryDeviceActivationProof,
  verifyRecoveryDeviceActivationProofV2,
} from "../../src/recovery/device-transfer-v2.ts";
import {
  deviceTransferInventoryRevision,
  pendingDeviceRevision,
} from "../../src/recovery/device-transfer-common-v2.ts";
import {
  recoveryKeyGeneration,
  recoveryPublicKeyDigest,
} from "../../src/format/recovery-v2.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function bitFlip(value: Uint8Array, seed: number, tailBytes: number): Uint8Array {
  const output = value.slice();
  const tailStart = Math.max(0, output.length - tailBytes);
  const offset = tailStart + (seed % (output.length - tailStart));
  output[offset] = output[offset]! ^ (1 << (seed % 8));
  return output;
}

async function expectOwnedRejection(
  action: () => unknown,
  label: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /\b(?:activation|binding|challenge|decode|domain|envelope|frame|handoff|manifest|proof|recovery|response|runtime|signature|trailing|truncated|u32|u64|utf-8|version)\b/iu,
    );
    return;
  }
  throw new Error(`${label} unexpectedly verified mutated bytes`);
}

class RuntimeMutationCrypto extends LatticeCrypto {
  openedPlaintextTransform:
    ((plaintext: Uint8Array) => Uint8Array) | null = null;

  override async openSealed(
    privateKey: Uint8Array,
    sealed: Uint8Array,
  ): Promise<Uint8Array | null> {
    const opened = await super.openSealed(privateKey, sealed);
    return opened === null || this.openedPlaintextTransform === null
      ? opened
      : this.openedPlaintextTransform(opened);
  }
}

async function runtimeHandoffFixture(seed: number) {
  const crypto = new RuntimeMutationCrypto(
    seededRng(0x2258 + seed),
    manualClock(1_000_000),
  );
  const sourceSigning = crypto.generateSigningKeyPair();
  const targetSigning = crypto.generateSigningKeyPair();
  const targetEphemeral = await crypto.generateEncryptionKeyPair();
  const plan: AgentRuntimeHandoffPlanV1 = {
    operationId: "operation_runtime_handoff_fuzz",
    agentId: agentId("agent_genie"),
    runtimeGeneration: agentRuntimeGeneration(7),
    source: {
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      agentAuthorizationRevision: authorizationRevision(11),
      committerDeviceId: cryptoDeviceId("device_alice"),
    },
    target: {
      domainId: cryptoDomainId("domain_bc"),
      domainEpoch: domainEpoch(5),
      agentAuthorizationRevision: authorizationRevision(13),
      committerDeviceId: cryptoDeviceId("device_bob"),
    },
  };
  const currentCommitter:
    CurrentAgentRuntimeHandoffCommitterResolverV1 = ({ role }) =>
      role === "source" ? sourceSigning.publicKey : targetSigning.publicKey;
  const challenge = prepareAgentRuntimeHandoffChallenge({
    crypto,
    plan,
    targetEphemeralPublicKey: targetEphemeral.publicKey,
    targetCommitterSigningPrivateKey: targetSigning.privateKey,
    resolveCurrentCommitter: currentCommitter,
    ttlMs: 60_000,
  });
  const sourceEnvelope = sealAgentRuntimeToDomain({
    crypto,
    domainRoot: bytes(0x31),
    runtime: {
      agentId: plan.agentId,
      keyClass: "runtime",
      generation: plan.runtimeGeneration,
      key: bytes(0x47),
    },
    context: plan.source,
    committerSigningPrivateKey: sourceSigning.privateKey,
    currentCommitterAuthorized: () => true,
  });
  const response = await prepareAgentRuntimeHandoffResponse({
    crypto,
    challengeBytes: challenge.challengeBytes,
    expectedPlan: plan,
    sourceDomainRoot: bytes(0x31),
    sourceEnvelope,
    resolveHistoricalSourceCommitter: () => sourceSigning.publicKey,
    sourceCommitterSigningPrivateKey: sourceSigning.privateKey,
    resolveCurrentCommitter: currentCommitter,
  });
  const finish = (
    challengeBytes: Uint8Array,
    responseBytes: Uint8Array,
  ) =>
    prepareAgentRuntimeHandoffTarget({
      crypto,
      challengeBytes,
      responseBytes,
      expectedPlan: plan,
      trustedChallengeState: {
        challengeHash: challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: targetEphemeral.privateKey,
      targetDomainRoot: bytes(0x52),
      targetCommitterSigningPrivateKey: targetSigning.privateKey,
      resolveCurrentCommitter: currentCommitter,
    });
  return { crypto, challenge, response, finish };
}

describe("v2 byte-consuming verifier fuzz corpus", () => {
  test("rejects deterministic Runtime challenge, response, and secret corruption", async () => {
    for (let seed = 1; seed <= 16; seed++) {
      const fixture = await runtimeHandoffFixture(seed);
      await expectOwnedRejection(
        () =>
          fixture.finish(
            bitFlip(fixture.challenge.challengeBytes, seed, 64),
            fixture.response,
          ),
        "Runtime challenge",
      );
      await expectOwnedRejection(
        () =>
          fixture.finish(
            fixture.challenge.challengeBytes,
            bitFlip(fixture.response, seed, 64),
          ),
        "Runtime response",
      );
      fixture.crypto.openedPlaintextTransform = (plaintext) => {
        const output = plaintext.slice();
        const metadataBytes = Math.max(1, output.length - 40);
        const offset = seed % metadataBytes;
        output[offset] = output[offset]! ^ (1 << (seed % 8));
        return output;
      };
      await expectOwnedRejection(
        () =>
          fixture.finish(
            fixture.challenge.challengeBytes,
            fixture.response,
          ),
        "Runtime secret",
      );
    }
  });

  test("rejects mutated Namespace binding and keyring verification bytes", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2259));
    const signing = crypto.generateSigningKeyPair();
    const roots = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("namespace_fuzz"),
    );
    const metadata = {
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(1),
      previousBindingHash: null,
      committerDeviceId: cryptoDeviceId("device_alice"),
    };
    const humanEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x61),
      keyring: roots.human,
      metadata,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x62),
      keyring: roots.ai,
      metadata,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope,
      aiEnvelope,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    expect(verifyNamespaceBinding({
      crypto,
      binding,
      resolveHistoricalCommitter: () => signing.publicKey,
    })).toBe(true);
    expect(verifyNamespaceKeyringEnvelope({
      crypto,
      envelope: humanEnvelope,
      resolveHistoricalCommitter: () => signing.publicKey,
    })).toBe(true);

    for (let seed = 1; seed <= 32; seed++) {
      await expectOwnedRejection(
        () =>
          verifyNamespaceBinding({
            crypto,
            binding: parseNamespaceBinding(
              bitFlip(serializeNamespaceBinding(binding), seed, 64),
            ),
            resolveHistoricalCommitter: () => signing.publicKey,
          }),
        "Namespace binding",
      );
      await expectOwnedRejection(
        () =>
          verifyNamespaceKeyringEnvelope({
            crypto,
            envelope: parseNamespaceKeyringEnvelope(
              bitFlip(
                serializeNamespaceKeyringEnvelope(humanEnvelope),
                seed,
                64,
              ),
            ),
            resolveHistoricalCommitter: () => signing.publicKey,
          }),
        "Namespace keyring",
      );
    }
  });

  test("rejects mutated object manifest-chain bytes", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2260));
    const signing = crypto.generateSigningKeyPair();
    const created = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_fuzz"),
        payloadHash: bytes(0x71),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [bytes(0x72)],
        committerDeviceId: cryptoDeviceId("device_alice"),
        hostAuthorizationRevision: authorizationRevision(0),
      },
      signing.privateKey,
    );
    const input = {
      manifestBytes: created.bytes,
      proof: [],
      trustedMinimumHead: {
        objectId: created.manifest.objectId,
        payloadHash: created.manifest.payloadHash,
        accessRevision: created.manifest.accessRevision,
        manifestHash: created.hash,
      },
      resolveSigningPublicKey: () => signing.publicKey,
    };
    expect(verifyObjectAccessManifestChainV2(crypto, input).manifestHash)
      .toEqual(created.hash);
    for (let seed = 1; seed <= 32; seed++) {
      await expectOwnedRejection(
        () =>
          verifyObjectAccessManifestChainV2(crypto, {
            ...input,
            manifestBytes: bitFlip(created.bytes, seed, 64),
          }),
        "object manifest",
      );
    }
  });

  test("rejects mutated recovery activation challenge and proof bytes", async () => {
    class RecoveryCaptureCrypto extends LatticeCrypto {
      sealedPlaintext: Uint8Array | null = null;
      override async sealTo(
        publicKey: Uint8Array,
        plaintext: Uint8Array,
      ): Promise<Uint8Array> {
        this.sealedPlaintext = plaintext.slice();
        return super.sealTo(publicKey, plaintext);
      }
    }
    const crypto = new RecoveryCaptureCrypto(seededRng(0x2261));
    const recovery = await crypto.generateEncryptionKeyPair();
    const deviceEncryption = await crypto.generateEncryptionKeyPair();
    const deviceSigning = crypto.generateSigningKeyPair();
    const pending = {
      humanId: humanId("alice"),
      deviceId: cryptoDeviceId("device_new"),
      pendingDeviceRevision: pendingDeviceRevision(1),
      encryptionPublicKey: deviceEncryption.publicKey,
      signingPublicKey: deviceSigning.publicKey,
    };
    const inventoryRevision = deviceTransferInventoryRevision(1);
    const inventoryDigest = bytes(0x81);
    const recoveryArchiveDigest = bytes(0x82);
    const trustedPending = {
      humanId: pending.humanId,
      deviceId: pending.deviceId,
      pendingDeviceRevision: pending.pendingDeviceRevision,
      encryptionPublicKeyDigest: sha256(pending.encryptionPublicKey),
      signingPublicKeyDigest: sha256(pending.signingPublicKey),
      status: "pending" as const,
    };
    const trustedRecovery = {
      humanId: pending.humanId,
      recoveryKeyId: "recovery_key_1",
      recoveryGeneration: recoveryKeyGeneration(1),
      publicKeyDigest: recoveryPublicKeyDigest(recovery.publicKey),
    };
    const prepared = await prepareRecoveryDeviceActivationChallengeV2({
      crypto,
      challengeId: "challenge_fuzz",
      pendingDevice: pending,
      resolveTrustedPendingDevice: () => trustedPending,
      recoveryKeyId: trustedRecovery.recoveryKeyId,
      recoveryGeneration: trustedRecovery.recoveryGeneration,
      recoveryPublicKey: recovery.publicKey,
      resolveTrustedCurrentRecoveryKey: () => trustedRecovery,
      recoveryArchiveDigest,
      inventoryRevision,
      resolveTrustedInventoryCommitment: () => ({
        humanId: pending.humanId,
        inventoryRevision,
        inventoryCount: 1,
        inventoryDigest,
      }),
      issuedAt: unixTimestamp(1_000),
      expiresAt: unixTimestamp(2_000),
    });
    if (crypto.sealedPlaintext === null) {
      throw new Error("recovery activation fixture did not capture a secret");
    }
    const response = crypto.sealedPlaintext.slice(-32);
    const proofBytes = serializeRecoveryDeviceActivationProof({
      formatVersion: 2,
      challengeHash: prepared.verifier.challengeHash,
      readinessDigest: recoveryReadinessDigest(
        recoveryArchiveDigest,
        {
          humanId: pending.humanId,
          inventoryRevision,
          inventoryCount: 1,
          inventoryDigest,
        },
      ),
      response,
    });
    const verify = (challengeBytes: Uint8Array, candidateProof: Uint8Array) =>
      verifyRecoveryDeviceActivationProofV2({
        challengeBytes,
        proofBytes: candidateProof,
        resolveTrustedChallenge: () => prepared.verifier,
        pendingDevice: pending,
        resolveTrustedPendingDevice: () => trustedPending,
        resolveTrustedCurrentRecoveryKey: () => trustedRecovery,
        currentTime: unixTimestamp(1_500),
      });
    expect(verify(prepared.challengeBytes, proofBytes).activationCas)
      .toMatchObject({ intendedChallengeStatus: "consumed" });
    for (let seed = 1; seed <= 32; seed++) {
      await expectOwnedRejection(
        () => verify(bitFlip(prepared.challengeBytes, seed, 48), proofBytes),
        "recovery activation challenge",
      );
      await expectOwnedRejection(
        () => verify(prepared.challengeBytes, bitFlip(proofBytes, seed, 32)),
        "recovery activation proof",
      );
    }
    console.log(JSON.stringify({
      lane: "lattice-v2-fuzz",
      corpus: "byte-consuming-verifiers",
      seedRanges: {
        "runtime-handoff": "1-16",
        "namespace-and-keyring": "1-32",
        "manifest-chain": "1-32",
        "recovery-activation": "1-32",
      },
    }));
  });
});
