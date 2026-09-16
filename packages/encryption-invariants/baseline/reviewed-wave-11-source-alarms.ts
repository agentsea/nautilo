import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/**
 * Exact source-alarm closure for the M244 schema-development finalizer. It
 * rewrites only a freshly generated migration with deterministic role DDL and
 * never receives product rows, content, credentials, roots, or key material.
 */
export const REVIEWED_WAVE_11_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    {
      locator:
        "packages/db/scripts/finalize-m244-background-authority-sets.ts#filesystem_write:38832cb9afa308b1:1",
      owner: "packages/db",
      closure: "reviewed_exclusion",
      exclusionId:
        "exclusion.wave11.generated-background-authority-migration-finalizer",
      reason:
        "This schema-development helper writes only reviewed deterministic migration role DDL after Drizzle generation; it never processes product rows, content, credentials, roots, or key material.",
    },
  ];
