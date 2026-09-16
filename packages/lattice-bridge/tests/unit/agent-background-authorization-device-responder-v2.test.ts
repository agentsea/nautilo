import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
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
} from "@nautilo/lattice-crypto";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
  backgroundWorkDescriptorDigestV2,
  encodeBackgroundWorkDescriptorV2,
  verifyCurrentAgentBackgroundGrantResponseV2,
  type BackgroundAgentWorkDescriptorV2,
} from "@nautilo/lattice-crypto/wire";
import {
  AGENT_BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION_V2,
  BackgroundAuthorizationDeviceResponderError,
  fulfillAgentBackgroundAuthorizationRequest,
  fulfillAgentBackgroundAuthorizationRequestV2,
  verifyCurrentBackgroundAuthorizationDeviceResponse,
  verifyCurrentAgentBackgroundAuthorizationDeviceResponseV2,
  type AgentBackgroundAuthorizationDeviceAuthorityV2,
  type AgentBackgroundAuthorizationDevicePublicAuthorityV2,
  type AgentBackgroundAuthorizationDeviceRequestV2,
} from "../../src/index.ts";

const NOW = 1_990_000_000_000;

function deterministicCrypto(seed = 1): LatticeCrypto {
  let next = seed;
  return new LatticeCrypto(
    {
      bytes: (length) => {
        const output = new Uint8Array(length);
        for (let index = 0; index < length; index += 1) {
          output[index] = next++ & 0xff;
        }
        return output;
      },
    },
    { now: () => NOW },
  );
}

async function descriptor(
  crypto: LatticeCrypto,
): Promise<BackgroundAgentWorkDescriptorV2> {
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  return {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
    requestId: "background-agent-v2-request-1",
    recipientGeneration: 4,
    workKind: "memory.review",
    workId: "memory-review-22",
    anchorNamespaceId: namespaceId("namespace-ab-1"),
    anchorDomainId: cryptoDomainId("domain-ab"),
    subject: {
      kind: "agent",
      agentId: agentId("agent-genie"),
      runtimeGeneration: agentRuntimeGeneration(7),
      authorizationRevision: authorizationRevision(101),
    },
    purpose: "memory.review",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "synthetic_payload",
      generation: 2,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    grantScope: [humanId("human-alice"), humanId("human-bob")],
    inputBindings: [
      {
        objectId: objectId("memory-input-1"),
        namespaceId: namespaceId("namespace-ab-1"),
      },
      {
        objectId: objectId("memory-input-2"),
        namespaceId: namespaceId("namespace-abc-1"),
      },
    ],
    outputSlots: [{
      objectId: objectId("memory-output-1"),
      objectType: "memory.revision",
      createdAt: unixTimestamp(NOW),
      namespaceIds: [
        namespaceId("namespace-ab-1"),
        namespaceId("namespace-ac-1"),
      ],
    }],
    namespaceRequirements: [
      {
        namespaceId: namespaceId("namespace-ab-1"),
        domainId: cryptoDomainId("domain-ab"),
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: accessRevision(11),
        expectedPolicyRevision: authorizationRevision(21),
      },
      {
        namespaceId: namespaceId("namespace-abc-1"),
        domainId: cryptoDomainId("domain-abc"),
        operations: ["decrypt"],
        expectedAccessRevision: accessRevision(12),
        expectedPolicyRevision: authorizationRevision(22),
      },
      {
        namespaceId: namespaceId("namespace-ac-1"),
        domainId: cryptoDomainId("domain-ac"),
        operations: ["encrypt"],
        expectedAccessRevision: accessRevision(13),
        expectedPolicyRevision: authorizationRevision(23),
      },
    ],
    domainRequirements: [
      {
        domainId: cryptoDomainId("domain-ab"),
        expectedEpoch: domainEpoch(31),
        expectedAgentAuthorizationRevision: authorizationRevision(41),
      },
      {
        domainId: cryptoDomainId("domain-abc"),
        expectedEpoch: domainEpoch(32),
        expectedAgentAuthorizationRevision: authorizationRevision(42),
      },
      {
        domainId: cryptoDomainId("domain-ac"),
        expectedEpoch: domainEpoch(33),
        expectedAgentAuthorizationRevision: authorizationRevision(43),
      },
    ],
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    recipientKeyId: "background-agent-recipient-4",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 5 * 60 * 1_000,
    idempotencyId: "memory-review-22-attempt-2",
  };
}

