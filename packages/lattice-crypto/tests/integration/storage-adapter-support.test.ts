import { describe, expect, test } from "bun:test";
import * as root from "@nautilo/lattice-crypto";
import * as wire from "@nautilo/lattice-crypto/wire";

const { storageAdapterSupportV2 } = wire;

function expectExactThrow(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact error: ${message}`);
}

function namespaceBindingWire(
  namespaceValue: string,
  revision: number,
) {
  const crypto = new root.LatticeCrypto();
  const previousBindingHash = revision === 0
    ? null
    : new Uint8Array(32).fill(0x31);
  const envelope = (keyClass: "human" | "ai") =>
    wire.serializeNamespaceKeyringEnvelopeV2({
      formatVersion: wire.NAMESPACE_KEYRING_FORMAT_VERSION_V2,
      namespaceId: root.namespaceId(namespaceValue),
      keyClass,
      domainId: root.cryptoDomainId("domain-adapter-namespace"),
      domainEpoch: root.domainEpoch(revision),
      accessRevision: root.accessRevision(revision),
      currentGeneration: root.namespaceGeneration(revision),
      previousBindingHash,
      committerDeviceId: root.cryptoDeviceId("device-adapter-namespace"),
      ciphertext: new Uint8Array(40).fill(keyClass === "human" ? 1 : 2),
      signature: new Uint8Array(64).fill(keyClass === "human" ? 3 : 4),
    });
  const humanKeyringEnvelopeBytes = envelope("human");
  const aiKeyringEnvelopeBytes = envelope("ai");
  const signedBindingBytes = wire.serializeNamespaceBindingV2({
    formatVersion: wire.NAMESPACE_BINDING_FORMAT_VERSION_V2,
    namespaceId: root.namespaceId(namespaceValue),
    domainId: root.cryptoDomainId("domain-adapter-namespace"),
    domainEpoch: root.domainEpoch(revision),
    accessRevision: root.accessRevision(revision),
    humanCurrentGeneration: root.namespaceGeneration(revision),
    aiCurrentGeneration: root.namespaceGeneration(revision),
    previousBindingHash,
    humanKeyringEnvelopeHash: crypto.hash(humanKeyringEnvelopeBytes),
    aiKeyringEnvelopeHash: crypto.hash(aiKeyringEnvelopeBytes),
    committerDeviceId: root.cryptoDeviceId("device-adapter-namespace"),
    signature: new Uint8Array(64).fill(5),
  });
  return {
    namespaceId: root.namespaceId(namespaceValue),
    revision: root.accessRevision(revision),
    bindingHash: crypto.hash(signedBindingBytes),
    previousBindingHash,
    signedBindingBytes,
    humanKeyringEnvelopeBytes,
    aiKeyringEnvelopeBytes,
  };
}

function encryptedObjectWire(objectValue: string) {
  return {
    objectId: root.objectId(objectValue),
    payloadBytes: wire.encodeEncryptedPayloadV2({
      formatVersion: wire.ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: {
        objectId: root.objectId(objectValue),
        keyClass: "human" as const,
        objectType: "adapter-record",
        createdAt: root.unixTimestamp(1),
      },
      ciphertext: new Uint8Array(40).fill(0x52),
    }),
  };
}

function objectAccessWire() {
  const crypto = new root.LatticeCrypto();
  const objectValue = root.objectId("object-access-adapter");
  const namespaceValue = root.namespaceId("namespace-access-adapter");
  const envelopeBytes = wire.encodeNamespaceObjectEnvelopeV2(
    root.wrapObjectDekForNamespace(
      crypto,
      new Uint8Array(32).fill(0x71),
      {
        objectId: objectValue,
        namespaceId: namespaceValue,
        keyClass: "human",
        keyGeneration: root.namespaceGeneration(0),
        bindingRevisionAtWrap: root.accessRevision(0),
      },
      new Uint8Array(32).fill(0x72),
    ),
  );
  const envelopeHash = crypto.hash(envelopeBytes);
  const signing = crypto.generateSigningKeyPair();
  const created = root.createObjectAccessManifest(
    crypto,
    {
      objectId: objectValue,
      payloadHash: new Uint8Array(32).fill(0x73),
      accessRevision: root.accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [envelopeHash],
      committerDeviceId: root.cryptoDeviceId("device-access-adapter"),
      hostAuthorizationRevision: root.authorizationRevision(0),
    },
    signing.privateKey,
  );
  return {
    head: {
      objectId: objectValue,
      accessRevision: root.accessRevision(0),
      manifestHash: created.hash,
      manifestBytes: created.bytes,
    },
    namespaceEnvelopes: [{
      namespaceId: namespaceValue,
      envelopeHash,
      envelopeBytes,
    }],
  };
}

function humanV5ObjectAccessWire(
  namespaceValue: string,
  marker: number,
  keyClass: "human" | "ai" = "ai",
) {
  const crypto = new root.LatticeCrypto();
  const objectValue = root.objectId("object-access-human-v5-adapter");
  const namespaceCoordinate = root.namespaceId(namespaceValue);
  const envelopeBytes = wire.encodeNamespaceObjectEnvelopeV2(
    root.wrapObjectDekForNamespace(
      crypto,
      new Uint8Array(32).fill(marker),
      {
        objectId: objectValue,
        namespaceId: namespaceCoordinate,
        keyClass,
        keyGeneration: root.namespaceGeneration(2),
        bindingRevisionAtWrap: root.accessRevision(3),
      },
      new Uint8Array(32).fill(marker + 1),
    ),
  );
  const envelopeHash = crypto.hash(envelopeBytes);
  const signing = crypto.generateSigningKeyPair();
  const created = root.createCommonHumanObjectAccessManifest(crypto, {
    objectId: objectValue,
    payloadHash: new Uint8Array(32).fill(0x74),
    accessRevision: root.accessRevision(0),
    previousManifestHash: null,
    envelopeHashes: [envelopeHash],
    signer: {
      kind: "human_device",
      subjectHumanId: root.humanId("human-access-adapter"),
      committerDeviceId: root.cryptoDeviceId("device-access-adapter"),
    },
    signerAuthorizationHash: null,
    hostAuthorizationRevision: root.authorizationRevision(4),
  }, signing.privateKey);
  return {
    state: {
      head: {
        objectId: objectValue,
        accessRevision: root.accessRevision(0),
        manifestHash: created.hash,
        manifestBytes: created.bytes,
      },
      namespaceEnvelopes: [{
        namespaceId: namespaceCoordinate,
        envelopeHash,
        envelopeBytes,
      }],
    },
    authorization: {
      kind: "human-v5-genesis" as const,
      context: {
        purpose: "persist-human-object-access-genesis-v5" as const,
        objectId: objectValue,
        payloadHash: new Uint8Array(32).fill(0x74),
        envelopes: [{
          objectId: objectValue,
          namespaceId: namespaceCoordinate,
          keyClass,
          keyGeneration: root.namespaceGeneration(2),
          bindingRevisionAtWrap: root.accessRevision(3),
          envelopeHash,
        }],
        subjectHumanId: root.humanId("human-access-adapter"),
        committerDeviceId: root.cryptoDeviceId("device-access-adapter"),
        hostAuthorizationRevision: root.authorizationRevision(4),
      },
      currentHostAuthorizationRevision: root.authorizationRevision(4),
      committerSigningPublicKeyHash: crypto.hash(signing.publicKey),
    },
  };
}

function grantWire(grantValue: string) {
  return wire.serializeGrantV2({
    formatVersion: wire.GRANT_V2_FORMAT_VERSION,
    id: root.grantId(grantValue),
    issuingDeviceId: root.cryptoDeviceId("device-grant-adapter"),
    recipientAgentId: root.agentId("agent-grant-adapter"),
    recipientKeyId: "invocation-key",
    scope: [root.humanId("human-grant-adapter")],
    operations: ["decrypt"],
    issuedAt: 1,
    expiresAt: 2,
    coveredDomains: [{
      domainId: root.cryptoDomainId("domain-grant-adapter"),
      domainEpoch: root.domainEpoch(1),
      agentAuthorizationRevision: root.authorizationRevision(1),
    }],
    encryptedSecret: new Uint8Array(40).fill(0x81),
    scheme: wire.GRANT_V2_SCHEME,
    signature: new Uint8Array(64).fill(0x82),
    singleUse: true,
    consumed: false,
  });
}

function recoveryWire(owner: string, generation: number) {
  return wire.serializeHumanRecoveryArchiveV2({
    formatVersion: wire.HUMAN_RECOVERY_FORMAT_VERSION_V2,
    humanId: root.humanId(owner),
    recoveryKeyId: `recovery-key-${String(generation)}`,
    recoveryGeneration: wire.recoveryKeyGenerationV2(generation),
    recoveryPublicKeyDigest: new Uint8Array(32).fill(0x91),
    issuerDeviceId: root.cryptoDeviceId("device-recovery-adapter"),
    createdAt: root.unixTimestamp(1),
    packages: [],
    signature: new Uint8Array(64).fill(0x92),
  });
}

describe("versioned storage adapter support", () => {
  test("is a frozen wire-only persistence boundary", () => {
    expect(Object.isFrozen(storageAdapterSupportV2)).toBeTrue();
    expect("storageAdapterSupportV2" in root).toBeFalse();
    expect(Object.keys(storageAdapterSupportV2).sort()).toEqual([
      "consumeAgentRuntimeAuthorizationTransitionWrite",
      "consumeAgentRuntimeChallengeReservationWrite",
      "consumeAgentRuntimeInitializationWrite",
      "consumeAgentRuntimeRotationWrite",
      "consumeNamespaceBindingWrite",
      "consumeObjectAccessWrite",
      "consumeProviderHeadWrite",
      "humanV5GenesisAuthorizationMatchesState",
      "validateAgentRuntimeAtomicState",
      "validateAgentRuntimeChallengeReservationExpectation",
      "validateAgentRuntimeRotationExpectation",
      "validateDomain",
      "validateEncryptedObject",
      "validateGrant",
      "validateNamespaceBinding",
      "validateNamespaceHead",
      "validateObjectAccessAuthorizationExpectation",
      "validateObjectAccessHead",
      "validateObjectAccessState",
      "validateProviderState",
      "validateRecoveryArchive",
      "validateRecoveryArchiveExpectation",
    ]);
  });

  test("rejects forged capabilities instead of exposing an authorization bypass", () => {
    for (const consume of [
      storageAdapterSupportV2.consumeProviderHeadWrite,
      storageAdapterSupportV2.consumeNamespaceBindingWrite,
      storageAdapterSupportV2.consumeObjectAccessWrite,
      storageAdapterSupportV2.consumeAgentRuntimeInitializationWrite,
      storageAdapterSupportV2.consumeAgentRuntimeChallengeReservationWrite,
      storageAdapterSupportV2.consumeAgentRuntimeRotationWrite,
      storageAdapterSupportV2.consumeAgentRuntimeAuthorizationTransitionWrite,
    ]) {
      expect(() => consume({} as never)).toThrow("authorized");
    }
  });

  test("validates and detaches durable public records", () => {
    const participants = [root.humanId("human-alice")];
    const digest = Buffer.from(root.participantDigest(participants));
    const roster = Buffer.from([1, 2, 3]);
    const domain = {
      id: root.cryptoDomainId("domain-adapter-support"),
      participantDigest: digest,
      participants,
      epoch: root.domainEpoch(0),
      authorizationRevision: root.authorizationRevision(0),
      rosterBytes: roster,
    };

    const validated = storageAdapterSupportV2.validateDomain(domain);
    expect(validated).toEqual(domain);
    expect(validated).not.toBe(domain);
    expect(validated.participantDigest).not.toBe(digest);
    expect(validated.rosterBytes).not.toBe(roster);
    expect(Buffer.isBuffer(validated.participantDigest)).toBeFalse();
    expect(Buffer.isBuffer(validated.rosterBytes)).toBeFalse();

    digest.fill(0);
    roster.fill(0);
    expect(validated.participantDigest).toEqual(
      root.participantDigest(participants),
    );
    expect(validated.rosterBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(() =>
      storageAdapterSupportV2.validateDomain({
        ...validated,
        participantDigest: new Uint8Array(32),
      })
    ).toThrow("does not match canonical participants");
  });

  test("rejects every malformed Domain coordinate at the adapter boundary", () => {
    const participants = [root.humanId("human-alice")];
    const exact = {
      id: root.cryptoDomainId("domain-adapter-validation"),
      participantDigest: root.participantDigest(participants),
      participants,
      epoch: root.domainEpoch(0),
      authorizationRevision: root.authorizationRevision(0),
      rosterBytes: new Uint8Array([1, 2, 3]),
    };
    const invalid: readonly [string, unknown][] = [
      [
        "Crypto Domain record has an invalid field set",
        { ...exact, unexpected: true },
      ],
      [
        "Crypto Domain participants must be an array",
        { ...exact, participants: "human-alice" },
      ],
      [
        "Crypto Domain participants must be in canonical unsigned UTF-8 order",
        {
          ...exact,
          participants: [
            root.humanId("human-bob"),
            root.humanId("human-alice"),
          ],
        },
      ],
      [
        "Crypto Domain participant digest must be exactly 32 bytes",
        { ...exact, participantDigest: new Uint8Array(31) },
      ],
      [
        "Crypto Domain roster bytes must be encoded bytes",
        { ...exact, rosterBytes: "roster" },
      ],
      [
        "Crypto Domain participant digest does not match canonical participants",
        { ...exact, participantDigest: new Uint8Array(32) },
      ],
    ];
    for (const [message, candidate] of invalid) {
      expectExactThrow(
        () => storageAdapterSupportV2.validateDomain(candidate as never),
        message,
      );
    }
  });

  test("validates, detaches, and diagnoses provider public state", () => {
    const stateHash = new Uint8Array(32).fill(0x41);
    const rosterBytes = new Uint8Array([4, 5, 6]);
    const exact = {
      head: {
        providerId: "provider-v2",
        domainId: root.cryptoDomainId("domain-provider-adapter"),
        epoch: root.domainEpoch(2),
        stateHash,
      },
      rosterBytes,
    };
    const validated = storageAdapterSupportV2.validateProviderState(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.head).not.toBe(exact.head);
    expect(validated.head.stateHash).not.toBe(stateHash);
    expect(validated.rosterBytes).not.toBe(rosterBytes);
    stateHash.fill(0);
    rosterBytes.fill(0);
    expect(validated.head.stateHash).toEqual(new Uint8Array(32).fill(0x41));
    expect(validated.rosterBytes).toEqual(new Uint8Array([4, 5, 6]));

    for (const [message, candidate] of [
      [
        "Domain provider public state has an invalid field set",
        { ...validated, unexpected: true },
      ],
      [
        "Domain provider head has an invalid field set",
        { ...validated, head: { ...validated.head, unexpected: true } },
      ],
      [
        "Domain provider head state hash must be exactly 32 bytes",
        {
          ...validated,
          head: { ...validated.head, stateHash: new Uint8Array(31) },
        },
      ],
      [
        "Domain provider roster bytes must be encoded bytes",
        { ...validated, rosterBytes: "roster" },
      ],
    ] as const) {
      expectExactThrow(
        () => storageAdapterSupportV2.validateProviderState(candidate as never),
        message,
      );
    }
  });

  test("hydrates and binds every Namespace durable coordinate", () => {
    const exact = namespaceBindingWire("namespace-adapter", 1);
    const validated = storageAdapterSupportV2.validateNamespaceBinding(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    for (const field of [
      "bindingHash",
      "previousBindingHash",
      "signedBindingBytes",
      "humanKeyringEnvelopeBytes",
      "aiKeyringEnvelopeBytes",
    ] as const) {
      expect(validated[field]).not.toBe(exact[field]);
    }
    const genesis = namespaceBindingWire("namespace-adapter-genesis", 0);
    expect(storageAdapterSupportV2.validateNamespaceBinding(genesis))
      .toEqual(genesis);
    const changedHash = new Uint8Array(32).fill(0xee);
    for (const candidate of [
      { ...exact, namespaceId: root.namespaceId("namespace-other") },
      { ...exact, revision: root.accessRevision(2) },
      { ...exact, bindingHash: changedHash },
      { ...exact, previousBindingHash: changedHash },
      { ...exact, previousBindingHash: null },
      { ...genesis, previousBindingHash: changedHash },
    ]) {
      expectExactThrow(
        () => storageAdapterSupportV2.validateNamespaceBinding(candidate),
        "Namespace binding durable coordinates do not match canonical wire bytes",
      );
    }
    expectExactThrow(
      () =>
        storageAdapterSupportV2.validateNamespaceBinding({
          ...exact,
          unexpected: true,
        } as never),
      "Namespace binding wire record has an invalid field set",
    );
  });

  test("validates Namespace heads without retaining hash bytes", () => {
    const bindingHash = new Uint8Array(32).fill(0x61);
    const exact = {
      namespaceId: root.namespaceId("namespace-head-adapter"),
      accessRevision: root.accessRevision(2),
      bindingHash,
      domainId: root.cryptoDomainId("domain-head-adapter"),
      domainEpoch: root.domainEpoch(3),
    };
    const validated = storageAdapterSupportV2.validateNamespaceHead(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.bindingHash).not.toBe(bindingHash);
    bindingHash.fill(0);
    expect(validated.bindingHash).toEqual(new Uint8Array(32).fill(0x61));
    for (const [message, candidate] of [
      [
        "Namespace head has an invalid field set",
        { ...validated, unexpected: true },
      ],
      [
        "Namespace head binding hash must be exactly 32 bytes",
        { ...validated, bindingHash: new Uint8Array(31) },
      ],
    ] as const) {
      expectExactThrow(
        () => storageAdapterSupportV2.validateNamespaceHead(candidate as never),
        message,
      );
    }
  });

  test("hydrates encrypted object wire and binds its authenticated id", () => {
    const exact = encryptedObjectWire("object-adapter");
    const validated = storageAdapterSupportV2.validateEncryptedObject(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.payloadBytes).not.toBe(exact.payloadBytes);
    exact.payloadBytes.fill(0);
    expect(wire.decodeEncryptedPayloadV2(validated.payloadBytes).context.objectId)
      .toBe(root.objectId("object-adapter"));
    expectExactThrow(
      () =>
        storageAdapterSupportV2.validateEncryptedObject({
          ...encryptedObjectWire("object-adapter"),
          unexpected: true,
        } as never),
      "Encrypted object record has an invalid field set",
    );
    expectExactThrow(
      () =>
        storageAdapterSupportV2.validateEncryptedObject({
          ...encryptedObjectWire("object-adapter"),
          objectId: root.objectId("object-other"),
        }),
      "Encrypted object id does not match canonical payload bytes",
    );
  });

  test("hydrates and validates complete object-access wire state", () => {
    const exact = objectAccessWire();
    const validated = storageAdapterSupportV2.validateObjectAccessState(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.head).not.toBe(exact.head);
    expect(validated.head.manifestHash).not.toBe(exact.head.manifestHash);
    expect(validated.head.manifestBytes).not.toBe(exact.head.manifestBytes);
    expect(validated.namespaceEnvelopes).not.toBe(exact.namespaceEnvelopes);
    expect(validated.namespaceEnvelopes[0]?.envelopeHash)
      .not.toBe(exact.namespaceEnvelopes[0]?.envelopeHash);
    expect(validated.namespaceEnvelopes[0]?.envelopeBytes)
      .not.toBe(exact.namespaceEnvelopes[0]?.envelopeBytes);

    for (const [message, candidate] of [
      [
        "Object access wire state has an invalid field set",
        { ...objectAccessWire(), unexpected: true },
      ],
      [
        "Object access Namespace envelopes must be an array",
        { ...objectAccessWire(), namespaceEnvelopes: "envelopes" },
      ],
      [
        "Namespace object envelope wire record has an invalid field set",
        {
          ...objectAccessWire(),
          namespaceEnvelopes: [{
            ...objectAccessWire().namespaceEnvelopes[0]!,
            unexpected: true,
          }],
        },
      ],
    ] as const) {
      expectExactThrow(
        () => storageAdapterSupportV2.validateObjectAccessState(candidate as never),
        message,
      );
    }
  });

  test("binds Human v5 authorization to the exact AI-envelope inventory", () => {
    const exact = humanV5ObjectAccessWire("namespace-human-v5-a", 0x75);
    const substituted = humanV5ObjectAccessWire(
      "namespace-human-v5-b",
      0x76,
    );
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      exact.authorization,
      exact.state,
    )).toBeTrue();
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      exact.authorization,
      substituted.state,
    )).toBeFalse();

    const exactContext = exact.authorization.context.envelopes[0]!;
    for (const mismatchedContext of [
      { ...exactContext, namespaceId: root.namespaceId("namespace-other") },
      { ...exactContext, keyGeneration: root.namespaceGeneration(3) },
      { ...exactContext, bindingRevisionAtWrap: root.accessRevision(4) },
      { ...exactContext, envelopeHash: new Uint8Array(32).fill(0x91) },
    ]) {
      expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
        {
          ...exact.authorization,
          context: {
            ...exact.authorization.context,
            envelopes: [mismatchedContext],
          },
        },
        exact.state,
      )).toBeFalse();
    }

    const extra = humanV5ObjectAccessWire("namespace-human-v5-extra", 0x77);
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      {
        ...exact.authorization,
        context: {
          ...exact.authorization.context,
          envelopes: [
            exactContext,
            extra.authorization.context.envelopes[0]!,
          ],
        },
      },
      exact.state,
    )).toBeFalse();

    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      exact.authorization,
      objectAccessWire(),
    )).toBeFalse();

    const otherObjectId = root.objectId("object-access-human-v5-other");
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      {
        ...exact.authorization,
        context: {
          ...exact.authorization.context,
          objectId: otherObjectId,
          envelopes: [{ ...exactContext, objectId: otherObjectId }],
        },
      },
      exact.state,
    )).toBeFalse();

    const humanEnvelope = humanV5ObjectAccessWire(
      "namespace-human-v5-a",
      0x78,
      "human",
    );
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      {
        ...humanEnvelope.authorization,
        context: {
          ...humanEnvelope.authorization.context,
          envelopes: [{
            ...humanEnvelope.authorization.context.envelopes[0]!,
            keyClass: "ai",
          }],
        },
      },
      humanEnvelope.state,
    )).toBeFalse();

    const v2Crypto = new root.LatticeCrypto();
    const v2Signing = v2Crypto.generateSigningKeyPair();
    const v2Manifest = root.createObjectAccessManifest(v2Crypto, {
      objectId: exact.state.head.objectId,
      payloadHash: exact.authorization.context.payloadHash,
      accessRevision: root.accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [exact.state.namespaceEnvelopes[0]!.envelopeHash],
      committerDeviceId: exact.authorization.context.committerDeviceId,
      hostAuthorizationRevision:
        exact.authorization.context.hostAuthorizationRevision,
    }, v2Signing.privateKey);
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      exact.authorization,
      {
        head: {
          objectId: exact.state.head.objectId,
          accessRevision: root.accessRevision(0),
          manifestHash: v2Manifest.hash,
          manifestBytes: v2Manifest.bytes,
        },
        namespaceEnvelopes: exact.state.namespaceEnvelopes,
      },
    )).toBeFalse();
    v2Signing.privateKey.fill(0);
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      {
        kind: "genesis",
        context: {
          purpose: "persist-object-access-genesis",
          objectId: exact.authorization.context.objectId,
          payloadHash: exact.authorization.context.payloadHash,
          envelopes: exact.authorization.context.envelopes,
          committerDeviceId: exact.authorization.context.committerDeviceId,
          hostAuthorizationRevision:
            exact.authorization.context.hostAuthorizationRevision,
        },
        currentHostAuthorizationRevision:
          exact.authorization.currentHostAuthorizationRevision,
        committerSigningPublicKeyHash:
          exact.authorization.committerSigningPublicKeyHash,
      },
      exact.state,
    )).toBeFalse();

    const second = humanV5ObjectAccessWire("namespace-human-v5-b", 0x76);
    const crypto = new root.LatticeCrypto();
    const records = [
      exact.state.namespaceEnvelopes[0]!,
      second.state.namespaceEnvelopes[0]!,
    ].sort((left, right) => Buffer.compare(
      left.envelopeHash,
      right.envelopeHash,
    ));
    const signing = crypto.generateSigningKeyPair();
    const manifest = root.createCommonHumanObjectAccessManifest(crypto, {
      objectId: exact.state.head.objectId,
      payloadHash: exact.authorization.context.payloadHash,
      accessRevision: root.accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: records.map((record) => record.envelopeHash),
      signer: {
        kind: "human_device",
        subjectHumanId: root.humanId("human-access-adapter"),
        committerDeviceId: root.cryptoDeviceId("device-access-adapter"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: root.authorizationRevision(4),
    }, signing.privateKey);
    const contexts = [
      exact.authorization.context.envelopes[0]!,
      second.authorization.context.envelopes[0]!,
    ].sort((left, right) => left.namespaceId < right.namespaceId ? -1 : 1);
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      {
        ...exact.authorization,
        context: { ...exact.authorization.context, envelopes: contexts },
      },
      {
        head: {
          objectId: exact.state.head.objectId,
          accessRevision: root.accessRevision(0),
          manifestHash: manifest.hash,
          manifestBytes: manifest.bytes,
        },
        namespaceEnvelopes: records,
      },
    )).toBeTrue();
    expect(storageAdapterSupportV2.humanV5GenesisAuthorizationMatchesState(
      {
        ...exact.authorization,
        context: {
          ...exact.authorization.context,
          envelopes: [
            contexts[0]!,
            {
              ...contexts[1]!,
              bindingRevisionAtWrap: root.accessRevision(4),
            },
          ],
        },
      },
      {
        head: {
          objectId: exact.state.head.objectId,
          accessRevision: root.accessRevision(0),
          manifestHash: manifest.hash,
          manifestBytes: manifest.bytes,
        },
        namespaceEnvelopes: records,
      },
    )).toBeFalse();
    signing.privateKey.fill(0);
  });

  test("validates and detaches object-access heads", () => {
    const exact = objectAccessWire().head;
    const validated = storageAdapterSupportV2.validateObjectAccessHead(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.manifestHash).not.toBe(exact.manifestHash);
    expect(validated.manifestBytes).not.toBe(exact.manifestBytes);
    expectExactThrow(
      () =>
        storageAdapterSupportV2.validateObjectAccessHead({
          ...exact,
          manifestHash: new Uint8Array(31),
        }),
      "Object access head hash must be exactly 32 bytes",
    );
  });

  test("validates and detaches mutable recovery expectations", () => {
    const archiveHash = new Uint8Array(32).fill(0x51);
    const validated = storageAdapterSupportV2.validateRecoveryArchiveExpectation({
      humanId: root.humanId("human-recovery"),
      recoveryKeyGeneration: 3,
      archiveHash,
    });

    expect(validated.archiveHash).not.toBe(archiveHash);
    archiveHash.fill(0);
    expect(validated.archiveHash).toEqual(new Uint8Array(32).fill(0x51));
    expect(() =>
      storageAdapterSupportV2.validateRecoveryArchiveExpectation({
        humanId: "invalid id with spaces",
        recoveryKeyGeneration: 3,
        archiveHash: new Uint8Array(32),
      })
    ).toThrow("Human id");
  });

  test("hydrates Grant wire, preserves consumption, and binds Grant id", () => {
    const grantBytes = grantWire("grant-adapter");
    const exact = {
      grantId: root.grantId("grant-adapter"),
      grantBytes,
      consumed: true,
    };
    const validated = storageAdapterSupportV2.validateGrant(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.grantBytes).not.toBe(grantBytes);
    grantBytes.fill(0);
    expect(wire.parseGrantV2(validated.grantBytes)?.id)
      .toBe(root.grantId("grant-adapter"));
    for (const [message, candidate] of [
      ["Grant record has an invalid field set", { ...exact, unexpected: true }],
      ["Grant consumed state must be boolean", { ...exact, consumed: 1 }],
      [
        "Grant id does not match canonical Grant wire bytes",
        {
          ...exact,
          grantId: root.grantId("grant-other"),
          grantBytes: grantWire("grant-adapter"),
        },
      ],
    ] as const) {
      expectExactThrow(
        () => storageAdapterSupportV2.validateGrant(candidate as never),
        message,
      );
    }
  });

  test("hydrates recovery wire and independently binds both coordinates", () => {
    const archiveBytes = recoveryWire("human-recovery-adapter", 3);
    const exact = {
      humanId: root.humanId("human-recovery-adapter"),
      recoveryKeyGeneration: 3,
      archiveBytes,
    };
    const validated = storageAdapterSupportV2.validateRecoveryArchive(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.archiveBytes).not.toBe(archiveBytes);
    archiveBytes.fill(0);
    expect(wire.decodeHumanRecoveryArchiveV2(validated.archiveBytes).humanId)
      .toBe(root.humanId("human-recovery-adapter"));
    for (const [message, candidate] of [
      [
        "Recovery archive record has an invalid field set",
        { ...exact, unexpected: true },
      ],
      [
        "Recovery archive durable coordinates do not match canonical wire bytes",
        {
          ...exact,
          humanId: root.humanId("human-other"),
          archiveBytes: recoveryWire("human-recovery-adapter", 3),
        },
      ],
      [
        "Recovery archive durable coordinates do not match canonical wire bytes",
        {
          ...exact,
          recoveryKeyGeneration: 4,
          archiveBytes: recoveryWire("human-recovery-adapter", 3),
        },
      ],
    ] as const) {
      expectExactThrow(
        () => storageAdapterSupportV2.validateRecoveryArchive(candidate as never),
        message,
      );
    }
  });

  test("diagnoses and detaches recovery archive expectations exactly", () => {
    const archiveHash = new Uint8Array(32).fill(0xa1);
    const exact = {
      humanId: root.humanId("human-recovery-expectation"),
      recoveryKeyGeneration: 4,
      archiveHash,
    };
    const validated = storageAdapterSupportV2
      .validateRecoveryArchiveExpectation(exact);
    expect(validated).toEqual(exact);
    expect(validated).not.toBe(exact);
    expect(validated.archiveHash).not.toBe(archiveHash);
    archiveHash.fill(0);
    expect(validated.archiveHash).toEqual(new Uint8Array(32).fill(0xa1));
    for (const [message, candidate] of [
      [
        "Recovery archive expectation has an invalid field set",
        { ...validated, unexpected: true },
      ],
      [
        "Expected recovery key generation must be a non-negative safe integer",
        { ...validated, recoveryKeyGeneration: -1 },
      ],
      [
        "Expected recovery archive hash must be exactly 32 bytes",
        { ...validated, archiveHash: new Uint8Array(31) },
      ],
    ] as const) {
      expectExactThrow(
        () =>
          storageAdapterSupportV2.validateRecoveryArchiveExpectation(
            candidate as never,
          ),
        message,
      );
    }
  });

  test("rejects malformed object authorization expectations", () => {
    expect(() =>
      storageAdapterSupportV2.validateObjectAccessAuthorizationExpectation({
        kind: "unknown",
      } as never)
    ).toThrow("invalid");
  });

  test("validates every Human v5 authorization coordinate exactly", () => {
    const first = humanV5ObjectAccessWire("namespace-human-policy-a", 0xa1)
      .authorization;
    const second = humanV5ObjectAccessWire("namespace-human-policy-b", 0xa2)
      .authorization.context.envelopes[0]!;
    const envelope = first.context.envelopes[0]!;
    const context = first.context;
    const invalid: readonly [string, unknown][] = [
      [
        "Human v5 object access genesis authorization expectation has an invalid field set",
        { ...first, unexpected: true },
      ],
      [
        "Human v5 object access genesis authorization context has an invalid field set",
        { ...first, context: { ...context, unexpected: true } },
      ],
      [
        "Human v5 object access genesis authorization purpose is invalid",
        { ...first, context: { ...context, purpose: "wrong" } },
      ],
      [
        "Object id must be 1-128 ASCII bytes using the portable identifier grammar",
        { ...first, context: { ...context, objectId: "invalid id" } },
      ],
      [
        "Human id must be 1-128 ASCII bytes using the portable identifier grammar",
        { ...first, context: { ...context, subjectHumanId: "invalid id" } },
      ],
      [
        "Crypto device id must be 1-128 ASCII bytes using the portable identifier grammar",
        { ...first, context: { ...context, committerDeviceId: "invalid id" } },
      ],
      [
        "Authorization revision must be a non-negative safe integer",
        { ...first, context: { ...context, hostAuthorizationRevision: -1 } },
      ],
      [
        "Authorization revision must be a non-negative safe integer",
        { ...first, currentHostAuthorizationRevision: -1 },
      ],
      [
        "Human v5 object access genesis payload hash must be exactly 32 bytes",
        { ...first, context: { ...context, payloadHash: new Uint8Array(31) } },
      ],
      [
        "Human v5 object access genesis signing key hash must be exactly 32 bytes",
        { ...first, committerSigningPublicKeyHash: new Uint8Array(31) },
      ],
      [
        "Human v5 object access envelopes must be an array",
        { ...first, context: { ...context, envelopes: {} } },
      ],
      [
        "Human v5 object access envelope count exceeds the 256 limit",
        { ...first, context: { ...context, envelopes: Array(257).fill(envelope) } },
      ],
      [
        "Human v5 object access envelope has an invalid field set",
        {
          ...first,
          context: {
            ...context,
            envelopes: [{ ...envelope, unexpected: true }],
          },
        },
      ],
      [
        "Object id must be 1-128 ASCII bytes using the portable identifier grammar",
        {
          ...first,
          context: { ...context, envelopes: [{ ...envelope, objectId: "bad id" }] },
        },
      ],
      [
        "Namespace id must be 1-128 ASCII bytes using the portable identifier grammar",
        {
          ...first,
          context: {
            ...context,
            envelopes: [{ ...envelope, namespaceId: "bad id" }],
          },
        },
      ],
      [
        "Namespace generation must be a non-negative safe integer",
        {
          ...first,
          context: { ...context, envelopes: [{ ...envelope, keyGeneration: -1 }] },
        },
      ],
      [
        "Access revision must be a non-negative safe integer",
        {
          ...first,
          context: {
            ...context,
            envelopes: [{ ...envelope, bindingRevisionAtWrap: -1 }],
          },
        },
      ],
      [
        "Human v5 object access envelope hash must be exactly 32 bytes",
        {
          ...first,
          context: {
            ...context,
            envelopes: [{ ...envelope, envelopeHash: new Uint8Array(31) }],
          },
        },
      ],
      [
        "Human v5 object access requires AI envelopes",
        {
          ...first,
          context: { ...context, envelopes: [{ ...envelope, keyClass: "human" }] },
        },
      ],
      [
        "Human v5 object access envelope object is invalid",
        {
          ...first,
          context: {
            ...context,
            envelopes: [{ ...envelope, objectId: root.objectId("object-other") }],
          },
        },
      ],
      [
        "Human v5 object access envelopes must be canonical and unique",
        { ...first, context: { ...context, envelopes: [envelope, envelope] } },
      ],
      [
        "Human v5 object access envelopes must be canonical and unique",
        { ...first, context: { ...context, envelopes: [second, envelope] } },
      ],
    ];
    for (const [message, candidate] of invalid) {
      expectExactThrow(
        () => storageAdapterSupportV2
          .validateObjectAccessAuthorizationExpectation(candidate as never),
        message,
      );
    }
    expect(storageAdapterSupportV2.validateObjectAccessAuthorizationExpectation(
      first,
    )).toEqual(first);
  });
});
