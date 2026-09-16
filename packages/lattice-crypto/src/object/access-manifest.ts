import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  createObjectAccessManifestV2,
  decodeObjectAccessManifestV2,
  encodeObjectAccessManifestV2,
  objectAccessManifestSigningBytesV2,
  type CreatedObjectAccessManifestV2,
  type ObjectAccessManifestV2,
} from "../format/object-access-manifest-v2.ts";
import type {
  ObjectAccessGenesisEnvelopeAuthorizationContextV2,
  ObjectAccessGenesisPersistenceAuthorizationContextV2,
  ResolveCurrentObjectAccessGenesisAuthorizationV2,
} from "./storage-coordinator.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  objectId,
  type AccessRevision,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type ObjectId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import { bytesToHex } from "@noble/hashes/utils.js";

const HASH_BYTES = 32;

export interface TrustedMinimumObjectAccessHeadV2 {
  readonly objectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly accessRevision: AccessRevision;
  readonly manifestHash: Uint8Array;
}

export type ResolveDeviceSigningPublicKeyV2 = (
  deviceId: string,
) => Uint8Array | null;

export interface VerifyObjectAccessManifestChainInputV2 {
  readonly manifestBytes: Uint8Array;
  /** Intermediate manifests after the anchor and before `manifestBytes`. */
  readonly proof: readonly Uint8Array[];
  readonly trustedMinimumHead: TrustedMinimumObjectAccessHeadV2;
  readonly resolveSigningPublicKey: ResolveDeviceSigningPublicKeyV2;
}

export interface VerifiedObjectAccessManifestV2 {
  readonly manifest: ObjectAccessManifestV2;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
}

const verifiedManifestSnapshots = new WeakMap<
  object,
  {
    readonly objectId: string;
    readonly envelopeHashes: readonly Uint8Array[];
  }
>();

function rememberVerifiedManifest(
  verified: VerifiedObjectAccessManifestV2,
): VerifiedObjectAccessManifestV2 {
  verifiedManifestSnapshots.set(verified, {
    objectId: verified.manifest.objectId,
    envelopeHashes: verified.manifest.envelopeHashes.map(
      copyOwnedBytesV2,
    ),
  });
  return verified;
}

export type ObjectAccessManifestOperationV2 =
  | {
    readonly type: "attach";
    readonly envelopeBytes: Uint8Array;
  }
  | {
    readonly type: "detach";
    readonly envelopeBytes: Uint8Array;
  };

export interface PrepareObjectAccessManifestUpdateInputV2 {
  readonly currentManifestBytes: Uint8Array;
  readonly currentEnvelopeBytes: readonly Uint8Array[];
  readonly trustedMinimumHead: TrustedMinimumObjectAccessHeadV2;
  readonly proof: readonly Uint8Array[];
  readonly resolveSigningPublicKey: ResolveDeviceSigningPublicKeyV2;
  readonly operation: ObjectAccessManifestOperationV2;
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly signingPrivateKey: Uint8Array;
}

export interface PreparedObjectAccessManifestUpdateV2 {
  readonly manifest: ObjectAccessManifestV2;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly operation: ObjectAccessManifestOperationV2;
}

export interface PrepareObjectAccessManifestGenesisInputV2 {
  readonly objectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly signingPrivateKey: Uint8Array;
}

export interface PreparedObjectAccessManifestGenesisV2 {
  readonly manifest: ObjectAccessManifestV2;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
}

export interface AuthenticateObjectAccessManifestGenesisInputV2 {
  readonly crypto: LatticeCrypto;
  readonly payloadBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly envelopeBytes: readonly Uint8Array[];
  readonly resolveCurrentAuthorization:
    ResolveCurrentObjectAccessGenesisAuthorizationV2;
}

export interface PreparedObjectAccessManifestTombstoneV2 {
  readonly manifest: ObjectAccessManifestV2;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
}

export interface PreparedObjectAccessManifestGenesisWithTombstoneV2 {
  readonly genesis: PreparedObjectAccessManifestGenesisV2;
  readonly preauthorizedTombstone: PreparedObjectAccessManifestTombstoneV2;
}

