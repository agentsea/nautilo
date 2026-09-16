import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  destroyDomainNamespaceBundleBindingV2,
  domainNamespaceGenerationHeadDigestV2,
  domainNamespaceRetainedAuthoritySetDigestV2,
  prepareDomainNamespaceBundleV2,
  verifyDomainNamespaceBundleBindingV2,
  withOpenedDomainNamespaceBundleV2,
  type DomainNamespaceBundleV2,
  type DomainNamespaceRetainedGenerationV2,
} from "../../src/format/domain-namespace-bundle-v2.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceGeneration,
  namespaceId,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

function retained(): readonly DomainNamespaceRetainedGenerationV2[] {
  return [1, 2].map((generation) => Object.freeze({
    generation: namespaceGeneration(generation),
    accessRevision: accessRevision(3),
    headDigest: new Uint8Array(32).fill(0x40 + generation),
    generationKey: new Uint8Array(32).fill(0x50 + generation),
  }));
}

function bundle(
  crypto: LatticeCrypto,
  keyClass: "human" | "ai",
): DomainNamespaceBundleV2 {
  const generations = retained();
  return Object.freeze({
    formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
    purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
    serverId: "server:alpha",
    cryptoDomainId: cryptoDomainId("domain:alpha-beta"),
    participantDigest: new Uint8Array(32).fill(0x31),
    participantCount: 2,
    keyClass,
    domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(5),
    domainHeadDigest: new Uint8Array(32).fill(0x32),
    namespaceId: namespaceId("namespace:room:alpha-beta"),
    namespaceAccessRevision: accessRevision(3),
    namespaceCurrentGeneration: namespaceGeneration(2),
    bundleRevision: 7,
    retainedGenerationCount: generations.length,
    retainedAuthoritySetDigest: domainNamespaceRetainedAuthoritySetDigestV2(
      crypto,
      generations,
    ),
    retainedGenerations: generations,
  });
}

