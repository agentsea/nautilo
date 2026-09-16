import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as nautiloSchema from "@nautilo/db/schema";

import { DATABASE_WRITER_BASELINE } from "../../baseline/inventory-fingerprints";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  auditDatabaseWriterInventory,
  auditRawDatabaseWriterDebt,
  discoverDatabaseWriterInventory,
  fingerprintDatabaseWriterInventory,
} from "../../src/node/database-writer-inventory";
import { rawDatabaseWriterDebtId } from "../../src/raw-database-writer-debt";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";

const temporaryDirectories: string[] = [];

function fixtureRoot(source: string): string {
  const root = mkdtempSync(resolve(tmpdir(), "m220 database writers "));
  temporaryDirectories.push(root);
  const sourceDirectory = resolve(root, "packages/demo/src");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(resolve(sourceDirectory, "writers.ts"), source);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database writer inventory", () => {
  test("matches the reviewed production Drizzle writer inventory", async () => {
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

    expect({
      count: observations.length,
      insert: observations.filter((item) => item.operation === "insert").length,
      update: observations.filter((item) => item.operation === "update").length,
      delete: observations.filter((item) => item.operation === "delete").length,
      unresolved:
        observations.filter((item) => item.operation === "unresolved").length,
      sha256: fingerprintDatabaseWriterInventory(observations),
    }).toEqual(DATABASE_WRITER_BASELINE);
    expect(observations).toContainEqual({
      operation: "insert",
      table: "public.session_message_crypto_revisions",
      path:
        "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts",
      symbol: "afterMessageIdAllocated",
      locator:
        "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts#afterMessageIdAllocated:insert:public.session_message_crypto_revisions:1",
    });
    for (const locator of [
      "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:insert:public.memories:1",
      "packages/agent/src/store/memory-store.ts#executeAtomicProjectionMemoryInTx:insert:public.memory_namespaces:1",
      "packages/server/src/lib/relay-token-store.ts#cleanupHistoricalForUser:update:public.relay_tokens:1",
      "packages/server/src/lib/relay-token-store.ts#revokeGroupedForUser:update:public.relay_tokens:1",
      "packages/server/src/acp/opencode-task-execution-composition.ts#linkJob:update:public.task_runs:1",
    ]) {
      expect(observations.some((item) => item.locator === locator)).toBe(true);
    }
    for (const locator of [
      "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memories:1",
      "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memory_namespaces:1",
    ]) {
      expect(observations.some((item) => item.locator === locator)).toBe(false);
    }
    expect(auditRawDatabaseWriterDebt({
      observations,
      declarations: RAW_DATABASE_WRITER_DEBT,
      reviewedLocators: [
        ...BASELINE_REGISTRY.entries,
        ...(BASELINE_REGISTRY.reviewedDebtLinks ?? []),
      ].filter((entry) => entry.locator.includes(":raw_sql:"))
        .map((entry) => entry.locator),
    })).toEqual({ ok: true, errors: [] });
  });

  test("finds endpoint-independent Drizzle insert/update/delete writers and ignores lookalikes", async () => {
    const root = fixtureRoot(`
      import { messages as persistedMessages } from "@nautilo/db/schema";

      export async function createMessage(db: any) {
        await db.insert(persistedMessages).values({ content: "secret" });
      }

      export async function reviseMessage(tx: any) {
        await tx.update(persistedMessages).set({ content: "changed" });
      }

      export async function removeMessage(handle: any) {
        await handle.delete(persistedMessages);
      }

      export function lookalikes(cache: Map<string, string>, hash: any) {
        cache.delete("not-a-table");
        hash.update("not-a-table");
      }
    `);

    const observations = await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    });
    expect(observations).toEqual([
      {
        operation: "insert",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "createMessage",
        locator:
          "packages/demo/src/writers.ts#createMessage:insert:public.messages:1",
      },
      {
        operation: "delete",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "removeMessage",
        locator:
          "packages/demo/src/writers.ts#removeMessage:delete:public.messages:1",
      },
      {
        operation: "update",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "reviseMessage",
        locator:
          "packages/demo/src/writers.ts#reviseMessage:update:public.messages:1",
      },
    ]);
  });

  test("finds raw SQL execute, unsafe, and psql-style mutation chokepoints", async () => {
    const root = fixtureRoot(`
      import { sql } from "drizzle-orm";

      export async function executeWriter(db: any) {
        await db.execute(sql\`
          UPDATE messages
          SET content = \${"changed"}
          WHERE id = \${"message-id"}
        \`);
      }

      export async function rawWrapperWriter(db: any) {
        await db.execute(sql.raw("UPDATE messages SET content = 'wrapped'"));
      }

      export async function unsafeWriter(client: any) {
        await client.unsafe("DELETE FROM messages WHERE id = 'message-id'");
      }

      export function operatorWriter(psqlExec: (sql: string) => void) {
        const statement = \`
          INSERT INTO messages (id, content)
          VALUES ('message-id', 'secret')
        \`;
        psqlExec(statement);
      }

      function psql(container: string, database: string, sql: string) {}

      export function operatorArgumentWriter() {
        psql("app-postgres", "nautilo", "DELETE FROM messages WHERE id = 'operator'");
      }
    `);

    const observations = await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    });
    expect(observations).toEqual([
      {
        operation: "update",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "executeWriter",
        locator:
          "packages/demo/src/writers.ts#executeWriter:raw_sql:update:public.messages:1",
      },
      {
        operation: "delete",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "operatorArgumentWriter",
        locator:
          "packages/demo/src/writers.ts#operatorArgumentWriter:raw_sql:delete:public.messages:1",
      },
      {
        operation: "insert",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "operatorWriter",
        locator:
          "packages/demo/src/writers.ts#operatorWriter:raw_sql:insert:public.messages:1",
      },
      {
        operation: "update",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "rawWrapperWriter",
        locator:
          "packages/demo/src/writers.ts#rawWrapperWriter:raw_sql:update:public.messages:1",
      },
      {
        operation: "delete",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "unsafeWriter",
        locator:
          "packages/demo/src/writers.ts#unsafeWriter:raw_sql:delete:public.messages:1",
      },
    ]);
  });

  test("does not misclassify SELECT row locks as raw UPDATE writers", async () => {
    const root = fixtureRoot(`
      export async function lockRows(db: any) {
        await db.query(\`
          SELECT id
            FROM jobs
           ORDER BY id
           FOR UPDATE SKIP LOCKED
        \`);
      }
    `);

    expect(await discoverDatabaseWriterInventory(root, {})).toEqual([]);
  });

  test("finds shell psql mutation input outside package source roots", async () => {
    const root = fixtureRoot("export {};");
    const infraDirectory = resolve(root, "infra");
    mkdirSync(infraDirectory, { recursive: true });
    writeFileSync(resolve(infraDirectory, "postgres-init.sh"), `
      psql -v ON_ERROR_STOP=1 <<-'EOSQL'
        INSERT INTO messages (id, content) VALUES ('message-id', 'secret');
        UPDATE messages SET content = 'changed' WHERE id = 'message-id';
        DELETE FROM messages WHERE id = 'message-id';
      EOSQL
    `);

    const shellObservations = await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    });
    expect(shellObservations).toEqual([
      {
        operation: "delete",
        table: "public.messages",
        path: "infra/postgres-init.sh",
        symbol: "<shell>",
        locator:
          "infra/postgres-init.sh#<shell>:raw_sql:delete:public.messages:1",
      },
      {
        operation: "insert",
        table: "public.messages",
        path: "infra/postgres-init.sh",
        symbol: "<shell>",
        locator:
          "infra/postgres-init.sh#<shell>:raw_sql:insert:public.messages:1",
      },
      {
        operation: "update",
        table: "public.messages",
        path: "infra/postgres-init.sh",
        symbol: "<shell>",
        locator:
          "infra/postgres-init.sh#<shell>:raw_sql:update:public.messages:1",
      },
    ]);
    expect(auditDatabaseWriterInventory({
      observations: shellObservations,
      declaredLocators: [],
    })).toMatchObject({
      ok: false,
      unknown: shellObservations.map((item) => item.locator),
      stale: [],
    });
  });

  test("fails closed when a new raw SQL writer appears", async () => {
    const root = fixtureRoot(`
      export async function existingWriter(db: any) {
        await db.execute("UPDATE messages SET content = 'reviewed'");
      }
      export async function newlyAddedWriter(db: any) {
        await db.execute("DELETE FROM messages WHERE id = 'new'");
      }
    `);
    const observations = await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    });
    const inspection = auditDatabaseWriterInventory({
      observations,
      declaredLocators: [
        "packages/demo/src/writers.ts#existingWriter:raw_sql:update:public.messages:1",
      ],
    });

    expect(inspection.ok).toBe(false);
    expect(inspection.unknown).toEqual([
      "packages/demo/src/writers.ts#newlyAddedWriter:raw_sql:delete:public.messages:1",
    ]);
  });

  test("preserves an exact writer review when only scanner provenance changes", () => {
    const locator =
      "packages/demo/src/writers.ts#save:update:public.messages:1";
    expect(auditDatabaseWriterInventory({
      observations: [{
        operation: "update",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "save",
        locator,
      }],
      declaredLocators: [locator.replace(":update:", ":raw_sql:update:")],
    })).toEqual({ ok: true, unknown: [], stale: [], errors: [] });

    expect(auditDatabaseWriterInventory({
      observations: [{
        operation: "delete",
        table: "public.messages",
        path: "packages/demo/src/writers.ts",
        symbol: "save",
        locator: locator.replace(":update:", ":delete:"),
      }],
      declaredLocators: [locator.replace(":update:", ":raw_sql:update:")],
    }).ok).toBe(false);
  });

  test("does not let a provenance alias hide a second writer or declaration", () => {
    const typedLocator =
      "packages/demo/src/writers.ts#save:insert:public.memories:1";
    const rawLocator = typedLocator.replace(":insert:", ":raw_sql:insert:");
    const observation = (locator: string) => ({
      operation: "insert" as const,
      table: "public.memories",
      path: "packages/demo/src/writers.ts",
      symbol: "save",
      locator,
    });

    expect(auditDatabaseWriterInventory({
      observations: [observation(typedLocator), observation(rawLocator)],
      declaredLocators: [typedLocator],
    }).unknown).toEqual([rawLocator]);
    expect(auditDatabaseWriterInventory({
      observations: [observation(typedLocator)],
      declaredLocators: [typedLocator, rawLocator],
    }).stale).toEqual([rawLocator]);
    expect(auditDatabaseWriterInventory({
      observations: [observation(typedLocator), observation(rawLocator)],
      declaredLocators: [typedLocator, rawLocator],
    }).errors).toEqual([]);
  });

  test("records non-locally-reducible DB raw SQL inputs instead of dropping them", async () => {
    const root = fixtureRoot(`
      import { importedStatement } from "./imported-sql";

      type DirectDatabase = {
        execute(statement: unknown): Promise<unknown>;
      };

      export async function importedWriter(db: DirectDatabase) {
        await db.execute(importedStatement, "non-sql-option");
      }

      export async function functionWriter(db: DirectDatabase) {
        await db.execute(buildMutation());
      }

      export async function propertyWriter(db: DirectDatabase, config: any) {
        await db.execute(config.statement);
      }

      export async function spreadWriter(db: DirectDatabase, statements: any[]) {
        await db.execute(...statements);
      }

      export async function lookalike(executor: any, dynamicTask: unknown) {
        await executor.execute(dynamicTask);
      }
    `);

    const unresolvedObservations = await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    });
    expect(unresolvedObservations).toEqual([
      {
        operation: "unresolved",
        table: "unresolved.dynamic_sql",
        path: "packages/demo/src/writers.ts",
        symbol: "functionWriter",
        locator:
          "packages/demo/src/writers.ts#functionWriter:raw_sql:unresolved:unresolved.dynamic_sql:1",
      },
      {
        operation: "unresolved",
        table: "unresolved.dynamic_sql",
        path: "packages/demo/src/writers.ts",
        symbol: "importedWriter",
        locator:
          "packages/demo/src/writers.ts#importedWriter:raw_sql:unresolved:unresolved.dynamic_sql:1",
      },
      {
        operation: "unresolved",
        table: "unresolved.dynamic_sql",
        path: "packages/demo/src/writers.ts",
        symbol: "propertyWriter",
        locator:
          "packages/demo/src/writers.ts#propertyWriter:raw_sql:unresolved:unresolved.dynamic_sql:1",
      },
      {
        operation: "unresolved",
        table: "unresolved.dynamic_sql",
        path: "packages/demo/src/writers.ts",
        symbol: "spreadWriter",
        locator:
          "packages/demo/src/writers.ts#spreadWriter:raw_sql:unresolved:unresolved.dynamic_sql:1",
      },
    ]);
    expect(auditDatabaseWriterInventory({
      observations: unresolvedObservations,
      declaredLocators: [],
    })).toMatchObject({
      ok: false,
      unknown: unresolvedObservations.map((item) => item.locator),
      stale: [],
    });
  });

  test("does not treat ordinary non-DB execute methods as raw SQL transports", async () => {
    const root = fixtureRoot(`
      export async function runJob(
        executor: { execute(task: unknown): Promise<unknown> },
        dynamicTask: unknown,
      ) {
        await executor.execute(dynamicTask);
      }

      export async function querySearch(
        searchClient: { query(value: unknown): Promise<unknown> },
        dynamicQuery: unknown,
      ) {
        await searchClient.query(dynamicQuery);
      }
    `);

    expect(await discoverDatabaseWriterInventory(root, {})).toEqual([]);
  });

  test("requires every raw writer debt declaration to have its exact owner and closure", () => {
    const locator =
      "packages/demo/src/writers.ts#write:raw_sql:update:public.messages:1";
    const observations = [{
      operation: "update" as const,
      table: "public.messages",
      path: "packages/demo/src/writers.ts",
      symbol: "write",
      locator,
    }];

    expect(auditRawDatabaseWriterDebt({
      observations,
      declarations: [{
        id: "debt.db.raw-writer.wrong",
        surface: "wire",
        locator,
        owner: "packages/other",
        reason: " ",
        remediationState: "planned",
        releaseImpact: "blocks_enabled_scope",
        evidenceGap: " ",
      }],
    })).toEqual({
      ok: false,
      errors: [
        `raw database writer debt id mismatch: ${locator}`,
        `raw database writer debt must block the whole-product claim: ${locator}`,
        `raw database writer debt must start untriaged: ${locator}`,
        `raw database writer debt must use db surface: ${locator}`,
        `raw database writer debt owner mismatch: ${locator} expected packages/demo, received packages/other`,
        `raw database writer debt requires an evidence gap: ${locator}`,
        `raw database writer debt requires a reason: ${locator}`,
      ].sort(),
    });
    expect(rawDatabaseWriterDebtId(locator)).toMatch(
      /^debt[.]db[.]raw-writer[.][a-z0-9]+$/u,
    );
  });

  test("includes representative runtime and operator raw mutation paths", async () => {
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

    expect(observations.some((item) =>
      item.path === "packages/agent/src/store/memory-store.ts"
      && item.operation === "update"
      && item.table === "public.memories"
      && !item.locator.includes(":raw_sql:")
    )).toBe(true);
    expect(observations.some((item) =>
      item.path === "packages/trust/src/read-state.ts"
      && item.operation === "insert"
      && item.table === "public.session_message_recipient_state"
      && !item.locator.includes(":raw_sql:")
    )).toBe(true);
    expect(observations.some((item) =>
      (
        item.path === "deploy/compose-driver/src/ComposeDriver.ts"
        || item.path.startsWith("bin/nautilo-dev/src/")
      )
      && item.locator.includes(":raw_sql:")
    )).toBe(true);
  });

  test("resolves local and chained aliases of imported tables", async () => {
    const root = fixtureRoot(`
      import { messages } from "@nautilo/db/schema";

      const moduleAlias = messages;
      const chainedAlias = moduleAlias as typeof messages;

      export async function createMessage(db: any) {
        const localAlias = chainedAlias;
        await db.insert(localAlias).values({ content: "secret" });
      }
    `);

    expect(await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    })).toEqual([{
      operation: "insert",
      table: "public.messages",
      path: "packages/demo/src/writers.ts",
      symbol: "createMessage",
      locator:
        "packages/demo/src/writers.ts#createMessage:insert:public.messages:1",
    }]);
  });

  test("does not promote a table alias name that is shadowed in another scope", async () => {
    const root = fixtureRoot(`
      import { messages } from "@nautilo/db/schema";

      export async function realWriter(db: any) {
        const selected = messages;
        await db.insert(selected).values({ content: "secret" });
      }

      export async function lookalike(db: any) {
        const selected = { cache: true };
        await db.insert(selected).values({ content: "not a table" });
      }
    `);

    expect(await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    })).toEqual([{
      operation: "insert",
      table: "public.messages",
      path: "packages/demo/src/writers.ts",
      symbol: "realWriter",
      locator:
        "packages/demo/src/writers.ts#realWriter:insert:public.messages:1",
    }]);
  });

  test.each(["insert", "update", "delete"] as const)(
    "fails closed when a new %s writer targets an existing table",
    async (operation) => {
      const chain = operation === "insert"
        ? ".values({ content: payload })"
        : operation === "update"
          ? ".set({ content: payload })"
          : "";
      const root = fixtureRoot(`
        import { messages } from "@nautilo/db";
        export async function existingWriter(db: any, payload: string) {
          await db.${operation}(messages)${chain};
        }
        export async function newlyAddedWriter(db: any, payload: string) {
          await db.${operation}(messages)${chain};
        }
      `);
      const observations = await discoverDatabaseWriterInventory(root, {
        messages: "public.messages",
      });
      const inspection = auditDatabaseWriterInventory({
        observations,
        declaredLocators: [
          `packages/demo/src/writers.ts#existingWriter:${operation}:public.messages:1`,
        ],
      });

      expect(inspection.ok).toBe(false);
      expect(inspection.unknown).toEqual([
        `packages/demo/src/writers.ts#newlyAddedWriter:${operation}:public.messages:1`,
      ]);
      expect(inspection.stale).toEqual([]);
    },
  );

  test("fails when a reviewed writer disappears", async () => {
    const root = fixtureRoot(`
      import { messages } from "@nautilo/db";
      export async function liveWriter(db: any) {
        await db.insert(messages).values({ content: "secret" });
      }
    `);
    const observations = await discoverDatabaseWriterInventory(root, {
      messages: "public.messages",
    });
    const inspection = auditDatabaseWriterInventory({
      observations,
      declaredLocators: [
        "packages/demo/src/writers.ts#liveWriter:insert:public.messages:1",
        "packages/demo/src/writers.ts#removedWriter:update:public.messages:1",
      ],
    });

    expect(inspection.ok).toBe(false);
    expect(inspection.unknown).toEqual([]);
    expect(inspection.stale).toEqual([
      "packages/demo/src/writers.ts#removedWriter:update:public.messages:1",
    ]);
  });
});
