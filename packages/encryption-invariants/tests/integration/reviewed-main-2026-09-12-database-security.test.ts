import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as nautiloSchema from "@nautilo/db/schema";
import {
  eventFeedItemSchema,
  eventFeedRecordInputSchema,
} from "@nautilo/types";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  CONTENT_ACCESS_OPERATION_METADATA_FIELDS,
  CONTENT_ACCESS_OPERATION_METADATA_LOCATORS,
  FEED_EVENT_METADATA_FIELDS,
  FEED_EVENT_METADATA_LOCATORS,
  FEED_RECIPIENT_METADATA_FIELDS,
  FEED_RECIPIENT_METADATA_LOCATORS,
  MEDIA_MODEL_METADATA_FIELDS,
  ORDINARY_STENOGRAPHER_FALLBACK_METADATA_FIELDS,
  PROCESSOR_SIGNER_METADATA_FIELDS,
  REFLECTION_TARGET_METADATA_FIELDS,
  REVIEWED_MAIN_2026_09_12_DATABASE_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_09_12_DATABASE_METADATA_ENTRIES,
  REVIEWED_MAIN_2026_09_12_DATABASE_WRITER_ENTRIES,
  STENOGRAPHER_AUTHORIZATION_WAIT_METADATA_FIELDS,
  SUPERSEDED_MAIN_2026_09_12_DATABASE_WRITER_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-database";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { canonicalDatabaseWriterLocator } from "../../src/registry";
import { discoverDatabaseWriterInventory } from
  "../../src/node/database-writer-inventory";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");

function normalizedCheckSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const check = getTableConfig(table).checks.find((item) => item.name === name);
  expect(check, name).toBeDefined();
  return new PgDialect().sqlToQuery(check!.value).sql
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
}

