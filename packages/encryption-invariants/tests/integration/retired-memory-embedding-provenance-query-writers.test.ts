import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as nautiloSchema from "@nautilo/db/schema";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  RETIRED_MEMORY_EMBEDDING_FROZEN_DEBT,
  RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/retired-memory-embedding-provenance-query-writers";
import { discoverDatabaseWriterInventory } from "../../src/node/database-writer-inventory";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

const TYPED_REPLACEMENT_LOCATORS = [
  "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:insert:public.memories:1",
  "packages/agent/src/store/memory-store.ts#replaceMemoryWithDb:update:public.memories:2",
  "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:insert:public.memories:1",
  "packages/agent/src/store/memory-store.ts#saveMemoryWithDb:update:public.memories:1",
  "packages/agent/src/store/memory-store.ts#updateMemory:update:public.memories:1",
  "packages/agent/src/store/memory-store.ts#updateMemory:update:public.memories:2",
  "packages/agent/src/store/scope-memory-store.ts#replaceScopeMemoryWithDb:update:public.memories:2",
  "packages/agent/src/store/scope-memory-store.ts#updateScopeMemory:update:public.memories:1",
  "packages/agent/src/store/scope-memory-store.ts#updateScopeMemory:update:public.memories:2",
] as const;

describe("Memory embedding provenance typed writers", () => {
  test("retires only the replaced raw writers and inventories every typed replacement", async () => {
    const schema = inventoryDrizzleSchema(nautiloSchema);
    const tableExports = Object.fromEntries(
      schema.objects
        .filter((object) => object.kind === "table")
        .flatMap((object) =>
          object.exportNames.map((exportName) => [exportName, object.locator])
        ),
    );
    const observations = await discoverDatabaseWriterInventory(
      resolve(import.meta.dir, "../../../.."),
      tableExports,
    );
    const observedLocators = new Set(observations.map((item) => item.locator));

    expect(RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS.size).toBe(5);
    expect(RETIRED_MEMORY_EMBEDDING_FROZEN_DEBT).toHaveLength(4);
    for (const locator of RETIRED_MEMORY_EMBEDDING_RAW_DATABASE_WRITER_LOCATORS) {
      expect(observedLocators.has(locator)).toBe(false);
      expect(RAW_DATABASE_WRITER_DEBT.some((entry) => entry.locator === locator))
        .toBe(false);
    }
    for (const locator of TYPED_REPLACEMENT_LOCATORS) {
      expect(observedLocators.has(locator)).toBe(true);
    }
    for (const retirement of RETIRED_MEMORY_EMBEDDING_FROZEN_DEBT) {
      expect(BASELINE_REGISTRY.debt.some((entry) =>
        entry.id === retirement.debtId
      )).toBe(true);
      expect(BASELINE_REGISTRY.retiredFrozenDebt).toContainEqual(retirement);
    }
  });
});
