import { bytesToHex } from "@noble/hashes/utils.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  createObjectAccessManifestV2,
  objectAccessManifestSigningBytesV2,
  type ObjectAccessManifestV2,
} from "../format/object-access-manifest-v2.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  verifyObjectAccessManifestChainV2,
  type ResolveDeviceSigningPublicKeyV2,
  type TrustedMinimumObjectAccessHeadV2,
} from "../object/access-manifest.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export interface PrepareHumanMemoryDeletionInputV1 {
  readonly currentManifestBytes: Uint8Array;
  readonly currentEnvelopeBytes: readonly Uint8Array[];
  readonly trustedMinimumHead: TrustedMinimumObjectAccessHeadV2;
  readonly proof: readonly Uint8Array[];
  readonly resolveSigningPublicKey: ResolveDeviceSigningPublicKeyV2;
  readonly sourceAuthorized: boolean;
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface PreparedHumanMemoryDeletionV1 {
  readonly manifest: ObjectAccessManifestV2;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
}

type DeletionSnapshot = Readonly<{
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
}>;

const preparedDeletions = new WeakMap<object, DeletionSnapshot>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactBytes(label: string, value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function wipeBytes(...values: readonly (Uint8Array | undefined)[]): void {
  for (const value of values) value?.fill(0);
}

/**
 * Prepares the terminal empty-envelope Human Memory access revision while the
 * authorized client device still owns its signing key. No signing material is
 * retained or returned.
 */
export function prepareHumanMemoryDeletionV1(
  crypto: LatticeCrypto,
  input: PrepareHumanMemoryDeletionInputV1,
): PreparedHumanMemoryDeletionV1 {
  if (input.sourceAuthorized !== true) {
    throw new TypeError("Human Memory deletion requires live source authority");
  }
  if (!Array.isArray(input.currentEnvelopeBytes as unknown)) {
    throw new TypeError("Human Memory deletion envelopes must be an array");
  }
  assertV2Range(
    "Human Memory deletion current Namespace set",
    input.currentEnvelopeBytes.length,
    1,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  const verified = verifyObjectAccessManifestChainV2(crypto, {
    manifestBytes: input.currentManifestBytes,
    proof: input.proof,
    trustedMinimumHead: input.trustedMinimumHead,
    resolveSigningPublicKey: input.resolveSigningPublicKey,
  });
  const envelopeHashes: Uint8Array[] = [];
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    let aggregateEnvelopeBytes = 0;
    for (const sourceBytes of input.currentEnvelopeBytes) {
      if (!(sourceBytes instanceof Uint8Array)) {
        throw new TypeError("Human Memory deletion envelope must be bytes");
      }
      aggregateEnvelopeBytes += sourceBytes.length;
      if (aggregateEnvelopeBytes > V2_LIMITS.manifestEnvelopeBytes) {
        throw new RangeError(
          "Human Memory deletion envelope bytes exceed limit",
        );
      }
      const decoded = decodeNamespaceObjectEnvelopeV2(sourceBytes);
      const canonical = encodeNamespaceObjectEnvelopeV2(decoded);
      try {
        if (
          decoded.context.objectId !== verified.manifest.objectId
          || !equalBytes(canonical, sourceBytes)
        ) throw new TypeError("Human Memory deletion envelope is inexact");
        envelopeHashes.push(crypto.hash(canonical));
      } finally {
        wipeBytes(canonical);
      }
    }
    envelopeHashes.sort((left, right) =>
      compareUnsignedUtf8(bytesToHex(left), bytesToHex(right))
    );
    if (
      envelopeHashes.length !== verified.manifest.envelopeHashes.length
      || envelopeHashes.some((hash, index) =>
        !equalBytes(hash, verified.manifest.envelopeHashes[index]!)
      )
    ) throw new TypeError("Human Memory deletion envelope inventory is inexact");
    publicKey = exactBytes(
      "Human Memory deletion signing public key",
      input.committerSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    privateKey = exactBytes(
      "Human Memory deletion signing private key",
      input.committerSigningPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    const created = createObjectAccessManifestV2(crypto, {
      objectId: verified.manifest.objectId,
      payloadHash: verified.manifest.payloadHash,
      accessRevision: accessRevision(verified.manifest.accessRevision + 1),
      previousManifestHash: verified.manifestHash,
      envelopeHashes: [],
      committerDeviceId: cryptoDeviceId(input.committerDeviceId),
      hostAuthorizationRevision: authorizationRevision(
        input.hostAuthorizationRevision,
      ),
    }, privateKey);
    signingBytes = objectAccessManifestSigningBytesV2(created.manifest);
    if (!crypto.verify(publicKey, signingBytes, created.manifest.signature)) {
      wipeBytes(created.bytes, created.hash);
      throw new TypeError("Human Memory deletion signing keys do not match");
    }
    const prepared = Object.freeze({
      manifest: created.manifest,
      manifestBytes: created.bytes,
      manifestHash: created.hash,
    });
    preparedDeletions.set(prepared, Object.freeze({
      manifestBytes: copyOwnedBytesV2(prepared.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.manifestHash),
    }));
    return prepared;
  } finally {
    wipeBytes(
      ...envelopeHashes,
      verified.manifestBytes,
      verified.manifestHash,
      publicKey,
      privateKey,
      signingBytes,
    );
  }
}

export function assertAuthenticPreparedHumanMemoryDeletionV1(
  prepared: PreparedHumanMemoryDeletionV1,
): void {
  const snapshot = preparedDeletions.get(prepared as object);
  if (
    snapshot === undefined
    || prepared.manifest.envelopeHashes.length !== 0
    || !equalBytes(snapshot.manifestBytes, prepared.manifestBytes)
    || !equalBytes(snapshot.manifestHash, prepared.manifestHash)
  ) throw new TypeError(
    "Human Memory deletion requires an authentic prepared empty-envelope manifest",
  );
}
