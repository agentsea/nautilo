import type {
  ProtectedMemoryPreparedCreateRequestV1,
  ProtectedMemoryPreparedUpdateRequestV1,
} from "@nautilo/api-client";
import type {
  HumanMemoryContentEmbeddingRequest,
  LatticeCrypto,
  ObjectAccessGenesisEnvelopeAuthorizationContext,
} from "@nautilo/lattice-crypto";
import {
  LATTICE_LIMITS,
  objectId,
  unixTimestamp,
  verifyHumanMemoryContentEmbeddingRequest,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanMemoryContentEmbeddingRequestV2,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  objectAccessManifestSigningBytesV5,
} from "@nautilo/lattice-crypto/wire";

import type {
  MemoryForegroundEmbeddingRequest,
} from "../../memory/foreground-embedding-processor.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  type PreparedMemoryCryptoRevision,
} from "../../memory/memory-repository.ts";
import {
  humanMemoryPreparedAuthorizationError,
  humanMemoryPreparedIntegrityError,
} from "./human-memory-prepared-route-error.ts";

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HumanMemoryPreparedAuthorityContext {
  readonly purpose:
    | "authenticate-human-memory-prepared-create"
    | "authenticate-human-memory-prepared-update";
  readonly expectedHumanId: string;
  readonly operationId: string;
  readonly memoryId: string;
  readonly expectedContentRevision: number;
  readonly nextContentRevision: number;
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopes: readonly ObjectAccessGenesisEnvelopeAuthorizationContext[];
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
}

export interface HistoricalHumanMemoryDeviceAuthority
  extends HumanMemoryPreparedAuthorityContext {
  readonly committerSigningPublicKey: Uint8Array;
}

/**
 * A non-null result proves that the expected Human owned the exact device and
 * signing key at the signed host-authorization revision. Every returned field
 * is compared with the complete, signed Namespace-envelope context.
 */
export type ResolveHistoricalHumanMemoryDeviceAuthority = (
  context: HumanMemoryPreparedAuthorityContext,
) => Promise<HistoricalHumanMemoryDeviceAuthority | null>;

export interface PreparedHumanMemoryUpdate extends PreparedMemoryCryptoRevision {
  readonly expectedHumanId: string;
  readonly operationId: string;
  readonly expectedContentRevision: number;
  readonly nextContentRevision: number;
}

export type PreparedHumanMemoryCreate = PreparedHumanMemoryUpdate;

declare const reservedReplayAdmissionBrand: unique symbol;
export type HumanMemoryReservedReplayAdmission = Readonly<{
  [reservedReplayAdmissionBrand]: true;
}>;
const reservedReplayAdmissions = new WeakMap<object, Readonly<{
  operationId: string;
  memoryId: string;
  operationRequestDigest: Uint8Array;
}>>();

/** Internal mint used only after exact durable active/completed receipt proof. */
export function createHumanMemoryReservedReplayAdmission(input: Readonly<{
  operationId: string;
  memoryId: string;
  operationRequestDigest: Uint8Array;
}>): HumanMemoryReservedReplayAdmission {
  if (input.operationRequestDigest.length !== 32) {
    throw new TypeError("Human Memory replay admission digest is invalid");
  }
  const token = Object.freeze({}) as HumanMemoryReservedReplayAdmission;
  reservedReplayAdmissions.set(token, Object.freeze({
    ...input,
    operationRequestDigest: input.operationRequestDigest.slice(),
  }));
  return token;
}

export function digestPreparedHumanMemorySignedRequest(
  crypto: LatticeCrypto,
  prepared: ProtectedMemoryPreparedCreateRequestV1 | ProtectedMemoryPreparedUpdateRequestV1,
): Uint8Array {
  const bytes = decodeBase64url("Signed content-embedding request",
    prepared.signedContentEmbeddingRequestBytesBase64url, 160 * 1024);
  try {
    decodeIntegrity("Signed Human Memory request", () =>
      decodeHumanMemoryContentEmbeddingRequestV2(bytes));
    return crypto.hash(bytes);
  } finally {
    bytes.fill(0);
  }
}

