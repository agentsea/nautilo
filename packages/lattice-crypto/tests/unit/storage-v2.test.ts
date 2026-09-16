import { describe, expect, test } from "bun:test";
import * as v2StorageCompatibility from "../../src/storage/v2-store.ts";
import { storageAdapterSupportV2 } from "../../src/storage/v2-adapter-support.ts";
import {
  assertAgentRuntimeAtomicState,
  assertCanonicalNamespaceBindingRecord,
  assertCanonicalRecoveryArchiveRecord,
  bindingWireRecord,
  cloneAtomicRuntimeState,
  cloneBytes,
  compareBytes,
  equalBindings,
  equalBytes,
  equalStrings,
} from "../../src/storage/v2-record-policy.ts";
import {
  InMemoryV2Store,
  type CryptoDomainPublicRecordV2,
  type AgentRuntimeAtomicStorageStateV2,
  type AgentRuntimeAtomicStorageWireV2,
  type NamespaceBindingRecordV2,
  type NamespaceHeadV2,
  type OpaqueGrantRecordV2,
} from "../../src/storage/v2-store.ts";
import {
  authorizeProviderHeadWriteV2,
} from "../../src/transition/provider-authorized-write.ts";
import {
  authorizeNamespaceBindingWriteV2,
} from "../../src/namespace/authorized-write.ts";
import {
  authorizeAgentRuntimeInitializationWriteV2,
} from "../../src/agent-runtime/initialization-authorized-write.ts";
import {
  authorizeAgentRuntimeAuthorizationTransitionWriteV2,
  authorizeAgentRuntimeChallengeReservationWriteV2,
  authorizeAgentRuntimeRotationWriteV2,
} from "../../src/agent-runtime/storage-authorized-write.ts";
import {
  agentRuntimeSignerPublicationForTesting,
} from "../../src/testing/agent-runtime-signer-publication.ts";
import {
  authenticatedAgentRuntimeConfigDekV2,
  assertOpaqueBytes,
  cloneOpaqueBytes,
  opaqueBytes,
  type OpaqueBytes,
} from "../../src/v2-types/opaque.ts";
import {
  V2LimitError,
  V2_LIMITS,
} from "../../src/v2-types/limits.ts";
import type {
  ProviderPublicHeadV2,
} from "../../src/transition/provider-candidate.ts";
import {
  agentId,
  accessRevision,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  V2ValidationError,
} from "../../src/v2-types/ids.ts";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  agentRuntimeConfigInventoryCommitmentV2,
} from "../../src/agent-runtime/runtime-rotation-v2.ts";
import {
  sealAgentRuntimeToDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import {
  prepareObjectAccessManifestGenesisV2,
} from "../../src/object/access-manifest.ts";
import {
  persistPreparedObjectAccessManifestGenesisV2,
} from "../../src/object/storage-coordinator.ts";
import {
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../../src/format/agent-runtime-v2.ts";
import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  decodeEncryptedPayloadV2,
  encodeEncryptedPayloadV2,
} from "../../src/format/object-v2.ts";
import {
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  parseGrantV2,
  serializeGrantV2,
} from "../../src/format/grant-v2.ts";
import {
  HUMAN_RECOVERY_FORMAT_VERSION,
  decodeHumanRecoveryArchive,
  recoveryKeyGeneration,
  serializeHumanRecoveryArchive,
} from "../../src/format/recovery-v2.ts";
import {
  NAMESPACE_BINDING_FORMAT_VERSION,
  parseNamespaceBinding,
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  NAMESPACE_KEYRING_FORMAT_VERSION,
  parseNamespaceKeyringEnvelope,
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  participantDigest,
} from "../../src/domain/participants.ts";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

interface ForbiddenSecretSentinel {
  readonly label: string;
  readonly bytes: Uint8Array;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (
    let offset = 0;
    offset <= haystack.length - needle.length;
    offset += 1
  ) {
    if (
      needle.every((value, index) => haystack[offset + index] === value)
    ) {
      return true;
    }
  }
  return false;
}

function forbiddenSecretPaths(
  value: unknown,
  sentinels: readonly ForbiddenSecretSentinel[],
): readonly string[] {
  const findings: string[] = [];
  const visited = new Set<object>();
  const inspect = (candidate: unknown, path: string): void => {
    if (candidate instanceof Uint8Array) {
      for (const sentinel of sentinels) {
        if (containsBytes(candidate, sentinel.bytes)) {
          findings.push(`${path}:${sentinel.label}`);
        }
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
      return;
    }
    for (const [field, entry] of Object.entries(candidate)) {
      inspect(entry, `${path}.${field}`);
    }
  };
  inspect(value, "$");
  return findings;
}

function canonicalObjectPayload(
  id: string,
  marker = 1,
): Uint8Array {
  return encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: objectId(id),
      keyClass: "human",
      objectType: "test-record",
      createdAt: unixTimestamp(1),
    },
    ciphertext: new Uint8Array(40).fill(marker),
  });
}

function canonicalGrantWire(
  id: string,
  marker = 1,
): Uint8Array {
  return serializeGrantV2({
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: grantId(id),
    issuingDeviceId: cryptoDeviceId("device-grant-issuer"),
    recipientAgentId: agentId("agent-grant-recipient"),
    recipientKeyId: "invocation-key",
    scope: [humanId("alice")],
    operations: ["decrypt"],
    issuedAt: 1,
    expiresAt: 2,
    coveredDomains: [{
      domainId: cryptoDomainId("domain-grant"),
      domainEpoch: domainEpoch(1),
      agentAuthorizationRevision: authorizationRevision(1),
    }],
    encryptedSecret: new Uint8Array(40).fill(marker),
    scheme: GRANT_V2_SCHEME,
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(marker),
    singleUse: true,
    consumed: false,
  });
}

function canonicalRecoveryArchiveWire(
  owner: string,
  generation: number,
  marker = 1,
): Uint8Array {
  return serializeHumanRecoveryArchive({
    formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
    humanId: humanId(owner),
    recoveryKeyId: `recovery-key-${String(generation)}`,
    recoveryGeneration: recoveryKeyGeneration(generation),
    recoveryPublicKeyDigest: new Uint8Array(32).fill(marker),
    issuerDeviceId: cryptoDeviceId("device-recovery-issuer"),
    createdAt: unixTimestamp(1),
    packages: [],
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(marker),
  });
}

describe("v2 opaque storage bytes", () => {
  test("keeps the compatibility barrel runtime surface exact", () => {
    expect(Object.keys(v2StorageCompatibility).sort()).toEqual([
      "InMemoryV2Store",
      "encryptedObjectWriteRecordV2",
      "grantWriteRecordV2",
      "namespaceBindingWriteRecordV2",
      "recoveryArchiveWriteRecordV2",
    ]);
  });

  test("internal storage comparisons are exact across lengths, ordering, and every binding byte family", () => {
    expect(equalBytes(bytes(1, 2), bytes(1, 2))).toBe(true);
    expect(equalBytes(bytes(1), bytes(1, 2))).toBe(false);
    expect(equalBytes(bytes(1, 2), bytes(1, 3))).toBe(false);
    expect(equalStrings(["a", "b"], ["a", "b"])).toBe(true);
    expect(equalStrings(["a"], ["a", "b"])).toBe(false);
    expect(equalStrings(["a", "b"], ["a", "c"])).toBe(false);
    expect(compareBytes(bytes(1), bytes(1, 2))).toBeLessThan(0);
    expect(compareBytes(bytes(1, 2), bytes(1))).toBeGreaterThan(0);
    expect(compareBytes(bytes(1, 2), bytes(1, 3))).toBeLessThan(0);
    expect(compareBytes(bytes(1, 3), bytes(1, 2))).toBeGreaterThan(0);
    const canonical = binding("ns-binding-equality", 1, bytes(0x21));
    expect(equalBindings(canonical, structuredClone(canonical))).toBe(true);
    const differences: NamespaceBindingRecordV2[] = [
      {
        ...canonical,
        bindingHash: new Uint8Array(32).fill(0x31),
      },
      {
        ...canonical,
        previousBindingHash: null,
      },
      {
        ...canonical,
        previousBindingHash: new Uint8Array(32).fill(0x32),
      },
      {
        ...canonical,
        signedBindingBytes: bytes(0x33),
      },
      {
        ...canonical,
        humanKeyringEnvelope: opaqueBytes(
          "human-keyring-envelope",
          bytes(0x34),
        ),
      },
      {
        ...canonical,
        aiKeyringEnvelope: opaqueBytes(
          "ai-keyring-envelope",
          bytes(0x35),
        ),
      },
    ];
    for (const different of differences) {
      expect(equalBindings(canonical, different)).toBe(false);
    }

    const genesis = binding("ns-binding-equality", 0, bytes(0x22));
    expect(equalBindings(genesis, structuredClone(genesis))).toBe(true);
    expect(equalBindings(genesis, {
      ...genesis,
      previousBindingHash: new Uint8Array(32),
    })).toBe(false);
  });

  test("binding wire conversion detaches every mutable byte family", () => {
    const source = binding("ns-binding-wire", 1, bytes(0x41));
    const wire = bindingWireRecord(source);
    expect(wire).toMatchObject({
      namespaceId: source.namespaceId,
      revision: source.revision,
      bindingHash: source.bindingHash,
      previousBindingHash: source.previousBindingHash,
      signedBindingBytes: source.signedBindingBytes,
      humanKeyringEnvelopeBytes:
        source.humanKeyringEnvelope.ciphertext,
      aiKeyringEnvelopeBytes: source.aiKeyringEnvelope.ciphertext,
    });
    expect(wire.bindingHash).not.toBe(source.bindingHash);
    expect(wire.previousBindingHash).not.toBe(source.previousBindingHash);
    expect(wire.signedBindingBytes).not.toBe(source.signedBindingBytes);
    expect(wire.humanKeyringEnvelopeBytes).not.toBe(
      source.humanKeyringEnvelope.ciphertext,
    );
    expect(wire.aiKeyringEnvelopeBytes).not.toBe(
      source.aiKeyringEnvelope.ciphertext,
    );
  });

  test("storage byte cloning owns Buffer views", () => {
    const source = Buffer.from([1, 2, 3]);
    const cloned = cloneBytes(source);

    source.fill(0);
    expect(cloned).toEqual(bytes(1, 2, 3));
    expect(Buffer.isBuffer(cloned)).toBeFalse();
  });

  test("constructs frozen, detached ciphertext and rejects non-byte input exactly", () => {
    const source = bytes(1, 2, 3);
    const opaque = opaqueBytes("grant", source);

    expect(opaque).toMatchObject({
      classification: "opaque-ciphertext",
      kind: "grant",
      ciphertext: bytes(1, 2, 3),
    });
    expect(Object.isFrozen(opaque)).toBe(true);
    expect(opaque.ciphertext).not.toBe(source);
    source.fill(0);
    expect(opaque.ciphertext).toEqual(bytes(1, 2, 3));
    expect(() =>
      opaqueBytes("grant", [1, 2, 3] as unknown as Uint8Array)
    ).toThrow(
      new TypeError("opaque grant must contain Uint8Array ciphertext"),
    );
  });

  test("owns Buffer-backed ciphertext without retaining its shared slice", () => {
    const source = Buffer.from([1, 2, 3]);
    const opaque = opaqueBytes("grant", source);

    source.fill(0);
    expect(opaque.ciphertext).toEqual(bytes(1, 2, 3));
    expect(Buffer.isBuffer(opaque.ciphertext)).toBeFalse();
    expect(() =>
      assertOpaqueBytes("Grant", opaque, "grant")
    ).not.toThrow();
  });

  test("copies genuine byte subclasses without invoking hostile hooks", () => {
    let hookCalls = 0;
    class HostileBytes extends Uint8Array {
      static get [Symbol.species](): Uint8ArrayConstructor {
        hookCalls += 1;
        return Uint8Array;
      }

      override get length(): number {
        hookCalls += 1;
        return 1;
      }

      override slice(
        _start?: number,
        _end?: number,
      ): Uint8Array<ArrayBuffer> {
        hookCalls += 1;
        throw new Error("hostile slice");
      }

      override [Symbol.iterator](): ArrayIterator<number> {
        hookCalls += 1;
        return [0xff].values();
      }
    }

    const source = new HostileBytes([1, 2, 3]);
    const opaque = opaqueBytes("grant", source);
    expect(opaque.ciphertext).toEqual(bytes(1, 2, 3));
    expect(Object.getPrototypeOf(opaque.ciphertext))
      .toBe(Uint8Array.prototype);
    expect(hookCalls).toBe(0);

    let proxyIteratorRead = false;
    const proxy = new Proxy(new Uint8Array([1, 2, 3]), {
      get(target, property, receiver): unknown {
        if (property === Symbol.iterator) proxyIteratorRead = true;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => opaqueBytes("grant", proxy)).toThrow(
      "owned byte source must be a genuine Uint8Array",
    );
    expect(proxyIteratorRead).toBeFalse();
  });

  test("accepts only an authentic opaque capability with the expected kind", () => {
    const valid = {
      classification: "opaque-ciphertext",
      kind: "grant",
      ciphertext: bytes(1),
    };
    expect(() => assertOpaqueBytes("Grant", valid, "grant")).toThrow(
      new TypeError("Grant must be opaque grant ciphertext"),
    );
    expect(() =>
      assertOpaqueBytes(
        "Grant",
        opaqueBytes("grant", valid.ciphertext),
        "grant",
      )
    ).not.toThrow();
    expect(() =>
      assertOpaqueBytes(
        "Recovery archive",
        opaqueBytes("grant", bytes(1)),
        "recovery-archive",
      )
    ).toThrow(
      new TypeError(
        "Recovery archive must be opaque recovery-archive ciphertext",
      ),
    );

    const invalid: unknown[] = [
      null,
      undefined,
      "opaque",
      {},
      { kind: "grant", ciphertext: bytes(1) },
      { classification: "opaque-ciphertext", ciphertext: bytes(1) },
      { classification: "opaque-ciphertext", kind: "grant" },
      { ...valid, classification: "plaintext-secret" },
      { ...valid, kind: "recovery-archive" },
      { ...valid, ciphertext: [1] },
      { ...valid, extra: true },
      {
        classification: "opaque-ciphertext",
        kind: "grant",
        unknown: bytes(1),
      },
    ];
    for (const candidate of invalid) {
      expect(() => assertOpaqueBytes("Grant", candidate, "grant")).toThrow(
        new TypeError("Grant must be opaque grant ciphertext"),
      );
    }
  });

  test("clones after validation and detaches the cloned ciphertext", () => {
    const original = opaqueBytes("grant", bytes(1, 2, 3));
    const cloned = cloneOpaqueBytes(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.ciphertext).not.toBe(original.ciphertext);
    original.ciphertext.fill(0);
    expect(cloned.ciphertext).toEqual(bytes(1, 2, 3));

    expect(() =>
      cloneOpaqueBytes({
        classification: "plaintext-secret",
        kind: "grant",
        ciphertext: bytes(1),
      } as unknown as OpaqueBytes<"grant">)
    ).toThrow(
      new TypeError("opaque bytes must be opaque grant ciphertext"),
    );

    const substituted = opaqueBytes("grant", bytes(4, 5, 6));
    substituted.ciphertext[0] = 0x5a;
    expect(() =>
      assertOpaqueBytes("Grant", substituted, "grant")
    ).toThrow(
      new TypeError("Grant must be opaque grant ciphertext"),
    );
    expect(() => cloneOpaqueBytes(substituted)).toThrow(
      new TypeError("opaque bytes must be opaque grant ciphertext"),
    );
  });

  test("constructs an authentic detached Runtime config-DEK capability", () => {
    const source = bytes(4, 5, 6);
    const wrappedDek = authenticatedAgentRuntimeConfigDekV2(source);
    expect(wrappedDek).toMatchObject({
      classification: "opaque-ciphertext",
      kind: "agent-runtime-config-dek",
      ciphertext: bytes(4, 5, 6),
    });
    expect(wrappedDek.ciphertext).not.toBe(source);
    expect(() =>
      assertOpaqueBytes(
        "Runtime config DEK",
        wrappedDek,
        "agent-runtime-config-dek",
      )
    ).not.toThrow();
    source.fill(0);
    expect(wrappedDek.ciphertext).toEqual(bytes(4, 5, 6));
  });
});

function domain(
  id: string,
  fallbackDigest: Uint8Array,
  participants: string[],
): CryptoDomainPublicRecordV2 {
  let digest = fallbackDigest;
  try {
    digest = participantDigest(participants.map(humanId));
  } catch {
    // Malformed-participant tests must reach the store validation boundary.
  }
  return {
    id,
    participantDigest: digest,
    participants,
    epoch: 0,
    authorizationRevision: 0,
    rosterBytes: bytes(1, 2, 3),
  };
}

function binding(
  namespaceValue: string,
  revision: number,
  markerBytes: Uint8Array,
  previousHash?: Uint8Array,
): NamespaceBindingRecordV2 {
  const crypto = new LatticeCrypto();
  const marker = markerBytes[0] ?? 0;
  const previousBindingHash = revision === 0
    ? null
    : previousHash?.slice() ?? new Uint8Array(32).fill(revision - 1);
  const envelope = (keyClass: "human" | "ai") =>
    serializeNamespaceKeyringEnvelope({
      formatVersion: NAMESPACE_KEYRING_FORMAT_VERSION,
      namespaceId: namespaceId(namespaceValue),
      keyClass,
      domainId: cryptoDomainId(`domain-${revision}`),
      domainEpoch: domainEpoch(revision),
      accessRevision: accessRevision(revision),
      currentGeneration: namespaceGeneration(revision),
      previousBindingHash,
      committerDeviceId: cryptoDeviceId("device-binding"),
      ciphertext: new Uint8Array(40).fill(
        marker + (keyClass === "human" ? 1 : 2),
      ),
      signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(
        marker + (keyClass === "human" ? 3 : 4),
      ),
    });
  const humanBytes = envelope("human");
  const aiBytes = envelope("ai");
  const signedBindingBytes = serializeNamespaceBinding({
    formatVersion: NAMESPACE_BINDING_FORMAT_VERSION,
    namespaceId: namespaceId(namespaceValue),
    domainId: cryptoDomainId(`domain-${revision}`),
    domainEpoch: domainEpoch(revision),
    accessRevision: accessRevision(revision),
    humanCurrentGeneration: namespaceGeneration(revision),
    aiCurrentGeneration: namespaceGeneration(revision),
    previousBindingHash,
    humanKeyringEnvelopeHash: crypto.hash(humanBytes),
    aiKeyringEnvelopeHash: crypto.hash(aiBytes),
    committerDeviceId: cryptoDeviceId("device-binding"),
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(marker + 5),
  });
  return {
    namespaceId: namespaceValue,
    revision,
    bindingHash: crypto.hash(signedBindingBytes),
    previousBindingHash,
    signedBindingBytes,
    humanKeyringEnvelope: opaqueBytes(
      "human-keyring-envelope",
      humanBytes,
    ),
    aiKeyringEnvelope: opaqueBytes(
      "ai-keyring-envelope",
      aiBytes,
    ),
  };
}

function bindingWithKeyringMismatch(
  keyClass: "human" | "ai",
  override: Partial<Readonly<{
    namespaceId: string;
    keyClass: "human" | "ai";
    domainId: string;
    domainEpoch: number;
    accessRevision: number;
    currentGeneration: number;
    previousBindingHash: Uint8Array | null;
  }>>,
  revision = 0,
  previousBindingHash: Uint8Array | null = null,
): NamespaceBindingRecordV2 {
  const crypto = new LatticeCrypto();
  const namespaceValue = "ns-keyring-mismatch";
  const signedCoordinates = {
    namespaceId: namespaceId(namespaceValue),
    domainId: cryptoDomainId("domain-keyring-mismatch"),
    domainEpoch: domainEpoch(revision),
    accessRevision: accessRevision(revision),
    currentGeneration: namespaceGeneration(revision),
    previousBindingHash,
      committerDeviceId: cryptoDeviceId("device-binding"),
    } as const;
  const envelope = (candidate: "human" | "ai") =>
    serializeNamespaceKeyringEnvelope({
      formatVersion: NAMESPACE_KEYRING_FORMAT_VERSION,
      ...signedCoordinates,
      keyClass: candidate,
      ...(candidate === keyClass ? override : {}),
      namespaceId: namespaceId(
        candidate === keyClass && override.namespaceId !== undefined
          ? override.namespaceId
          : signedCoordinates.namespaceId,
      ),
      domainId: cryptoDomainId(
        candidate === keyClass && override.domainId !== undefined
          ? override.domainId
          : signedCoordinates.domainId,
      ),
      domainEpoch: domainEpoch(
        candidate === keyClass && override.domainEpoch !== undefined
          ? override.domainEpoch
          : signedCoordinates.domainEpoch,
      ),
      accessRevision: accessRevision(
        candidate === keyClass && override.accessRevision !== undefined
          ? override.accessRevision
          : signedCoordinates.accessRevision,
      ),
      currentGeneration: namespaceGeneration(
        candidate === keyClass && override.currentGeneration !== undefined
          ? override.currentGeneration
          : signedCoordinates.currentGeneration,
      ),
      ciphertext: new Uint8Array(40).fill(
        candidate === "human" ? 0x71 : 0x72,
      ),
      signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(
        candidate === "human" ? 0x73 : 0x74,
      ),
    });
  const humanBytes = envelope("human");
  const aiBytes = envelope("ai");
  const signedBindingBytes = serializeNamespaceBinding({
    formatVersion: NAMESPACE_BINDING_FORMAT_VERSION,
    namespaceId: signedCoordinates.namespaceId,
    domainId: signedCoordinates.domainId,
    domainEpoch: signedCoordinates.domainEpoch,
    accessRevision: signedCoordinates.accessRevision,
    humanCurrentGeneration: signedCoordinates.currentGeneration,
    aiCurrentGeneration: signedCoordinates.currentGeneration,
    previousBindingHash: signedCoordinates.previousBindingHash,
    humanKeyringEnvelopeHash: crypto.hash(humanBytes),
    aiKeyringEnvelopeHash: crypto.hash(aiBytes),
    committerDeviceId: cryptoDeviceId("device-binding"),
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(0x75),
  });
  return {
    namespaceId: namespaceValue,
    revision,
    bindingHash: crypto.hash(signedBindingBytes),
    previousBindingHash,
    signedBindingBytes,
    humanKeyringEnvelope: opaqueBytes(
      "human-keyring-envelope",
      humanBytes,
    ),
    aiKeyringEnvelope: opaqueBytes("ai-keyring-envelope", aiBytes),
  };
}

function head(
  namespaceValue: string,
  revision: number,
  markerBytes: Uint8Array,
): NamespaceHeadV2 {
  const record = binding(namespaceValue, revision, markerBytes);
  const signed = parseNamespaceBinding(record.signedBindingBytes);
  return {
    namespaceId: namespaceValue,
    accessRevision: revision,
    bindingHash: record.bindingHash,
    domainId: signed.domainId,
    domainEpoch: signed.domainEpoch,
  };
}

function headForBinding(
  record: NamespaceBindingRecordV2,
): NamespaceHeadV2 {
  const signed = parseNamespaceBinding(record.signedBindingBytes);
  return {
    namespaceId: record.namespaceId,
    accessRevision: record.revision,
    bindingHash: record.bindingHash,
    domainId: signed.domainId,
    domainEpoch: signed.domainEpoch,
  };
}

function namespaceWriteCapability(input: Readonly<{
  expected: Readonly<{
    namespaceId: string;
    accessRevision: number;
    bindingHash: Uint8Array;
  }> | null;
  binding: NamespaceBindingRecordV2;
  next: NamespaceHeadV2;
}>) {
  const previousBindingHash = input.expected?.bindingHash.slice() ?? null;
  const committer = {
    namespaceId: namespaceId(input.next.namespaceId),
    domainId: cryptoDomainId(input.next.domainId),
    domainEpoch: domainEpoch(input.next.domainEpoch),
    accessRevision: accessRevision(input.next.accessRevision),
    committerDeviceId: cryptoDeviceId("device-binding"),
    previousBindingHash,
  };
  return authorizeNamespaceBindingWriteV2({
    ...input,
    authorization: {
      bindingCommitter: {
        ...committer,
        purpose: "namespace-binding",
      },
      keyringCommitter: {
        ...committer,
        purpose: "namespace-keyring-envelope",
      },
      committerSigningPublicKeyHash: new Uint8Array(32).fill(0x5a),
    },
  });
}

function providerHead(
  domainId: string,
  epoch: number,
  fill: number,
): ProviderPublicHeadV2 {
  return {
    providerId: "provider-v2",
    domainId: cryptoDomainId(domainId),
    epoch: domainEpoch(epoch),
    stateHash: new Uint8Array(32).fill(fill),
  };
}

function providerWriteCapability(
  input: Readonly<{
    expected: ProviderPublicHeadV2;
    next: ProviderPublicHeadV2;
    nextRosterBytes: Uint8Array;
  }>,
) {
  return authorizeProviderHeadWriteV2({
    ...input,
    authorization: {
      providerId: input.expected.providerId,
      domainId: input.expected.domainId,
      authorizationRevision: authorizationRevision(0),
      actorDeviceId: cryptoDeviceId("device-provider-writer"),
      operation: "update",
      targetHumanId: humanId("alice"),
      targetDeviceId: cryptoDeviceId("device-provider-target"),
      currentHead: input.expected,
      nextHead: input.next,
      candidateId: "candidate-provider-write",
      publicTransitionDigest: new Uint8Array(32).fill(0x42),
    },
  });
}

function emptyRuntimeState(
  agent = "agent-store",
): AgentRuntimeAtomicStorageStateV2 {
  const crypto = new LatticeCrypto(seededRng(225), manualClock(1));
  return {
    runtime: {
      agentId: agentId(agent),
      authorizationRevision: authorizationRevision(0),
      runtimeGeneration: agentRuntimeGeneration(0),
    },
    configInventory: agentRuntimeConfigInventoryCommitmentV2({
      crypto,
      agentId: agentId(agent),
      runtimeGeneration: agentRuntimeGeneration(0),
      activeConfigObjects: [],
    }),
    configObjects: [],
    domainEnvelopes: [],
    challengeConsumptions: [],
  };
}

function runtimeStateWithConfig(
  agent: string,
  authorization: number,
  generation: number,
  config: Readonly<{
    objectId?: string;
    configRevision?: number;
    marker?: number;
  }> = {},
): AgentRuntimeAtomicStorageStateV2 {
  return runtimeStateWithConfigs(
    agent,
    authorization,
    generation,
    [{
      objectId: config.objectId ?? "config-a",
      configRevision: config.configRevision ?? 0,
      marker: config.marker ?? 1,
    }],
  );
}

function runtimeStateWithConfigs(
  agent: string,
  authorization: number,
  generation: number,
  configs: readonly Readonly<{
    objectId: string;
    configRevision: number;
    marker: number;
  }>[],
): AgentRuntimeAtomicStorageStateV2 {
  const crypto = new LatticeCrypto(seededRng(226), manualClock(1));
  const targetAgentId = agentId(agent);
  const targetGeneration = agentRuntimeGeneration(generation);
  const activeConfigObjects = configs.map((config) => ({
    agentId: targetAgentId,
    objectId: objectId(config.objectId),
    configRevision: authorizationRevision(config.configRevision),
    runtimeGeneration: targetGeneration,
    wrappedDek: new Uint8Array(40).fill(config.marker),
  }));
  const inventory = agentRuntimeConfigInventoryCommitmentV2({
    crypto,
    agentId: targetAgentId,
    runtimeGeneration: targetGeneration,
    activeConfigObjects,
  });
  return {
    runtime: {
      agentId: targetAgentId,
      authorizationRevision: authorizationRevision(authorization),
      runtimeGeneration: targetGeneration,
    },
    configInventory: inventory,
    configObjects: activeConfigObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: crypto.hash(object.wrappedDek),
      wrappedDek: opaqueBytes(
        "agent-runtime-config-dek",
        object.wrappedDek,
      ),
    })),
    domainEnvelopes: [],
    challengeConsumptions: [],
  };
}

