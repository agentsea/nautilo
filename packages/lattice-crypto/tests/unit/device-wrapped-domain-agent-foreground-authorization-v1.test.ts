import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS,
  createDeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
  mintDeviceWrappedDomainAgentForegroundAuthorizationV1,
  parseDeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
  parseDeviceWrappedDomainAgentForegroundAuthorizationV1,
  serializeDeviceWrappedDomainAgentForegroundAuthorizationPlanV1,
  serializeDeviceWrappedDomainAgentForegroundAuthorizationSecretV1,
  serializeDeviceWrappedDomainAgentForegroundAuthorizationV1,
  withOpenedDeviceWrappedDomainAgentForegroundAuthorizationV1,
  type DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1,
  type DeviceWrappedDomainAgentForegroundAuthorizationCurrentAuthorityV1,
  type DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1,
} from "../../src/format/device-wrapped-domain-agent-foreground-authorization-v1.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function authority(
  grantDomainId: string,
  byte: number,
): DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1 {
  return {
    grantDomainId,
    participantDigest: bytes(byte),
    domainKeyGeneration: 3,
    headDigest: bytes(byte + 1),
    publicationDigest: bytes(byte + 2),
    publicationAuthorizationRevision: authorizationRevision(4),
    authorizationRevision: authorizationRevision(7),
    activeNamespaceBindingSetDigest: bytes(byte + 3),
    activeNamespaceBindingCount: 140,
  };
}

function secret(
  value: DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1,
  byte: number,
): DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1 {
  return {
    grantDomainId: value.grantDomainId,
    domainKeyGeneration: value.domainKeyGeneration,
    participantDigest: value.participantDigest,
    headDigest: value.headDigest,
    authorizationRevision: value.authorizationRevision,
    domainAiGrantKey: bytes(byte),
  };
}

