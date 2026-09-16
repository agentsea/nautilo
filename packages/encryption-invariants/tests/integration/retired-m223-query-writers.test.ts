import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as nautiloSchema from "@nautilo/db/schema";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  RETIRED_M223_FROZEN_DEBT,
  RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/retired-m223-query-writers";
import { discoverDatabaseWriterInventory } from "../../src/node/database-writer-inventory";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

const TYPED_REPLACEMENT_LOCATORS = [
  "packages/agent/src/store/memory-store.ts#attachMemoryToNamespaceWithDb:insert:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#detachMemoryFromNamespace:delete:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#hardDeleteMemory:delete:public.memory_namespaces:1",
  "packages/agent/src/store/memory-store.ts#updateMemory:delete:public.memory_namespaces:1",
  "packages/db/src/queries/room-journal-state.ts#createRoomJournalStateInTx:insert:public.room_journal_state:1",
  "packages/db/src/utils/profile-migration-memory-primitives.ts#insertPrivateMemoryInTx:insert:public.memories:1",
  "packages/db/src/queries/session-message-read-state.ts#markMessageRecipientDeliveredWith:insert:public.session_message_recipient_state:1",
  "packages/db/src/queries/session-message-read-state.ts#markMessageRecipientReadWith:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRoomRead:insert:public.session_message_recipient_state:1",
  "packages/trust/src/read-state.ts#markRoomRead:update:public.session_messages:1",
  "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:insert:public.memory_namespaces:1",
] as const;

describe("M223 retired raw database writers", () => {
  test("keeps frozen history while proving each typed replacement", async () => {
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

    expect(RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS.size).toBe(11);
    expect(RETIRED_M223_FROZEN_DEBT).toHaveLength(10);
    for (const locator of RETIRED_M223_RAW_DATABASE_WRITER_LOCATORS) {
      expect(observedLocators.has(locator)).toBe(false);
      expect(RAW_DATABASE_WRITER_DEBT.some((entry) => entry.locator === locator))
        .toBe(false);
    }
    for (const locator of TYPED_REPLACEMENT_LOCATORS) {
      expect(observedLocators.has(locator)).toBe(true);
    }
    for (const retirement of RETIRED_M223_FROZEN_DEBT) {
      expect(BASELINE_REGISTRY.debt.some((entry) =>
        entry.id === retirement.debtId
      )).toBe(true);
      expect(BASELINE_REGISTRY.retiredFrozenDebt).toContainEqual(retirement);
    }
  });
});
