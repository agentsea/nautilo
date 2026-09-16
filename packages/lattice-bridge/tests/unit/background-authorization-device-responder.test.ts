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
  backgroundWorkDescriptorDigestV1,
  decodeBackgroundAuthorizationResponseV1,
  decodeProcessorCredentialV1,
  decodeProcessorSignerAuthorizationV1,
  encodeBackgroundWorkDescriptorV1,
  verifyCurrentBackgroundAuthorizationResponseV1,
  verifyCurrentProcessorSignerAuthorizationForCredentialV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES,
  BackgroundAuthorizationDeviceResponderError,
  fulfillProcessorBackgroundAuthorizationRequest,
  type BackgroundAuthorizationDeviceAuthority,
  type BackgroundAuthorizationDeviceRequest,
} from "../../src/index.ts";

const NOW = 1_800_000_000_000;

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

async function descriptorFixture(
  crypto: LatticeCrypto,
  overrides: Partial<BackgroundWorkDescriptorV1> = {},
): Promise<BackgroundWorkDescriptorV1> {
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  const outputIds = [
    objectId("journal-event-001"),
    objectId("journal-event-002"),
  ];
  return {
    formatVersion: 1,
    requestId: "background-request-001",
    recipientGeneration: 1,
    workKind: "stenographer.extraction",
    workId: "journal-batch-001",
    namespaceId: namespaceId("namespace-room-001"),
    domainId: cryptoDomainId("domain-room-001"),
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
      startSequence: 41,
      endSequence: 45,
      rebuildGeneration: 3,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [
      objectId("message-object-041"),
      objectId("message-object-042"),
    ],
    outputObjectIds: outputIds,
    outputObjectMetadata: outputIds.map((id, index) => ({
      objectId: id,
      objectType: "room_event",
      createdAt: unixTimestamp(NOW + index),
    })),
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 2,
    maximumPlaintextBytes: 128 * 1024,
    maximumCiphertextBytes: 256 * 1024,
    expectedDomainEpoch: domainEpoch(7),
    expectedNamespaceAccessRevision: accessRevision(11),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: "recipient-key-001",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
    idempotencyId: "background-idempotency-001",
    ...overrides,
  };
}

function request(
  crypto: LatticeCrypto,
  descriptor: BackgroundWorkDescriptorV1,
): BackgroundAuthorizationDeviceRequest {
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  return {
    formatVersion: 1,
    descriptorBytes,
    descriptorHash: backgroundWorkDescriptorDigestV1(crypto, descriptor),
  };
}

function authority(
  crypto: LatticeCrypto,
  descriptor: BackgroundWorkDescriptorV1,
  overrides: Partial<BackgroundAuthorizationDeviceAuthority> = {},
): BackgroundAuthorizationDeviceAuthority {
  const issuer = crypto.generateSigningKeyPair();
  return {
    humanId: humanId("human-alice"),
    humanState: "active",
    deviceId: cryptoDeviceId("device-alice-browser"),
    deviceHumanId: humanId("human-alice"),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(17),
    deviceSigningPublicKey: issuer.publicKey,
    deviceSigningPrivateKey: issuer.privateKey,
    namespaceId: descriptor.namespaceId,
    namespaceState: "active",
    membershipHumanId: humanId("human-alice"),
    membershipState: "active",
    namespaceAccessRevision: descriptor.expectedNamespaceAccessRevision,
    policyRevision: descriptor.expectedPolicyRevision,
    domainId: descriptor.domainId,
    domainState: "active",
    domainEpoch: descriptor.expectedDomainEpoch,
    processorKind: "stenographer",
    processorVersion: 1,
    processorState: "active",
    processorAuthorizationRevision: authorizationRevision(19),
    aiRoot: new Uint8Array(32).fill(0xa7),
    ...overrides,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof BackgroundAuthorizationDeviceResponderError
    ? error.code
    : undefined;
}

function containsBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
): boolean {
  outer:
  for (
    let offset = 0;
    offset <= haystack.length - needle.length;
    offset += 1
  ) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

async function expectResponderError(
  operation: Promise<unknown>,
  code: string,
  label?: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`${label ?? code} unexpectedly succeeded`);
  } catch (error) {
    expect(errorCode(error), label).toBe(code);
  }
}

