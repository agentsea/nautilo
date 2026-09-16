import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  namespaceBindingSigningBytes,
  parseNamespaceBinding,
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  namespaceKeyringEnvelopeSigningBytes,
  parseNamespaceKeyringEnvelope,
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  authorizeNamespaceBindingWriteV2,
  consumeAuthorizedNamespaceBindingWriteV2,
  type AuthorizedNamespaceBindingWriteV2,
} from "../../src/namespace/authorized-write.ts";
import {
  createNamespaceBinding,
  namespaceBindingHash,
  namespaceKeyringEnvelopeHash,
} from "../../src/namespace/bindings.ts";
import {
  createInitialNamespaceKeyrings,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import {
  NamespaceBindingPersistenceOutcomeUnknownV2,
  persistNamespaceBindingV2,
  type NamespaceBindingHeadCasStorageV2,
  type NamespaceBindingPersistenceV2,
} from "../../src/namespace/storage-coordinator.ts";
import {
  InMemoryV2Store,
  type NamespaceHeadExpectationV2,
} from "../../src/storage/v2-store.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
} from "../../src/v2-types/ids.ts";

function fixture(
  crypto: LatticeCrypto,
  signingPrivateKey: Uint8Array,
  signingPublicKey: Uint8Array,
  revision: number,
  previousBindingHash: Uint8Array | null,
  marker = revision + 1,
): NamespaceBindingPersistenceV2 {
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    namespaceId("namespace-atomic"),
  );
  const metadata = {
    domainId: cryptoDomainId(`domain-${String(revision)}`),
    domainEpoch: domainEpoch(revision + 1),
    previousBindingHash,
    committerDeviceId: cryptoDeviceId("device-alice"),
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: new Uint8Array(32).fill(0x40 + marker),
    keyring: {
      ...keyrings.human,
      accessRevision: accessRevision(revision),
    },
    metadata,
    committerSigningPrivateKey: signingPrivateKey,
    resolveCurrentCommitter: () => signingPublicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: new Uint8Array(32).fill(0x60 + marker),
    keyring: {
      ...keyrings.ai,
      accessRevision: accessRevision(revision),
    },
    metadata,
    committerSigningPrivateKey: signingPrivateKey,
    resolveCurrentCommitter: () => signingPublicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: signingPrivateKey,
    resolveCurrentCommitter: () => signingPublicKey,
  });
  const bindingBytes = serializeNamespaceBinding(binding);
  const bindingHash = namespaceBindingHash(binding);
  return Object.freeze({
    expectedHead: previousBindingHash === null
      ? null
      : Object.freeze({
        namespaceId: binding.namespaceId,
        accessRevision: accessRevision(Math.max(0, revision - 1)),
        bindingHash: previousBindingHash.slice(),
      }),
    nextHead: Object.freeze({
      namespaceId: binding.namespaceId,
      accessRevision: binding.accessRevision,
      bindingHash: bindingHash.slice(),
      domainId: binding.domainId,
      domainEpoch: binding.domainEpoch,
    }),
    signedBindingBytes: bindingBytes.slice(),
    humanKeyringEnvelopeBytes:
      serializeNamespaceKeyringEnvelope(humanEnvelope),
    aiKeyringEnvelopeBytes:
      serializeNamespaceKeyringEnvelope(aiEnvelope),
  });
}

