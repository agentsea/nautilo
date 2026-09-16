import { describe, expect, test } from "bun:test";

import {
  AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V1,
  AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V1,
  AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V1,
  MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V1,
  agentBackgroundGrantResponseSigningBytesV1,
  createAgentBackgroundGrantResponseV1,
  decodeAgentBackgroundGrantResponseV1,
  encodeAgentBackgroundGrantResponseV1,
  verifyCurrentAgentBackgroundGrantResponseV1,
  verifyHistoricalAgentBackgroundGrantResponseV1,
  type AgentBackgroundGrantIssuerContextV1,
} from "../../src/background/agent-background-grant-response-v1.ts";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "../../src/background/work-descriptor-v1.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  mintGrantV2,
} from "../../src/grant/authorization.ts";
import {
  serializeGrantV2,
} from "../../src/format/grant-v2.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_900_000_000_000;

async function fixture(
  seed = 24_150,
  timing: Readonly<{
    issuedAt: number;
    notBefore: number;
    expiresAt: number;
  }> = {
    issuedAt: NOW,
    notBefore: NOW + 10,
    expiresAt: NOW + 5 * 60_000,
  },
) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const agentSubject = {
    kind: "agent",
    agentId: agentId("agent-genie"),
    runtimeGeneration: agentRuntimeGeneration(7),
    authorizationRevision: authorizationRevision(13),
  } as const;
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId: "background-request-agent-1",
    recipientGeneration: 4,
    workKind: "task.execute",
    workId: "task-run-14",
    namespaceId: namespaceId("room-namespace-1"),
    domainId: cryptoDomainId("domain-ab"),
    subject: agentSubject,
    purpose: "task.execute",
    operations: ["decrypt"],
    source: {
      kind: "synthetic_payload",
      generation: 2,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [objectId("task-payload-14")],
    outputObjectIds: [],
    outputObjectMetadata: [],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 0,
    maximumPlaintextBytes: 64 * 1024,
    maximumCiphertextBytes: 96 * 1024,
    expectedDomainEpoch: domainEpoch(5),
    expectedNamespaceAccessRevision: accessRevision(11),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: "background-agent-recipient-4",
    recipientPublicKey: recipient.publicKey,
    issuedAt: timing.issuedAt,
    notBefore: timing.notBefore,
    expiresAt: timing.expiresAt,
    idempotencyId: "task-run-14-attempt-2",
  };
  const grant = await mintGrantV2(crypto, {
    id: grantId("background-agent-grant-1"),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentSubject.agentId,
    recipientKeyId: descriptor.recipientKeyId,
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice"), humanId("bob")],
    operations: descriptor.operations,
    issuedAt: descriptor.issuedAt,
    expiresAt: descriptor.expiresAt,
    coveredDomains: [{
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      agentAuthorizationRevision:
        agentSubject.authorizationRevision,
      aiRoot: new Uint8Array(32).fill(0x52),
    }],
    singleUse: true,
  });
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const grantBytes = serializeGrantV2(grant);
  const created = createAgentBackgroundGrantResponseV1(crypto, {
    workDescriptorBytes: descriptorBytes,
    grantBytes,
    issuingHumanId: humanId("alice"),
    issuingDeviceAuthorizationRevision: authorizationRevision(17),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceSigningPrivateKey: issuer.privateKey,
  });
  return {
    created,
    crypto,
    descriptor,
    descriptorBytes,
    grant,
    grantBytes,
    issuer,
    recipient,
  };
}