describe("processor background-authorization device responder", () => {
  test("mints one exact recipient-bound credential, signer certificate, and response", async () => {
    const crypto = deterministicCrypto();
    const descriptor = await descriptorFixture(crypto);
    const current = authority(crypto, descriptor);
    const rootBefore = Uint8Array.from(current.aiRoot);
    const privateKeyBefore = Uint8Array.from(
      current.deviceSigningPrivateKey,
    );
    let authorityContext: Record<string, unknown> | undefined;

    const result = await fulfillProcessorBackgroundAuthorizationRequest({
      crypto,
      request: request(crypto, descriptor),
      resolveCurrentAuthority: (context) => {
        authorityContext = context as unknown as Record<string, unknown>;
        return Promise.resolve(current);
      },
    });

    expect(Object.keys(result).sort()).toEqual([
      "credentialHash",
      "expiresAt",
      "formatVersion",
      "recipientGeneration",
      "requestId",
      "responseBytes",
      "responseHash",
      "signerAuthorizationBytes",
      "signerAuthorizationHash",
    ]);
    expect(result.requestId).toBe(descriptor.requestId);
    expect(result.recipientGeneration).toBe(descriptor.recipientGeneration);
    expect(result.expiresAt).toBe(descriptor.expiresAt);
    expect(current.aiRoot).toEqual(rootBefore);
    expect(current.deviceSigningPrivateKey).toEqual(privateKeyBefore);
    expect("aiRoot" in result).toBe(false);
    expect("signerPrivateKey" in result).toBe(false);
    expect(containsBytes(result.responseBytes, rootBefore)).toBe(false);
    expect(
      containsBytes(result.signerAuthorizationBytes, rootBefore),
    ).toBe(false);
    expect(Object.keys(authorityContext ?? {}).sort()).toEqual([
      "descriptorHash",
      "domainId",
      "expectedDomainEpoch",
      "expectedNamespaceAccessRevision",
      "expectedPolicyRevision",
      "expiresAt",
      "issuedAt",
      "namespaceId",
      "notBefore",
      "processorAuthorizationRevision",
      "processorKind",
      "processorVersion",
      "purpose",
      "recipientGeneration",
      "requestId",
      "workId",
      "workKind",
    ]);
    expect("inputObjectIds" in (authorityContext ?? {})).toBe(false);
    expect("outputObjectIds" in (authorityContext ?? {})).toBe(false);
    expect("source" in (authorityContext ?? {})).toBe(false);

    const response =
      decodeBackgroundAuthorizationResponseV1(result.responseBytes);
    const credential = decodeProcessorCredentialV1(
      response.credentialBytes,
    );
    const signerAuthorization = decodeProcessorSignerAuthorizationV1(
      result.signerAuthorizationBytes,
    );
    expect(response.requestId).toBe(descriptor.requestId);
    expect(response.recipientPublicKey).toEqual(
      descriptor.recipientPublicKey,
    );
    expect(credential.encryptedSecret).not.toEqual(current.aiRoot);
    expect(signerAuthorization.outputObjectIds).toEqual(
      descriptor.outputObjectIds,
    );
    expect(signerAuthorization.processorAuthorizationRevision).toBe(
      current.processorAuthorizationRevision,
    );

    const responseVerified =
      await verifyCurrentBackgroundAuthorizationResponseV1(crypto, {
        responseBytes: result.responseBytes,
        now: NOW,
        resolveCurrentIssuingDevicePublicKey: (context) =>
          context.issuingHumanId === current.humanId
            && context.issuingDeviceId === current.deviceId
            && context.namespaceId === descriptor.namespaceId
            && context.domainId === descriptor.domainId
            && context.domainEpoch === descriptor.expectedDomainEpoch
            && context.namespaceAccessRevision
              === descriptor.expectedNamespaceAccessRevision
            && context.policyRevision === descriptor.expectedPolicyRevision
            ? current.deviceSigningPublicKey
            : null,
      });
    expect(responseVerified.responseHash).toEqual(result.responseHash);

    const pairVerified =
      await verifyCurrentProcessorSignerAuthorizationForCredentialV1(
        crypto,
        {
          authorizationBytes: result.signerAuthorizationBytes,
          credentialBytes: response.credentialBytes,
          now: NOW,
          resolveCurrentCredentialIssuerPublicKey: () =>
            current.deviceSigningPublicKey,
          resolveCurrentSignerIssuingDevicePublicKey: (context) =>
            context.processorAuthorizationRevision
                === current.processorAuthorizationRevision
              ? current.deviceSigningPublicKey
              : null,
        },
      );
    expect(pairVerified.signerAuthorization.authorizationHash).toEqual(
      result.signerAuthorizationHash,
    );
  });

  test("rejects malformed or noncanonical request wrappers before authority lookup", async () => {
    const crypto = deterministicCrypto();
    const descriptor = await descriptorFixture(crypto);
    const exact = request(crypto, descriptor);
    let resolutions = 0;
    const resolveCurrentAuthority = () => {
      resolutions += 1;
      return Promise.resolve(authority(crypto, descriptor));
    };

    for (const malformed of [
      null,
      { ...exact, unexpected: true },
      { ...exact, formatVersion: 2 },
      { ...exact, descriptorHash: new Uint8Array(31) },
      {
        ...exact,
        descriptorHash: new Uint8Array(exact.descriptorHash).fill(0),
      },
      {
        ...exact,
        descriptorBytes: new Uint8Array([...exact.descriptorBytes, 0]),
      },
    ]) {
      await expectResponderError(
        fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: malformed,
        resolveCurrentAuthority,
        }),
        "malformed_request",
      );
    }
    expect(resolutions).toBe(0);
  });

  test("rejects Agent subjects, excessive scope, future, expired, and overlong credentials", async () => {
    const cases: readonly [
      string,
      Partial<BackgroundWorkDescriptorV1>,
      string,
    ][] = [
      [
        "unsupported Agent subject",
        {
          workKind: "task.execute",
          purpose: "task.execute",
          subject: {
            kind: "agent",
            agentId: agentId("agent-genie"),
            runtimeGeneration: agentRuntimeGeneration(1),
            authorizationRevision: authorizationRevision(1),
          },
          source: {
            kind: "synthetic_payload",
            generation: 1,
            fingerprint: new Uint8Array(32).fill(0x51),
          },
        },
        "unsupported_request",
      ],
      [
        "excessive output inventory",
        {
          outputObjectIds: Array.from(
            { length: BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS + 1 },
            (_, index) => objectId(`journal-event-${index + 1}`),
          ),
          outputObjectMetadata: Array.from(
            { length: BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS + 1 },
            (_, index) => ({
              objectId: objectId(`journal-event-${index + 1}`),
              objectType: "room_event",
              createdAt: unixTimestamp(NOW + index),
            }),
          ),
          maximumOutputObjectCount:
            BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS + 1,
        },
        "excessive_scope",
      ],
      [
        "excessive plaintext",
        {
          maximumPlaintextBytes:
            BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES + 1,
        },
        "excessive_scope",
      ],
      [
        "future not-before",
        { issuedAt: NOW, notBefore: NOW + 1, expiresAt: NOW + 60_000 },
        "not_yet_valid",
      ],
      [
        "expired",
        { issuedAt: NOW - 60_000, notBefore: NOW - 60_000, expiresAt: NOW },
        "expired",
      ],
      [
        "overlong product TTL",
        {
          issuedAt: NOW,
          notBefore: NOW,
          expiresAt:
            NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS + 1,
        },
        "excessive_scope",
      ],
    ];

    for (const [label, overrides, expectedCode] of cases) {
      const crypto = deterministicCrypto();
      const descriptor = await descriptorFixture(crypto, overrides);
      await expectResponderError(
        fulfillProcessorBackgroundAuthorizationRequest({
          crypto,
          request: request(crypto, descriptor),
          resolveCurrentAuthority: () =>
            Promise.resolve(authority(crypto, descriptor)),
        }),
        expectedCode,
        label,
      );
    }
  });

  test("rejects removed, revoked, inactive, and stale current authority facts", async () => {
    const cases: readonly [
      string,
      Partial<BackgroundAuthorizationDeviceAuthority>,
      string,
    ][] = [
      ["removed Human", { humanState: "removed" }, "human_removed"],
      ["revoked device", { deviceState: "revoked" }, "device_revoked"],
      [
        "deleted Namespace",
        { namespaceState: "deleted" },
        "namespace_unavailable",
      ],
      [
        "removed membership",
        { membershipState: "removed" },
        "membership_removed",
      ],
      ["retired Domain", { domainState: "retired" }, "domain_unavailable"],
      [
        "disabled processor",
        { processorState: "disabled" },
        "processor_unavailable",
      ],
      [
        "device belongs to another Human",
        { deviceHumanId: humanId("human-bob") },
        "stale_authority",
      ],
      [
        "membership belongs to another Human",
        { membershipHumanId: humanId("human-bob") },
        "stale_authority",
      ],
      [
        "wrong Namespace",
        { namespaceId: namespaceId("namespace-room-002") },
        "stale_authority",
      ],
      [
        "wrong Domain",
        { domainId: cryptoDomainId("domain-room-002") },
        "stale_authority",
      ],
      [
        "stale Domain epoch",
        { domainEpoch: domainEpoch(8) },
        "stale_authority",
      ],
      [
        "stale Namespace revision",
        { namespaceAccessRevision: accessRevision(12) },
        "stale_authority",
      ],
      [
        "stale policy revision",
        { policyRevision: authorizationRevision(14) },
        "stale_authority",
      ],
      [
        "stale processor authorization revision",
        { processorAuthorizationRevision: authorizationRevision(20) },
        "stale_authority",
      ],
    ];

    for (const [label, overrides, expectedCode] of cases) {
      const crypto = deterministicCrypto();
      const descriptor = await descriptorFixture(crypto);
      await expectResponderError(
        fulfillProcessorBackgroundAuthorizationRequest({
          crypto,
          request: request(crypto, descriptor),
          resolveCurrentAuthority: () =>
            Promise.resolve(authority(crypto, descriptor, overrides)),
        }),
        expectedCode,
        label,
      );
    }
  });

  test("rejects absence of a currently eligible device without minting", async () => {
    const crypto = deterministicCrypto();
    const descriptor = await descriptorFixture(crypto);
    await expectResponderError(
      fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: request(crypto, descriptor),
        resolveCurrentAuthority: () => Promise.resolve(null),
      }),
      "authority_unavailable",
    );
  });

  test("fails closed with a typed outcome when device custody is corrupt", async () => {
    const crypto = deterministicCrypto();
    const descriptor = await descriptorFixture(crypto);
    const first = authority(crypto, descriptor);
    const second = crypto.generateSigningKeyPair();
    await expectResponderError(
      fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: request(crypto, descriptor),
        resolveCurrentAuthority: () => Promise.resolve({
          ...first,
          deviceSigningPrivateKey: second.privateKey,
        }),
      }),
      "authority_unavailable",
    );
  });
});
