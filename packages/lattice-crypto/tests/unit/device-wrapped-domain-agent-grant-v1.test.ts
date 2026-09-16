import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS,
  createDeviceWrappedDomainAgentGrantPlanV1,
  deviceWrappedDomainAgentGrantAuthoritySetDigestV1,
  mintDeviceWrappedDomainAgentGrantV1,
  parseDeviceWrappedDomainAgentGrantPlanV1,
  serializeDeviceWrappedDomainAgentGrantV1,
  serializeDeviceWrappedDomainAgentGrantPlanV1,
  serializeDeviceWrappedDomainAgentGrantSecretV1,
  withOpenedDeviceWrappedDomainAgentGrantV1,
  type DeviceWrappedDomainAgentGrantAuthorityEntryV1,
  type DeviceWrappedDomainAgentGrantPlanV1,
  type DeviceWrappedDomainAgentGrantSecretEntryV1,
} from "../../src/format/device-wrapped-domain-agent-grant-v1.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  grantId,
  humanId,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

function authority(
  grantDomainId: string,
  bindingCount: number,
  byte: number,
): DeviceWrappedDomainAgentGrantAuthorityEntryV1 {
  return {
    grantDomainId,
    participantDigest: new Uint8Array(32).fill(byte),
    domainKeyGeneration: 3,
    headDigest: new Uint8Array(32).fill(byte + 1),
    publicationDigest: new Uint8Array(32).fill(byte + 2),
    publicationAuthorizationRevision: authorizationRevision(1),
    authorizationRevision: authorizationRevision(7),
    activeNamespaceBindingSetDigest: new Uint8Array(32).fill(byte + 3),
    activeNamespaceBindingCount: bindingCount,
  };
}

function secret(
  value: DeviceWrappedDomainAgentGrantAuthorityEntryV1,
  keyByte: number,
): DeviceWrappedDomainAgentGrantSecretEntryV1 {
  return {
    grantDomainId: value.grantDomainId,
    domainKeyGeneration: value.domainKeyGeneration,
    participantDigest: value.participantDigest,
    headDigest: value.headDigest,
    authorizationRevision: value.authorizationRevision,
    domainAiGrantKey: new Uint8Array(32).fill(keyByte),
  };
}

