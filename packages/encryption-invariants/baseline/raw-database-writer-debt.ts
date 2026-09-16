import type { EncryptionBaselineDebt } from "../src/model";
import { RETIRED_LANDING_RAW_LOCATORS } from "./reviewed-main-2026-09-05-landing-coverage";
import { RETIRED_M320_RAW_DATABASE_WRITER_LOCATORS } from "./reviewed-m320-coverage";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";
import {
  RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS,
} from "./reviewed-main-2026-08-14-landing";
import {
  RETIRED_MAIN_2026_08_14_M267_RAW_DATABASE_WRITER_LOCATORS,
} from "./retired-main-2026-08-14-m267";
import { RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS } from "./retired-m223-query-writers";
import { RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS } from "./retired-memory-embedding-provenance-query-writers";
import {
  RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS,
} from "./retired-main-2026-08-20-query-writers";
import {
  RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS,
} from "./reviewed-main-2026-08-21-coverage";

function ownerForLocator(locator: string): string {
  const [first = "", second = ""] = locator.split("/");
  return `${first}/${second}`;
}

/**
 * Exact Wave 0 declaration of production raw-SQL mutation chokepoints.
 *
 * Unlike ordinary Drizzle writers, these sites bypass table-qualified query
 * builders. Every site therefore carries an explicit owning package and
 * remains baseline debt until a later encryption wave either removes the raw
 * writer or adds boundary-specific encrypted persistence evidence.
 */
const WAVE_0_RAW_DATABASE_WRITER_LOCATORS = [
  "bin/nautilo-dev/src/commands/cleanup-test-cruft.ts#cleanupTestCruft:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "bin/nautilo-dev/src/commands/mark-all-messages-read.ts#markAllMessagesRead:raw_sql:insert:public.session_message_recipient_state:1",
  "bin/nautilo-dev/src/commands/mark-all-messages-read.ts#markAllMessagesRead:raw_sql:update:public.session_messages:1",
  "bin/nautilo-dev/src/commands/migrate-add-agent-role.ts#migrateAddAgentRole:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "bin/nautilo-dev/src/commands/migrate-add-agent-role.ts#migrateAddAgentRole:raw_sql:unresolved:unresolved.dynamic_sql:2",
  "bin/nautilo-dev/src/commands/migrate-add-agent-role.ts#probeAppRoleState:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "bin/nautilo-dev/src/commands/migrate-add-agent-role.ts#probeAppRoleState:raw_sql:unresolved:unresolved.dynamic_sql:2",
  "bin/nautilo-dev/src/commands/migrate-to-username-identity.ts#deleteLogtoOneTimeTokensFromCluster:raw_sql:delete:unresolved.one_time_tokens:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:delete:public.agent_scopes:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:delete:public.channel_identities:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:delete:public.credentials:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:delete:public.group_members:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:delete:public.room_members:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:delete:public.room_members:2",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:delete:public.sessions:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:update:public.rooms:1",
  "bin/nautilo-dev/src/commands/repair-orphan-default-agent.ts#repairOrphanDefaultAgent:raw_sql:update:public.rooms:2",
  "bin/nautilo-dev/src/lib/docker-db.ts#rebindRestoredInstanceIdentity:raw_sql:insert:public.nautilo_instance_identity:1",
  "bin/nautilo-dev/src/lib/restore-migrations.ts#insertCredentialRemapped:raw_sql:insert:public.credentials:1",
  "bin/nautilo-dev/src/lib/restore-migrations.ts#insertGroupMemberWithNullableGrantor:raw_sql:insert:public.group_members:1",
  "bin/nautilo-dev/src/lib/restore-migrations.ts#insertRecoveryCodeRemapped:raw_sql:insert:public.recovery_codes:1",
  "deploy/compose-driver/src/ComposeDriver.ts#restore:raw_sql:delete:public.nautilo_instance_identity:1",
  "deploy/compose-driver/src/ComposeDriver.ts#restoreRemoteBundle:raw_sql:delete:public.nautilo_instance_identity:1",
  "packages/agent/src/store/memory-store.ts#attachMemoryToNamespaceWithDb:raw_sql:insert:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#detachMemoryFromNamespace:raw_sql:delete:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#hardDeleteMemory:raw_sql:delete:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#replaceMemory:raw_sql:update:public.memories:1",
  "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:raw_sql:insert:public.memories:1",
  "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:raw_sql:update:public.memories:1",
  "packages/agent/src/store/memory-store.ts#updateMemory:raw_sql:delete:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#updateMemory:raw_sql:update:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#replaceScopeMemory:raw_sql:update:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#saveScopeMemory:raw_sql:insert:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#saveScopeMemory:raw_sql:update:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#updateScopeMemory:raw_sql:update:public.memories:1",
  "packages/db/src/queries/room-journal-state.ts#createRoomJournalStateInTx:raw_sql:insert:public.room_journal_state:1",
  "packages/db/src/queries/room-journal-state.ts#reconcileRoomJournalMembershipInTx:raw_sql:insert:public.room_journal_state:1",
  "packages/db/src/queries/room-journal-state.ts#reconcileRoomJournalMembershipInTx:raw_sql:update:public.room_journal_state:1",
  "packages/db/scripts/repair-merge-main-drizzle-state.mjs#main:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "packages/db/scripts/repair-merge-main-drizzle-state.mjs#main:raw_sql:unresolved:unresolved.dynamic_sql:2",
  "packages/db/scripts/repair-merge-main-drizzle-state.mjs#main:raw_sql:unresolved:unresolved.dynamic_sql:3",
  "packages/db/src/queries/llm-usage.ts#rows:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "packages/db/src/utils/profile-migration-memory-primitives.ts#insertPrivateMemoryInTx:raw_sql:insert:public.memories:1",
  "packages/db/src/utils/seed-default-room.ts#seedDefaultRoom:raw_sql:insert:public.memory_namespaces:1",
  "packages/runtime/src/stenographer/repository.ts#applyEventPlan:raw_sql:insert:public.room_events:1",
  "packages/runtime/src/stenographer/repository.ts#applyEventPlan:raw_sql:update:public.room_events:1",
  "packages/runtime/src/stenographer/repository.ts#failCompaction:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#failExtraction:raw_sql:update:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/repository.ts#failExtraction:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#initializeHistoricalBackfills:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#publishCompaction:raw_sql:insert:public.room_event_rollups:1",
  "packages/runtime/src/stenographer/repository.ts#publishCompaction:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#publishExtraction:raw_sql:update:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/repository.ts#publishExtraction:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:raw_sql:update:public.room_journal_state:2",
  "packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:raw_sql:update:public.room_journal_state:3",
  "packages/runtime/src/stenographer/repository.ts#tryClaimRoom:raw_sql:insert:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/repository.ts#tryClaimRoom:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:2",
  "packages/runtime/src/conductor/history-search.ts#subthreadContextWindow:raw_sql:unresolved:unresolved.dynamic_sql:3",
  "packages/runtime/src/stenographer/repository.ts#tryClaimRoom:raw_sql:unresolved:unresolved.dynamic_sql:1",
  "packages/trust/src/read-state.ts#markDelivered:raw_sql:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRead:raw_sql:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRoomRead:raw_sql:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRoomRead:raw_sql:update:public.session_messages:1",
] as const;

