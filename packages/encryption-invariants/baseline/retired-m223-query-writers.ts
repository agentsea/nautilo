import type { RetiredFrozenDebt } from "../src/registry";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";

export const RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS = new Set<string>([
  "packages/agent/src/store/memory-store.ts#attachMemoryToNamespaceWithDb:raw_sql:insert:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#detachMemoryFromNamespace:raw_sql:delete:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#hardDeleteMemory:raw_sql:delete:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#updateMemory:raw_sql:delete:public.memory_namespaces:1",
  "packages/db/src/queries/room-journal-state.ts#createRoomJournalStateInTx:raw_sql:insert:public.room_journal_state:1",
  "packages/db/src/utils/profile-migration-memory-primitives.ts#insertPrivateMemoryInTx:raw_sql:insert:public.memories:1",
  "packages/trust/src/read-state.ts#markDelivered:raw_sql:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRead:raw_sql:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRoomRead:raw_sql:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRoomRead:raw_sql:update:public.session_messages:1",
  "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memory_namespaces:1",
]);

const RETIRED_M223_FROZEN_RAW_DATABASE_WRITER_LOCATORS = [
  ...RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS,
].filter((locator) =>
  locator !==
    "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memory_namespaces:1"
);

export const RETIRED_M223_FROZEN_DEBT: readonly RetiredFrozenDebt[] = [
  ...RETIRED_M223_FROZEN_RAW_DATABASE_WRITER_LOCATORS,
].map((locator) => ({
  debtId: rawDatabaseWriterDebtId(locator),
  reason:
    "M223 replaced this raw mutation with a table-qualified Drizzle writer while preserving its transaction, conflict, and bounded-write semantics; the frozen debt row remains as audit history.",
  testEvidence: [
    "packages/encryption-invariants/tests/integration/retired-m223-query-writers.test.ts",
  ],
}));
