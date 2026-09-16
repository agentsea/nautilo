import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2,
  MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2,
  agentBackgroundGrantResponseSigningBytesV2,
  assertBoundAgentGrantV2,
  createAgentBackgroundGrantResponseV2,
  decodeAgentBackgroundGrantResponseV2,
  encodeAgentBackgroundGrantResponseV2,
  verifyCurrentAgentBackgroundGrantResponseV2,
  verifyHistoricalAgentBackgroundGrantResponseV2,
  type AgentBackgroundGrantIssuerContextV2,
} from "../../src/background/agent-background-grant-response-v2.ts";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
  encodeBackgroundWorkDescriptorV2,
  type BackgroundAgentWorkDescriptorV2 as BackgroundWorkDescriptorV2,
} from "../../src/background/work-descriptor-v2.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { serializeGrantV2 } from "../../src/format/grant-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import { mintGrantV2 } from "../../src/grant/authorization.ts";
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
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { backgroundProcessorWorkV2Fixture } from "../helpers/background-work-v2-fixture.ts";

const NOW = 1_900_000_000_000;

async function fixture(
  timestamps: Readonly<{
    issuedAt: number;
    notBefore: number;
    expiresAt: number;
  }> = {
    issuedAt: NOW,
    notBefore: NOW + 10,
    expiresAt: NOW + 300_000,
  },
) {
  const crypto = new LatticeCrypto(seededRng(24_410));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const descriptor: BackgroundWorkDescriptorV2 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
    requestId: "background-request-multi-1",
    recipientGeneration: 4,
    workKind: "task.execute",
    workId: "task-run-14",
    anchorNamespaceId: namespaceId("namespace-ab"),
    anchorDomainId: cryptoDomainId("domain-ab"),
    subject: {
      kind: "agent",
      agentId: agentId("agent-genie"),
      runtimeGeneration: agentRuntimeGeneration(7),
      authorizationRevision: authorizationRevision(101),
    },
    purpose: "task.execute",
    operations: ["decrypt"],
    source: {
      kind: "synthetic_payload",
      generation: 2,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    grantScope: [humanId("alice"), humanId("bob")],
    inputBindings: [
      { objectId: objectId("task-input-1"), namespaceId: namespaceId("namespace-ab") },
      { objectId: objectId("task-input-2"), namespaceId: namespaceId("namespace-ac") },
    ],
    outputSlots: [],
    namespaceRequirements: [
      {
        namespaceId: namespaceId("namespace-ab"),
        domainId: cryptoDomainId("domain-ab"),
        operations: ["decrypt"],
        expectedAccessRevision: accessRevision(11),
        expectedPolicyRevision: authorizationRevision(21),
      },
      {
        namespaceId: namespaceId("namespace-ac"),
        domainId: cryptoDomainId("domain-ac"),
        operations: ["decrypt"],
        expectedAccessRevision: accessRevision(12),
        expectedPolicyRevision: authorizationRevision(22),
      },
    ],
    domainRequirements: [
      {
        domainId: cryptoDomainId("domain-ab"),
        expectedEpoch: domainEpoch(31),
        expectedAgentAuthorizationRevision: authorizationRevision(41),
      },
      {
        domainId: cryptoDomainId("domain-ac"),
        expectedEpoch: domainEpoch(32),
        expectedAgentAuthorizationRevision: authorizationRevision(42),
      },
    ],
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 0,
    maximumPlaintextBytes: 64 * 1024,
    maximumCiphertextBytes: 96 * 1024,
    recipientKeyId: "background-agent-recipient-4",
    recipientPublicKey: recipient.publicKey,
    issuedAt: timestamps.issuedAt,
    notBefore: timestamps.notBefore,
    expiresAt: timestamps.expiresAt,
    idempotencyId: "task-run-14-attempt-2",
  };
  const grant = await mintGrantV2(crypto, {
    id: grantId("background-agent-grant-2"),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: descriptor.subject.agentId,
    recipientKeyId: descriptor.recipientKeyId,
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: descriptor.grantScope,
    operations: descriptor.operations,
    issuedAt: descriptor.issuedAt,
    expiresAt: descriptor.expiresAt,
    coveredDomains: descriptor.domainRequirements.map((requirement, index) => ({
      domainId: requirement.domainId,
      domainEpoch: requirement.expectedEpoch,
      agentAuthorizationRevision:
        requirement.expectedAgentAuthorizationRevision,
      aiRoot: new Uint8Array(32).fill(0x50 + index),
    })),
    singleUse: true,
  });
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const grantBytes = serializeGrantV2(grant);
  const created = createAgentBackgroundGrantResponseV2(crypto, {
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
  };
}

describe("Agent background GrantV2 response v2", () => {
  test("keeps the existing Agent descriptor, grant, and response wires byte-stable", async () => {
    const state = await fixture();
    const descriptorBytes = encodeBackgroundWorkDescriptorV2({
      ...state.descriptor,
      recipientPublicKey: new Uint8Array(65).fill(0x21),
    });
    const grantBytes = serializeGrantV2({
      ...state.grant,
      encryptedSecret: new Uint8Array([0x31, 0x32, 0x33]),
      signature: new Uint8Array(64).fill(0x41),
    });
    const hash = (bytes: Uint8Array): Uint8Array =>
      new Uint8Array(createHash("sha256").update(bytes).digest());
    const responseBytes = encodeAgentBackgroundGrantResponseV2({
      ...state.created.response,
      workDescriptorBytes: descriptorBytes,
      workDescriptorHash: hash(descriptorBytes),
      grantBytes,
      grantHash: hash(grantBytes),
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x51),
      signature: new Uint8Array(64).fill(0x61),
    });
    const decoded = decodeAgentBackgroundGrantResponseV2(responseBytes);
    const { signature: _signature, ...unsigned } = decoded;
    expect(createHash("sha256").update(descriptorBytes).digest("hex"))
      .toBe("3ab3c5bdba0af171ba41cdcd00a2ec61adab4fcf4f9800b5c0f85d231fb3c88f");
    expect(createHash("sha256").update(grantBytes).digest("hex"))
      .toBe("9b91690b82fb719ffb6efe4b8425dd39ee1c27fc43e98e2d19271b34a7839258");
    expect(createHash("sha256")
      .update(agentBackgroundGrantResponseSigningBytesV2(unsigned))
      .digest("hex"))
      .toBe("029d10004d42c32f8756453b5e9019b625f3beb7306856b34bba73b8c9a9d92b");
    expect(createHash("sha256").update(responseBytes).digest("hex"))
      .toBe("1f849b4b7c001b97b9a54b8d9bcbc9968773e72a8f9f4cd8f585cd9eebc8c9c9");
  });

  test("rejects the named-processor V2 variant at every Agent response entry point", async () => {
    const state = await fixture();
    const processorBytes = encodeBackgroundWorkDescriptorV2(
      backgroundProcessorWorkV2Fixture(
        new Uint8Array(V2_LIMITS.hpkePublicKeyBytes).fill(0x71),
      ),
    );
    const processorHash = new Uint8Array(
      createHash("sha256").update(processorBytes).digest(),
    );
    const processorResponse = {
      ...state.created.response,
      workDescriptorBytes: processorBytes,
      workDescriptorHash: processorHash,
    };
    const { signature: processorSignature, ...processorUnsigned } =
      processorResponse;

    expect(() => agentBackgroundGrantResponseSigningBytesV2(processorUnsigned))
      .toThrow("Agent subject");
    expect(() => encodeAgentBackgroundGrantResponseV2(processorResponse))
      .toThrow("Agent subject");
    expect(() => createAgentBackgroundGrantResponseV2(state.crypto, {
      workDescriptorBytes: processorBytes,
      grantBytes: state.grantBytes,
      issuingHumanId: humanId("alice"),
      issuingDeviceAuthorizationRevision: authorizationRevision(17),
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
    })).toThrow("Agent subject");

    const processorResponseBytes = concatV2(
      frameText(AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2),
      encodeU32(2),
      frame(processorResponse.workDescriptorBytes),
      frame(processorResponse.workDescriptorHash),
      frame(processorResponse.grantBytes),
      frame(processorResponse.grantHash),
      frameText(processorResponse.issuingHumanId),
      encodeU64(processorResponse.issuingDeviceAuthorizationRevision),
      frame(processorResponse.issuerSigningPublicKeyHash),
      encodeU64(processorResponse.issuedAt),
      encodeU64(processorResponse.notBefore),
      encodeU64(processorResponse.expiresAt),
      frame(processorSignature),
    );
    expect(() => decodeAgentBackgroundGrantResponseV2(processorResponseBytes))
      .toThrow("Agent subject");
    expect(verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
      responseBytes: processorResponseBytes,
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("Agent subject");
  });

  test("round-trips and exposes the complete exact authority to verification", async () => {
    const state = await fixture();
    let context: AgentBackgroundGrantIssuerContextV2 | undefined;
    let resolverContext: AgentBackgroundGrantIssuerContextV2 | undefined;
    const verified = await verifyCurrentAgentBackgroundGrantResponseV2(
      state.crypto,
      {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: (value) => {
          resolverContext = value;
          context = structuredClone(value);
          return state.issuer.publicKey;
        },
      },
    );

    expect(AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2).toBe(
      "nautilo/lattice-crypto/agent-background-grant-response/v2",
    );
    expect(encodeAgentBackgroundGrantResponseV2(
      decodeAgentBackgroundGrantResponseV2(state.created.bytes),
    )).toEqual(state.created.bytes);
    expect(verified.workDescriptor).toEqual(state.descriptor);
    expect(verified.grant).toEqual(state.grant);
    expect(context).toMatchObject({
      purpose: "verify-current-agent-background-grant-response-v2",
      grantScope: ["alice", "bob"],
      operations: ["decrypt"],
      namespaceRequirements: state.descriptor.namespaceRequirements,
      domainRequirements: state.descriptor.domainRequirements,
      agentAuthorizationRevision: 101,
    });
    expect(resolverContext).toBeDefined();
    expect([
      resolverContext!.recipientPublicKey,
      resolverContext!.workDescriptorHash,
      resolverContext!.grantHash,
      resolverContext!.issuerSigningPublicKeyHash,
    ].every((bytes) => bytes.every((value) => value === 0))).toBe(true);
    expect(verified.workDescriptor.recipientPublicKey).toEqual(
      state.descriptor.recipientPublicKey,
    );
    expect(verified.response.workDescriptorHash).toEqual(
      state.created.response.workDescriptorHash,
    );
  });

  test("rejects extra, missing, reordered, stale, or scope-mismatched Domains", async () => {
    const state = await fixture();
    const createFromGrant = (grantBytes: Uint8Array) =>
      createAgentBackgroundGrantResponseV2(state.crypto, {
        workDescriptorBytes: state.descriptorBytes,
        grantBytes,
        issuingHumanId: humanId("alice"),
        issuingDeviceAuthorizationRevision: authorizationRevision(17),
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      });
    const changedGrant = (changes: Partial<typeof state.grant>) =>
      serializeGrantV2({ ...state.grant, ...changes });

    const extraDomain = {
      domainId: cryptoDomainId("domain-extra"),
      domainEpoch: domainEpoch(1),
      agentAuthorizationRevision: authorizationRevision(1),
    };
    expect(() => changedGrant({
      coveredDomains: [...state.grant.coveredDomains].reverse(),
    })).toThrow("canonical");
    expect(() => assertBoundAgentGrantV2(state.descriptor, {
      ...state.grant,
      coveredDomains: [...state.grant.coveredDomains].reverse(),
    })).toThrow("exact background work descriptor");
    for (const bytes of [
      changedGrant({ coveredDomains: state.grant.coveredDomains.slice(0, 1) }),
      changedGrant({ coveredDomains: [
        ...state.grant.coveredDomains,
        extraDomain,
      ] }),
      changedGrant({ coveredDomains: state.grant.coveredDomains.map((entry, index) =>
        index === 0
          ? { ...entry, domainEpoch: domainEpoch(entry.domainEpoch + 1) }
          : entry
      ) }),
      changedGrant({ scope: [humanId("alice")] }),
      changedGrant({ operations: ["decrypt", "encrypt"] }),
      changedGrant({ singleUse: false }),
    ]) {
      expect(() => createFromGrant(bytes)).toThrow(
        /Agent background|GrantV2/,
      );
    }
  });

  test("binds every Grant identity, lifetime, operation, and Domain coordinate", async () => {
    const state = await fixture();
    const mismatches: Array<Partial<typeof state.grant>> = [
      { consumed: true },
      { singleUse: false },
      { recipientAgentId: agentId("agent-other") },
      { recipientKeyId: "background-agent-recipient-other" },
      { issuingDeviceId: "" as typeof state.grant.issuingDeviceId },
      { issuedAt: state.grant.issuedAt + 1 },
      { expiresAt: state.grant.expiresAt + 1 },
      { scope: [humanId("alice")] },
      { scope: [humanId("alice"), humanId("charlie")] },
      { operations: ["decrypt", "encrypt"] },
      { coveredDomains: state.grant.coveredDomains.slice(0, 1) },
      {
        coveredDomains: state.grant.coveredDomains.map((entry, index) =>
          index === 0
            ? { ...entry, domainId: cryptoDomainId("domain-other") }
            : entry
        ),
      },
      {
        coveredDomains: state.grant.coveredDomains.map((entry, index) =>
          index === 0
            ? { ...entry, domainEpoch: domainEpoch(entry.domainEpoch + 1) }
            : entry
        ),
      },
      {
        coveredDomains: state.grant.coveredDomains.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                agentAuthorizationRevision: authorizationRevision(
                  entry.agentAuthorizationRevision + 1,
                ),
              }
            : entry
        ),
      },
    ];

    for (const mismatch of mismatches) {
      expect(() => assertBoundAgentGrantV2(state.descriptor, {
        ...state.grant,
        ...mismatch,
      })).toThrow("exact background work descriptor");
    }
    expect(() => assertBoundAgentGrantV2(
      state.descriptor,
      state.grant,
    )).not.toThrow();
  });

  test("validates every embedded response field before encoding", async () => {
    const state = await fixture();
    expect(() => encodeAgentBackgroundGrantResponseV2({
      ...state.created.response,
      formatVersion: 1 as 2,
    })).toThrow(
      "Agent background grant response v2 format version is invalid",
    );
    expect(() => encodeAgentBackgroundGrantResponseV2({
      ...state.created.response,
      issuingHumanId: humanId("charlie"),
    })).toThrow(
      "Agent background grant scope excludes its issuing Human",
    );
    expect(() => encodeAgentBackgroundGrantResponseV2({
      ...state.created.response,
      issuedAt: -1,
    })).toThrow(
      "Agent background grant response v2 timestamps are invalid",
    );
    const invalidResponses: Array<typeof state.created.response> = [
      { ...state.created.response, formatVersion: 1 as 2 },
      { ...state.created.response, workDescriptorBytes: new Uint8Array() },
      { ...state.created.response, workDescriptorHash: new Uint8Array(31) },
      {
        ...state.created.response,
        workDescriptorHash: new Uint8Array(32),
      },
      { ...state.created.response, grantBytes: new Uint8Array() },
      { ...state.created.response, grantHash: new Uint8Array(31) },
      { ...state.created.response, grantHash: new Uint8Array(32) },
      {
        ...state.created.response,
        issuingHumanId: humanId("charlie"),
      },
      {
        ...state.created.response,
        issuerSigningPublicKeyHash: new Uint8Array(31),
      },
      { ...state.created.response, issuedAt: -1 },
      { ...state.created.response, issuedAt: Number.NaN },
      { ...state.created.response, notBefore: Number.NaN },
      { ...state.created.response, expiresAt: Number.NaN },
      { ...state.created.response, notBefore: state.created.response.issuedAt - 1 },
      { ...state.created.response, expiresAt: state.created.response.notBefore },
      {
        ...state.created.response,
        expiresAt: state.created.response.issuedAt + 10 * 60 * 1_000 + 1,
      },
      { ...state.created.response, issuedAt: state.created.response.issuedAt + 1 },
      { ...state.created.response, notBefore: state.created.response.notBefore + 1 },
      { ...state.created.response, expiresAt: state.created.response.expiresAt - 1 },
      { ...state.created.response, signature: new Uint8Array(63) },
    ];

    for (const response of invalidResponses) {
      expect(() => encodeAgentBackgroundGrantResponseV2(response)).toThrow(
        /Agent background/,
      );
    }

    for (const response of [null, [], "response"]) {
      expect(() => encodeAgentBackgroundGrantResponseV2(
        response as never,
      )).toThrow("object");
    }
    const sameSizeWrongFields = { ...state.created.response } as Record<
      string,
      unknown
    >;
    delete sameSizeWrongFields["signature"];
    sameSizeWrongFields["signaturf"] = state.created.response.signature;
    expect(() => encodeAgentBackgroundGrantResponseV2(
      sameSizeWrongFields as never,
    )).toThrow("field set");
    expect(() => encodeAgentBackgroundGrantResponseV2({
      ...state.created.response,
      signature: new Uint8Array(
        MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2,
      ),
    })).toThrow(/Agent background/);
  });

  test("produces stable non-empty signing bytes", async () => {
    const state = await fixture();
    const { signature: _signature, ...unsigned } = state.created.response;
    const first = agentBackgroundGrantResponseSigningBytesV2(unsigned);
    const second = agentBackgroundGrantResponseSigningBytesV2(unsigned);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  test("accepts exact zero-time, equal-not-before, and maximum-TTL boundaries", async () => {
    const state = await fixture({
      issuedAt: 0,
      notBefore: 0,
      expiresAt: 10 * 60 * 1_000,
    });
    expect(() => encodeAgentBackgroundGrantResponseV2(
      state.created.response,
    )).not.toThrow();
    expect(await verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
      responseBytes: state.created.bytes,
      now: 0,
      resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
    })).toMatchObject({
      response: {
        issuedAt: 0,
        notBefore: 0,
        expiresAt: 10 * 60 * 1_000,
      },
    });
  });

  test("fails closed on signed-wire tampering and stale issuer authority", async () => {
    const state = await fixture();
    const tampered = state.created.bytes.slice();
    tampered[tampered.length - 1] = tampered.at(-1)! ^ 1;
    expect(verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
      responseBytes: tampered,
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("signature");
    expect(verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
      responseBytes: state.created.bytes,
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () => null,
    })).rejects.toThrow("not currently authorized");
  });

  test("enforces current time while historical verification remains time-independent", async () => {
    const state = await fixture();
    const resolve = () => state.issuer.publicKey;

    for (const now of [
      state.descriptor.notBefore - 1,
      state.descriptor.expiresAt,
      -1,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
        responseBytes: state.created.bytes,
        now,
        resolveCurrentIssuingDevicePublicKey: resolve,
      })).rejects.toThrow(/Agent background/);
    }

    const historical = await verifyHistoricalAgentBackgroundGrantResponseV2(
      state.crypto,
      {
        responseBytes: state.created.bytes,
        resolveHistoricalIssuingDevicePublicKey: (context) => {
          expect(context.purpose).toBe(
            "verify-historical-agent-background-grant-response-v2",
          );
          return state.issuer.publicKey;
        },
      },
    );
    expect(historical.responseHash).toEqual(state.created.hash);
  });

  test("rejects absent, malformed, mismatched, and wrong issuer keys", async () => {
    const state = await fixture();
    const otherIssuer = state.crypto.generateSigningKeyPair();
    const resolvers = [
      undefined,
      () => ({ slice: () => state.issuer.publicKey } as unknown as Uint8Array),
      () => new Uint8Array(31),
      () => otherIssuer.publicKey,
    ];

    for (const resolver of resolvers) {
      expect(verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: resolver as never,
      })).rejects.toThrow(/Agent background/);
    }
  });

  test("rejects invalid creation inputs before publishing a response", async () => {
    const state = await fixture();
    const create = (
      changes: Partial<Parameters<typeof createAgentBackgroundGrantResponseV2>[1]>,
    ) => createAgentBackgroundGrantResponseV2(state.crypto, {
      workDescriptorBytes: state.descriptorBytes,
      grantBytes: state.grantBytes,
      issuingHumanId: humanId("alice"),
      issuingDeviceAuthorizationRevision: authorizationRevision(17),
      issuingDeviceSigningPublicKey: state.issuer.publicKey,
      issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      ...changes,
    });
    const otherIssuer = state.crypto.generateSigningKeyPair();
    const tamperedGrant = state.grantBytes.slice();
    tamperedGrant[tamperedGrant.length - 1] =
      tamperedGrant[tamperedGrant.length - 1]! ^ 1;

    for (const changes of [
      { workDescriptorBytes: new Uint8Array() },
      { grantBytes: new Uint8Array() },
      { grantBytes: tamperedGrant },
      { issuingHumanId: humanId("charlie") },
      { issuingDeviceSigningPublicKey: new Uint8Array(31) },
      { issuingDeviceSigningPrivateKey: new Uint8Array(31) },
      { issuingDeviceSigningPublicKey: otherIssuer.publicKey },
      { issuingDeviceSigningPrivateKey: otherIssuer.privateKey },
    ]) {
      expect(() => create(changes)).toThrow(/Agent background|GrantV2/);
    }
  });

  test("zeroizes every temporary buffer on successful creation and verification", async () => {
    const state = await fixture();
    const trackedLengths = new Set([
      state.descriptorBytes.length,
      state.grantBytes.length,
      state.created.bytes.length,
    ]);
    const countZeroFills = async (run: () => unknown): Promise<number> => {
      const originalFill = Uint8Array.prototype.fill;
      let count = 0;
      Uint8Array.prototype.fill = function (
        value: number,
        start?: number,
        end?: number,
      ): Uint8Array {
        if (value === 0 && trackedLengths.has(this.length)) count += 1;
        return originalFill.call(this, value, start, end);
      };
      try {
        await run();
      } finally {
        Uint8Array.prototype.fill = originalFill;
      }
      return count;
    };

    const creationFills = await countZeroFills(() =>
      createAgentBackgroundGrantResponseV2(state.crypto, {
        workDescriptorBytes: state.descriptorBytes,
        grantBytes: state.grantBytes,
        issuingHumanId: humanId("alice"),
        issuingDeviceAuthorizationRevision: authorizationRevision(17),
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      })
    );
    const verificationFills = await countZeroFills(() =>
      verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
      })
    );
    const otherIssuer = state.crypto.generateSigningKeyPair();
    const failedCreationFills = await countZeroFills(() => {
      expect(() => createAgentBackgroundGrantResponseV2(state.crypto, {
        workDescriptorBytes: state.descriptorBytes,
        grantBytes: state.grantBytes,
        issuingHumanId: humanId("alice"),
        issuingDeviceAuthorizationRevision: authorizationRevision(17),
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: otherIssuer.privateKey,
      })).toThrow("keys do not match");
    });
    const failedVerificationFills = await countZeroFills(async () => {
      await verifyCurrentAgentBackgroundGrantResponseV2(state.crypto, {
        responseBytes: state.created.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () => otherIssuer.publicKey,
      }).catch(() => undefined);
    });
    const failedEncodingFills = await countZeroFills(() => {
      expect(() => encodeAgentBackgroundGrantResponseV2({
        ...state.created.response,
        signature: new Uint8Array(63),
      })).toThrow("signature");
    });

    expect({
      creationFills,
      failedCreationFills,
      failedEncodingFills,
      failedVerificationFills,
      verificationFills,
    }).toEqual({
      creationFills: 27,
      failedCreationFills: 10,
      failedEncodingFills: 5,
      failedVerificationFills: 17,
      verificationFills: 15,
    });
  });

  test("zeroizes the exact signing and verification inputs retained by crypto", async () => {
    const state = await fixture();
    const captured: Uint8Array[] = [];
    const originalSign = state.crypto.sign.bind(state.crypto);
    const originalVerify = state.crypto.verify.bind(state.crypto);
    state.crypto.sign = ((privateKey, message) => {
      captured.push(privateKey, message);
      return originalSign(privateKey, message);
    }) as typeof state.crypto.sign;
    state.crypto.verify = ((publicKey, message, signature) => {
      captured.push(publicKey, message, signature);
      return originalVerify(publicKey, message, signature);
    }) as typeof state.crypto.verify;

    try {
      createAgentBackgroundGrantResponseV2(state.crypto, {
        workDescriptorBytes: state.descriptorBytes,
        grantBytes: state.grantBytes,
        issuingHumanId: humanId("alice"),
        issuingDeviceAuthorizationRevision: authorizationRevision(17),
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      });
    } finally {
      state.crypto.sign = originalSign;
      state.crypto.verify = originalVerify;
    }

    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((bytes) =>
      bytes.every((value) => value === 0)
    )).toBe(true);
  });

  test("rejects non-byte and wrong-domain response wires", async () => {
    const state = await fixture();
    expect(() => decodeAgentBackgroundGrantResponseV2("wire" as never))
      .toThrow("Uint8Array");
    const wrongDomain = state.created.bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() => decodeAgentBackgroundGrantResponseV2(wrongDomain))
      .toThrow("domain mismatch");
  });

  test("rejects unknown fields, trailing bytes, and oversized response wire", async () => {
    const state = await fixture();
    expect(() => encodeAgentBackgroundGrantResponseV2({
      ...state.created.response,
      extra: true,
    } as typeof state.created.response)).toThrow("field set");
    expect(() => decodeAgentBackgroundGrantResponseV2(
      new Uint8Array([...state.created.bytes, 0]),
    )).toThrow("trailing");
    expect(() => decodeAgentBackgroundGrantResponseV2(
      new Uint8Array(MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2 + 1),
    )).toThrow("wire limit");
  });
});
