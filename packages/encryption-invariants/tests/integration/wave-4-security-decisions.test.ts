import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-14-landing";
import {
  REVIEWED_WAVE_4_SOURCE_ALARMS,
  SUPERSEDED_WAVE_0_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-wave-4-source-alarms";
import {
  RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/retired-m223-query-writers";
import {
  RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/retired-memory-embedding-provenance-query-writers";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";
import { rawDatabaseWriterDebtId } from "../../src/raw-database-writer-debt";

const evidencePath =
  "packages/encryption-invariants/tests/integration/wave-4-security-decisions.test.ts";

const reviewedMetadata = [
  {
    locator: "public.memories.creation_key",
    allowlist: ["creation_key"],
    owner: "packages/agent",
  },
  {
    locator: "public.relay_tokens.device_group_id",
    allowlist: ["device_group_id"],
    owner: "packages/server",
  },
  {
    locator: "public.relay_tokens.device_management_id",
    allowlist: ["device_management_id"],
    owner: "packages/server",
  },
  {
    locator: "public.session_messages.edited_at",
    allowlist: ["edit_timestamp"],
    owner: "packages/trust",
  },
  {
    locator: "public.session_messages.edit_revision",
    allowlist: ["nonnegative_revision"],
    owner: "packages/trust",
  },
  {
    locator: "public.room_journal_state.rebuild_generation",
    allowlist: ["nonnegative_generation"],
    owner: "packages/runtime",
  },
  {
    locator: "public.room_journal_state.rebuild_requested_at",
    allowlist: ["rebuild_timestamp_or_null"],
    owner: "packages/runtime",
  },
  {
    locator: "public.room_journal_state.rebuild_target_message_id",
    allowlist: ["nonnegative_internal_message_id_or_null"],
    owner: "packages/runtime",
  },
] as const;

const retiredMemoryWriterLocators = [
  {
    locator:
      "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memories:1",
    retirement: RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS,
    frozenDebtLocator:
      "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:raw_sql:insert:public.memories:1",
    retainsBoundaryLink: true,
  },
  {
    locator:
      "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:raw_sql:insert:public.memory_namespaces:1",
    retirement: RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS,
    frozenDebtLocator:
      "packages/agent/src/store/memory-store.ts#attachMemoryToNamespaceWithDb:raw_sql:insert:public.memory_namespaces:1",
    retainsBoundaryLink: false,
  },
  {
    locator:
      "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memories:1",
    retirement:
      RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS,
    frozenDebtLocator:
      "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:raw_sql:insert:public.memories:1",
    retainsBoundaryLink: false,
  },
  {
    locator:
      "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memory_namespaces:1",
    retirement:
      RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS,
    frozenDebtLocator:
      "packages/agent/src/store/memory-store.ts#attachMemoryToNamespaceWithDb:raw_sql:insert:public.memory_namespaces:1",
    retainsBoundaryLink: false,
  },
] as const;

const reviewedM230RebuildWriterLocators = [
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:delete:public.room_event_rollups:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:delete:public.room_events:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:delete:public.room_journal_batches:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:update:public.room_journal_state:1",
  "packages/runtime/src/stenographer/repository.ts#prepareNextJournalRebuild:raw_sql:update:public.room_journal_state:2",
] as const;

describe("Wave 4 database security decisions", () => {
  test("classifies only opaque routing and idempotency fields as bounded metadata", () => {
    for (const decision of reviewedMetadata) {
      const entry = BASELINE_REGISTRY.entries.find(
        (candidate) => candidate.locator === decision.locator,
      );
      expect(entry).toMatchObject({
        surface: "db",
        owner: decision.owner,
        classification: "bounded_metadata",
        metadataAllowlist: decision.allowlist,
        migrationState: "not_applicable",
        testEvidence: [evidencePath],
      });
    }
  });

  test("keeps the normalized room label blocked as protected-derived plaintext", () => {
    expect(
      BASELINE_REGISTRY.entries.some(
        (entry) => entry.locator === "public.rooms.normalized_label",
      ),
    ).toBe(false);

    const link = BASELINE_REGISTRY.reviewedDebtLinks?.find(
      (candidate) => candidate.locator === "public.rooms.normalized_label",
    );
    expect(link).toMatchObject({
      surface: "db",
      owner: "packages/db",
      targetDebtIds: ["debt.db.public.rooms.label"],
      testEvidence: [evidencePath],
    });
    expect(link?.reason).toContain("user-authored Room-label plaintext boundary");
  });

  test("retires replaced raw Memory writers without erasing frozen debt", () => {
    for (const {
      locator,
      retirement,
      frozenDebtLocator,
      retainsBoundaryLink,
    } of retiredMemoryWriterLocators) {
      expect(retirement.has(locator)).toBe(true);
      expect(RAW_DATABASE_WRITER_DEBT.some(
        (candidate) => candidate.locator === locator,
      )).toBe(false);
      const boundaryLink = BASELINE_REGISTRY.reviewedDebtLinks?.find(
        (candidate) => candidate.locator === locator,
      );
      if (retainsBoundaryLink) {
        expect(boundaryLink).toMatchObject({
          surface: "db",
          owner: "packages/agent",
          targetDebtIds: [rawDatabaseWriterDebtId(frozenDebtLocator)],
          testEvidence: [evidencePath],
        });
      } else {
        expect(boundaryLink).toBeUndefined();
      }
      expect(BASELINE_REGISTRY.debt.some(
        (candidate) =>
          candidate.id === rawDatabaseWriterDebtId(frozenDebtLocator),
      )).toBe(true);
    }
  });

  test("classifies edit-triggered journal invalidation as opaque delete/reset controls", () => {
    for (const locator of reviewedM230RebuildWriterLocators) {
      expect(RAW_DATABASE_WRITER_DEBT.some(
        (candidate) => candidate.locator === locator,
      )).toBe(true);
      expect(BASELINE_REGISTRY.entries.find(
        (candidate) => candidate.locator === locator,
      )).toMatchObject({
        surface: "db",
        owner: "packages/runtime",
        classification: "bounded_metadata",
        testEvidence: [evidencePath],
      });
    }
  });
});

describe("Wave 4 relay wire security decisions", () => {
  test("classifies only closed lifecycle controls as bounded metadata", () => {
    const locators = [
      "http:request_response:DELETE /api/relay/devices/v2/:deviceManagementId",
      "http:request_response:DELETE /api/relay/devices/v2/:deviceManagementId#request.body.expectedPairingCount",
      "http:request_response:POST /api/relay/devices/v2/historical/cleanup",
      "http:request_response:POST /api/relay/devices/v2/historical/cleanup#request.body.confirm",
      "http:request_response:POST /api/relay/devices/v2/historical/cleanup#request.body.expectedPairingCount",
      "http:request_response:POST /api/relay/pair#request.body.deviceGroupId",
    ];
    for (const locator of locators) {
      expect(BASELINE_REGISTRY.entries.find(
        (candidate) => candidate.locator === locator,
      )).toMatchObject({
        surface: "wire",
        owner: "packages/server",
        classification: "bounded_metadata",
      });
    }
  });

  test("does not misclassify the user-authored device label as metadata", () => {
    for (const locator of [
      "http:request_response:GET /api/relay/devices/v2",
      "http:request_response:GET /api/relay/devices/v2/:deviceManagementId",
    ]) {
      expect(BASELINE_REGISTRY.entries.some(
        (candidate) => candidate.locator === locator,
      )).toBe(false);
      expect(BASELINE_REGISTRY.reviewedDebtLinks?.find(
        (candidate) => candidate.locator === locator,
      )).toMatchObject({
        surface: "wire",
        owner: "packages/server",
        targetDebtIds: [
          "debt.wire.http.request.response.get.api.relay.devices.1kclu9f",
        ],
      });
    }
  });

  test("keeps transcript search and navigation on the frozen Room-message boundary", () => {
    for (const locator of [
      "http:request_response:GET /api/rooms/:id/messages/search",
      "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
    ]) {
      expect(BASELINE_REGISTRY.entries.some(
        (candidate) => candidate.locator === locator,
      )).toBe(false);
      expect(BASELINE_REGISTRY.reviewedDebtLinks?.find(
        (candidate) => candidate.locator === locator,
      )).toMatchObject({
        surface: "wire",
        owner: "packages/server",
        targetDebtIds: [
          "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
        ],
      });
    }
  });

  test("keeps message edit HTTP and WS content on the frozen Room-message boundary", () => {
    for (const locator of [
      "http:request_response:PATCH /api/rooms/:roomId/messages/:messageId",
      "ws:server_to_client:message.updated",
    ]) {
      expect(BASELINE_REGISTRY.entries.some(
        (candidate) => candidate.locator === locator,
      )).toBe(false);
      expect(BASELINE_REGISTRY.reviewedDebtLinks?.find(
        (candidate) => candidate.locator === locator,
      )).toMatchObject({ surface: "wire" });
    }
  });
});

describe("Wave 4 source-alarm security decisions", () => {
  test("closes the exact current source alarms with unresolved runtime debt explicit", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const inventory = await scanSourceAlarms({ repoRoot });
    expect(inventory.errors).toEqual([]);

    const inspection = inspectSourceAlarmReviews(inventory.alarms);
    expect(inspection.errors).toEqual([]);
    expect(inspection.reviews).toHaveLength(CURRENT_SOURCE_ALARM_REVIEWS.length);
    expect(new Set(inspection.reviews.map((review) => review.locator))).toEqual(
      new Set(CURRENT_SOURCE_ALARM_REVIEWS.map((review) => review.locator)),
    );
    expect(inspection.counts).toEqual({
      declaration: CURRENT_SOURCE_ALARM_REVIEWS.filter(
        (review) => review.closure === "declaration",
      ).length,
      baselineDebt: CURRENT_SOURCE_ALARM_REVIEWS.filter(
        (review) => review.closure === "baseline_debt",
      ).length,
      reviewedExclusion: CURRENT_SOURCE_ALARM_REVIEWS.filter(
        (review) => review.closure === "reviewed_exclusion",
      ).length,
      unmapped: 0,
    });
    expect(
      REVIEWED_WAVE_4_SOURCE_ALARMS.some(
        (review) => review.closure === "baseline_debt",
      ),
    ).toBe(false);
  });

  test("replaces moved reviews and removes the unsafe desktop URL log", () => {
    const reintroducedLocators = new Set([
      "apps/desktop/electron/main.ts#log_emitter:ae27fd70f90d5f14:8",
    ]);
    for (const locator of SUPERSEDED_WAVE_0_SOURCE_ALARM_LOCATORS) {
      expect(
        CURRENT_SOURCE_ALARM_REVIEWS.some(
          (review) => review.locator === locator,
        ),
      ).toBe(reintroducedLocators.has(locator));
    }
    expect(REVIEWED_WAVE_4_SOURCE_ALARMS).toHaveLength(22);
  });
});
