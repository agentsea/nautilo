import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_MAIN_2026_08_14_M267_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    {
      locator:
        "packages/db/scripts/finalize-m267-stenographer-record-cutover.ts#filesystem_write:3dcc6339408547a4:1",
      owner: "packages/db",
      closure: "reviewed_exclusion",
      exclusionId:
        "exclusion.main-2026-08-14.m267-stenographer-record-cutover-finalizer",
      reason:
        "This exact build-time Drizzle finalizer writes only deterministic immutable migration SQL before commit and is not reachable from product runtime data processing.",
    },
  ];
