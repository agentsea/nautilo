import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_MAIN_2026_08_13_MERGED_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  "packages/db/scripts/finalize-m257-reflection-records.ts#filesystem_write:9a8b75afe8bfe0f2:1",
  "packages/db/scripts/finalize-m257-reflection-records.ts#filesystem_write:d005bf0747616ddb:1",
].map((locator, index) => ({
  locator,
  owner: "packages/db",
  closure: "reviewed_exclusion" as const,
  exclusionId: `exclusion.main-2026-08-13-merged.reflection-migration-finalizer-${index + 1}`,
  reason:
    "This exact build-time Drizzle migration finalizer writes only generated immutable migration SQL before commit and is not reachable from product runtime data processing.",
}));