export interface HumanMemoryPreparedUpdateSnapshot {
  readonly authority: HumanMemoryPreparedAuthorityContext;
  readonly payloadBytes: Uint8Array;
  readonly payloadHash: Uint8Array;
  readonly genesisManifestBytes: Uint8Array;
  readonly genesisManifestHash: Uint8Array;
  readonly envelopes: readonly Readonly<{
    namespaceId: string;
    keyGeneration: number;
    bindingRevisionAtWrap: number;
    envelopeBytes: Uint8Array;
    envelopeHash: Uint8Array;
  }>[];
  /** Hash of the complete canonical signed request, including its signature. */
  readonly operationRequestDigest: Uint8Array;
  readonly productAllocation: HumanMemoryProductAllocationCertificate | null;
}

export interface HumanMemoryProductAllocationCertificate {
  readonly operationId: string;
  readonly memoryId: string;
  readonly expectedContentRevision: number;
  readonly nextContentRevision: number;
  readonly objectId: string;
  readonly anchorNamespaceId: string;
  readonly requiredNamespaceFingerprint: Uint8Array;
  readonly expectedAccessRevision: number;
  readonly operationRequestDigest: Uint8Array;
  readonly allocationRequestDigest: Uint8Array;
}

export interface AuthenticatedHumanMemoryPreparedUpdate {
  readonly prepared: PreparedHumanMemoryUpdate;
  /** Original signed times remain immutable for create-plan binding. */
  readonly signedRequestValidity: Readonly<{ issuedAt: number; deadlineAt: number }>;
  /** Exact authored payload authenticated by the Human's signed request. */
  readonly authored: Readonly<{
    formatVersion: 1;
    type: string;
    content: string;
    importance?: number;
  }>;
  /** Transient, verified plaintext disclosure for the foreground processor. */
  readonly embeddingRequest: MemoryForegroundEmbeddingRequest;
  /** Hash of the complete canonical signed request, including its signature. */
  readonly operationRequestDigest: Uint8Array;
  /** Public key already verified against exact historical device authority. */
  readonly committerSigningPublicKey: Uint8Array;
}

export type AuthenticatedHumanMemoryPreparedCreate =
  AuthenticatedHumanMemoryPreparedUpdate;

const snapshots = new WeakMap<object, HumanMemoryPreparedUpdateSnapshot>();

function copyProductAllocation(
  value: HumanMemoryProductAllocationCertificate,
): HumanMemoryProductAllocationCertificate {
  return Object.freeze({
    ...value,
    requiredNamespaceFingerprint: value.requiredNamespaceFingerprint.slice(),
    operationRequestDigest: value.operationRequestDigest.slice(),
    allocationRequestDigest: value.allocationRequestDigest.slice(),
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function copyContext(
  context: HumanMemoryPreparedAuthorityContext,
): HumanMemoryPreparedAuthorityContext {
  return Object.freeze({
    ...context,
    payloadHash: context.payloadHash.slice(),
    envelopes: Object.freeze(context.envelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeHash: entry.envelopeHash.slice(),
    }))),
  });
}

function authorityMatches(
  resolved: HistoricalHumanMemoryDeviceAuthority,
  expected: HumanMemoryPreparedAuthorityContext,
): boolean {
  return resolved.purpose === expected.purpose
    && resolved.expectedHumanId === expected.expectedHumanId
    && resolved.operationId === expected.operationId
    && resolved.memoryId === expected.memoryId
    && resolved.expectedContentRevision === expected.expectedContentRevision
    && resolved.nextContentRevision === expected.nextContentRevision
    && resolved.objectId === expected.objectId
    && bytesEqual(resolved.payloadHash, expected.payloadHash)
    && resolved.committerDeviceId === expected.committerDeviceId
    && resolved.hostAuthorizationRevision
      === expected.hostAuthorizationRevision
    && resolved.envelopes.length === expected.envelopes.length
    && resolved.envelopes.every((entry, index) => {
      const intended = expected.envelopes[index]!;
      return entry.namespaceId === intended.namespaceId
        && entry.keyGeneration === intended.keyGeneration
        && entry.bindingRevisionAtWrap === intended.bindingRevisionAtWrap
        && bytesEqual(entry.envelopeHash, intended.envelopeHash);
    })
    && resolved.committerSigningPublicKey instanceof Uint8Array
    && resolved.committerSigningPublicKey.length
      === LATTICE_LIMITS.signingPublicKeyBytes;
}