describe("M301 class-neutral Domain Namespace bundle V2", () => {
  test("commits native generations to their complete coordinates and predecessor", () => {
    const crypto = new LatticeCrypto(seededRng(306_001));
    const key = new Uint8Array(32).fill(0x61);
    const first = domainNamespaceGenerationHeadDigestV2(crypto, {
      serverId: "server:alpha",
      namespaceId: namespaceId("namespace:room:alpha-beta"),
      keyClass: "human",
      accessRevision: accessRevision(3),
      generation: namespaceGeneration(0),
      previousHeadDigest: null,
      generationKey: key,
    });
    const replay = domainNamespaceGenerationHeadDigestV2(crypto, {
      serverId: "server:alpha",
      namespaceId: namespaceId("namespace:room:alpha-beta"),
      keyClass: "human",
      accessRevision: accessRevision(3),
      generation: namespaceGeneration(0),
      previousHeadDigest: null,
      generationKey: key,
    });
    const next = domainNamespaceGenerationHeadDigestV2(crypto, {
      serverId: "server:alpha",
      namespaceId: namespaceId("namespace:room:alpha-beta"),
      keyClass: "human",
      accessRevision: accessRevision(4),
      generation: namespaceGeneration(1),
      previousHeadDigest: first,
      generationKey: key,
    });
    const substituted = domainNamespaceGenerationHeadDigestV2(crypto, {
      serverId: "server:alpha",
      namespaceId: namespaceId("namespace:room:other"),
      keyClass: "human",
      accessRevision: accessRevision(3),
      generation: namespaceGeneration(0),
      previousHeadDigest: null,
      generationKey: key,
    });
    expect(replay).toEqual(first);
    expect(next).not.toEqual(first);
    expect(substituted).not.toEqual(first);
    key.fill(0);
    first.fill(0);
    replay.fill(0);
    next.fill(0);
    substituted.fill(0);
  });

  test.each(["human", "ai"] as const)(
    "seals and opens %s Namespace generations through its Domain key",
    async (keyClass) => {
      const crypto = new LatticeCrypto(seededRng(keyClass === "human" ? 301_401 : 301_402));
      const signer = crypto.generateSigningKeyPair();
      const domainKey = new Uint8Array(32).fill(keyClass === "human" ? 0x61 : 0x62);
      const inputBundle = bundle(crypto, keyClass);
      const prepared = prepareDomainNamespaceBundleV2(crypto, {
        operationId: `operation:bundle:${keyClass}:7`,
        bundle: inputBundle,
        previousBindingDigest: null,
        issuerHumanId: humanId("human:alpha"),
        issuerDeviceId: cryptoDeviceId("device:alpha"),
        issuerDeviceSigningGeneration: 1,
        issuerSigningPrivateKey: signer.privateKey,
        issuerSigningPublicKey: signer.publicKey,
        domainKey,
        issuedAt: NOW,
      });
      const verified = verifyDomainNamespaceBundleBindingV2(crypto, {
        bindingBytes: prepared.bytes,
        expectedBindingDigest: prepared.bindingDigest,
        issuerSigningPublicKey: signer.publicKey,
      });
      expect(verified?.keyClass).toBe(keyClass);
      if (verified) destroyDomainNamespaceBundleBindingV2(verified);
      const substituted = prepared.bytes.slice();
      const finalByteIndex = substituted.length - 1;
      substituted[finalByteIndex] = (substituted[finalByteIndex] ?? 0) ^ 1;
      expect(verifyDomainNamespaceBundleBindingV2(crypto, {
        bindingBytes: substituted,
        issuerSigningPublicKey: signer.publicKey,
      })).toBeNull();
      substituted.fill(0);
      let callbackKey: Uint8Array | undefined;
      const opened = await withOpenedDomainNamespaceBundleV2(crypto, {
        bindingBytes: prepared.bytes,
        expectedBindingDigest: prepared.bindingDigest,
        issuerSigningPublicKey: signer.publicKey,
        domainKey,
        current: {
          serverId: inputBundle.serverId,
          cryptoDomainId: inputBundle.cryptoDomainId,
          participantDigest: inputBundle.participantDigest,
          participantCount: inputBundle.participantCount,
          keyClass,
          domainKeyGeneration: inputBundle.domainKeyGeneration,
          domainAuthorizationRevision: inputBundle.domainAuthorizationRevision,
          domainHeadDigest: inputBundle.domainHeadDigest,
          namespaceId: inputBundle.namespaceId,
          namespaceAccessRevision: inputBundle.namespaceAccessRevision,
          namespaceCurrentGeneration: inputBundle.namespaceCurrentGeneration,
          bundleRevision: inputBundle.bundleRevision,
          retainedAuthoritySetDigest: inputBundle.retainedAuthoritySetDigest,
        },
        operation: (generations) => {
          callbackKey = generations[1]!.generationKey;
          expect(generations.map((value) => Number(value.generation))).toEqual([1, 2]);
          return generations[1]!.generationKey.slice();
        },
      });
      expect(opened.status).toBe("opened");
      if (opened.status === "opened") {
        expect(opened.value).toEqual(new Uint8Array(32).fill(0x52));
        opened.value.fill(0);
      }
      expect(callbackKey).toEqual(new Uint8Array(32));
      destroyDomainNamespaceBundleBindingV2(prepared.binding);
      prepared.bytes.fill(0);
      prepared.bindingDigest.fill(0);
      prepared.plaintextDigest.fill(0);
    },
  );

  test("rejects cross-class and stale-head substitution", async () => {
    const crypto = new LatticeCrypto(seededRng(301_403));
    const signer = crypto.generateSigningKeyPair();
    const humanBundle = bundle(crypto, "human");
    const domainKey = new Uint8Array(32).fill(0x63);
    const prepared = prepareDomainNamespaceBundleV2(crypto, {
      operationId: "operation:bundle:human:7",
      bundle: humanBundle,
      previousBindingDigest: null,
      issuerHumanId: humanId("human:alpha"),
      issuerDeviceId: cryptoDeviceId("device:alpha"),
      issuerDeviceSigningGeneration: 1,
      issuerSigningPrivateKey: signer.privateKey,
      issuerSigningPublicKey: signer.publicKey,
      domainKey,
      issuedAt: NOW,
    });
    const result = await withOpenedDomainNamespaceBundleV2(crypto, {
      bindingBytes: prepared.bytes,
      issuerSigningPublicKey: signer.publicKey,
      domainKey,
      current: {
        serverId: humanBundle.serverId,
        cryptoDomainId: humanBundle.cryptoDomainId,
        participantDigest: humanBundle.participantDigest,
        participantCount: humanBundle.participantCount,
        keyClass: "ai",
        domainKeyGeneration: humanBundle.domainKeyGeneration,
        domainAuthorizationRevision: humanBundle.domainAuthorizationRevision,
        domainHeadDigest: new Uint8Array(32).fill(0x99),
        namespaceId: humanBundle.namespaceId,
        namespaceAccessRevision: humanBundle.namespaceAccessRevision,
        namespaceCurrentGeneration: humanBundle.namespaceCurrentGeneration,
        bundleRevision: humanBundle.bundleRevision,
        retainedAuthoritySetDigest: humanBundle.retainedAuthoritySetDigest,
      },
      operation: () => {
        throw new Error("must not open");
      },
    });
    expect(result).toEqual({ status: "unavailable", reason: "authority_stale" });
  });
});
