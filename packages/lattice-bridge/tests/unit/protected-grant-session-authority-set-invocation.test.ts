import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceId,
  type GrantAuthoritySetUseAuthorizationContext,
  type GrantAuthoritySetUseAuthorizationDecision,
  type Rng,
} from "@nautilo/lattice-crypto";
import { serializeGrantV2 } from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  destroyProtectedInvocationCapability,
  executeProtectedGrantSessionAuthoritySetCapabilityOperationV2,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
} from "../../src/invocation/protected-grant-invocation";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage";

const NOW = 8_600_000;

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(length: number): Uint8Array {
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

function allow(
  context: GrantAuthoritySetUseAuthorizationContext,
): GrantAuthoritySetUseAuthorizationDecision {
  return Object.freeze({
    context,
    currentTime: NOW + 2,
    issuingDeviceActive: true,
    recipientAgentAuthorized: true,
    requestedNamespacesAuthorized: true,
    requestedDomainsAuthorized: true,
    hostAllowsOperation: true,
    currentSingleUseStatus: context.singleUseStatus,
  });
}

async function setup(singleUse: boolean) {
  const crypto = new LatticeCrypto(seededRng(singleUse ? 13_001 : 13_002), {
    now: () => NOW,
  });
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "foreground-key",
  });
  const grant = await mintGrant(crypto, {
    id: grantId(singleUse ? "grant-single-use-set" : "grant-reusable-set"),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "foreground-key",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [
      {
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(8),
        aiRoot: new Uint8Array(32).fill(0xa1),
      },
      {
        domainId: cryptoDomainId("domain-b"),
        domainEpoch: domainEpoch(5),
        agentAuthorizationRevision: authorizationRevision(9),
        aiRoot: new Uint8Array(32).fill(0xb2),
      },
    ],
    singleUse,
  });
  const { storage } = createFakeLatticeStorage();
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const coordinates = Object.freeze({
    invocationId: singleUse
      ? "invocation-single-use-set"
      : "invocation-reusable-set",
    grantId: grant.id,
    issuingHumanId: "alice",
    recipientAgentId: grant.recipientAgentId,
    recipientKeyId: grant.recipientKeyId,
    issuingDeviceId: grant.issuingDeviceId,
    namespaceIds: Object.freeze(["room-a", "room-b"]),
    domainIds: Object.freeze(["domain-a", "domain-b"]),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
  const facts: ProtectedGrantAuthoritySetFactsV2 = Object.freeze({
    now: NOW + 1,
    expectedIssuingDeviceId: "alice-phone",
    issuingDeviceHumanId: "alice",
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: "genie",
    recipientKeyId: "foreground-key",
    singleUseAvailable: true,
    grantScope: ["alice"],
    namespaceRequirements: [
      {
        namespaceId: namespaceId("room-a"),
        domainId: cryptoDomainId("domain-a"),
        operations: ["decrypt"] as const,
        namespaceParticipants: ["alice"],
        expectedAccessRevision: accessRevision(2),
        expectedPolicyRevision: 3,
      },
      {
        namespaceId: namespaceId("room-b"),
        domainId: cryptoDomainId("domain-b"),
        operations: ["encrypt"] as const,
        namespaceParticipants: ["alice", "bob"],
        expectedAccessRevision: accessRevision(3),
        expectedPolicyRevision: 4,
      },
    ],
    domainRequirements: [
      {
        domainId: cryptoDomainId("domain-a"),
        expectedEpoch: domainEpoch(4),
        expectedAgentAuthorizationRevision: authorizationRevision(8),
      },
      {
        domainId: cryptoDomainId("domain-b"),
        expectedEpoch: domainEpoch(5),
        expectedAgentAuthorizationRevision: authorizationRevision(9),
      },
    ],
    hostAllowsOperation: true,
  });
  const capability = createProtectedInvocationCapability({
    coordinates,
    recipient: recipient.recipient,
  });
  return { capability, crypto, facts, grant, storage };
}

describe("foreground reusable Grant authority-set invocation", () => {
  test("revalidates every use, retains the capability, and wipes every opened root", async () => {
    const fixture = await setup(false);
    const phases: string[] = [];
    const borrowedRoots: Uint8Array[] = [];
    const authority: ProtectedGrantAuthoritySetPortV2 = {
      resolvePreflightFacts: (request) => {
        phases.push(request.phase);
        return fixture.facts;
      },
      resolveCurrentAuthorization: (context) => {
        phases.push(context.phase);
        expect(context.singleUseStatus).toBe("reusable");
        return allow(context);
      },
    };

    for (const expected of ["first", "second"] as const) {
      const result =
        await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
          capability: fixture.capability,
          crypto: fixture.crypto,
          storage: fixture.storage,
          authority,
          execute: (opened, evidence) => {
            expect(evidence.grantId).toBe(fixture.grant.id);
            expect(evidence.grantUseStatus).toBe("reusable");
            expect(evidence.namespaceRequirements.map((entry) => ({
              namespaceId: entry.namespaceId,
              domainId: entry.domainId,
              operations: entry.operations,
              expectedAccessRevision: entry.expectedAccessRevision,
              expectedPolicyRevision: entry.expectedPolicyRevision,
            }))).toEqual(opened.namespaceRequirements.map((entry) => ({
              namespaceId: entry.namespaceId,
              domainId: entry.domainId,
              operations: entry.operations,
              expectedAccessRevision: entry.expectedAccessRevision,
              expectedPolicyRevision: entry.expectedPolicyRevision,
            })));
            expect(evidence.domainRequirements.map((entry) => entry.domainId))
              .toEqual(opened.domains.map((entry) => entry.domainId));
            expect(opened.namespaceRequirements.map((entry) => entry.namespaceId))
              .toEqual([namespaceId("room-a"), namespaceId("room-b")]);
            expect(opened.domains.map((entry) => entry.domainId))
              .toEqual([
                cryptoDomainId("domain-a"),
                cryptoDomainId("domain-b"),
              ]);
            expect(opened.domains[0]!.aiRoot).toEqual(
              new Uint8Array(32).fill(0xa1),
            );
            expect(opened.domains[1]!.aiRoot).toEqual(
              new Uint8Array(32).fill(0xb2),
            );
            borrowedRoots.push(...opened.domains.map((entry) => entry.aiRoot));
            return expected;
          },
        });
      expect(result).toEqual({ status: "executed", value: expected });
      expect(inspectProtectedInvocationCapability(fixture.capability)).not
        .toBeNull();
      expect(borrowedRoots.every((root) => root.every((byte) => byte === 0)))
        .toBeTrue();
      expect(await fixture.storage.getGrant(fixture.grant.id)).toMatchObject({
        consumed: false,
      });
    }

    expect(phases).toEqual([
      "preflight",
      "before-execute",
      "preflight",
      "before-execute",
    ]);
    destroyProtectedInvocationCapability(fixture.capability);
    expect(inspectProtectedInvocationCapability(fixture.capability)).toBeNull();
  });

  test("rejects single-use Grants without consuming them or destroying the capability", async () => {
    const fixture = await setup(true);
    let authorityRan = false;
    let callbackRan = false;
    const authority: ProtectedGrantAuthoritySetPortV2 = {
      resolvePreflightFacts: () => {
        authorityRan = true;
        return fixture.facts;
      },
      resolveCurrentAuthorization: (context) => allow(context),
    };

    expect(
      await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
        capability: fixture.capability,
        crypto: fixture.crypto,
        storage: fixture.storage,
        authority,
        execute: () => {
          callbackRan = true;
        },
      }),
    ).toEqual({ status: "unavailable", reason: "grant_not_reusable" });
    expect(authorityRan).toBeFalse();
    expect(callbackRan).toBeFalse();
    expect(inspectProtectedInvocationCapability(fixture.capability)).not
      .toBeNull();
    expect(await fixture.storage.getGrant(fixture.grant.id)).toMatchObject({
      consumed: false,
    });
    destroyProtectedInvocationCapability(fixture.capability);
  });

  test("wipes every opened root after a throwing callback without poisoning the session", async () => {
    const fixture = await setup(false);
    const borrowedRoots: Uint8Array[] = [];
    const authority: ProtectedGrantAuthoritySetPortV2 = {
      resolvePreflightFacts: () => fixture.facts,
      resolveCurrentAuthorization: (context) => allow(context),
    };

    let thrown: unknown;
    try {
      await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
        capability: fixture.capability,
        crypto: fixture.crypto,
        storage: fixture.storage,
        authority,
        execute: (opened) => {
          borrowedRoots.push(...opened.domains.map((entry) => entry.aiRoot));
          throw new Error("foreground set callback failed");
        },
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("foreground set callback failed");
    expect(borrowedRoots).toHaveLength(2);
    expect(borrowedRoots.every((root) => root.every((byte) => byte === 0)))
      .toBeTrue();
    expect(inspectProtectedInvocationCapability(fixture.capability)).not
      .toBeNull();
    expect(await fixture.storage.getGrant(fixture.grant.id)).toMatchObject({
      consumed: false,
    });

    expect(
      await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
        capability: fixture.capability,
        crypto: fixture.crypto,
        storage: fixture.storage,
        authority,
        execute: () => "recovered",
      }),
    ).toEqual({ status: "executed", value: "recovered" });
    destroyProtectedInvocationCapability(fixture.capability);
  });

  test("rejects partial, extra, and stale authority without poisoning the session", async () => {
    const fixture = await setup(false);
    const partial = Object.freeze({
      ...fixture.facts,
      namespaceRequirements: fixture.facts.namespaceRequirements.slice(0, 1),
    });
    const extra = Object.freeze({
      ...fixture.facts,
      namespaceRequirements: Object.freeze([
        ...fixture.facts.namespaceRequirements,
        Object.freeze({
          namespaceId: namespaceId("room-c"),
          domainId: cryptoDomainId("domain-b"),
          operations: ["decrypt"] as const,
          namespaceParticipants: ["alice"],
          expectedAccessRevision: accessRevision(1),
          expectedPolicyRevision: 1,
        }),
      ]),
    });
    let preflightFacts: ProtectedGrantAuthoritySetFactsV2 = partial;
    let current = true;
    let callbackCount = 0;
    const authority: ProtectedGrantAuthoritySetPortV2 = {
      resolvePreflightFacts: () => preflightFacts,
      resolveCurrentAuthorization: (context) =>
        current ? allow(context) : null,
    };
    const execute = () => {
      callbackCount += 1;
      return callbackCount;
    };

    for (const invalid of [partial, extra]) {
      preflightFacts = invalid;
      expect(
        await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
          capability: fixture.capability,
          crypto: fixture.crypto,
          storage: fixture.storage,
          authority,
          execute,
        }),
      ).toEqual({
        status: "unavailable",
        reason: "authorization_unavailable",
      });
      expect(inspectProtectedInvocationCapability(fixture.capability)).not
        .toBeNull();
    }

    preflightFacts = fixture.facts;
    current = false;
    expect(
      await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
        capability: fixture.capability,
        crypto: fixture.crypto,
        storage: fixture.storage,
        authority,
        execute,
      }),
    ).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(inspectProtectedInvocationCapability(fixture.capability)).not
      .toBeNull();

    current = true;
    expect(
      await executeProtectedGrantSessionAuthoritySetCapabilityOperationV2({
        capability: fixture.capability,
        crypto: fixture.crypto,
        storage: fixture.storage,
        authority,
        execute,
      }),
    ).toEqual({ status: "executed", value: 1 });
    expect(callbackCount).toBe(1);
    expect(inspectProtectedInvocationCapability(fixture.capability)).not
      .toBeNull();
    destroyProtectedInvocationCapability(fixture.capability);
  });
});
