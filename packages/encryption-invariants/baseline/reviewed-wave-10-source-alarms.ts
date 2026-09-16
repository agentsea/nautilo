import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/**
 * Exact source-alarm closure for the M241 schema-development finalizer. It
 * rewrites only a freshly generated migration file with deterministic role
 * DDL and never receives product rows, content, credentials, or key material.
 */
export const REVIEWED_WAVE_10_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    {
      locator:
        "packages/db/scripts/finalize-m241-background-authorization.ts#filesystem_write:38832cb9afa308b1:1",
      owner: "packages/db",
      closure: "reviewed_exclusion",
      exclusionId:
        "exclusion.wave10.generated-background-authorization-migration-finalizer",
      reason:
        "This schema-development helper writes only reviewed deterministic migration role DDL after Drizzle generation; it never processes product rows, content, credentials, or key material.",
    },
  ];