const preparedManifestSnapshots = new WeakMap<
  object,
  {
    readonly manifestBytes: Uint8Array;
    readonly manifestHash: Uint8Array;
    readonly envelopeBytes: readonly Uint8Array[];
    readonly operationEnvelopeBytes: Uint8Array;
  }
>();

const preparedManifestGenesisSnapshots = new WeakMap<
  object,
  {
    readonly manifestBytes: Uint8Array;
    readonly manifestHash: Uint8Array;
    readonly envelopeBytes: readonly Uint8Array[];
  }
>();
const preparedGenesisTombstoneSnapshots = new WeakMap<
  PreparedObjectAccessManifestGenesisWithTombstoneV2,
  Readonly<{
    genesisHash: Uint8Array;
    tombstoneBytes: Uint8Array;
    tombstoneHash: Uint8Array;
  }>
>();

/**
 * Prepared persistence is capability-bound to this module's verified
 * authorization/signing path. A structurally similar caller object is not an
 * acceptable storage authorization.
 */
export function assertAuthenticPreparedObjectAccessManifestUpdateV2(
  prepared: PreparedObjectAccessManifestUpdateV2,
): void {
  const snapshot = preparedManifestSnapshots.get(prepared);
  if (
    !snapshot
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.some(
      (bytes, index) => !equalBytes(bytes, prepared.envelopeBytes[index]!),
    )
    || !equalBytes(
      snapshot.operationEnvelopeBytes,
      prepared.operation.envelopeBytes,
    )
  ) {
    throw new TypeError(
      "object access persistence requires an authentic prepared update",
    );
  }
}

export function assertAuthenticPreparedObjectAccessManifestGenesisV2(
  prepared: PreparedObjectAccessManifestGenesisV2,
): void {
  const snapshot = preparedManifestGenesisSnapshots.get(prepared);
  if (
    !snapshot
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
    || snapshot.envelopeBytes.some(
      (bytes, index) => !equalBytes(bytes, prepared.envelopeBytes[index]!),
    )
  ) {
    throw new TypeError(
      "object access genesis persistence requires an authentic prepared genesis",
    );
  }
}

function assertHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

function compareHashes(left: Uint8Array, right: Uint8Array): number {
  return compareUnsignedUtf8(bytesToHex(left), bytesToHex(right));
}

function validateAnchor(
  anchor: TrustedMinimumObjectAccessHeadV2,
): TrustedMinimumObjectAccessHeadV2 {
  return Object.freeze({
    objectId: objectId(anchor.objectId),
    payloadHash: assertHash("trusted payload hash", anchor.payloadHash),
    accessRevision: accessRevision(anchor.accessRevision),
    manifestHash: assertHash("trusted manifest hash", anchor.manifestHash),
  });
}

function verifySignature(
  crypto: LatticeCrypto,
  manifest: ObjectAccessManifestV2,
  resolveSigningPublicKey: ResolveDeviceSigningPublicKeyV2,
): void {
  const publicKey = resolveSigningPublicKey(manifest.committerDeviceId);
  if (!(publicKey instanceof Uint8Array)) {
    throw new Error(
      `no trusted signing key for committer ${manifest.committerDeviceId}`,
    );
  }
  if (
    !crypto.verify(
      publicKey,
      objectAccessManifestSigningBytesV2(manifest),
      manifest.signature,
    )
  ) {
    throw new Error("object access manifest signature is invalid");
  }
}

function assertManifestIdentity(
  manifest: ObjectAccessManifestV2,
  anchor: TrustedMinimumObjectAccessHeadV2,
): void {
  if (manifest.objectId !== anchor.objectId) {
    throw new Error("object access manifest object mismatch");
  }
  if (!equalBytes(manifest.payloadHash, anchor.payloadHash)) {
    throw new Error("object access manifest payload mismatch");
  }
}

