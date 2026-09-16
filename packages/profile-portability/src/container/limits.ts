/**
 * Bounded structural limits for the container. These are contract-level
 * rejection bounds, enforced by validators before any source/target
 * mutation. They are deliberately conservative; production streaming
 * transport (Wave 1A+) may refine per-frame chunking but must not exceed the
 * frame-count / payload ceilings declared here without bumping the container
 * version.
 */

export const LIMITS = {
  chunkSize: { min: 64, max: 1024 * 1024 }, // bytes per frame ciphertext chunk
  maxFrameCount: 1_000_000,
  maxFrameCiphertextBytes: 1024 * 1024, // 1 MiB per frame
  maxTotalPayloadBytes: 1024 * 1024 * 1024, // 1 GiB total payload
  minKeySlots: 1,
  maxKeySlots: 4,
  bundleIdMaxLength: 128,
  bundleIdMinLength: 8,
  // Archive (bundle-as-archive) manifest rejection bounds.
  maxArchiveEntryBytes: 256 * 1024 * 1024, // 256 MiB per entry
  maxArchiveTotalBytes: 1024 * 1024 * 1024, // 1 GiB total archive
  // uncompressed/compressed ratio above which an entry is a compression bomb.
  // Compression is disallowed outright; this is a secondary defense for
  // malformed/malicious entries that claim a tiny compressed size.
  compressionBombRatio: 100,
} as const;