describe("Agent background GrantV2 response adapter", () => {
  test("locks the public format and wire limits", () => {
    expect(AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V1).toBe(
      "nautilo/lattice-crypto/agent-background-grant-response/v1",
    );
    expect(AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V1).toBe(600_000);
    expect(MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V1)
      .toBe(16_912_384);
  });

  test("round-trips unchanged GrantV2 under one request-bound signed response", async () => {
    const state = await fixture();
    const decoded =
      decodeAgentBackgroundGrantResponseV1(state.created.bytes);
    let currentContext: AgentBackgroundGrantIssuerContextV1 | undefined;
    let historicalContext: AgentBackgroundGrantIssuerContextV1 | undefined;

    const current = await verifyCurrentAgentBackgroundGrantResponseV1(
      state.crypto,
      {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: (context) => {
          currentContext = structuredClone(context);
          return state.issuer.publicKey;
        },
      },
    );
    const historical =
      await verifyHistoricalAgentBackgroundGrantResponseV1(
        state.crypto,
        {
          responseBytes: state.created.bytes,
          resolveHistoricalIssuingDevicePublicKey: (context) => {
            historicalContext = structuredClone(context);
            return state.issuer.publicKey;
          },
        },
      );

    expect(decoded.formatVersion)
      .toBe(AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V1);
    expect(encodeAgentBackgroundGrantResponseV1(decoded))
      .toEqual(state.created.bytes);
    const { signature: _, ...unsigned } = decoded;
    const signingBytes = agentBackgroundGrantResponseSigningBytesV1(unsigned);
    expect(signingBytes).toEqual(state.created.bytes.slice(0, -68));
    signingBytes.fill(0);
    expect(state.created.bytes.at(0)).not.toBe(0xff);
    expect(current.grant).toEqual(state.grant);
    expect(current.grantBytes).toEqual(state.grantBytes);
    expect(current.workDescriptor).toEqual(state.descriptor);
    expect(historical.workDescriptor).toEqual(state.descriptor);
    if (state.descriptor.subject.kind !== "agent") {
      throw new Error("fixture is not Agent-bound");
    }
    expect(currentContext).toMatchObject({
      purpose: "verify-current-agent-background-grant-response",
      requestId: state.descriptor.requestId,
      recipientGeneration: state.descriptor.recipientGeneration,
      agentId: state.descriptor.subject.agentId,
      runtimeGeneration: state.descriptor.subject.runtimeGeneration,
      agentAuthorizationRevision:
        state.descriptor.subject.authorizationRevision,
      namespaceId: state.descriptor.namespaceId,
      domainId: state.descriptor.domainId,
      issuingHumanId: "alice",
      issuingDeviceId: "alice-phone",
      grantScope: ["alice", "bob"],
      operations: ["decrypt"],
    });
    expect(historicalContext).toMatchObject({
      purpose: "verify-historical-agent-background-grant-response",
      requestId: state.descriptor.requestId,
    });
  });

  test("accepts the inclusive timestamp boundaries", async () => {
    const epoch = await fixture(24_155, {
      issuedAt: 0,
      notBefore: 0,
      expiresAt: 1,
    });
    expect(decodeAgentBackgroundGrantResponseV1(
      epoch.created.bytes,
    )).toMatchObject({ issuedAt: 0, notBefore: 0, expiresAt: 1 });

    const simultaneous = await fixture(24_153, {
      issuedAt: NOW,
      notBefore: NOW,
      expiresAt: NOW + 1,
    });
    expect(decodeAgentBackgroundGrantResponseV1(
      simultaneous.created.bytes,
    )).toMatchObject({
      issuedAt: NOW,
      notBefore: NOW,
      expiresAt: NOW + 1,
    });

    const maximumTtl = await fixture(24_154, {
      issuedAt: NOW,
      notBefore: NOW + 1,
      expiresAt: NOW + AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V1,
    });
    expect(decodeAgentBackgroundGrantResponseV1(
      maximumTtl.created.bytes,
    ).expiresAt).toBe(
      NOW + AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V1,
    );
  });

  test("rejects a processor descriptor, reusable/broad/substituted GrantV2, and stale authority", async () => {
    const state = await fixture(24_151);
    const agentSubject = state.descriptor.subject;
    if (agentSubject.kind !== "agent") {
      throw new Error("fixture is not Agent-bound");
    }
    const processorDescriptor: BackgroundWorkDescriptorV1 = {
      ...state.descriptor,
      workKind: "stenographer.extraction",
      workId: "stenographer-batch-1",
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
        fingerprint: new Uint8Array(32).fill(0x21),
      },
      outputObjectIds: [objectId("event-object-1")],
      outputObjectMetadata: [{
        objectId: objectId("event-object-1"),
        objectType: "journal.event",
        createdAt: unixTimestamp(state.descriptor.issuedAt),
      }],
      maximumOutputObjectCount: 1,
    };
    expect(() => createAgentBackgroundGrantResponseV1(state.crypto, {
      workDescriptorBytes:
        encodeBackgroundWorkDescriptorV1(processorDescriptor),
      grantBytes: state.grantBytes,
      issuingHumanId: humanId("alice"),
      issuingDeviceAuthorizationRevision: authorizationRevision(17),
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
    })).toThrow(
      "Agent background grant response requires an Agent work descriptor",
    );

    const changedGrant = (changes: Partial<typeof state.grant>) =>
      serializeGrantV2({
        ...state.grant,
        ...changes,
        signature: state.grant.signature,
      });
    const createFromGrant = (grantBytes: Uint8Array) =>
      createAgentBackgroundGrantResponseV1(state.crypto, {
        workDescriptorBytes: state.descriptorBytes,
        grantBytes,
        issuingHumanId: humanId("alice"),
        issuingDeviceAuthorizationRevision: authorizationRevision(17),
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      });
    for (const grantBytes of [
      changedGrant({ singleUse: false }),
      changedGrant({
        recipientAgentId: agentId("agent-other"),
      }),
      changedGrant({ recipientKeyId: "background-agent-recipient-other" }),
      changedGrant({ issuedAt: state.grant.issuedAt + 1 }),
      changedGrant({ expiresAt: state.grant.expiresAt + 1 }),
      changedGrant({ operations: ["encrypt"] }),
      changedGrant({ operations: ["decrypt", "encrypt"] }),
      changedGrant({
        coveredDomains: [{
          ...state.grant.coveredDomains[0]!,
          domainId: cryptoDomainId("domain-other"),
        }],
      }),
      changedGrant({
        coveredDomains: [{
          ...state.grant.coveredDomains[0]!,
          domainEpoch: domainEpoch(
            state.grant.coveredDomains[0]!.domainEpoch + 1,
          ),
        }],
      }),
      changedGrant({
        coveredDomains: [{
          ...state.grant.coveredDomains[0]!,
          agentAuthorizationRevision: authorizationRevision(
            state.grant.coveredDomains[0]!.agentAuthorizationRevision + 1,
          ),
        }],
      }),
      changedGrant({
        coveredDomains: [
          ...state.grant.coveredDomains,
          {
            domainId: cryptoDomainId("domain-extra"),
            domainEpoch: domainEpoch(1),
            agentAuthorizationRevision: authorizationRevision(1),
          },
        ],
      }),
    ]) {
      expect(() => createFromGrant(grantBytes)).toThrow(
        "does not match the exact background work descriptor",
      );
    }
    expect(() =>
      createFromGrant(changedGrant({ scope: [humanId("bob")] }))
    ).toThrow("scope excludes its issuing Human");

    const invalidGrant = state.grantBytes.slice();
    invalidGrant[0] = invalidGrant[0]! ^ 1;
    expect(() => createFromGrant(invalidGrant)).toThrow("GrantV2 is invalid");
    const invalidGrantSignature = serializeGrantV2({
      ...state.grant,
      signature: new Uint8Array(state.grant.signature.length),
    });
    expect(() => createFromGrant(invalidGrantSignature))
      .toThrow("issuer signature is invalid");
    const otherSigningIssuer = state.crypto.generateSigningKeyPair();
    expect(() => createAgentBackgroundGrantResponseV1(state.crypto, {
      workDescriptorBytes: state.descriptorBytes,
      grantBytes: state.grantBytes,
      issuingHumanId: humanId("alice"),
      issuingDeviceAuthorizationRevision: authorizationRevision(17),
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: otherSigningIssuer.privateKey,
    })).toThrow("issuer keys do not match");

    const mismatchedPolicyDescriptor = {
      ...state.descriptor,
      expectedPolicyRevision: authorizationRevision(
        agentSubject.authorizationRevision + 1,
      ),
    };
    expect(() => createAgentBackgroundGrantResponseV1(state.crypto, {
      workDescriptorBytes:
        encodeBackgroundWorkDescriptorV1(mismatchedPolicyDescriptor),
      grantBytes: state.grantBytes,
      issuingHumanId: humanId("alice"),
      issuingDeviceAuthorizationRevision: authorizationRevision(17),
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
    })).toThrow("exact background work descriptor");

    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () => null,
      }),
    ).rejects.toThrow("not currently authorized");
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.expiresAt,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      }),
    ).rejects.toThrow("not currently valid");
    const otherResolvedIssuer = state.crypto.generateSigningKeyPair();
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          otherResolvedIssuer.publicKey,
      }),
    ).rejects.toThrow("public key does not match");
  });

  test("fails closed on tampering, trailing bytes, oversize, and unknown fields", async () => {
    const state = await fixture(24_152);
    const tampered = state.created.bytes.slice();
    tampered[tampered.length - 1] =
      tampered[tampered.length - 1]! ^ 1;

    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: tampered,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      }),
    ).rejects.toThrow();
    expect(() =>
      decodeAgentBackgroundGrantResponseV1(
        new Uint8Array([...state.created.bytes, 0]),
      )
    ).toThrow("trailing");
    expect(() =>
      decodeAgentBackgroundGrantResponseV1(
        new Uint8Array(
          MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V1 + 1,
        ),
      )
    ).toThrow("wire limit");
    expect(() =>
      encodeAgentBackgroundGrantResponseV1({
        ...state.created.response,
        extra: true,
      } as never)
    ).toThrow("field set");
    const { signature: _signature, ...withoutSignature } =
      state.created.response;
    expect(() =>
      encodeAgentBackgroundGrantResponseV1(withoutSignature as never)
    ).toThrow("field set");

    const response = state.created.response;
    const { workDescriptorHash: _, ...withoutDescriptorHash } = response;
    const malformed: Array<readonly [unknown, string]> = [
      [null, "must be an object"],
      [[], "must be an object"],
      ["response", "must be an object"],
      [{ ...withoutDescriptorHash, descriptorHash: response.workDescriptorHash },
        "field set"],
      [{ ...response, formatVersion: 2 }, "format version"],
      [{ ...response, workDescriptorBytes: new Uint8Array() },
        "must contain"],
      [{ ...response, workDescriptorHash: new Uint8Array(31) },
        "exactly 32 bytes"],
      [{ ...response, workDescriptorHash: new Uint8Array(32) },
        "descriptor hash does not match"],
      [{ ...response, grantBytes: new Uint8Array() }, "must contain"],
      [{ ...response, grantHash: new Uint8Array(31) },
        "exactly 32 bytes"],
      [{ ...response, grantHash: new Uint8Array(32) },
        "GrantV2 hash does not match"],
      [{ ...response, issuerSigningPublicKeyHash: new Uint8Array(31) },
        "exactly 32 bytes"],
      [{ ...response, signature: new Uint8Array(63) },
        "exactly 64 bytes"],
      [{ ...response, issuedAt: Number.NaN }, "timestamps"],
      [{ ...response, notBefore: 1.5 }, "timestamps"],
      [{ ...response, expiresAt: Number.POSITIVE_INFINITY }, "timestamps"],
      [{ ...response, issuedAt: -1 }, "timestamps"],
      [{ ...response, issuedAt: response.notBefore + 1 }, "timestamps"],
      [{ ...response, notBefore: response.expiresAt }, "timestamps"],
      [{
        ...response,
        expiresAt: response.issuedAt
          + AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V1 + 1,
      }, "timestamps"],
      [{ ...response, issuedAt: response.issuedAt + 1 }, "timestamps"],
      [{ ...response, notBefore: response.notBefore + 1 }, "timestamps"],
      [{ ...response, expiresAt: response.expiresAt + 1 }, "timestamps"],
    ];
    for (const [value, message] of malformed) {
      expect(() =>
        encodeAgentBackgroundGrantResponseV1(value as never)
      ).toThrow(message);
    }

    expect(() => decodeAgentBackgroundGrantResponseV1(null as never))
      .toThrow("must be Uint8Array");
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: state.created.bytes,
        now: 0,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      }),
    ).rejects.toThrow("not currently valid");
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: new Uint8Array([0]),
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      }),
    ).rejects.toThrow("truncated u32");
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: new Uint8Array(
          MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V1,
        ),
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      }),
    ).rejects.toThrow("domain mismatch");
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: state.created.bytes,
        now: -1,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      }),
    ).rejects.toThrow("verification time is invalid");
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: null as never,
      }),
    ).rejects.toThrow("resolver is required");
    expect(
      verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () => new Uint8Array(31),
      }),
    ).rejects.toThrow("exactly 32 bytes");

    const wrongDomain = state.created.bytes.slice();
    const domainTail = AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V1.length - 1;
    wrongDomain[domainTail] = wrongDomain[domainTail]! ^ 1;
    expect(() => decodeAgentBackgroundGrantResponseV1(wrongDomain))
      .toThrow("domain mismatch");

    const invalidGrantSignature = serializeGrantV2({
      ...state.grant,
      signature: new Uint8Array(state.grant.signature.length),
    });
    const {
      signature: _responseSignature,
      ...originalResponseUnsigned
    } = state.created.response;
    const invalidInnerUnsigned = {
      ...originalResponseUnsigned,
      grantBytes: invalidGrantSignature,
      grantHash: state.crypto.hash(invalidGrantSignature),
    };
    const invalidInnerSigningBytes =
      agentBackgroundGrantResponseSigningBytesV1(invalidInnerUnsigned);
    const invalidInnerResponse = encodeAgentBackgroundGrantResponseV1({
      ...invalidInnerUnsigned,
      signature: state.crypto.sign(
        state.issuer.privateKey,
        invalidInnerSigningBytes,
      ),
    });
    invalidInnerSigningBytes.fill(0);
    expect(verifyCurrentAgentBackgroundGrantResponseV1(state.crypto, {
      responseBytes: invalidInnerResponse,
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("signature is invalid");

    const scopeExcludingGrant = await mintGrantV2(state.crypto, {
      id: grantId("background-agent-grant-scope-excluding"),
      issuingDeviceId: cryptoDeviceId("bob-phone"),
      issuingHumanId: humanId("bob"),
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      recipientAgentId: state.grant.recipientAgentId,
      recipientKeyId: state.grant.recipientKeyId,
      recipientEncryptionPublicKey: state.recipient.publicKey,
      scope: [humanId("bob")],
      operations: state.grant.operations,
      issuedAt: state.grant.issuedAt,
      expiresAt: state.grant.expiresAt,
      coveredDomains: [{
        ...state.grant.coveredDomains[0]!,
        aiRoot: new Uint8Array(32).fill(0x52),
      }],
      singleUse: true,
    });
    const scopeExcludingGrantBytes = serializeGrantV2(scopeExcludingGrant);
    expect(() => encodeAgentBackgroundGrantResponseV1({
      ...state.created.response,
      grantBytes: scopeExcludingGrantBytes,
      grantHash: state.crypto.hash(scopeExcludingGrantBytes),
    })).toThrow("scope excludes its issuing Human");
  });
});
