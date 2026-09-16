/**
 * Golden malformed fixtures — each is a structural input that MUST be rejected
 * by a specific error code. Grouped by validator. These double as the
 * canonical-parser rejection matrix for §0.1.4 of the phase doc.
 */

import type { ContainerHeaderV1, EncryptedFrameV1, ArchiveEntry } from "../../src/container/types";
import type { GenieLiveV1 } from "../../src/semantic/types";
import { validContainerHeaderV1, validRecoverySlot, validArtifactRecord, validArtifactMediaManifest, validGenieLiveV1 } from "./valid";

// --- Semantic record rejections ---

export const malformedRecordUnknownKind = {
  recordKind: "onboarding",
  name: "X",
};

export const malformedRecordForbiddenIdField = {
  recordKind: "identity",
  name: "X",
  handleIntent: null,
  id: "src-uuid-123",
};

export const malformedRecordForbiddenAgentId = {
  recordKind: "memory",
  scope: "private",
  type: "general",
  content: "hi",
  createdAt: null,
  agentId: "agent-1",
};

export const malformedRecordSharedMemoryScope = {
  recordKind: "memory",
  scope: "shared",
  type: "general",
  content: "hi",
  createdAt: null,
};

export const malformedRecordBadField = {
  recordKind: "identity",
  name: 42,
  handleIntent: null,
};

export const malformedGenieLiveBadSemanticMajor = {
  semanticVersion: { major: 2, minor: 0 },
  bundleId: "source-genie-001",
  scopes: ["profile"],
  records: [{ recordKind: "soul", text: null }],
};

export const malformedGenieLiveBadBundleId = {
  semanticVersion: { major: 1, minor: 0 },
  bundleId: "has spaces!",
  scopes: ["profile"],
  records: [{ recordKind: "soul", text: null }],
};

export const malformedGenieLiveUnknownScope = {
  semanticVersion: { major: 1, minor: 0 },
  bundleId: "source-genie-001",
  scopes: ["profile", "vault"],
  records: [{ recordKind: "soul", text: null }],
};

export const malformedGenieLiveEmptyRecords = {
  semanticVersion: { major: 1, minor: 0 },
  bundleId: "source-genie-001",
  scopes: ["profile"],
  records: [],
};

// --- Header rejections ---

export const malformedHeaderUnknownContainerVersion: ContainerHeaderV1 = {
  ...validContainerHeaderV1,
  containerVersion: 2 as unknown as 1,
};

export const malformedHeaderUnknownSuite: ContainerHeaderV1 = {
  ...validContainerHeaderV1,
  protectionSuite: "aes-gcm-v9" as unknown as "xchacha20poly1305-framed-v1",
};

export const malformedHeaderPlaintextDowngrade: ContainerHeaderV1 = {
  ...validContainerHeaderV1,
  protectionSuite: "plaintext" as unknown as "xchacha20poly1305-framed-v1",
};

export const malformedHeaderChunkSizeTooSmall: ContainerHeaderV1 = {
  ...validContainerHeaderV1,
  chunkSize: 8,
};

export const malformedHeaderNoSlots: ContainerHeaderV1 = {
  ...validContainerHeaderV1,
  keySlots: [],
};

export const malformedHeaderTooManySlots: ContainerHeaderV1 = {
  ...validContainerHeaderV1,
  keySlots: [validRecoverySlot, validRecoverySlot, validRecoverySlot, validRecoverySlot, validRecoverySlot],
};

// --- Key-slot rejections ---

export const malformedRecoverySlotKdfOutOfBound = {
  ...validRecoverySlot,
  kdfParams: { memoryCostKiB: 1024, timeCost: 2, parallelism: 1, outputLength: 32 },
};

export const malformedRecoverySlotSaltLength = {
  ...validRecoverySlot,
  salt: new Uint8Array(8),
};

export const malformedKeychainSlot = {
  kind: "keychain",
  slotId: 1,
  keychainLabel: "nautilo-dek",
  wrappedDek: new Uint8Array(48),
  aad: new Uint8Array(32),
};

// --- Frame rejections ---

