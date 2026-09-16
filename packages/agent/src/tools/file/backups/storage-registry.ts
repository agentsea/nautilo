import type { StorageProvider, StorageZones } from "@nautilo/config";

/**
 * D087 Phase 2A — backup blob storage registry.
 *
 * The cold lane stores pre-bytes as content-addressed blobs via a
 * `StorageProvider`. The `data` zone is the right home for these
 * because:
 *
 *   - It is server-internal (never agent-accessible through the
 *     artifact registry, which exposes only `home` + `scratch`).
 *   - It already has the same per-deployment encryption boundary we'll
 *     extend in M2 (see v8 §9.1 key-isolation design).
 *   - The `data` provider maps 1:1 onto the future `S3StorageProvider`
 *     for SaaS deployments, so nothing about this wiring needs to
 *     change when cloud mode lands — we just swap the provider impl
 *     behind the same interface.
 *
 * Blobs land under the relative path
 *
 *     backups/blobs/sha256/<xx>/<sha256>
 *
 * where `<xx>` is the first two hex chars of the sha256 (classical
 * 256-way fan-out to keep any single directory from ballooning past
 * filesystem-manageable cardinality). `recordRevision` + `restore` +
 * the GC sweep all go through this module to read/write/unlink blobs;
 * no direct `fs` touches.
 *
 * Mirrors the pattern already established by
 * `packages/agent/src/tools/artifacts/storage-registry.ts` — module-
 * level singleton installed at server boot via
 * `setBackupStorage(storageZones)`, reset via `resetBackupStorage()`
 * in test teardown.
 */

let _dataStore: StorageProvider | null = null;

/**
 * Install the backup blob provider. Called once at server boot from
 * `@nautilo/server`'s `app.ts` right after `createStorageZones(paths)`.
 *
 * Accepts the full `StorageZones` bundle (rather than just the `data`
 * provider) to keep a symmetric shape with `setArtifactStorage` and to
 * leave room for future multi-zone backup routing (e.g. encrypted
 * secrets pulling from `vault` instead).
 */
export function setBackupStorage(zones: StorageZones): void {
  _dataStore = zones.data;
}

/**
 * Clear the registry. Intended for test teardown so suites that spin
 * up temp storage don't leak state into the next suite.
 */
export function resetBackupStorage(): void {
  _dataStore = null;
}

/**
 * Look up the backup blob provider. Returns `null` if the registry
 * hasn't been installed yet, which the caller treats as "backup
 * subsystem not wired" — typically a test fixture or a partial boot;
 * the caller logs a warning and returns a no-op revision (FS write
 * still lands; just no undo record). Never throws.
 */
export function getBackupStorage(): StorageProvider | null {
  return _dataStore;
}

/**
 * Hex-sha256 validator. Sha256 output is exactly 64 lowercase hex
 * chars. Exported so tests + the blob-GC sweep can share the same
 * rule for filtering non-blob debris under `backups/blobs/sha256/`.
 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export function isSha256Hex(s: string): boolean {
  return SHA256_HEX_RE.test(s);
}

/**
 * Two-hex-char fan-bucket validator. Separate helper so the GC sweep
 * can fast-reject non-hex entries before attempting a delete on
 * garbage (e.g. `.DS_Store`).
 */
const HEX2_RE = /^[0-9a-f]{2}$/;
export function isHex2(s: string): boolean {
  return HEX2_RE.test(s);
}

/**
 * Compute the canonical relative path for a content-addressed blob.
 * Exported so tests and GC code derive the same path as the writer
 * without re-implementing the rule.
 *
 * Enforces sha256-hex format defensively: callers are expected to
 * pass the output of `sha256Hex()` (64 lowercase hex chars), so any
 * other shape indicates a bug (or, worse, a prompt-injection attempt
 * to control the blob path). Throw rather than silently produce a
 * weird path — the StorageProvider would likely catch it downstream
 * via `StoragePathTraversalError`, but a clear error at this layer
 * points operators at the actual bug.
 */
export function blobRelPathFor(sha256: string): string {
  if (!isSha256Hex(sha256)) {
    throw new Error(
      `[backups] blob sha256 must be 64 lowercase hex chars; ` +
        `got length ${sha256.length} (first 16 = ${JSON.stringify(sha256.slice(0, 16))})`,
    );
  }
  return `backups/blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}