export function verifyObjectAccessManifestChainV2(
  crypto: LatticeCrypto,
  input: VerifyObjectAccessManifestChainInputV2,
): VerifiedObjectAccessManifestV2 {
  if (!Array.isArray(input.proof as unknown)) {
    throw new TypeError("object access proof must be an array");
  }
  const proof: readonly Uint8Array[] = input.proof;
  assertV2Limit(
    "object access proof entries",
    proof.length,
    V2_LIMITS.proofEntriesPerSegment,
  );
  const anchor = validateAnchor(input.trustedMinimumHead);
  const target = decodeObjectAccessManifestV2(input.manifestBytes);
  const targetHash = crypto.hash(input.manifestBytes);
  assertManifestIdentity(target, anchor);

  if (target.accessRevision < anchor.accessRevision) {
    throw new Error("object access manifest rollback below trusted minimum");
  }
  if (target.accessRevision === anchor.accessRevision) {
    if (proof.length !== 0) {
      throw new Error("same-revision object access proof must be empty");
    }
    if (!equalBytes(targetHash, anchor.manifestHash)) {
      throw new Error("object access manifest changed at the same revision");
    }
    verifySignature(crypto, target, input.resolveSigningPublicKey);
    const verified = Object.freeze({
      manifest: target,
      manifestBytes: copyOwnedBytesV2(input.manifestBytes),
      manifestHash: targetHash,
    });
    return rememberVerifiedManifest(verified);
  }

  let previousRevision = anchor.accessRevision;
  let previousHash = anchor.manifestHash;
  const segment: readonly Uint8Array[] = [...proof, input.manifestBytes];
  for (const manifestBytes of segment) {
    const manifest = decodeObjectAccessManifestV2(manifestBytes);
    const manifestHash = crypto.hash(manifestBytes);
    assertManifestIdentity(manifest, anchor);
    if (
      manifest.accessRevision !== previousRevision + 1
      || !equalBytes(manifest.previousManifestHash!, previousHash)
    ) {
      throw new Error("object access manifest fork or broken hash chain");
    }
    verifySignature(crypto, manifest, input.resolveSigningPublicKey);
    previousRevision = manifest.accessRevision;
    previousHash = manifestHash;
  }
  const verified = Object.freeze({
    manifest: target,
    manifestBytes: copyOwnedBytesV2(input.manifestBytes),
    manifestHash: targetHash,
  });
  return rememberVerifiedManifest(verified);
}

type HashedEnvelope = {
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
};

function canonicalEnvelopeBytes(
  crypto: LatticeCrypto,
  envelopes: readonly Uint8Array[],
): readonly HashedEnvelope[] {
  if (!Array.isArray(envelopes as unknown)) {
    throw new TypeError("Namespace envelope bytes must be an array");
  }
  const source: readonly Uint8Array[] = envelopes;
  assertV2Limit(
    "Namespace envelope count",
    source.length,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  let totalBytes = 0;
  for (const envelope of source) {
    totalBytes += envelope.length;
    assertV2Limit(
      "manifest envelope bytes",
      totalBytes,
      V2_LIMITS.manifestEnvelopeBytes,
    );
  }
  const canonical = source.map((envelope) => {
    decodeNamespaceObjectEnvelopeV2(envelope);
    const bytes = envelope;
    return { bytes, hash: crypto.hash(bytes) };
  }).sort((left, right) => compareHashes(left.hash, right.hash));
  for (let index = 1; index < canonical.length; index++) {
    if (equalBytes(canonical[index - 1]!.hash, canonical[index]!.hash)) {
      throw new Error("duplicate Namespace envelope hash");
    }
  }
  return Object.freeze(canonical);
}

function assertEnvelopeInventoryMatches(
  manifest: ObjectAccessManifestV2,
  envelopes: readonly HashedEnvelope[],
): void {
  if (manifest.envelopeHashes.length !== envelopes.length) {
    throw new Error("Namespace envelope inventory does not match manifest");
  }
  for (let index = 0; index < envelopes.length; index++) {
    if (!equalBytes(manifest.envelopeHashes[index]!, envelopes[index]!.hash)) {
      throw new Error("Namespace envelope inventory does not match manifest");
    }
  }
}

function exactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) throw new TypeError(`${label} fields are invalid`);
}