const REVIEWED_WAVE_4_RAW_DATABASE_WRITER_LOCATORS = [
  "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memories:1",
  "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memories:1",
  "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memory_namespaces:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:delete:public.room_event_rollups:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:delete:public.room_events:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:delete:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:update:public.room_journal_state:2",
] as const;

function baselineDebtForRawLocator(
  locator: string,
): EncryptionBaselineDebt {
    const unresolved = locator.includes(":raw_sql:unresolved:");
    return {
      id: rawDatabaseWriterDebtId(locator),
      surface: "db",
      locator,
      owner: ownerForLocator(locator),
      reason: unresolved
        ? `${locator} is a database raw-SQL transport whose dynamic input cannot `
          + "be statically reduced to a proven read-only statement."
        : `${locator} is a raw SQL mutation that bypasses the table-qualified `
          + "Drizzle writer surface and remains untriaged for encryption.",
      remediationState: "untriaged",
      releaseImpact: "blocks_whole_product_claim",
      evidenceGap: unresolved
        ? `${locator} lacks a local static SQL value proving its operation, table, `
          + "and encryption boundary."
        : `${locator} has no implemented ciphertext repository bridge or negative `
          + "plaintext-write evidence.",
    };
}

export const WAVE_0_RAW_DATABASE_WRITER_DEBT:
  readonly EncryptionBaselineDebt[] =
  WAVE_0_RAW_DATABASE_WRITER_LOCATORS.map(baselineDebtForRawLocator);

const REVIEWED_WAVE_4_RAW_DATABASE_WRITER_DEBT:
  readonly EncryptionBaselineDebt[] =
  REVIEWED_WAVE_4_RAW_DATABASE_WRITER_LOCATORS.map((locator) => ({
    id: rawDatabaseWriterDebtId(locator),
    surface: "db",
    locator,
    owner: ownerForLocator(locator),
    reason:
      `${locator} atomically writes Memory plaintext and its Namespace edge; `
      + "the raw chokepoint remains blocked until the Memory encryption wave.",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    evidenceGap:
      `${locator} has no implemented ciphertext repository bridge or negative `
      + "plaintext-write evidence.",
  }));

export const RAW_DATABASE_WRITER_DEBT: readonly EncryptionBaselineDebt[] = [
  ...WAVE_0_RAW_DATABASE_WRITER_DEBT.filter((entry) =>
    !RETIRED_LANDING_RAW_LOCATORS.has(entry.locator) &&
    !RETIRED_M320_RAW_DATABASE_WRITER_LOCATORS.has(entry.locator) &&
    !RETIRED_MAIN_2026_08_14_M267_RAW_DATABASE_WRITER_LOCATORS.has(
      entry.locator,
    ) && !RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS.has(entry.locator)
      && !RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS.has(entry.locator)
      && !RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS.has(
        entry.locator,
      )
      && !RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS.has(
        entry.locator,
      )
  ),
  ...REVIEWED_WAVE_4_RAW_DATABASE_WRITER_DEBT.filter((entry) =>
    !RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS.has(
      entry.locator,
    ) && !RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS.has(entry.locator)
      && !RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS.has(entry.locator)
      && !RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS.has(
        entry.locator,
      )
      && !RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS.has(
        entry.locator,
      )
  ),
];
