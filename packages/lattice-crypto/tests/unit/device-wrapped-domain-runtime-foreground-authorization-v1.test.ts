import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS,
  DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_RECIPIENT_KIND,
  createDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1,
  mintDeviceWrappedDomainRuntimeForegroundAuthorizationV1,
  parseDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1,
  parseDeviceWrappedDomainRuntimeForegroundAuthorizationV1,
  serializeDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1,
  serializeDeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1,
  serializeDeviceWrappedDomainRuntimeForegroundAuthorizationV1,
  withOpenedDeviceWrappedDomainRuntimeForegroundAuthorizationV1,
  type DeviceWrappedDomainRuntimeForegroundAuthorizationAuthorityEntryV1,
  type DeviceWrappedDomainRuntimeForegroundAuthorizationCurrentAuthorityV1,
  type DeviceWrappedDomainRuntimeForegroundAuthorizationSecretEntryV1,
} from "../../src/format/device-wrapped-domain-runtime-foreground-authorization-v1.ts";
import {
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
): DeviceWrappedDomainRuntimeForegroundAuthorizationAuthorityEntryV1 {
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
  value: DeviceWrappedDomainRuntimeForegroundAuthorizationAuthorityEntryV1,
  byte: number,
): DeviceWrappedDomainRuntimeForegroundAuthorizationSecretEntryV1 {
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
  const plan = createDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1(
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
      recipientKind:
        DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_RECIPIENT_KIND,
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
    await mintDeviceWrappedDomainRuntimeForegroundAuthorizationV1(crypto, {
      plan,
      domains: secrets,
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
  const current: DeviceWrappedDomainRuntimeForegroundAuthorizationCurrentAuthorityV1 = {
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
    recipientKeyId: plan.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    runtimeAuthorized: true,
    domains,
  };
  return { crypto, signer, recipient, domains, plan, secrets, authorization, current };
}

describe("M298 device-wrapped Domain Runtime foreground authorization V1", () => {
  test("opens an exact multi-Domain session authorization and wipes callback keys", async () => {
    const value = await fixture();
    const authorizationBytes =
      serializeDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
        value.authorization,
      );
    expect(Buffer.from(authorizationBytes).includes(
      Buffer.from(value.secrets[0]!.domainAiGrantKey),
    )).toBeFalse();
    let retainedKey: Uint8Array | undefined;
    expect(await withOpenedDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
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
      NOW + DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS,
    );
    const planBytes =
      serializeDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1(value.plan);
    const authorizationBytes =
      serializeDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
        value.authorization,
      );
    expect(Buffer.from(value.crypto.hash(planBytes)).toString("hex"))
      .toBe("ac20b4f9a9a7794af1bb57a058cda196f70e90c683bb4cad70ff1f8819b07ce3");
    const secretBytes =
      serializeDeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1({
        formatVersion: 1,
        purpose:
          "device_wrapped_grant_domain.runtime_foreground_authorization_secret",
        authorizationId: value.plan.authorizationId,
        sessionId: value.plan.sessionId,
        roomId: value.plan.roomId,
        subjectHumanId: value.plan.subjectHumanId,
        committerDeviceId: value.plan.committerDeviceId,
        recipientKind: value.plan.recipientKind,
        recipientKeyId: value.plan.recipientKeyId,
        domainAuthoritySetDigest: value.plan.domainAuthoritySetDigest,
        domainCount: value.secrets.length,
        domains: value.secrets,
      });
    expect(Buffer.from(value.crypto.hash(secretBytes)).toString("hex"))
      .toBe("0dc072e83bf7c5ae6499933798531c1e29afd21f48cadc6af0445369fee13341");
    const decodedAuthorization =
      parseDeviceWrappedDomainRuntimeForegroundAuthorizationV1(authorizationBytes);
    expect(decodedAuthorization).not.toBeNull();
    expect(serializeDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
      decodedAuthorization!,
    )).toEqual(authorizationBytes);
    expect(parseDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1(planBytes))
      .not.toBeNull();
    expect(() => createDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1(
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
        recipientKind: value.plan.recipientKind,
        recipientKeyId: value.plan.recipientKeyId,
        operations: ["decrypt", "encrypt"],
        issuedAt: NOW,
        deadlineAt:
          NOW
          + DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS
          + 1,
        maximumSecretBytes: value.plan.maximumSecretBytes,
        domains: value.domains,
      },
    )).toThrow(/deadline/i);
  });

  test("fails closed for substituted current authority and malformed bytes", async () => {
    const value = await fixture();
    const authorizationBytes =
      serializeDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
        value.authorization,
      );
    for (const current of [
      { ...value.current, authorizationId: "foreground-authorization:other" },
      { ...value.current, roomId: "room:other" },
      { ...value.current, committerDeviceActive: false },
      { ...value.current, runtimeAuthorized: false },
      {
        ...value.current,
        domains: [{
          ...value.domains[0],
          activeNamespaceBindingSetDigest: bytes(0xee),
        }, value.domains[1]],
      },
    ]) {
      expect(await withOpenedDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
        value.crypto,
        {
          authorizationBytes,
          now: NOW + 1,
          current,
          operation: () => "unreachable",
        },
      )).toEqual({ status: "unavailable", reason: "authority_stale" });
    }
    expect(parseDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
      authorizationBytes.subarray(0, authorizationBytes.length - 1),
    )).toBeNull();
    expect(parseDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
      new Uint8Array([...authorizationBytes, 0]),
    )).toBeNull();
    const wrongRecipient = await value.crypto.deriveEncryptionKeyPair(bytes(0x91));
    expect(await withOpenedDeviceWrappedDomainRuntimeForegroundAuthorizationV1(
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

  test("rejects attempts to inject an Agent addressee into Runtime bytes", async () => {
    const value = await fixture();
    expect(() =>
      serializeDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1({
        ...value.plan,
        recipientAgentId: "agent:injected",
      } as typeof value.plan)
    ).toThrow("invalid field set");
    expect(() =>
      serializeDeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1({
        formatVersion: 1,
        purpose:
          "device_wrapped_grant_domain.runtime_foreground_authorization_secret",
        authorizationId: value.plan.authorizationId,
        sessionId: value.plan.sessionId,
        roomId: value.plan.roomId,
        subjectHumanId: value.plan.subjectHumanId,
        committerDeviceId: value.plan.committerDeviceId,
        recipientKind: value.plan.recipientKind,
        recipientKeyId: value.plan.recipientKeyId,
        domainAuthoritySetDigest: value.plan.domainAuthoritySetDigest,
        domainCount: value.secrets.length,
        domains: value.secrets,
        recipientAgentId: "agent:injected",
      } as Parameters<
        typeof serializeDeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1
      >[0])
    ).toThrow("invalid field set");
  });
});