function authenticationEnvelopeContext(
  envelope: HashedEnvelope,
): ObjectAccessGenesisEnvelopeAuthorizationContextV2 {
  const decoded = decodeNamespaceObjectEnvelopeV2(envelope.bytes);
  return Object.freeze({
    objectId: decoded.context.objectId,
    namespaceId: decoded.context.namespaceId,
    keyClass: decoded.context.keyClass,
    keyGeneration: decoded.context.keyGeneration,
    bindingRevisionAtWrap: decoded.context.bindingRevisionAtWrap,
    envelopeHash: copyOwnedBytesV2(envelope.hash),
  });
}

function authenticationContextCopy(
  context: ObjectAccessGenesisPersistenceAuthorizationContextV2,
): ObjectAccessGenesisPersistenceAuthorizationContextV2 {
  return Object.freeze({
    ...context,
    payloadHash: copyOwnedBytesV2(context.payloadHash),
    envelopes: Object.freeze(context.envelopes.map((envelope) =>
      Object.freeze({
        ...envelope,
        envelopeHash: copyOwnedBytesV2(envelope.envelopeHash),
      })
    )),
  });
}

function authenticationContextsEqual(
  left: ObjectAccessGenesisPersistenceAuthorizationContextV2,
  right: ObjectAccessGenesisPersistenceAuthorizationContextV2,
): boolean {
  return left.purpose === right.purpose
    && left.objectId === right.objectId
    && equalBytes(left.payloadHash, right.payloadHash)
    && left.committerDeviceId === right.committerDeviceId
    && left.hostAuthorizationRevision === right.hostAuthorizationRevision
    && left.envelopes.length === right.envelopes.length
    && left.envelopes.every((envelope, index) => {
      const candidate = right.envelopes[index];
      return candidate !== undefined
        && envelope.objectId === candidate.objectId
        && envelope.namespaceId === candidate.namespaceId
        && envelope.keyClass === candidate.keyClass
        && envelope.keyGeneration === candidate.keyGeneration
        && envelope.bindingRevisionAtWrap === candidate.bindingRevisionAtWrap
        && equalBytes(envelope.envelopeHash, candidate.envelopeHash);
    });
}

/**
 * Authenticate client-supplied genesis bytes at an HTTP/storage boundary and
 * mint the same process-local capability produced by the private-key prepare
 * path. Raw wire objects cannot bypass this check or survive as authority.
 */
