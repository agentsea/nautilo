import { describe, expect, test } from "bun:test";
import * as schema from "@nautilo/db/schema";
import { resolve } from "node:path";

import {
  discoverDatabaseWriterInventory,
  type DatabaseWriterObservation,
} from "../../src/node/database-writer-inventory";
import { inventoryMigrationTree } from "../../src/node/migration-inventory";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");

const addedWriters = [
  "update|public.room_journal_batches|packages/db/src/queries/room-journal-recovery.ts#rebindRoomJournalFailedBatchServiceModel:update:public.room_journal_batches:1",
  "update|public.room_journal_state|packages/db/src/queries/room-journal-recovery.ts#rebindRoomJournalFailedBatchServiceModel:update:public.room_journal_state:1",
  "insert|public.room_journal_state|packages/db/src/queries/room-journal-recovery.ts#requestRoomJournalRebuildInTx:insert:public.room_journal_state:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-derived-record-lineage-repair.ts#repairBlockedDerivedRecordLineage:update:public.reflection_record_semantic_work:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#consumeManualProviderAttempt:update:public.reflection_record_semantic_work:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#defer:update:public.reflection_record_semantic_work:2",
  "insert|public.reflection_record_dependency_change_repairs|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#repairMissingTerminalStructuralDependency:insert:public.reflection_record_dependency_change_repairs:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#requestManualProviderRecovery:update:public.reflection_record_semantic_work:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#requestManualProviderRecovery:update:public.reflection_record_semantic_work:2",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#saveOrganizerProposalCheckpoints:update:public.reflection_record_semantic_work:1",
  "update|public.room_journal_model_recoveries|packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:update:public.room_journal_model_recoveries:1",
  "update|public.room_journal_state|packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:update:public.room_journal_state:5",
  "update|public.room_journal_batches|packages/runtime/src/stenographer/repository.ts#tryClaimRoom:update:public.room_journal_batches:2",
  "update|public.room_journal_model_recoveries|packages/runtime/src/stenographer/repository.ts#tryClaimRoom:update:public.room_journal_model_recoveries:1",
  "insert|public.memory_recovery_runs|packages/server/src/lib/manual-memory-recovery.ts#request:insert:public.memory_recovery_runs:1",
  "update|public.memory_recovery_runs|packages/server/src/lib/manual-memory-recovery.ts#request:update:public.memory_recovery_runs:1",
  "update|public.reflection_record_semantic_work|packages/server/src/lib/memory-recovery-service.ts#recoverReflectionFamily:update:public.reflection_record_semantic_work:1",
  "insert|public.room_journal_model_recoveries|packages/server/src/lib/request-manual-journal-recovery.ts#queueCandidate:insert:public.room_journal_model_recoveries:1",
  "insert|public.memory_review_model_recoveries|packages/server/src/lib/request-manual-review-recovery.ts#requestManualReviewRecovery:insert:public.memory_review_model_recoveries:1",
  "update|public.memory_review_model_recoveries|packages/server/src/lib/request-manual-review-recovery.ts#requestManualReviewRecovery:update:public.memory_review_model_recoveries:1",
  "update|public.memory_review_turns|packages/server/src/lib/request-manual-review-recovery.ts#requestManualReviewRecovery:update:public.memory_review_turns:1",
  "update|public.room_journal_model_recoveries|packages/server/src/lib/stenographer-memory-funding.ts#admit:update:public.room_journal_model_recoveries:1",
] as const;

const removedWriters: readonly DatabaseWriterObservation[] = [
  {
    operation: "update",
    table: "public.memory_review_turns",
    path: "packages/runtime/src/memory-review/repository.ts",
    symbol: "claimNext",
    locator: "packages/runtime/src/memory-review/repository.ts#claimNext:update:public.memory_review_turns:3",
  },
  {
    operation: "insert",
    table: "public.room_journal_state",
    path: "packages/trust/src/canonical-transcript-mutations.ts",
    symbol: "editCanonicalTranscriptMessageInTx",
    locator: "packages/trust/src/canonical-transcript-mutations.ts#editCanonicalTranscriptMessageInTx:insert:public.room_journal_state:1",
  },
] as const;

describe("reviewed Journal and Memory recovery inventory", () => {
  test("pins only three appended generated migrations and snapshots", () => {
    const inventory = inventoryMigrationTree(resolve(repoRoot, "packages/db/src/migrations"));
    expect(inventory.migrations.filter(item => item.index >= 392 && item.index <= 394)).toEqual([
      { index: 392, tag: "0392_flaky_spencer_smythe", path: "0392_flaky_spencer_smythe.sql", sha256: "22ffc8f0d9fc59c6c63386f395b240dd874d75c90f6f0adb783ee03e7427de56" },
      { index: 393, tag: "0393_past_shocker", path: "0393_past_shocker.sql", sha256: "4129a4432c0e224827f8034921544dbc9faff127ebfbf676646c2f80e2b60007" },
      { index: 394, tag: "0394_absurd_young_avengers", path: "0394_absurd_young_avengers.sql", sha256: "978a13f89a637a05ea1fbb05f83085c11038b5dbc7a6c88d327454bcce13574a" },
    ]);
    expect(inventory.snapshots.filter(item => item.index >= 392 && item.index <= 394)).toEqual([
      { index: 392, path: "meta/0392_snapshot.json", sha256: "bd63f34c95e159046995803accace3ecf48562cac8b249df0d1785fb17f71b50" },
      { index: 393, path: "meta/0393_snapshot.json", sha256: "b4380617cd8bf32d402094a405c73e93400769fc7d12e078db0a6c2b1e12ac50" },
      { index: 394, path: "meta/0394_snapshot.json", sha256: "2ea9817face611550bdde19128dcc6535f8c3e62c97c67ab0d29331f3b3f7383" },
    ]);
  });

  test("recognizes the reviewed recovery writes and excludes their obsolete predecessors", async () => {
    const tableExports = Object.fromEntries(
      inventoryDrizzleSchema(schema).objects
        .filter((object) => object.kind === "table")
        .flatMap((object) => object.exportNames.map((name) => [name, object.locator])),
    );
    const current = await discoverDatabaseWriterInventory(repoRoot, tableExports);
    for (const item of addedWriters) {
      const [operation, table, locator] = item.split("|");
      expect(current.some((candidate) =>
        candidate.operation === operation
        && candidate.table === table
        && candidate.locator === locator
      )).toBe(true);
    }
    for (const removed of removedWriters) expect(current).not.toContainEqual(removed);

  });
});
