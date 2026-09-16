import {
  OBJECT_ACCESS_MANIFEST_DOMAIN_V2,
  decodeObjectAccessManifestV2,
  type ObjectAccessManifestV2,
} from "./object-access-manifest-v2.ts";
import {
  OBJECT_ACCESS_MANIFEST_DOMAIN_V3,
  decodeObjectAccessManifestV3,
  type ObjectAccessManifestV3,
} from "./object-access-manifest-v3.ts";
import { frameText } from "./v2-primitives.ts";
import {
  OBJECT_ACCESS_MANIFEST_DOMAIN_V5,
  decodeObjectAccessManifestV5,
  type ObjectAccessManifestV5,
} from "./object-access-manifest-v5.ts";

export type ObjectAccessManifestV2OrV3 =
  | ObjectAccessManifestV2
  | ObjectAccessManifestV3;

function hasPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  return value.length >= prefix.length
    && prefix.every((byte, index) => value[index] === byte);
}

const V2_PREFIX = frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V2);
const V3_PREFIX = frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V3);
const V5_PREFIX = frameText(OBJECT_ACCESS_MANIFEST_DOMAIN_V5);

export type ObjectAccessStorageManifest =
  | ObjectAccessManifestV2
  | ObjectAccessManifestV3
  | ObjectAccessManifestV5;

/**
 * Strictly dispatch an access manifest by its framed signing domain. A
 * malformed manifest never falls through from one version's decoder to the
 * other.
 */
export function decodeObjectAccessManifestV2OrV3(
  bytes: Uint8Array,
): ObjectAccessManifestV2OrV3 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (hasPrefix(bytes, V2_PREFIX)) {
    return decodeObjectAccessManifestV2(bytes);
  }
  if (hasPrefix(bytes, V3_PREFIX)) {
    return decodeObjectAccessManifestV3(bytes);
  }
  throw new TypeError("object access manifest domain is unsupported");
}

/** Strict storage-family dispatch; every accepted version has a distinct domain. */
export function decodeObjectAccessStorageManifest(
  bytes: Uint8Array,
): ObjectAccessStorageManifest {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("object access manifest bytes must be Uint8Array");
  }
  if (hasPrefix(bytes, V2_PREFIX)) return decodeObjectAccessManifestV2(bytes);
  if (hasPrefix(bytes, V3_PREFIX)) return decodeObjectAccessManifestV3(bytes);
  if (hasPrefix(bytes, V5_PREFIX)) return decodeObjectAccessManifestV5(bytes);
  throw new TypeError("object access storage manifest domain is unsupported");
}
