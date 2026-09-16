import { describe, expect, test } from "bun:test";

import {
  LATTICE_LIMITS,
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
} from "@nautilo/lattice-crypto";
import {
  backgroundWorkDescriptorDigestV1,
  encodeBackgroundWorkDescriptorV1,
  verifyCurrentAgentBackgroundGrantResponseV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  BackgroundAuthorizationDeviceResponderError,
  fulfillAgentBackgroundAuthorizationRequest,
  type AgentBackgroundAuthorizationDeviceAuthority,
  type BackgroundAuthorizationDeviceRequest,
} from "../../src/index.ts";

const NOW = 1_900_000_000_000;

function crypto(seed = 1): LatticeCrypto {
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
  lattice: LatticeCrypto,
  overrides: Partial<BackgroundWorkDescriptorV1> = {},
): Promise<BackgroundWorkDescriptorV1> {
  const recipient = await lattice.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  return {
    formatVersion: 1,
    requestId: "background-agent-request-1",
    recipientGeneration: 2,
    workKind: "task.execute",
    workId: "task-run-42",
    namespaceId: namespaceId("namespace-room-1"),
    domainId: cryptoDomainId("domain-room-1"),
    subject: {
      kind: "agent",
      agentId: agentId("agent-genie"),
      runtimeGeneration: agentRuntimeGeneration(9),
      authorizationRevision: authorizationRevision(13),
    },
    purpose: "task.execute",
    operations: ["decrypt"],
    source: {
      kind: "synthetic_payload",
      generation: 1,
      fingerprint: new Uint8Array(32).fill(0x31),
    },
    inputObjectIds: [objectId("task-payload-42")],
    outputObjectIds: [],
    outputObjectMetadata: [],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 0,
    maximumPlaintextBytes: 32 * 1024,
    maximumCiphertextBytes: 64 * 1024,
    expectedDomainEpoch: domainEpoch(4),
    expectedNamespaceAccessRevision: accessRevision(8),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: "background-agent-recipient-2",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
    idempotencyId: "task-run-42-attempt-1",
    ...overrides,
  };
}

function request(
  lattice: LatticeCrypto,
  work: BackgroundWorkDescriptorV1,
): BackgroundAuthorizationDeviceRequest {
  return {
    formatVersion: 1,
    descriptorBytes: encodeBackgroundWorkDescriptorV1(work),
    descriptorHash: backgroundWorkDescriptorDigestV1(lattice, work),
  };
}

