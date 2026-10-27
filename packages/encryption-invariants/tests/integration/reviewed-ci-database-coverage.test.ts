import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as nautiloSchema from "@nautilo/db/schema";

import {
  REVIEWED_CI_DATABASE_COVERAGE,
  REVIEWED_CI_DATABASE_DEBT_LINKS,
  REVIEWED_CI_DATABASE_OBSERVATION_LOCATORS,
  REVIEWED_CI_DATABASE_WRITER_LOCATORS,
} from "../../baseline/reviewed-ci-database-coverage";
import { BASELINE_REGISTRY, CURRENT_FROZEN_BASELINE_DEBT } from
  "../../baseline/existing-debt";
import { discoverDatabaseWriterInventory } from
  "../../src/node/database-writer-inventory";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");
const CONTENT_DEBT_ID = "debt.db.public.session_messages.content";
const ARCHIVE_CONTENT_DEBT_IDS = [
  CONTENT_DEBT_ID,
  "debt.db.public.session_messages.content_search",
  "debt.db.public.session_messages.metadata",
  "debt.db.public.sessions.title",
  "debt.db.public.jobs.result",
  "debt.db.public.jobs.message",
  "debt.db.public.jobs.metadata",
] as const;

describe("isolated external-operator database coverage", () => {
  test("classifies all 20 added schema observations without hiding content as metadata", () => {
    expect(REVIEWED_CI_DATABASE_COVERAGE).toHaveLength(16);
    expect(REVIEWED_CI_DATABASE_DEBT_LINKS).toHaveLength(4);
    expect(new Set(REVIEWED_CI_DATABASE_OBSERVATION_LOCATORS).size).toBe(20);

    const schema = inventoryDrizzleSchema(nautiloSchema);
    const observed = new Set([
      ...schema.objects.map((object) => object.locator),
      ...schema.columns.map((column) => column.locator),
    ]);
    for (const locator of REVIEWED_CI_DATABASE_OBSERVATION_LOCATORS) {
      expect(observed.has(locator), locator).toBe(true);
    }

    const metadataLocators = new Set(
      REVIEWED_CI_DATABASE_COVERAGE.map((entry) => entry.locator),
    );
    const contentLocators = new Set(
      REVIEWED_CI_DATABASE_DEBT_LINKS.map((entry) => entry.locator),
    );
    expect(contentLocators).toEqual(new Set([
      "public.bolter_inbox_receipts.control_input",
      "public.bolter_outbox.control_result",
      "public.external_operator_control_archive",
      "public.external_operator_control_archive.evidence",
    ]));
    for (const locator of contentLocators) {
      expect(metadataLocators.has(locator), locator).toBe(false);
    }
  });

  test("registers metadata and links every plaintext representation to frozen Message content", () => {
    const frozenIds = new Set(
      CURRENT_FROZEN_BASELINE_DEBT.map((entry) => entry.id),
    );
    expect(frozenIds.has(CONTENT_DEBT_ID)).toBe(true);

    for (const entry of REVIEWED_CI_DATABASE_COVERAGE) {
      expect(entry.classification).toBe("bounded_metadata");
      expect(entry.testEvidence.length).toBeGreaterThan(0);
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    for (const link of REVIEWED_CI_DATABASE_DEBT_LINKS) {
      expect(link.targetDebtIds).toEqual(
        link.locator.startsWith("public.external_operator_control_archive")
          ? ARCHIVE_CONTENT_DEBT_IDS
          : [CONTENT_DEBT_ID],
      );
      expect(link.targetDebtIds.every((id) => frozenIds.has(id))).toBe(true);
      expect(link.crossBoundaryProjection?.fields).toHaveLength(1);
      expect(link.testEvidence.length).toBeGreaterThan(0);
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
    }
  });

  test("pins the exact added typed writer set", async () => {
    const schema = inventoryDrizzleSchema(nautiloSchema);
    const tableExports = Object.fromEntries(
      schema.objects.filter((object) => object.kind === "table").flatMap(
        (object) => object.exportNames.map((name) => [name, object.locator]),
      ),
    );
    const inventory = await discoverDatabaseWriterInventory(
      repositoryRoot,
      tableExports,
    );
    const observed = new Set(inventory.map((entry) => entry.locator));
    expect(REVIEWED_CI_DATABASE_WRITER_LOCATORS).toHaveLength(5);
    for (const locator of REVIEWED_CI_DATABASE_WRITER_LOCATORS) {
      expect(observed.has(locator), locator).toBe(true);
    }
  });
});