function request(
  crypto: LatticeCrypto,
  work: BackgroundAgentWorkDescriptorV2,
): AgentBackgroundAuthorizationDeviceRequestV2 {
  return {
    formatVersion:
      AGENT_BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION_V2,
    descriptorBytes: encodeBackgroundWorkDescriptorV2(work),
    descriptorHash: backgroundWorkDescriptorDigestV2(crypto, work),
  };
}

function authority(
  crypto: LatticeCrypto,
  work: BackgroundAgentWorkDescriptorV2,
): AgentBackgroundAuthorizationDeviceAuthorityV2 {
  const signer = crypto.generateSigningKeyPair();
  return {
    humanId: humanId("human-alice"),
    humanState: "active",
    deviceId: cryptoDeviceId("device-alice-browser"),
    deviceHumanId: humanId("human-alice"),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(17),
    deviceSigningPublicKey: signer.publicKey,
    deviceSigningPrivateKey: signer.privateKey,
    agentId: work.subject.agentId,
    agentState: "active",
    runtimeGeneration: work.subject.runtimeGeneration,
    agentAuthorizationRevision: work.subject.authorizationRevision,
    namespaces: work.namespaceRequirements.map((entry) => ({
      namespaceId: entry.namespaceId,
      domainId: entry.domainId,
      namespaceState: "active" as const,
      issuingHumanAccess: "authorized" as const,
      grantScopeAccess: "authorized" as const,
      authorizedOperations: entry.operations,
      namespaceAccessRevision: entry.expectedAccessRevision,
      policyRevision: entry.expectedPolicyRevision,
    })),
    domains: work.domainRequirements.map((entry, index) => ({
      domainId: entry.domainId,
      domainState: "active" as const,
      domainEpoch: entry.expectedEpoch,
      agentAuthorizationRevision:
        entry.expectedAgentAuthorizationRevision,
      aiRoot: new Uint8Array(32).fill(0x71 + index),
    })),
  };
}

function publicAuthority(
  value: AgentBackgroundAuthorizationDeviceAuthorityV2,
): AgentBackgroundAuthorizationDevicePublicAuthorityV2 {
  return {
    humanId: value.humanId,
    humanState: value.humanState,
    deviceId: value.deviceId,
    deviceHumanId: value.deviceHumanId,
    deviceState: value.deviceState,
    deviceAuthorizationRevision: value.deviceAuthorizationRevision,
    deviceSigningPublicKey: value.deviceSigningPublicKey,
    agentId: value.agentId,
    agentState: value.agentState,
    runtimeGeneration: value.runtimeGeneration,
    agentAuthorizationRevision: value.agentAuthorizationRevision,
    namespaces: value.namespaces,
    domains: value.domains.map(({ aiRoot: _aiRoot, ...domain }) => domain),
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof BackgroundAuthorizationDeviceResponderError
    ? error.code
    : undefined;
}

async function expectResponderError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`${code} unexpectedly succeeded`);
  } catch (error) {
    expect(errorCode(error)).toBe(code);
  }
}

