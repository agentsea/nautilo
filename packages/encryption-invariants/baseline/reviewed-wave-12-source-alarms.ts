import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_WAVE_12_SOURCE_ALARM_LOCATORS = new Set<string>([
  "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:89b81c36ea23316a:2",
]);

/** Exact source-alarm closure for Wave 12's migration helper and bounded logs. */
export const REVIEWED_WAVE_12_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    {
      locator:
        "packages/db/scripts/finalize-m243-memory-crypto-lifecycle.ts#filesystem_write:38832cb9afa308b1:1",
      owner: "packages/db",
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.wave12.generated-memory-migration-finalizer",
      reason:
        "This schema-development helper writes only deterministic reviewed migration lifecycle DDL after Drizzle generation; it never reads or writes product rows, Memory content, credentials, roots, or key material.",
    },
    {
      locator:
        "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:0ae25e725db4e950:5",
      owner: "packages/runtime",
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.wave12.protected-memory-background-status-log",
      reason:
        "The log interpolates only the closed protected-background lifecycle status returned by the coordinator; it contains no Memory content, query, prompt, identifier, key material, or thrown error text.",
    },
    {
      locator:
        "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:a1436e7c26c240df:3",
      owner: "packages/runtime",
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.wave12.protected-memory-missing-coordinate-log",
      reason:
        "This warning is one fixed literal stating that required coordinates are absent; it interpolates no coordinate, content, query, prompt, error, credential, root, or key material.",
    },
    {
      locator:
        "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:a1436e7c26c240df:4",
      owner: "packages/runtime",
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.wave12.protected-memory-failure-log",
      reason:
        "This warning is one fixed failure literal; the caught exception is deliberately discarded so no Memory content, query, prompt, identifier, error text, credential, root, or key material can enter the log.",
    },
  ];