export async function authenticateObjectAccessManifestGenesisV2(
  input: AuthenticateObjectAccessManifestGenesisInputV2,
): Promise<PreparedObjectAccessManifestGenesisV2> {
  if (!(input.payloadBytes instanceof Uint8Array)) {
    throw new TypeError("object access genesis payload bytes must be Uint8Array");
  }
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError("current object access genesis authority is required");
  }
  const manifestBytes = copyOwnedBytesV2(input.manifestBytes);
  const payloadHash = input.crypto.hash(input.payloadBytes);
  const envelopes = canonicalEnvelopeBytes(input.crypto, input.envelopeBytes);
  const canonicalManifestBytes: Uint8Array[] = [];
  const authorityBytes: Uint8Array[] = [];
  try {
    const manifest = decodeObjectAccessManifestV2(manifestBytes);
    const encoded = encodeObjectAccessManifestV2(manifest);
    canonicalManifestBytes.push(encoded);
    if (!equalBytes(encoded, manifestBytes)) {
      throw new TypeError("object access genesis manifest is noncanonical");
    }
    if (
      manifest.accessRevision !== 0
      || manifest.previousManifestHash !== null
    ) throw new TypeError("object access admission requires genesis revision zero");
    if (!equalBytes(payloadHash, manifest.payloadHash)) {
      throw new Error("object access genesis payload hash mismatch");
    }
    assertEnvelopeInventoryMatches(manifest, envelopes);
    const envelopeContexts = Object.freeze(
      envelopes.map(authenticationEnvelopeContext),
    );
    if (envelopeContexts.some((entry) => entry.objectId !== manifest.objectId)) {
      throw new Error("object access genesis envelope object mismatch");
    }
    const context = Object.freeze({
      purpose: "persist-object-access-genesis" as const,
      objectId: manifest.objectId,
      payloadHash: copyOwnedBytesV2(manifest.payloadHash),
      envelopes: envelopeContexts,
      committerDeviceId: manifest.committerDeviceId,
      hostAuthorizationRevision: manifest.hostAuthorizationRevision,
    });
    const resolved = await input.resolveCurrentAuthorization(
      authenticationContextCopy(context),
    );
    if (resolved === null || typeof resolved !== "object") {
      throw new Error("current object access genesis authority is unavailable");
    }
    exactFields("object access genesis authority", resolved, [
      "purpose",
      "objectId",
      "payloadHash",
      "envelopes",
      "committerDeviceId",
      "hostAuthorizationRevision",
      "sourceAuthorized",
      "targetAuthorized",
      "currentHostAuthorizationRevision",
      "committerSigningPublicKey",
    ]);
    if (
      resolved.sourceAuthorized !== true
      || resolved.targetAuthorized !== true
      || resolved.currentHostAuthorizationRevision
        !== manifest.hostAuthorizationRevision
    ) throw new Error("current object access genesis host authorization is stale");
    if (!authenticationContextsEqual(context, resolved)) {
      throw new Error("current object access genesis authority was substituted");
    }
    if (
      !(resolved.committerSigningPublicKey instanceof Uint8Array)
      || resolved.committerSigningPublicKey.length
        !== V2_LIMITS.signingPublicKeyBytes
    ) throw new TypeError("committer signing public key is invalid");
    const publicKey = copyOwnedBytesV2(resolved.committerSigningPublicKey);
    const signingBytes = objectAccessManifestSigningBytesV2(manifest);
    authorityBytes.push(publicKey, signingBytes);
    if (!input.crypto.verify(publicKey, signingBytes, manifest.signature)) {
      throw new Error("object access genesis signature is invalid");
    }
    const manifestHash = input.crypto.hash(manifestBytes);
    try {
      const prepared = Object.freeze({
        manifest,
        manifestBytes: copyOwnedBytesV2(manifestBytes),
        manifestHash: copyOwnedBytesV2(manifestHash),
        envelopeBytes: Object.freeze(
          envelopes.map((entry) => copyOwnedBytesV2(entry.bytes)),
        ),
      });
      preparedManifestGenesisSnapshots.set(prepared, {
        manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
        manifestHash: copyOwnedBytesV2(prepared.manifestHash),
        envelopeBytes: prepared.envelopeBytes.map(copyOwnedBytesV2),
      });
      return prepared;
    } finally {
      manifestHash.fill(0);
    }
  } finally {
    manifestBytes.fill(0);
    payloadHash.fill(0);
    for (const bytes of canonicalManifestBytes) bytes.fill(0);
    for (const bytes of authorityBytes) bytes.fill(0);
    for (const envelope of envelopes) envelope.hash.fill(0);
  }
}