function decodeBase64url(
  label: string,
  encoded: string,
  maximumBytes: number,
): Uint8Array {
  if (
    typeof encoded !== "string"
    || encoded.length === 0
    || encoded.length > Math.ceil(maximumBytes * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) throw humanMemoryPreparedIntegrityError(
    `${label} is not bounded canonical base64url`,
  );
  const bytes = new Uint8Array(Buffer.from(encoded, "base64url"));
  if (
    bytes.length > maximumBytes
    || Buffer.from(bytes).toString("base64url") !== encoded
  ) throw humanMemoryPreparedIntegrityError(`${label} is not canonical base64url`);
  return bytes;
}

function assertPortable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || !PORTABLE_ID.test(value)
    || new TextEncoder().encode(value).length > LATTICE_LIMITS.idBytes
  ) throw humanMemoryPreparedIntegrityError(
    `${label} must be a bounded portable identifier`,
  );
}

function assertRevision(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw humanMemoryPreparedIntegrityError(`${label} must be a positive revision`);
  }
}

function decodeIntegrity<Value>(label: string, decode: () => Value): Value {
  try {
    return decode();
  } catch (error) {
    throw humanMemoryPreparedIntegrityError(`${label} is invalid`, error);
  }
}

function requestMatchesOuterPreparedUpdate(input: Readonly<{
  request: HumanMemoryContentEmbeddingRequest;
  expectedHumanId: string;
  memoryId: string;
  prepared:
    | ProtectedMemoryPreparedCreateRequestV1
    | ProtectedMemoryPreparedUpdateRequestV1;
  expectedObjectId: string;
  payloadHash: Uint8Array;
  genesisManifestHash: Uint8Array;
  envelopes: readonly Readonly<{
    namespaceId: string;
    envelopeHash: Uint8Array;
  }>[];
}>): boolean {
  const { request } = input;
  return request.subjectHumanId === input.expectedHumanId
    && request.requestId === input.prepared.operationId
    && request.memoryId === input.memoryId
    && request.expectedProductRevision
      === input.prepared.expectedContentRevision
    && request.nextProductRevision === input.prepared.nextContentRevision
    && request.cryptoObjectId === input.expectedObjectId
    && bytesEqual(request.ciphertextPayloadHash, input.payloadHash)
    && bytesEqual(request.genesisManifestHash, input.genesisManifestHash)
    && request.namespaceEnvelopes.length === input.envelopes.length
    && request.namespaceEnvelopes.every((entry, index) => {
      const expected = input.envelopes[index]!;
      return entry.namespaceId === expected.namespaceId
        && bytesEqual(entry.envelopeHash, expected.envelopeHash);
    });
}

function wipeByteArrays(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) wipeByteArrays(child, seen);
}

/**
 * Authenticate client-created Human Memory bytes, then seal them behind an
 * opaque process-local handle. This code never receives plaintext or a private
 * signing key and deliberately does not decrypt the payload.
 */
