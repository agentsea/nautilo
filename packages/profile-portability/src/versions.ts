/**
 * Versioning and compatibility rules for the three independently-versioned
 * contracts: semantic (`GenieLiveV1`), container (`ProfileContainerV1`), and
 * protection (`ProtectionSuite`).
 *
 * The package freezes container version 1 and semantic major 1 / minor 1. A reader
 * rejects unknown container versions and unknown semantic majors before any
 * source/target mutation. Semantic minor 0 remains an explicit legacy read
 * contract; unknown future minors are rejected because their record field
 * semantics cannot be validated honestly by this reader.
 */

export const CONTAINER_VERSION = 1 as const;
export type ContainerVersion = typeof CONTAINER_VERSION;

export const SEMANTIC_VERSION = { major: 1, minor: 1 } as const;
export type SemanticVersion = { readonly major: number; readonly minor: number };

export const PAYLOAD_CODEC = "genie-live-records" as const;
export type PayloadCodec = typeof PAYLOAD_CODEC;

export const PROTECTION_SUITE_ID = "xchacha20poly1305-framed-v1" as const;
export type ProtectionSuiteId = typeof PROTECTION_SUITE_ID;

export type VersionCompatibility =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: "unknown-major" | "unknown-minor" | "unknown-container" };

export function isKnownContainerVersion(v: unknown): boolean {
  return v === CONTAINER_VERSION;
}

export function isKnownPayloadCodec(codec: unknown): boolean {
  return codec === PAYLOAD_CODEC;
}

export function isKnownProtectionSuite(suite: string): boolean {
  return suite === PROTECTION_SUITE_ID;
}

/**
 * Semantic-version compatibility for a reader implementing major N.
 * Unknown majors and future minors are rejected. Major 1 minor 0 is the only
 * legacy semantic shape; minor 1 is the current shape.
 */
export function semanticVersionCompatibility(
  bundle: SemanticVersion,
  readerMajor: number,
): VersionCompatibility {
  if (!Number.isInteger(bundle.major) || !Number.isInteger(bundle.minor)) {
    return { compatible: false, reason: "unknown-major" };
  }
  if (bundle.major !== readerMajor) {
    return { compatible: false, reason: "unknown-major" };
  }
  if (bundle.minor < 0) {
    return { compatible: false, reason: "unknown-minor" };
  }
  const readerMinor = SEMANTIC_VERSION.minor;
  if (bundle.minor > readerMinor) {
    return { compatible: false, reason: "unknown-minor" };
  }
  return { compatible: true };
}