async function fixture(deadlineAt = NOW + 5 * 60_000) {
  const crypto = new LatticeCrypto(seededRng(294_101), { now: () => NOW });
  const signer = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x51));
  const domains = [
    authority("grant-domain:alpha", 0x11),
    authority("grant-domain:beta", 0x21),
  ] as const;
  const plan = createDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
    crypto,
    {
      authorizationId: "foreground-authorization:alpha",
      policyRevision: 12,
      sessionId: "session:alpha",
      roomId: "room:alpha",
      subjectHumanId: humanId("human:alpha"),
      committerDeviceId: cryptoDeviceId("device:browser:alpha"),
      committerDeviceSigningGeneration: 2,
      hostAuthorizationRevision: authorizationRevision(4),
      recipientAgentId: agentId("agent:alpha"),
      agentAuthorizationRevision: authorizationRevision(6),
      agentRuntimeGeneration: 3,
      recipientKeyId: "foreground-recipient:alpha",
      operations: ["decrypt", "encrypt"],
      issuedAt: NOW,
      deadlineAt,
      maximumSecretBytes: 256 * 1024,
      domains,
    },
  );
  const secrets = [secret(domains[0], 0xa1), secret(domains[1], 0xb1)];
  const authorization =
    await mintDeviceWrappedDomainAgentForegroundAuthorizationV1(crypto, {
      plan,
      domains: secrets,
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
  const current: DeviceWrappedDomainAgentForegroundAuthorizationCurrentAuthorityV1 = {
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
    recipientAgentId: plan.recipientAgentId,
    agentAuthorizationRevision: plan.agentAuthorizationRevision,
    agentRuntimeGeneration: plan.agentRuntimeGeneration,
    recipientKeyId: plan.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    agentAuthorized: true,
    domains,
  };
  return { crypto, signer, recipient, domains, plan, secrets, authorization, current };
}

describe("M294 device-wrapped Domain Agent foreground authorization V1", () => {
  test("opens an exact multi-Domain session authorization and wipes callback keys", async () => {
    const value = await fixture();
    const authorizationBytes =
      serializeDeviceWrappedDomainAgentForegroundAuthorizationV1(
        value.authorization,
      );
    expect(Buffer.from(authorizationBytes).includes(
      Buffer.from(value.secrets[0]!.domainAiGrantKey),
    )).toBeFalse();
    let retainedKey: Uint8Array | undefined;
    expect(await withOpenedDeviceWrappedDomainAgentForegroundAuthorizationV1(
      value.crypto,
      {
        authorizationBytes,
        now: NOW + 1,
        current: value.current,
        operation(domains) {
          expect(domains).toHaveLength(2);
          retainedKey = domains[0]!.domainAiGrantKey;
          return "opened";
        },
      },
    )).toEqual({ status: "opened", value: "opened" });
    expect(retainedKey).toEqual(new Uint8Array(32));
  });

  test("pins independent canonical bytes and the two-hour protocol ceiling", async () => {
    const value = await fixture(
      NOW + DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS,
    );
    const planBytes =
      serializeDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(value.plan);
    const authorizationBytes =
      serializeDeviceWrappedDomainAgentForegroundAuthorizationV1(
        value.authorization,
      );
    expect(Buffer.from(value.crypto.hash(planBytes)).toString("hex"))
      .toBe("1414dc9b08e48ed0b04b17c2f005c6063bb181c8d0025dd05d6855c7c5c00009");
    const secretBytes =
      serializeDeviceWrappedDomainAgentForegroundAuthorizationSecretV1({
        formatVersion: 1,
        purpose:
          "device_wrapped_grant_domain.agent_foreground_authorization_secret",
        authorizationId: value.plan.authorizationId,
        sessionId: value.plan.sessionId,
        roomId: value.plan.roomId,
        subjectHumanId: value.plan.subjectHumanId,
        committerDeviceId: value.plan.committerDeviceId,
        recipientAgentId: value.plan.recipientAgentId,
        agentRuntimeGeneration: value.plan.agentRuntimeGeneration,
        recipientKeyId: value.plan.recipientKeyId,
        domainAuthoritySetDigest: value.plan.domainAuthoritySetDigest,
        domainCount: value.secrets.length,
        domains: value.secrets,
      });
    expect(Buffer.from(value.crypto.hash(secretBytes)).toString("hex"))
      .toBe("4eab3ffea550ccfc0b7d080217c2c06e13702e4f8c8095d5e1fa4b1090402f57");
    const decodedAuthorization =
      parseDeviceWrappedDomainAgentForegroundAuthorizationV1(authorizationBytes);
    expect(decodedAuthorization).not.toBeNull();
    expect(serializeDeviceWrappedDomainAgentForegroundAuthorizationV1(
      decodedAuthorization!,
    )).toEqual(authorizationBytes);
    expect(parseDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(planBytes))
      .not.toBeNull();
    expect(() => createDeviceWrappedDomainAgentForegroundAuthorizationPlanV1(
      value.crypto,
      {
        authorizationId: value.plan.authorizationId,
        policyRevision: value.plan.policyRevision,
        sessionId: value.plan.sessionId,
        roomId: value.plan.roomId,
        subjectHumanId: value.plan.subjectHumanId,
        committerDeviceId: value.plan.committerDeviceId,
        committerDeviceSigningGeneration:
          value.plan.committerDeviceSigningGeneration,
        hostAuthorizationRevision: value.plan.hostAuthorizationRevision,
        recipientAgentId: value.plan.recipientAgentId,
        agentAuthorizationRevision: value.plan.agentAuthorizationRevision,
        agentRuntimeGeneration: value.plan.agentRuntimeGeneration,
        recipientKeyId: value.plan.recipientKeyId,
        operations: ["decrypt", "encrypt"],
        issuedAt: NOW,
        deadlineAt:
          NOW
          + DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS
          + 1,
        maximumSecretBytes: value.plan.maximumSecretBytes,
        domains: value.domains,
      },
    )).toThrow(/deadline/i);
  });

  test("fails closed for substituted current authority and malformed bytes", async () => {
    const value = await fixture();
    const authorizationBytes =
      serializeDeviceWrappedDomainAgentForegroundAuthorizationV1(
        value.authorization,
      );
    for (const current of [
      { ...value.current, authorizationId: "foreground-authorization:other" },
      { ...value.current, roomId: "room:other" },
      { ...value.current, agentRuntimeGeneration: 4 },
      { ...value.current, committerDeviceActive: false },
      { ...value.current, agentAuthorized: false },
      {
        ...value.current,
        domains: [{
          ...value.domains[0],
          activeNamespaceBindingSetDigest: bytes(0xee),
        }, value.domains[1]],
      },
    ]) {
      expect(await withOpenedDeviceWrappedDomainAgentForegroundAuthorizationV1(
        value.crypto,
        {
          authorizationBytes,
          now: NOW + 1,
          current,
          operation: () => "unreachable",
        },
      )).toEqual({ status: "unavailable", reason: "authority_stale" });
    }
    expect(parseDeviceWrappedDomainAgentForegroundAuthorizationV1(
      authorizationBytes.subarray(0, authorizationBytes.length - 1),
    )).toBeNull();
    expect(parseDeviceWrappedDomainAgentForegroundAuthorizationV1(
      new Uint8Array([...authorizationBytes, 0]),
    )).toBeNull();
    const wrongRecipient = await value.crypto.deriveEncryptionKeyPair(bytes(0x91));
    expect(await withOpenedDeviceWrappedDomainAgentForegroundAuthorizationV1(
      value.crypto,
      {
        authorizationBytes,
        now: NOW + 1,
        current: {
          ...value.current,
          recipientEncryptionPrivateKey: wrongRecipient.privateKey,
        },
        operation: () => "unreachable",
      },
    )).toEqual({ status: "unavailable", reason: "secret_unavailable" });
  });
});