function persist(
  crypto: LatticeCrypto,
  storage: NamespaceBindingHeadCasStorageV2,
  prepared: NamespaceBindingPersistenceV2,
  signingPublicKey: Uint8Array,
) {
  return persistNamespaceBindingV2({
    crypto,
    storage,
    prepared,
    resolveCurrentCommitter: () => signingPublicKey,
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function flipFirstByte(bytes: Uint8Array): void {
  bytes[0] = bytes[0]! ^ 0xff;
}

async function captureAuthorizedWrite(
  crypto: LatticeCrypto,
  prepared: NamespaceBindingPersistenceV2,
  signingPublicKey: Uint8Array,
): Promise<AuthorizedNamespaceBindingWriteV2> {
  let captured: AuthorizedNamespaceBindingWriteV2 | null = null;
  expect(await persistNamespaceBindingV2({
    crypto,
    prepared,
    resolveCurrentCommitter: () => signingPublicKey,
    storage: {
      compareAndSwapNamespaceBindingAndHead: async (authorized) => {
        captured = authorized;
        return "applied";
      },
    },
  })).toBe("applied");
  if (captured === null) throw new Error("missing authorized write");
  return captured;
}

async function expectRejectionMessage(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
}

describe("Namespace binding atomic storage coordinator", () => {
  test("applies one binding/head write, deduplicates replay, and rejects forks", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2250));
    const signing = crypto.generateSigningKeyPair();
    const store = new InMemoryV2Store();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );

    expect(
      await persist(crypto, store, initial, signing.publicKey),
    ).toBe("applied");
    expect(
      await persist(crypto, store, initial, signing.publicKey),
    ).toBe("duplicate");

    const fork = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
      9,
    );
    expect(await persist(crypto, store, fork, signing.publicKey)).toBe(
      "stale",
    );
    expect(await store.getNamespaceHead(initial.nextHead.namespaceId)).toEqual(
      initial.nextHead,
    );
    expect(
      await store.getBinding(
        initial.nextHead.namespaceId,
        initial.nextHead.accessRevision,
      ),
    ).toEqual({
      namespaceId: initial.nextHead.namespaceId,
      revision: initial.nextHead.accessRevision,
      bindingHash: initial.nextHead.bindingHash,
      previousBindingHash: null,
      signedBindingBytes: initial.signedBindingBytes,
      humanKeyringEnvelopeBytes: initial.humanKeyringEnvelopeBytes,
      aiKeyringEnvelopeBytes: initial.aiKeyringEnvelopeBytes,
    });
  });

  test("rejects an individually authentic but mismatched envelope pair before storage", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2254));
    const signing = crypto.generateSigningKeyPair();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const substitute = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
      9,
    );
    let storageCalls = 0;
    const storage: NamespaceBindingHeadCasStorageV2 = {
      compareAndSwapNamespaceBindingAndHead() {
        storageCalls += 1;
        return Promise.resolve("applied");
      },
    };

    expect(
      persistNamespaceBindingV2({
        crypto,
        storage,
        prepared: {
          ...initial,
          aiKeyringEnvelopeBytes:
            substitute.aiKeyringEnvelopeBytes,
        },
        resolveCurrentCommitter: () => signing.publicKey,
      }),
    ).rejects.toThrow(
      "Namespace binding record does not match its canonical binding and keyring envelopes",
    );
    expect(storageCalls).toBe(0);
  });

  test("reference storage rejects structural, cloned, and mutated capability bypasses", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2255));
    const signing = crypto.generateSigningKeyPair();
    const prepared = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    type AuthorizedWrite = Parameters<
      NamespaceBindingHeadCasStorageV2[
        "compareAndSwapNamespaceBindingAndHead"
      ]
    >[0];
    let captured: AuthorizedWrite | null = null;
    await persistNamespaceBindingV2({
      crypto,
      prepared,
      resolveCurrentCommitter: () => signing.publicKey,
      storage: {
        compareAndSwapNamespaceBindingAndHead: async (authorized) => {
          captured = authorized;
          return "applied";
        },
      },
    });
    const capturedCapability = captured as unknown as AuthorizedWrite;
    const reference = new InMemoryV2Store();
    expect(reference.compareAndSwapNamespaceBindingAndHead({
      expected: null,
      binding: {},
      next: {},
    } as never)).rejects.toThrow("authorized write capability");
    expect(reference.compareAndSwapNamespaceBindingAndHead(
      structuredClone(capturedCapability) as never,
    )).rejects.toThrow("authorized write capability");
    capturedCapability.next.bindingHash[0] =
      capturedCapability.next.bindingHash[0]! ^ 0xff;
    expect(reference.compareAndSwapNamespaceBindingAndHead(
      capturedCapability,
    )).rejects.toThrow("authorized write capability");
    const authorizationMutated = await captureAuthorizedWrite(
      crypto,
      prepared,
      signing.publicKey,
    );
    flipFirstByte(
      authorizationMutated.authorization.committerSigningPublicKeyHash,
    );
    expect(reference.compareAndSwapNamespaceBindingAndHead(
      authorizationMutated,
    )).rejects.toThrow("authorized write capability");
    expect(reference.compareAndSwapNamespaceBindingAndHead(
      prepared as never,
    )).rejects.toThrow("authorized write capability");
    expect(await reference.getNamespaceHead(prepared.nextHead.namespaceId))
      .toBeNull();
  });

  test("capability mint and consume detach every mutable byte family and consume exactly once", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_70));
    const signing = crypto.generateSigningKeyPair();
    const previousBindingHash = new Uint8Array(32).fill(0x31);
    const prepared = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      previousBindingHash,
    );
    const sourceBytes = {
      expected: prepared.expectedHead!.bindingHash.slice(),
      next: prepared.nextHead.bindingHash.slice(),
      signed: prepared.signedBindingBytes.slice(),
      human: prepared.humanKeyringEnvelopeBytes.slice(),
      ai: prepared.aiKeyringEnvelopeBytes.slice(),
    };
    const authorized = await captureAuthorizedWrite(
      crypto,
      prepared,
      signing.publicKey,
    );

    expect(authorized.expected).toEqual(prepared.expectedHead);
    expect(authorized.next).toEqual(prepared.nextHead);
    expect(authorized.binding).toMatchObject({
      namespaceId: prepared.nextHead.namespaceId,
      revision: prepared.nextHead.accessRevision,
      bindingHash: prepared.nextHead.bindingHash,
      previousBindingHash,
    });
    expect(authorized.expected).not.toBe(prepared.expectedHead);
    expect(authorized.next).not.toBe(prepared.nextHead);
    expect(authorized.expected!.bindingHash)
      .not.toBe(prepared.expectedHead!.bindingHash);
    expect(authorized.next.bindingHash)
      .not.toBe(prepared.nextHead.bindingHash);
    expect(authorized.binding.signedBindingBytes)
      .not.toBe(prepared.signedBindingBytes);
    expect(authorized.binding.humanKeyringEnvelope.ciphertext)
      .not.toBe(prepared.humanKeyringEnvelopeBytes);
    expect(authorized.binding.aiKeyringEnvelope.ciphertext)
      .not.toBe(prepared.aiKeyringEnvelopeBytes);
    expect(authorized.authorization).toEqual({
      bindingCommitter: {
        purpose: "namespace-binding",
        namespaceId: namespaceId(prepared.nextHead.namespaceId),
        domainId: cryptoDomainId(prepared.nextHead.domainId),
        domainEpoch: domainEpoch(prepared.nextHead.domainEpoch),
        accessRevision: accessRevision(prepared.nextHead.accessRevision),
        committerDeviceId: cryptoDeviceId("device-alice"),
        previousBindingHash,
      },
      keyringCommitter: {
        purpose: "namespace-keyring-envelope",
        namespaceId: namespaceId(prepared.nextHead.namespaceId),
        domainId: cryptoDomainId(prepared.nextHead.domainId),
        domainEpoch: domainEpoch(prepared.nextHead.domainEpoch),
        accessRevision: accessRevision(prepared.nextHead.accessRevision),
        committerDeviceId: cryptoDeviceId("device-alice"),
        previousBindingHash,
      },
      committerSigningPublicKeyHash: crypto.hash(signing.publicKey),
    });
    expect(authorized.authorization.bindingCommitter.previousBindingHash)
      .not.toBe(previousBindingHash);
    expect(authorized.authorization.keyringCommitter.previousBindingHash)
      .not.toBe(previousBindingHash);

    flipFirstByte(prepared.expectedHead!.bindingHash);
    flipFirstByte(prepared.nextHead.bindingHash);
    flipFirstByte(prepared.signedBindingBytes);
    flipFirstByte(prepared.humanKeyringEnvelopeBytes);
    flipFirstByte(prepared.aiKeyringEnvelopeBytes);
    expect(authorized.expected!.bindingHash).toEqual(sourceBytes.expected);
    expect(authorized.next.bindingHash).toEqual(sourceBytes.next);
    expect(authorized.binding.signedBindingBytes).toEqual(sourceBytes.signed);
    expect(authorized.binding.humanKeyringEnvelope.ciphertext)
      .toEqual(sourceBytes.human);
    expect(authorized.binding.aiKeyringEnvelope.ciphertext)
      .toEqual(sourceBytes.ai);

    const consumed = consumeAuthorizedNamespaceBindingWriteV2(authorized);
    expect(consumed).toEqual(authorized);
    expect(consumed.expected).not.toBe(authorized.expected);
    expect(consumed.binding).not.toBe(authorized.binding);
    expect(consumed.next).not.toBe(authorized.next);
    expect(consumed.expected!.bindingHash)
      .not.toBe(authorized.expected!.bindingHash);
    expect(consumed.binding.bindingHash)
      .not.toBe(authorized.binding.bindingHash);
    expect(consumed.binding.previousBindingHash)
      .not.toBe(authorized.binding.previousBindingHash);
    expect(consumed.binding.signedBindingBytes)
      .not.toBe(authorized.binding.signedBindingBytes);
    expect(consumed.binding.humanKeyringEnvelope.ciphertext)
      .not.toBe(authorized.binding.humanKeyringEnvelope.ciphertext);
    expect(consumed.binding.aiKeyringEnvelope.ciphertext)
      .not.toBe(authorized.binding.aiKeyringEnvelope.ciphertext);
    expect(consumed.next.bindingHash)
      .not.toBe(authorized.next.bindingHash);
    expect(consumed.authorization).not.toBe(authorized.authorization);
    expect(consumed.authorization.bindingCommitter)
      .not.toBe(authorized.authorization.bindingCommitter);
    expect(consumed.authorization.committerSigningPublicKeyHash)
      .not.toBe(authorized.authorization.committerSigningPublicKeyHash);
    flipFirstByte(authorized.binding.bindingHash);
    expect(consumed.binding.bindingHash)
      .toEqual(sourceBytes.next);
    expect(() => consumeAuthorizedNamespaceBindingWriteV2(authorized))
      .toThrow(
        "Namespace binding CAS requires an authorized write capability",
      );
  });

  test("capability rejects mutation of every mutable byte family, clones, and non-objects", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_71));
    const signing = crypto.generateSigningKeyPair();
    const prepared = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      new Uint8Array(32).fill(0x71),
    );
    const mutations = [
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(value.expected!.bindingHash);
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(value.binding.bindingHash);
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(value.binding.previousBindingHash!);
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(value.binding.signedBindingBytes);
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(value.binding.humanKeyringEnvelope.ciphertext);
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(value.binding.aiKeyringEnvelope.ciphertext);
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(value.next.bindingHash);
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(
          value.authorization.bindingCommitter.previousBindingHash!,
        );
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(
          value.authorization.keyringCommitter.previousBindingHash!,
        );
      },
      (value: AuthorizedNamespaceBindingWriteV2) => {
        flipFirstByte(
          value.authorization.committerSigningPublicKeyHash,
        );
      },
    ] as const;
    for (const mutate of mutations) {
      const authorized = await captureAuthorizedWrite(
        crypto,
        prepared,
        signing.publicKey,
      );
      mutate(authorized);
      expect(() => consumeAuthorizedNamespaceBindingWriteV2(authorized))
        .toThrow(
          "Namespace binding CAS requires an authorized write capability",
        );
    }

    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const nullExpected = await captureAuthorizedWrite(
      crypto,
      initial,
      signing.publicKey,
    );
    expect(nullExpected.expected).toBeNull();
    expect(consumeAuthorizedNamespaceBindingWriteV2(nullExpected).expected)
      .toBeNull();

    const bufferSource = Buffer.from(nullExpected.binding.bindingHash);
    const pristineBufferBytes = Uint8Array.from(bufferSource);
    const bufferCapability = authorizeNamespaceBindingWriteV2({
      expected: nullExpected.expected,
      binding: {
        ...nullExpected.binding,
        bindingHash: bufferSource,
      },
      next: nullExpected.next,
      authorization: nullExpected.authorization,
    });
    bufferSource.fill(0);
    const bufferConsumed =
      consumeAuthorizedNamespaceBindingWriteV2(bufferCapability);
    expect(bufferConsumed.binding.bindingHash)
      .toEqual(pristineBufferBytes);
    expect(Buffer.isBuffer(bufferConsumed.binding.bindingHash)).toBeFalse();

    const original = await captureAuthorizedWrite(
      crypto,
      initial,
      signing.publicKey,
    );
    expect(() => consumeAuthorizedNamespaceBindingWriteV2(
      structuredClone(original) as never,
    )).toThrow(
      "Namespace binding CAS requires an authorized write capability",
    );
    for (const value of [null, undefined, 0, "capability"]) {
      expect(() => consumeAuthorizedNamespaceBindingWriteV2(value as never))
        .toThrow(
          "Namespace binding CAS requires an authorized write capability",
        );
    }

    const authentic = await captureAuthorizedWrite(
      crypto,
      initial,
      signing.publicKey,
    );
    expect(() => authorizeNamespaceBindingWriteV2({
      expected: authentic.expected,
      binding: authentic.binding,
      next: authentic.next,
      authorization: {
        ...authentic.authorization,
        keyringCommitter: {
          ...authentic.authorization.keyringCommitter,
          domainId: cryptoDomainId("domain-substituted"),
        },
      },
    })).toThrow(
      "Namespace write authorization does not match the exact CAS transition",
    );
  });

  test("capability mint rejects every mismatched authorization coordinate", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_75));
    const signing = crypto.generateSigningKeyPair();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const initialWrite = await captureAuthorizedWrite(
      crypto,
      initial,
      signing.publicKey,
    );
    const update = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      initial.nextHead.bindingHash,
    );
    const updateWrite = await captureAuthorizedWrite(
      crypto,
      update,
      signing.publicKey,
    );
    const expectRejected = (
      value: Parameters<typeof authorizeNamespaceBindingWriteV2>[0],
      label: string,
    ) => {
      expect(
        () => authorizeNamespaceBindingWriteV2(value),
        label,
      ).toThrow(
        "Namespace write authorization does not match the exact CAS transition",
      );
    };
    const withAuthorization = (
      write: AuthorizedNamespaceBindingWriteV2,
      authorization: AuthorizedNamespaceBindingWriteV2["authorization"],
    ) => ({
      expected: write.expected,
      binding: write.binding,
      next: write.next,
      authorization,
    });

    for (const [label, authorization] of [
      [
        "binding purpose",
        {
          ...initialWrite.authorization,
          bindingCommitter: {
            ...initialWrite.authorization.bindingCommitter,
            purpose: "namespace-keyring-envelope",
          },
        },
      ],
      [
        "keyring purpose",
        {
          ...initialWrite.authorization,
          keyringCommitter: {
            ...initialWrite.authorization.keyringCommitter,
            purpose: "namespace-binding",
          },
        },
      ],
      ...([
        ["namespaceId", namespaceId("namespace-other")],
        ["domainId", cryptoDomainId("domain-other")],
        ["domainEpoch", domainEpoch(99)],
        ["accessRevision", accessRevision(9)],
        ["committerDeviceId", cryptoDeviceId("device-other")],
      ] as const).map(([field, value]) => [
        `keyring ${field}`,
        {
          ...initialWrite.authorization,
          keyringCommitter: {
            ...initialWrite.authorization.keyringCommitter,
            [field]: value,
          },
        },
      ] as const),
      [
        "initial previous hash mismatch",
        {
          ...initialWrite.authorization,
          keyringCommitter: {
            ...initialWrite.authorization.keyringCommitter,
            previousBindingHash: new Uint8Array(32).fill(0x75),
          },
        },
      ],
      ...([
        ["namespaceId", namespaceId("namespace-other")],
        ["domainId", cryptoDomainId("domain-other")],
        ["domainEpoch", domainEpoch(99)],
        ["accessRevision", accessRevision(9)],
      ] as const).map(([field, value]) => [
        `next ${field}`,
        {
          ...initialWrite.authorization,
          bindingCommitter: {
            ...initialWrite.authorization.bindingCommitter,
            [field]: value,
          },
          keyringCommitter: {
            ...initialWrite.authorization.keyringCommitter,
            [field]: value,
          },
        },
      ] as const),
      [
        "signing key hash length",
        {
          ...initialWrite.authorization,
          committerSigningPublicKeyHash: new Uint8Array(31),
        },
      ],
      [
        "non-null initial parent",
        {
          ...initialWrite.authorization,
          bindingCommitter: {
            ...initialWrite.authorization.bindingCommitter,
            previousBindingHash: new Uint8Array(32).fill(0x76),
          },
          keyringCommitter: {
            ...initialWrite.authorization.keyringCommitter,
            previousBindingHash: new Uint8Array(32).fill(0x76),
          },
        },
      ],
    ] as const) {
      expectRejected(
        withAuthorization(
          initialWrite,
          authorization as AuthorizedNamespaceBindingWriteV2["authorization"],
        ),
        label,
      );
    }

    for (const [label, authorization] of [
      [
        "null update keyring parent",
        {
          ...updateWrite.authorization,
          keyringCommitter: {
            ...updateWrite.authorization.keyringCommitter,
            previousBindingHash: null,
          },
        },
      ],
      [
        "short update keyring parent",
        {
          ...updateWrite.authorization,
          keyringCommitter: {
            ...updateWrite.authorization.keyringCommitter,
            previousBindingHash: new Uint8Array(31),
          },
        },
      ],
      [
        "null update parent",
        {
          ...updateWrite.authorization,
          bindingCommitter: {
            ...updateWrite.authorization.bindingCommitter,
            previousBindingHash: null,
          },
          keyringCommitter: {
            ...updateWrite.authorization.keyringCommitter,
            previousBindingHash: null,
          },
        },
      ],
      [
        "wrong update parent",
        {
          ...updateWrite.authorization,
          bindingCommitter: {
            ...updateWrite.authorization.bindingCommitter,
            previousBindingHash: new Uint8Array(32).fill(0x77),
          },
          keyringCommitter: {
            ...updateWrite.authorization.keyringCommitter,
            previousBindingHash: new Uint8Array(32).fill(0x77),
          },
        },
      ],
      [
        "short update parent",
        {
          ...updateWrite.authorization,
          bindingCommitter: {
            ...updateWrite.authorization.bindingCommitter,
            previousBindingHash:
              update.expectedHead!.bindingHash.slice(0, 31),
          },
          keyringCommitter: {
            ...updateWrite.authorization.keyringCommitter,
            previousBindingHash:
              update.expectedHead!.bindingHash.slice(0, 31),
          },
        },
      ],
    ] as const) {
      expectRejected(
        withAuthorization(
          updateWrite,
          authorization as AuthorizedNamespaceBindingWriteV2["authorization"],
        ),
        label,
      );
    }
  });

  test("coordinator detaches hostile resolver inputs and rejects unstable keys", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_76));
    const signing = crypto.generateSigningKeyPair();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    let storageCalls = 0;
    const storage: NamespaceBindingHeadCasStorageV2 = {
      compareAndSwapNamespaceBindingAndHead: async () => {
        storageCalls += 1;
        return "applied";
      },
    };
    for (const resolved of [
      "not-bytes",
      new Uint8Array(31),
      new Uint8Array(33),
    ]) {
      await expectRejectionMessage(
        persistNamespaceBindingV2({
          crypto,
          storage,
          prepared: initial,
          resolveCurrentCommitter: () => resolved as never,
        }),
        "Current Namespace committer signing public key must contain exactly 32 bytes",
      );
    }

    const mutableKey = Buffer.from(signing.publicKey);
    let keyCalls = 0;
    await expectRejectionMessage(
      persistNamespaceBindingV2({
        crypto,
        storage,
        prepared: initial,
        resolveCurrentCommitter: () => {
          keyCalls += 1;
          if (keyCalls === 2) flipFirstByte(mutableKey);
          return mutableKey;
        },
      }),
      "Current Namespace committer authorization keys differ",
    );

    const update = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      initial.nextHead.bindingHash,
    );
    let captured: AuthorizedNamespaceBindingWriteV2 | null = null;
    expect(await persistNamespaceBindingV2({
      crypto,
      prepared: update,
      storage: {
        compareAndSwapNamespaceBindingAndHead: async (authorized) => {
          captured = authorized;
          return "applied";
        },
      },
      resolveCurrentCommitter: (context) => {
        context.previousBindingHash?.fill(0);
        return signing.publicKey;
      },
    })).toBe("applied");
    expect(
      (captured as unknown as AuthorizedNamespaceBindingWriteV2)
        .authorization.bindingCommitter.previousBindingHash,
    ).toEqual(initial.nextHead.bindingHash);
    expect(storageCalls).toBe(0);
  });

  test("coordinator rejects different authenticated Human and AI committers", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_77));
    const signing = crypto.generateSigningKeyPair();
    const prepared = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const ai = parseNamespaceKeyringEnvelope(
      prepared.aiKeyringEnvelopeBytes,
    );
    const aiUnsigned = {
      ...ai,
      committerDeviceId: cryptoDeviceId("device-bob"),
      signature: new Uint8Array(ai.signature.length),
    };
    const substitutedAi = {
      ...aiUnsigned,
      signature: crypto.sign(
        signing.privateKey,
        namespaceKeyringEnvelopeSigningBytes(aiUnsigned),
      ),
    };
    const binding = parseNamespaceBinding(prepared.signedBindingBytes);
    const bindingUnsigned = {
      ...binding,
      aiKeyringEnvelopeHash:
        namespaceKeyringEnvelopeHash(substitutedAi),
      signature: new Uint8Array(binding.signature.length),
    };
    const substitutedBinding = {
      ...bindingUnsigned,
      signature: crypto.sign(
        signing.privateKey,
        namespaceBindingSigningBytes(bindingUnsigned),
      ),
    };
    const signedBindingBytes =
      serializeNamespaceBinding(substitutedBinding);
    const adversarial: NamespaceBindingPersistenceV2 = {
      ...prepared,
      nextHead: {
        ...prepared.nextHead,
        bindingHash: crypto.hash(signedBindingBytes),
      },
      signedBindingBytes,
      aiKeyringEnvelopeBytes:
        serializeNamespaceKeyringEnvelope(substitutedAi),
    };
    let storageCalls = 0;
    await expectRejectionMessage(
      persistNamespaceBindingV2({
        crypto,
        prepared: adversarial,
        storage: {
          compareAndSwapNamespaceBindingAndHead: async () => {
            storageCalls += 1;
            return "applied";
          },
        },
        resolveCurrentCommitter: () => signing.publicKey,
      }),
      "Current Namespace committer authorization contexts differ",
    );
    expect(storageCalls).toBe(0);
  });

  test("an adapter persists only durable capability fields and exact replay survives restart", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2256));
    const signing = crypto.generateSigningKeyPair();
    const prepared = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    let durable: Readonly<{
      binding: {
        namespaceId: string;
        revision: number;
        bindingHash: Uint8Array;
        signedBindingBytes: Uint8Array;
        humanKeyringEnvelopeBytes: Uint8Array;
        aiKeyringEnvelopeBytes: Uint8Array;
      };
      head: NamespaceBindingPersistenceV2["nextHead"];
    }> | null = null;
    let casCalls = 0;
    const adapter: NamespaceBindingHeadCasStorageV2 = {
      compareAndSwapNamespaceBindingAndHead: async (authorized) => {
        casCalls += 1;
        if (
          durable !== null
          && durable.head.namespaceId === authorized.next.namespaceId
          && durable.head.accessRevision
            === authorized.next.accessRevision
          && sameBytes(
            durable.head.bindingHash,
            authorized.next.bindingHash,
          )
          && sameBytes(
            durable.binding.signedBindingBytes,
            authorized.binding.signedBindingBytes,
          )
        ) {
          return "duplicate";
        }
        if (authorized.expected !== null || durable !== null) return "stale";
        durable = Object.freeze({
          binding: Object.freeze({
            namespaceId: authorized.binding.namespaceId,
            revision: authorized.binding.revision,
            bindingHash: authorized.binding.bindingHash.slice(),
            signedBindingBytes:
              authorized.binding.signedBindingBytes.slice(),
            humanKeyringEnvelopeBytes:
              authorized.binding.humanKeyringEnvelope.ciphertext.slice(),
            aiKeyringEnvelopeBytes:
              authorized.binding.aiKeyringEnvelope.ciphertext.slice(),
          }),
          head: Object.freeze({
            ...authorized.next,
            bindingHash: authorized.next.bindingHash.slice(),
          }),
        });
        return "applied";
      },
    };
    expect(await persist(
      crypto,
      adapter,
      prepared,
      signing.publicKey,
    )).toBe("applied");
    durable = structuredClone(durable);
    expect(await persist(
      crypto,
      adapter,
      structuredClone(prepared),
      signing.publicKey,
    )).toBe("duplicate");
    expect(casCalls).toBe(2);
    const restartedDurable = durable as unknown as {
      readonly binding: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(restartedDurable.binding)).toEqual([
      "namespaceId",
      "revision",
      "bindingHash",
      "signedBindingBytes",
      "humanKeyringEnvelopeBytes",
      "aiKeyringEnvelopeBytes",
    ]);
  });

  test("a crash before the atomic apply leaves no partial state and explicit retry applies", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2251));
    const signing = crypto.generateSigningKeyPair();
    const store = new InMemoryV2Store();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const crashBeforeApply = new Error("crash before atomic apply");
    let calls = 0;
    const testLocalTransport: NamespaceBindingHeadCasStorageV2 = {
      compareAndSwapNamespaceBindingAndHead() {
        calls += 1;
        throw crashBeforeApply;
      },
    };

    const error = await persist(
      crypto,
      testLocalTransport,
      initial,
      signing.publicKey,
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      name: "NamespaceBindingPersistenceOutcomeUnknownV2",
      cause: crashBeforeApply,
    });
    expect(calls).toBe(1);
    expect(
      await store.getNamespaceHead(initial.nextHead.namespaceId),
    ).toBeNull();
    expect(
      await store.getBinding(
        initial.nextHead.namespaceId,
        initial.nextHead.accessRevision,
      ),
    ).toBeNull();
    expect(
      await persist(crypto, store, initial, signing.publicKey),
    ).toBe("applied");
    expect(await store.getNamespaceHead(initial.nextHead.namespaceId)).toEqual(
      initial.nextHead,
    );
  });

  test("surfaces throw-after-commit ambiguity and explicit retry resolves duplicate", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2252));
    const signing = crypto.generateSigningKeyPair();
    const reference = new InMemoryV2Store();
    const prepared = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const delivered = new Error("transport lost after commit");
    let calls = 0;
    const ambiguous: NamespaceBindingHeadCasStorageV2 = {
      async compareAndSwapNamespaceBindingAndHead(authorized) {
        calls += 1;
        await reference.compareAndSwapNamespaceBindingAndHead(
          authorized,
        );
        throw delivered;
      },
    };

    const error = await persist(
      crypto,
      ambiguous,
      prepared,
      signing.publicKey,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(
      NamespaceBindingPersistenceOutcomeUnknownV2,
    );
    expect(error).toMatchObject({
      name: "NamespaceBindingPersistenceOutcomeUnknownV2",
      message:
        "Namespace binding storage outcome is ambiguous; retry must be explicit",
      cause: delivered,
    });
    expect(calls).toBe(1);
    expect(
      await persist(crypto, reference, prepared, signing.publicKey),
    ).toBe("duplicate");
  });

  test("rejects every coordinator and head shape with exact diagnostics before CAS", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_72));
    const signing = crypto.generateSigningKeyPair();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const next = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      initial.nextHead.bindingHash,
    );
    let casCalls = 0;
    const storage: NamespaceBindingHeadCasStorageV2 = {
      compareAndSwapNamespaceBindingAndHead: async () => {
        casCalls += 1;
        return "applied";
      },
    };
    const valid = {
      crypto,
      storage,
      prepared: next,
      resolveCurrentCommitter: () => signing.publicKey,
    };
    const inputCases: readonly [unknown, string][] = [
      [
        null,
        "Namespace binding persistence input must be an object",
      ],
      [
        0,
        "Namespace binding persistence input must be an object",
      ],
      [
        {
          crypto,
          storage,
          prepared: next,
          wrongResolver: () => signing.publicKey,
        },
        "Namespace binding persistence input has an invalid field set",
      ],
      [
        { ...valid, extra: true },
        "Namespace binding persistence input has an invalid field set",
      ],
      [
        { ...valid, prepared: null },
        "Namespace binding persistence material must be an object",
      ],
      [
        {
          ...valid,
          prepared: {
            expectedHead: next.expectedHead,
            nextHead: next.nextHead,
            signedBindingBytes: next.signedBindingBytes,
            humanKeyringEnvelopeBytes: next.humanKeyringEnvelopeBytes,
          },
        },
        "Namespace binding persistence material has an invalid field set",
      ],
      [
        {
          ...valid,
          prepared: {
            expectedHead: next.expectedHead,
            nextHead: next.nextHead,
            signedBindingBytes: next.signedBindingBytes,
            humanKeyringEnvelopeBytes: next.humanKeyringEnvelopeBytes,
            wrongEnvelopeBytes: next.aiKeyringEnvelopeBytes,
          },
        },
        "Namespace binding persistence material has an invalid field set",
      ],
      [
        { ...valid, resolveCurrentCommitter: "resolver" },
        "Current Namespace committer resolver is required",
      ],
    ];
    for (const [value, message] of inputCases) {
      await expectRejectionMessage(
        persistNamespaceBindingV2(value as never),
        message,
      );
    }

    const headCases: readonly [
      NamespaceBindingPersistenceV2,
      string,
    ][] = [
      [
        { ...next, expectedHead: {} as never },
        "Expected Namespace head has an invalid field set",
      ],
      [
        {
          ...next,
          expectedHead: {
            ...next.expectedHead!,
            bindingHash: new Uint8Array(31),
          },
        },
        "Expected Namespace binding hash must contain exactly 32 bytes",
      ],
      [
        { ...next, nextHead: {} as never },
        "Next Namespace head has an invalid field set",
      ],
      [
        {
          ...next,
          nextHead: {
            ...next.nextHead,
            bindingHash: new Uint8Array(31),
          },
        },
        "Next Namespace binding hash must contain exactly 32 bytes",
      ],
    ];
    for (const [prepared, message] of headCases) {
      await expectRejectionMessage(
        persistNamespaceBindingV2({
          ...valid,
          prepared,
        }),
        message,
      );
    }
    expect(casCalls).toBe(0);
  });

  test("rejects every binding/head transition coordinate independently", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_73));
    const signing = crypto.generateSigningKeyPair();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    const coordinateCases: readonly NamespaceBindingPersistenceV2[] = [
      {
        ...initial,
        nextHead: {
          ...initial.nextHead,
          namespaceId: namespaceId("namespace-substitute"),
        },
      },
      {
        ...initial,
        nextHead: {
          ...initial.nextHead,
          accessRevision: accessRevision(1),
        },
      },
      {
        ...initial,
        nextHead: {
          ...initial.nextHead,
          bindingHash: new Uint8Array(32).fill(0x73),
        },
      },
      {
        ...initial,
        nextHead: {
          ...initial.nextHead,
          domainId: cryptoDomainId("domain-substitute"),
        },
      },
      {
        ...initial,
        nextHead: {
          ...initial.nextHead,
          domainEpoch: domainEpoch(99),
        },
      },
    ];
    let casCalls = 0;
    const storage: NamespaceBindingHeadCasStorageV2 = {
      compareAndSwapNamespaceBindingAndHead: async () => {
        casCalls += 1;
        return "applied";
      },
    };
    for (const prepared of coordinateCases) {
      expect(persist(
        crypto,
        storage,
        prepared,
        signing.publicKey,
      )).rejects.toThrow(
        "Namespace binding persistence binding and next-head coordinates differ",
      );
    }

    const nonzeroInitial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      new Uint8Array(32).fill(0x74),
    );
    expect(persist(
      crypto,
      storage,
      { ...nonzeroInitial, expectedHead: null },
      signing.publicKey,
    )).rejects.toThrow(
      "Initial Namespace binding persistence requires revision zero and no previous hash",
    );
    const next = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      initial.nextHead.bindingHash,
    );
    const priorCases: readonly NamespaceBindingPersistenceV2[] = [
      {
        ...next,
        expectedHead: {
          ...next.expectedHead!,
          namespaceId: namespaceId("namespace-substitute"),
        },
      },
      {
        ...next,
        expectedHead: {
          ...next.expectedHead!,
          accessRevision: accessRevision(1),
        },
      },
      {
        ...next,
        expectedHead: {
          ...next.expectedHead!,
          bindingHash: new Uint8Array(32).fill(0x75),
        },
      },
    ];
    for (const prepared of priorCases) {
      expect(persist(
        crypto,
        storage,
        prepared,
        signing.publicKey,
      )).rejects.toThrow(
        "Namespace binding persistence requires one exact previous head",
      );
    }
    expect(casCalls).toBe(0);
  });

  test("resolves the current committer for every signed artifact and rejects invalid CAS statuses", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_74));
    const signing = crypto.generateSigningKeyPair();
    const prepared = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    let resolverCalls = 0;
    let casCalls = 0;
    expect(await persistNamespaceBindingV2({
      crypto,
      prepared,
      storage: {
        compareAndSwapNamespaceBindingAndHead: async () => {
          casCalls += 1;
          return "applied";
        },
      },
      resolveCurrentCommitter: () => {
        resolverCalls += 1;
        return signing.publicKey;
      },
    })).toBe("applied");
    expect(resolverCalls).toBe(3);
    expect(casCalls).toBe(1);

    const next = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      prepared.nextHead.bindingHash,
    );
    const expectedHash = next.expectedHead!.bindingHash.slice();
    const nextHash = next.nextHead.bindingHash.slice();
    let mutated = false;
    let authorized: AuthorizedNamespaceBindingWriteV2 | null = null;
    expect(await persistNamespaceBindingV2({
      crypto,
      prepared: next,
      storage: {
        compareAndSwapNamespaceBindingAndHead: async (value) => {
          authorized = value;
          return "applied";
        },
      },
      resolveCurrentCommitter: () => {
        if (!mutated) {
          mutated = true;
          flipFirstByte(next.expectedHead!.bindingHash);
          flipFirstByte(next.nextHead.bindingHash);
        }
        return signing.publicKey;
      },
    })).toBe("applied");
    const detached = authorized as unknown as
      AuthorizedNamespaceBindingWriteV2;
    expect(detached.expected!.bindingHash).toEqual(expectedHash);
    expect(detached.next.bindingHash).toEqual(nextHash);

    casCalls = 0;
    expect(persistNamespaceBindingV2({
      crypto,
      prepared,
      storage: {
        compareAndSwapNamespaceBindingAndHead: async () => {
          casCalls += 1;
          return "invalid" as never;
        },
      },
      resolveCurrentCommitter: () => signing.publicKey,
    })).rejects.toThrow(
      "Namespace binding storage returned an invalid CAS status",
    );
    expect(casCalls).toBe(1);
  });

  test("rejects stale competitors and current-authorization revocation without writes", async () => {
    const crypto = new LatticeCrypto(seededRng(0x2253));
    const signing = crypto.generateSigningKeyPair();
    const store = new InMemoryV2Store();
    const initial = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      0,
      null,
    );
    expect(await persist(crypto, store, initial, signing.publicKey)).toBe(
      "applied",
    );
    const next = fixture(
      crypto,
      signing.privateKey,
      signing.publicKey,
      1,
      initial.nextHead.bindingHash,
    );
    const staleExpected: NamespaceHeadExpectationV2 = {
      ...next.expectedHead!,
      bindingHash: new Uint8Array(32).fill(0xfe),
    };
    expect(
      persist(
        crypto,
        store,
        { ...next, expectedHead: staleExpected },
        signing.publicKey,
      ),
    ).rejects.toThrow("requires one exact previous head");

    let storageCalls = 0;
    const counting: NamespaceBindingHeadCasStorageV2 = {
      compareAndSwapNamespaceBindingAndHead() {
        storageCalls += 1;
        return Promise.resolve("applied");
      },
    };
    const rejection = await persistNamespaceBindingV2({
      crypto,
      storage: counting,
      prepared: next,
      resolveCurrentCommitter: () => null,
    }).catch((error: unknown) => error);
    expect(rejection).toEqual(
      new Error(
      "Namespace binding committer is absent from the authenticated historical roster",
      ),
    );
    expect(storageCalls).toBe(0);
    expect(await store.getBinding(next.nextHead.namespaceId, 1)).toBeNull();

    const replacement = crypto.generateSigningKeyPair();
    let authoritativeCommitterHash = crypto.hash(signing.publicKey);
    let resolverCalls = 0;
    let appliedWrites = 0;
    expect(await persistNamespaceBindingV2({
      crypto,
      prepared: initial,
      storage: {
        compareAndSwapNamespaceBindingAndHead: async (authorized) => {
          if (
            authorized.authorization.committerSigningPublicKeyHash.toHex()
              !== authoritativeCommitterHash.toHex()
          ) return "stale";
          appliedWrites += 1;
          return "applied";
        },
      },
      resolveCurrentCommitter: () => {
        resolverCalls += 1;
        if (resolverCalls === 3) {
          authoritativeCommitterHash = crypto.hash(replacement.publicKey);
        }
        return signing.publicKey;
      },
    })).toBe("stale");
    expect({ resolverCalls, appliedWrites }).toEqual({
      resolverCalls: 3,
      appliedWrites: 0,
    });
  });
});
