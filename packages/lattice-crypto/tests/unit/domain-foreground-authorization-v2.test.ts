import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  domainForegroundNamespaceBindingSetDigestV2,
  mintDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
  withOpenedDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorityEntryV2,
  type DomainForegroundAuthorizationCurrentAuthorityV2,
  type DomainForegroundSecretEntryV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

const NOW = 1_800_200_000_000;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function maximumPortableId(prefix: string, index: number): string {
  const ordinal = String(index).padStart(5, "0");
  const padding = "x".repeat(128 - prefix.length - ordinal.length - 1);
  return `${prefix}${ordinal}:${padding}`;
}

function largeAuthority(
  count: number,
): readonly DomainForegroundAuthorityEntryV2[] {
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    Object.freeze({
      domainId: maximumPortableId("domain-v2:", index),
      sourceNamespaceId: maximumPortableId("namespace:", index),
      participantDigest: bytes(0x11),
      participantCount: 1,
      keyClass: "ai" as const,
      domainKeyGeneration: 1,
      authorizationRevision: authorizationRevision(1),
      headDigest: bytes(0x12),
      activeNamespaceBindingSetDigest: bytes(0x13),
      activeNamespaceBindingCount: 1,
    })));
}

function largePlan(
  crypto: LatticeCrypto,
  count: number,
): ReturnType<typeof createDomainForegroundAuthorizationPlanV2> {
  return createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: "authorization:capacity",
    policyRevision: 1,
    sessionId: "session:capacity",
    roomId: "room:capacity",
    subjectHumanId: humanId("human:capacity"),
    committerDeviceId: cryptoDeviceId("device:capacity"),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(1),
    recipientKind: "agent",
    recipientPrincipalId: "agent:capacity",
    recipientAuthorizationRevision: authorizationRevision(1),
    recipientRuntimeGeneration: 1,
    recipientKeyId: "recipient-key:capacity",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 5 * 60_000,
    maximumSecretBytes: V2_LIMITS.agentGrantSecretBytes,
    domains: largeAuthority(count),
  });
}

async function fixture(kind: "agent" | "runtime" = "agent") {
  const crypto = new LatticeCrypto(seededRng(301_401), { now: () => NOW });
  const signer = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x51));
  const activeNamespaceBindingSetDigest =
    domainForegroundNamespaceBindingSetDigestV2(crypto, [
      { namespaceId: "namespace:alpha", bindingDigest: bytes(0x31) },
      { namespaceId: "namespace:readable", bindingDigest: bytes(0x32) },
    ]);
  const domains: readonly DomainForegroundAuthorityEntryV2[] = Object.freeze([
    Object.freeze({
      domainId: "domain:alpha",
      sourceNamespaceId: "namespace:alpha",
      participantDigest: bytes(0x11),
      participantCount: 3,
      keyClass: "ai" as const,
      domainKeyGeneration: 2,
      authorizationRevision: authorizationRevision(4),
      headDigest: bytes(0x12),
      activeNamespaceBindingSetDigest,
      activeNamespaceBindingCount: 2,
    }),
  ]);
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: "authorization:alpha",
    policyRevision: 8,
    sessionId: "session:alpha",
    roomId: "room:alpha",
    subjectHumanId: humanId("human:alpha"),
    committerDeviceId: cryptoDeviceId("device:alpha"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: kind,
    recipientPrincipalId: kind === "agent" ? "agent:alpha" : "runtime:foreground",
    recipientAuthorizationRevision: authorizationRevision(
      kind === "agent" ? 6 : 0,
    ),
    recipientRuntimeGeneration: kind === "agent" ? 3 : 0,
    recipientKeyId: "recipient-key:alpha",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 5 * 60_000,
    maximumSecretBytes: 256 * 1024,
    domains,
  });
  const secrets: readonly DomainForegroundSecretEntryV2[] = Object.freeze([
    Object.freeze({
      domainId: domains[0]!.domainId,
      sourceNamespaceId: domains[0]!.sourceNamespaceId,
      participantDigest: domains[0]!.participantDigest,
      participantCount: domains[0]!.participantCount,
      keyClass: "ai" as const,
      domainKeyGeneration: domains[0]!.domainKeyGeneration,
      authorizationRevision: domains[0]!.authorizationRevision,
      headDigest: domains[0]!.headDigest,
      domainKey: bytes(0xa1),
    }),
  ]);
  const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
    plan,
    domains: secrets,
    committerDeviceSigningPrivateKey: signer.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const current: DomainForegroundAuthorizationCurrentAuthorityV2 = {
    authorizationId: plan.authorizationId,
    policyRevision: plan.policyRevision,
    sessionId: plan.sessionId,
    roomId: plan.roomId,
    subjectHumanId: plan.subjectHumanId,
    committerDeviceId: plan.committerDeviceId,
    committerDeviceSigningGeneration: plan.committerDeviceSigningGeneration,
    committerDeviceSigningPublicKey: signer.publicKey,
    committerDeviceActive: true,
    hostAuthorizationRevision: plan.hostAuthorizationRevision,
    recipientKind: plan.recipientKind,
    recipientPrincipalId: plan.recipientPrincipalId,
    recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
    recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
    recipientKeyId: plan.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    recipientAuthorized: true,
    domains,
  };
  return { crypto, plan, secrets, authorization, current };
}