describe("reviewed main 2026-09-12 database encryption inventory", () => {
  test("registers exactly 41 bounded metadata observations and two moved writers", () => {
    expect(REVIEWED_MAIN_2026_09_12_DATABASE_METADATA_ENTRIES).toHaveLength(41);
    expect(REVIEWED_MAIN_2026_09_12_DATABASE_WRITER_ENTRIES).toHaveLength(2);
    expect(REVIEWED_MAIN_2026_09_12_DATABASE_COVERAGE_ENTRIES).toHaveLength(43);
    expect(SUPERSEDED_MAIN_2026_09_12_DATABASE_WRITER_LOCATORS.size).toBe(3);

    for (const entry of REVIEWED_MAIN_2026_09_12_DATABASE_COVERAGE_ENTRIES) {
      expect(entry).toMatchObject({
        surface: "db",
        classification: "bounded_metadata",
        migrationState: "not_applicable",
      });
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      if (entry.classification !== "bounded_metadata") {
        throw new Error(`unexpected classification for ${entry.locator}`);
      }
      expect(entry.metadataAllowlist.length).toBeGreaterThan(0);
      expect(entry.testEvidence.length).toBeGreaterThan(0);
    }
    for (const locator of SUPERSEDED_MAIN_2026_09_12_DATABASE_WRITER_LOCATORS) {
      expect(BASELINE_REGISTRY.entries.some((entry) =>
        entry.locator === locator
      )).toBe(false);
    }
  });

  test("keeps each table group on a concrete field allowlist", () => {
    const expected = new Map<string, readonly string[]>([
      ...CONTENT_ACCESS_OPERATION_METADATA_LOCATORS.map((locator) => [
        locator,
        CONTENT_ACCESS_OPERATION_METADATA_FIELDS,
      ] as const),
      ...FEED_EVENT_METADATA_LOCATORS.map((locator) => [
        locator,
        FEED_EVENT_METADATA_FIELDS,
      ] as const),
      ...FEED_RECIPIENT_METADATA_LOCATORS.map((locator) => [
        locator,
        FEED_RECIPIENT_METADATA_FIELDS,
      ] as const),
    ]);
    for (const entry of REVIEWED_MAIN_2026_09_12_DATABASE_METADATA_ENTRIES) {
      const allowlist = expected.get(entry.locator);
      if (allowlist === undefined) continue;
      expect(entry.classification).toBe("bounded_metadata");
      if (entry.classification === "bounded_metadata") {
        expect(entry.metadataAllowlist).toEqual(allowlist);
      }
    }
  });

  test("rejects human-authored feed payload fields before the storage write", () => {
    const valid = {
      key: "membership:operation-1",
      type: "room.member_joined",
      actorKind: "human",
      actorId: "10000000-0000-4000-8000-000000000001",
      recipientUserIds: ["10000000-0000-4000-8000-000000000002"],
      data: {
        roomId: "10000000-0000-4000-8000-000000000003",
        userId: "10000000-0000-4000-8000-000000000002",
      },
    } as const;
    expect(eventFeedRecordInputSchema.safeParse(valid).success).toBe(true);
    for (const extra of [
      { content: "private Room message" },
      { displayName: "private Human name" },
      { summary: "private Artifact summary" },
    ]) {
      expect(eventFeedRecordInputSchema.safeParse({
        ...valid,
        data: { ...valid.data, ...extra },
      }).success).toBe(false);
    }

    const future = eventFeedItemSchema.parse({
      id: "10000000-0000-4000-8000-000000000004",
      type: "future.private-event",
      actorKind: "human",
      actorId: valid.actorId,
      data: { content: "must not survive" },
      createdAt: "2026-09-12T00:00:00.000Z",
      readAt: null,
    });
    expect(future).toMatchObject({
      type: "unknown",
      actorKind: null,
      actorId: null,
      data: {},
    });
    expect(JSON.stringify(future)).not.toContain("must not survive");

    const backend = readFileSync(
      join(repositoryRoot, "packages/event-feed/src/event-feed.ts"),
      "utf8",
    );
    const validation = backend.indexOf(
      "eventFeedRecordInputSchema.safeParse(input)",
    );
    const write = backend.indexOf("options.storage.record(normalized)");
    expect(validation).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(validation);
    expect(backend.slice(validation, write)).toContain("if (!parsed.success)");
  });

  test("keeps content-access receipts closed, immutable metadata only", () => {
    const columns = Object.keys(getTableColumns(nautiloSchema.contentAccessOperations));
    expect(columns).toEqual([
      "operationId",
      "requestDigest",
      "requesterUserId",
      "requesterActorId",
      "memoryId",
      "artifactId",
      "outcome",
      "changed",
      "attachedCount",
      "detachedCount",
      "skippedCount",
      "createdAt",
    ]);
    for (const forbidden of [
      "content",
      "payload",
      "result",
      "plan",
      "audience",
      "namespaceId",
      "token",
      "expiresAt",
      "pendingAt",
      "claimOwner",
      "nextAttemptAt",
    ]) {
      expect(columns).not.toContain(forbidden);
    }
    const migration = readFileSync(
      join(
        repositoryRoot,
        "packages/db/src/migrations/0282_content_access_receipt_immutability.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("Content access receipts are immutable");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("BEFORE TRUNCATE");
  });

  test("pins the closed versions, fallback fingerprints, waits, and model ids", () => {
    expect(PROCESSOR_SIGNER_METADATA_FIELDS).toEqual(["format_version"]);
    const signerVersion = normalizedCheckSql(
      nautiloSchema.processorCryptoSignerAuthorizations,
      "processor_crypto_signer_authorizations_format_version",
    );
    expect(signerVersion).toContain('"format_version" in (1, 2, 3)');

    expect(REFLECTION_TARGET_METADATA_FIELDS).toEqual([
      "target_access_namespace_ids",
      "target_audience_set_commitment",
      "target_crypto_retired_at",
    ]);
    const reflectionTarget = normalizedCheckSql(
      nautiloSchema.reflectionRecordAuthorityReconciliations,
      "reflection_record_authority_reconciliation_target_access_coherent",
    );
    expect(reflectionTarget).toContain("cardinality");
    expect(reflectionTarget).toContain("between 1 and 256");
    expect(reflectionTarget).toContain("octet_length");
    expect(reflectionTarget).toContain("= 32");

    expect(ORDINARY_STENOGRAPHER_FALLBACK_METADATA_FIELDS).toEqual([
      "ordinary_fallback_reason",
      "ordinary_fallback_rebuild_generation",
      "ordinary_output_fingerprint",
    ]);
    for (const [table, name] of [
      [nautiloSchema.roomEventRollups, "room_event_rollups_ordinary_fallback_provenance"],
      [nautiloSchema.roomJournalBatches, "room_journal_batches_ordinary_fallback_provenance"],
    ] as const) {
      const fallback = normalizedCheckSql(table, name);
      expect(fallback).toContain("in ('device', 'authority')");
      expect(fallback).toContain("ordinary_fallback_rebuild_generation");
      expect(fallback).toContain(">= 0");
      expect(fallback).toContain("ordinary_output_fingerprint");
      expect(fallback).toContain("= 32");
    }

    expect(STENOGRAPHER_AUTHORIZATION_WAIT_METADATA_FIELDS).toEqual([
      "compaction_authorization_waiting_since",
      "extraction_authorization_wait_lane",
      "extraction_authorization_waiting_since",
    ]);
    const wait = normalizedCheckSql(
      nautiloSchema.roomJournalState,
      "room_journal_state_extraction_authorization_wait",
    );
    expect(wait).toContain("in ('live', 'historical', 'rebuild')");

    expect(MEDIA_MODEL_METADATA_FIELDS).toEqual([
      "image_model",
      "music_model",
      "video_model",
    ]);
    const modelColumns = getTableConfig(nautiloSchema.serverModelConfig).columns
      .filter((column) => MEDIA_MODEL_METADATA_FIELDS.includes(
        column.name as typeof MEDIA_MODEL_METADATA_FIELDS[number],
      ));
    expect(modelColumns.map((column) => column.name)).toEqual([
      ...MEDIA_MODEL_METADATA_FIELDS,
    ]);
    expect(modelColumns.every((column) =>
      column.getSQLType() === "text" && !column.notNull
    )).toBe(true);
  });

  test("maps moved Reflection writers to exact current scanner identities", async () => {
    const schema = inventoryDrizzleSchema(nautiloSchema);
    const tableExports = Object.fromEntries(
      schema.objects.filter((object) => object.kind === "table").flatMap(
        (object) => object.exportNames.map((name) => [name, object.locator]),
      ),
    );
    const current = await discoverDatabaseWriterInventory(
      repositoryRoot,
      tableExports,
    );
    const currentCanonical = new Set(
      current.map((writer) => canonicalDatabaseWriterLocator(writer.locator)),
    );
    for (const entry of REVIEWED_MAIN_2026_09_12_DATABASE_WRITER_ENTRIES) {
      expect(currentCanonical.has(
        canonicalDatabaseWriterLocator(entry.locator),
      )).toBe(true);
    }
    for (const locator of SUPERSEDED_MAIN_2026_09_12_DATABASE_WRITER_LOCATORS) {
      expect(current.some((writer) => writer.locator === locator)).toBe(false);
    }
  });
});