function runtimeExpectation(
  state: AgentRuntimeAtomicStorageStateV2,
) {
  return {
    runtime: state.runtime,
    configInventory: state.configInventory,
    configObjects: state.configObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: object.wrappedDekHash,
    })),
    challengeConsumptions: state.challengeConsumptions,
  };
}

function runtimeWire(
  state: AgentRuntimeAtomicStorageStateV2,
): AgentRuntimeAtomicStorageWireV2 {
  return {
    runtime: structuredClone(state.runtime),
    configInventory: structuredClone(state.configInventory),
    configObjects: state.configObjects.map((object) => ({
      agentId: object.agentId,
      objectId: object.objectId,
      configRevision: object.configRevision,
      runtimeGeneration: object.runtimeGeneration,
      wrappedDekHash: object.wrappedDekHash.slice(),
      wrappedDekBytes: object.wrappedDek.ciphertext.slice(),
    })),
    domainEnvelopes: state.domainEnvelopes.map((envelope) => ({
      agentId: envelope.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: envelope.runtimeGeneration,
      committerDeviceId: envelope.committerDeviceId,
      envelopeHash: envelope.envelopeHash.slice(),
      envelopeBytes: envelope.envelopeBytes.ciphertext.slice(),
    })),
    challengeConsumptions: structuredClone(state.challengeConsumptions),
  };
}

async function rejectedMessage(
  run: () => Promise<unknown>,
): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

function runtimeDomainEnvelopeRecord(input: Readonly<{
  agent: string;
  authorization: number;
  generation: number;
  domain: string;
  marker: number;
}>) {
  const crypto = new LatticeCrypto(
    seededRng(227 + input.marker),
    manualClock(1),
  );
  const signing = crypto.generateSigningKeyPair();
  const context = {
    agentId: agentId(input.agent),
    domainId: cryptoDomainId(input.domain),
    domainEpoch: domainEpoch(3),
    agentAuthorizationRevision:
      authorizationRevision(input.authorization),
    committerDeviceId: cryptoDeviceId(`device-${input.domain}`),
  };
  const envelope = sealAgentRuntimeToDomain({
    crypto,
    domainRoot: new Uint8Array(32).fill(0x70 + input.marker),
    runtime: {
      agentId: context.agentId,
      keyClass: "runtime",
      generation: agentRuntimeGeneration(input.generation),
      key: new Uint8Array(32).fill(0x80 + input.marker),
    },
    context,
    committerSigningPrivateKey: signing.privateKey,
    currentCommitterAuthorized: () => true,
  });
  const serialized = serializeAgentRuntimeDomainEnvelope(envelope);
  return {
    agentId: envelope.agentId,
    domainId: envelope.domainId,
    domainEpoch: envelope.domainEpoch,
    agentAuthorizationRevision:
      envelope.agentAuthorizationRevision,
    runtimeGeneration: envelope.runtimeGeneration,
    committerDeviceId: envelope.committerDeviceId,
    envelopeHash: crypto.hash(serialized),
    envelopeBytes: opaqueBytes(
      "agent-runtime-domain-envelope",
      serialized,
    ),
  };
}

function runtimeRotationFixture(
  agent = "agent-runtime-cas",
) {
  const crypto = new LatticeCrypto(seededRng(227), manualClock(1));
  const challengeHash = new Uint8Array(32).fill(0x91);
  const initial: AgentRuntimeAtomicStorageStateV2 = {
    ...runtimeStateWithConfig(agent, 0, 0, {
      objectId: "config-a",
      configRevision: 2,
      marker: 0x31,
    }),
    challengeConsumptions: [{
      challengeHash: challengeHash.slice(),
      consumed: false,
    }],
  };
  const nextBase = runtimeStateWithConfig(agent, 1, 1, {
    objectId: "config-a",
    configRevision: 2,
    marker: 0x52,
  });
  const intended: AgentRuntimeAtomicStorageStateV2 = {
    ...nextBase,
    domainEnvelopes: [runtimeDomainEnvelopeRecord({
      agent,
      authorization: 1,
      generation: 1,
      domain: "domain-a",
      marker: 3,
    })],
    challengeConsumptions: [{
      challengeHash: challengeHash.slice(),
      consumed: true,
    }],
  };
  return {
    crypto,
    initial,
    expected: runtimeExpectation(initial),
    intended,
    challengeHash,
  };
}

function runtimeAuthorizationTransitionFixture(
  agent = "agent-authorization-transition",
) {
  const challengeHashes = [
    new Uint8Array(32).fill(0xa1),
    new Uint8Array(32).fill(0xa2),
  ];
  const initial: AgentRuntimeAtomicStorageStateV2 = {
    ...runtimeStateWithConfigs(agent, 0, 0, [
      { objectId: "config-a", configRevision: 2, marker: 0x31 },
      { objectId: "config-b", configRevision: 4, marker: 0x32 },
    ]),
    domainEnvelopes: [
      runtimeDomainEnvelopeRecord({
        agent,
        authorization: 0,
        generation: 0,
        domain: "domain-a",
        marker: 1,
      }),
      runtimeDomainEnvelopeRecord({
        agent,
        authorization: 0,
        generation: 0,
        domain: "domain-b",
        marker: 2,
      }),
    ],
    challengeConsumptions: challengeHashes.map((challengeHash) => ({
      challengeHash,
      consumed: false,
    })),
  };
  const intended: AgentRuntimeAtomicStorageStateV2 = {
    ...cloneAtomicRuntimeState(initial),
    runtime: {
      ...initial.runtime,
      authorizationRevision: authorizationRevision(1),
    },
    domainEnvelopes: [
      initial.domainEnvelopes[0]!,
      runtimeDomainEnvelopeRecord({
        agent,
        authorization: 1,
        generation: 0,
        domain: "domain-b",
        marker: 3,
      }),
    ],
    challengeConsumptions: [
      { challengeHash: challengeHashes[0]!, consumed: true },
      { challengeHash: challengeHashes[1]!, consumed: false },
    ],
  };
  return { initial, intended, challengeHashes };
}

async function initializedRuntimeRotationStore(
  initial: AgentRuntimeAtomicStorageStateV2,
): Promise<InMemoryV2Store> {
  const store = new InMemoryV2Store();
  expect(await putAuthorizedRuntime(store, initial)).toBe(
    "inserted",
  );
  return store;
}

async function putAuthorizedRuntime(
  store: InMemoryV2Store,
  state: AgentRuntimeAtomicStorageStateV2,
  suppliedSignerPublication?: ReturnType<
    typeof agentRuntimeSignerPublicationForTesting
  >,
) {
  if (typeof state !== "object" || state === null) {
    return store.putAgentRuntimeAtomicStateIfAbsent(
      authorizeAgentRuntimeInitializationWriteV2({
        state,
        authorization: null as never,
        signerPublication: null as never,
      }),
    );
  }
  const expectedDomains = Array.isArray(state.domainEnvelopes as unknown)
    ? state.domainEnvelopes.map((domain) => ({
    domainId: cryptoDomainId(domain.domainId),
    domainEpoch: domainEpoch(domain.domainEpoch),
    agentAuthorizationRevision:
      authorizationRevision(domain.agentAuthorizationRevision),
    committerDeviceId: cryptoDeviceId(domain.committerDeviceId),
    }))
    : [];
  const signerPublication = suppliedSignerPublication ?? (
    typeof state.runtime === "object" && state.runtime !== null
      ? agentRuntimeSignerPublicationForTesting({
        state: state.runtime,
        transitionKind:
          state.runtime.runtimeGeneration === 0
            ? "initialization"
            : "rotation",
      })
      : agentRuntimeSignerPublicationForTesting({
        state: emptyRuntimeState(
          "agent-malformed-signer-fixture",
        ).runtime,
        transitionKind: "initialization",
      })
  );
  return store.putAgentRuntimeAtomicStateIfAbsent(
    authorizeAgentRuntimeInitializationWriteV2({
      state,
      authorization: {
        context: {
          purpose: "persist-agent-runtime-initialization",
          operationId: signerPublication.operationId,
          expectedState: state.runtime,
          expectedManager: {
            managerHumanId: signerPublication.managerHumanId,
            managerAuthorizationRevision:
              signerPublication.managerAuthorizationRevision,
            managerDeviceId: signerPublication.managerDeviceId,
          },
          configInventory: state.configInventory,
          expectedDomains,
        },
        currentManager: {
          managerHumanId: signerPublication.managerHumanId,
          managerAuthorizationRevision:
            signerPublication.managerAuthorizationRevision,
          managerDeviceId: signerPublication.managerDeviceId,
        },
        currentManagerSigningPublicKey: bytes(0x72),
        authorizedDomains: expectedDomains.map((domain) => ({
          ...domain,
          committerSigningPublicKey: bytes(0x71),
        })),
      },
      signerPublication,
    }),
  );
}

async function putAuthorizedRuntimeRotation(
  store: InMemoryV2Store,
  expected: Parameters<
    typeof authorizeAgentRuntimeRotationWriteV2
  >[0]["expected"],
  intended: AgentRuntimeAtomicStorageStateV2,
  signerPublication = agentRuntimeSignerPublicationForTesting({
    state: intended.runtime,
    transitionKind:
      intended.runtime.runtimeGeneration === 0
        ? "initialization"
        : "rotation",
    operationId: "operation-storage-test",
  }),
) {
  if (typeof expected !== "object" || expected === null) {
    return store.compareAndSwapAgentRuntimeRotation(
      authorizeAgentRuntimeRotationWriteV2({
        expected,
        intended,
        authorization: null as never,
        signerPublication: null as never,
      }),
    );
  }
  const currentManager = {
    managerHumanId: humanId("human-runtime-manager"),
    managerAuthorizationRevision: authorizationRevision(0),
    managerDeviceId: cryptoDeviceId("device-runtime-manager"),
  };
  return store.compareAndSwapAgentRuntimeRotation(
    authorizeAgentRuntimeRotationWriteV2({
      expected,
      intended,
      authorization: {
        context: {
          purpose: "persist-agent-runtime-rotation",
          operationId: "operation-storage-test",
          expectedState: expected.runtime,
          nextState: intended.runtime,
          expectedManager: currentManager,
        },
        currentState: expected.runtime,
        currentManager,
        currentManagerSigningPublicKey: bytes(0x72),
        remainingDomains: intended.domainEnvelopes.map((domain) => ({
          domainId: cryptoDomainId(domain.domainId),
          domainEpoch: domainEpoch(domain.domainEpoch),
          agentAuthorizationRevision:
            authorizationRevision(domain.agentAuthorizationRevision),
          committerDeviceId: cryptoDeviceId(domain.committerDeviceId),
          committerSigningPublicKey: bytes(0x73),
        })),
      },
      signerPublication,
    }),
  );
}

async function putAuthorizedRuntimeAuthorizationTransition(
  store: InMemoryV2Store,
  expected: AgentRuntimeAtomicStorageStateV2,
  intended: AgentRuntimeAtomicStorageStateV2,
  refreshedDomainIds: readonly string[],
  currentState = expected.runtime,
  signerPublication = agentRuntimeSignerPublicationForTesting({
    state: expected.runtime,
    transitionKind:
      expected.runtime.runtimeGeneration === 0
        ? "initialization"
        : "rotation",
  }),
) {
  return store.compareAndSwapAgentRuntimeAuthorizationTransition(
    authorizeAgentRuntimeAuthorizationTransitionWriteV2({
      expected,
      intended,
      authorization: {
        purpose: "persist-agent-runtime-authorization-transition",
        operationId: "operation-authorization-transition-storage-test",
        currentState,
        nextState: intended.runtime,
        remainingDomains: intended.domainEnvelopes.map((domain) => ({
          domainId: domain.domainId,
          domainEpoch: domain.domainEpoch,
          agentAuthorizationRevision: domain.agentAuthorizationRevision,
          committerDeviceId: domain.committerDeviceId,
        })),
        refreshedDomainIds,
      },
      signerPublication,
    }),
  );
}

async function putAuthorizedChallengeReservation(
  store: InMemoryV2Store,
  expected: Parameters<
    typeof authorizeAgentRuntimeChallengeReservationWriteV2
  >[0]["expected"],
  additions: Parameters<
    typeof authorizeAgentRuntimeChallengeReservationWriteV2
  >[0]["additions"],
) {
  if (typeof expected !== "object" || expected === null) {
    return store.compareAndSwapAgentRuntimeChallengeReservations(
      authorizeAgentRuntimeChallengeReservationWriteV2({
        expected,
        additions,
        authorization: null as never,
      }),
    );
  }
  if (!Array.isArray(additions as unknown)) {
    return store.compareAndSwapAgentRuntimeChallengeReservations(
      authorizeAgentRuntimeChallengeReservationWriteV2({
        expected,
        additions,
        authorization: null as never,
      }),
    );
  }
  const currentManager = {
    managerHumanId: humanId("human-runtime-manager"),
    managerAuthorizationRevision: authorizationRevision(0),
    managerDeviceId: cryptoDeviceId("device-runtime-manager"),
  };
  return store.compareAndSwapAgentRuntimeChallengeReservations(
    authorizeAgentRuntimeChallengeReservationWriteV2({
      expected,
      additions,
      authorization: {
        purpose: "reserve-agent-runtime-rotation-challenges",
        operationId: "operation-storage-test",
        expectedState: expected.runtime,
        expectedManager: currentManager,
        remainingDomains: additions.map((_, index) => ({
          domainId: cryptoDomainId(`domain-reservation-${index}`),
          domainEpoch: domainEpoch(0),
          agentAuthorizationRevision: authorizationRevision(0),
          committerDeviceId:
            cryptoDeviceId(`device-reservation-${index}`),
        })),
        challengeHashes: additions.map((entry) => entry.challengeHash),
      },
    }),
  );
}