async function authenticatePreparedHumanMemory(input: Readonly<{
  crypto: LatticeCrypto;
  expectedHumanId: string;
  memoryId: string;
  prepared:
    | ProtectedMemoryPreparedCreateRequestV1
    | ProtectedMemoryPreparedUpdateRequestV1;
  operation: "create" | "update";
  now: number;
  resolveHistoricalDeviceAuthority:
    ResolveHistoricalHumanMemoryDeviceAuthority;
  reservedReplayAdmission?: HumanMemoryReservedReplayAdmission;
}>): Promise<AuthenticatedHumanMemoryPreparedUpdate> {
  assertPortable("Expected Human ID", input.expectedHumanId);
  assertPortable("Operation ID", input.prepared.operationId);
  if (input.operation === "create") {
    if (input.prepared.expectedContentRevision !== 0) {
      throw humanMemoryPreparedIntegrityError(
        "Prepared Human Memory create must start at revision zero",
      );
    }
  } else {
    assertRevision(
      "Expected content revision",
      input.prepared.expectedContentRevision,
    );
  }
  assertRevision("Next content revision", input.prepared.nextContentRevision);
  if (
    input.prepared.requestVersion !== 1
    || input.prepared.payloadVersion !== MEMORY_PAYLOAD_VERSION
    || input.prepared.nextContentRevision
      !== input.prepared.expectedContentRevision + 1
    || (input.operation === "create"
      ? input.prepared.expectedContentRevision !== 0
      : input.prepared.expectedContentRevision === 0)
  ) throw humanMemoryPreparedIntegrityError(
    "Prepared Human Memory revision coordinates are invalid",
  );
  const expectedObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: input.memoryId,
    contentRevision: input.prepared.nextContentRevision,
  });
  if (
    objectId(input.prepared.cryptoObjectId) !== expectedObjectId
    || input.prepared.requiredNamespaceIds.length < 1
    || input.prepared.requiredNamespaceIds.length
      > LATTICE_LIMITS.namespaceEnvelopesPerManifest
    || input.prepared.namespaceEnvelopes.length
      !== input.prepared.requiredNamespaceIds.length
  ) throw humanMemoryPreparedIntegrityError(
    "Prepared Human Memory exact Namespace set is invalid",
  );
  const requiredNamespaceIds = [...input.prepared.requiredNamespaceIds];
  const sortedNamespaceIds = [...requiredNamespaceIds].sort();
  if (
    requiredNamespaceIds.some((value) => !UUID.test(value))
    ||
    !exactStrings(requiredNamespaceIds, sortedNamespaceIds)
    || new Set(requiredNamespaceIds).size !== requiredNamespaceIds.length
  ) throw humanMemoryPreparedIntegrityError(
    "Prepared Human Memory Namespace IDs must be unique and sorted",
  );
  let payloadBytes: Uint8Array | undefined;
  let genesisManifestBytes: Uint8Array | undefined;
  let signedRequestBytes: Uint8Array | undefined;
  let payload: ReturnType<typeof decodeEncryptedPayloadV2> | undefined;
  let genesis: ReturnType<typeof decodeObjectAccessManifestV5> | undefined;
  let decodedSignedRequest:
    | ReturnType<typeof decodeHumanMemoryContentEmbeddingRequestV2>
    | undefined;
  let verifiedSignedRequest: HumanMemoryContentEmbeddingRequest | undefined;
  let payloadHash: Uint8Array | undefined;
  let genesisManifestHash: Uint8Array | undefined;
  let operationRequestDigest: Uint8Array | undefined;
  let resolverPublicKey: Uint8Array | undefined;
  const envelopes: Array<Readonly<{
    namespaceId: string;
    keyGeneration: number;
    bindingRevisionAtWrap: number;
    envelopeBytes: Uint8Array;
    envelopeHash: Uint8Array;
  }>> = [];
  const signingBytes: Uint8Array[] = [];
  try {
    payloadBytes = decodeBase64url(
      "Encrypted payload",
      input.prepared.encryptedPayloadBytesBase64url,
      LATTICE_LIMITS.ciphertextBytes + 512,
    );
    genesisManifestBytes = decodeBase64url(
      "Access manifest",
      input.prepared.accessManifestBytesBase64url,
      LATTICE_LIMITS.manifestEnvelopeBytes,
    );
    signedRequestBytes = decodeBase64url(
      "Signed content-embedding request",
      input.prepared.signedContentEmbeddingRequestBytesBase64url,
      160 * 1024,
    );
    payload = decodeIntegrity("Prepared Human Memory encrypted payload", () =>
      decodeEncryptedPayloadV2(payloadBytes!));
    genesis = decodeIntegrity("Prepared Human Memory access manifest", () =>
      decodeObjectAccessManifestV5(genesisManifestBytes!));
    decodedSignedRequest = decodeIntegrity("Signed Human Memory request", () =>
      decodeHumanMemoryContentEmbeddingRequestV2(signedRequestBytes!));
    payloadHash = input.crypto.hash(payloadBytes);
    genesisManifestHash = input.crypto.hash(genesisManifestBytes);
    for (const entry of [...input.prepared.namespaceEnvelopes]
      .sort((left, right) => left.namespaceId < right.namespaceId ? -1 : 1)) {
      let envelopeBytes: Uint8Array | undefined;
      let envelopeHash: Uint8Array | undefined;
      let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>
        | undefined;
      let retained = false;
      try {
        envelopeBytes = decodeBase64url(
          "Namespace envelope",
          entry.envelopeBytesBase64url,
          LATTICE_LIMITS.wrappedDekBytes + 512,
        );
        envelope = decodeIntegrity("Prepared Human Memory Namespace envelope", () =>
          decodeNamespaceObjectEnvelopeV2(envelopeBytes!));
        if (
          entry.namespaceId !== envelope.context.namespaceId
          || envelope.context.objectId !== expectedObjectId
          || envelope.context.keyClass !== "ai"
        ) throw humanMemoryPreparedIntegrityError(
          "Prepared Human Memory Namespace envelope disagrees",
        );
        envelopeHash = input.crypto.hash(envelopeBytes);
        envelopes.push(Object.freeze({
          namespaceId: envelope.context.namespaceId,
          keyGeneration: envelope.context.keyGeneration,
          bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
          envelopeBytes,
          envelopeHash,
        }));
        retained = true;
      } finally {
        wipeByteArrays(envelope);
        if (!retained) {
          envelopeBytes?.fill(0);
          envelopeHash?.fill(0);
        }
      }
    }
    const envelopeNamespaceIds = envelopes.map((entry) => entry.namespaceId);
    const canonicalEnvelopeHashes = envelopes.map((entry) => entry.envelopeHash)
      .sort((left, right) => Buffer.compare(left, right));
    if (
      !exactStrings(envelopeNamespaceIds, requiredNamespaceIds)
      || payload.context.objectId !== expectedObjectId
      || payload.context.objectType !== MEMORY_OBJECT_TYPE
      || payload.context.keyClass !== "ai"
      || genesis.objectId !== expectedObjectId
      || genesis.accessRevision !== 0
      || genesis.previousManifestHash !== null
      || !bytesEqual(genesis.payloadHash, payloadHash)
      || genesis.envelopeHashes.length !== canonicalEnvelopeHashes.length
      || genesis.envelopeHashes.some((hash, index) =>
        !bytesEqual(hash, canonicalEnvelopeHashes[index]!)
      )
    ) throw humanMemoryPreparedIntegrityError(
      "Prepared Human Memory crypto coordinates disagree",
    );

    const authority = copyContext(Object.freeze({
      purpose: input.operation === "create"
        ? "authenticate-human-memory-prepared-create"
        : "authenticate-human-memory-prepared-update",
      expectedHumanId: input.expectedHumanId,
      operationId: input.prepared.operationId,
      memoryId: input.memoryId,
      expectedContentRevision: input.prepared.expectedContentRevision,
      nextContentRevision: input.prepared.nextContentRevision,
      objectId: expectedObjectId,
      payloadHash,
      envelopes: Object.freeze(envelopes.map((entry) => Object.freeze({
        objectId: expectedObjectId,
        namespaceId: entry.namespaceId,
        keyClass: "ai" as const,
        keyGeneration: entry.keyGeneration,
        bindingRevisionAtWrap: entry.bindingRevisionAtWrap,
        envelopeHash: entry.envelopeHash,
      }))),
      committerDeviceId: decodedSignedRequest.committerDeviceId,
      hostAuthorizationRevision:
        decodedSignedRequest.hostAuthorizationRevision,
    }));
    const resolved = await input.resolveHistoricalDeviceAuthority(authority);
    if (resolved === null) {
      throw humanMemoryPreparedAuthorizationError(
        "Prepared Human Memory historical device authority is unavailable",
      );
    }
    if (!authorityMatches(resolved, authority)) {
      if (resolved.committerSigningPublicKey instanceof Uint8Array) {
        resolved.committerSigningPublicKey.fill(0);
      }
      throw humanMemoryPreparedAuthorizationError(
        "Prepared Human Memory historical device authority is unavailable",
      );
    }
    resolverPublicKey = resolved.committerSigningPublicKey.slice();
    resolved.committerSigningPublicKey.fill(0);
    if (
      genesis.signer.kind !== "human_device"
      || genesis.signer.subjectHumanId !== input.expectedHumanId
      || genesis.signer.committerDeviceId !== decodedSignedRequest.committerDeviceId
      || genesis.hostAuthorizationRevision
        !== decodedSignedRequest.hostAuthorizationRevision
      || !requestMatchesOuterPreparedUpdate({
        request: decodedSignedRequest,
        expectedHumanId: input.expectedHumanId,
        memoryId: input.memoryId,
        prepared: input.prepared,
        expectedObjectId,
        payloadHash,
        genesisManifestHash,
        envelopes,
      })
    ) throw humanMemoryPreparedIntegrityError(
      "Signed Human Memory request coordinates disagree",
    );
    const replay = input.reservedReplayAdmission === undefined ? undefined
      : reservedReplayAdmissions.get(input.reservedReplayAdmission);
    if (input.reservedReplayAdmission !== undefined && (replay === undefined
      || replay.operationId !== input.prepared.operationId
      || replay.memoryId !== input.memoryId
      || !bytesEqual(replay.operationRequestDigest, input.crypto.hash(signedRequestBytes)))) {
      throw humanMemoryPreparedIntegrityError(
        "Human Memory reserved replay admission disagrees",
      );
    }
    try {
      verifiedSignedRequest = verifyHumanMemoryContentEmbeddingRequest(input.crypto, {
        requestBytes: signedRequestBytes,
        committerSigningPublicKey: resolverPublicKey,
        // A durable exact reservation proves these signed bytes were admitted
        // while new. This checks signature validity at their signed issuedAt;
        // it does not assert an acceptedAt or extend a fresh request deadline.
        now: unixTimestamp(replay === undefined
          ? input.now : decodedSignedRequest.issuedAt),
      });
    } catch (error) {
      if (replay === undefined && (
        input.now < decodedSignedRequest.issuedAt
        || input.now > decodedSignedRequest.deadlineAt
      )) {
        throw humanMemoryPreparedAuthorizationError(
          "Signed Human Memory request is not currently valid",
        );
      }
      throw humanMemoryPreparedIntegrityError(
        "Signed Human Memory request is invalid",
        error,
      );
    }
    const genesisSigningBytes = objectAccessManifestSigningBytesV5({
      objectId: genesis.objectId,
      payloadHash: genesis.payloadHash,
      accessRevision: genesis.accessRevision,
      previousManifestHash: genesis.previousManifestHash,
      envelopeHashes: genesis.envelopeHashes,
      signer: genesis.signer,
      signerAuthorizationHash: genesis.signerAuthorizationHash,
      hostAuthorizationRevision: genesis.hostAuthorizationRevision,
    });
    signingBytes.push(genesisSigningBytes);
    if (
      !input.crypto.verify(
        resolverPublicKey,
        genesisSigningBytes,
        genesis.signature,
      )
    ) throw humanMemoryPreparedIntegrityError(
      "Prepared Human Memory manifest signature is invalid",
    );

    const update = Object.freeze({
      expectedHumanId: input.expectedHumanId,
      operationId: input.prepared.operationId,
      memoryId: input.memoryId,
      contentRevision: input.prepared.nextContentRevision,
      expectedContentRevision: input.prepared.expectedContentRevision,
      nextContentRevision: input.prepared.nextContentRevision,
      objectId: expectedObjectId,
      objectType: MEMORY_OBJECT_TYPE,
      payloadVersion: MEMORY_PAYLOAD_VERSION,
      requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
    });
    operationRequestDigest = input.crypto.hash(signedRequestBytes);
    snapshots.set(update, Object.freeze({
      authority,
      payloadBytes: payloadBytes.slice(),
      payloadHash: payloadHash.slice(),
      genesisManifestBytes: genesisManifestBytes.slice(),
      genesisManifestHash: genesisManifestHash.slice(),
      envelopes: Object.freeze(envelopes.map((entry) => Object.freeze({
        ...entry,
        envelopeBytes: entry.envelopeBytes.slice(),
        envelopeHash: entry.envelopeHash.slice(),
      }))),
      operationRequestDigest: operationRequestDigest.slice(),
      productAllocation: null,
    }));
    if (typeof verifiedSignedRequest.type !== "string") {
      throw humanMemoryPreparedIntegrityError(
        "Signed Human Memory authored type is missing",
      );
    }
    const importance = verifiedSignedRequest.importance;
    if (importance !== undefined
      && (typeof importance !== "number" || !Number.isFinite(importance))) {
      throw humanMemoryPreparedIntegrityError(
        "Signed Human Memory importance is invalid",
      );
    }
    return Object.freeze({
      prepared: update,
      committerSigningPublicKey: resolverPublicKey.slice(),
      authored: Object.freeze({
        formatVersion: 1 as const,
        type: verifiedSignedRequest.type,
        content: verifiedSignedRequest.content,
        ...(importance === undefined ? {} : { importance }),
      }),
      operationRequestDigest: operationRequestDigest.slice(),
      signedRequestValidity: Object.freeze({
        issuedAt: verifiedSignedRequest.issuedAt,
        deadlineAt: verifiedSignedRequest.deadlineAt,
      }),
      embeddingRequest: Object.freeze({
        contractVersion: verifiedSignedRequest.processorContractVersion,
        purpose: verifiedSignedRequest.purpose,
        subjectId: verifiedSignedRequest.subjectHumanId,
        requestId: verifiedSignedRequest.requestId,
        plaintext: verifiedSignedRequest.content,
        provider: verifiedSignedRequest.requestedProvider,
        model: verifiedSignedRequest.requestedModel,
        dimensions: verifiedSignedRequest.dimensions,
        // An exact durable reservation admits a new, transient processor
        // attempt. It does not renew or rewrite the original signed request.
        // Route composition rechecks current device authority before disclosure.
        issuedAt: replay === undefined ? verifiedSignedRequest.issuedAt : input.now,
        deadlineAt: replay === undefined ? verifiedSignedRequest.deadlineAt
          : input.now + (verifiedSignedRequest.deadlineAt - verifiedSignedRequest.issuedAt),
        publication: Object.freeze({
          objectId: verifiedSignedRequest.cryptoObjectId,
          expectedProductRevision:
            verifiedSignedRequest.expectedProductRevision,
          idempotencyId: verifiedSignedRequest.requestId,
        }),
      }),
    });
  } finally {
    payloadBytes?.fill(0);
    genesisManifestBytes?.fill(0);
    signedRequestBytes?.fill(0);
    payloadHash?.fill(0);
    genesisManifestHash?.fill(0);
    operationRequestDigest?.fill(0);
    resolverPublicKey?.fill(0);
    envelopes.forEach((entry) => {
      entry.envelopeBytes.fill(0);
      entry.envelopeHash.fill(0);
    });
    signingBytes.forEach((bytes) => bytes.fill(0));
    wipeByteArrays(payload);
    wipeByteArrays(genesis);
    wipeByteArrays(decodedSignedRequest);
    wipeByteArrays(verifiedSignedRequest);
  }
}

