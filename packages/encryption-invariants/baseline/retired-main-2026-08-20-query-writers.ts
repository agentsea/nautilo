import type { RetiredFrozenDebt } from "../src/registry";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";

export const RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS =
  new Set<string>([
    "packages/db/src/queries/llm-usage.ts#rows:raw_sql:unresolved:unresolved.dynamic_sql:1",
    "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:1",
    "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:2",
    "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:3",
    "packages/runtime/src/stenographer/repository.ts#tryClaimRoom:raw_sql:unresolved:unresolved.dynamic_sql:1",
  ]);

export const RETIRED_MAIN_2026_08_20_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] =
  [...RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS].map((locator) => ({
    debtId: rawDatabaseWriterDebtId(locator),
    reason:
      "The current typed-query implementation no longer contains this unresolved raw-SQL scanner site; the frozen declaration remains only as immutable audit history.",
    testEvidence: [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-20-security.test.ts",
    ],
  }));
