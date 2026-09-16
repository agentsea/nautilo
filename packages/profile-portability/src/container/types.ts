/**
 * Immutable container types: header, bounded key slots, record frames, AAD,
 * ordering, FINAL marker, and the encrypted terminal manifest.
 *
 * The public header carries versions, bundle ID, bounded framing values, and
 * wrapped-DEK slots only. Records and the terminal manifest are encrypted
 * frames. A reader yields semantic records only after FINAL authentication
 * and after every per-record hash and the semantic root verify.
 */

import type { KeySlotV1 } from "../key-slots/types";
import type { ProtectionSuiteId, PayloadCodec, SemanticVersion } from "../versions";

export type ContainerHeaderV1 = {
  readonly containerVersion: 1;
  readonly semanticVersion: SemanticVersion;
  readonly bundleId: string;
  readonly payloadCodec: PayloadCodec;
  readonly protectionSuite: ProtectionSuiteId;
  readonly chunkSize: number;
  readonly keySlots: readonly KeySlotV1[];
  readonly frameCount: number;
  readonly totalPayloadBytes: number;
};

export type FrameKind = "record" | "terminal-manifest";

/**
 * One encrypted frame. `ordinal` is the strict 0-based ordering index; the
 * FINAL terminal-manifest frame is the frame with the highest ordinal and
 * `kind: "terminal-manifest"`. `aad` is the per-frame additional authenticated
 * data bound to the ciphertext (header digest + ordinal + kind). The
 * ciphertext is opaque bytes; Wave 0 does not perform AEAD.
 */
export type EncryptedFrameV1 = {
  readonly ordinal: number;
  readonly kind: FrameKind;
  readonly ciphertext: Uint8Array;
  readonly aad: Uint8Array;
};

export type ManifestRecord = {
  readonly recordKind: string;
  readonly frameOrdinal: number;
  readonly sha256: string;
  readonly bytes: number;
};

export type TerminalManifestV1 = {
  readonly semanticRoot: string;
  readonly records: readonly ManifestRecord[];
  readonly frameCount: number;
  readonly totalPayloadBytes: number;
};

/**
 * Archive entry — the bundle is also a structural archive of named entries
 * (header, frames, manifest, media). The manifest allowlist validator
 * rejects entries outside the fixed allowlist and entries that are symlinks,
 * traversal, oversized, or compression bombs.
 */
export type ArchiveEntryKind = "file" | "symlink" | "directory";

export type ArchiveEntry = {
  readonly path: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly kind: ArchiveEntryKind;
  readonly isCompressed: boolean;
};

/**
 * Fixed archive manifest allowlist. Only these path prefixes are permitted
 * inside a `.nautilo-profile` archive. Anything else is rejected before
 * extraction/parse. Paths are forward-slash relative, no leading slash, no
 * `..` segments.
 */
export const ARCHIVE_ALLOWLIST: readonly string[] = [
  "header.json",
  "manifest.json",
  "frames/",
  "media/",
];

// ---------------------------------------------------------------------------
// Wave 3 — format v2 artifact-byte chunk framing
// ---------------------------------------------------------------------------
//
// Artifact bytes are opt-in and may be arbitrarily large product-wise, so they
// are carried as a stream of bounded, individually-authenticated AEAD chunk
// frames (NOT JSON hex blobs and NOT a whole-artifact Uint8Array). Each chunk
// frame binds the immutable container-header digest, the artifact media
// version, the entry path (`media/artifacts/<opaque-id>.bin`), the chunk
// ordinal, finality, and the plaintext length. A single terminal
// artifact-manifest frame carries the per-entry size / sha256 / chunkCount
// totals and authenticates them under the same DEK.
//
// These types describe the logical, in-memory frame shape. The on-wire
// encoding (length-prefixed binary) lives in the serializer; validators here
// operate on the logical shape so they can be unit-tested without I/O.

/** Logical artifact chunk frame type. */
export type ArtifactChunkFrame = {
  readonly frameType: "artifact-chunk";
  readonly mediaVersion: number;
  readonly entryPath: string;
  readonly ordinal: number;
  readonly final: boolean;
  readonly plaintextLength: number;
  readonly nonce: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
};

/** Logical artifact terminal-manifest frame type. */
export type ArtifactTerminalFrame = {
  readonly frameType: "artifact-manifest";
  readonly mediaVersion: number;
  readonly ordinal: number;
  readonly final: boolean;
  readonly plaintextLength: number;
  readonly nonce: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
};

export type ArtifactFrame = ArtifactChunkFrame | ArtifactTerminalFrame;

/** Minimal incremental SHA-256 surface used by CLI-only artifact streaming. */
export type HexDigestAccumulator = {
  update(data: Uint8Array): unknown;
  digest(encoding: "hex"): string;
};

/**
 * Per-entry accumulated totals a reader maintains while streaming chunk frames,
 * cross-checked against the authenticated terminal manifest.
 */
export type ArtifactEntryAccumulator = {
  readonly entryPath: string;
  chunkCount: number;
  bytesReceived: number;
  finalSeen: boolean;
  hash: HexDigestAccumulator;
};

/**
 * Authenticated per-entry manifest record carried by the terminal
 * artifact-manifest frame. `bytesEntry` is the opaque media path and MUST equal
 * the matching `PortableArtifact.bytesEntry` (enforced by the semantic layer);
 * the stream reader enforces 1:1 with the received chunk entries.
 */
export type ArtifactStreamManifestEntry = {
  readonly entryPath: string;
  readonly size: number;
  readonly sha256: string;
  readonly chunkCount: number;
};

export type ArtifactStreamManifest = {
  readonly mediaVersion: number;
  readonly entries: readonly ArtifactStreamManifestEntry[];
};

/** On-wire artifact frame format version (distinct from media version 2). */
export const ARTIFACT_FRAME_FORMAT_VERSION = 1 as const;
export type ArtifactFrameFormatVersion = typeof ARTIFACT_FRAME_FORMAT_VERSION;

/** Fixed binary frame field sizes. */
export const ARTIFACT_FRAME_NONCE_BYTES = 24;
export const ARTIFACT_FRAME_TAG_BYTES = 16;
export const ARTIFACT_FRAME_MAX_BODY_BYTES = 8 * 1024 * 1024; // hard ceiling per frame body
