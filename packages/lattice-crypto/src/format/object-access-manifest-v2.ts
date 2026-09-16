import { bytesToHex } from "@noble/hashes/utils.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "./v2-primitives.ts";
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

export const OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2 = 2 as const;
export const OBJECT_ACCESS_MANIFEST_DOMAIN_V2 =
  "nautilo/lattice-crypto/object-access-manifest/v2";
const HASH_BYTES = 32;

export interface ObjectAccessManifestUnsignedV2 {
  readonly objectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly accessRevision: AccessRevision;
  readonly previousManifestHash: Uint8Array | null;
  readonly envelopeHashes: readonly Uint8Array[];
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface ObjectAccessManifestV2
  extends ObjectAccessManifestUnsignedV2 {
  readonly formatVersion: typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2;
  readonly signature: Uint8Array;
}

export interface CreatedObjectAccessManifestV2 {
  readonly manifest: ObjectAccessManifestV2;
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
}

function assertFixedBytes(
  label: string,
  value: Uint8Array,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const leftHex = bytesToHex(left);
  const rightHex = bytesToHex(right);
  return compareUnsignedUtf8(leftHex, rightHex);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

function canonicalEnvelopeHashes(
  hashes: readonly Uint8Array[],
): readonly Uint8Array[] {
  if (!Array.isArray(hashes as unknown)) {
    throw new TypeError("manifest envelope hashes must be an array");
  }
  const source: readonly Uint8Array[] = hashes;
  assertV2Limit(
    "manifest envelope count",
    source.length,
    V2_LIMITS.namespaceEnvelopesPerManifest,
  );
  const canonical = source
    .map((hash) => assertFixedBytes("envelope hash", hash, HASH_BYTES))
    .sort(compareBytes);
  for (let index = 1; index < canonical.length; index++) {
    if (equalBytes(canonical[index - 1]!, canonical[index]!)) {
      throw new TypeError("manifest contains a duplicate envelope hash");
    }
  }
  return Object.freeze(canonical);
}

function normalizeUnsigned(
  value: ObjectAccessManifestUnsignedV2,
): ObjectAccessManifestUnsignedV2 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("object access manifest must be an object");
  }
  const normalized = {
    objectId: objectId(value.objectId),
    payloadHash: assertFixedBytes("payload hash", value.payloadHash, HASH_BYTES),
    accessRevision: accessRevision(value.accessRevision),
    previousManifestHash: value.previousManifestHash === null
      ? null
      : assertFixedBytes(
        "previous manifest hash",
        value.previousManifestHash,
        HASH_BYTES,
      ),
    envelopeHashes: canonicalEnvelopeHashes(value.envelopeHashes),
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    hostAuthorizationRevision: authorizationRevision(
      value.hostAuthorizationRevision,
    ),
  };
  if (
    (normalized.accessRevision === 0)
    !== (normalized.previousManifestHash === null)
  ) {
    throw new TypeError(
      "revision zero requires no previous manifest hash; later revisions require one",
    );
  }
  return Object.freeze(normalized);
}

function signingBytesFromNormalized(
  manifest: ObjectAccessManifestUnsignedV2,
): Uint8Array {
  return concatV2(
    frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V2),
    encodeU32(OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2),
    frameText(manifest.objectId),
    frame(manifest.payloadHash),
    encodeU64(manifest.accessRevision),
    encodeU32(manifest.previousManifestHash === null ? 0 : 1),
    ...(manifest.previousManifestHash === null
      ? []
      : [frame(manifest.previousManifestHash)]),
    encodeU32(manifest.envelopeHashes.length),
    ...manifest.envelopeHashes.map(frame),
    frameText(manifest.committerDeviceId),
    encodeU64(manifest.hostAuthorizationRevision),
  );
}

export function objectAccessManifestSigningBytesV2(
  manifest: ObjectAccessManifestUnsignedV2,
): Uint8Array {
  return signingBytesFromNormalized(normalizeUnsigned(manifest));
}

export function encodeObjectAccessManifestV2(
  manifest: ObjectAccessManifestV2,
): Uint8Array {
  if (
    manifest.formatVersion !== OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2
  ) {
    throw new TypeError("unsupported object access manifest version");
  }
  const signature = assertFixedBytes(
    "manifest signature",
    manifest.signature,
    V2_LIMITS.signatureBytes,
  );
  return concatV2(objectAccessManifestSigningBytesV2(manifest), frame(signature));
}

function decodeHash(reader: StrictDecoder): Uint8Array {
  return reader.readFrame(HASH_BYTES);
}

export function decodeObjectAccessManifestV2(
  bytes: Uint8Array,
): ObjectAccessManifestV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  return decodeExact(bytes, (reader) => {
    const domain = reader.readText(utf8V2(OBJECT_ACCESS_MANIFEST_DOMAIN_V2).length);
    if (domain !== OBJECT_ACCESS_MANIFEST_DOMAIN_V2) {
      throw new TypeError("object access manifest domain mismatch");
    }
    const formatVersion = reader.readVersion(
      OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2,
    ) as typeof OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2;
    const decodedObjectId = objectId(reader.readText(V2_LIMITS.idBytes));
    const payloadHash = decodeHash(reader);
    const decodedAccessRevision = accessRevision(reader.readU64());
    const previousPresence = reader.readU32();
    if (previousPresence !== 0 && previousPresence !== 1) {
      throw new TypeError("previous manifest hash presence must be 0 or 1");
    }
    const previousManifestHash = previousPresence === 0
      ? null
      : decodeHash(reader);
    const count = reader.readCount(V2_LIMITS.namespaceEnvelopesPerManifest);
    const envelopeHashes = Array.from(
      { length: count },
      () => decodeHash(reader),
    );
    const committerDeviceId = cryptoDeviceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const hostAuthorizationRevision = authorizationRevision(reader.readU64());
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    if (signature.length !== V2_LIMITS.signatureBytes) {
      throw new TypeError(
        `manifest signature must be exactly ${V2_LIMITS.signatureBytes} bytes`,
      );
    }
    const normalized = normalizeUnsigned({
      objectId: decodedObjectId,
      payloadHash,
      accessRevision: decodedAccessRevision,
      previousManifestHash,
      envelopeHashes,
      committerDeviceId,
      hostAuthorizationRevision,
    });
    for (let index = 0; index < envelopeHashes.length; index++) {
      if (!equalBytes(envelopeHashes[index]!, normalized.envelopeHashes[index]!)) {
        throw new TypeError(
          "manifest envelope hashes use noncanonical ordering",
        );
      }
    }
    return Object.freeze({
      formatVersion,
      ...normalized,
      signature,
    });
  });
}

export function createObjectAccessManifestV2(
  crypto: LatticeCrypto,
  unsigned: ObjectAccessManifestUnsignedV2,
  signingPrivateKey: Uint8Array,
): CreatedObjectAccessManifestV2 {
  assertFixedBytes(
    "signing private key",
    signingPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const normalized = normalizeUnsigned(unsigned);
  const signature = crypto.sign(
    signingPrivateKey,
    signingBytesFromNormalized(normalized),
  );
  const manifest = Object.freeze({
    formatVersion: OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V2,
    ...normalized,
    signature: assertFixedBytes(
      "manifest signature",
      signature,
      V2_LIMITS.signatureBytes,
    ),
  });
  const bytes = encodeObjectAccessManifestV2(manifest);
  return Object.freeze({
    manifest,
    bytes,
    hash: crypto.hash(bytes),
  });
}
