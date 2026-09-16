import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  recoveryKeyGeneration,
  recoveryPublicKeyDigest,
} from "../../src/format/recovery-v2.ts";
import {
  createNamespaceBinding,
  verifyNamespaceBindingProof,
} from "../../src/namespace/bindings.ts";
import {
  createInitialNamespaceKeyrings,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import {
  openHumanRecoveryArchiveV2,
  publishHumanRecoveryArchiveV2,
  type HumanRecoveryInventoryItemV2,
  type HumanRecoveryKeyringSourceV2,
} from "../../src/recovery/human-archive-v2.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value & 0xff);
}

function shuffled<T>(input: readonly T[], seed: number): T[] {
  const output = [...input];
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let index = output.length - 1; index > 0; index--) {
    const target = next() % (index + 1);
    [output[index], output[target]] = [
      output[target]!,
      output[index]!,
    ];
  }
  return output;
}

function replay(seed: number, error: unknown): never {
  throw new Error(
    `recovery inventory property failed; replay seed ${seed}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

describe("v2 recorded-seed recovery inventory properties", () => {
  test("publication is permutation-invariant and restore is exactly inventory-bounded", async () => {
    for (let seed = 1; seed <= 32; seed++) {
      try {
        const setupCrypto = new LatticeCrypto(seededRng(seed));
        const signing = setupCrypto.generateSigningKeyPair();
        const recoverySecret = setupCrypto.randomBytes(32);
        const recoveryKeyPair = await setupCrypto.deriveEncryptionKeyPair(
          recoverySecret,
        );
        recoverySecret.fill(0);
        const targetHumanId = humanId("human_alice");
        const recoveryGeneration = recoveryKeyGeneration(2);
        const resolveTrustedCurrentRecoveryKey = () => ({
          humanId: targetHumanId,
          recoveryKeyId: "recovery_alice",
          recoveryGeneration,
          publicKeyDigest: recoveryPublicKeyDigest(
            recoveryKeyPair.publicKey,
          ),
        });
        const issuerDeviceId = cryptoDeviceId("device_alice");
        const namespaceCount = 1 + (seed % 6);
        const sources: HumanRecoveryKeyringSourceV2[] = [];

        for (let index = 0; index < namespaceCount; index++) {
          const targetNamespaceId = namespaceId(
            `namespace_${index.toString().padStart(2, "0")}`,
          );
          const keyrings = createInitialNamespaceKeyrings(
            setupCrypto,
            targetNamespaceId,
          );
          const metadata = {
            domainId: cryptoDomainId(
              `domain_${(index % 3).toString().padStart(2, "0")}`,
            ),
            // Every Namespace sharing a current Domain must agree on its
            // authenticated current group epoch.
            domainEpoch: domainEpoch(index % 3),
            previousBindingHash: null,
            committerDeviceId: issuerDeviceId,
          };
          const humanRoot = bytes(0x20 + index);
          const aiRoot = bytes(0x80 + index);
          const humanEnvelope = sealNamespaceKeyring({
            crypto: setupCrypto,
            domainRoot: humanRoot,
            keyring: keyrings.human,
            metadata,
            committerSigningPrivateKey: signing.privateKey,
            resolveCurrentCommitter: () => signing.publicKey,
          });
          const aiEnvelope = sealNamespaceKeyring({
            crypto: setupCrypto,
            domainRoot: aiRoot,
            keyring: keyrings.ai,
            metadata,
            committerSigningPrivateKey: signing.privateKey,
            resolveCurrentCommitter: () => signing.publicKey,
          });
          const binding = createNamespaceBinding({
            crypto: setupCrypto,
            humanEnvelope,
            aiEnvelope,
            committerSigningPrivateKey: signing.privateKey,
            resolveCurrentCommitter: () => signing.publicKey,
          });
          const trustedNamespaceHead = verifyNamespaceBindingProof({
            crypto: setupCrypto,
            anchor: null,
            proof: [binding],
            resolveHistoricalCommitter: () => signing.publicKey,
          });
          sources.push(
            {
              authorizedHumanId: targetHumanId,
              trustedNamespaceHead,
              keyClass: "human",
              currentKeyringEnvelope: humanEnvelope,
              currentDomainRoot: humanRoot,
              resolveHistoricalCommitter: () => signing.publicKey,
            },
            {
              authorizedHumanId: targetHumanId,
              trustedNamespaceHead,
              keyClass: "ai",
              currentKeyringEnvelope: aiEnvelope,
              currentDomainRoot: aiRoot,
              resolveHistoricalCommitter: () => signing.publicKey,
            },
          );
        }

        const publish = (
          crypto: LatticeCrypto,
          orderedSources: readonly HumanRecoveryKeyringSourceV2[],
        ) =>
          publishHumanRecoveryArchiveV2({
            crypto,
            humanId: targetHumanId,
            recoveryKeyId: "recovery_alice",
            recoveryGeneration,
            recoveryPublicKey: recoveryKeyPair.publicKey,
            resolveTrustedCurrentRecoveryKey,
            issuerDeviceId,
            createdAt: unixTimestamp(1_700_000_000_000),
            sources: orderedSources,
            issuerSigningPrivateKey: signing.privateKey,
            resolveIssuerDevice: () => signing.publicKey,
          });
        const left = await publish(
          new LatticeCrypto(seededRng(seed ^ 0x51a7)),
          shuffled(sources, seed),
        );
        const right = await publish(
          new LatticeCrypto(seededRng(seed ^ 0x51a7)),
          shuffled(sources, seed ^ 0xa5a5_a5a5),
        );

        const leftOrder = left.archive.packages.map((item) =>
          `${item.namespaceId}:${item.keyClass}`
        );
        const rightOrder = right.archive.packages.map((item) =>
          `${item.namespaceId}:${item.keyClass}`
        );
        expect(leftOrder).toEqual(rightOrder);
        expect(left.archive.packages).toHaveLength(namespaceCount * 2);
        expect(leftOrder).toEqual([...leftOrder].sort());

        const expectedInventory: HumanRecoveryInventoryItemV2[] =
          sources.map((source) => ({
            authorizedHumanId: source.authorizedHumanId,
            trustedNamespaceHead: source.trustedNamespaceHead,
            keyClass: source.keyClass,
          }));
        const open = (archiveBytes: Uint8Array) =>
          openHumanRecoveryArchiveV2({
            crypto: setupCrypto,
            archiveBytes,
            humanId: targetHumanId,
            currentRecoveryKeyId: "recovery_alice",
            currentRecoveryGeneration: recoveryGeneration,
            recoveryPrivateKey: recoveryKeyPair.privateKey,
            resolveTrustedCurrentRecoveryKey,
            expectedInventory: shuffled(expectedInventory, seed ^ 0x9e37),
            resolveIssuerDevice: () => signing.publicKey,
          });
        const restored = await open(left.archiveBytes);
        const restoredRight = await open(right.archiveBytes);
        expect(restored).toEqual(restoredRight);
        expect(restored).toHaveLength(namespaceCount * 2);
      } catch (error) {
        replay(seed, error);
      }
    }
  }, 60_000);
});