function authority(
  lattice: LatticeCrypto,
  work: BackgroundWorkDescriptorV1,
  overrides: Partial<AgentBackgroundAuthorizationDeviceAuthority> = {},
): AgentBackgroundAuthorizationDeviceAuthority {
  if (work.subject.kind !== "agent") {
    throw new Error("fixture is not Agent-bound");
  }
  const signer = lattice.generateSigningKeyPair();
  return {
    humanId: humanId("human-alice"),
    humanState: "active",
    deviceId: cryptoDeviceId("device-alice-browser"),
    deviceHumanId: humanId("human-alice"),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(17),
    deviceSigningPublicKey: signer.publicKey,
    deviceSigningPrivateKey: signer.privateKey,
    namespaceId: work.namespaceId,
    namespaceState: "active",
    membershipHumanId: humanId("human-alice"),
    membershipState: "active",
    namespaceParticipants: [
      humanId("human-alice"),
      humanId("human-bob"),
    ],
    namespaceAccessRevision: work.expectedNamespaceAccessRevision,
    policyRevision: work.expectedPolicyRevision,
    domainId: work.domainId,
    domainState: "active",
    domainEpoch: work.expectedDomainEpoch,
    agentId: work.subject.agentId,
    agentState: "active",
    runtimeGeneration: work.subject.runtimeGeneration,
    agentAuthorizationRevision: work.subject.authorizationRevision,
    aiRoot: new Uint8Array(32).fill(0x72),
    ...overrides,
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

describe("Agent background-authorization device responder", () => {
  test("mints unchanged single-use GrantV2 and a request-bound response", async () => {
    const lattice = crypto();
    const work = await descriptor(lattice);
    const current = authority(lattice, work);
    const rootBefore = Uint8Array.from(current.aiRoot);
    const privateBefore = Uint8Array.from(current.deviceSigningPrivateKey);
    let context: Record<string, unknown> | undefined;

    const result = await fulfillAgentBackgroundAuthorizationRequest({
      crypto: lattice,
      request: request(lattice, work),
      resolveCurrentAuthority: (value) => {
        context = value as unknown as Record<string, unknown>;
        return current;
      },
    });
    const verified = await verifyCurrentAgentBackgroundGrantResponseV1(
      lattice,
      {
        responseBytes: result.responseBytes,
        now: NOW,
        resolveCurrentIssuingDevicePublicKey: () =>
          current.deviceSigningPublicKey,
      },
    );

    expect(result).toMatchObject({
      formatVersion: 1,
      requestId: work.requestId,
      recipientGeneration: work.recipientGeneration,
      expiresAt: work.expiresAt,
    });
    expect(verified.grant.singleUse).toBe(true);
    if (work.subject.kind !== "agent") {
      throw new Error("fixture is not Agent-bound");
    }
    expect(verified.grant.recipientAgentId)
      .toBe(work.subject.agentId);
    expect(verified.grant.scope).toEqual(current.namespaceParticipants);
    expect(verified.grant.coveredDomains).toEqual([{
      domainId: work.domainId,
      domainEpoch: work.expectedDomainEpoch,
      agentAuthorizationRevision:
        current.agentAuthorizationRevision,
    }]);
    expect(current.aiRoot).toEqual(rootBefore);
    expect(current.deviceSigningPrivateKey).toEqual(privateBefore);
    expect("aiRoot" in result).toBe(false);
    expect("privateKey" in result).toBe(false);
    expect(Object.keys(context ?? {}).sort()).toEqual([
      "agentAuthorizationRevision",
      "agentId",
      "descriptorHash",
      "domainId",
      "expectedDomainEpoch",
      "expectedNamespaceAccessRevision",
      "expectedPolicyRevision",
      "expiresAt",
      "issuedAt",
      "namespaceId",
      "notBefore",
      "purpose",
      "recipientGeneration",
      "requestId",
      "runtimeGeneration",
      "workId",
      "workKind",
    ]);
  });

  test("rejects processor identity, stale Agent/runtime/revisions, and unavailable authority", async () => {
    const lattice = crypto(2);
    const work = await descriptor(lattice);
    const processor = {
      ...work,
      workKind: "stenographer.extraction",
      subject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: authorizationRevision(19),
      },
      purpose: "journal.extract",
      operations: ["decrypt", "encrypt"],
      source: {
        kind: "journal_range",
        startSequence: 1,
        endSequence: 1,
        rebuildGeneration: 0,
        fingerprint: new Uint8Array(32).fill(0x51),
      },
      outputObjectIds: [objectId("journal-event-1")],
      outputObjectMetadata: [{
        objectId: objectId("journal-event-1"),
        objectType: "room_event",
        createdAt: NOW,
      }],
      maximumOutputObjectCount: 1,
    } as unknown as BackgroundWorkDescriptorV1;
    await expectResponderError(
      fulfillAgentBackgroundAuthorizationRequest({
        crypto: lattice,
        request: request(lattice, processor),
        resolveCurrentAuthority: () => null,
      }),
      "unsupported_request",
    );

    for (const changes of [
      { agentId: agentId("agent-other") },
      { runtimeGeneration: agentRuntimeGeneration(10) },
      { agentAuthorizationRevision: authorizationRevision(14) },
      { policyRevision: authorizationRevision(14) },
      { membershipState: "removed" as const },
      { deviceState: "revoked" as const },
    ]) {
      await expectResponderError(
        fulfillAgentBackgroundAuthorizationRequest({
          crypto: lattice,
          request: request(lattice, work),
          resolveCurrentAuthority: () =>
            authority(lattice, work, changes),
        }),
        changes.membershipState === "removed"
          ? "membership_removed"
          : changes.deviceState === "revoked"
            ? "device_revoked"
            : "stale_authority",
      );
    }
  });

  test("rejects noncanonical/excessive participants and a TTL over product policy", async () => {
    const lattice = crypto(3);
    const work = await descriptor(lattice);
    for (const participants of [
      [humanId("human-bob"), humanId("human-alice")],
      [humanId("human-alice"), humanId("human-alice")],
      Array.from(
        { length: LATTICE_LIMITS.grantScopeHumans + 1 },
        (_, index) => humanId(`human-${String(index).padStart(2, "0")}`),
      ),
    ]) {
      expect(
        fulfillAgentBackgroundAuthorizationRequest({
          crypto: lattice,
          request: request(lattice, work),
          resolveCurrentAuthority: () =>
            authority(lattice, work, {
              namespaceParticipants: participants,
            }),
        }),
      ).rejects.toBeDefined();
    }
    const excessiveTtl = await descriptor(lattice, {
      expiresAt:
        NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS + 1,
    });
    await expectResponderError(
      fulfillAgentBackgroundAuthorizationRequest({
        crypto: lattice,
        request: request(lattice, excessiveTtl),
        resolveCurrentAuthority: () =>
          authority(lattice, excessiveTtl),
      }),
      "excessive_scope",
    );
  });
});
