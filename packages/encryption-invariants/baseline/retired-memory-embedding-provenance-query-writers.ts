import type { RetiredFrozenDebt } from "../src/registry";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";

export const RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS =
  new Set<string>([
    "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memories:1",
    "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:raw_sql:insert:public.memories:1",
    "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:raw_sql:update:public.memories:1",
    "packages/agent/src/store/memory-store.ts#updateMemory:raw_sql:update:public.memories:1",
    "packages/agent/src/store/scope-memory-store.ts#updateScopeMemory:raw_sql:update:public.memories:1",
  ]);

const RETIRED_FROZEN_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS = [
  ...RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS,
].filter((locator) =>
  locator !==
    "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memories:1"
);

export const RETIRED_MEMORY_EMBEDDING_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] =
  RETIRED_FROZEN_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS.map(
    (locator) => ({
      debtId: rawDatabaseWriterDebtId(locator),
      reason:
        "The Memory embedding provenance change replaced this raw mutation with a table-qualified Drizzle writer while preserving its transaction and authority boundary; the frozen debt row remains only as immutable audit history.",
      testEvidence: [
        "packages/encryption-invariants/tests/integration/retired-memory-embedding-provenance-query-writers.test.ts",
      ],
    }),
  );