describe("v2 opaque storage and CAS seam", () => {
  test("concurrent exact-set Domain creation resolves to one canonical record", async () => {
    const store = new InMemoryV2Store();
    const digest = bytes(0xaa, 0xbb);

    const [left, right] = await Promise.all([
      store.createDomainIfAbsent(domain("domain-left", digest, ["alice", "bob"])),
      store.createDomainIfAbsent(domain("domain-right", digest, ["alice", "bob"])),
    ]);

    expect([left.status, right.status].sort()).toEqual(["created", "existing"]);
    expect(left.domain.id).toBe(right.domain.id);
    expect(await store.listDomains()).toHaveLength(1);
  });

  test("a participant digest is only an index and never aliases unequal exact sets", async () => {
    const store = new InMemoryV2Store();
    const abDigest = participantDigest([humanId("alice"), humanId("bob")]);
    const acDigest = participantDigest([humanId("alice"), humanId("carol")]);

    await store.createDomainIfAbsent(
      domain("domain-ab", abDigest, ["alice", "bob"]),
    );
    await store.createDomainIfAbsent(
      domain("domain-ac", acDigest, ["alice", "carol"]),
    );

    expect(
      (await store.findDomain(abDigest, ["alice", "bob"]))?.id,
    ).toBe("domain-ab");
    expect(
      (await store.findDomain(acDigest, ["alice", "carol"]))?.id,
    ).toBe("domain-ac");
    expect(
      store.findDomain(abDigest, ["alice"]),
    ).rejects.toThrow(
      "lookup digest does not match canonical participants",
    );
    expect(
      store.findDomain(abDigest, ["bob", "alice"]),
    ).rejects.toThrow("canonical unsigned UTF-8 order");
    const lengthStore = new InMemoryV2Store();
    await lengthStore.createDomainIfAbsent(
      domain("domain-a", bytes(), ["alice"]),
    );
    expect(
      lengthStore.findDomain(
        participantDigest([humanId("alice")]),
        ["alice", "bob"],
      ),
    ).rejects.toThrow(
      "lookup digest does not match canonical participants",
    );
    expect(await store.listDomains()).toHaveLength(2);
    expect(store.findDomain(bytes(0xff), ["alice"])).rejects.toThrow(
      "lookup digest must be exactly 32 bytes",
    );
    expect(
      store.findDomain(
        participantDigest([humanId("nobody")]),
        ["nobody"],
      ),
    ).resolves.toBeNull();
    expect(
      store.findDomain(
        participantDigest([humanId("alice")]),
        null as never,
      ),
    ).rejects.toThrow("participants must be an array");
  });

  test("rejects forged participant digests before they can split one exact set", async () => {
    const store = new InMemoryV2Store();
    const forged = {
      ...domain("domain-forged", bytes(), ["alice", "bob"]),
      participantDigest: new Uint8Array(32).fill(7),
    };

    expect(store.createDomainIfAbsent(forged)).rejects.toThrow(
      "participant digest does not match canonical participants",
    );

    const valid = domain("domain-valid", bytes(), ["alice", "bob"]);
    expect(await store.createDomainIfAbsent(valid)).toMatchObject({
      status: "created",
      domain: { id: "domain-valid" },
    });
    expect(await store.listDomains()).toHaveLength(1);
  });

  test("rejects an oversized Domain roster before mutating either Domain index", async () => {
    const store = new InMemoryV2Store();
    const oversized = {
      ...domain("domain-oversized-roster", bytes(), ["alice"]),
      rosterBytes: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
    };

    expect(store.createDomainIfAbsent(oversized)).rejects.toThrow(
      "Crypto Domain roster bytes exceeds",
    );
    expect(await store.listDomains()).toEqual([]);
  });

  test("Domain records reject noncanonical participants and identity reuse", async () => {
    const store = new InMemoryV2Store();
    expect(
      store.createDomainIfAbsent({
        ...domain("domain-fields", bytes(0), ["alice"]),
        extra: true,
      } as never),
    ).rejects.toEqual(
      new TypeError("Crypto Domain record has an invalid field set"),
    );
    expect(
      store.createDomainIfAbsent({
        ...domain("domain-participant-type", bytes(0), ["alice"]),
        participants: null,
      } as never),
    ).rejects.toThrow("participants must be an array");
    expect(
      store.createDomainIfAbsent(
        domain("domain-unsorted", bytes(1), ["bob", "alice"]),
      ),
    ).rejects.toThrow("canonical");
    expect(
      store.createDomainIfAbsent(
        domain("domain-duplicate", bytes(2), ["alice", "alice"]),
      ),
    ).rejects.toThrow("duplicate");

    await store.createDomainIfAbsent(
      domain("domain-stable", bytes(3), ["alice"]),
    );
    expect(
      await store.createDomainIfAbsent(
        domain("domain-stable", bytes(3), ["alice"]),
      ),
    ).toMatchObject({ status: "existing" });
    expect(
      store.createDomainIfAbsent(
        {
          ...domain("domain-stable", bytes(4), ["alice"]),
          participantDigest: new Uint8Array(32).fill(4),
        },
      ),
    ).rejects.toThrow(
      "participant digest does not match canonical participants",
    );
    expect(
      store.createDomainIfAbsent(
        domain("domain-stable", bytes(3), ["bob"]),
      ),
    ).rejects.toThrow("Domain id is already bound");
    expect(
      store.createDomainIfAbsent(
        {
          ...domain("domain-stable", bytes(4), ["bob"]),
          participantDigest: new Uint8Array(32).fill(4),
        },
      ),
    ).rejects.toThrow(
      "participant digest does not match canonical participants",
    );
  });

  test("reads and writes detach every byte buffer and participant array", async () => {
    const store = new InMemoryV2Store();
    const input = domain("domain-ab", bytes(7, 8), ["alice", "bob"]);
    const digest = input.participantDigest.slice();
    const created = await store.createDomainIfAbsent(input);

    input.participantDigest[0] = 0;
    (input.participants as string[])[0] = "mallory";
    input.rosterBytes[0] = 0;
    created.domain.participantDigest[1] = 0;
    (created.domain.participants as string[])[1] = "mallory";

    const stored = await store.findDomain(digest, ["alice", "bob"]);
    expect(stored).toMatchObject({
      id: "domain-ab",
      participants: ["alice", "bob"],
    });
    expect(stored?.participantDigest).toEqual(digest);
    expect(stored?.rosterBytes).toEqual(bytes(1, 2, 3));
  });

  test("Domain provider heads initialize once and advance with exact detached CAS", async () => {
    const store = new InMemoryV2Store();
    const initialRoster = bytes(1, 2, 3);
    await store.createDomainIfAbsent(
      domain("domain-provider", bytes(7), ["alice"]),
    );
    const initial = providerHead("domain-provider", 0, 0x10);

    expect(
      await store.putDomainProviderHeadIfAbsent(initial, initialRoster),
    ).toBe("inserted");
    initial.stateHash[0] = 0xff;
    initialRoster[0] = 0xff;
    expect(await store.getDomainProviderHead("domain-provider")).toEqual(
      providerHead("domain-provider", 0, 0x10),
    );
    expect(
      await store.putDomainProviderHeadIfAbsent(
        providerHead("domain-provider", 0, 0x10),
        bytes(1, 2, 3),
      ),
    ).toBe("existing");
    expect(
      store.putDomainProviderHeadIfAbsent(
        providerHead("domain-provider", 0, 0x11),
        bytes(1, 2, 3),
      ),
    ).rejects.toThrow("different public state");

    const next = providerHead("domain-provider", 1, 0x20);
    expect(
      await store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: providerHead("domain-provider", 0, 0x99),
          next,
          nextRosterBytes: bytes(3, 4),
        }),
      ),
    ).toBe("stale");
    expect(
      await store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: providerHead("domain-provider", 0, 0x10),
          next,
          nextRosterBytes: bytes(3, 4),
        }),
      ),
    ).toBe("applied");
    next.stateHash[0] = 0xff;
    expect(await store.getDomainProviderHead("domain-provider")).toEqual(
      providerHead("domain-provider", 1, 0x20),
    );
    expect((await store.listDomains())[0]).toMatchObject({
      epoch: 1,
      rosterBytes: bytes(3, 4),
    });
    expect(
      await store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: providerHead("domain-provider", 0, 0x10),
          next: providerHead("domain-provider", 1, 0x20),
          nextRosterBytes: bytes(3, 4),
        }),
      ),
    ).toBe("duplicate");
  });

  test("Domain provider CAS rejects forged, cloned, mutated, and replayed authorization capabilities", async () => {
    const store = new InMemoryV2Store();
    const initial = providerHead("domain-provider-capability", 0, 0x31);
    const next = providerHead("domain-provider-capability", 1, 0x32);
    const initialRoster = bytes(1, 2, 3);
    const nextRoster = bytes(4, 5, 6);
    await store.createDomainIfAbsent(
      domain("domain-provider-capability", bytes(7), ["alice"]),
    );
    await store.putDomainProviderHeadIfAbsent(initial, initialRoster);

    const direct = store.compareAndSwapDomainProviderHead as unknown as (
      write: unknown,
    ) => Promise<unknown>;
    const structural = {
      expected: initial,
      next,
      nextRosterBytes: nextRoster,
    };
    expect(direct.call(store, structural)).rejects.toThrow(
      "authorized provider-head write capability",
    );
    expect(direct.call(store, structural as never)).rejects.toThrow(
      "authorized provider-head write capability",
    );

    const authentic = providerWriteCapability(structural);
    expect(direct.call(store, { ...authentic })).rejects.toThrow(
      "authorized provider-head write capability",
    );

    const mutated = providerWriteCapability(structural);
    mutated.nextRosterBytes[0] = mutated.nextRosterBytes[0]! ^ 0xff;
    expect(store.compareAndSwapDomainProviderHead(mutated)).rejects.toThrow(
      "authorized provider-head write capability",
    );

    const authorizationMutated = providerWriteCapability(structural);
    authorizationMutated.authorization.publicTransitionDigest[0] =
      authorizationMutated.authorization.publicTransitionDigest[0]! ^ 0xff;
    expect(
      store.compareAndSwapDomainProviderHead(authorizationMutated),
    ).rejects.toThrow(
      "authorized provider-head write capability",
    );

    const replayed = providerWriteCapability({
      expected: providerHead("domain-provider-capability", 0, 0x99),
      next,
      nextRosterBytes: nextRoster,
    });
    expect(await store.compareAndSwapDomainProviderHead(replayed)).toBe(
      "stale",
    );
    expect(store.compareAndSwapDomainProviderHead(replayed)).rejects.toThrow(
      "authorized provider-head write capability",
    );

    expect(await store.getDomainProviderHead(initial.domainId)).toEqual(
      initial,
    );
  });

  test("Domain provider CAS rejects an authentic write after host authorization advances", async () => {
    const store = new InMemoryV2Store();
    const initial = providerHead("domain-provider-stale-auth", 0, 0x51);
    await store.createDomainIfAbsent({
      ...domain("domain-provider-stale-auth", bytes(7), ["alice"]),
      authorizationRevision: 1,
    });
    await store.putDomainProviderHeadIfAbsent(initial, bytes(1, 2, 3));

    expect(
      await store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: initial,
          next: providerHead("domain-provider-stale-auth", 1, 0x52),
          nextRosterBytes: bytes(4, 5, 6),
        }),
      ),
    ).toBe("stale");
    expect(await store.getDomainProviderHead(initial.domainId)).toEqual(
      initial,
    );
  });

  test("Domain-provider storage validates initialization and every CAS coordinate", async () => {
    const missing = new InMemoryV2Store();
    expect(
      missing.putDomainProviderHeadIfAbsent(
        providerHead("domain-missing", 0, 1),
        bytes(1, 2, 3),
      ),
    ).rejects.toThrow("requires an existing Domain");

    const store = new InMemoryV2Store();
    await store.createDomainIfAbsent(
      domain("domain-provider-exact", bytes(7), ["alice"]),
    );
    expect(
      store.putDomainProviderHeadIfAbsent(
        "provider-head" as never,
        bytes(1, 2, 3),
      ),
    ).rejects.toEqual(
      new TypeError("Domain provider head must be an object"),
    );
    expect(
      store.putDomainProviderHeadIfAbsent(
        {
          providerId: "provider-v2",
          domainId: "domain-provider-exact",
          epoch: 0,
          substitutedStateHash: new Uint8Array(32),
        } as never,
        bytes(1, 2, 3),
      ),
    ).rejects.toEqual(
      new TypeError("Domain provider head has an invalid field set"),
    );
    expect(
      store.putDomainProviderHeadIfAbsent(
        {
          providerId: "provider-v2",
          domainId: "domain-provider-exact",
          epoch: 0,
        } as never,
        bytes(1, 2, 3),
      ),
    ).rejects.toEqual(
      new TypeError("Domain provider head has an invalid field set"),
    );
    expect(
      store.putDomainProviderHeadIfAbsent(
        {
          ...providerHead("domain-provider-exact", 0, 1),
          providerId: "/",
        },
        bytes(1, 2, 3),
      ),
    ).rejects.toThrow("Domain provider head provider id");
    expect(
      store.putDomainProviderHeadIfAbsent(
        { ...providerHead("domain-provider-exact", 0, 1), stateHash: bytes(1) },
        bytes(1, 2, 3),
      ),
    ).rejects.toEqual(
      new RangeError(
        "Domain provider head state hash must be exactly 32 bytes",
      ),
    );
    expect(
      store.putDomainProviderHeadIfAbsent(
        providerHead("domain-provider-exact", 0, 1),
        "roster" as unknown as Uint8Array,
      ),
    ).rejects.toEqual(
      new TypeError("Domain provider roster bytes must be encoded bytes"),
    );
    expect(
      store.putDomainProviderHeadIfAbsent(
        providerHead("domain-provider-exact", 1, 1),
        bytes(1, 2, 3),
      ),
    ).rejects.toThrow("does not match the current Domain public state");
    expect(
      store.putDomainProviderHeadIfAbsent(
        providerHead("domain-provider-exact", 0, 1),
        bytes(9),
      ),
    ).rejects.toThrow("does not match the current Domain public state");
    expect(store.getDomainProviderHead("")).rejects.toThrow(
      "Crypto Domain id",
    );

    const initial = providerHead("domain-provider-exact", 0, 1);
    await store.putDomainProviderHeadIfAbsent(initial, bytes(1, 2, 3));
    const validNext = providerHead("domain-provider-exact", 1, 2);
    expect(
      store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: { ...initial, stateHash: new Uint8Array(31) },
          next: validNext,
          nextRosterBytes: bytes(4, 5),
        }),
      ),
    ).rejects.toEqual(
      new RangeError(
        "Expected Domain provider head state hash must be exactly 32 bytes",
      ),
    );
    expect(
      store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: initial,
          next: { ...validNext, stateHash: new Uint8Array(31) },
          nextRosterBytes: bytes(4, 5),
        }),
      ),
    ).rejects.toEqual(
      new RangeError(
        "Next Domain provider head state hash must be exactly 32 bytes",
      ),
    );
    for (const [expected, next] of [
      [
        { ...initial, providerId: "provider-other" },
        validNext,
      ],
      [
        initial,
        { ...validNext, domainId: cryptoDomainId("domain-other") },
      ],
      [
        initial,
        { ...validNext, epoch: domainEpoch(0) },
      ],
      [
        initial,
        { ...validNext, epoch: domainEpoch(2) },
      ],
    ] as const) {
      expect(
        store.compareAndSwapDomainProviderHead(
          providerWriteCapability({
            expected,
            next,
            nextRosterBytes: bytes(4, 5),
          }),
        ),
      ).rejects.toThrow(
        "requires one exact same-provider epoch advance",
      );
    }

    const noHead = new InMemoryV2Store();
    await noHead.createDomainIfAbsent(
      domain("domain-no-head", bytes(8), ["alice"]),
    );
    expect(
      await noHead.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: providerHead("domain-no-head", 0, 1),
          next: providerHead("domain-no-head", 1, 2),
          nextRosterBytes: bytes(4, 5),
        }),
      ),
    ).toBe("stale");

    expect(
      await store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: initial,
          next: validNext,
          nextRosterBytes: bytes(4, 5),
        }),
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: initial,
          next: validNext,
          nextRosterBytes: bytes(9),
        }),
      ),
    ).toBe("stale");

    const collision = new InMemoryV2Store();
    const digest = bytes(0xaa);
    await collision.createDomainIfAbsent(
      domain("domain-first", digest, ["alice"]),
    );
    await collision.createDomainIfAbsent(
      domain("domain-second", digest, ["bob"]),
    );
    const secondInitial = providerHead("domain-second", 0, 3);
    await collision.putDomainProviderHeadIfAbsent(
      secondInitial,
      bytes(1, 2, 3),
    );
    expect(
      await collision.compareAndSwapDomainProviderHead(
        providerWriteCapability({
          expected: secondInitial,
          next: providerHead("domain-second", 1, 4),
          nextRosterBytes: bytes(6),
        }),
      ),
    ).toBe("applied");
    expect(
      (await collision.listDomains())
        .map(({ id, epoch }) => ({ id, epoch }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "domain-first", epoch: 0 },
      { id: "domain-second", epoch: 1 },
    ]);
  });

  test("Namespace binding/head CAS rejects structural and cloned write bypasses", async () => {
    const store = new InMemoryV2Store();
    const initial = binding("ns-atomic", 0, bytes(1));
    const initialHead = headForBinding(initial);
    const structural = {
      expected: null,
      binding: initial,
      next: initialHead,
    };
    expect(store.compareAndSwapNamespaceBindingAndHead(
      structural as never,
    )).rejects.toThrow("authorized write capability");
    expect(store.compareAndSwapNamespaceBindingAndHead(
      structuredClone(structural) as never,
    )).rejects.toThrow("authorized write capability");
    expect(await store.getNamespaceHead("ns-atomic")).toBeNull();
  });

  test("Namespace binding/head CAS applies one linked history and rejects historical genesis replay", async () => {
    const store = new InMemoryV2Store();
    const initial = binding("ns-history", 0, bytes(0x10));
    const initialHead = headForBinding(initial);

    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: initial,
          next: initialHead,
        }),
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: initial,
          next: initialHead,
        }),
      ),
    ).toBe("duplicate");
    const competingInitial = binding("ns-history", 0, bytes(0x11));
    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: competingInitial,
          next: headForBinding(competingInitial),
        }),
      ),
    ).toBe("stale");

    const next = binding(
      "ns-history",
      1,
      bytes(0x20),
      initial.bindingHash,
    );
    const nextHead = headForBinding(next);
    const expected = {
      namespaceId: initialHead.namespaceId,
      accessRevision: initialHead.accessRevision,
      bindingHash: initialHead.bindingHash,
    };
    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected,
          binding: next,
          next: nextHead,
        }),
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected,
          binding: next,
          next: nextHead,
        }),
      ),
    ).toBe("duplicate");
    const competingNext = binding(
      "ns-history",
      1,
      bytes(0x21),
      initial.bindingHash,
    );
    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected,
          binding: competingNext,
          next: headForBinding(competingNext),
        }),
      ),
    ).toBe("stale");

    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: initial,
          next: initialHead,
        }),
      ),
    ).toBe("stale");
    expect(await store.getNamespaceHead("ns-history")).toEqual(nextHead);
    expect(await store.getBinding("ns-history", 0)).toMatchObject({
      namespaceId: "ns-history",
      revision: 0,
    });
    expect(await store.getBinding("ns-history", 1)).toMatchObject({
      namespaceId: "ns-history",
      revision: 1,
    });
  });

  test("Namespace binding/head CAS checks every binding-to-head coordinate", async () => {
    const canonical = binding("ns-coordinates", 0, bytes(0x30));
    const canonicalHead = headForBinding(canonical);
    const cases = [
      {
        label: "namespace id",
        binding: canonical,
        next: { ...canonicalHead, namespaceId: "ns-other" },
      },
      {
        label: "access revision",
        binding: canonical,
        next: { ...canonicalHead, accessRevision: 1 },
      },
      {
        label: "binding hash",
        binding: canonical,
        next: {
          ...canonicalHead,
          bindingHash: new Uint8Array(32).fill(0xee),
        },
      },
      {
        label: "Domain id",
        binding: canonical,
        next: {
          ...canonicalHead,
          domainId: cryptoDomainId("domain-other"),
        },
      },
      {
        label: "Domain epoch",
        binding: canonical,
        next: {
          ...canonicalHead,
          domainEpoch: domainEpoch(1),
        },
      },
    ] as const;

    for (const candidate of cases) {
      const store = new InMemoryV2Store();
      expect(
        store.compareAndSwapNamespaceBindingAndHead(
          namespaceWriteCapability({
            expected: null,
            binding: candidate.binding,
            next: candidate.next,
          }),
        ),
        candidate.label,
      ).rejects.toThrow();
      expect(await store.getNamespaceHead("ns-coordinates")).toBeNull();
    }
  });

  test("Namespace binding authentication binds every Human and AI keyring coordinate", async () => {
    const mismatchCases = [
      { label: "namespace id", override: { namespaceId: "ns-other" } },
      { label: "key class", override: {} },
      { label: "Domain id", override: { domainId: "domain-other" } },
      { label: "Domain epoch", override: { domainEpoch: 1 } },
      { label: "current generation", override: { currentGeneration: 1 } },
    ] as const;
    for (const keyClass of ["human", "ai"] as const) {
      for (const candidate of mismatchCases) {
        const store = new InMemoryV2Store();
        const malformed = bindingWithKeyringMismatch(
          keyClass,
          candidate.label === "key class"
            ? { keyClass: keyClass === "human" ? "ai" : "human" }
            : candidate.override,
        );
        const next = headForBinding(malformed);
        expect(
          store.compareAndSwapNamespaceBindingAndHead(
            namespaceWriteCapability({
              expected: null,
              binding: malformed,
              next,
            }),
          ),
          `${keyClass} ${candidate.label}`,
        ).rejects.toThrow(
          "does not match its canonical binding and keyring envelopes",
        );
        expect(await store.getNamespaceHead(next.namespaceId)).toBeNull();
      }
      const previous = new Uint8Array(32).fill(0xd1);
      for (const [label, override] of [
        ["access revision", { accessRevision: 2 }],
        [
          "previous binding hash",
          { previousBindingHash: new Uint8Array(32).fill(0xd2) },
        ],
      ] as const) {
        const store = new InMemoryV2Store();
        const malformed = bindingWithKeyringMismatch(
          keyClass,
          override,
          1,
          previous,
        );
        const next = headForBinding(malformed);
        expect(
          store.compareAndSwapNamespaceBindingAndHead(
            namespaceWriteCapability({
              expected: {
                namespaceId: next.namespaceId,
                accessRevision: 0,
                bindingHash: previous,
              },
              binding: malformed,
              next,
            }),
          ),
          `${keyClass} ${label}`,
        ).rejects.toThrow(
          "does not match its canonical binding and keyring envelopes",
        );
      }
    }
  });

  test("Namespace binding authentication binds every durable outer coordinate and byte family", async () => {
    const canonical = binding("ns-record-binding", 1, bytes(0x76));
    const next = headForBinding(canonical);
    const expected = {
      namespaceId: next.namespaceId,
      accessRevision: 0,
      bindingHash: canonical.previousBindingHash!,
    };
    const other = binding(
      "ns-record-binding",
      1,
      bytes(0x77),
      canonical.previousBindingHash!,
    );
    const cases: readonly Readonly<{
      label: string;
      binding: NamespaceBindingRecordV2;
    }>[] = [
      {
        label: "namespace id",
        binding: { ...canonical, namespaceId: "ns-other" },
      },
      {
        label: "revision",
        binding: { ...canonical, revision: 2 },
      },
      {
        label: "binding hash",
        binding: {
          ...canonical,
          bindingHash: new Uint8Array(32).fill(0xee),
        },
      },
      {
        label: "previous binding hash",
        binding: {
          ...canonical,
          previousBindingHash: new Uint8Array(32).fill(0xef),
        },
      },
      {
        label: "missing previous binding hash",
        binding: {
          ...canonical,
          previousBindingHash: null,
        },
      },
      {
        label: "signed binding bytes",
        binding: {
          ...canonical,
          signedBindingBytes: other.signedBindingBytes,
        },
      },
      {
        label: "Human envelope",
        binding: {
          ...canonical,
          humanKeyringEnvelope: other.humanKeyringEnvelope,
        },
      },
      {
        label: "AI envelope",
        binding: {
          ...canonical,
          aiKeyringEnvelope: other.aiKeyringEnvelope,
        },
      },
    ];
    for (const candidate of cases) {
      expect(
        new InMemoryV2Store().compareAndSwapNamespaceBindingAndHead(
          namespaceWriteCapability({
            expected,
            binding: candidate.binding,
            next,
          }),
        ),
        candidate.label,
      ).rejects.toThrow(
        "does not match its canonical binding and keyring envelopes",
      );
    }
    const genesis = binding("ns-record-binding-genesis", 0, bytes(0x78));
    expect(
      new InMemoryV2Store().compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: {
            ...genesis,
            previousBindingHash: new Uint8Array(32),
          },
          next: headForBinding(genesis),
        }),
      ),
    ).rejects.toThrow(
      "does not match its canonical binding and keyring envelopes",
    );
  });

  test("Namespace update CAS checks every expected-head and chain coordinate", async () => {
    const initial = binding("ns-update-cas", 0, bytes(0x40));
    const initialHead = headForBinding(initial);
    const canonicalExpected = {
      namespaceId: initialHead.namespaceId,
      accessRevision: initialHead.accessRevision,
      bindingHash: initialHead.bindingHash,
    };
    const canonicalNext = binding(
      "ns-update-cas",
      1,
      bytes(0x41),
      initial.bindingHash,
    );
    const canonicalNextHead = headForBinding(canonicalNext);
    for (const [label, malformedExpected] of [
      [
        "namespace id",
        { ...canonicalExpected, namespaceId: "/" },
      ],
      [
        "revision",
        { ...canonicalExpected, accessRevision: -1 },
      ],
      [
        "hash",
        { ...canonicalExpected, bindingHash: new Uint8Array(31) },
      ],
    ] as const) {
      const store = new InMemoryV2Store();
      expect(
        await store.compareAndSwapNamespaceBindingAndHead(
          namespaceWriteCapability({
            expected: null,
            binding: initial,
            next: initialHead,
          }),
        ),
      ).toBe("applied");
      expect(
        store.compareAndSwapNamespaceBindingAndHead(
          namespaceWriteCapability({
            expected: malformedExpected as never,
            binding: canonicalNext,
            next: canonicalNextHead,
          }),
        ),
        label,
      ).rejects.toThrow();
    }

    expect(
      await new InMemoryV2Store().compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: canonicalExpected,
          binding: canonicalNext,
          next: canonicalNextHead,
        }),
      ),
    ).toBe("stale");

    const revisionMismatchStore = new InMemoryV2Store();
    expect(
      await revisionMismatchStore.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: initial,
          next: initialHead,
        }),
      ),
    ).toBe("applied");
    const revisionTwo = binding(
      "ns-update-cas",
      2,
      bytes(0x44),
      initial.bindingHash,
    );
    expect(
      await revisionMismatchStore.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: {
            ...canonicalExpected,
            accessRevision: 1,
          },
          binding: revisionTwo,
          next: headForBinding(revisionTwo),
        }),
      ),
    ).toBe("stale");

    const cases = [
      {
        label: "expected namespace",
        expected: { ...canonicalExpected, namespaceId: "ns-other" },
        binding: canonicalNext,
        next: canonicalNextHead,
      },
      {
        label: "expected revision",
        expected: { ...canonicalExpected, accessRevision: 1 },
        binding: canonicalNext,
        next: canonicalNextHead,
      },
      {
        label: "expected hash",
        expected: {
          ...canonicalExpected,
          bindingHash: new Uint8Array(32).fill(0xee),
        },
        binding: canonicalNext,
        next: canonicalNextHead,
      },
      {
        label: "non-sequential revision",
        expected: canonicalExpected,
        binding: binding(
          "ns-update-cas",
          2,
          bytes(0x42),
          initial.bindingHash,
        ),
        next: headForBinding(binding(
          "ns-update-cas",
          2,
          bytes(0x42),
          initial.bindingHash,
        )),
      },
      {
        label: "wrong previous hash",
        expected: canonicalExpected,
        binding: binding(
          "ns-update-cas",
          1,
          bytes(0x43),
          new Uint8Array(32).fill(0xef),
        ),
        next: headForBinding(binding(
          "ns-update-cas",
          1,
          bytes(0x43),
          new Uint8Array(32).fill(0xef),
        )),
      },
    ] as const;

    for (const candidate of cases) {
      const store = new InMemoryV2Store();
      expect(
        await store.compareAndSwapNamespaceBindingAndHead(
          namespaceWriteCapability({
            expected: null,
            binding: initial,
            next: initialHead,
          }),
        ),
      ).toBe("applied");
      const status = await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: candidate.expected,
          binding: candidate.binding,
          next: candidate.next,
        }),
      );
      expect(status, candidate.label).toBe("stale");
      expect(await store.getNamespaceHead("ns-update-cas")).toEqual(
        initialHead,
      );
    }
  });

  test("Namespace genesis rejects a canonical non-genesis binding", async () => {
    const store = new InMemoryV2Store();
    const parentHash = new Uint8Array(32).fill(0x52);
    const nonGenesis = binding(
      "ns-genesis-revision",
      1,
      bytes(0x53),
      parentHash,
    );

    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: nonGenesis,
          next: headForBinding(nonGenesis),
        }),
      ),
    ).toBe("stale");
    expect(await store.getNamespaceHead("ns-genesis-revision")).toBeNull();
    expect(
      await store.getBinding("ns-genesis-revision", 1),
    ).toBeNull();
  });

  test("single-use grant claim is atomic and never retries an ambiguous result", async () => {
    const store = new InMemoryV2Store();
    const grant: OpaqueGrantRecordV2 = {
      grantId: "grant-1",
      grantBytes: opaqueBytes("grant", canonicalGrantWire("grant-1")),
      consumed: false,
    };
    await store.putGrant(grant);

    const attempts = await Promise.all([
      store.consumeGrant("grant-1"),
      store.consumeGrant("grant-1"),
    ]);

    expect(attempts.filter((candidate) => candidate !== null)).toHaveLength(1);
    expect((await store.getGrant("grant-1"))?.consumed).toBe(true);

    expect(
      store.putGrant(grant),
    ).rejects.toEqual(
      new Error(
        "Grant record is already initialized with different or consumed state",
      ),
    );
    expect((await store.getGrant("grant-1"))?.consumed).toBe(true);
  });

  test("Grant initialization is immutable, idempotent, and cannot reset consumption under replay", async () => {
    const exact = {
      grantId: "grant-immutable",
      grantBytes: opaqueBytes(
        "grant",
        canonicalGrantWire("grant-immutable", 1),
      ),
      consumed: false,
    } as const;
    const store = new InMemoryV2Store();
    await Promise.all([
      store.putGrant(exact),
      store.putGrant({
        ...exact,
        grantBytes: cloneOpaqueBytes(exact.grantBytes),
      }),
    ]);
    expect(await store.getGrant(exact.grantId)).toEqual({
      grantId: exact.grantId,
      grantBytes: exact.grantBytes.ciphertext,
      consumed: false,
    });
    expect(
      store.putGrant({
        ...exact,
        grantBytes: opaqueBytes(
          "grant",
          canonicalGrantWire("grant-immutable", 2),
        ),
      }),
    ).rejects.toThrow("already initialized");
    expect(
      new InMemoryV2Store().putGrant({ ...exact, consumed: true }),
    ).rejects.toEqual(
      new Error("A newly persisted Grant must be unconsumed"),
    );

    const [claim, replay] = await Promise.allSettled([
      store.consumeGrant(exact.grantId),
      store.putGrant({
        ...exact,
        grantBytes: cloneOpaqueBytes(exact.grantBytes),
      }),
    ]);
    expect(claim.status).toBe("fulfilled");
    expect(
      claim.status === "fulfilled" ? claim.value?.consumed : null,
    ).toBe(true);
    expect(replay.status).toBe("rejected");
    expect((await store.getGrant(exact.grantId))?.consumed).toBe(true);
  });

  test("opaque record indexes must match their authenticated canonical wire coordinates", async () => {
    const store = new InMemoryV2Store();
    expect(
      store.putObject({
        objectId: "object-index",
        payloadBytes: opaqueBytes(
          "encrypted-payload",
          canonicalObjectPayload("object-wire"),
        ),
      }),
    ).rejects.toThrow("does not match");
    expect(
      store.putGrant({
        grantId: "grant-index",
        grantBytes: opaqueBytes(
          "grant",
          canonicalGrantWire("grant-wire"),
        ),
        consumed: false,
      }),
    ).rejects.toThrow("matching Grant wire bytes");
    expect(
      store.compareAndSwapRecoveryArchive(null, {
        humanId: "bob",
        recoveryKeyGeneration: 3,
        archiveBytes: opaqueBytes(
          "recovery-archive",
          canonicalRecoveryArchiveWire("alice", 3),
        ),
      }),
    ).rejects.toThrow("coordinates");
    expect(
      store.compareAndSwapRecoveryArchive(null, {
        humanId: "alice",
        recoveryKeyGeneration: 4,
        archiveBytes: opaqueBytes(
          "recovery-archive",
          canonicalRecoveryArchiveWire("alice", 3),
        ),
      }),
    ).rejects.toThrow("coordinates");

    expect(await store.getObject("object-index")).toBeNull();
    expect(await store.getGrant("grant-index")).toBeNull();
    expect(await store.getRecoveryArchive("alice")).toBeNull();
    expect(await store.getRecoveryArchive("bob")).toBeNull();
  });

  test("durable write factories authenticate canonical bytes, own them, and preserve exact coordinates", () => {
    const objectBytes = canonicalObjectPayload("object-hydrated");
    const object = v2StorageCompatibility.encryptedObjectWriteRecordV2(
      objectBytes,
    );
    expect(object).toMatchObject({
      objectId: "object-hydrated",
      payloadBytes: {
        classification: "opaque-ciphertext",
        kind: "encrypted-payload",
        ciphertext: objectBytes,
      },
    });
    expect(object.payloadBytes.ciphertext).not.toBe(objectBytes);

    const grantBytes = canonicalGrantWire("grant-hydrated");
    const grant = v2StorageCompatibility.grantWriteRecordV2(grantBytes);
    expect(grant).toMatchObject({
      grantId: "grant-hydrated",
      grantBytes: {
        classification: "opaque-ciphertext",
        kind: "grant",
        ciphertext: grantBytes,
      },
      consumed: false,
    });
    expect(grant.grantBytes.ciphertext).not.toBe(grantBytes);

    const recoveryBytes = canonicalRecoveryArchiveWire("alice", 7);
    const recovery =
      v2StorageCompatibility.recoveryArchiveWriteRecordV2(recoveryBytes);
    expect(recovery).toMatchObject({
      humanId: "alice",
      recoveryKeyGeneration: 7,
      archiveBytes: {
        classification: "opaque-ciphertext",
        kind: "recovery-archive",
        ciphertext: recoveryBytes,
      },
    });
    expect(recovery.archiveBytes.ciphertext).not.toBe(recoveryBytes);

    const sourceBinding = binding(
      "ns-hydrated",
      1,
      bytes(0x61),
      new Uint8Array(32).fill(0x60),
    );
    const expectedPreviousBindingHash =
      sourceBinding.previousBindingHash!.slice();
    const durableBinding =
      v2StorageCompatibility.namespaceBindingWriteRecordV2({
        signedBindingBytes: sourceBinding.signedBindingBytes,
        humanKeyringEnvelopeBytes:
          sourceBinding.humanKeyringEnvelope.ciphertext,
        aiKeyringEnvelopeBytes:
          sourceBinding.aiKeyringEnvelope.ciphertext,
      });
    expect(durableBinding).toEqual(sourceBinding);
    expect(durableBinding.signedBindingBytes).not.toBe(
      sourceBinding.signedBindingBytes,
    );
    expect(durableBinding.bindingHash).not.toBe(sourceBinding.bindingHash);
    expect(durableBinding.previousBindingHash).not.toBe(
      sourceBinding.previousBindingHash,
    );
    expect(durableBinding.humanKeyringEnvelope.ciphertext).not.toBe(
      sourceBinding.humanKeyringEnvelope.ciphertext,
    );
    expect(durableBinding.aiKeyringEnvelope.ciphertext).not.toBe(
      sourceBinding.aiKeyringEnvelope.ciphertext,
    );

    objectBytes.fill(0);
    grantBytes.fill(0);
    recoveryBytes.fill(0);
    sourceBinding.signedBindingBytes.fill(0);
    sourceBinding.previousBindingHash!.fill(0);
    sourceBinding.humanKeyringEnvelope.ciphertext.fill(0);
    sourceBinding.aiKeyringEnvelope.ciphertext.fill(0);
    expect(object.payloadBytes.ciphertext).toEqual(
      canonicalObjectPayload("object-hydrated"),
    );
    expect(grant.grantBytes.ciphertext).toEqual(
      canonicalGrantWire("grant-hydrated"),
    );
    expect(recovery.archiveBytes.ciphertext).toEqual(
      canonicalRecoveryArchiveWire("alice", 7),
    );
    expect(durableBinding.previousBindingHash).toEqual(
      expectedPreviousBindingHash,
    );
    expect(parseNamespaceBinding(durableBinding.signedBindingBytes))
      .toMatchObject({ namespaceId: "ns-hydrated", accessRevision: 1 });
  });

  test("every durable decoder re-encodes its accepted canonical wire exactly", () => {
    const sourceBinding = binding("ns-canonical-roundtrip", 0, bytes(0x64));
    const grantBytes = canonicalGrantWire("grant-canonical-roundtrip");
    const grant = parseGrantV2(grantBytes);
    expect(grant).not.toBeNull();
    const cases = [
      [
        sourceBinding.signedBindingBytes,
        serializeNamespaceBinding(
          parseNamespaceBinding(sourceBinding.signedBindingBytes),
        ),
      ],
      [
        sourceBinding.humanKeyringEnvelope.ciphertext,
        serializeNamespaceKeyringEnvelope(
          parseNamespaceKeyringEnvelope(
            sourceBinding.humanKeyringEnvelope.ciphertext,
          ),
        ),
      ],
      [
        sourceBinding.aiKeyringEnvelope.ciphertext,
        serializeNamespaceKeyringEnvelope(
          parseNamespaceKeyringEnvelope(
            sourceBinding.aiKeyringEnvelope.ciphertext,
          ),
        ),
      ],
      [
        canonicalObjectPayload("object-canonical-roundtrip"),
        encodeEncryptedPayloadV2(
          decodeEncryptedPayloadV2(
            canonicalObjectPayload("object-canonical-roundtrip"),
          ),
        ),
      ],
      [grantBytes, serializeGrantV2(grant!)],
      [
        canonicalRecoveryArchiveWire("alice", 8),
        serializeHumanRecoveryArchive(
          decodeHumanRecoveryArchive(
            canonicalRecoveryArchiveWire("alice", 8),
          ),
        ),
      ],
    ] as const;
    for (const [original, canonical] of cases) {
      expect(canonical).toEqual(original);
    }
  });

  test("durable write factories reject non-bytes, oversized bytes, and malformed wires", () => {
    const factories = [
      {
        name: "Namespace binding",
        label: "Signed Namespace binding bytes",
        call: (value: unknown) =>
          v2StorageCompatibility.namespaceBindingWriteRecordV2({
            signedBindingBytes: value as Uint8Array,
            humanKeyringEnvelopeBytes: bytes(1),
            aiKeyringEnvelopeBytes: bytes(1),
          }),
        maximum: V2_LIMITS.ciphertextBytes,
      },
      {
        name: "encrypted object",
        label: "Encrypted payload bytes",
        call: (value: unknown) =>
          v2StorageCompatibility.encryptedObjectWriteRecordV2(
            value as Uint8Array,
          ),
        maximum: V2_LIMITS.ciphertextBytes,
      },
      {
        name: "Grant",
        label: "Grant wire bytes",
        call: (value: unknown) =>
          v2StorageCompatibility.grantWriteRecordV2(value as Uint8Array),
        maximum: V2_LIMITS.agentGrantWireBytes,
      },
      {
        name: "recovery archive",
        label: "Recovery archive bytes",
        call: (value: unknown) =>
          v2StorageCompatibility.recoveryArchiveWriteRecordV2(
            value as Uint8Array,
          ),
        maximum: V2_LIMITS.recoveryArchiveBytes,
      },
    ] as const;
    for (const factory of factories) {
      expect(
        () => factory.call("not-bytes"),
        `${factory.name} type`,
      ).toThrow(`${factory.label} must be Uint8Array`);
      expect(
        () => factory.call(new Uint8Array(factory.maximum + 1)),
        `${factory.name} limit`,
      ).toThrow(
        `${factory.label} exceeds the ${factory.maximum} limit`,
      );
    }
    expect(() =>
      v2StorageCompatibility.grantWriteRecordV2(bytes(1, 2, 3))
    ).toThrow("not a canonical Grant");

    const canonicalBinding = binding(
      "ns-hydration-validation",
      0,
      bytes(0x62),
    );
    const bindingInput = {
      signedBindingBytes: canonicalBinding.signedBindingBytes,
      humanKeyringEnvelopeBytes:
        canonicalBinding.humanKeyringEnvelope.ciphertext,
      aiKeyringEnvelopeBytes:
        canonicalBinding.aiKeyringEnvelope.ciphertext,
    };
    expect(() =>
      v2StorageCompatibility.namespaceBindingWriteRecordV2({
        ...bindingInput,
        extra: true,
      } as never)
    ).toThrow(
      "Durable Namespace binding record has an invalid field set",
    );
    for (const field of [
      "signedBindingBytes",
      "humanKeyringEnvelopeBytes",
      "aiKeyringEnvelopeBytes",
    ] as const) {
      const label = field === "signedBindingBytes"
        ? "Signed Namespace binding bytes"
        : field === "humanKeyringEnvelopeBytes"
          ? "Human keyring envelope bytes"
          : "AI keyring envelope bytes";
      expect(
        () =>
          v2StorageCompatibility.namespaceBindingWriteRecordV2({
            ...bindingInput,
            [field]: "not-bytes",
          } as never),
        `${field} type`,
      ).toThrow(`${label} must be Uint8Array`);
      const maximum = field === "signedBindingBytes"
        ? V2_LIMITS.ciphertextBytes
        : V2_LIMITS.namespaceKeyringBytes;
      expect(
        () =>
          v2StorageCompatibility.namespaceBindingWriteRecordV2({
            ...bindingInput,
            [field]: new Uint8Array(maximum + 1),
          }),
        `${field} limit`,
      ).toThrow(`${label} exceeds the ${maximum} limit`);
    }
  });

  test("Namespace binding validation identifies the exact malformed coordinate", () => {
    const exact = binding("ns-diagnostic", 0, bytes(0x63));
    const invalid: readonly [string, NamespaceBindingRecordV2][] = [
      [
        "Namespace binding record has an invalid field set",
        { ...exact, unexpected: true } as never,
      ],
      [
        "Human keyring envelope must be opaque human-keyring-envelope ciphertext",
        {
          ...exact,
          humanKeyringEnvelope: opaqueBytes(
            "ai-keyring-envelope",
            exact.humanKeyringEnvelope.ciphertext,
          ),
        } as never,
      ],
      [
        "AI keyring envelope must be opaque ai-keyring-envelope ciphertext",
        {
          ...exact,
          aiKeyringEnvelope: opaqueBytes(
            "human-keyring-envelope",
            exact.aiKeyringEnvelope.ciphertext,
          ),
        } as never,
      ],
      [
        `Human keyring envelope bytes exceeds the ${V2_LIMITS.namespaceKeyringBytes} limit`,
        {
          ...exact,
          humanKeyringEnvelope: opaqueBytes(
            "human-keyring-envelope",
            new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
          ),
        },
      ],
      [
        `AI keyring envelope bytes exceeds the ${V2_LIMITS.namespaceKeyringBytes} limit`,
        {
          ...exact,
          aiKeyringEnvelope: opaqueBytes(
            "ai-keyring-envelope",
            new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
          ),
        },
      ],
    ];
    for (const [message, record] of invalid) {
      expect(() => assertCanonicalNamespaceBindingRecord(record))
        .toThrow(message);
    }
  });

  test("grant and recovery persistence validate exact opaque records and detach reads", async () => {
    const store = new InMemoryV2Store();
    const grantWire = canonicalGrantWire("grant-exact");
    const grantBytes = opaqueBytes("grant", grantWire);
    await store.putGrant({
      grantId: "grant-exact",
      grantBytes,
      consumed: false,
    });
    const recoveryBytes = opaqueBytes(
      "recovery-archive",
      canonicalRecoveryArchiveWire("alice", 3),
    );
    expect(await store.compareAndSwapRecoveryArchive(null, {
      humanId: "alice",
      recoveryKeyGeneration: 3,
      archiveBytes: recoveryBytes,
    })).toBe("applied");

    grantBytes.ciphertext.fill(0);
    recoveryBytes.ciphertext.fill(0);
    const storedGrant = await store.getGrant("grant-exact");
    const storedRecovery = await store.getRecoveryArchive("alice");
    expect(storedGrant?.grantBytes).toEqual(grantWire);
    expect(storedRecovery).toEqual({
      humanId: "alice",
      recoveryKeyGeneration: 3,
      archiveBytes: canonicalRecoveryArchiveWire("alice", 3),
    });
    storedGrant!.grantBytes.fill(0);
    storedRecovery!.archiveBytes.fill(0);
    expect(
      (await store.getGrant("grant-exact"))?.grantBytes,
    ).toEqual(grantWire);
    expect(
      (await store.getRecoveryArchive("alice"))?.archiveBytes,
    ).toEqual(canonicalRecoveryArchiveWire("alice", 3));
    expect(await store.getRecoveryArchive("bob")).toBeNull();

    expect(
      store.putGrant({
        grantId: "grant-extra",
        grantBytes: opaqueBytes("grant", bytes(1)),
        consumed: false,
        extra: true,
      } as never),
    ).rejects.toEqual(
      new TypeError("Grant record has an invalid field set"),
    );
    expect(
      store.putGrant({
        grantId: "grant-kind",
        grantBytes: opaqueBytes("recovery-archive", bytes(1)) as never,
        consumed: false,
      }),
    ).rejects.toEqual(
      new TypeError("Grant must be opaque grant ciphertext"),
    );
    expect(
      store.putGrant({
        grantId: "grant-limit",
        grantBytes: opaqueBytes(
          "grant",
          new Uint8Array(V2_LIMITS.agentGrantWireBytes + 1),
        ),
        consumed: false,
      }),
    ).rejects.toEqual(
      new V2LimitError(
        `Grant wire bytes exceeds the ${V2_LIMITS.agentGrantWireBytes} limit`,
      ),
    );
    expect(() =>
      assertCanonicalRecoveryArchiveRecord({
        humanId: "alice",
        recoveryKeyGeneration: 3,
        archiveBytes: opaqueBytes(
          "recovery-archive",
          new Uint8Array(V2_LIMITS.recoveryArchiveBytes + 1),
        ),
      })
    ).toThrow(
      `Recovery archive bytes exceeds the ${V2_LIMITS.recoveryArchiveBytes} limit`,
    );

    expect(
      store.compareAndSwapRecoveryArchive(null, {
        humanId: "alice",
        recoveryKeyGeneration: 3,
        archiveBytes: opaqueBytes("recovery-archive", bytes(1)),
        extra: true,
      } as never),
    ).rejects.toEqual(
      new TypeError("Recovery archive record has an invalid field set"),
    );
    expect(
      store.compareAndSwapRecoveryArchive(null, {
        humanId: "alice",
        recoveryKeyGeneration: -1,
        archiveBytes: opaqueBytes("recovery-archive", bytes(1)),
      }),
    ).rejects.toEqual(
      new V2ValidationError(
        "Recovery key generation must be a non-negative safe integer",
      ),
    );
    expect(
      store.compareAndSwapRecoveryArchive(null, {
        humanId: "alice",
        recoveryKeyGeneration: 3,
        archiveBytes: opaqueBytes("grant", bytes(1)) as never,
      }),
    ).rejects.toEqual(
      new TypeError(
        "Recovery archive must be opaque recovery-archive ciphertext",
      ),
    );
  });

  test("Recovery archive CAS is monotonic, fork-safe, and explicitly retryable after ambiguity", async () => {
    const crypto = new LatticeCrypto();
    const store = new InMemoryV2Store();
    const archive = (generation: number, marker = generation) => ({
      humanId: "alice",
      recoveryKeyGeneration: generation,
      archiveBytes: opaqueBytes(
        "recovery-archive",
        canonicalRecoveryArchiveWire("alice", generation, marker),
      ),
    });
    const generation3 = archive(3);

    expect(
      await store.compareAndSwapRecoveryArchive(null, generation3),
    ).toBe("applied");
    expect(
      await store.compareAndSwapRecoveryArchive(null, generation3),
    ).toBe("duplicate");
    expect(
      await store.compareAndSwapRecoveryArchive(null, archive(3, 9)),
    ).toBe("stale");
    expect(
      await store.compareAndSwapRecoveryArchive(
        {
          humanId: "alice",
          recoveryKeyGeneration: 3,
          archiveHash: new Uint8Array(32).fill(0xfe),
        },
        archive(4),
      ),
    ).toBe("stale");
    const expectedGeneration3 = {
      humanId: "alice",
      recoveryKeyGeneration: 3,
      archiveHash: crypto.hash(
        generation3.archiveBytes.ciphertext,
      ),
    };
    const generation4 = archive(4);
    expect(
      await new InMemoryV2Store().compareAndSwapRecoveryArchive(
        expectedGeneration3,
        generation4,
      ),
    ).toBe("stale");
    expect(
      await store.compareAndSwapRecoveryArchive(
        {
          ...expectedGeneration3,
          recoveryKeyGeneration: 2,
        },
        archive(3, 9),
      ),
    ).toBe("stale");
    for (const [label, malformed] of [
      [
        "field set",
        { ...expectedGeneration3, extra: true },
      ],
      [
        "Human id",
        { ...expectedGeneration3, humanId: "/" },
      ],
      [
        "generation",
        { ...expectedGeneration3, recoveryKeyGeneration: -1 },
      ],
      [
        "hash",
        { ...expectedGeneration3, archiveHash: new Uint8Array(31) },
      ],
    ] as const) {
      expect(
        store.compareAndSwapRecoveryArchive(malformed as never, generation4),
        label,
      ).rejects.toThrow();
    }
    for (const [label, expected, intended] of [
      [
        "expected Human",
        { ...expectedGeneration3, humanId: "bob" },
        generation4,
      ],
      [
        "expected generation",
        { ...expectedGeneration3, recoveryKeyGeneration: 2 },
        generation4,
      ],
      [
        "next generation",
        expectedGeneration3,
        archive(5),
      ],
    ] as const) {
      expect(
        await store.compareAndSwapRecoveryArchive(expected, intended),
        label,
      ).toBe("stale");
      expect(await store.getRecoveryArchive("alice")).toMatchObject({
        recoveryKeyGeneration: 3,
      });
    }
    expect(
      await store.compareAndSwapRecoveryArchive(
        expectedGeneration3,
        generation4,
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwapRecoveryArchive(
        expectedGeneration3,
        archive(4, 8),
      ),
    ).toBe("stale");
    expect(await store.getRecoveryArchive("alice")).toEqual({
      humanId: generation4.humanId,
      recoveryKeyGeneration: generation4.recoveryKeyGeneration,
      archiveBytes: generation4.archiveBytes.ciphertext,
    });

    const reference = new InMemoryV2Store();
    const first = archive(1);
    const transportError = new Error("lost after recovery commit");
    const ambiguous = {
      async compareAndSwapRecoveryArchive() {
        await reference.compareAndSwapRecoveryArchive(null, first);
        throw transportError;
      },
    };
    const error = await ambiguous.compareAndSwapRecoveryArchive().catch(
      (cause: unknown) => cause,
    );
    expect(error).toBe(transportError);
    expect(
      await reference.compareAndSwapRecoveryArchive(null, first),
    ).toBe("duplicate");
  });

  test("object payload bytes are detached and have no competing manifest field", async () => {
    const store = new InMemoryV2Store();
    const canonicalPayload = canonicalObjectPayload("object-1");
    const payload = opaqueBytes("encrypted-payload", canonicalPayload);
    await store.putObject({
      objectId: "object-1",
      payloadBytes: payload,
    });

    payload.ciphertext[0] = 0xff;

    const stored = await store.getObject("object-1");
    expect(stored?.payloadBytes).toEqual(canonicalPayload);
    expect(stored).not.toHaveProperty("accessManifestBytes");
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
    ).not.toContain("compareAndSwapObjectManifest");
    await store.putObject({
      objectId: "object-1",
      payloadBytes: opaqueBytes("encrypted-payload", canonicalPayload),
    });
    expect(
      store.putObject({
        objectId: "object-1",
        payloadBytes: opaqueBytes(
          "encrypted-payload",
          canonicalObjectPayload("object-1", 2),
        ),
      }),
    ).rejects.toEqual(
      new Error(
        "Encrypted object is already initialized with different payload bytes",
      ),
    );
    expect(
      (await store.getObject("object-1"))?.payloadBytes,
    ).toEqual(canonicalPayload);

    expect(
      store.putObject("object-record" as never),
    ).rejects.toEqual(
      new TypeError("Encrypted object record must be an object"),
    );
    expect(
      store.putObject({
        objectId: "object-invalid-fields",
        substitutedPayloadBytes: opaqueBytes(
          "encrypted-payload",
          bytes(1),
        ),
      } as never),
    ).rejects.toEqual(
      new TypeError("Encrypted object record has an invalid field set"),
    );
    expect(
      store.putObject({
        objectId: "object-invalid-kind",
        payloadBytes: opaqueBytes("grant", bytes(1)) as never,
      }),
    ).rejects.toEqual(
      new TypeError(
        "Object payload must be opaque encrypted-payload ciphertext",
      ),
    );
    expect(
      store.putObject({
        objectId: "object-over-limit",
        payloadBytes: opaqueBytes(
          "encrypted-payload",
          new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
        ),
      }),
    ).rejects.toEqual(
      new V2LimitError(
        `Encrypted payload bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
      ),
    );
  });

  test("the complete reference snapshot contains only public metadata and opaque bytes", async () => {
    const store = new InMemoryV2Store();
    await store.createDomainIfAbsent(
      domain("domain-ab", bytes(1, 2), ["alice", "bob"]),
    );
    await store.putDomainProviderHeadIfAbsent(
      providerHead("domain-ab", 0, 0x81),
      bytes(1, 2, 3),
    );
    const snapshotBinding = binding("ns-snapshot", 0, bytes(0x82));
    const snapshotHead = headForBinding(snapshotBinding);
    expect(
      await store.compareAndSwapNamespaceBindingAndHead(
        namespaceWriteCapability({
          expected: null,
          binding: snapshotBinding,
          next: snapshotHead,
        }),
      ),
    ).toBe("applied");
    await store.putGrant({
      grantId: "grant-1",
      grantBytes: opaqueBytes("grant", canonicalGrantWire("grant-1")),
      consumed: false,
    });
    await store.putObject({
      objectId: "object-snapshot",
      payloadBytes: opaqueBytes(
        "encrypted-payload",
        canonicalObjectPayload("object-snapshot"),
      ),
    });
    const crypto = new LatticeCrypto(seededRng(2_251), manualClock(1));
    const objectCommitter = crypto.generateSigningKeyPair();
    const preparedObjectAccess = prepareObjectAccessManifestGenesisV2(
      crypto,
      {
        objectId: objectId("object-snapshot"),
        payloadHash: crypto.hash(
          canonicalObjectPayload("object-snapshot"),
        ),
        envelopeBytes: [],
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: cryptoDeviceId("device-object-snapshot"),
        hostAuthorizationRevision: authorizationRevision(0),
        signingPrivateKey: objectCommitter.privateKey,
      },
    );
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        storage: store,
        prepared: preparedObjectAccess,
        resolveCurrentAuthorization: (context) => ({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: authorizationRevision(0),
          committerSigningPublicKey: objectCommitter.publicKey,
        }),
      }),
    ).toBe("applied");
    expect(await store.compareAndSwapRecoveryArchive(null, {
      humanId: "alice",
      recoveryKeyGeneration: 2,
      archiveBytes: opaqueBytes(
        "recovery-archive",
        canonicalRecoveryArchiveWire("alice", 2),
      ),
    })).toBe("applied");
    await putAuthorizedRuntime(
      store,
      emptyRuntimeState("agent-snapshot"),
    );

    const snapshot = store.snapshot();
    expect(snapshot.domains.map(({ id }) => id)).toEqual(["domain-ab"]);
    expect(snapshot.domainProviderStates).toHaveLength(1);
    expect(snapshot.bindings.map(({ namespaceId: id }) => id)).toEqual([
      "ns-snapshot",
    ]);
    expect(snapshot.namespaceHeads.map(({ namespaceId: id }) => id)).toEqual([
      "ns-snapshot",
    ]);
    expect(snapshot.objects.map(({ objectId: id }) => id)).toEqual([
      "object-snapshot",
    ]);
    expect(snapshot.objectAccessStates.map(({ head: { objectId: id } }) => id))
      .toEqual(["object-snapshot"]);
    expect(snapshot.atomicRuntimeStates.map(
      ({ runtime: { agentId: id } }) => String(id),
    ))
      .toEqual(["agent-snapshot"]);
    expect(snapshot.grants.map(({ grantId: id }) => id)).toEqual(["grant-1"]);
    expect(snapshot.recoveryArchives.map(({ humanId: id }) => id)).toEqual([
      "alice",
    ]);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("plaintextKey");
    expect(json).not.toContain("domainRoot");
    expect(json).not.toContain("namespaceKey");
    expect(json).not.toContain("exporterSecret");
    expect(json).not.toContain("privateKey");

    const sentinels = [
      { label: "human-domain-root", bytes: new Uint8Array(32).fill(0xa1) },
      { label: "namespace-key", bytes: new Uint8Array(32).fill(0xa2) },
      { label: "object-dek", bytes: new Uint8Array(32).fill(0xa3) },
      { label: "runtime-key", bytes: new Uint8Array(32).fill(0xa4) },
      { label: "management-key", bytes: new Uint8Array(32).fill(0xa5) },
      { label: "private-key", bytes: new Uint8Array(32).fill(0xa6) },
      { label: "recovery-key", bytes: new Uint8Array(32).fill(0xa7) },
      { label: "exporter-secret", bytes: new Uint8Array(32).fill(0xa8) },
    ] as const;
    expect(forbiddenSecretPaths(snapshot, sentinels)).toEqual([]);

    const knownLeaks = [
      { domains: [{ rosterBytes: sentinels[0].bytes }] },
      {
        bindings: [{
          humanKeyringEnvelope: {
            ciphertext: new Uint8Array([
              0,
              ...sentinels[1].bytes,
              0,
            ]),
          },
        }],
      },
      { objects: [{ payloadBytes: { ciphertext: sentinels[2].bytes } }] },
      {
        objectAccessStates: [{
          namespaceEnvelopes: [{
            envelopeBytes: { ciphertext: sentinels[5].bytes },
          }],
        }],
      },
      {
        atomicRuntimeStates: [{
          configObjects: [{ wrappedDek: { ciphertext: sentinels[3].bytes } }],
          managementKey: sentinels[4].bytes,
        }],
      },
      { grants: [{ grantBytes: { ciphertext: sentinels[7].bytes } }] },
      {
        recoveryArchives: [{
          archiveBytes: { ciphertext: sentinels[6].bytes },
        }],
      },
    ];
    for (const leak of knownLeaks) {
      expect(forbiddenSecretPaths(leak, sentinels)).not.toEqual([]);
    }

    const methodNames = Object.getOwnPropertyNames(
      Object.getPrototypeOf(store),
    );
    expect(methodNames).not.toContain("updateNamespace");
    expect(methodNames).not.toContain("putSecret");
    expect(methodNames).not.toContain("putKey");
  });

  test("plain secret bytes are neither type-compatible nor runtime-compatible with opaque records", async () => {
    type PlainBytesAreRejected =
      Uint8Array extends OpaqueBytes<"grant"> ? false : true;
    expect(true as PlainBytesAreRejected).toBe(true);

    const store = new InMemoryV2Store();
    const forgedPlaintextSecret = {
      kind: "grant",
      classification: "plaintext-secret",
      bytes: bytes(0xde, 0xad),
    };
    expect(
      store.putGrant({
        grantId: "grant-forged",
        // Deliberate hostile untyped boundary: runtime validation must still
        // reject a key-shaped object that bypasses TypeScript.
        grantBytes: forgedPlaintextSecret as unknown as OpaqueBytes<"grant">,
        consumed: false,
      }),
    ).rejects.toThrow("opaque grant");
    expect(await store.getGrant("grant-forged")).toBeNull();
  });

  test("exported opaque factory cannot relabel key-like plaintext as persisted v2 ciphertext", async () => {
    const store = new InMemoryV2Store();
    const keyLike = new Uint8Array(32).fill(0x5a);

    expect(
      store.putObject({
        objectId: "object-opaque-bypass",
        payloadBytes: opaqueBytes("encrypted-payload", keyLike),
      }),
    ).rejects.toThrow();
    expect(
      store.putGrant({
        grantId: "grant-opaque-bypass",
        grantBytes: opaqueBytes("grant", keyLike),
        consumed: false,
      }),
    ).rejects.toThrow(
      "canonical matching Grant wire bytes",
    );
    expect(
      store.compareAndSwapRecoveryArchive(null, {
        humanId: "alice",
        recoveryKeyGeneration: 1,
        archiveBytes: opaqueBytes("recovery-archive", keyLike),
      }),
    ).rejects.toThrow();

    const runtime = structuredClone(
      runtimeStateWithConfig(
        "agent-opaque-bypass",
        0,
        0,
      ),
    );
    Object.assign(runtime.configObjects[0]!.wrappedDek, {
      ciphertext: keyLike.slice(),
    });
    expect(
      putAuthorizedRuntime(store, runtime),
    ).rejects.toThrow(
      "must be opaque agent-runtime-config-dek ciphertext",
    );

    const runtimeWithDomain: AgentRuntimeAtomicStorageStateV2 = {
      ...emptyRuntimeState("agent-domain-opaque-bypass"),
      domainEnvelopes: [{
        ...runtimeDomainEnvelopeRecord({
          agent: "agent-domain-opaque-bypass",
          authorization: 0,
          generation: 0,
          domain: "domain-a",
          marker: 1,
        }),
        envelopeHash: new LatticeCrypto().hash(keyLike),
        envelopeBytes: opaqueBytes(
          "agent-runtime-domain-envelope",
          keyLike,
        ),
      }],
    };
    expect(
      putAuthorizedRuntime(store, runtimeWithDomain),
    ).rejects.toThrow();

    expect(store.snapshot().objects).toEqual([]);
    expect(store.snapshot().grants).toEqual([]);
    expect(store.snapshot().recoveryArchives).toEqual([]);
    expect(store.snapshot().atomicRuntimeStates).toEqual([]);
  });

  test("a raw Domain root cannot masquerade as a persisted Namespace keyring envelope", async () => {
    const store = new InMemoryV2Store();
    const valid = binding("namespace-root-substitution", 0, bytes(0x30));
    const rawDomainRoot = new Uint8Array(32).fill(0x5a);
    expect(
      store.compareAndSwapNamespaceBindingAndHead(
        {
          expected: null,
          binding: {
            ...valid,
            humanKeyringEnvelope: opaqueBytes(
              "human-keyring-envelope",
              rawDomainRoot,
            ),
          },
          next: head("namespace-root-substitution", 0, bytes(0x30)),
        } as never,
      ),
    ).rejects.toThrow("authorized write capability");
    expect(
      await store.getBinding("namespace-root-substitution", 0),
    ).toBeNull();
  });

  test("rejects unknown key-shaped fields at every server-facing record boundary", async () => {
    const store = new InMemoryV2Store();
    const leakedKey = new Uint8Array(32).fill(0x5a);

    expect(
      store.createDomainIfAbsent({
        ...domain("domain-leak", bytes(1), ["alice"]),
        plaintextKey: leakedKey,
      } as never),
    ).rejects.toThrow("invalid field set");
    const providerStore = new InMemoryV2Store();
    await providerStore.createDomainIfAbsent(
      domain("domain-provider-leak", bytes(9), ["alice"]),
    );
    expect(
      providerStore.putDomainProviderHeadIfAbsent(
        {
          ...providerHead("domain-provider-leak", 0, 0x10),
          exporterSecret: leakedKey,
        } as never,
        bytes(1, 2, 3),
      ),
    ).rejects.toThrow("invalid field set");
    expect(await providerStore.getDomainProviderHead("domain-provider-leak"))
      .toBeNull();
    expect(
      store.compareAndSwapNamespaceBindingAndHead(
        {
          expected: null,
          binding: {
            ...binding("ns-leak", 0, bytes(2)),
            domainRoot: leakedKey,
          },
          next: head("ns-leak", 0, bytes(2)),
        } as never,
      ),
    ).rejects.toThrow("authorized write capability");
    expect(
      store.compareAndSwapNamespaceBindingAndHead(
        {
          expected: null,
          binding: binding("ns-leak", 0, bytes(2)),
          next: {
            ...head("ns-leak", 0, bytes(2)),
            namespaceKey: leakedKey,
          },
        } as never,
      ),
    ).rejects.toThrow("authorized write capability");
    expect(
      store.putObject({
        objectId: "object-leak",
        payloadBytes: opaqueBytes("encrypted-payload", bytes(3)),
        dek: leakedKey,
      } as never),
    ).rejects.toThrow("invalid field set");
    expect(
      store.putObject({
        objectId: "object-manifest-escape",
        payloadBytes: opaqueBytes("encrypted-payload", bytes(3)),
        accessManifestBytes: bytes(4),
      } as never),
    ).rejects.toThrow("invalid field set");
    expect(
      putAuthorizedRuntime(store, {
        ...emptyRuntimeState("agent-leak"),
        runtimeKey: leakedKey,
      } as never),
    ).rejects.toThrow("invalid field set");
    expect(
      store.putGrant({
        grantId: "grant-leak",
        grantBytes: opaqueBytes("grant", bytes(6)),
        consumed: false,
        privateKey: leakedKey,
      } as never),
    ).rejects.toThrow("invalid field set");
    expect(
      store.compareAndSwapRecoveryArchive(null, {
        humanId: "alice",
        recoveryKeyGeneration: 1,
        archiveBytes: opaqueBytes("recovery-archive", bytes(7)),
        exporterSecret: leakedKey,
      } as never),
    ).rejects.toThrow("invalid field set");
    expect(
      store.putGrant({
        grantId: "grant-nested-leak",
        grantBytes: {
          ...opaqueBytes("grant", bytes(8)),
          plaintextKey: leakedKey,
        } as never,
        consumed: false,
      }),
    ).rejects.toThrow("opaque grant");

    expect(store.snapshot()).toEqual({
      domains: [],
      domainProviderStates: [],
      bindings: [],
      namespaceHeads: [],
      objects: [],
      objectAccessStates: [],
      atomicRuntimeStates: [],
      grants: [],
      recoveryArchives: [],
    });
  });

  test("record limits fail before an oversized value enters the store", async () => {
    const store = new InMemoryV2Store();
    expect(
      store.putGrant({
        grantId: "grant-oversized",
        grantBytes: opaqueBytes(
          "grant",
          new Uint8Array(V2_LIMITS.agentGrantWireBytes + 1),
        ),
        consumed: false,
      }),
    ).rejects.toThrow("limit");

    const oversizedRuntime = emptyRuntimeState("agent-1");
    expect(
      putAuthorizedRuntime(store, {
        ...oversizedRuntime,
        configInventory: {
          objectCount: V2_LIMITS.batchItems + 1,
          digest: new Uint8Array(32),
        },
        configObjects: Array.from(
          { length: V2_LIMITS.batchItems + 1 },
          (_, index) => ({
            agentId: "agent-1",
            objectId: `config-${index}`,
            configRevision: 0,
            runtimeGeneration: 0,
            wrappedDekHash: new Uint8Array(32),
            wrappedDek: opaqueBytes(
              "agent-runtime-config-dek",
              new Uint8Array(40),
            ),
          }),
        ),
      }),
    ).rejects.toThrow("limit");

    expect(await store.getGrant("grant-oversized")).toBeNull();
    expect(await store.getAgentRuntimeAtomicState("agent-1")).toBeNull();
  });

  test("Runtime initialization recomputes inventory commitments and has no non-atomic write escape", async () => {
    const store = new InMemoryV2Store();
    const initial = emptyRuntimeState("agent-exact");
    expect(
      putAuthorizedRuntime(store, {
        ...initial,
        configInventory: {
          ...initial.configInventory,
          digest: new Uint8Array(32).fill(0xff),
        },
      }),
    ).rejects.toThrow("digest");
    expect(await store.getAgentRuntimeAtomicState("agent-exact")).toBeNull();

    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
    ).not.toContain("putAgentRuntime");
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
    ).not.toContain("getAgentRuntime");
  });

  test("Runtime authorization-only transitions have one dedicated atomic CAS", () => {
    const store = new InMemoryV2Store();
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
    ).toContain("compareAndSwapAgentRuntimeAuthorizationTransition");
  });

  test("Runtime authorization-only CAS applies once, converges on duplicate, and rejects stale state", async () => {
    const agent = "agent-authorization-transition";
    const challengeHash = new Uint8Array(32).fill(0xa1);
    const initialConfig = runtimeStateWithConfig(agent, 0, 0, {
      objectId: "config-a",
      configRevision: 2,
      marker: 0x31,
    });
    const initial: AgentRuntimeAtomicStorageStateV2 = {
      ...initialConfig,
      domainEnvelopes: [runtimeDomainEnvelopeRecord({
        agent,
        authorization: 0,
        generation: 0,
        domain: "domain-a",
        marker: 1,
      })],
      challengeConsumptions: [{
        challengeHash: challengeHash.slice(),
        consumed: false,
      }],
    };
    const intended: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(initial),
      runtime: {
        ...initial.runtime,
        authorizationRevision: authorizationRevision(1),
      },
      domainEnvelopes: [
        initial.domainEnvelopes[0]!,
        runtimeDomainEnvelopeRecord({
          agent,
          authorization: 1,
          generation: 0,
          domain: "domain-b",
          marker: 2,
        }),
      ],
      challengeConsumptions: [{
        challengeHash: challengeHash.slice(),
        consumed: true,
      }],
    };
    const store = await initializedRuntimeRotationStore(initial);
    expect(await putAuthorizedRuntimeAuthorizationTransition(
      store,
      initial,
      intended,
      ["domain-b"],
    )).toBe("applied");
    expect(await putAuthorizedRuntimeAuthorizationTransition(
      store,
      initial,
      intended,
      ["domain-b"],
      intended.runtime,
    )).toBe("duplicate");

    const staleCurrent: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(initial),
      domainEnvelopes: [runtimeDomainEnvelopeRecord({
        agent,
        authorization: 0,
        generation: 0,
        domain: "domain-stale",
        marker: 9,
      })],
    };
    const staleStore =
      await initializedRuntimeRotationStore(staleCurrent);
    expect(await putAuthorizedRuntimeAuthorizationTransition(
      staleStore,
      initial,
      intended,
      ["domain-b"],
    )).toBe("stale");
    expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
      runtimeWire(intended),
    );
  });

  test("Runtime signer publication capabilities reject substitution and authorization-only mutation", async () => {
    const initial = emptyRuntimeState("agent-signer-capability");
    const intended: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(initial),
      runtime: {
        ...initial.runtime,
        authorizationRevision: authorizationRevision(1),
      },
    };
    const store = await initializedRuntimeRotationStore(initial);
    const persistedPublication =
      await store.getAgentRuntimeSignerPublication(
        initial.runtime.agentId,
        initial.runtime.runtimeGeneration,
      );
    expect(persistedPublication).not.toBeNull();
    const authorize = (
      signerPublication: NonNullable<typeof persistedPublication>,
    ) =>
      authorizeAgentRuntimeAuthorizationTransitionWriteV2({
        expected: initial,
        intended,
        authorization: {
          purpose: "persist-agent-runtime-authorization-transition",
          operationId: "operation-signer-capability",
          currentState: initial.runtime,
          nextState: intended.runtime,
          remainingDomains: [],
          refreshedDomainIds: [],
        },
        signerPublication,
      });
    const authentic = authorize(persistedPublication!);
    const substituted = {
      ...authentic,
      signerPublication: agentRuntimeSignerPublicationForTesting({
        state: initial.runtime,
        transitionKind: "initialization",
        operationId: "operation-substituted-capability",
      }),
    } as typeof authentic;
    expect(
      store.compareAndSwapAgentRuntimeAuthorizationTransition(substituted),
    ).rejects.toThrow("authorized write capability");

    const mutatedPublication =
      agentRuntimeSignerPublicationForTesting({
        state: initial.runtime,
        transitionKind: "initialization",
        operationId: "operation-mutated-same-generation",
      });
    expect(
      await store.compareAndSwapAgentRuntimeAuthorizationTransition(
        authorize(mutatedPublication),
      ),
    ).toBe("stale");
    expect(
      await store.getAgentRuntimeSignerPublication(
        initial.runtime.agentId,
        initial.runtime.runtimeGeneration,
      ),
    ).toEqual(persistedPublication);
    expect(await store.getAgentRuntimeAtomicState(initial.runtime.agentId))
      .toEqual(runtimeWire(initial));
    expect(await store.getAgentRuntimeSignerPublication(
      initial.runtime.agentId,
      99,
    )).toBeNull();
    expect(store.getAgentRuntimeSignerPublication(
      initial.runtime.agentId,
      -1,
    )).rejects.toThrow("Agent Runtime signer generation");
  });

  test("Runtime authorization-only CAS preserves config/generation and binds refresh/challenge sets", async () => {
    const agent = "agent-authorization-transition-invalid";
    const challengeHash = new Uint8Array(32).fill(0xb1);
    const initial: AgentRuntimeAtomicStorageStateV2 = {
      ...runtimeStateWithConfig(agent, 0, 0, { marker: 1 }),
      challengeConsumptions: [{
        challengeHash: challengeHash.slice(),
        consumed: false,
      }],
    };
    const valid: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(initial),
      runtime: {
        ...initial.runtime,
        authorizationRevision: authorizationRevision(1),
      },
      domainEnvelopes: [runtimeDomainEnvelopeRecord({
        agent,
        authorization: 1,
        generation: 0,
        domain: "domain-a",
        marker: 2,
      })],
      challengeConsumptions: [{
        challengeHash: challengeHash.slice(),
        consumed: true,
      }],
    };

    for (const invalid of [
      {
        ...cloneAtomicRuntimeState(valid),
        runtime: {
          ...valid.runtime,
          runtimeGeneration: agentRuntimeGeneration(1),
        },
      },
      runtimeStateWithConfig(agent, 1, 0, { marker: 9 }),
      {
        ...cloneAtomicRuntimeState(valid),
        challengeConsumptions: [{
          challengeHash: challengeHash.slice(),
          consumed: false,
        }],
      },
    ]) {
      const store = await initializedRuntimeRotationStore(initial);
      expect(putAuthorizedRuntimeAuthorizationTransition(
        store,
        initial,
        invalid,
        ["domain-a"],
      )).rejects.toThrow();
      expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
        runtimeWire(initial),
      );
    }
  });

  test("Runtime authorization-only CAS rejects every invalid transition coordinate", async () => {
    const { initial, intended } =
      runtimeAuthorizationTransitionFixture("agent-transition-coordinate");
    const otherAgent = runtimeStateWithConfigs(
      "agent-transition-other",
      1,
      0,
      [
        { objectId: "config-a", configRevision: 2, marker: 0x31 },
        { objectId: "config-b", configRevision: 4, marker: 0x32 },
      ],
    );
    const nextGeneration = runtimeStateWithConfigs(
      initial.runtime.agentId,
      1,
      1,
      [
        { objectId: "config-a", configRevision: 2, marker: 0x41 },
        { objectId: "config-b", configRevision: 4, marker: 0x42 },
      ],
    );
    const invalidStates: readonly AgentRuntimeAtomicStorageStateV2[] = [
      {
        ...cloneAtomicRuntimeState(intended),
        runtime: {
          ...intended.runtime,
          authorizationRevision: initial.runtime.authorizationRevision,
        },
      },
      {
        ...cloneAtomicRuntimeState(intended),
        runtime: {
          ...intended.runtime,
          authorizationRevision: authorizationRevision(2),
        },
      },
      {
        ...nextGeneration,
        domainEnvelopes: [runtimeDomainEnvelopeRecord({
          agent: initial.runtime.agentId,
          authorization: 1,
          generation: 1,
          domain: "domain-b",
          marker: 5,
        })],
        challengeConsumptions: intended.challengeConsumptions,
      },
      {
        ...otherAgent,
        domainEnvelopes: [],
        challengeConsumptions: [],
      },
    ];

    for (const invalid of invalidStates) {
      const store = await initializedRuntimeRotationStore(initial);
      expect(putAuthorizedRuntimeAuthorizationTransition(
        store,
        initial,
        invalid,
        invalid.domainEnvelopes.length === 0 ? [] : ["domain-b"],
      )).rejects.toThrow(
        "one exact authorization advance and no generation change",
      );
      expect(await store.getAgentRuntimeAtomicState(initial.runtime.agentId))
        .toEqual(runtimeWire(initial));
    }
  });

  test("Runtime authorization-only CAS preserves each committed config coordinate", async () => {
    const agent = "agent-transition-config";
    const { initial, intended } = runtimeAuthorizationTransitionFixture(agent);
    const configVariants = [
      [{ objectId: "config-a", configRevision: 2, marker: 0x31 }],
      [
        { objectId: "config-a0", configRevision: 2, marker: 0x31 },
        { objectId: "config-b", configRevision: 4, marker: 0x32 },
      ],
      [
        { objectId: "config-a", configRevision: 3, marker: 0x31 },
        { objectId: "config-b", configRevision: 4, marker: 0x32 },
      ],
      [
        { objectId: "config-a", configRevision: 2, marker: 0x39 },
        { objectId: "config-b", configRevision: 4, marker: 0x32 },
      ],
    ] as const;

    for (const configs of configVariants) {
      const changedConfig = runtimeStateWithConfigs(agent, 1, 0, configs);
      const invalid: AgentRuntimeAtomicStorageStateV2 = {
        ...cloneAtomicRuntimeState(intended),
        configInventory: changedConfig.configInventory,
        configObjects: changedConfig.configObjects,
      };
      const store = await initializedRuntimeRotationStore(initial);
      expect(putAuthorizedRuntimeAuthorizationTransition(
        store,
        initial,
        invalid,
        ["domain-b"],
      )).rejects.toThrow("must preserve exact config");
      expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
        runtimeWire(initial),
      );
    }
  });

  test("Runtime authorization-only CAS requires the persisted signer coordinates", async () => {
    const { initial, intended } = runtimeAuthorizationTransitionFixture(
      "agent-transition-signer",
    );
    const invalidPublications = [
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...initial.runtime,
          agentId: agentId("agent-transition-signer-other"),
        },
        transitionKind: "initialization",
      }),
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...initial.runtime,
          runtimeGeneration: agentRuntimeGeneration(1),
        },
        transitionKind: "rotation",
      }),
    ];

    for (const publication of invalidPublications) {
      const store = await initializedRuntimeRotationStore(initial);
      expect(putAuthorizedRuntimeAuthorizationTransition(
        store,
        initial,
        intended,
        ["domain-b"],
        initial.runtime,
        publication,
      )).rejects.toThrow("must preserve its exact signer publication");
      expect(await store.getAgentRuntimeAtomicState(initial.runtime.agentId))
        .toEqual(runtimeWire(initial));
    }
  });

  test("Runtime authorization-only CAS requires a sorted exact Domain refresh set", async () => {
    const agent = "agent-transition-refresh-set";
    const { initial, intended } = runtimeAuthorizationTransitionFixture(agent);
    const bothRefreshed: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(intended),
      domainEnvelopes: [
        runtimeDomainEnvelopeRecord({
          agent,
          authorization: 1,
          generation: 0,
          domain: "domain-a",
          marker: 4,
        }),
        intended.domainEnvelopes[1]!,
      ],
      challengeConsumptions: intended.challengeConsumptions.map(
        (challenge) => ({ ...challenge, consumed: true }),
      ),
    };
    const cases = [
      { state: intended, refreshed: ["domain-b", "domain-b"] },
      { state: bothRefreshed, refreshed: ["domain-b", "domain-a"] },
    ] as const;

    for (const invalid of cases) {
      const store = await initializedRuntimeRotationStore(initial);
      expect(putAuthorizedRuntimeAuthorizationTransition(
        store,
        initial,
        invalid.state,
        invalid.refreshed,
      )).rejects.toThrow("must be sorted and unique");
      expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
        runtimeWire(initial),
      );
    }
  });

  test("Runtime authorization-only CAS binds changed Domains to the refresh set exactly", async () => {
    const agent = "agent-transition-domain-set";
    const { initial, intended } = runtimeAuthorizationTransitionFixture(agent);
    const unchangedDomains: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(intended),
      domainEnvelopes: initial.domainEnvelopes,
    };
    const cases = [
      { state: intended, refreshed: [] },
      { state: unchangedDomains, refreshed: ["domain-b"] },
      { state: unchangedDomains, refreshed: ["domain-c"] },
    ] as const;

    for (const invalid of cases) {
      const store = await initializedRuntimeRotationStore(initial);
      expect(putAuthorizedRuntimeAuthorizationTransition(
        store,
        initial,
        invalid.state,
        invalid.refreshed,
      )).rejects.toThrow("refresh set is not exact");
      expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
        runtimeWire(initial),
      );
    }
  });

  test("Runtime authorization-only CAS binds one fresh challenge to each refreshed Domain", async () => {
    const agent = "agent-transition-challenge-set";
    const { initial, intended, challengeHashes } =
      runtimeAuthorizationTransitionFixture(agent);
    const cases: readonly AgentRuntimeAtomicStorageStateV2[] = [
      {
        ...cloneAtomicRuntimeState(intended),
        challengeConsumptions: [],
      },
      {
        ...cloneAtomicRuntimeState(intended),
        challengeConsumptions: intended.challengeConsumptions.map(
          (challenge, index) => ({
            ...challenge,
            challengeHash: index === 1
              ? new Uint8Array(32).fill(0xee)
              : challenge.challengeHash,
          }),
        ),
      },
      {
        ...cloneAtomicRuntimeState(intended),
        challengeConsumptions: initial.challengeConsumptions,
      },
      {
        ...cloneAtomicRuntimeState(intended),
        challengeConsumptions: [
          { challengeHash: challengeHashes[0]!, consumed: true },
          { challengeHash: challengeHashes[1]!, consumed: true },
        ],
      },
    ];

    for (const invalid of cases) {
      const store = await initializedRuntimeRotationStore(initial);
      expect(putAuthorizedRuntimeAuthorizationTransition(
        store,
        initial,
        invalid,
        ["domain-b"],
      )).rejects.toThrow("challenge set is not exact");
      expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
        runtimeWire(initial),
      );
    }
  });

  test("Runtime authorization-only CAS never permits challenge consumption rollback", async () => {
    const agent = "agent-transition-challenge-rollback";
    const { initial, intended } = runtimeAuthorizationTransitionFixture(agent);
    const consumedInitial: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(initial),
      challengeConsumptions: [
        { ...initial.challengeConsumptions[0]!, consumed: true },
        initial.challengeConsumptions[1]!,
      ],
    };
    const rollback: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(intended),
      challengeConsumptions: [
        { ...intended.challengeConsumptions[0]!, consumed: false },
        { ...intended.challengeConsumptions[1]!, consumed: true },
      ],
    };
    const store = await initializedRuntimeRotationStore(consumedInitial);
    expect(putAuthorizedRuntimeAuthorizationTransition(
      store,
      consumedInitial,
      rollback,
      ["domain-b"],
    )).rejects.toThrow("challenge set is not exact");
    expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
      runtimeWire(consumedInitial),
    );
  });

  test("Runtime authorization-only CAS rejects an authorization for a future live state", async () => {
    const agent = "agent-transition-future-live-state";
    const { initial, intended } = runtimeAuthorizationTransitionFixture(agent);
    const store = await initializedRuntimeRotationStore(initial);
    expect(await putAuthorizedRuntimeAuthorizationTransition(
      store,
      initial,
      intended,
      ["domain-b"],
      intended.runtime,
    )).toBe("stale");
    expect(await store.getAgentRuntimeAtomicState(agent)).toEqual(
      runtimeWire(initial),
    );
  });

  test("Runtime authorization-only CAS can remove the final Domain without rotating", async () => {
    const agent = "agent-authorization-transition-remove";
    const initial: AgentRuntimeAtomicStorageStateV2 = {
      ...emptyRuntimeState(agent),
      domainEnvelopes: [runtimeDomainEnvelopeRecord({
        agent,
        authorization: 0,
        generation: 0,
        domain: "domain-a",
        marker: 3,
      })],
    };
    const intended: AgentRuntimeAtomicStorageStateV2 = {
      ...cloneAtomicRuntimeState(initial),
      runtime: {
        ...initial.runtime,
        authorizationRevision: authorizationRevision(1),
      },
      domainEnvelopes: [],
    };
    const store = await initializedRuntimeRotationStore(initial);
    expect(await putAuthorizedRuntimeAuthorizationTransition(
      store,
      initial,
      intended,
      [],
    )).toBe("applied");
    expect(
      (await store.getAgentRuntimeAtomicState(agent))?.domainEnvelopes,
    ).toEqual([]);
  });

  test("Runtime initialization is exact, idempotent, detached, and fail-closed", async () => {
    const store = new InMemoryV2Store();
    const initial = emptyRuntimeState("agent-init");
    expect(await putAuthorizedRuntime(store, initial)).toBe(
      "inserted",
    );
    expect(
      await putAuthorizedRuntime(
        store,
        emptyRuntimeState("agent-init"),
      ),
    ).toBe("existing");
    expect(
      putAuthorizedRuntime(store, {
        ...emptyRuntimeState("agent-init"),
        runtime: {
          ...emptyRuntimeState("agent-init").runtime,
          authorizationRevision: authorizationRevision(1),
        },
      }),
    ).rejects.toEqual(
      new Error(
        "Agent Runtime atomic state is already initialized with different bytes",
      ),
    );
    expect(await store.getAgentRuntimeAtomicState("agent-missing")).toBeNull();
    expect(store.getAgentRuntimeAtomicState("")).rejects.toThrow("Agent id");
    expect(await store.getAgentRuntimeAtomicState("agent-init")).toEqual(
      runtimeWire(initial),
    );
  });

  test("Runtime initialization requires exact signer coordinates and publication history", async () => {
    const initial = emptyRuntimeState("agent-init-signer");
    const invalidPublications = [
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...initial.runtime,
          agentId: agentId("agent-init-signer-other"),
        },
        transitionKind: "initialization",
      }),
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...initial.runtime,
          runtimeGeneration: agentRuntimeGeneration(1),
        },
        transitionKind: "rotation",
      }),
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...initial.runtime,
          authorizationRevision: authorizationRevision(1),
        },
        transitionKind: "initialization",
      }),
    ];
    for (const publication of invalidPublications) {
      const store = new InMemoryV2Store();
      expect(putAuthorizedRuntime(
        store,
        initial,
        publication,
      )).rejects.toThrow(
        "initialization signer publication does not match its state",
      );
      expect(await store.getAgentRuntimeAtomicState(initial.runtime.agentId))
        .toBeNull();
    }

    const store = new InMemoryV2Store();
    expect(await putAuthorizedRuntime(store, initial)).toBe("inserted");
    const conflictingHistory = agentRuntimeSignerPublicationForTesting({
      state: initial.runtime,
      transitionKind: "initialization",
      operationId: "operation-conflicting-initialization-history",
    });
    expect(putAuthorizedRuntime(
      store,
      initial,
      conflictingHistory,
    )).rejects.toThrow(
      "signer publication history does not match initialized state",
    );
    expect(await store.getAgentRuntimeAtomicState(initial.runtime.agentId))
      .toEqual(runtimeWire(initial));
  });

  test("Runtime initialization idempotency compares each committed byte family", async () => {
    const expectDifferent = async (
      initial: AgentRuntimeAtomicStorageStateV2,
      variant: AgentRuntimeAtomicStorageStateV2,
    ) => {
      const store = new InMemoryV2Store();
      expect(await putAuthorizedRuntime(store, initial)).toBe(
        "inserted",
      );
      expect(
        putAuthorizedRuntime(store, variant),
      ).rejects.toEqual(
        new Error(
          "Agent Runtime atomic state is already initialized with different bytes",
        ),
      );
    };

    const configAgent = "agent-init-config";
    const configInitial = runtimeStateWithConfig(configAgent, 0, 0, {
      marker: 1,
    });
    for (const variant of [
      runtimeStateWithConfig(configAgent, 1, 0, { marker: 1 }),
      runtimeStateWithConfig(configAgent, 0, 1, { marker: 1 }),
      runtimeStateWithConfig(configAgent, 0, 0, {
        objectId: "config-b",
        marker: 1,
      }),
      runtimeStateWithConfig(configAgent, 0, 0, {
        configRevision: 1,
        marker: 1,
      }),
      runtimeStateWithConfig(configAgent, 0, 0, { marker: 2 }),
      runtimeStateWithConfigs(configAgent, 0, 0, [
        { objectId: "config-a", configRevision: 0, marker: 1 },
        { objectId: "config-b", configRevision: 0, marker: 2 },
      ]),
    ]) {
      await expectDifferent(configInitial, variant);
    }

    const envelopeAgent = "agent-init-envelope";
    const envelopeInitial: AgentRuntimeAtomicStorageStateV2 = {
      ...emptyRuntimeState(envelopeAgent),
      domainEnvelopes: [runtimeDomainEnvelopeRecord({
        agent: envelopeAgent,
        authorization: 1,
        generation: 0,
        domain: "domain-a",
        marker: 1,
      })],
    };
    await expectDifferent(envelopeInitial, {
      ...emptyRuntimeState(envelopeAgent),
      domainEnvelopes: [],
    });
    await expectDifferent(envelopeInitial, {
      ...emptyRuntimeState(envelopeAgent),
      domainEnvelopes: [runtimeDomainEnvelopeRecord({
        agent: envelopeAgent,
        authorization: 1,
        generation: 0,
        domain: "domain-b",
        marker: 2,
      })],
    });

    const challengeAgent = "agent-init-challenge";
    const challengeInitial: AgentRuntimeAtomicStorageStateV2 = {
      ...emptyRuntimeState(challengeAgent),
      challengeConsumptions: [{
        challengeHash: new Uint8Array(32).fill(1),
        consumed: false,
      }],
    };
    await expectDifferent(challengeInitial, {
      ...emptyRuntimeState(challengeAgent),
      challengeConsumptions: [],
    });
    await expectDifferent(challengeInitial, {
      ...emptyRuntimeState(challengeAgent),
      challengeConsumptions: [{
        challengeHash: new Uint8Array(32).fill(2),
        consumed: false,
      }],
    });
    await expectDifferent(challengeInitial, {
      ...emptyRuntimeState(challengeAgent),
      challengeConsumptions: [{
        challengeHash: new Uint8Array(32).fill(1),
        consumed: true,
      }],
    });
  });

  test("mutation contract: Runtime rotation CAS applies, deduplicates, rejects stale state, and detaches", async () => {
    const fixture = runtimeRotationFixture();
    const store = await initializedRuntimeRotationStore(fixture.initial);
    expect(
      await putAuthorizedRuntimeRotation(store,
        fixture.expected,
        fixture.intended,
      ),
    ).toBe("applied");
    const stored = await store.getAgentRuntimeAtomicState(
      fixture.initial.runtime.agentId,
    );
    expect(stored).toEqual(runtimeWire(fixture.intended));

    const duplicate = runtimeRotationFixture();
    expect(
      await putAuthorizedRuntimeRotation(store,
        duplicate.expected,
        duplicate.intended,
      ),
    ).toBe("duplicate");

    const absent = runtimeRotationFixture("agent-runtime-absent");
    expect(
      await putAuthorizedRuntimeRotation(
        new InMemoryV2Store(),
        absent.expected,
        absent.intended,
      ),
    ).toBe("stale");

    for (const consumed of [false, true]) {
      const agent = `agent-runtime-carried-${String(consumed)}`;
      const challenge = {
        challengeHash: new Uint8Array(32).fill(0x41),
        consumed,
      };
      const initial: AgentRuntimeAtomicStorageStateV2 = {
        ...runtimeStateWithConfig(agent, 0, 0),
        challengeConsumptions: [challenge],
      };
      const intended: AgentRuntimeAtomicStorageStateV2 = {
        ...runtimeStateWithConfig(agent, 1, 1, { marker: 2 }),
        challengeConsumptions: [{
          challengeHash: challenge.challengeHash.slice(),
          consumed,
        }],
      };
      const carriedStore =
        await initializedRuntimeRotationStore(initial);
      expect(
        await putAuthorizedRuntimeRotation(carriedStore,
          runtimeExpectation(initial),
          intended,
        ),
      ).toBe("applied");
    }

    const mismatchedCurrent = runtimeRotationFixture(
      "agent-runtime-stale",
    );
    const staleStore = await initializedRuntimeRotationStore(
      mismatchedCurrent.initial,
    );
    const otherInitial: AgentRuntimeAtomicStorageStateV2 = {
      ...runtimeStateWithConfig("agent-runtime-stale", 0, 0, {
        objectId: "config-a",
        configRevision: 2,
        marker: 0x99,
      }),
      challengeConsumptions:
        mismatchedCurrent.initial.challengeConsumptions,
    };
    expect(
      await putAuthorizedRuntimeRotation(staleStore,
        runtimeExpectation(otherInitial),
        mismatchedCurrent.intended,
      ),
    ).toBe("stale");

    {
      const agent = "agent-runtime-stale-auth";
      const initial = runtimeStateWithConfig(agent, 0, 0);
      const expected = runtimeExpectation(initial);
      const intended = runtimeStateWithConfig(agent, 2, 1, {
        marker: 2,
      });
      const authStore = await initializedRuntimeRotationStore(initial);
      expect(
        await putAuthorizedRuntimeRotation(authStore,
          {
            ...expected,
            runtime: {
              ...expected.runtime,
              authorizationRevision: authorizationRevision(1),
            },
          },
          intended,
        ),
      ).toBe("stale");
    }
    {
      const agent = "agent-runtime-stale-generation";
      const initial = emptyRuntimeState(agent);
      const expectedState: AgentRuntimeAtomicStorageStateV2 = {
        ...emptyRuntimeState(agent),
        runtime: {
          ...initial.runtime,
          runtimeGeneration: agentRuntimeGeneration(1),
        },
      };
      const intended: AgentRuntimeAtomicStorageStateV2 = {
        ...emptyRuntimeState(agent),
        runtime: {
          ...initial.runtime,
          authorizationRevision: authorizationRevision(1),
          runtimeGeneration: agentRuntimeGeneration(2),
        },
      };
      const generationStore =
        await initializedRuntimeRotationStore(initial);
      expect(
        await putAuthorizedRuntimeRotation(generationStore,
          runtimeExpectation(expectedState),
          intended,
        ),
      ).toBe("stale");
    }
    {
      const agent = "agent-runtime-stale-challenges";
      const hash = (fill: number) => new Uint8Array(32).fill(fill);
      const initial: AgentRuntimeAtomicStorageStateV2 = {
        ...runtimeStateWithConfig(agent, 0, 0),
        challengeConsumptions: [
          { challengeHash: hash(0x40), consumed: false },
          { challengeHash: hash(0x41), consumed: false },
        ],
      };
      const expectedState: AgentRuntimeAtomicStorageStateV2 = {
        ...initial,
        challengeConsumptions: [
          { challengeHash: hash(0x40), consumed: false },
          { challengeHash: hash(0x42), consumed: false },
        ],
      };
      const intended: AgentRuntimeAtomicStorageStateV2 = {
        ...runtimeStateWithConfig(agent, 1, 1, { marker: 2 }),
        challengeConsumptions: expectedState.challengeConsumptions,
      };
      const challengeStore =
        await initializedRuntimeRotationStore(initial);
      expect(
        await putAuthorizedRuntimeRotation(challengeStore,
          runtimeExpectation(expectedState),
          intended,
        ),
      ).toBe("stale");
      expect(
        await putAuthorizedRuntimeRotation(challengeStore,
          {
            ...runtimeExpectation(initial),
            challengeConsumptions: [],
          },
          {
            ...intended,
            challengeConsumptions: [],
          },
        ),
      ).toBe("stale");
      expect(
        await putAuthorizedRuntimeRotation(challengeStore,
          {
            ...runtimeExpectation(initial),
            challengeConsumptions: [{
              challengeHash: hash(0x40),
              consumed: true,
            }, initial.challengeConsumptions[1]!],
          },
          {
            ...intended,
            challengeConsumptions: [{
              challengeHash: hash(0x40),
              consumed: true,
            }, initial.challengeConsumptions[1]!],
          },
        ),
      ).toBe("stale");
    }

    const snapshot = structuredClone(stored!);
    fixture.expected.configInventory.digest.fill(0);
    fixture.expected.configObjects[0]!.wrappedDekHash.fill(0);
    fixture.expected.challengeConsumptions[0]!.challengeHash.fill(0);
    fixture.intended.configInventory.digest.fill(0);
    fixture.intended.configObjects[0]!.wrappedDekHash.fill(0);
    fixture.intended.configObjects[0]!.wrappedDek.ciphertext.fill(0);
    fixture.intended.domainEnvelopes[0]!.envelopeHash.fill(0);
    fixture.intended.domainEnvelopes[0]!.envelopeBytes.ciphertext.fill(0);
    fixture.intended.challengeConsumptions[0]!.challengeHash.fill(0);
    expect(
      await store.getAgentRuntimeAtomicState(
        fixture.initial.runtime.agentId,
      ),
    ).toEqual(snapshot);
  });

  test("mutation contract: Runtime rotation CAS requires one exact advance and config rewrap set", async () => {
    const agent = "agent-runtime-write-set";
    const initial = runtimeStateWithConfig(agent, 0, 0, {
      objectId: "config-a",
      configRevision: 2,
      marker: 1,
    });
    const expected = runtimeExpectation(initial);
    const valid = runtimeStateWithConfig(agent, 1, 1, {
      objectId: "config-a",
      configRevision: 2,
      marker: 2,
    });
    const expectCasError = async (
      intended: AgentRuntimeAtomicStorageStateV2,
      message: string,
    ) => {
      const store = await initializedRuntimeRotationStore(initial);
      expect(await rejectedMessage(() =>
        putAuthorizedRuntimeRotation(store, expected, intended)
      )).toBe(message);
      expect(
        await store.getAgentRuntimeAtomicState(agent),
      ).toEqual(runtimeWire(initial));
    };
    const advanceMessage =
      "Agent Runtime CAS requires one exact authorization and generation advance";
    await expectCasError(
      runtimeStateWithConfig("agent-other", 1, 1),
      advanceMessage,
    );
    await expectCasError(
      { ...valid, runtime: { ...valid.runtime,
        authorizationRevision: authorizationRevision(0) } },
      advanceMessage,
    );
    await expectCasError(
      { ...valid, runtime: { ...valid.runtime,
        authorizationRevision: authorizationRevision(2) } },
      advanceMessage,
    );
    for (const generation of [0, 2]) {
      const candidate = runtimeStateWithConfig(agent, 1, generation, {
        objectId: "config-a",
        configRevision: 2,
        marker: 2,
      });
      await expectCasError(candidate, advanceMessage);
    }

    const configMessage =
      "Agent Runtime CAS write set does not exactly rewrap config";
    await expectCasError(emptyRuntimeState(agent), advanceMessage);
    const emptyNext: AgentRuntimeAtomicStorageStateV2 = {
      ...emptyRuntimeState(agent),
      runtime: valid.runtime,
    };
    await expectCasError(emptyNext, configMessage);
    await expectCasError(
      runtimeStateWithConfig(agent, 1, 1, {
        objectId: "config-b",
        configRevision: 2,
        marker: 2,
      }),
      configMessage,
    );
    await expectCasError(
      runtimeStateWithConfig(agent, 1, 1, {
        objectId: "config-a",
        configRevision: 3,
        marker: 2,
      }),
      configMessage,
    );
  });

  test("mutation contract: Runtime rotation requires exact next signer coordinates", async () => {
    const fixture = runtimeRotationFixture("agent-runtime-signer");
    const invalidPublications = [
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...fixture.intended.runtime,
          agentId: agentId("agent-runtime-signer-other"),
        },
        transitionKind: "rotation",
      }),
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...fixture.intended.runtime,
          authorizationRevision: authorizationRevision(2),
        },
        transitionKind: "rotation",
      }),
      agentRuntimeSignerPublicationForTesting({
        state: {
          ...fixture.intended.runtime,
          runtimeGeneration: agentRuntimeGeneration(2),
        },
        transitionKind: "rotation",
      }),
    ];

    for (const publication of invalidPublications) {
      const store = await initializedRuntimeRotationStore(fixture.initial);
      expect(putAuthorizedRuntimeRotation(
        store,
        fixture.expected,
        fixture.intended,
        publication,
      )).rejects.toThrow(
        "rotation signer publication does not match its state",
      );
      expect(await store.getAgentRuntimeAtomicState(
        fixture.initial.runtime.agentId,
      )).toEqual(runtimeWire(fixture.initial));
    }
  });

  test("mutation contract: Runtime rotation duplicate requires the persisted publication", async () => {
    const fixture = runtimeRotationFixture(
      "agent-runtime-duplicate-publication",
    );
    const store = await initializedRuntimeRotationStore(fixture.initial);
    expect(await putAuthorizedRuntimeRotation(
      store,
      fixture.expected,
      fixture.intended,
    )).toBe("applied");
    expect(await store.getAgentRuntimeSignerPublication(
      fixture.initial.runtime.agentId,
      fixture.initial.runtime.runtimeGeneration,
    )).toEqual(agentRuntimeSignerPublicationForTesting({
      state: fixture.initial.runtime,
      transitionKind: "initialization",
    }));
    expect(await store.getAgentRuntimeSignerPublication(
      fixture.intended.runtime.agentId,
      fixture.intended.runtime.runtimeGeneration,
    )).toEqual(agentRuntimeSignerPublicationForTesting({
      state: fixture.intended.runtime,
      transitionKind: "rotation",
      operationId: "operation-storage-test",
    }));
    const conflictingPublication = agentRuntimeSignerPublicationForTesting({
      state: fixture.intended.runtime,
      transitionKind: "rotation",
      operationId: "operation-conflicting-rotation-publication",
    });
    expect(await putAuthorizedRuntimeRotation(
      store,
      fixture.expected,
      fixture.intended,
      conflictingPublication,
    )).toBe("stale");
    expect(await store.getAgentRuntimeAtomicState(
      fixture.initial.runtime.agentId,
    )).toEqual(runtimeWire(fixture.intended));
  });

  test("mutation contract: Runtime rotation CAS consumes exactly the signed challenge write set", async () => {
    const fixture = runtimeRotationFixture("agent-runtime-challenges");
    const message =
      "Agent Runtime CAS write set does not consume exactly its challenges";
    const expectChallengeError = async (
      initial: AgentRuntimeAtomicStorageStateV2,
      expected: ReturnType<typeof runtimeExpectation>,
      intended: AgentRuntimeAtomicStorageStateV2,
    ) => {
      const store = await initializedRuntimeRotationStore(initial);
      expect(await rejectedMessage(() =>
        putAuthorizedRuntimeRotation(store, expected, intended)
      )).toBe(message);
    };
    await expectChallengeError(
      fixture.initial,
      fixture.expected,
      { ...fixture.intended, challengeConsumptions: [] },
    );
    await expectChallengeError(
      fixture.initial,
      fixture.expected,
      {
        ...fixture.intended,
        challengeConsumptions: [{
          challengeHash: new Uint8Array(32).fill(0x92),
          consumed: true,
        }],
      },
    );
    await expectChallengeError(
      fixture.initial,
      fixture.expected,
      { ...fixture.intended, domainEnvelopes: [] },
    );

    const consumedInitial: AgentRuntimeAtomicStorageStateV2 = {
      ...fixture.initial,
      challengeConsumptions: [{
        challengeHash: fixture.challengeHash.slice(),
        consumed: true,
      }],
    };
    const regressed: AgentRuntimeAtomicStorageStateV2 = {
      ...fixture.intended,
      domainEnvelopes: [],
      challengeConsumptions: [{
        challengeHash: fixture.challengeHash.slice(),
        consumed: false,
      }],
    };
    await expectChallengeError(
      consumedInitial,
      runtimeExpectation(consumedInitial),
      regressed,
    );
  });

  test("mutation contract: Runtime rotation expectation validates every direct-store field", async () => {
    const fixture = runtimeRotationFixture(
      "agent-runtime-expectation",
    );
    const expectError = async (
      expected: unknown,
      message: string,
    ) => {
      expect(await rejectedMessage(() =>
        putAuthorizedRuntimeRotation(
          new InMemoryV2Store(),
          expected as never,
          fixture.intended,
        )
      )).toBe(message);
    };
    await expectError(
      null,
      "Agent Runtime rotation expectation must be an object",
    );
    await expectError(
      { ...fixture.expected, unexpected: true },
      "Agent Runtime rotation expectation has an invalid field set",
    );
    await expectError(
      { ...fixture.expected, runtime: null },
      "Expected Agent Runtime public state must be an object",
    );
    await expectError(
      {
        ...fixture.expected,
        runtime: { ...fixture.expected.runtime, unexpected: true },
      },
      "Expected Agent Runtime public state has an invalid field set",
    );
    await expectError(
      {
        ...fixture.expected,
        runtime: { ...fixture.expected.runtime, agentId: "" },
      },
      "Agent id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    await expectError(
      {
        ...fixture.expected,
        runtime: {
          ...fixture.expected.runtime,
          authorizationRevision: -1,
        },
      },
      "Authorization revision must be a non-negative safe integer",
    );
    await expectError(
      {
        ...fixture.expected,
        runtime: {
          ...fixture.expected.runtime,
          runtimeGeneration: -1,
        },
      },
      "Agent Runtime generation must be a non-negative safe integer",
    );
    await expectError(
      { ...fixture.expected, configInventory: null },
      "Expected Agent Runtime config inventory commitment must be an object",
    );
    await expectError(
      {
        ...fixture.expected,
        configInventory: {
          ...fixture.expected.configInventory,
          unexpected: true,
        },
      },
      "Expected Agent Runtime config inventory commitment has an invalid field set",
    );
    await expectError(
      {
        ...fixture.expected,
        configInventory: {
          ...fixture.expected.configInventory,
          objectCount: V2_LIMITS.batchItems + 1,
        },
      },
      `Expected Agent Runtime config count exceeds the ${V2_LIMITS.batchItems} limit`,
    );
    await expectError(
      {
        ...fixture.expected,
        configInventory: {
          ...fixture.expected.configInventory,
          digest: new Uint8Array(31),
        },
      },
      "Expected Agent Runtime config inventory digest must be exactly 32 bytes",
    );
    await expectError(
      { ...fixture.expected, configObjects: null },
      "Expected Agent Runtime config objects must be an array",
    );
    await expectError(
      {
        ...fixture.expected,
        configInventory: {
          ...fixture.expected.configInventory,
          objectCount: 0,
        },
      },
      "Expected Agent Runtime config coverage is incomplete",
    );
    await expectError(
      {
        ...fixture.expected,
        configObjects: [{
          ...fixture.expected.configObjects[0]!,
          unexpected: true,
        }],
      },
      "Expected Agent Runtime config object has an invalid field set",
    );
    await expectError(
      {
        ...fixture.expected,
        configObjects: [{
          ...fixture.expected.configObjects[0]!,
          agentId: agentId("agent-other"),
        }],
      },
      "Expected Agent Runtime config coordinates are inconsistent",
    );
    await expectError(
      {
        ...fixture.expected,
        configObjects: [{
          ...fixture.expected.configObjects[0]!,
          runtimeGeneration: agentRuntimeGeneration(9),
        }],
      },
      "Expected Agent Runtime config coordinates are inconsistent",
    );
    await expectError(
      {
        ...fixture.expected,
        configObjects: [{
          ...fixture.expected.configObjects[0]!,
          objectId: "",
        }],
      },
      "Object id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    await expectError(
      {
        ...fixture.expected,
        configObjects: [{
          ...fixture.expected.configObjects[0]!,
          configRevision: -1,
        }],
      },
      "Authorization revision must be a non-negative safe integer",
    );
    await expectError(
      {
        ...fixture.expected,
        configObjects: [{
          ...fixture.expected.configObjects[0]!,
          wrappedDekHash: new Uint8Array(31),
        }],
      },
      "Expected Agent Runtime wrapped-DEK hash must be exactly 32 bytes",
    );

    const twoConfigs = runtimeStateWithConfigs(
      fixture.initial.runtime.agentId,
      0,
      0,
      [
        { objectId: "config-a", configRevision: 1, marker: 1 },
        { objectId: "config-b", configRevision: 1, marker: 2 },
      ],
    );
    const twoExpectation = runtimeExpectation(twoConfigs);
    const twoConfigIntended = runtimeStateWithConfigs(
      fixture.initial.runtime.agentId,
      1,
      1,
      [
        { objectId: "config-a", configRevision: 1, marker: 3 },
        { objectId: "config-b", configRevision: 1, marker: 4 },
      ],
    );
    expect(
      await putAuthorizedRuntimeRotation(
        new InMemoryV2Store(),
        twoExpectation,
        twoConfigIntended,
      ),
    ).toBe("stale");
    for (const configObjects of [
      [
        twoExpectation.configObjects[0]!,
        twoExpectation.configObjects[0]!,
      ],
      [...twoExpectation.configObjects].reverse(),
    ]) {
      await expectError(
        { ...twoExpectation, configObjects },
        "Expected Agent Runtime config objects must be sorted and unique",
      );
    }
    await expectError(
      {
        ...fixture.expected,
        configInventory: {
          ...fixture.expected.configInventory,
          digest: new Uint8Array(32).fill(0xff),
        },
      },
      "Expected Agent Runtime config inventory digest does not match config objects",
    );
    await expectError(
      { ...fixture.expected, challengeConsumptions: null },
      "Expected Agent Runtime challenge consumptions must be an array",
    );
    await expectError(
      {
        ...fixture.expected,
        challengeConsumptions: Array.from(
          { length: V2_LIMITS.agentGrantDomains + 1 },
          (_, index) => {
            const challengeHash = new Uint8Array(32);
            new DataView(challengeHash.buffer).setUint32(28, index);
            return { challengeHash, consumed: false };
          },
        ),
      },
      `Expected Agent Runtime challenge consumption count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
    );
    await expectError(
      {
        ...fixture.expected,
        challengeConsumptions: [{
          ...fixture.expected.challengeConsumptions[0]!,
          unexpected: true,
        }],
      },
      "Expected Agent Runtime challenge consumption has an invalid field set",
    );
    await expectError(
      {
        ...fixture.expected,
        challengeConsumptions: [{
          challengeHash: new Uint8Array(31),
          consumed: false,
        }],
      },
      "Expected Agent Runtime challenge hash must be exactly 32 bytes",
    );
    await expectError(
      {
        ...fixture.expected,
        challengeConsumptions: [{
          challengeHash: new Uint8Array(32),
          consumed: "no",
        }],
      },
      "Expected Agent Runtime challenge consumed state must be boolean",
    );
    const challenge = fixture.expected.challengeConsumptions[0]!;
    for (const challengeConsumptions of [
      [challenge, challenge],
      [
        { challengeHash: new Uint8Array(32).fill(0x92), consumed: false },
        challenge,
      ],
    ]) {
      await expectError(
        { ...fixture.expected, challengeConsumptions },
        "Expected Agent Runtime challenges must be sorted and unique",
      );
    }
  });

  test("mutation contract: Runtime atomic state validates config, envelope, and challenge inventories exactly", async () => {
    const fixture = runtimeRotationFixture("agent-runtime-atomic");
    const valid = fixture.intended;
    const expectStateError = async (
      state: unknown,
      message: string,
    ) => {
      expect(await rejectedMessage(() =>
        putAuthorizedRuntime(
          new InMemoryV2Store(),
          state as AgentRuntimeAtomicStorageStateV2,
        )
      )).toBe(message);
    };
    await expectStateError(
      null,
      "Agent Runtime atomic state must be an object",
    );
    await expectStateError(
      { ...valid, unexpected: true },
      "Agent Runtime atomic state has an invalid field set",
    );
    await expectStateError(
      { ...valid, runtime: null },
      "Agent Runtime public state must be an object",
    );
    await expectStateError(
      {
        ...valid,
        runtime: { ...valid.runtime, unexpected: true },
      },
      "Agent Runtime public state has an invalid field set",
    );
    await expectStateError(
      { ...valid, runtime: { ...valid.runtime, agentId: "" } },
      "Agent id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    await expectStateError(
      {
        ...valid,
        runtime: {
          ...valid.runtime,
          authorizationRevision: -1,
        },
      },
      "Authorization revision must be a non-negative safe integer",
    );
    await expectStateError(
      {
        ...valid,
        runtime: { ...valid.runtime, runtimeGeneration: -1 },
      },
      "Agent Runtime generation must be a non-negative safe integer",
    );
    await expectStateError(
      { ...valid, configInventory: null },
      "Agent Runtime config inventory commitment must be an object",
    );
    await expectStateError(
      {
        ...valid,
        configInventory: {
          ...valid.configInventory,
          unexpected: true,
        },
      },
      "Agent Runtime config inventory commitment has an invalid field set",
    );
    await expectStateError(
      {
        ...valid,
        configInventory: {
          ...valid.configInventory,
          objectCount: V2_LIMITS.batchItems + 1,
        },
      },
      `Agent Runtime config inventory count exceeds the ${V2_LIMITS.batchItems} limit`,
    );
    await expectStateError(
      {
        ...valid,
        configInventory: {
          ...valid.configInventory,
          digest: new Uint8Array(31),
        },
      },
      "Agent Runtime config inventory digest must be exactly 32 bytes",
    );
    await expectStateError(
      { ...valid, configObjects: null },
      "Agent Runtime config objects must be an array",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: Array.from(
          { length: V2_LIMITS.batchItems + 1 },
          () => valid.configObjects[0]!,
        ),
      },
      `Agent Runtime config object count exceeds the ${V2_LIMITS.batchItems} limit`,
    );
    await expectStateError(
      {
        ...valid,
        configInventory: {
          ...valid.configInventory,
          objectCount: 0,
        },
      },
      "Agent Runtime config object count does not match its inventory commitment",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          unexpected: true,
        }],
      },
      "Agent Runtime config object has an invalid field set",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          agentId: agentId("agent-other"),
        }],
      },
      "Agent Runtime config object has the wrong Agent",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          runtimeGeneration: agentRuntimeGeneration(9),
        }],
      },
      "Agent Runtime config object has the wrong Runtime generation",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          objectId: "",
        }],
      },
      "Object id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          configRevision: -1,
        }],
      },
      "Authorization revision must be a non-negative safe integer",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          wrappedDekHash: new Uint8Array(31),
        }],
      },
      "Agent Runtime wrapped-DEK hash must be exactly 32 bytes",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          wrappedDek: opaqueBytes(
            "agent-runtime-config-dek",
            new Uint8Array(39),
          ),
        }],
      },
      "Agent Runtime config wrapped DEK ciphertext is too short",
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          wrappedDek: opaqueBytes(
            "agent-runtime-config-dek",
            new Uint8Array(V2_LIMITS.wrappedDekBytes + 1),
          ),
        }],
      },
      `Agent Runtime config wrapped DEK bytes exceeds the ${V2_LIMITS.wrappedDekBytes} limit`,
    );
    await expectStateError(
      {
        ...valid,
        configObjects: [{
          ...valid.configObjects[0]!,
          wrappedDekHash: new Uint8Array(32),
        }],
      },
      "Agent Runtime config wrapped-DEK hash is invalid",
    );

    const twoConfigs = runtimeStateWithConfigs(
      valid.runtime.agentId,
      valid.runtime.authorizationRevision,
      valid.runtime.runtimeGeneration,
      [
        { objectId: "config-a", configRevision: 1, marker: 1 },
        { objectId: "config-b", configRevision: 1, marker: 2 },
      ],
    );
    expect(
      await putAuthorizedRuntime(
        new InMemoryV2Store(),
        twoConfigs,
      ),
    ).toBe("inserted");
    for (const configObjects of [
      [twoConfigs.configObjects[0]!, twoConfigs.configObjects[0]!],
      [...twoConfigs.configObjects].reverse(),
    ]) {
      await expectStateError(
        { ...twoConfigs, configObjects },
        "Agent Runtime config objects must be sorted and unique",
      );
    }
    await expectStateError(
      {
        ...valid,
        configInventory: {
          ...valid.configInventory,
          digest: new Uint8Array(32).fill(0xff),
        },
      },
      "Agent Runtime config inventory digest does not match config objects",
    );

    await expectStateError(
      { ...valid, domainEnvelopes: null },
      "Agent Runtime Domain envelopes must be an array",
    );
    await expectStateError(
      {
        ...valid,
        domainEnvelopes: Array.from(
          { length: V2_LIMITS.agentGrantDomains + 1 },
          () => valid.domainEnvelopes[0]!,
        ),
      },
      `Agent Runtime Domain envelope count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
    );
    await expectStateError(
      {
        ...valid,
        domainEnvelopes: [{
          ...valid.domainEnvelopes[0]!,
          unexpected: true,
        }],
      },
      "Agent Runtime Domain envelope record has an invalid field set",
    );
    for (const [overrides, message] of [
      [{ agentId: agentId("agent-other") },
        "Agent Runtime Domain envelope has the wrong Agent"],
      [{ runtimeGeneration: agentRuntimeGeneration(9) },
        "Agent Runtime Domain envelope has the wrong Runtime generation"],
      [{ domainId: "" },
        "Crypto Domain id must be 1-128 ASCII bytes using the portable identifier grammar"],
      [{ domainEpoch: -1 },
        "Domain epoch must be a non-negative safe integer"],
      [{ agentAuthorizationRevision: -1 },
        "Authorization revision must be a non-negative safe integer"],
      [{ committerDeviceId: "" },
        "Crypto device id must be 1-128 ASCII bytes using the portable identifier grammar"],
      [{ envelopeHash: new Uint8Array(31) },
        "Agent Runtime Domain envelope hash must be exactly 32 bytes"],
    ] as const) {
      await expectStateError(
        {
          ...valid,
          domainEnvelopes: [{
            ...valid.domainEnvelopes[0]!,
            ...overrides,
          }],
        },
        message,
      );
    }
    await expectStateError(
      {
        ...valid,
        domainEnvelopes: [{
          ...valid.domainEnvelopes[0]!,
          envelopeBytes: opaqueBytes(
            "agent-runtime-domain-envelope",
            new Uint8Array([
              ...valid.domainEnvelopes[0]!.envelopeBytes.ciphertext,
              0,
            ]),
          ),
        }],
      },
      "trailing bytes (1)",
    );
    await expectStateError(
      {
        ...valid,
        domainEnvelopes: [{
          ...valid.domainEnvelopes[0]!,
          envelopeHash: new Uint8Array(32),
        }],
      },
      "Agent Runtime Domain envelope record is noncanonical or inconsistent",
    );
    await expectStateError(
      {
        ...valid,
        domainEnvelopes: [{
          ...valid.domainEnvelopes[0]!,
          envelopeBytes: opaqueBytes(
            "grant",
            valid.domainEnvelopes[0]!.envelopeBytes.ciphertext,
          ),
        }],
      },
      "Agent Runtime Domain envelope must be opaque agent-runtime-domain-envelope ciphertext",
    );
    expect(() =>
      assertAgentRuntimeAtomicState({
        ...valid,
        domainEnvelopes: [{
          ...valid.domainEnvelopes[0]!,
          envelopeBytes: opaqueBytes(
            "grant",
            valid.domainEnvelopes[0]!.envelopeBytes.ciphertext,
          ) as never,
        }],
      })
    ).toThrow(
      "Agent Runtime Domain envelope must be opaque agent-runtime-domain-envelope ciphertext",
    );

    const decodedEnvelope = parseAgentRuntimeDomainEnvelope(
      valid.domainEnvelopes[0]!.envelopeBytes.ciphertext,
    );
    const encodedCoordinateVariants = [
      { ...decodedEnvelope, agentId: agentId("agent-encoded-other") },
      {
        ...decodedEnvelope,
        domainId: cryptoDomainId("domain-encoded-other"),
      },
      {
        ...decodedEnvelope,
        domainEpoch: domainEpoch(decodedEnvelope.domainEpoch + 1),
      },
      {
        ...decodedEnvelope,
        agentAuthorizationRevision: authorizationRevision(
          decodedEnvelope.agentAuthorizationRevision + 1,
        ),
      },
      {
        ...decodedEnvelope,
        runtimeGeneration: agentRuntimeGeneration(
          decodedEnvelope.runtimeGeneration + 1,
        ),
      },
      {
        ...decodedEnvelope,
        committerDeviceId: cryptoDeviceId("device-encoded-other"),
      },
    ];
    for (const encoded of encodedCoordinateVariants) {
      const ciphertext = serializeAgentRuntimeDomainEnvelope(encoded);
      await expectStateError(
        {
          ...valid,
          domainEnvelopes: [{
            ...valid.domainEnvelopes[0]!,
            envelopeHash: fixture.crypto.hash(ciphertext),
            envelopeBytes: opaqueBytes(
              "agent-runtime-domain-envelope",
              ciphertext,
            ),
          }],
        },
        "Agent Runtime Domain envelope record is noncanonical or inconsistent",
      );
    }

    const oversizedDomainRecords = ["domain-large-a", "domain-large-b"]
      .map((domainIdValue, index) => {
        const encoded = {
          ...decodedEnvelope,
          domainId: cryptoDomainId(domainIdValue),
          ciphertext: new Uint8Array(600_000).fill(0x30 + index),
        };
        const ciphertext = serializeAgentRuntimeDomainEnvelope(encoded);
        return {
          ...valid.domainEnvelopes[0]!,
          domainId: encoded.domainId,
          envelopeHash: fixture.crypto.hash(ciphertext),
          envelopeBytes: opaqueBytes(
            "agent-runtime-domain-envelope",
            ciphertext,
          ),
        };
      });
    await expectStateError(
      {
        ...valid,
        domainEnvelopes: oversizedDomainRecords,
      },
      `Agent Runtime Domain aggregate envelope bytes exceeds the ${V2_LIMITS.manifestEnvelopeBytes} limit`,
    );
    const twoDomains: AgentRuntimeAtomicStorageStateV2 = {
      ...runtimeStateWithConfig(
        valid.runtime.agentId,
        valid.runtime.authorizationRevision,
        valid.runtime.runtimeGeneration,
      ),
      domainEnvelopes: [
        runtimeDomainEnvelopeRecord({
          agent: valid.runtime.agentId,
          authorization: valid.runtime.authorizationRevision,
          generation: valid.runtime.runtimeGeneration,
          domain: "domain-a",
          marker: 4,
        }),
        runtimeDomainEnvelopeRecord({
          agent: valid.runtime.agentId,
          authorization: valid.runtime.authorizationRevision,
          generation: valid.runtime.runtimeGeneration,
          domain: "domain-b",
          marker: 5,
        }),
      ],
    };
    expect(
      await putAuthorizedRuntime(
        new InMemoryV2Store(),
        twoDomains,
      ),
    ).toBe("inserted");
    for (const domainEnvelopes of [
      [twoDomains.domainEnvelopes[0]!, twoDomains.domainEnvelopes[0]!],
      [...twoDomains.domainEnvelopes].reverse(),
    ]) {
      await expectStateError(
        { ...twoDomains, domainEnvelopes },
        "Agent Runtime Domain envelopes must be sorted and unique",
      );
    }

    await expectStateError(
      { ...valid, challengeConsumptions: null },
      "Agent Runtime challenge consumptions must be an array",
    );
    await expectStateError(
      {
        ...valid,
        challengeConsumptions: Array.from(
          { length: V2_LIMITS.agentGrantDomains + 1 },
          (_, index) => {
            const challengeHash = new Uint8Array(32);
            new DataView(challengeHash.buffer).setUint32(28, index);
            return { challengeHash, consumed: false };
          },
        ),
      },
      `Agent Runtime challenge consumption count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
    );
    await expectStateError(
      {
        ...valid,
        challengeConsumptions: [{
          ...valid.challengeConsumptions[0]!,
          unexpected: true,
        }],
      },
      "Agent Runtime challenge consumption has an invalid field set",
    );
    await expectStateError(
      {
        ...valid,
        challengeConsumptions: [{
          challengeHash: new Uint8Array(31),
          consumed: false,
        }],
      },
      "Agent Runtime challenge consumption hash must be exactly 32 bytes",
    );
    await expectStateError(
      {
        ...valid,
        challengeConsumptions: [{
          challengeHash: new Uint8Array(32),
          consumed: "no",
        }],
      },
      "Agent Runtime challenge consumed state must be boolean",
    );
    const challenge = valid.challengeConsumptions[0]!;
    for (const challengeConsumptions of [
      [challenge, challenge],
      [
        { challengeHash: new Uint8Array(32).fill(0x92), consumed: false },
        challenge,
      ],
    ]) {
      await expectStateError(
        { ...valid, challengeConsumptions },
        "Agent Runtime challenge consumptions must be sorted and unique",
      );
    }
  });

  test("storage adapter hydrates Runtime wire collections and detects Domain-only wire state", () => {
    const intended = runtimeRotationFixture("agent-adapter-runtime").intended;
    const durable = runtimeWire(intended);
    const validated = storageAdapterSupportV2
      .validateAgentRuntimeAtomicState(durable);
    expect(validated).toEqual(durable);
    expect(validated).not.toBe(durable);
    expect(validated.configObjects).not.toBe(durable.configObjects);
    expect(validated.configObjects[0]?.wrappedDekHash)
      .not.toBe(durable.configObjects[0]?.wrappedDekHash);
    expect(validated.configObjects[0]?.wrappedDekBytes)
      .not.toBe(durable.configObjects[0]?.wrappedDekBytes);
    expect(validated.domainEnvelopes).not.toBe(durable.domainEnvelopes);
    expect(validated.domainEnvelopes[0]?.envelopeHash)
      .not.toBe(durable.domainEnvelopes[0]?.envelopeHash);
    expect(validated.domainEnvelopes[0]?.envelopeBytes)
      .not.toBe(durable.domainEnvelopes[0]?.envelopeBytes);
    expect(validated.challengeConsumptions)
      .not.toBe(durable.challengeConsumptions);
    expect(validated.challengeConsumptions[0]?.challengeHash)
      .not.toBe(durable.challengeConsumptions[0]?.challengeHash);

    expect(
      storageAdapterSupportV2.validateAgentRuntimeAtomicState(intended),
    ).toEqual(durable);

    const configOnlyOpaque = runtimeStateWithConfigs(
      "agent-adapter-config-only",
      0,
      0,
      [
        { objectId: "config-a", configRevision: 0, marker: 5 },
        { objectId: "config-b", configRevision: 0, marker: 6 },
      ],
    );
    const configOnlyWire = runtimeWire(configOnlyOpaque);
    expect(
      storageAdapterSupportV2.validateAgentRuntimeAtomicState(configOnlyWire),
    ).toEqual(configOnlyWire);
    expect(
      storageAdapterSupportV2.validateAgentRuntimeAtomicState(configOnlyOpaque),
    ).toEqual(configOnlyWire);

    const domainOnlyOpaque = {
      ...emptyRuntimeState("agent-adapter-domain-only"),
      domainEnvelopes: [runtimeDomainEnvelopeRecord({
        agent: "agent-adapter-domain-only",
        authorization: 0,
        generation: 0,
        domain: "domain-adapter-only",
        marker: 7,
      })],
    };
    const domainOnlyWire = runtimeWire(domainOnlyOpaque);
    expect(
      storageAdapterSupportV2.validateAgentRuntimeAtomicState(domainOnlyWire),
    ).toEqual(domainOnlyWire);
    expect(
      storageAdapterSupportV2.validateAgentRuntimeAtomicState(domainOnlyOpaque),
    ).toEqual(domainOnlyWire);

    expect(() =>
      storageAdapterSupportV2.validateAgentRuntimeAtomicState({
        ...durable,
        configObjects: "configs",
      } as never)
    ).toThrow("Agent Runtime durable collections must be arrays");
    expect(() =>
      storageAdapterSupportV2.validateAgentRuntimeAtomicState({
        ...intended,
        configObjects: [null],
      } as never)
    ).toThrow("Agent Runtime config object must be an object");
    expect(() =>
      storageAdapterSupportV2.validateAgentRuntimeAtomicState({
        ...intended,
        domainEnvelopes: [null],
      } as never)
    ).toThrow("Agent Runtime Domain envelope record must be an object");

    for (const [candidate, message] of [
      [
        { ...durable, unexpected: true },
        "Agent Runtime atomic wire state has an invalid field set",
      ],
      [
        {
          ...durable,
          configObjects: [{ ...durable.configObjects[0]!, unexpected: true }],
        },
        "Agent Runtime config wire record has an invalid field set",
      ],
      [
        {
          ...durable,
          domainEnvelopes: [{
            ...durable.domainEnvelopes[0]!,
            unexpected: true,
          }],
        },
        "Agent Runtime Domain envelope wire record has an invalid field set",
      ],
    ] as const) {
      expect(() =>
        storageAdapterSupportV2.validateAgentRuntimeAtomicState(
          candidate as never,
        )
      ).toThrow(message);
    }
  });

  test("storage adapter accepts opaque records and preserves their canonical wire coordinates", () => {
    for (const revision of [0, 1]) {
      const exactBinding = binding(
        `ns-adapter-opaque-${String(revision)}`,
        revision,
        bytes(0x65 + revision),
      );
      expect(
        storageAdapterSupportV2.validateNamespaceBinding(exactBinding),
      ).toEqual(bindingWireRecord(exactBinding));
    }

    const payloadBytes = canonicalObjectPayload("object-adapter-opaque");
    const opaqueObject = {
      objectId: objectId("object-adapter-opaque"),
      payloadBytes: opaqueBytes("encrypted-payload", payloadBytes),
    };
    const validatedObject = storageAdapterSupportV2
      .validateEncryptedObject(opaqueObject);
    expect(validatedObject).toEqual({
      objectId: opaqueObject.objectId,
      payloadBytes,
    });
    expect(validatedObject.payloadBytes).not.toBe(payloadBytes);
    expect(() =>
      storageAdapterSupportV2.validateEncryptedObject({
        ...opaqueObject,
        objectId: objectId("object-adapter-other"),
      })
    ).toThrow("Encrypted object id does not match canonical payload bytes");
    expect(() =>
      storageAdapterSupportV2.validateEncryptedObject({
        ...opaqueObject,
        payloadBytes: opaqueBytes("grant", payloadBytes) as never,
      })
    ).toThrow(
      "Encrypted object payload must be opaque encrypted-payload ciphertext",
    );

    const grantBytes = canonicalGrantWire("grant-adapter-opaque");
    const opaqueGrant = {
      grantId: grantId("grant-adapter-opaque"),
      grantBytes: opaqueBytes("grant", grantBytes),
      consumed: true,
    };
    const validatedGrant = storageAdapterSupportV2.validateGrant(opaqueGrant);
    expect(validatedGrant).toEqual({
      grantId: opaqueGrant.grantId,
      grantBytes,
      consumed: true,
    });
    expect(validatedGrant.grantBytes).not.toBe(grantBytes);
    expect(() =>
      storageAdapterSupportV2.validateGrant({
        ...opaqueGrant,
        grantBytes: opaqueBytes("recovery-archive", grantBytes) as never,
      })
    ).toThrow("Grant must be opaque grant ciphertext");

    const archiveBytes = canonicalRecoveryArchiveWire(
      "human-adapter-opaque",
      5,
    );
    const opaqueArchive = {
      humanId: humanId("human-adapter-opaque"),
      recoveryKeyGeneration: 5,
      archiveBytes: opaqueBytes("recovery-archive", archiveBytes),
    };
    const validatedArchive = storageAdapterSupportV2
      .validateRecoveryArchive(opaqueArchive);
    expect(validatedArchive).toEqual({
      humanId: opaqueArchive.humanId,
      recoveryKeyGeneration: 5,
      archiveBytes,
    });
    expect(validatedArchive.archiveBytes).not.toBe(archiveBytes);
  });

  test("storage adapter detaches Runtime reservation and rotation expectations", () => {
    const intended = runtimeRotationFixture(
      "agent-adapter-expectations",
    ).intended;
    const reservation = {
      runtime: intended.runtime,
      challengeConsumptions: intended.challengeConsumptions,
    };
    const validatedReservation = storageAdapterSupportV2
      .validateAgentRuntimeChallengeReservationExpectation(reservation);
    expect(validatedReservation).toEqual(reservation);
    expect(validatedReservation).not.toBe(reservation);
    expect(validatedReservation.runtime).not.toBe(reservation.runtime);
    expect(validatedReservation.challengeConsumptions)
      .not.toBe(reservation.challengeConsumptions);
    expect(validatedReservation.challengeConsumptions[0]?.challengeHash)
      .not.toBe(reservation.challengeConsumptions[0]?.challengeHash);

    const rotation = runtimeExpectation(intended);
    const validatedRotation = storageAdapterSupportV2
      .validateAgentRuntimeRotationExpectation(rotation);
    expect(validatedRotation).toEqual(rotation);
    expect(validatedRotation).not.toBe(rotation);
    expect(validatedRotation.runtime).not.toBe(rotation.runtime);
    expect(validatedRotation.configInventory)
      .not.toBe(rotation.configInventory);
    expect(validatedRotation.configInventory.digest)
      .not.toBe(rotation.configInventory.digest);
    expect(validatedRotation.configObjects).not.toBe(rotation.configObjects);
    expect(validatedRotation.configObjects[0])
      .not.toBe(rotation.configObjects[0]);
    expect(validatedRotation.configObjects[0]?.wrappedDekHash)
      .not.toBe(rotation.configObjects[0]?.wrappedDekHash);
    expect(validatedRotation.challengeConsumptions)
      .not.toBe(rotation.challengeConsumptions);
    expect(validatedRotation.challengeConsumptions[0]?.challengeHash)
      .not.toBe(rotation.challengeConsumptions[0]?.challengeHash);
  });

  test("Runtime challenge reservations validate and compare every direct-store axis", async () => {
    const hash = (marker: number) => new Uint8Array(32).fill(marker);
    const initial = emptyRuntimeState("agent-reservations");
    const expectation = {
      runtime: initial.runtime,
      challengeConsumptions: [],
    };
    const addition = {
      challengeHash: hash(1),
      consumed: false,
    };
    const fresh = async () => {
      const store = new InMemoryV2Store();
      expect(await putAuthorizedRuntime(store, initial)).toBe(
        "inserted",
      );
      return store;
    };

    {
      const store = await fresh();
      expect(
        putAuthorizedChallengeReservation(store,
          "expectation" as never,
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation expectation must be an object",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            runtime: expectation.runtime,
            substitutedChallengeConsumptions: [],
          } as never,
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation expectation has an invalid field set",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            ...expectation,
            runtime: "runtime" as never,
          },
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation public state must be an object",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            ...expectation,
            runtime: {
              agentId: expectation.runtime.agentId,
              authorizationRevision:
                expectation.runtime.authorizationRevision,
              substitutedRuntimeGeneration:
                expectation.runtime.runtimeGeneration,
            } as never,
          },
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation public state has an invalid field set",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            ...expectation,
            challengeConsumptions: "challenges" as never,
          },
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Expected Agent Runtime challenge reservations must be an array",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            ...expectation,
            challengeConsumptions: Array.from(
              {
                length:
                  V2_LIMITS.agentGrantDomains + 1,
              },
              (_, index) => ({
                challengeHash: new Uint8Array(32).fill(index),
                consumed: false,
              }),
            ),
          },
          [addition],
        ),
      ).rejects.toThrow(
        `Expected Agent Runtime challenge reservation count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            ...expectation,
            challengeConsumptions: [{
              challengeHash: new Uint8Array(32),
              consumed: false,
              unexpected: true,
            }] as never,
          },
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation has an invalid field set",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            ...expectation,
            challengeConsumptions: [{
              challengeHash: new Uint8Array(31),
              consumed: false,
            }],
          },
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation hash must be exactly 32 bytes",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          {
            ...expectation,
            challengeConsumptions: [{
              challengeHash: new Uint8Array(32),
              consumed: "no",
            }] as never,
          },
          [addition],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation consumed state must be boolean",
        ),
      );
      for (const challengeConsumptions of [
        [
          { challengeHash: hash(1), consumed: false },
          { challengeHash: hash(1), consumed: false },
        ],
        [
          { challengeHash: hash(2), consumed: false },
          { challengeHash: hash(1), consumed: false },
        ],
      ]) {
        expect(
          putAuthorizedChallengeReservation(store,
            { ...expectation, challengeConsumptions },
            [addition],
          ),
        ).rejects.toEqual(
          new Error(
            "Agent Runtime challenge reservations must be sorted and unique",
          ),
        );
      }
      expect(
        putAuthorizedChallengeReservation(store,
          expectation,
          null as unknown as [],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation additions must be an array",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          expectation,
          Array.from(
            { length: V2_LIMITS.agentGrantDomains + 1 },
            () => addition,
          ),
        ),
      ).rejects.toThrow(
        `Agent Runtime challenge reservation addition count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
      );
      expect(
        putAuthorizedChallengeReservation(store,
          expectation,
          [{ ...addition, extra: true }] as never,
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation addition has an invalid field set",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          expectation,
          [{ challengeHash: new Uint8Array(31), consumed: false }],
        ),
      ).rejects.toEqual(
        new TypeError(
          "Agent Runtime challenge reservation addition hash must be exactly 32 bytes",
        ),
      );
      expect(
        putAuthorizedChallengeReservation(store,
          expectation,
          [{ ...addition, consumed: true }],
        ),
      ).rejects.toThrow("must be unconsumed");
      expect(
        putAuthorizedChallengeReservation(store,
          expectation,
          [addition, { ...addition, challengeHash: hash(1) }],
        ),
      ).rejects.toThrow("sorted and unique");
      expect(
        putAuthorizedChallengeReservation(store,
          expectation,
          [
            { ...addition, challengeHash: hash(2) },
            addition,
          ],
        ),
      ).rejects.toThrow("sorted and unique");
    }

    expect(
      await putAuthorizedChallengeReservation(
        new InMemoryV2Store(),
        expectation,
        [addition],
      ),
    ).toBe("stale");
    for (const runtime of [
      {
        ...expectation.runtime,
        authorizationRevision: authorizationRevision(1),
      },
      {
        ...expectation.runtime,
        runtimeGeneration: agentRuntimeGeneration(1),
      },
    ]) {
      const store = await fresh();
      expect(
        await putAuthorizedChallengeReservation(store,
          { ...expectation, runtime },
          [addition],
        ),
      ).toBe("stale");
    }

    const store = await fresh();
    expect(
      await putAuthorizedChallengeReservation(store,
        expectation,
        [],
      ),
    ).toBe("applied");
    expect(
      await putAuthorizedChallengeReservation(store,
        expectation,
        [
          { ...addition, challengeHash: hash(2) },
          { ...addition, challengeHash: hash(3) },
        ],
      ),
    ).toBe("applied");
    const reserved = await store.getAgentRuntimeAtomicState(
      "agent-reservations",
    );
    expect(reserved?.challengeConsumptions).toEqual([
      { challengeHash: hash(2), consumed: false },
      { challengeHash: hash(3), consumed: false },
    ]);
    expect(
      await putAuthorizedChallengeReservation(store,
        {
          runtime: expectation.runtime,
          challengeConsumptions: reserved!.challengeConsumptions,
        },
        [{ ...addition, challengeHash: hash(2) }],
      ),
    ).toBe("duplicate");

    for (const expectedChallenges of [
      [],
      [{ challengeHash: hash(9), consumed: false }],
      [
        { challengeHash: hash(2), consumed: false },
        { challengeHash: hash(9), consumed: false },
      ],
      [
        { challengeHash: hash(2), consumed: true },
        { challengeHash: hash(3), consumed: false },
      ],
    ]) {
      expect(
        await putAuthorizedChallengeReservation(store,
          {
            runtime: expectation.runtime,
            challengeConsumptions: expectedChallenges,
          },
          [{ ...addition, challengeHash: hash(4) }],
        ),
      ).toBe("stale");
    }
    expect(
      await putAuthorizedChallengeReservation(store,
        {
          runtime: expectation.runtime,
          challengeConsumptions: reserved!.challengeConsumptions,
        },
        [{ ...addition, challengeHash: hash(3) }],
      ),
    ).toBe("duplicate");
    expect(
      await putAuthorizedChallengeReservation(store,
        {
          runtime: expectation.runtime,
          challengeConsumptions: reserved!.challengeConsumptions,
        },
        [
          { ...addition, challengeHash: hash(3) },
          { ...addition, challengeHash: hash(4) },
        ],
      ),
    ).toBe("stale");

    const applyThird = await putAuthorizedChallengeReservation(store,
      {
        runtime: expectation.runtime,
        challengeConsumptions: reserved!.challengeConsumptions,
      },
      [{ ...addition, challengeHash: hash(4) }],
    );
    expect(applyThird).toBe("applied");
    expect(
      (await store.getAgentRuntimeAtomicState("agent-reservations"))
        ?.challengeConsumptions,
    ).toEqual([
      { challengeHash: hash(2), consumed: false },
      { challengeHash: hash(3), consumed: false },
      { challengeHash: hash(4), consumed: false },
    ]);

    {
      const consumedState = {
        ...emptyRuntimeState("agent-consumed"),
        challengeConsumptions: [
          { challengeHash: hash(1), consumed: true },
          { challengeHash: hash(3), consumed: false },
        ],
      };
      const consumedStore = new InMemoryV2Store();
      await putAuthorizedRuntime(consumedStore, consumedState);
      expect(
        await putAuthorizedChallengeReservation(consumedStore,
          {
            runtime: consumedState.runtime,
            challengeConsumptions: consumedState.challengeConsumptions,
          },
          [{ ...addition, challengeHash: hash(2) }],
        ),
      ).toBe("applied");
      expect(
        (await consumedStore.getAgentRuntimeAtomicState("agent-consumed"))
          ?.challengeConsumptions,
      ).toEqual([
        { challengeHash: hash(2), consumed: false },
        { challengeHash: hash(3), consumed: false },
      ]);
    }

    {
      const fullChallenges = Array.from(
        { length: V2_LIMITS.agentGrantDomains },
        (_, index) => {
          const challengeHash = new Uint8Array(32);
          new DataView(challengeHash.buffer).setUint32(28, index);
          return { challengeHash, consumed: false };
        },
      );
      const fullState = {
        ...emptyRuntimeState("agent-full"),
        challengeConsumptions: fullChallenges,
      };
      const fullStore = new InMemoryV2Store();
      await putAuthorizedRuntime(fullStore, fullState);
      const overflowHash = new Uint8Array(32);
      new DataView(overflowHash.buffer).setUint32(
        28,
        V2_LIMITS.agentGrantDomains,
      );
      expect(
        putAuthorizedChallengeReservation(fullStore,
          {
            runtime: fullState.runtime,
            challengeConsumptions: fullChallenges,
          },
          [{ challengeHash: overflowHash, consumed: false }],
        ),
      ).rejects.toThrow(
        `Agent Runtime pending challenge reservation count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
      );
    }
  });
});