describe("M301 V2 Domain foreground authorization", () => {
  test("roundtrips an exact decrypt-only plan while preserving existing two-operation bytes", async () => {
    const value = await fixture("runtime");
    const crypto = new LatticeCrypto();
    const signer = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const originalBytes = serializeDomainForegroundAuthorizationPlanV2(value.plan);
    const unchanged = createDomainForegroundAuthorizationPlanV2(crypto, value.plan);
    expect(serializeDomainForegroundAuthorizationPlanV2(unchanged)).toEqual(originalBytes);
    const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
      ...value.plan, operations: ["decrypt"],
    });
    const decoded = parseDomainForegroundAuthorizationPlanV2(serializeDomainForegroundAuthorizationPlanV2(plan));
    expect(decoded?.operations).toEqual(["decrypt"]);
    const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
      plan, domains: value.secrets,
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
    try {
      let legacyExecutionStarted = false;
      expect(await withOpenedDomainForegroundAuthorizationV2(crypto, {
        authorizationBytes: serializeDomainForegroundAuthorizationV2(authorization), now: NOW,
        current: { ...value.current,
          committerDeviceSigningPublicKey: signer.publicKey,
          recipientEncryptionPrivateKey: recipient.privateKey },
        operation: () => {legacyExecutionStarted = true;},
      })).toEqual({status: "unavailable", reason: "authority_stale"});
      expect(legacyExecutionStarted).toBe(false);
      expect(await withOpenedDomainForegroundAuthorizationV2(crypto, {
        authorizationBytes: serializeDomainForegroundAuthorizationV2(authorization), now: NOW,
        expectedOperations: ["decrypt"],
        current: { ...value.current,
          committerDeviceSigningPublicKey: signer.publicKey,
          recipientEncryptionPrivateKey: recipient.privateKey },
        operation: (entries) => entries.length,
      })).toEqual({ status: "opened", value: 1 });
      for (const operations of [[], ["encrypt"], ["decrypt", "decrypt"], ["encrypt", "decrypt"], ["decrypt", "unknown"]]) {
        expect(() => createDomainForegroundAuthorizationPlanV2(crypto, {
          ...value.plan, operations: operations as typeof plan.operations,
        })).toThrow();
      }
    } finally {
      signer.privateKey.fill(0);
      recipient.privateKey.fill(0);
      destroyDomainForegroundAuthorizationV2(authorization);
      destroyDomainForegroundAuthorizationPlanV2(plan);
      destroyDomainForegroundAuthorizationPlanV2(unchanged);
      if (decoded !== null) destroyDomainForegroundAuthorizationPlanV2(decoded);
    }
  });
  test("binds the same Namespace set independently of input order", () => {
    const crypto = new LatticeCrypto(seededRng(301_400));
    const alpha = { namespaceId: "namespace:alpha", bindingDigest: bytes(0x31) };
    const beta = { namespaceId: "namespace:beta", bindingDigest: bytes(0x32) };
    expect(domainForegroundNamespaceBindingSetDigestV2(crypto, [beta, alpha]))
      .toEqual(domainForegroundNamespaceBindingSetDigestV2(crypto, [alpha, beta]));
  });

  test("invalidates a grant when visibility replaces one readable Namespace inside the same Domain", async () => {
    const value = await fixture();
    const currentBindingSetDigest =
      domainForegroundNamespaceBindingSetDigestV2(value.crypto, [
        { namespaceId: "namespace:alpha", bindingDigest: bytes(0x31) },
        { namespaceId: "namespace:public", bindingDigest: bytes(0x32) },
      ]);
    expect(currentBindingSetDigest).not.toEqual(
      value.plan.domains[0]!.activeNamespaceBindingSetDigest,
    );

    const currentDomain = Object.freeze({
      ...value.current.domains[0]!,
      activeNamespaceBindingSetDigest: currentBindingSetDigest,
    });
    expect(currentDomain.domainId).toBe(value.plan.domains[0]!.domainId);
    expect(currentDomain.headDigest).toEqual(value.plan.domains[0]!.headDigest);
    expect(currentDomain.activeNamespaceBindingCount).toBe(
      value.plan.domains[0]!.activeNamespaceBindingCount,
    );
    expect(await withOpenedDomainForegroundAuthorizationV2(value.crypto, {
      authorizationBytes: serializeDomainForegroundAuthorizationV2(
        value.authorization,
      ),
      now: NOW + 1,
      current: {
        ...value.current,
        domains: Object.freeze([currentDomain]),
      },
      operation: () => "unreachable",
    })).toEqual({ status: "unavailable", reason: "authority_stale" });
  });

  test("opens one exact AI Domain grant and wipes borrowed keys", async () => {
    const value = await fixture();
    const encoded = serializeDomainForegroundAuthorizationV2(value.authorization);
    expect(Buffer.from(encoded).includes(Buffer.from(value.secrets[0]!.domainKey)))
      .toBeFalse();
    let borrowed: Uint8Array | undefined;
    expect(await withOpenedDomainForegroundAuthorizationV2(value.crypto, {
      authorizationBytes: encoded, now: NOW + 1, current: value.current,
      expectedOperations: ["decrypt"],
      operation() {throw new Error("Full grant cannot enter decrypt-only consumer");},
    })).toEqual({status: "unavailable", reason: "authority_stale"});
    expect(await withOpenedDomainForegroundAuthorizationV2(value.crypto, {
      authorizationBytes: encoded,
      now: NOW + 1,
      current: value.current,
      operation(domains) {
        borrowed = domains[0]!.domainKey;
        return domains[0]!.domainId;
      },
    })).toEqual({ status: "opened", value: "domain:alpha" });
    expect(borrowed).toEqual(new Uint8Array(32));
  });

  test("uses independent canonical V2 plan and authorization bytes", async () => {
    const value = await fixture("runtime");
    const planBytes = serializeDomainForegroundAuthorizationPlanV2(value.plan);
    const authorizationBytes = serializeDomainForegroundAuthorizationV2(
      value.authorization,
    );
    expect(parseDomainForegroundAuthorizationPlanV2(planBytes)).not.toBeNull();
    expect(parseDomainForegroundAuthorizationV2(authorizationBytes)).not.toBeNull();
    expect(parseDomainForegroundAuthorizationPlanV2(
      planBytes.subarray(0, planBytes.length - 1),
    )).toBeNull();
  });

  test("rejects recipient, class-authority, and ciphertext substitution", async () => {
    const value = await fixture();
    expect(await withOpenedDomainForegroundAuthorizationV2(value.crypto, {
      authorizationBytes: serializeDomainForegroundAuthorizationV2(
        value.authorization,
      ),
      now: NOW + 1,
      current: { ...value.current, recipientPrincipalId: "agent:other" },
      operation: () => "unreachable",
    })).toEqual({ status: "unavailable", reason: "authority_stale" });
    const encoded = serializeDomainForegroundAuthorizationV2(value.authorization);
    encoded[Math.floor(encoded.length / 2)]! ^= 1;
    expect(await withOpenedDomainForegroundAuthorizationV2(value.crypto, {
      authorizationBytes: encoded,
      now: NOW + 1,
      current: value.current,
      operation: () => "unreachable",
    })).toEqual({ status: "unavailable", reason: "invalid" });
  });

  test("keeps representative grant sizes canonical across the raised capacity", () => {
    const crypto = new LatticeCrypto(seededRng(315_100));
    for (const count of [256, 257, 1_024, 4_096]) {
      const plan = largePlan(crypto, count);
      const encoded = serializeDomainForegroundAuthorizationPlanV2(plan);
      const parsed = parseDomainForegroundAuthorizationPlanV2(encoded);
      expect(parsed?.domainCount).toBe(count);
      if (parsed !== null) destroyDomainForegroundAuthorizationPlanV2(parsed);
      destroyDomainForegroundAuthorizationPlanV2(plan);
      encoded.fill(0);
    }
  });

  test("mints, parses, and opens exactly 16,384 maximum-size Domain entries", async () => {
    const crypto = new LatticeCrypto(seededRng(315_101), { now: () => NOW });
    const signer = crypto.generateSigningKeyPair();
    const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x51));
    const domains = largeAuthority(V2_LIMITS.agentGrantDomains);
    const plan = largePlan(crypto, domains.length);
    const secrets: readonly DomainForegroundSecretEntryV2[] = Object.freeze(
      domains.map((domain) => Object.freeze({
        domainId: domain.domainId,
        sourceNamespaceId: domain.sourceNamespaceId,
        participantDigest: domain.participantDigest,
        participantCount: domain.participantCount,
        keyClass: "ai" as const,
        domainKeyGeneration: domain.domainKeyGeneration,
        authorizationRevision: domain.authorizationRevision,
        headDigest: domain.headDigest,
        domainKey: bytes(0xa1),
      })),
    );
    const planBytes = serializeDomainForegroundAuthorizationPlanV2(plan);
    expect(planBytes.length).toBeLessThanOrEqual(V2_LIMITS.agentGrantPlanBytes);
    const authorization = await mintDomainForegroundAuthorizationV2(crypto, {
      plan,
      domains: secrets,
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
    const authorizationBytes = serializeDomainForegroundAuthorizationV2(
      authorization,
    );
    expect(authorizationBytes.length)
      .toBeLessThanOrEqual(V2_LIMITS.agentGrantWireBytes);
    const parsed = parseDomainForegroundAuthorizationV2(authorizationBytes);
    expect(parsed?.domainCount).toBe(V2_LIMITS.agentGrantDomains);
    if (parsed !== null) destroyDomainForegroundAuthorizationV2(parsed);
    expect(await withOpenedDomainForegroundAuthorizationV2(crypto, {
      authorizationBytes,
      now: NOW + 1,
      current: {
        authorizationId: plan.authorizationId,
        policyRevision: plan.policyRevision,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        subjectHumanId: plan.subjectHumanId,
        committerDeviceId: plan.committerDeviceId,
        committerDeviceSigningGeneration:
          plan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey: signer.publicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        recipientKind: plan.recipientKind,
        recipientPrincipalId: plan.recipientPrincipalId,
        recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
        recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
        recipientKeyId: plan.recipientKeyId,
        recipientEncryptionPrivateKey: recipient.privateKey,
        recipientAuthorized: true,
        domains,
      },
      operation(opened) {
        return Object.freeze({
          count: opened.length,
          lastDomainId: opened.at(-1)?.domainId,
        });
      },
    })).toEqual({
      status: "opened",
      value: {
        count: V2_LIMITS.agentGrantDomains,
        lastDomainId: domains.at(-1)?.domainId,
      },
    });
    destroyDomainForegroundAuthorizationV2(authorization);
    destroyDomainForegroundAuthorizationPlanV2(plan);
    planBytes.fill(0);
    authorizationBytes.fill(0);
  });

  test("rejects the 16,385th Domain before serialization or cryptography", () => {
    const crypto = new LatticeCrypto(seededRng(315_102));
    expect(() => largePlan(crypto, V2_LIMITS.agentGrantDomains + 1))
      .toThrow(`Foreground Domain set exceeds the ${V2_LIMITS.agentGrantDomains} limit`);
  });
});