export function authenticatePreparedHumanMemoryUpdate(input: Readonly<{
  crypto: LatticeCrypto;
  expectedHumanId: string;
  memoryId: string;
  prepared: ProtectedMemoryPreparedUpdateRequestV1;
  now: number;
  resolveHistoricalDeviceAuthority:
    ResolveHistoricalHumanMemoryDeviceAuthority;
  reservedReplayAdmission?: HumanMemoryReservedReplayAdmission;
}>): Promise<AuthenticatedHumanMemoryPreparedUpdate> {
  return authenticatePreparedHumanMemory({ ...input, operation: "update" });
}

export function authenticatePreparedHumanMemoryCreate(input: Readonly<{
  crypto: LatticeCrypto;
  expectedHumanId: string;
  prepared: ProtectedMemoryPreparedCreateRequestV1;
  now: number;
  resolveHistoricalDeviceAuthority:
    ResolveHistoricalHumanMemoryDeviceAuthority;
  reservedReplayAdmission?: HumanMemoryReservedReplayAdmission;
}>): Promise<AuthenticatedHumanMemoryPreparedCreate> {
  return authenticatePreparedHumanMemory({
    ...input,
    memoryId: input.prepared.memoryId,
    operation: "create",
  });
}

/**
 * Bind the independently durable ordinary-role allocation to a new opaque
 * handle. The crypto completion adapter rejects the pre-allocation handle.
 */
