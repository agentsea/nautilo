import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  AGENT_MANAGER_RECOVERY_DOMAIN,
  AGENT_MANAGER_RECOVERY_VERSION,
  agentManagerRecoveryPackageAad,
  agentManagerRecoveryPackageSigningBytes,
  assertCanonicalAgentManagerKeyring,
  decodeAgentManagerKeyring,
  decodeAgentManagerRecoveryPackage,
  encodeAgentManagerKeyring,
  openAgentManagerRecoveryPackage,
  publishAgentManagerRecoveryPackage,
  serializeAgentManagerRecoveryPackage,
  type AgentManagerAuthorityContextV2,
  type AgentManagerKeyClass,
  type AgentManagerKeyringV2,
  type AgentManagerRecoveryMetadataV2,
  type ResolveCurrentAgentManagerAuthorityV2,
} from "../../src/recovery/agent-manager-v2.ts";
import {
  recoveryKeyGeneration,
  recoveryPublicKeyDigest,
} from "../../src/format/recovery-v2.ts";
import {
  concatV2,
  encodeU32,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

const PACKAGE_AAD_FIXTURE =
  "000000306e617574696c6f2f6c6174746963652d63727970746f2f6167656e742d6d616e616765722d7265636f766572792f7632"
  + "000000156167656e742d6d616e616765722d7061636b61676500000002"
  + "0000000b68756d616e5f616c6963650000000b6167656e745f67656e6965"
  + "0000000772756e74696d650000000000000011000000107265636f766572795f616c6963655f34"
  + `000000000000000400000020${"99".repeat(32)}0000000000000002000000126465766963655f616c6963655f70686f6e65`
  + "00000000000007d0";
const PACKAGE_SIGNING_FIXTURE =
  `${PACKAGE_AAD_FIXTURE}00000020`
  + "fa22dfe1da9013b3c1145040acae9089e0c08bc1c1a0719614f4b73add6f6ef5";
const PACKAGE_WIRE_FIXTURE =
  `${PACKAGE_AAD_FIXTURE}00000003aabbcc00000040${"5a".repeat(64)}`;

class CaptureCrypto extends LatticeCrypto {
  sealedPlaintext: Uint8Array | null = null;
  openedPlaintext: Uint8Array | null = null;
  readonly signedMessages: Uint8Array[] = [];
  hpkeSealCalls = 0;
  hpkeOpenCalls = 0;

  override sign(
    signingPrivateKey: Uint8Array,
    message: Uint8Array,
  ): Uint8Array {
    this.signedMessages.push(message.slice());
    return super.sign(signingPrivateKey, message);
  }

  override async sealTo(
    recipientPublicKey: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    this.hpkeSealCalls++;
    this.sealedPlaintext = plaintext;
    return super.sealTo(recipientPublicKey, plaintext);
  }

  override async openSealed(
    recipientPrivateKey: Uint8Array,
    sealed: Uint8Array,
  ): Promise<Uint8Array | null> {
    this.hpkeOpenCalls++;
    const plaintext = await super.openSealed(recipientPrivateKey, sealed);
    this.openedPlaintext = plaintext;
    return plaintext;
  }
}

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function isZeroized(value: Uint8Array | null): boolean {
  return value !== null && value.every((byte) => byte === 0);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to throw");
}

async function rejectedMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

function keyring(
  keyClass: AgentManagerKeyClass = "runtime",
  generations = 3,
): AgentManagerKeyringV2 {
  return {
    formatVersion: AGENT_MANAGER_RECOVERY_VERSION,
    agentId: agentId("agent_genie"),
    keyClass,
    currentGeneration: agentRuntimeGeneration(generations - 1),
    generations: Array.from({ length: generations }, (_, generation) => ({
      generation: agentRuntimeGeneration(generation),
      key: bytes(0x30 + generation),
    })),
  };
}

function metadata(
  keyClass: AgentManagerKeyClass = "runtime",
  publicKeyDigest = bytes(0x99),
): AgentManagerRecoveryMetadataV2 {
  return {
    formatVersion: AGENT_MANAGER_RECOVERY_VERSION,
    managerHumanId: humanId("human_alice"),
    agentId: agentId("agent_genie"),
    keyClass,
    managerAuthorizationRevision: authorizationRevision(17),
    recoveryKeyId: "recovery_alice_4",
    recoveryGeneration: recoveryKeyGeneration(4),
    recoveryPublicKeyDigest: publicKeyDigest,
    currentGeneration: agentRuntimeGeneration(2),
    issuerDeviceId: cryptoDeviceId("device_alice_phone"),
    createdAt: unixTimestamp(2_000),
  };
}

async function setup(keyClass: AgentManagerKeyClass = "runtime") {
  const crypto = new CaptureCrypto(seededRng(0xa622));
  const recovery = await crypto.generateEncryptionKeyPair();
  const issuer = crypto.generateSigningKeyPair();
  const expectedMetadata = metadata(
    keyClass,
    recoveryPublicKeyDigest(recovery.publicKey),
  );
  const contexts: AgentManagerAuthorityContextV2[] = [];
  const resolveCurrentManagerAuthority:
    ResolveCurrentAgentManagerAuthorityV2 = (context) => {
      contexts.push(context);
      return issuer.publicKey;
    };
  const resolveTrustedCurrentRecoveryKey = () => ({
    humanId: expectedMetadata.managerHumanId,
    recoveryKeyId: expectedMetadata.recoveryKeyId,
    recoveryGeneration: expectedMetadata.recoveryGeneration,
    publicKeyDigest: expectedMetadata.recoveryPublicKeyDigest,
  });
  const published = await publishAgentManagerRecoveryPackage({
    crypto,
    metadata: expectedMetadata,
    keyring: keyring(keyClass),
    currentRecoveryKeyId: expectedMetadata.recoveryKeyId,
    currentRecoveryGeneration: expectedMetadata.recoveryGeneration,
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey,
    issuerSigningPrivateKey: issuer.privateKey,
    resolveCurrentManagerAuthority,
  });
  return {
    crypto,
    recovery,
    issuer,
    expectedMetadata,
    contexts,
    resolveCurrentManagerAuthority,
    resolveTrustedCurrentRecoveryKey,
    published,
  };
}

type ManagerRecoveryState = Awaited<ReturnType<typeof setup>>;
type PublishInput = Parameters<
  typeof publishAgentManagerRecoveryPackage
>[0];
type OpenInput = Parameters<typeof openAgentManagerRecoveryPackage>[0];

function republish(
  state: ManagerRecoveryState,
  overrides: Partial<PublishInput> = {},
) {
  return publishAgentManagerRecoveryPackage({
    crypto: state.crypto,
    metadata: state.expectedMetadata,
    keyring: keyring(state.expectedMetadata.keyClass),
    currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
    currentRecoveryGeneration: state.expectedMetadata.recoveryGeneration,
    recoveryPublicKey: state.recovery.publicKey,
    resolveTrustedCurrentRecoveryKey:
      state.resolveTrustedCurrentRecoveryKey,
    issuerSigningPrivateKey: state.issuer.privateKey,
    resolveCurrentManagerAuthority: state.resolveCurrentManagerAuthority,
    ...overrides,
  });
}

function reopen(
  state: ManagerRecoveryState,
  overrides: Partial<OpenInput> = {},
) {
  return openAgentManagerRecoveryPackage({
    crypto: state.crypto,
    packageBytes: state.published.packageBytes,
    expectedMetadata: state.expectedMetadata,
    currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
    currentRecoveryGeneration: state.expectedMetadata.recoveryGeneration,
    recoveryPrivateKey: state.recovery.privateKey,
    resolveTrustedCurrentRecoveryKey:
      state.resolveTrustedCurrentRecoveryKey,
    resolveCurrentManagerAuthority: state.resolveCurrentManagerAuthority,
    ...overrides,
  });
}

async function forgeManagerRecoveryPackage(
  state: ManagerRecoveryState,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = await state.crypto.sealTo(
    state.recovery.publicKey,
    plaintext,
  );
  const unsigned = {
    ...state.expectedMetadata,
    ciphertext,
  };
  return serializeAgentManagerRecoveryPackage({
    ...unsigned,
    signature: state.crypto.sign(
      state.issuer.privateKey,
      agentManagerRecoveryPackageSigningBytes(unsigned),
    ),
  });
}

describe("manager-authority Agent recovery packages", () => {
  test("validates every metadata and keyring field with exact hostile boundaries", () => {
    const expectedMetadata = metadata();
    expect(() => agentManagerRecoveryPackageAad(expectedMetadata)).not
      .toThrow();
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageAad(null as never)
    )).toBe("Agent manager recovery metadata must be an object");
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageAad(42 as never)
    )).toBe("Agent manager recovery metadata must be an object");
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageAad({
        ...expectedMetadata,
        formatVersion: 1,
      } as never)
    )).toBe("Agent manager recovery version is unsupported");
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageAad({
        ...expectedMetadata,
        keyClass: "owner",
      } as never)
    )).toBe(
      "Agent manager recovery key class must be runtime or management",
    );
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageAad({
        ...expectedMetadata,
        recoveryKeyId: "/",
      })
    )).toContain("Recovery key id");
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageAad({
        ...expectedMetadata,
        recoveryPublicKeyDigest: bytes(0x99, 31),
      })
    )).toBe(
      "Agent manager recovery public-key digest must contain exactly 32 bytes",
    );
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageAad({
        ...expectedMetadata,
        unexpected: true,
      } as AgentManagerRecoveryMetadataV2)
    )).toBe(
      "Agent manager recovery package contains unknown field unexpected",
    );

    const expectedKeyring = keyring();
    expect(() => assertCanonicalAgentManagerKeyring(expectedKeyring)).not
      .toThrow();
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring(null as never)
    )).toBe("Agent manager keyring must be an object");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring(42 as never)
    )).toBe("Agent manager keyring must be an object");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        formatVersion: 1,
      } as never)
    )).toBe("Agent manager keyring version is unsupported");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        keyClass: "owner",
      } as never)
    )).toBe(
      "Agent manager recovery key class must be runtime or management",
    );
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        generations: "generations",
      } as never)
    )).toBe("Agent manager keyring generations must be an array");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        currentGeneration: agentRuntimeGeneration(0),
        generations: [],
      })
    )).toBe(
      "Agent manager retained history must start at generation 0",
    );
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        unexpected: true,
      } as AgentManagerKeyringV2)
    )).toBe("Agent manager keyring contains unknown field unexpected");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        generations: [42, ...expectedKeyring.generations.slice(1)] as never,
      })
    )).toBe("Agent manager generation must be an object");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        generations: [null, ...expectedKeyring.generations.slice(1)] as never,
      })
    )).toBe("Agent manager generation must be an object");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        generations: [
          {
            ...expectedKeyring.generations[0]!,
            unexpected: true,
          },
          ...expectedKeyring.generations.slice(1),
        ] as never,
      })
    )).toBe("Agent manager generation contains unknown field unexpected");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        generations: [
          expectedKeyring.generations[0]!,
          {
            ...expectedKeyring.generations[1]!,
            generation: agentRuntimeGeneration(2),
          },
          expectedKeyring.generations[2]!,
        ],
      })
    )).toBe(
      "Agent manager retained history must be contiguous from generation 0",
    );
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        generations: [
          {
            ...expectedKeyring.generations[0]!,
            key: bytes(0x30, 31),
          },
          ...expectedKeyring.generations.slice(1),
        ],
      })
    )).toBe("Agent manager generation key must contain exactly 32 bytes");
    expect(thrownMessage(() =>
      assertCanonicalAgentManagerKeyring({
        ...expectedKeyring,
        currentGeneration: agentRuntimeGeneration(
          V2_LIMITS.retainedAgentGenerations,
        ),
        generations: Array.from(
          { length: V2_LIMITS.retainedAgentGenerations + 1 },
          () => expectedKeyring.generations[0]!,
        ),
      })
    )).toBe(
      `Agent manager retained generations exceeds the ${V2_LIMITS.retainedAgentGenerations} limit`,
    );
  });

  test("enforces package ciphertext, signature, decode, domain, and ownership boundaries", () => {
    const fixturePackage = {
      ...metadata(),
      ciphertext: Uint8Array.of(0xaa, 0xbb, 0xcc),
      signature: bytes(0x5a, V2_LIMITS.signatureBytes),
    };
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageSigningBytes({
        ...fixturePackage,
        ciphertext: "ciphertext" as never,
      })
    )).toBe("Agent manager recovery ciphertext must be bytes");
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageSigningBytes({
        ...fixturePackage,
        ciphertext: new Uint8Array(),
      })
    )).toBe(
      `Agent manager recovery ciphertext bytes must be between 1 and ${V2_LIMITS.ciphertextBytes}`,
    );
    expect(() =>
      agentManagerRecoveryPackageSigningBytes({
        ...fixturePackage,
        ciphertext: Uint8Array.of(1),
      })
    ).not.toThrow();
    expect(() =>
      agentManagerRecoveryPackageSigningBytes({
        ...fixturePackage,
        ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes),
      })
    ).not.toThrow();
    expect(thrownMessage(() =>
      agentManagerRecoveryPackageSigningBytes({
        ...fixturePackage,
        ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
      })
    )).toBe(
      `Agent manager recovery ciphertext bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
    );
    expect(thrownMessage(() =>
      serializeAgentManagerRecoveryPackage({
        ...fixturePackage,
        signature: bytes(0x5a, V2_LIMITS.signatureBytes - 1),
      })
    )).toBe(
      `Agent manager recovery signature must contain exactly ${V2_LIMITS.signatureBytes} bytes`,
    );

    const wire = serializeAgentManagerRecoveryPackage(fixturePackage);
    const decoded = decodeAgentManagerRecoveryPackage(wire);
    wire.fill(0);
    expect(decoded.ciphertext).toEqual(fixturePackage.ciphertext);
    expect(decoded.signature).toEqual(fixturePackage.signature);
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage("package" as never)
    )).toBe("Agent manager recovery package exceeds wire limits");
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage(
        new Uint8Array(V2_LIMITS.ciphertextBytes),
      )
    )).toBe("Agent manager recovery domain is unsupported");
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage(
        new Uint8Array(V2_LIMITS.ciphertextBytes + 2 * 1024 + 1),
      )
    )).toBe("Agent manager recovery package exceeds wire limits");

    const aad = agentManagerRecoveryPackageAad(fixturePackage);
    const emptyCiphertextWire = concatV2(
      aad,
      encodeU32(0),
      frame(fixturePackage.signature),
    );
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage(emptyCiphertextWire)
    )).toBe("Agent manager recovery ciphertext must not be empty");
    const shortSignatureWire = concatV2(
      aad,
      frame(fixturePackage.ciphertext),
      frame(bytes(0x5a, V2_LIMITS.signatureBytes - 1)),
    );
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage(shortSignatureWire)
    )).toBe(
      `Agent manager recovery signature must contain exactly ${V2_LIMITS.signatureBytes} bytes`,
    );

    const validWire = serializeAgentManagerRecoveryPackage(fixturePackage);
    const wrongDomain = validWire.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage(wrongDomain)
    )).toBe("Agent manager recovery domain is unsupported");
    const packageKindOffset = 4
      + new TextEncoder().encode(AGENT_MANAGER_RECOVERY_DOMAIN).length
      + 4;
    const wrongKind = validWire.slice();
    wrongKind[packageKindOffset] = wrongKind[packageKindOffset]! ^ 1;
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage(wrongKind)
    )).toBe("Agent manager recovery package kind is unsupported");

    const invalidRecoveryKeyId = validWire.slice();
    const keyId = new TextEncoder().encode("recovery_alice_4");
    const keyIdOffset = invalidRecoveryKeyId.findIndex((_, index) =>
      keyId.every(
        (byte, innerIndex) =>
          invalidRecoveryKeyId[index + innerIndex] === byte,
      )
    );
    expect(keyIdOffset).toBeGreaterThanOrEqual(0);
    invalidRecoveryKeyId[keyIdOffset] = 0x2f;
    expect(thrownMessage(() =>
      decodeAgentManagerRecoveryPackage(invalidRecoveryKeyId)
    )).toContain("Recovery key id");
  });

  test("owns validated metadata and rejects malformed authority records exactly", async () => {
    const state = await setup();
    const callerMetadata = {
      ...state.expectedMetadata,
      recoveryPublicKeyDigest:
        state.expectedMetadata.recoveryPublicKeyDigest.slice(),
    };
    const expectedDigest = callerMetadata.recoveryPublicKeyDigest.slice();
    let capturedContext: AgentManagerAuthorityContextV2 | null = null;
    await publishAgentManagerRecoveryPackage({
      crypto: state.crypto,
      metadata: callerMetadata,
      keyring: keyring(),
      currentRecoveryKeyId: callerMetadata.recoveryKeyId,
      currentRecoveryGeneration: callerMetadata.recoveryGeneration,
      recoveryPublicKey: state.recovery.publicKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      issuerSigningPrivateKey: state.issuer.privateKey,
      resolveCurrentManagerAuthority: (context) => {
        capturedContext = context;
        callerMetadata.recoveryPublicKeyDigest.fill(0);
        return state.issuer.publicKey;
      },
    });
    expect(capturedContext!.recoveryPublicKeyDigest).toEqual(expectedDigest);

    const publish = (overrides: {
      resolveTrustedCurrentRecoveryKey?:
        typeof state.resolveTrustedCurrentRecoveryKey;
      resolveCurrentManagerAuthority?:
        ResolveCurrentAgentManagerAuthorityV2;
    }) =>
      publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: state.expectedMetadata,
        keyring: keyring(),
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPublicKey: state.recovery.publicKey,
        resolveTrustedCurrentRecoveryKey:
          overrides.resolveTrustedCurrentRecoveryKey
          ?? state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: state.issuer.privateKey,
        resolveCurrentManagerAuthority:
          overrides.resolveCurrentManagerAuthority
          ?? state.resolveCurrentManagerAuthority,
      });
    expect(await rejectedMessage(() =>
      publish({
        resolveCurrentManagerAuthority: () => bytes(1, 31),
      })
    )).toBe(
      "Agent manager issuer signing public key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      publish({
        resolveTrustedCurrentRecoveryKey: () => null as never,
      })
    )).toBe(
      "Trusted current recovery-key record is required for the manager",
    );
    expect(await rejectedMessage(() =>
      publish({
        resolveTrustedCurrentRecoveryKey: () => ({
          ...state.resolveTrustedCurrentRecoveryKey(),
          humanId: humanId("human_mallory"),
        }),
      })
    )).toBe(
      "Trusted current recovery-key record belongs to another Human",
    );
  });

  test("rejects each publication identity and keyring mismatch independently", async () => {
    const state = await setup();
    expect(
      republish(state, { currentRecoveryKeyId: "/" }),
    ).rejects.toThrow("Current recovery key id");
    expect(
      republish(state, {
        currentRecoveryKeyId: "recovery_alice_5",
      }),
    ).rejects.toThrow(
      "publication does not target the current recovery key generation",
    );
    expect(
      republish(state, {
        currentRecoveryGeneration: recoveryKeyGeneration(5),
      }),
    ).rejects.toThrow(
      "publication does not target the current recovery key generation",
    );

    for (
      const mismatchedKeyring of [
        {
          ...keyring(),
          agentId: agentId("agent_other"),
        },
        keyring("management"),
        keyring("runtime", 2),
      ]
    ) {
      expect(
        republish(state, { keyring: mismatchedKeyring }),
      ).rejects.toThrow(
        "Agent manager recovery keyring does not match package metadata",
      );
    }

    expect(
      republish(state, { recoveryPublicKey: bytes(1, 31) }),
    ).rejects.toThrow("Agent manager recovery public key");
    expect(
      republish(state, { issuerSigningPrivateKey: bytes(1, 31) }),
    ).rejects.toThrow("Agent manager issuer signing private key");
  });

  test("rejects each trusted publication recipient coordinate independently", async () => {
    const state = await setup();
    const trusted = state.resolveTrustedCurrentRecoveryKey();
    const wrongTrustedRecords = [
      {
        ...trusted,
        recoveryKeyId: "recovery_alice_5",
      },
      {
        ...trusted,
        recoveryGeneration: recoveryKeyGeneration(5),
      },
      {
        ...trusted,
        publicKeyDigest: bytes(0x55),
      },
    ];
    for (const record of wrongTrustedRecords) {
      expect(
        republish(state, {
          resolveTrustedCurrentRecoveryKey: () => record,
        }),
      ).rejects.toThrow(
        "recipient is not the trusted current recovery key",
      );
    }
    expect(
      republish(state, {
        metadata: {
          ...state.expectedMetadata,
          recoveryPublicKeyDigest: bytes(0x55),
        },
      }),
    ).rejects.toThrow(
      "recipient is not the trusted current recovery key",
    );
  });

  test("enforces the exact publication ciphertext ceiling and owns crypto outputs", async () => {
    const state = await setup();
    class ReportedLengthCiphertext extends Uint8Array {
      constructor(private readonly reportedLength: number) {
        super([0xa5]);
      }

      override get length(): number {
        return this.reportedLength;
      }

      override slice(): Uint8Array<ArrayBuffer> {
        return Uint8Array.of(0xa5);
      }
    }

    state.crypto.sealTo = async () =>
      new ReportedLengthCiphertext(V2_LIMITS.ciphertextBytes);
    expect(await republish(state)).toBeDefined();
    state.crypto.sealTo = async () =>
      new ReportedLengthCiphertext(V2_LIMITS.ciphertextBytes + 1);
    expect(republish(state)).rejects.toThrow(
      "Agent manager recovery ciphertext exceeds format limits",
    );

    const ciphertext = Uint8Array.of(0x11, 0x12, 0x13);
    const signature = bytes(0x22, V2_LIMITS.signatureBytes);
    const originalSign = state.crypto.sign.bind(state.crypto);
    let signCalls = 0;
    state.crypto.sealTo = async () => ciphertext;
    state.crypto.sign = (privateKey, message) => {
      signCalls += 1;
      return signCalls === 1
        ? originalSign(privateKey, message)
        : signature;
    };
    const published = await republish(state);
    const expectedCiphertext = ciphertext.slice();
    const expectedSignature = signature.slice();
    ciphertext.fill(0);
    signature.fill(0);
    expect(published.package.ciphertext).toEqual(expectedCiphertext);
    expect(published.package.signature).toEqual(expectedSignature);
  });

  test("rejects each restore recovery-key coordinate independently", async () => {
    const state = await setup();
    expect(
      reopen(state, { currentRecoveryKeyId: "/" }),
    ).rejects.toThrow("Current recovery key id");
    expect(
      reopen(state, {
        currentRecoveryKeyId: "recovery_alice_5",
      }),
    ).rejects.toThrow(
      "package does not target the current recovery key generation",
    );
    expect(
      reopen(state, {
        currentRecoveryGeneration: recoveryKeyGeneration(5),
      }),
    ).rejects.toThrow(
      "package does not target the current recovery key generation",
    );
    expect(
      reopen(state, { recoveryPrivateKey: bytes(1, 31) }),
    ).rejects.toThrow("Agent manager recovery private key");

    const trusted = state.resolveTrustedCurrentRecoveryKey();
    for (
      const record of [
        {
          ...trusted,
          recoveryKeyId: "recovery_alice_5",
        },
        {
          ...trusted,
          recoveryGeneration: recoveryKeyGeneration(5),
        },
        {
          ...trusted,
          publicKeyDigest: bytes(0x55),
        },
      ]
    ) {
      expect(
        reopen(state, {
          resolveTrustedCurrentRecoveryKey: () => record,
        }),
      ).rejects.toThrow(
        "package does not match the trusted current recovery key",
      );
    }
  });

  test("zeroizes package-plaintext intermediates and decoded keys on inner failure", async () => {
    const state = await setup();
    const encodedLength = encodeAgentManagerKeyring(keyring()).length;
    const originalFill = Uint8Array.prototype.fill;
    const wiped: Uint8Array[] = [];
    const wipedReferences: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ) {
      if (value === 0) {
        wiped.push(this.slice());
        wipedReferences.push(this);
      }
      return originalFill.call(this, value, start, end);
    };
    try {
      await publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: state.expectedMetadata,
        keyring: keyring(),
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPublicKey: state.recovery.publicKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: state.issuer.privateKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      });
      const publishEncodedWiped = wiped.some((value) =>
        value.length === encodedLength && value.some((byte) => byte !== 0)
      );
      const publishFrameWiped = wiped.some((value) =>
        value.length === encodedLength + 4 && value.some((byte) => byte !== 0)
      );
      wiped.length = 0;
      wipedReferences.length = 0;

      const encoded = encodeAgentManagerKeyring(keyring());
      const malformedPlaintext = concatV2(
        frame(agentManagerRecoveryPackageAad(state.expectedMetadata)),
        frame(encoded),
        Uint8Array.of(0),
      );
      state.crypto.openSealed = async () => malformedPlaintext;
      expect(await rejectedMessage(() =>
        openAgentManagerRecoveryPackage({
          crypto: state.crypto,
          packageBytes: state.published.packageBytes,
          expectedMetadata: state.expectedMetadata,
          currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
          currentRecoveryGeneration:
            state.expectedMetadata.recoveryGeneration,
          recoveryPrivateKey: state.recovery.privateKey,
          resolveTrustedCurrentRecoveryKey:
            state.resolveTrustedCurrentRecoveryKey,
          resolveCurrentManagerAuthority:
            state.resolveCurrentManagerAuthority,
        })
      )).toContain("trailing bytes");
      expect(wipedReferences.some((value, index) =>
        value.length === encodedLength
        && wipedReferences.indexOf(value) === index
        && wipedReferences.filter((candidate) => candidate === value).length === 2
      )).toBe(true);
      for (const marker of [0x30, 0x31, 0x32]) {
        expect(
          wiped.filter((value) =>
            value.length === 32
            && value.every((byte) => byte === marker)
          ),
        ).toHaveLength(1);
      }

      state.crypto.openSealed = async () => Uint8Array.of(0);
      expect(await rejectedMessage(() =>
        openAgentManagerRecoveryPackage({
          crypto: state.crypto,
          packageBytes: state.published.packageBytes,
          expectedMetadata: state.expectedMetadata,
          currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
          currentRecoveryGeneration:
            state.expectedMetadata.recoveryGeneration,
          recoveryPrivateKey: state.recovery.privateKey,
          resolveTrustedCurrentRecoveryKey:
            state.resolveTrustedCurrentRecoveryKey,
          resolveCurrentManagerAuthority:
            state.resolveCurrentManagerAuthority,
        })
      )).toBe("truncated u32");
      expect(publishEncodedWiped).toBe(true);
      expect(publishFrameWiped).toBe(true);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(
      wiped.some((value) =>
        value.length === encodedLength && value.some((byte) => byte !== 0)
      ),
    ).toBe(true);
    for (const marker of [0x30, 0x31, 0x32]) {
      expect(
        wiped.filter((value) =>
          value.length === 32
          && value.every((byte) => byte === marker)
        ),
      ).toHaveLength(1);
    }
  });

  test("zeroizes temporary framed keys and every decoded key on failure", () => {
    const originalFill = Uint8Array.prototype.fill;
    const wiped: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ) {
      if (value === 0) wiped.push(this.slice());
      return originalFill.call(this, value, start, end);
    };
    try {
      const encoded = encodeAgentManagerKeyring(keyring());
      expect(() =>
        decodeAgentManagerKeyring(new Uint8Array([...encoded, 0]))
      ).toThrow("trailing bytes");
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(
      wiped.filter((value) =>
        value.length === 36
        && value[3] === 32
        && value.slice(4).some((byte) => byte !== 0)
      ),
    ).toHaveLength(3);
    expect(
      wiped.some((value) =>
        value.length === 32
        && value.every((byte) => byte === 0x30)
      ),
    ).toBe(true);
  });

  test("strict keyring decoder owns limits, discriminators, and failed-key cleanup", () => {
    const encoded = encodeAgentManagerKeyring(keyring());
    expect(thrownMessage(() =>
      decodeAgentManagerKeyring("keyring" as never)
    )).toBe("Agent manager keyring exceeds the plaintext limit");
    expect(thrownMessage(() =>
      decodeAgentManagerKeyring(new Uint8Array(V2_LIMITS.plaintextBytes))
    )).toBe("Agent manager recovery domain is unsupported");
    expect(thrownMessage(() =>
      decodeAgentManagerKeyring(
        new Uint8Array(V2_LIMITS.plaintextBytes + 1),
      )
    )).toBe("Agent manager keyring exceeds the plaintext limit");

    const wrongDomain = encoded.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(thrownMessage(() =>
      decodeAgentManagerKeyring(wrongDomain)
    )).toBe("Agent manager recovery domain is unsupported");
    const kindOffset = 4
      + new TextEncoder().encode(AGENT_MANAGER_RECOVERY_DOMAIN).length
      + 4;
    const wrongKind = encoded.slice();
    wrongKind[kindOffset] = wrongKind[kindOffset]! ^ 1;
    expect(thrownMessage(() =>
      decodeAgentManagerKeyring(wrongKind)
    )).toBe("Agent manager keyring kind is unsupported");
  });

  test("snapshots publication keys across HPKE and immediately opens the package", async () => {
    const state = await setup();
    const recoveryPublicKey = Buffer.from(state.recovery.publicKey);
    const issuerSigningPrivateKey = Buffer.from(state.issuer.privateKey);
    const originalSeal = state.crypto.sealTo.bind(state.crypto);
    const originalSign = state.crypto.sign.bind(state.crypto);
    let signingSnapshot: Uint8Array | null = null;
    let mutated = false;
    state.crypto.sign = (privateKey, message) => {
      signingSnapshot ??= privateKey;
      return originalSign(privateKey, message);
    };
    state.crypto.sealTo = async (...args) => {
      if (!mutated) {
        mutated = true;
        recoveryPublicKey.fill(0);
        issuerSigningPrivateKey.fill(0);
      }
      return originalSeal(...args);
    };
    const published = await publishAgentManagerRecoveryPackage({
      crypto: state.crypto,
      metadata: state.expectedMetadata,
      keyring: keyring(),
      currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
      currentRecoveryGeneration: state.expectedMetadata.recoveryGeneration,
      recoveryPublicKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      issuerSigningPrivateKey,
      resolveCurrentManagerAuthority:
        state.resolveCurrentManagerAuthority,
    });
    expect(isZeroized(signingSnapshot)).toBe(true);
    expect(Buffer.isBuffer(signingSnapshot)).toBe(false);
    const opened = await openAgentManagerRecoveryPackage({
      crypto: state.crypto,
      packageBytes: published.packageBytes,
      expectedMetadata: state.expectedMetadata,
      currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
      currentRecoveryGeneration: state.expectedMetadata.recoveryGeneration,
      recoveryPrivateKey: state.recovery.privateKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      resolveCurrentManagerAuthority:
        state.resolveCurrentManagerAuthority,
    });
    expect(opened).toEqual(keyring());
  });

  test("snapshots and wipes the recovery private key across HPKE restore", async () => {
    const state = await setup();
    const recoveryPrivateKey = Buffer.from(state.recovery.privateKey);
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    let privateSnapshot: Uint8Array | null = null;
    let mutated = false;
    state.crypto.openSealed = async (privateKey, ciphertext) => {
      privateSnapshot ??= privateKey;
      if (!mutated) {
        mutated = true;
        recoveryPrivateKey.fill(0);
      }
      return originalOpen(privateKey, ciphertext);
    };
    const opened = await openAgentManagerRecoveryPackage({
      crypto: state.crypto,
      packageBytes: state.published.packageBytes,
      expectedMetadata: state.expectedMetadata,
      currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
      currentRecoveryGeneration: state.expectedMetadata.recoveryGeneration,
      recoveryPrivateKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      resolveCurrentManagerAuthority:
        state.resolveCurrentManagerAuthority,
    });
    expect(opened).toEqual(keyring());
    expect(isZeroized(privateSnapshot)).toBe(true);
    expect(Buffer.isBuffer(privateSnapshot)).toBe(false);
  });

  test("wipes manager publication and restore private snapshots on HPKE failure", async () => {
    const publishState = await setup();
    const originalSign = publishState.crypto.sign.bind(publishState.crypto);
    let signingSnapshot: Uint8Array | null = null;
    publishState.crypto.sign = (privateKey, message) => {
      signingSnapshot ??= privateKey;
      return originalSign(privateKey, message);
    };
    publishState.crypto.sealTo = async () => {
      throw new Error("injected manager publication failure");
    };
    expect(publishAgentManagerRecoveryPackage({
      crypto: publishState.crypto,
      metadata: publishState.expectedMetadata,
      keyring: keyring(),
      currentRecoveryKeyId: publishState.expectedMetadata.recoveryKeyId,
      currentRecoveryGeneration:
        publishState.expectedMetadata.recoveryGeneration,
      recoveryPublicKey: publishState.recovery.publicKey,
      resolveTrustedCurrentRecoveryKey:
        publishState.resolveTrustedCurrentRecoveryKey,
      issuerSigningPrivateKey: publishState.issuer.privateKey,
      resolveCurrentManagerAuthority:
        publishState.resolveCurrentManagerAuthority,
    })).rejects.toThrow("injected manager publication failure");
    expect(isZeroized(signingSnapshot)).toBe(true);

    const openState = await setup();
    let privateSnapshot: Uint8Array | null = null;
    openState.crypto.openSealed = async (privateKey) => {
      privateSnapshot = privateKey;
      throw new Error("injected manager restore failure");
    };
    expect(openAgentManagerRecoveryPackage({
      crypto: openState.crypto,
      packageBytes: openState.published.packageBytes,
      expectedMetadata: openState.expectedMetadata,
      currentRecoveryKeyId: openState.expectedMetadata.recoveryKeyId,
      currentRecoveryGeneration:
        openState.expectedMetadata.recoveryGeneration,
      recoveryPrivateKey: openState.recovery.privateKey,
      resolveTrustedCurrentRecoveryKey:
        openState.resolveTrustedCurrentRecoveryKey,
      resolveCurrentManagerAuthority:
        openState.resolveCurrentManagerAuthority,
    })).rejects.toThrow("injected manager restore failure");
    expect(isZeroized(privateSnapshot)).toBe(true);
  });

  test("publishes and restores one complete detached Runtime or Management keyring", async () => {
    for (const keyClass of ["runtime", "management"] as const) {
      const state = await setup(keyClass);
      const opened = await openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: state.published.packageBytes,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      });

      expect(opened).toEqual(keyring(keyClass));
      expect(opened.generations).not.toBe(keyring(keyClass).generations);
      expect(opened.generations[0]!.key).not.toBe(
        keyring(keyClass).generations[0]!.key,
      );
      const before = opened.generations[0]!.key[0];
      state.published.packageBytes.fill(0);
      expect(opened.generations[0]!.key[0]).toBe(before);
      expect(state.contexts.at(-1)).toEqual({
        ...state.expectedMetadata,
        purpose: "agent-manager-recovery-restore",
      });
    }
  });

  test("locks the exact v2 domain and strict keyring framing", () => {
    expect(AGENT_MANAGER_RECOVERY_DOMAIN).toBe(
      "nautilo/lattice-crypto/agent-manager-recovery/v2",
    );
    const encoded = encodeAgentManagerKeyring(keyring());
    expect(decodeAgentManagerKeyring(encoded)).toEqual(keyring());
    expect(() =>
      decodeAgentManagerKeyring(new Uint8Array([...encoded, 0]))
    ).toThrow("trailing bytes");

    const fixturePackage = {
      ...metadata(),
      ciphertext: Uint8Array.of(0xaa, 0xbb, 0xcc),
      signature: bytes(0x5a, V2_LIMITS.signatureBytes),
    };
    expect(hex(agentManagerRecoveryPackageAad(fixturePackage))).toBe(
      PACKAGE_AAD_FIXTURE,
    );
    expect(hex(agentManagerRecoveryPackageSigningBytes(fixturePackage))).toBe(
      PACKAGE_SIGNING_FIXTURE,
    );
    expect(hex(serializeAgentManagerRecoveryPackage(fixturePackage))).toBe(
      PACKAGE_WIRE_FIXTURE,
    );
    expect(() =>
      encodeAgentManagerKeyring({
        ...keyring(),
        unexpected: "ignored",
      } as AgentManagerKeyringV2)
    ).toThrow("unknown field");
    expect(() =>
      serializeAgentManagerRecoveryPackage({
        ...fixturePackage,
        unexpected: "ignored",
      } as typeof fixturePackage)
    ).toThrow("unknown field");
  });

  test("domain-separates the manager-authority possession proof", async () => {
    const state = await setup();
    expect(state.crypto.signedMessages[0]).toEqual(concatV2(
      frameText(AGENT_MANAGER_RECOVERY_DOMAIN),
      frameText("agent-manager-issuer-proof"),
      agentManagerRecoveryPackageAad(state.expectedMetadata),
    ));
  });

  test("requires explicit current manager authority bound to every security field", async () => {
    const state = await setup();
    expect(state.contexts[0]).toEqual({
      ...state.expectedMetadata,
      purpose: "agent-manager-recovery-publish",
    });
    expect("domainId" in state.contexts[0]!).toBe(false);
    expect("domainRoot" in state.contexts[0]!).toBe(false);

    const hpkeCalls = state.crypto.hpkeSealCalls;
    expect(
      publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: state.expectedMetadata,
        keyring: keyring(),
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPublicKey: state.recovery.publicKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: state.issuer.privateKey,
        resolveCurrentManagerAuthority: () => null,
      }),
    ).rejects.toThrow("manager authorization");
    const wrongIssuer = state.crypto.generateSigningKeyPair();
    expect(
      publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: state.expectedMetadata,
        keyring: keyring(),
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPublicKey: state.recovery.publicKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: wrongIssuer.privateKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("does not match current authority");
    expect(state.crypto.hpkeSealCalls).toBe(hpkeCalls);

    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: state.published.packageBytes,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority: () => null,
      }),
    ).rejects.toThrow("manager authorization");
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: state.published.packageBytes,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority: () => wrongIssuer.publicKey,
      }),
    ).rejects.toThrow("signature");
  });

  test("rejects stale manager revision, wrong Human, Agent, class, and issuer", async () => {
    const state = await setup();
    const variants: AgentManagerRecoveryMetadataV2[] = [
      {
        ...state.expectedMetadata,
        managerHumanId: humanId("human_mallory"),
      },
      { ...state.expectedMetadata, agentId: agentId("agent_other") },
      { ...state.expectedMetadata, keyClass: "management" },
      {
        ...state.expectedMetadata,
        managerAuthorizationRevision: authorizationRevision(18),
      },
      {
        ...state.expectedMetadata,
        issuerDeviceId: cryptoDeviceId("device_mallory"),
      },
    ];
    for (const expectedMetadata of variants) {
      expect(
        openAgentManagerRecoveryPackage({
          crypto: state.crypto,
          packageBytes: state.published.packageBytes,
          expectedMetadata,
          currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
          currentRecoveryGeneration:
            state.expectedMetadata.recoveryGeneration,
          recoveryPrivateKey: state.recovery.privateKey,
          resolveTrustedCurrentRecoveryKey:
            state.resolveTrustedCurrentRecoveryKey,
          resolveCurrentManagerAuthority:
            state.resolveCurrentManagerAuthority,
        }),
      ).rejects.toThrow("expected manager context");
    }
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: state.published.packageBytes,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority: (context) =>
          context.managerAuthorizationRevision === 18
            ? state.issuer.publicKey
            : null,
      }),
    ).rejects.toThrow("manager authorization");
  });

  test("rejects an old recovery key generation before HPKE", async () => {
    const state = await setup();
    const before = state.crypto.hpkeSealCalls;
    expect(
      publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: state.expectedMetadata,
        keyring: keyring(),
        currentRecoveryKeyId: "recovery_alice_5",
        currentRecoveryGeneration: recoveryKeyGeneration(5),
        recoveryPublicKey: state.recovery.publicKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: state.issuer.privateKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("current recovery key");
    expect(state.crypto.hpkeSealCalls).toBe(before);

    const serverKey = await state.crypto.generateEncryptionKeyPair();
    expect(
      publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: state.expectedMetadata,
        keyring: keyring(),
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPublicKey: serverKey.publicKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: state.issuer.privateKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("trusted current recovery key");
    expect(state.crypto.hpkeSealCalls).toBe(before);

    const opensBefore = state.crypto.hpkeOpenCalls;
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: state.published.packageBytes,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: "recovery_alice_5",
        currentRecoveryGeneration: recoveryKeyGeneration(5),
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("current recovery key");
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: state.published.packageBytes,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey: () => ({
          humanId: state.expectedMetadata.managerHumanId,
          recoveryKeyId: "recovery_alice_5",
          recoveryGeneration: recoveryKeyGeneration(5),
          publicKeyDigest: bytes(0x55),
        }),
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("trusted current recovery key");
    expect(state.crypto.hpkeOpenCalls).toBe(opensBefore);
  });

  test("rejects signature, ciphertext, and package substitution", async () => {
    const state = await setup();
    const decoded = decodeAgentManagerRecoveryPackage(
      state.published.packageBytes,
    );
    const badSignature = serializeAgentManagerRecoveryPackage({
      ...decoded,
      signature: bytes(0x77, V2_LIMITS.signatureBytes),
    });
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: badSignature,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("signature");

    const tamperedCiphertext = decoded.ciphertext.slice();
    tamperedCiphertext[tamperedCiphertext.length - 1] =
      tamperedCiphertext[tamperedCiphertext.length - 1]! ^ 1;
    const badCiphertext = serializeAgentManagerRecoveryPackage({
      ...decoded,
      ciphertext: tamperedCiphertext,
    });
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: badCiphertext,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("signature");
  });

  test("rejects validly signed HPKE plaintext with mismatched inner metadata", async () => {
    const state = await setup();
    const wrongInner = {
      ...keyring("management"),
      currentGeneration: state.expectedMetadata.currentGeneration,
    };
    const plaintext = concatV2(
      frame(agentManagerRecoveryPackageAad(state.expectedMetadata)),
      frame(encodeAgentManagerKeyring(wrongInner)),
    );
    const ciphertext = await state.crypto.sealTo(
      state.recovery.publicKey,
      plaintext,
    );
    plaintext.fill(0);
    const unsigned = { ...state.expectedMetadata, ciphertext };
    const forged = {
      ...unsigned,
      signature: state.crypto.sign(
        state.issuer.privateKey,
        agentManagerRecoveryPackageSigningBytes(unsigned),
      ),
    };
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: serializeAgentManagerRecoveryPackage(forged),
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("inner and outer");
    expect(state.crypto.openedPlaintext).not.toBeNull();
    expect(state.crypto.openedPlaintext!.some((byte) => byte !== 0)).toBe(
      false,
    );
  });

  test("rejects every isolated inner-to-outer metadata mismatch", async () => {
    const state = await setup();
    const wrongEmbeddedMetadata = agentManagerRecoveryPackageAad({
      ...state.expectedMetadata,
      createdAt: unixTimestamp(2_001),
    });
    const variants = [
      concatV2(
        frame(wrongEmbeddedMetadata),
        frame(encodeAgentManagerKeyring(keyring())),
      ),
      concatV2(
        frame(agentManagerRecoveryPackageAad(state.expectedMetadata)),
        frame(encodeAgentManagerKeyring({
          ...keyring(),
          agentId: agentId("agent_other"),
        })),
      ),
      concatV2(
        frame(agentManagerRecoveryPackageAad(state.expectedMetadata)),
        frame(encodeAgentManagerKeyring(keyring("management"))),
      ),
      concatV2(
        frame(agentManagerRecoveryPackageAad(state.expectedMetadata)),
        frame(encodeAgentManagerKeyring(keyring("runtime", 2))),
      ),
    ];

    for (const plaintext of variants) {
      const packageBytes = await forgeManagerRecoveryPackage(
        state,
        plaintext,
      );
      plaintext.fill(0);
      expect(
        reopen(state, { packageBytes }),
      ).rejects.toThrow(
        "Agent manager recovery inner and outer metadata do not match",
      );
    }
  });

  test("wipes every decoded manager key after cloning a successful restore", async () => {
    const state = await setup();
    const originalFill = Uint8Array.prototype.fill;
    const wiped: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ) {
      if (value === 0) wiped.push(this.slice());
      return originalFill.call(this, value, start, end);
    };
    let opened: AgentManagerKeyringV2;
    try {
      opened = await reopen(state);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(opened!).toEqual(keyring());
    for (const value of [0x30, 0x31, 0x32]) {
      expect(
        wiped.some((candidate) =>
          candidate.length === 32
          && candidate.every((byte) => byte === value)
        ),
      ).toBe(true);
    }
  });

  test("rejects incomplete or excessive retained history before HPKE", async () => {
    const state = await setup();
    const incomplete: AgentManagerKeyringV2 = {
      ...keyring(),
      generations: [
        keyring().generations[0]!,
        {
          generation: agentRuntimeGeneration(2),
          key: bytes(0x32),
        },
      ],
    };
    expect(
      publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: state.expectedMetadata,
        keyring: incomplete,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPublicKey: state.recovery.publicKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: state.issuer.privateKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("complete");

    const excessive: AgentManagerKeyringV2 = {
      ...keyring(),
      currentGeneration: agentRuntimeGeneration(
        V2_LIMITS.retainedAgentGenerations,
      ),
      generations: Array.from(
        { length: V2_LIMITS.retainedAgentGenerations + 1 },
        (_, generation) => ({
          generation: agentRuntimeGeneration(generation),
          key: bytes(generation & 0xff),
        }),
      ),
    };
    const before = state.crypto.hpkeSealCalls;
    expect(
      publishAgentManagerRecoveryPackage({
        crypto: state.crypto,
        metadata: {
          ...state.expectedMetadata,
          currentGeneration: excessive.currentGeneration,
        },
        keyring: excessive,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPublicKey: state.recovery.publicKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        issuerSigningPrivateKey: state.issuer.privateKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("4096");
    expect(state.crypto.hpkeSealCalls).toBe(before);
  });

  test("zeroizes publish and restore plaintext while returning detached keys", async () => {
    const state = await setup();
    expect(state.crypto.sealedPlaintext).not.toBeNull();
    expect(state.crypto.sealedPlaintext!.some((byte) => byte !== 0)).toBe(
      false,
    );
    const opened = await openAgentManagerRecoveryPackage({
      crypto: state.crypto,
      packageBytes: state.published.packageBytes,
      expectedMetadata: state.expectedMetadata,
      currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
      currentRecoveryGeneration: state.expectedMetadata.recoveryGeneration,
      recoveryPrivateKey: state.recovery.privateKey,
      resolveTrustedCurrentRecoveryKey:
        state.resolveTrustedCurrentRecoveryKey,
      resolveCurrentManagerAuthority:
        state.resolveCurrentManagerAuthority,
    });
    expect(state.crypto.openedPlaintext).not.toBeNull();
    expect(state.crypto.openedPlaintext!.some((byte) => byte !== 0)).toBe(
      false,
    );
    expect(opened.generations[0]!.key).toEqual(bytes(0x30));
  });

  test("rejects malformed wire and wrong recovery private key", async () => {
    const state = await setup();
    class RejectSliceBytes extends Uint8Array {
      override slice(
        _start?: number,
        _end?: number,
      ): Uint8Array<ArrayBuffer> {
        throw new Error("oversized package was copied before its limit check");
      }
    }
    const hpkeCallsBeforeOversize = state.crypto.hpkeOpenCalls;
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: new RejectSliceBytes(
          V2_LIMITS.ciphertextBytes + (2 * 1024) + 1,
        ),
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("wire limits");
    expect(state.crypto.hpkeOpenCalls).toBe(hpkeCallsBeforeOversize);

    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: new Uint8Array([
          ...state.published.packageBytes,
          0,
        ]),
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: state.recovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("trailing bytes");
    const otherRecovery = await state.crypto.generateEncryptionKeyPair();
    expect(
      openAgentManagerRecoveryPackage({
        crypto: state.crypto,
        packageBytes: state.published.packageBytes,
        expectedMetadata: state.expectedMetadata,
        currentRecoveryKeyId: state.expectedMetadata.recoveryKeyId,
        currentRecoveryGeneration:
          state.expectedMetadata.recoveryGeneration,
        recoveryPrivateKey: otherRecovery.privateKey,
        resolveTrustedCurrentRecoveryKey:
          state.resolveTrustedCurrentRecoveryKey,
        resolveCurrentManagerAuthority:
          state.resolveCurrentManagerAuthority,
      }),
    ).rejects.toThrow("failed to decrypt");
  });
});
