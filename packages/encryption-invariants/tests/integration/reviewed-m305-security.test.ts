import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as nautiloSchema from "@nautilo/db/schema";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_M305_COVERAGE_ENTRIES,
  REVIEWED_M305_DATABASE_WRITER_LOCATOR,
} from "../../baseline/reviewed-m305-coverage";
import { SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS } from
  "../../baseline/reviewed-main-2026-09-03-coverage";
import { REVIEWED_M305_DTO_DECLARATIONS } from
  "../../baseline/reviewed-m305-dto";
import { discoverDatabaseWriterInventory } from
  "../../src/node/database-writer-inventory";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");

describe("M305 durable convergence encryption inventory", () => {
  test("classifies the source backlog and lifecycle writer as bounded metadata", () => {
    expect(REVIEWED_M305_COVERAGE_ENTRIES).toHaveLength(2);
    for (const entry of REVIEWED_M305_COVERAGE_ENTRIES) {
      expect(entry.classification).toBe("bounded_metadata");
      if (SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS.has(entry.locator)) {
        expect(BASELINE_REGISTRY.entries.some((candidate) =>
          candidate.locator === entry.locator
        )).toBe(false);
      } else {
        expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      }
      expect(entry.testEvidence.length).toBeGreaterThan(0);
    }
  });

  test("pins the content-free source-backlog wire contract", () => {
    expect(REVIEWED_M305_DTO_DECLARATIONS).toHaveLength(1);
    const declaration = REVIEWED_M305_DTO_DECLARATIONS[0]!;
    expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
    expect(declaration.arbitraryPayloads).toEqual([]);
  });

  test("pins the typed Human-peer lifecycle writer", async () => {
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
    expect(inventory.map((entry) => entry.locator)).toContain(
      REVIEWED_M305_DATABASE_WRITER_LOCATOR,
    );
  });
});
