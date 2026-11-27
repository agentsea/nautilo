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
  "update|public.room_journal_state|packages/db/src/queries/room-journal-recovery.ts#rebindRoomJournalFailedCompactionServiceModel:update:public.room_journal_state:1",
  "insert|public.room_journal_state|packages/db/src/queries/room-journal-recovery.ts#requestRoomJournalRebuildInTx:insert:public.room_journal_state:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-derived-record-lineage-repair.ts#repairBlockedDerivedRecordLineage:update:public.reflection_record_semantic_work:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#consumeManualProviderAttempt:update:public.reflection_record_semantic_work:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#defer:update:public.reflection_record_semantic_work:2",
  "insert|public.reflection_record_dependency_change_repairs|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#repairMissingTerminalStructuralDependency:insert:public.reflection_record_dependency_change_repairs:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#requestManualProviderRecovery:update:public.reflection_record_semantic_work:1",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#requestManualProviderRecovery:update:public.reflection_record_semantic_work:2",
  "update|public.reflection_record_semantic_work|packages/reflection-bridge/src/server/postgres-semantic-work-store.ts#saveOrganizerProposalCheckpoints:update:public.reflection_record_semantic_work:1",
  "update|public.room_journal_model_recoveries|packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:update:public.room_journal_model_recoveries:1",
  "update|public.memory_review_model_recoveries|packages/runtime/src/memory-review/repository.ts#fail:update:public.memory_review_model_recoveries:1",
  "update|public.memory_review_turns|packages/runtime/src/memory-review/repository.ts#fail:update:public.memory_review_turns:2",
  "update|public.room_journal_state|packages/runtime/src/stenographer/repository.ts#failCompaction:update:public.room_journal_state:2",
  "update|public.room_journal_state|packages/runtime/src/stenographer/repository.ts#failExtraction:update:public.room_journal_state:2",
  "update|public.room_journal_model_recoveries|packages/runtime/src/stenographer/repository.ts#parkUnspentJournalGrant:update:public.room_journal_model_recoveries:1",
  "update|public.room_journal_model_recoveries|packages/runtime/src/stenographer/repository.ts#retireFreshCompactionGrant:update:public.room_journal_model_recoveries:1",
  "update|public.room_journal_state|packages/runtime/src/stenographer/repository.ts#retireFreshCompactionGrant:update:public.room_journal_state:1",
  "update|public.room_journal_model_recoveries|packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:update:public.room_journal_model_recoveries:2",
  "update|public.room_journal_state|packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:update:public.room_journal_state:5",
  "update|public.room_journal_state|packages/runtime/src/stenographer/repository.ts#tryClaimCompactionRoom:update:public.room_journal_state:6",
  "update|public.room_journal_batches|packages/runtime/src/stenographer/repository.ts#tryClaimRoom:update:public.room_journal_batches:2",
  "update|public.room_journal_model_recoveries|packages/runtime/src/stenographer/repository.ts#tryClaimRoom:update:public.room_journal_model_recoveries:1",
  "insert|public.memory_recovery_runs|packages/server/src/lib/manual-memory-recovery.ts#request:insert:public.memory_recovery_runs:1",
  "update|public.memory_recovery_runs|packages/server/src/lib/manual-memory-recovery.ts#processNextPage:update:public.memory_recovery_runs:1",
  "update|public.memory_recovery_runs|packages/server/src/lib/manual-memory-recovery.ts#processNextPage:update:public.memory_recovery_runs:2",
  "update|public.memory_recovery_runs|packages/server/src/lib/manual-memory-recovery.ts#processNextPage:update:public.memory_recovery_runs:3",
  "update|public.memory_recovery_runs|packages/server/src/lib/manual-memory-recovery.ts#request:update:public.memory_recovery_runs:1",
  "update|public.reflection_record_semantic_work|packages/server/src/lib/memory-recovery-service.ts#recoverReflectionFamily:update:public.reflection_record_semantic_work:1",
  "insert|public.room_journal_model_recoveries|packages/server/src/lib/request-manual-journal-recovery.ts#queueCandidate:insert:public.room_journal_model_recoveries:1",
  "update|public.room_journal_model_recoveries|packages/server/src/lib/request-manual-journal-recovery.ts#queueCandidate:update:public.room_journal_model_recoveries:1",
  "update|public.room_journal_model_recoveries|packages/server/src/lib/request-manual-journal-recovery.ts#queueCandidate:update:public.room_journal_model_recoveries:2",
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
  test("pins the appended recovery migrations and snapshots", () => {
    const inventory = inventoryMigrationTree(resolve(repoRoot, "packages/db/src/migrations"));
    expect(inventory.migrations.filter(item => item.index >= 392 && item.index <= 402)).toEqual([
      { index: 392, tag: "0392_flaky_spencer_smythe", path: "0392_flaky_spencer_smythe.sql", sha256: "22ffc8f0d9fc59c6c63386f395b240dd874d75c90f6f0adb783ee03e7427de56" },
      { index: 393, tag: "0393_past_shocker", path: "0393_past_shocker.sql", sha256: "4129a4432c0e224827f8034921544dbc9faff127ebfbf676646c2f80e2b60007" },
      { index: 394, tag: "0394_absurd_young_avengers", path: "0394_absurd_young_avengers.sql", sha256: "978a13f89a637a05ea1fbb05f83085c11038b5dbc7a6c88d327454bcce13574a" },
      { index: 395, tag: "0395_big_blizzard", path: "0395_big_blizzard.sql", sha256: "02184ee600e44d98c3703a97f0e91a458b82e52b56ab38d5f47690d73c2edc6c" },
      { index: 396, tag: "0396_wise_apocalypse", path: "0396_wise_apocalypse.sql", sha256: "ef342a61cec17bcd8ee32f3ef0c72b75e75ec0a8dd2a9541f12ccb394b97bac3" },
      { index: 397, tag: "0397_dry_mikhail_rasputin", path: "0397_dry_mikhail_rasputin.sql", sha256: "0fcac8081329c323f78be0c225db20694779c3154072faef91993c0640a9dcd5" },
      { index: 398, tag: "0398_tricky_leper_queen", path: "0398_tricky_leper_queen.sql", sha256: "f0bf750a6bfd9799b2200dc9fb6b7648a7bf0b00a58cf765d3c430f79bf771b2" },
      { index: 399, tag: "0399_thick_madame_masque", path: "0399_thick_madame_masque.sql", sha256: "54e24cdc36fab0174054e43552849cd9022c8aaba78ba190ca1b0e3a572b7932" },
      { index: 400, tag: "0400_curious_professor_monster", path: "0400_curious_professor_monster.sql", sha256: "37b81025441248afda5aee03369737d8774774b6141334a3260683b4c0db1468" },
      { index: 401, tag: "0401_fearless_giant_girl", path: "0401_fearless_giant_girl.sql", sha256: "c7017122e7825da9754778c73985182b1d2deccf69495a96bf18421fa5a0ed81" },
      { index: 402, tag: "0402_romantic_frightful_four", path: "0402_romantic_frightful_four.sql", sha256: "b3e4a9df3482257f8e6453a5de512411bbbb1538e667400a56c2924f84908323" },
    ]);
    expect(inventory.snapshots.filter(item => item.index >= 392 && item.index <= 402)).toEqual([
      { index: 392, path: "meta/0392_snapshot.json", sha256: "bd63f34c95e159046995803accace3ecf48562cac8b249df0d1785fb17f71b50" },
      { index: 393, path: "meta/0393_snapshot.json", sha256: "b4380617cd8bf32d402094a405c73e93400769fc7d12e078db0a6c2b1e12ac50" },
      { index: 394, path: "meta/0394_snapshot.json", sha256: "2ea9817face611550bdde19128dcc6535f8c3e62c97c67ab0d29331f3b3f7383" },
      { index: 395, path: "meta/0395_snapshot.json", sha256: "1a360a6b44304ab7d36b02bbe5c3bda92c017a95d4f1469682057e66711a0af1" },
      { index: 396, path: "meta/0396_snapshot.json", sha256: "841ab92bd20dc35bd5256b3f965d05bf8faab3fbddd906a4ec1e93e6d91f9069" },
      { index: 397, path: "meta/0397_snapshot.json", sha256: "b47648a996b2b530775e38c24887357ed7004a0cfced88a4c9130ee67ff5eb87" },
      { index: 398, path: "meta/0398_snapshot.json", sha256: "ba79cd61e39c8edbdeaf44cc1d571d160a0bd9781c3d8642638870ab5933bc2d" },
      { index: 399, path: "meta/0399_snapshot.json", sha256: "647fe16b98e9301061a6b5effe2149e11ec7d0ecc28157e566a8cc733b84a57a" },
      { index: 400, path: "meta/0400_snapshot.json", sha256: "d29289e553fa444348d2c9f3dc8d085f2512b1e6784bd5feb7d00f592156daf7" },
      { index: 401, path: "meta/0401_snapshot.json", sha256: "685a0709afac2e0d69a82f8e3280615f5640e9f0bc8a08b3cacde22b8fa68649" },
      { index: 402, path: "meta/0402_snapshot.json", sha256: "3cbaaaf0f2ab8be9897c6c3539e6b65c3aa642187f673fd3c01d0985b77c6db1" },
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