export function prepareObjectAccessManifestGenesisV2(
  crypto: LatticeCrypto,
  input: PrepareObjectAccessManifestGenesisInputV2,
): PreparedObjectAccessManifestGenesisV2 {
  if (input.sourceAuthorized !== true || input.targetAuthorized !== true) {
    throw new Error(
      "object access genesis requires explicit source and target authorization",
    );
  }
  const targetObjectId = objectId(input.objectId);
  const envelopes = canonicalEnvelopeBytes(crypto, input.envelopeBytes);
  for (const envelope of envelopes) {
    if (
      decodeNamespaceObjectEnvelopeV2(envelope.bytes).context.objectId
        !== targetObjectId
    ) {
      throw new Error("Namespace envelope object mismatch");
    }
  }
  const created = createObjectAccessManifestV2(
    crypto,
    {
      objectId: targetObjectId,
      payloadHash: input.payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: envelopes.map((entry) => entry.hash),
      committerDeviceId: cryptoDeviceId(input.committerDeviceId),
      hostAuthorizationRevision: authorizationRevision(
        input.hostAuthorizationRevision,
      ),
    },
    input.signingPrivateKey,
  );
  const prepared = Object.freeze({
    manifest: created.manifest,
    manifestBytes: created.bytes,
    manifestHash: created.hash,
    envelopeBytes: Object.freeze(
      envelopes.map((entry) => copyOwnedBytesV2(entry.bytes)),
    ),
  });
  preparedManifestGenesisSnapshots.set(prepared, {
    manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
    manifestHash: copyOwnedBytesV2(prepared.manifestHash),
    envelopeBytes: prepared.envelopeBytes.map(copyOwnedBytesV2),
  });
  return prepared;
}
/**
 * Prepare Human-device genesis together with its exact empty-envelope
 * successor. Persistence may stage the successor for crash-safe recovery; the
 * server never receives signing authority.
 */
export function prepareObjectAccessManifestGenesisWithTombstoneV2(
  crypto: LatticeCrypto,
  input: PrepareObjectAccessManifestGenesisInputV2,
): PreparedObjectAccessManifestGenesisWithTombstoneV2 {
  const genesis = prepareObjectAccessManifestGenesisV2(crypto, input);
  const tombstone = createObjectAccessManifestV2(
    crypto,
    {
      objectId: genesis.manifest.objectId,
      payloadHash: genesis.manifest.payloadHash,
      accessRevision: accessRevision(1),
      previousManifestHash: genesis.manifestHash,
      envelopeHashes: [],
      committerDeviceId: genesis.manifest.committerDeviceId,
      hostAuthorizationRevision:
        genesis.manifest.hostAuthorizationRevision,
    },
    input.signingPrivateKey,
  );
  const prepared = Object.freeze({
    genesis,
    preauthorizedTombstone: Object.freeze({
      manifest: tombstone.manifest,
      manifestBytes: tombstone.bytes,
      manifestHash: tombstone.hash,
    }),
  });
  preparedGenesisTombstoneSnapshots.set(prepared, Object.freeze({
    genesisHash: copyOwnedBytesV2(genesis.manifestHash),
    tombstoneBytes: copyOwnedBytesV2(tombstone.bytes),
    tombstoneHash: copyOwnedBytesV2(tombstone.hash),
  }));
  return prepared;
}

export function assertAuthenticPreparedObjectAccessManifestGenesisWithTombstoneV2(
  prepared: PreparedObjectAccessManifestGenesisWithTombstoneV2,
): void {
  assertAuthenticPreparedObjectAccessManifestGenesisV2(prepared.genesis);
  const snapshot = preparedGenesisTombstoneSnapshots.get(prepared);
  if (
    snapshot === undefined
    || !equalBytes(snapshot.genesisHash, prepared.genesis.manifestHash)
    || !equalBytes(
      snapshot.tombstoneBytes,
      prepared.preauthorizedTombstone.manifestBytes,
    )
    || !equalBytes(
      snapshot.tombstoneHash,
      prepared.preauthorizedTombstone.manifestHash,
    )
  ) {
    throw new TypeError(
      "object access recovery requires an authentic prepared genesis tombstone",
    );
  }
}

export function assertEnvelopeAuthorizedV2(
  crypto: LatticeCrypto,
  verified: VerifiedObjectAccessManifestV2,
  envelopeBytes: Uint8Array,
): void {
  const snapshot = verifiedManifestSnapshots.get(verified);
  if (!snapshot) {
    throw new TypeError(
      "envelope authorization requires a trusted-head-verified manifest",
    );
  }
  const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
  if (envelope.context.objectId !== snapshot.objectId) {
    throw new Error("Namespace envelope object mismatch");
  }
  const hash = crypto.hash(envelopeBytes);
  if (
    !snapshot.envelopeHashes.some((candidate) =>
      equalBytes(candidate, hash)
    )
  ) {
    throw new Error("Namespace envelope is detached from current manifest");
  }
}

