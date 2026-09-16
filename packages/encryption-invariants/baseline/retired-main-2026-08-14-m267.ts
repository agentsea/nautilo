import type { RetiredFrozenDebt } from "../src/registry";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";

export const RETIRED_MAIN_2026_08_14_M267_RAW_DATABASE_WRITER_LOCATORS =
  new Set<string>([
    "packages/runtime/src/stenographer/repository.ts#applyEventPlan:raw_sql:insert:public.room_events:1",
    "packages/runtime/src/stenographer/repository.ts#applyEventPlan:raw_sql:update:public.room_events:1",
    "packages/runtime/src/stenographer/repository.ts#publishExtraction:raw_sql:update:public.room_journal_batches:1",
    "packages/runtime/src/stenographer/repository.ts#publishExtraction:raw_sql:update:public.room_journal_state:1",
  ]);

export const RETIRED_MAIN_2026_08_14_M267_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] = [
    ...RETIRED_MAIN_2026_08_14_M267_RAW_DATABASE_WRITER_LOCATORS,
  ].map((locator) => ({
    debtId: rawDatabaseWriterDebtId(locator),
    reason:
      "M267 removed this legacy Runtime Stenographer writer after native Record publication moved to the Reflection bridge; the frozen Wave 0 debt row remains as audit history.",
    testEvidence: [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-14-m267-security.test.ts",
    ],
  }));