describe("Agent v2 background-authorization device responder", () => {
  test("one current device mints one exact multi-Domain GrantV2", async () => {
    const crypto = deterministicCrypto();
    const work = await descriptor(crypto);
    const current = authority(crypto, work);
    const rootsBefore = current.domains.map((entry) =>
      Uint8Array.from(entry.aiRoot)
    );
    const privateBefore = Uint8Array.from(current.deviceSigningPrivateKey);
    let resolvedContext: Record<string, unknown> | undefined;

    const fulfillment = await fulfillAgentBackgroundAuthorizationRequestV2({
      crypto,
      request: request(crypto, work),
      resolveCurrentAuthority: (context) => {
        resolvedContext = context as unknown as Record<string, unknown>;
        return current;
      },
    });
    const verified = await verifyCurrentAgentBackgroundGrantResponseV2(
      crypto,
      {
        responseBytes: fulfillment.responseBytes,
        now: NOW,
        resolveCurrentIssuingDevicePublicKey: () =>
          current.deviceSigningPublicKey,
      },
    );

    expect(verified.grant.singleUse).toBe(true);
    expect(verified.grant.scope).toEqual(work.grantScope);
    expect(verified.grant.operations).toEqual(work.operations);
    expect(verified.grant.coveredDomains).toEqual(
      work.domainRequirements.map((entry) => ({
        domainId: entry.domainId,
        domainEpoch: entry.expectedEpoch,
        agentAuthorizationRevision:
          entry.expectedAgentAuthorizationRevision,
      })),
    );
    expect(current.domains.map((entry) => entry.aiRoot))
      .toEqual(rootsBefore);
    expect(current.deviceSigningPrivateKey).toEqual(privateBefore);
    expect("aiRoot" in fulfillment).toBe(false);
    expect("privateKey" in fulfillment).toBe(false);
    expect(resolvedContext?.["grantScope"]).toEqual(work.grantScope);
    expect(resolvedContext?.["namespaceRequirements"])
      .toEqual(work.namespaceRequirements);
    expect(resolvedContext?.["domainRequirements"])
      .toEqual(work.domainRequirements);
  });

  test("deduplicates many exact Namespaces into one covered Domain", async () => {
    const crypto = deterministicCrypto(11);
    const base = await descriptor(crypto);
    const sharedDomain = cryptoDomainId("domain-ab");
    const work: BackgroundAgentWorkDescriptorV2 = {
      ...base,
      namespaceRequirements: base.namespaceRequirements.map((entry) => ({
        ...entry,
        domainId: sharedDomain,
      })),
      domainRequirements: [{
        domainId: sharedDomain,
        expectedEpoch: domainEpoch(31),
        expectedAgentAuthorizationRevision: authorizationRevision(41),
      }],
    };
    const current = authority(crypto, work);
    const fulfillment = await fulfillAgentBackgroundAuthorizationRequestV2({
      crypto,
      request: request(crypto, work),
      resolveCurrentAuthority: () => current,
    });
    const verified = await verifyCurrentAgentBackgroundGrantResponseV2(
      crypto,
      {
        responseBytes: fulfillment.responseBytes,
        now: NOW,
        resolveCurrentIssuingDevicePublicKey: () =>
          current.deviceSigningPublicKey,
      },
    );
    expect(verified.grant.coveredDomains).toEqual([{
      domainId: sharedDomain,
      domainEpoch: domainEpoch(31),
      agentAuthorizationRevision: authorizationRevision(41),
    }]);
  });

  test("rejects partial, extra, stale, denied, and split-device authority", async () => {
    const crypto = deterministicCrypto(2);
    const work = await descriptor(crypto);
    const valid = authority(crypto, work);
    const candidates: Array<readonly [
      AgentBackgroundAuthorizationDeviceAuthorityV2,
      string,
    ]> = [
      [{ ...valid, domains: valid.domains.slice(0, 2) }, "stale_authority"],
      [{
        ...valid,
        domains: [...valid.domains, {
          ...valid.domains[0]!,
          domainId: cryptoDomainId("domain-extra"),
        }],
      }, "stale_authority"],
      [{
        ...valid,
        namespaces: valid.namespaces.map((entry, index) =>
          index === 1
            ? { ...entry, grantScopeAccess: "denied" as const }
            : entry
        ),
      }, "stale_authority"],
      [{
        ...valid,
        namespaces: valid.namespaces.map((entry, index) =>
          index === 1
            ? {
              ...entry,
              namespaceAccessRevision: accessRevision(99),
            }
            : entry
        ),
      }, "stale_authority"],
      [{
        ...valid,
        domains: valid.domains.map((entry, index) =>
          index === 1
            ? { ...entry, domainEpoch: domainEpoch(99) }
            : entry
        ),
      }, "stale_authority"],
      [{
        ...valid,
        domains: valid.domains.map((entry, index) =>
          index === 1
            ? { ...entry, aiRoot: new Uint8Array(0) }
            : entry
        ),
      }, "authority_unavailable"],
      [{ ...valid, humanState: "removed" }, "human_removed"],
      [{ ...valid, deviceState: "revoked" }, "device_revoked"],
      [{ ...valid, agentState: "disabled" }, "agent_unavailable"],
      [{
        ...valid,
        namespaces: valid.namespaces.map((entry, index) =>
          index === 1
            ? { ...entry, namespaceState: "deleted" as const }
            : entry
        ),
      }, "namespace_unavailable"],
      [{
        ...valid,
        domains: valid.domains.map((entry, index) =>
          index === 1
            ? { ...entry, domainState: "retired" as const }
            : entry
        ),
      }, "domain_unavailable"],
      [{
        ...valid,
        agentAuthorizationRevision: authorizationRevision(102),
      }, "stale_authority"],
      [{
        ...valid,
        namespaces: valid.namespaces.map((entry, index) =>
          index === 1
            ? { ...entry, policyRevision: authorizationRevision(99) }
            : entry
        ),
      }, "stale_authority"],
      [{
        ...valid,
        domains: valid.domains.map((entry, index) =>
          index === 1
            ? {
              ...entry,
              agentAuthorizationRevision: authorizationRevision(99),
            }
            : entry
        ),
      }, "stale_authority"],
    ];

    for (const [candidate, code] of candidates) {
      await expectResponderError(
        fulfillAgentBackgroundAuthorizationRequestV2({
          crypto,
          request: request(crypto, work),
          resolveCurrentAuthority: () => candidate,
        }),
        code,
      );
    }
  });

  test("re-verifies complete current public authority and returns no roots", async () => {
    const crypto = deterministicCrypto(3);
    const work = await descriptor(crypto);
    const current = authority(crypto, work);
    const fulfillment = await fulfillAgentBackgroundAuthorizationRequestV2({
      crypto,
      request: request(crypto, work),
      resolveCurrentAuthority: () => current,
    });

    const verified =
      await verifyCurrentAgentBackgroundAuthorizationDeviceResponseV2({
        crypto,
        expected: {
          requestId: work.requestId,
          recipientGeneration: work.recipientGeneration,
          descriptorHash: backgroundWorkDescriptorDigestV2(crypto, work),
          recipientKeyId: work.recipientKeyId,
          recipientPublicKey: work.recipientPublicKey,
        },
        responseBytes: fulfillment.responseBytes,
        now: NOW,
        resolveCurrentAuthority: () => publicAuthority(current),
      });

    expect(verified).toMatchObject({
      formatVersion: 2,
      kind: "agent",
      requestId: work.requestId,
      anchorNamespaceId: work.anchorNamespaceId,
      anchorDomainId: work.anchorDomainId,
      grantScope: work.grantScope,
      namespaceRequirements: work.namespaceRequirements,
      domainRequirements: work.domainRequirements,
    });
    expect(JSON.stringify(verified)).not.toContain("aiRoot");
    expect(JSON.stringify(verified)).not.toContain("privateKey");

    expect(
      verifyCurrentAgentBackgroundAuthorizationDeviceResponseV2({
        crypto,
        expected: {
          requestId: work.requestId,
          recipientGeneration: work.recipientGeneration,
          descriptorHash: backgroundWorkDescriptorDigestV2(crypto, work),
          recipientKeyId: work.recipientKeyId,
          recipientPublicKey: work.recipientPublicKey,
        },
        responseBytes: fulfillment.responseBytes,
        now: NOW,
        resolveCurrentAuthority: () => ({
          ...publicAuthority(current),
          domains: publicAuthority(current).domains.slice(0, 2),
        }),
      }),
    ).rejects.toThrow("current authority");

    expect(
      verifyCurrentAgentBackgroundAuthorizationDeviceResponseV2({
        crypto,
        expected: {
          requestId: work.requestId,
          recipientGeneration: work.recipientGeneration,
          descriptorHash: backgroundWorkDescriptorDigestV2(crypto, work),
          recipientKeyId: work.recipientKeyId,
          recipientPublicKey: work.recipientPublicKey,
        },
        responseBytes: fulfillment.responseBytes,
        now: NOW,
        resolveCurrentAuthority: () =>
          current as unknown as
            AgentBackgroundAuthorizationDevicePublicAuthorityV2,
      }),
    ).rejects.toThrow("secret material");
  });

  test("preserves the v1 Agent responder and verifier surface", () => {
    expect(typeof fulfillAgentBackgroundAuthorizationRequest).toBe(
      "function",
    );
    expect(typeof verifyCurrentBackgroundAuthorizationDeviceResponse)
      .toBe("function");
  });
});
