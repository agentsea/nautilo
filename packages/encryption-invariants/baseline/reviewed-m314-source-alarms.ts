import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_M314_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator:
      "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:8",
    owner: "apps/workbench",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.m314.mounted-key-waiting-refresh-error-class",
    reason:
      "The mounted key-waiting refresh diagnostic emits a fixed label plus only Error.name or the JavaScript typeof result. It excludes exception messages and stacks, identifiers, Message content, ciphertext, credentials, and keys.",
  },
  {
    locator:
      "packages/db/scripts/finalize-m314-public-room-message-authority.ts#filesystem_write:df680bf60066c513:1",
    owner: "packages/db",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.m314.generated-migration-finalizer-write",
    reason:
      "This build-time finalizer writes deterministic schema SQL only to the last migration under packages/db/src/migrations when its journal tag names an M314 authority migration and the source is the expected fresh Drizzle custom-migration stub. It does not receive or persist runtime Human content, ciphertext, credentials, or keys.",
  },
  {
    locator:
      "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:10",
    owner: "packages/server",
    closure: "declaration",
    declarationId: "source.m314.rooms-protected-recipient-sync-wakeup",
    reason:
      "This exact post-commit recipient-sync wake-up warning remains on Nautilo's reviewed plaintext diagnostic boundary. It emits the Room identifier and an arbitrary caught error message or string after canonical membership has committed, while protected recipient-state convergence remains recoverable on later Room access or retry; this declaration does not classify either dynamic value as encrypted or content-free.",
  },
];
