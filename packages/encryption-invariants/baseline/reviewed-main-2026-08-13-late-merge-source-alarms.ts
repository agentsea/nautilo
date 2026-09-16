import type { SourceAlarmReview } from "../src/node/source-alarm-review";

const finalizer = (
  locator: string,
  suffix: string,
): SourceAlarmReview => ({
  locator,
  owner: "packages/db",
  closure: "reviewed_exclusion",
  exclusionId: `exclusion.main-2026-08-13-late-merge.${suffix}`,
  reason:
    "This exact build-time Drizzle finalizer writes only deterministic immutable migration SQL before commit and is not reachable from product runtime data processing.",
});

const encryptedBlobWrite = (
  locator: string,
  suffix: string,
  reason: string,
): SourceAlarmReview => ({
  locator,
  owner: "packages/lattice-bridge",
  closure: "declaration",
  declarationId: `source.main-2026-08-13-late-merge.file.${suffix}`,
  reason,
});

export const REVIEWED_MAIN_2026_08_13_LATE_MERGE_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  finalizer(
    "packages/db/scripts/finalize-m258-reflection-authority.ts#filesystem_write:9a8b75afe8bfe0f2:1",
    "reflection-authority-migration-finalizer",
  ),
  finalizer(
    "packages/db/scripts/finalize-m261-artifact-crypto-lifecycle.ts#filesystem_write:3dcc6339408547a4:1",
    "artifact-crypto-migration-finalizer",
  ),
  encryptedBlobWrite(
    "packages/lattice-bridge/src/artifact/filesystem-blob-store.ts#filesystem_write:444d2b374eaf45d6:1",
    "encrypted-artifact-blob",
    "This write persists only the authenticated encrypted Artifact blob bytes at a repository-confined opaque storage reference; plaintext and keys never cross this file boundary.",
  ),
  encryptedBlobWrite(
    "packages/lattice-bridge/src/artifact/filesystem-blob-store.ts#filesystem_write:bfd3ca1ddb670908:1",
    "encrypted-artifact-blob-atomic-rename",
    "This filesystem operation atomically publishes an already-written authenticated encrypted Artifact blob and introduces no plaintext or key material.",
  ),
  encryptedBlobWrite(
    "packages/lattice-bridge/src/artifact/filesystem-blob-store.ts#filesystem_write:ca701904b80d822f:1",
    "encrypted-artifact-blob-temporary",
    "This temporary write contains only the authenticated encrypted Artifact blob bytes before an atomic rename; plaintext and keys never cross this file boundary.",
  ),
];