export const malformedFramesGap: EncryptedFrameV1[] = [
  { ordinal: 0, kind: "record", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
  { ordinal: 2, kind: "terminal-manifest", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
];

export const malformedFramesDuplicate: EncryptedFrameV1[] = [
  { ordinal: 0, kind: "record", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
  { ordinal: 0, kind: "record", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
  { ordinal: 1, kind: "terminal-manifest", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
];

export const malformedFramesNoFinal: EncryptedFrameV1[] = [
  { ordinal: 0, kind: "record", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
  { ordinal: 1, kind: "record", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
];

export const malformedFramesMultipleFinal: EncryptedFrameV1[] = [
  { ordinal: 0, kind: "terminal-manifest", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
  { ordinal: 1, kind: "terminal-manifest", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
];

export const malformedFramesFinalNotHighest: EncryptedFrameV1[] = [
  { ordinal: 0, kind: "terminal-manifest", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
  { ordinal: 1, kind: "record", ciphertext: new Uint8Array(16), aad: new Uint8Array(32) },
];

export const malformedFrameCiphertextOversized: EncryptedFrameV1 = {
  ordinal: 0,
  kind: "record",
  ciphertext: new Uint8Array(1024 * 1024 + 1),
  aad: new Uint8Array(32),
};

// --- Archive manifest rejections ---

export const malformedArchiveUnknownPath: ArchiveEntry = {
  path: "secret.txt",
  size: 10,
  compressedSize: 10,
  kind: "file",
  isCompressed: false,
};

export const malformedArchiveTraversal: ArchiveEntry = {
  path: "frames/../../../etc/passwd",
  size: 10,
  compressedSize: 10,
  kind: "file",
  isCompressed: false,
};

export const malformedArchiveAbsolute: ArchiveEntry = {
  path: "/etc/passwd",
  size: 10,
  compressedSize: 10,
  kind: "file",
  isCompressed: false,
};

export const malformedArchiveSymlink: ArchiveEntry = {
  path: "frames/0.bin",
  size: 10,
  compressedSize: 10,
  kind: "symlink",
  isCompressed: false,
};

export const malformedArchiveCompressed: ArchiveEntry = {
  path: "frames/0.bin",
  size: 1024,
  compressedSize: 100,
  kind: "file",
  isCompressed: true,
};

export const malformedArchiveCompressionBomb: ArchiveEntry = {
  path: "frames/0.bin",
  size: 256 * 1024 * 1024,
  compressedSize: 1024,
  kind: "file",
  isCompressed: false,
};

export const malformedArchiveEntryOversized: ArchiveEntry = {
  path: "media/avatar.bin",
  size: 256 * 1024 * 1024 + 1,
  compressedSize: 256 * 1024 * 1024 + 1,
  kind: "file",
  isCompressed: false,
};

export const malformedArchiveDuplicate: ArchiveEntry[] = [
  { path: "header.json", size: 1, compressedSize: 1, kind: "file", isCompressed: false },
  { path: "header.json", size: 1, compressedSize: 1, kind: "file", isCompressed: false },
];

// --- Format v2 portable artifact record rejections ---

export const malformedArtifactBadSha = {
  ...validArtifactRecord,
  sha256: "not-a-hex-digest",
};

export const malformedArtifactBadSize = {
  ...validArtifactRecord,
  size: -1,
};

export const malformedArtifactBadLogicalPath = {
  ...validArtifactRecord,
  path: "/etc/passwd",
};

export const malformedArtifactBytesEntryTraversal = {
  ...validArtifactRecord,
  bytesEntry: "media/artifacts/../../etc/passwd.bin",
};

export const malformedArtifactBytesEntryAbsolute = {
  ...validArtifactRecord,
  bytesEntry: "/etc/passwd",
};

export const malformedArtifactBytesEntryBackslash = {
  ...validArtifactRecord,
  bytesEntry: "media\\artifacts\\artifact-001.bin",
};

export const malformedArtifactBytesEntryNoPrefix = {
  ...validArtifactRecord,
  bytesEntry: "frames/0.bin",
};

export const malformedArtifactBytesEntryShortOpaqueId = {
  ...validArtifactRecord,
  bytesEntry: "media/artifacts/short.bin",
};

export const malformedArtifactBytesEntryMissingSuffix = {
  ...validArtifactRecord,
  bytesEntry: "media/artifacts/artifact-001",
};

// --- Format v2 artifact media entry rejections ---

export const malformedMediaEntryBadPath = {
  ...validArtifactMediaManifest.entries[0],
  path: "frames/0.bin",
};

export const malformedMediaEntryBadSha = {
  ...validArtifactMediaManifest.entries[0],
  sha256: "zzz",
};

export const malformedMediaEntryBadSize = {
  ...validArtifactMediaManifest.entries[0],
  size: -5,
};

export const malformedMediaEntryOversized = {
  ...validArtifactMediaManifest.entries[0],
  size: 256 * 1024 * 1024 + 1,
};

// --- Format v2 manifest + payload binding rejections ---

export const malformedArtifactMediaBadVersion = {
  ...validArtifactMediaManifest,
  mediaVersion: 1 as const,
};

export const malformedArtifactMediaDuplicatePath = {
  mediaVersion: 2 as const,
  entries: [
    { path: "media/artifacts/artifact-001.bin", size: 128, sha256: "0".repeat(64) },
    { path: "media/artifacts/artifact-001.bin", size: 128, sha256: "0".repeat(64) },
  ],
};

/** Artifact record present, but no matching media entry. */
export const malformedArtifactMissingMediaEntry: GenieLiveV1 = {
  ...validGenieLiveV1,
  artifactMedia: { mediaVersion: 2, entries: [] },
};

/** Media entry present, but no artifact record references it. */
export const malformedArtifactOrphanMediaEntry: GenieLiveV1 = {
  ...validGenieLiveV1,
  artifactMedia: {
    mediaVersion: 2,
    entries: [
      { path: "media/artifacts/artifact-001.bin", size: 128, sha256: "0".repeat(64) },
      { path: "media/artifacts/orphan-001.bin", size: 10, sha256: "0".repeat(64) },
    ],
  },
};

/** Two artifact records share the same bytesEntry. */
export const malformedArtifactDuplicateBytesEntry: GenieLiveV1 = {
  ...validGenieLiveV1,
  records: [...validGenieLiveV1.records, { ...validArtifactRecord }],
};

/** Media entry size/sha256 disagree with the artifact record. */
export const malformedArtifactMediaMismatch: GenieLiveV1 = {
  ...validGenieLiveV1,
  artifactMedia: {
    mediaVersion: 2,
    entries: [
      { path: "media/artifacts/artifact-001.bin", size: 999, sha256: "f".repeat(64) },
    ],
  },
};

/** v2 artifact records present but no artifactMedia manifest at all. */
export const malformedArtifactNoMediaManifest: GenieLiveV1 = {
  semanticVersion: validGenieLiveV1.semanticVersion,
  bundleId: validGenieLiveV1.bundleId,
  scopes: validGenieLiveV1.scopes,
  records: validGenieLiveV1.records,
};