export function prepareObjectAccessManifestUpdateV2(
  crypto: LatticeCrypto,
  input: PrepareObjectAccessManifestUpdateInputV2,
): PreparedObjectAccessManifestUpdateV2 {
  if (input.sourceAuthorized !== true || input.targetAuthorized !== true) {
    throw new Error(
      "attach/detach requires explicit source and target authorization",
    );
  }
  const currentEnvelopes = canonicalEnvelopeBytes(
    crypto,
    input.currentEnvelopeBytes,
  );
  const verified = verifyObjectAccessManifestChainV2(crypto, {
    manifestBytes: input.currentManifestBytes,
    proof: input.proof,
    trustedMinimumHead: input.trustedMinimumHead,
    resolveSigningPublicKey: input.resolveSigningPublicKey,
  });
  assertEnvelopeInventoryMatches(verified.manifest, currentEnvelopes);
  for (const envelope of currentEnvelopes) {
    const decoded = decodeNamespaceObjectEnvelopeV2(envelope.bytes);
    if (decoded.context.objectId !== verified.manifest.objectId) {
      throw new Error("Namespace envelope object mismatch");
    }
  }
  const operationEnvelope = decodeNamespaceObjectEnvelopeV2(
    input.operation.envelopeBytes,
  );
  const canonicalOperationBytes = encodeNamespaceObjectEnvelopeV2(
    operationEnvelope,
  );
  const operationHash = crypto.hash(canonicalOperationBytes);
  if (operationEnvelope.context.objectId !== verified.manifest.objectId) {
    throw new Error("updated Namespace envelope object mismatch");
  }
  const matchingIndex = currentEnvelopes.findIndex((candidate) =>
    equalBytes(candidate.hash, operationHash)
  );
  let nextEnvelopeBytes: readonly Uint8Array[];
  if (input.operation.type === "attach") {
    if (matchingIndex >= 0) {
      throw new Error("Namespace envelope is already attached");
    }
    nextEnvelopeBytes = [
      ...currentEnvelopes.map((entry) => entry.bytes),
      canonicalOperationBytes,
    ];
  } else {
    if (matchingIndex < 0) {
      throw new Error("cannot detach an absent Namespace envelope");
    }
    nextEnvelopeBytes = currentEnvelopes
      .filter((_, index) => index !== matchingIndex)
      .map((entry) => entry.bytes);
  }
  const nextEnvelopes = canonicalEnvelopeBytes(crypto, nextEnvelopeBytes);
  const created: CreatedObjectAccessManifestV2 =
    createObjectAccessManifestV2(
      crypto,
      {
        objectId: verified.manifest.objectId,
        payloadHash: verified.manifest.payloadHash,
        accessRevision: accessRevision(verified.manifest.accessRevision + 1),
        previousManifestHash: verified.manifestHash,
        envelopeHashes: nextEnvelopes.map((entry) => entry.hash),
        committerDeviceId: cryptoDeviceId(input.committerDeviceId),
        hostAuthorizationRevision: authorizationRevision(
          input.hostAuthorizationRevision,
        ),
      },
      input.signingPrivateKey,
    );
  const prepared = Object.freeze({
    manifest: created.manifest,
    manifestBytes: created.bytes,
    manifestHash: created.hash,
    envelopeBytes: Object.freeze(
      nextEnvelopes.map((entry) => copyOwnedBytesV2(entry.bytes)),
    ),
    operation: Object.freeze({
      type: input.operation.type,
      // Encoding created these bytes locally; no caller-visible alias exists.
      envelopeBytes: canonicalOperationBytes,
    }),
  });
  preparedManifestSnapshots.set(prepared, {
    manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
    manifestHash: copyOwnedBytesV2(prepared.manifestHash),
    envelopeBytes: prepared.envelopeBytes.map(copyOwnedBytesV2),
    operationEnvelopeBytes:
      copyOwnedBytesV2(prepared.operation.envelopeBytes),
  });
  return prepared;
}
