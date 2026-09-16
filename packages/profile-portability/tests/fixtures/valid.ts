/**
 * Golden valid fixtures for the Wave 0 contract. These are structural shapes
 * that MUST pass every validator. Keep them dependency-free and deterministic.
 */

import type { GenieLiveV1_0, GenieLiveV1_1, PortableArtifact, ArtifactMediaManifest } from "../../src/semantic/types";
import type { ContainerHeaderV1, EncryptedFrameV1, TerminalManifestV1, ArchiveEntry } from "../../src/container/types";
import type { RecoverySlot } from "../../src/key-slots/types";
import { canonicalJsonBytes } from "../../src/canonical";
import { computeRecordHash, computeSemanticRoot } from "../../src/canonical";

export const validGenieLiveV1: GenieLiveV1_1 = {
  semanticVersion: { major: 1, minor: 1 },
  bundleId: "source-genie-001",
  scopes: ["profile", "avatar", "privateMemories"],
  records: [
    { recordKind: "identity", name: "Aria", handleIntent: "aria" },
    { recordKind: "soul", text: "A calm, precise assistant." },
    { recordKind: "personality", text: "Warm but concise." },
    {
      recordKind: "voices",
      voices: [
        { voiceId: "v1", label: "Default", provider: "eleven", voiceUri: null },
      ],
    },
    {
      recordKind: "modelPolicy",
      policy: { primaryModel: "gpt-5", fallbackModel: "gpt-4o", temperature: 0.4 },
    },
    {
      recordKind: "avatar",
      avatar: {
        mediaEntry: "media/avatar.bin",
        mimeType: "image/png",
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        width: 512,
        height: 512,
      },
    },
    {
      recordKind: "preferences",
      preferences: { theme: "dark", notifications: true, volume: 0.8 },
    },
    {
      recordKind: "memory",
      scope: "private",
      type: "general",
      content: "User prefers terse answers on weekdays.",
      createdAt: "2026-07-14T10:00:00Z",
    },
    {
      recordKind: "artifact",
      path: "notes/release-plan.md",
      mimeType: "text/markdown",
      size: 128,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      bytesEntry: "media/artifacts/artifact-001.bin",
    },
  ],
  artifactMedia: {
    mediaVersion: 2,
    entries: [
      {
        path: "media/artifacts/artifact-001.bin",
        size: 128,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    ],
  },
};

/** Standalone valid format v2 artifact record + matching media manifest. */
export const validArtifactRecord: PortableArtifact = {
  recordKind: "artifact",
  path: "notes/release-plan.md",
  mimeType: "text/markdown",
  size: 128,
  sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  bytesEntry: "media/artifacts/artifact-001.bin",
};

export const validArtifactMediaManifest: ArtifactMediaManifest = {
  mediaVersion: 2,
  entries: [
    {
      path: "media/artifacts/artifact-001.bin",
      size: 128,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  ],
};

/**
 * v1 (avatar-only) bundle: no `PortableArtifact` records and no
 * `artifactMedia` manifest. A format v2 reader MUST still accept this
 * unchanged — v1 read compatibility is a hard contract invariant.
 */
export const v1AvatarOnlyBundle: GenieLiveV1_0 = {
  semanticVersion: { major: 1, minor: 0 },
  bundleId: "source-genie-001",
  scopes: ["profile", "avatar", "privateMemories"],
  records: [
    { recordKind: "identity", name: "Aria", handleIntent: "aria" },
    { recordKind: "soul", text: "A calm, precise assistant." },
    {
      recordKind: "avatar",
      avatar: {
        mediaEntry: "media/avatar.bin",
        mimeType: "image/png",
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        width: 512,
        height: 512,
      },
    },
  ],
};

/** Explicit semantic v1.0 Memory fixture: absence of `type` is legacy state. */
export const v1LegacyMemoryBundle: GenieLiveV1_0 = {
  semanticVersion: { major: 1, minor: 0 },
  bundleId: "legacy-memory-001",
  scopes: ["privateMemories"],
  records: [{
    recordKind: "memory",
    scope: "private",
    content: "Legacy private content",
    createdAt: null,
  }],
};

export const validRecoverySlot: RecoverySlot = {
  kind: "recovery",
  slotId: 0,
  kdf: "argon2id",
  kdfParams: { memoryCostKiB: 19456, timeCost: 2, parallelism: 1, outputLength: 32 },
  salt: new Uint8Array(16),
  wrappedDek: new Uint8Array(48),
  aad: new Uint8Array(32),
};

export const validContainerHeaderV1: ContainerHeaderV1 = {
  containerVersion: 1,
  semanticVersion: { major: 1, minor: 1 },
  bundleId: "source-genie-001",
  payloadCodec: "genie-live-records",
  protectionSuite: "xchacha20poly1305-framed-v1",
  chunkSize: 64 * 1024,
  keySlots: [validRecoverySlot],
  frameCount: 2,
  totalPayloadBytes: 1024,
};

/**
 * Build a valid frame sequence + matching terminal manifest for the records in
 * `validGenieLiveV1`. Ciphertext/aad are opaque placeholder bytes (Wave 0 does
 * not perform AEAD); the manifest's per-record hashes and semantic root are
 * computed canonically so `verifySemanticRoot` passes.
 */
export function buildValidFramesAndManifest(): {
  frames: EncryptedFrameV1[];
  manifest: TerminalManifestV1;
} {
  const records = validGenieLiveV1.records;
  const manifestRecords = records.map((rec, i) => ({
    recordKind: rec.recordKind,
    frameOrdinal: i,
    sha256: computeRecordHash(rec),
    bytes: canonicalJsonBytes(rec).length,
  }));
  const semanticRoot = computeSemanticRoot(manifestRecords.map((m) => m.sha256));
  const frames: EncryptedFrameV1[] = records.map((_rec, i) => ({
    ordinal: i,
    kind: "record",
    ciphertext: new Uint8Array(16).fill(0xa5 + i),
    aad: new Uint8Array(32).fill(0x01),
  }));
  frames.push({
    ordinal: records.length,
    kind: "terminal-manifest",
    ciphertext: new Uint8Array(16).fill(0xff),
    aad: new Uint8Array(32).fill(0x02),
  });
  const manifest: TerminalManifestV1 = {
    semanticRoot,
    records: manifestRecords,
    frameCount: frames.length,
    totalPayloadBytes: 1024,
  };
  return { frames, manifest };
}

export const validArchiveEntries: ArchiveEntry[] = [
  { path: "header.json", size: 256, compressedSize: 256, kind: "file", isCompressed: false },
  { path: "manifest.json", size: 512, compressedSize: 512, kind: "file", isCompressed: false },
  { path: "frames/0.bin", size: 1024, compressedSize: 1024, kind: "file", isCompressed: false },
  { path: "frames/1.bin", size: 1024, compressedSize: 1024, kind: "file", isCompressed: false },
  { path: "media/avatar.bin", size: 4096, compressedSize: 4096, kind: "file", isCompressed: false },
  { path: "media/artifacts/artifact-001.bin", size: 128, compressedSize: 128, kind: "file", isCompressed: false },
];

// Reference SHA-256 vectors used to prove the in-repo digest is correct.
export const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