function plan(
  crypto: LatticeCrypto,
  domains: readonly DeviceWrappedDomainAgentGrantAuthorityEntryV1[],
): DeviceWrappedDomainAgentGrantPlanV1 {
  return createDeviceWrappedDomainAgentGrantPlanV1(crypto, {
    operationId: "operation:live-turn:alpha",
    policyRevision: 12,
    sessionId: "session:alpha",
    roomId: "room:alpha",
    subjectHumanId: humanId("human:alpha"),
    committerDeviceId: cryptoDeviceId("device:alpha"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(4),
    recipientAgentId: agentId("agent:alpha"),
    recipientKeyId: "invocation-key:alpha",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    maximumSecretBytes: 256 * 1024,
    domains,
  });
}

describe("M291 device-wrapped Domain Agent Grant V1", () => {
  test("compresses 300 Namespace bindings into two Domain keys and wipes callback keys", async () => {
    const crypto = new LatticeCrypto(seededRng(291_301));
    const signer = crypto.generateSigningKeyPair();
    const recipient = await crypto.deriveEncryptionKeyPair(
      new Uint8Array(32).fill(0x71),
    );
    const domains = [
      authority("grant-domain:alpha", 200, 0x11),
      authority("grant-domain:alpha-beta", 100, 0x21),
    ] as const;
    const secrets = [secret(domains[0], 0xa1), secret(domains[1], 0xb1)] as const;
    const selectedPlan = plan(crypto, domains);
    const grant = await mintDeviceWrappedDomainAgentGrantV1(crypto, {
      grantId: grantId("grant:alpha"),
      plan: selectedPlan,
      domains: secrets,
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });

    expect(grant.domainCount).toBe(2);
    expect(selectedPlan.domains.reduce(
      (sum, entry) => sum + entry.activeNamespaceBindingCount,
      0,
    )).toBe(300);
    expect(Buffer.from(grant.encryptedSecret).includes(Buffer.from(secrets[0].domainAiGrantKey)))
      .toBeFalse();

    let retainedKey: Uint8Array | undefined;
    const opened = await withOpenedDeviceWrappedDomainAgentGrantV1(crypto, {
      grantBytes: serializeDeviceWrappedDomainAgentGrantV1(grant),
      now: NOW + 1,
      current: {
        operationId: selectedPlan.operationId,
        policyRevision: selectedPlan.policyRevision,
        sessionId: selectedPlan.sessionId,
        roomId: selectedPlan.roomId,
        subjectHumanId: selectedPlan.subjectHumanId,
        committerDeviceId: selectedPlan.committerDeviceId,
        committerDeviceSigningGeneration:
          selectedPlan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey: signer.publicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: selectedPlan.hostAuthorizationRevision,
        recipientAgentId: selectedPlan.recipientAgentId,
        recipientKeyId: selectedPlan.recipientKeyId,
        recipientEncryptionPrivateKey: recipient.privateKey,
        agentAuthorized: true,
        hostAllowsOperation: true,
        operation: "decrypt",
        domains,
      },
      operation(openedDomains) {
        expect(openedDomains).toHaveLength(2);
        expect(openedDomains[1]?.domainAiGrantKey).toEqual(
          secrets[1].domainAiGrantKey,
        );
        retainedKey = openedDomains[0]?.domainAiGrantKey;
        return "opened";
      },
    });
    expect(opened).toEqual({ status: "opened", value: "opened" });
    expect(retainedKey).toEqual(new Uint8Array(32));
  });

  test("rejects omission, addition, reorder, stale binding sets, and 257 distinct Domains", async () => {
    const crypto = new LatticeCrypto(seededRng(291_302));
    const signer = crypto.generateSigningKeyPair();
    const recipient = await crypto.deriveEncryptionKeyPair(
      new Uint8Array(32).fill(0x72),
    );
    const domains = [
      authority("grant-domain:alpha", 257, 0x11),
      authority("grant-domain:beta", 1, 0x21),
    ] as const;
    const selectedPlan = plan(crypto, domains);
    expect(mintDeviceWrappedDomainAgentGrantV1(crypto, {
      grantId: grantId("grant:missing"),
      plan: selectedPlan,
      domains: [secret(domains[0], 0xa1)],
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    })).rejects.toThrow("exact planned Domain set");
    expect(() => serializeDeviceWrappedDomainAgentGrantPlanV1({
      ...selectedPlan,
      domains: [...domains].reverse(),
    })).toThrow("canonical and unique");
    expect(() => serializeDeviceWrappedDomainAgentGrantPlanV1({
      ...selectedPlan,
      domains: [domains[0], domains[0]],
    })).toThrow("canonical and unique");

    const distinct257 = Array.from(
      { length: DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS + 1 },
      (_, index) => authority(
        `grant-domain:${index.toString().padStart(3, "0")}`,
        1,
        (index % 200) + 1,
      ),
    );
    expect(() => deviceWrappedDomainAgentGrantAuthoritySetDigestV1(
      crypto,
      distinct257,
    )).toThrow("Domain count is invalid");

    const grant = await mintDeviceWrappedDomainAgentGrantV1(crypto, {
      grantId: grantId("grant:stale"),
      plan: selectedPlan,
      domains: [secret(domains[0], 0xa1), secret(domains[1], 0xb1)],
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
    expect(await withOpenedDeviceWrappedDomainAgentGrantV1(crypto, {
      grantBytes: serializeDeviceWrappedDomainAgentGrantV1(grant),
      now: NOW + 1,
      current: {
        operationId: selectedPlan.operationId,
        policyRevision: selectedPlan.policyRevision,
        sessionId: selectedPlan.sessionId,
        roomId: selectedPlan.roomId,
        subjectHumanId: selectedPlan.subjectHumanId,
        committerDeviceId: selectedPlan.committerDeviceId,
        committerDeviceSigningGeneration:
          selectedPlan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey: signer.publicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: selectedPlan.hostAuthorizationRevision,
        recipientAgentId: selectedPlan.recipientAgentId,
        recipientKeyId: selectedPlan.recipientKeyId,
        recipientEncryptionPrivateKey: recipient.privateKey,
        agentAuthorized: true,
        hostAllowsOperation: true,
        operation: "decrypt",
        domains: [{
          ...domains[0],
          activeNamespaceBindingSetDigest: new Uint8Array(32).fill(0xff),
        }, domains[1]],
      },
      operation: () => "unreachable",
    })).toEqual({ status: "unavailable", reason: "authority_stale" });
  });

  test("pins canonical plan and secret bytes without Namespace coordinates", () => {
    const crypto = new LatticeCrypto(seededRng(291_303));
    const domains = [authority("grant-domain:alpha", 300, 0x11)];
    const selectedPlan = plan(crypto, domains);
    const planBytes = serializeDeviceWrappedDomainAgentGrantPlanV1(selectedPlan);
    const secretBytes = serializeDeviceWrappedDomainAgentGrantSecretV1({
      formatVersion: 1,
      purpose: "device_wrapped_grant_domain.agent_grant_secret",
      grantId: grantId("grant:pin"),
      operationId: selectedPlan.operationId,
      sessionId: selectedPlan.sessionId,
      roomId: selectedPlan.roomId,
      subjectHumanId: selectedPlan.subjectHumanId,
      committerDeviceId: selectedPlan.committerDeviceId,
      recipientAgentId: selectedPlan.recipientAgentId,
      recipientKeyId: selectedPlan.recipientKeyId,
      domainAuthoritySetDigest: selectedPlan.domainAuthoritySetDigest,
      domainCount: 1,
      domains: [secret(domains[0]!, 0xa1)],
    });
    expect(parseDeviceWrappedDomainAgentGrantPlanV1(planBytes)).not.toBeNull();
    expect(Buffer.from(secretBytes).includes(Buffer.from("namespace:", "utf8")))
      .toBeFalse();
    expect(Buffer.from(crypto.hash(planBytes)).toString("hex"))
      .toBe("4801ce464dfd5f4c3bc2f5f85b3815edc31ab6014457048a649469982273934d");
    expect(Buffer.from(crypto.hash(secretBytes)).toString("hex"))
      .toBe("2d83a5913718f8fd50a60790fc06b0018afc8d73ae63285cd9372eddaf42ae21");
  });
});