export function bindPreparedHumanMemoryProductAllocation(
  update: PreparedHumanMemoryUpdate,
  allocation: HumanMemoryProductAllocationCertificate,
): PreparedHumanMemoryUpdate {
  const snapshot = snapshots.get(update);
  if (snapshot === undefined || snapshot.productAllocation !== null) {
    throw humanMemoryPreparedIntegrityError(
      "Human Memory product allocation binding is invalid",
    );
  }
  const expectedFingerprint = fingerprintRequiredMemoryNamespaces(
    update.requiredNamespaceIds,
  );
  if (
    allocation.operationId !== update.operationId
    || allocation.memoryId !== update.memoryId
    || allocation.expectedContentRevision !== update.expectedContentRevision
    || allocation.nextContentRevision !== update.nextContentRevision
    || allocation.objectId !== update.objectId
    || allocation.anchorNamespaceId !== update.requiredNamespaceIds[0]
    || allocation.expectedAccessRevision < 0
    || !Number.isSafeInteger(allocation.expectedAccessRevision)
    || allocation.operationRequestDigest.length !== 32
    || allocation.allocationRequestDigest.length !== 32
    || !bytesEqual(
      allocation.operationRequestDigest,
      snapshot.operationRequestDigest,
    )
    || !bytesEqual(
      allocation.requiredNamespaceFingerprint,
      expectedFingerprint,
    )
  ) throw humanMemoryPreparedIntegrityError(
    "Human Memory product allocation disagrees",
  );
  const bound = Object.freeze({ ...update });
  snapshots.set(bound, Object.freeze({
    ...snapshot,
    productAllocation: copyProductAllocation(allocation),
  }));
  expectedFingerprint.fill(0);
  return bound;
}

export function readPreparedHumanMemoryUpdateSnapshot(
  update: object,
): HumanMemoryPreparedUpdateSnapshot {
  const snapshot = snapshots.get(update);
  if (snapshot === undefined) {
    throw new TypeError("Human Memory update was not authenticated by the bridge");
  }
  return Object.freeze({
    authority: copyContext(snapshot.authority),
    payloadBytes: snapshot.payloadBytes.slice(),
    payloadHash: snapshot.payloadHash.slice(),
    genesisManifestBytes: snapshot.genesisManifestBytes.slice(),
    genesisManifestHash: snapshot.genesisManifestHash.slice(),
    envelopes: Object.freeze(snapshot.envelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeBytes: entry.envelopeBytes.slice(),
      envelopeHash: entry.envelopeHash.slice(),
    }))),
    operationRequestDigest: snapshot.operationRequestDigest.slice(),
    productAllocation: snapshot.productAllocation === null
      ? null
      : copyProductAllocation(snapshot.productAllocation),
  });
}
