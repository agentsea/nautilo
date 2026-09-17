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
import {
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";
import { MIGRATION_TREE_BASELINE } from "../../baseline/inventory-fingerprints";
import {
  compareSchemaAndMigrationInventory,
  inventoryMigrationTree,
} from "../../src/node/migration-inventory";

const temporaryDirectories: string[] = [];

function temporaryMigrationTree(name: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), `m220 ${name} `));
  temporaryDirectories.push(directory);
  mkdirSync(resolve(directory, "meta"), { recursive: true });
  return directory;
}

function writeJournal(
  directory: string,
  entries: readonly { idx: number; tag: string; when?: number }[],
): void {
  writeFileSync(
    resolve(directory, "meta/_journal.json"),
    `${JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry) => ({
        version: "7",
        breakpoints: true,
        when: entry.when ?? 1,
        ...entry,
      })),
    }, null, 2)}\n`,
  );
}

function writeSnapshot(
  directory: string,
  index: number,
  tables: Record<string, readonly {
    name: string;
    type: string;
    notNull?: boolean;
    generated?: unknown;
    default?: unknown;
    primaryKey?: boolean;
  }[]>,
  tableSemantics: Readonly<Record<string, {
    compositePrimaryKeys?: Readonly<Record<string, {
      name: string;
      columns: readonly string[];
    }>>;
    uniqueConstraints?: Readonly<Record<string, {
      name: string;
      columns: readonly string[];
      nullsNotDistinct?: boolean;
    }>>;
    indexes?: Readonly<Record<string, {
      name: string;
      columns: readonly {
        expression: string;
        isExpression: boolean;
        asc: boolean;
        nulls: string;
      }[];
      isUnique: boolean;
      where?: string;
      concurrently?: boolean;
      method?: string;
      with?: Readonly<Record<string, string>>;
    }>>;
    foreignKeys?: Readonly<Record<string, {
      name: string;
      tableFrom: string;
      tableTo: string;
      columnsFrom: readonly string[];
      columnsTo: readonly string[];
      onDelete?: string;
      onUpdate?: string;
    }>>;
  }>> = {},
): void {
  writeFileSync(
    resolve(directory, `meta/${String(index).padStart(4, "0")}_snapshot.json`),
    `${JSON.stringify({
      id: `snapshot-${index}`,
      prevId: index === 0 ? "00000000-0000-0000-0000-000000000000" : "snapshot-0",
      version: "7",
      dialect: "postgresql",
      tables: Object.fromEntries(
        Object.entries(tables).map(([table, columns]) => [
          table,
          {
            name: table.split(".").at(-1),
            schema: table.split(".")[0],
            columns: Object.fromEntries(columns.map((column) => [
              column.name,
              {
                name: column.name,
                type: column.type,
                primaryKey: column.primaryKey ?? false,
                notNull: column.notNull ?? false,
                ...(column.default === undefined
                  ? {}
                  : { default: column.default }),
                ...(column.generated === undefined
                  ? {}
                  : { generated: column.generated }),
              },
            ])),
            compositePrimaryKeys:
              tableSemantics[table]?.compositePrimaryKeys ?? {},
            uniqueConstraints:
              tableSemantics[table]?.uniqueConstraints ?? {},
            indexes: tableSemantics[table]?.indexes ?? {},
            foreignKeys: tableSemantics[table]?.foreignKeys ?? {},
          },
        ]),
      ),
    }, null, 2)}\n`,
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration inventory", () => {
  test("enumerates the actual journal, SQL bijection, and current snapshot without a DB", () => {
    const directory = resolve(import.meta.dir, "../../../db/src/migrations");
    const inventory = inventoryMigrationTree(directory);

    expect(inventory.migrations).toHaveLength(MIGRATION_TREE_BASELINE.migrations);
    expect(inventory.snapshots).toHaveLength(MIGRATION_TREE_BASELINE.snapshots);
    expect(inventory.missingSnapshotIndices).toHaveLength(29);
    expect(inventory.missingSnapshotIndices).toContain(6);
    expect(inventory.missingSnapshotIndices).toContain(118);
    expect(inventory.latestSnapshotIndex).toBe(MIGRATION_TREE_BASELINE.tip);
    expect(inventory.currentTables).toHaveLength(206);
    expect(inventory.currentTables).toContainEqual({
      id: "db.public.session_messages",
      surface: "db",
      locator: "public.session_messages",
      schema: "public",
      name: "session_messages",
    });
    expect(inventory.currentColumns).toHaveLength(2_769);
    expect(inventory.currentConstraints).toHaveLength(778);
    expect(inventory.currentConstraints).toContainEqual({
      locator: "public.actors#foreign_key:actors_owner_id_users_id_fk",
      tableLocator: "public.actors",
      kind: "foreign_key",
      name: "actors_owner_id_users_id_fk",
      columns: ["owner_id"],
      referencedTable: "public.users",
      referencedColumns: ["id"],
      onDelete: "cascade",
      onUpdate: "no action",
    });
    expect(inventory.historicalCreatedTables).toHaveLength(222);
    expect(inventory.historicalDroppedTables).toEqual([
      "public.collaboration_sessions",
      "public.grant_domain_envelope_acknowledgements",
      "public.grant_domain_heads",
      "public.grant_domain_publication_operations",
      "public.grant_domain_recipient_authorization_operations",
      "public.grant_domain_recipient_envelopes",
      "public.grant_domain_recipient_sync_campaigns",
      "public.namespace_grant_domain_bindings",
      "public.namespace_grant_domain_heads",
      "public.namespace_key_envelope_acknowledgements",
      "public.namespace_key_generation_heads",
      "public.namespace_key_publication_operations",
      "public.namespace_key_recipient_authorization_operations",
      "public.namespace_key_recipient_envelopes",
      "public.namespace_key_recipient_sync_campaigns",
      "public.remote_controller_request_nonces",
      "public.remote_host_selections",
      "public.remote_run_bindings",
      "public.remote_run_commands",
      "public.remote_run_jobs",
      "public.user_agent_preferences",
    ]);
    expect(inventory.currentColumns.filter((column) =>
      [
        "public.room_journal_state.rebuild_generation",
        "public.room_journal_state.rebuild_requested_at",
        "public.room_journal_state.rebuild_target_message_id",
        "public.session_messages.edit_revision",
        "public.session_messages.edited_at",
      ].includes(column.locator)
    ).map((column) => column.locator)).toEqual([
      "public.room_journal_state.rebuild_generation",
      "public.room_journal_state.rebuild_requested_at",
      "public.room_journal_state.rebuild_target_message_id",
      "public.session_messages.edit_revision",
      "public.session_messages.edited_at",
    ]);
    expect(inventory.currentColumns.find((column) =>
      column.locator === "public.memories.crypto_object_id"
    )).toMatchObject({
      locator: "public.memories.crypto_object_id",
      sqlType: "text",
      notNull: false,
    });
    expect(inventory.currentColumns.find((column) =>
      column.locator === "public.memory_crypto_revisions.memory_id"
    )).toMatchObject({
      locator: "public.memory_crypto_revisions.memory_id",
      sqlType: "uuid",
      notNull: true,
    });
    expect(inventory.currentColumns.find((column) =>
      column.locator === "public.memory_crypto_operations.operation_id"
    )).toMatchObject({
      locator: "public.memory_crypto_operations.operation_id",
      sqlType: "text",
      notNull: true,
    });
    // These immutable historical bytes remain pinned as new migrations append.
    // The reviewed full-tree fingerprint covers the later tail separately.
    expect(inventory.migrations.slice(264, 284)).toEqual([
      {
        "index": 264,
        "tag": "0264_complete_skreet",
        "path": "0264_complete_skreet.sql",
        "sha256": "f1569a6f7d02b247df20d75f0fd51688f1c8d2f0585023fddc89d4b6b04cb3b2"
      },
      {
        "index": 265,
        "tag": "0265_sweet_tarantula",
        "path": "0265_sweet_tarantula.sql",
        "sha256": "62b42e98c6fff940f67776b116f01d174cd148991105565c75a88266efdd1510"
      },
      {
        "index": 266,
        "tag": "0266_naive_wallflower",
        "path": "0266_naive_wallflower.sql",
        "sha256": "b3dfe2a6e9ade53f49e131759db2f199638304d5eb2f34928f22c5677855aac6"
      },
      {
        "index": 267,
        "tag": "0267_polite_paladin",
        "path": "0267_polite_paladin.sql",
        "sha256": "56eecbe4e160f8dd0bd87dda4268a5500e0df7f33c636d06241b91bdcdc1489a"
      },
      {
        "index": 268,
        "tag": "0268_gifted_strong_guy",
        "path": "0268_gifted_strong_guy.sql",
        "sha256": "fee58b58d765bdf4023dc860862f6fb90bf17f6af025aa3f2a77f655bbc4da71"
      },
      {
        "index": 269,
        "tag": "0269_aberrant_changeling",
        "path": "0269_aberrant_changeling.sql",
        "sha256": "4153962600f60d2eee75cec123917d0d0977515cbdb515dff50f673a106694cb"
      },
      {
        "index": 270,
        "tag": "0270_repair_memory_agent_semantic_grant",
        "path": "0270_repair_memory_agent_semantic_grant.sql",
        "sha256": "3a3e77ca00aa0785808a5818d8a1f39099209f1f16cd523339d8f66f17e63c8a"
      },
      {
        "index": 271,
        "tag": "0271_m314_public_room_message_authority",
        "path": "0271_m314_public_room_message_authority.sql",
        "sha256": "581894ce696a99e60880098db8bc15aaed33cd100de55769093bd0c8936fe992"
      },
      {
        "index": 272,
        "tag": "0272_m314_participant_set_authority",
        "path": "0272_m314_participant_set_authority.sql",
        "sha256": "498d83afbdcecf5634b24b75d176a4fe971deef4a4e09b2fe4ab5397ffa7d81b"
      },
      {
        "index": 273,
        "tag": "0273_breezy_marvel_apes",
        "path": "0273_breezy_marvel_apes.sql",
        "sha256": "497b6024a1279b5d1b0c522f964a0816545ca0bd0d1917c69ed98a9f700804e9"
      },
      {
        "index": 274,
        "tag": "0274_kind_wind_dancer",
        "path": "0274_kind_wind_dancer.sql",
        "sha256": "5e6f9ca998d39b061a06853ac23701468ecbd0e2ad968d592b04ef96b8af8d26"
      },
      {
        "index": 275,
        "tag": "0275_open_titanium_man",
        "path": "0275_open_titanium_man.sql",
        "sha256": "52fe560f01b3381901e573c86875205f6763a81bdaa36d57602e863a627b1d0c"
      },
      {
        "index": 276,
        "tag": "0276_tearful_dragon_lord",
        "path": "0276_tearful_dragon_lord.sql",
        "sha256": "5b5f26b9f68d0524bdcd82e4b4c2b06c661e556d8377511cb2c0fb881043d190"
      },
      {
        "index": 277,
        "tag": "0277_brainy_sentinels",
        "path": "0277_brainy_sentinels.sql",
        "sha256": "62a34533abf10586dd35eed824c0e99dc6ef547e8d87707ca2c635fda18e58a7"
      },
      {
        "index": 278,
        "tag": "0278_aspiring_sugar_man",
        "path": "0278_aspiring_sugar_man.sql",
        "sha256": "b18aed043c43fe28618eae2ead621a24d041ee364869ce88f3ff8e796f16fed2"
      },
      {
        "index": 279,
        "tag": "0279_early_killraven",
        "path": "0279_early_killraven.sql",
        "sha256": "0c6301fd5083849d6e74be013e807cf7bf1cfff8e901177275b8173963a4cc8d"
      },
      {
        "index": 280,
        "tag": "0280_gigantic_spyke",
        "path": "0280_gigantic_spyke.sql",
        "sha256": "f2b72308996fcdff89990695cf840385ebbd434573e572e9f3f45d2d3b2dafcf"
      },
      {
        "index": 281,
        "tag": "0281_melodic_sister_grimm",
        "path": "0281_melodic_sister_grimm.sql",
        "sha256": "c69931263fcd2a17604881976002d3b2ce63d51c8264da4033ca04edcce0b8a7"
      },
      {
        "index": 282,
        "tag": "0282_content_access_receipt_immutability",
        "path": "0282_content_access_receipt_immutability.sql",
        // The new repository's initial commit adds a temporary TRIGGER grant
        // around creation and revokes it afterward; the old-repository hash
        // was copied into this test unchanged. No migration is edited here.
        "sha256": "c9d57e7399b6b071b21efbd22a1dc47f0e219830eab10103efd0fb0b6bded3ca"
      },
      {
        "index": 283,
        "tag": "0283_long_speed",
        "path": "0283_long_speed.sql",
        "sha256": "3da5958212ad7124bdd11c77cce537ff6f99fd4f64057eef810d7c78f540bea2"
      }
    ]);
    expect(inventory.migrations.every((migration) => !migration.path.startsWith("/")))
      .toBe(true);

    const comparison = compareSchemaAndMigrationInventory(
      inventoryDrizzleSchema(nautiloSchema),
      inventory,
    );
    expect(comparison).toEqual({
      missingTablesInMigration: [],
      missingTablesInSchema: [],
      missingInMigration: [],
      missingInSchema: [],
      columnMismatches: [],
      constraintMismatches: [],
    });
  });

  test("allows intentionally missing intermediate snapshots and paths containing spaces", () => {
    const directory = temporaryMigrationTree("snapshot gaps");
    writeJournal(directory, [
      { idx: 0, tag: "0000_first", when: 20 },
      { idx: 1, tag: "0001_second", when: 10 },
    ]);
    writeFileSync(resolve(directory, "0000_first.sql"), 'CREATE TABLE "alpha" ("id" text);\n');
    writeFileSync(resolve(directory, "0001_second.sql"), 'ALTER TABLE "alpha" ADD COLUMN "body" text;\n');
    writeSnapshot(directory, 1, {
      "public.alpha": [
        { name: "id", type: "text" },
        { name: "body", type: "text" },
      ],
    });

    const first = inventoryMigrationTree(directory);
    const second = inventoryMigrationTree(directory);

    expect(first).toEqual(second);
    expect(first.missingSnapshotIndices).toEqual([0]);
    expect(first.currentColumns.map((column) => column.locator)).toEqual([
      "public.alpha.body",
      "public.alpha.id",
    ]);
    expect(first.currentTables).toEqual([{
      id: "db.public.alpha",
      surface: "db",
      locator: "public.alpha",
      schema: "public",
      name: "alpha",
    }]);
    expect(JSON.stringify(first)).not.toContain(directory);
  });

  test("rejects journal/SQL drift, non-contiguous indices, and a missing tail snapshot", () => {
    const missingSql = temporaryMigrationTree("missing sql");
    writeJournal(missingSql, [{ idx: 0, tag: "0000_missing" }]);
    writeSnapshot(missingSql, 0, {});
    expect(() => inventoryMigrationTree(missingSql)).toThrow(
      "Journal tag has no matching SQL file: 0000_missing",
    );

    const unjournaled = temporaryMigrationTree("unjournaled sql");
    writeJournal(unjournaled, [{ idx: 0, tag: "0000_known" }]);
    writeFileSync(resolve(unjournaled, "0000_known.sql"), "-- known\n");
    writeFileSync(resolve(unjournaled, "0001_unknown.sql"), "-- unknown\n");
    writeSnapshot(unjournaled, 0, {});
    expect(() => inventoryMigrationTree(unjournaled)).toThrow(
      "SQL file has no matching journal entry: 0001_unknown.sql",
    );

    const indexGap = temporaryMigrationTree("index gap");
    writeJournal(indexGap, [
      { idx: 0, tag: "0000_first" },
      { idx: 2, tag: "0002_third" },
    ]);
    writeFileSync(resolve(indexGap, "0000_first.sql"), "-- first\n");
    writeFileSync(resolve(indexGap, "0002_third.sql"), "-- third\n");
    writeSnapshot(indexGap, 2, {});
    expect(() => inventoryMigrationTree(indexGap)).toThrow(
      "Migration journal indices must be contiguous from zero",
    );

    const missingTail = temporaryMigrationTree("missing tail snapshot");
    writeJournal(missingTail, [
      { idx: 0, tag: "0000_first" },
      { idx: 1, tag: "0001_second" },
    ]);
    writeFileSync(resolve(missingTail, "0000_first.sql"), "-- first\n");
    writeFileSync(resolve(missingTail, "0001_second.sql"), "-- second\n");
    writeSnapshot(missingTail, 0, {});
    expect(() => inventoryMigrationTree(missingTail)).toThrow(
      "Latest migration index 1 has no generated tail snapshot",
    );

    const duplicatePrimaryKey = temporaryMigrationTree("duplicate primary key");
    writeJournal(duplicatePrimaryKey, [{ idx: 0, tag: "0000_duplicate" }]);
    writeFileSync(resolve(duplicatePrimaryKey, "0000_duplicate.sql"), "-- duplicate\n");
    writeSnapshot(duplicatePrimaryKey, 0, {
      "public.duplicate": [{
        name: "id",
        type: "uuid",
        primaryKey: true,
      }],
    }, {
      "public.duplicate": {
        compositePrimaryKeys: {
          duplicate_id_pk: {
            name: "duplicate_id_pk",
            columns: ["id"],
          },
        },
      },
    });
    expect(() => inventoryMigrationTree(duplicatePrimaryKey)).toThrow(
      "Duplicate migration constraint locators: public.duplicate#primary_key",
    );
  });

  test("distinguishes historical create/drop events from the current migrated state", () => {
    const directory = temporaryMigrationTree("historical ddl");
    writeJournal(directory, [
      { idx: 0, tag: "0000_create" },
      { idx: 1, tag: "0001_drop" },
    ]);
    writeFileSync(
      resolve(directory, "0000_create.sql"),
      'CREATE TABLE IF NOT EXISTS "temporary_data" ("secret" text);\n',
    );
    writeFileSync(
      resolve(directory, "0001_drop.sql"),
      'DROP TABLE IF EXISTS "temporary_data";\n',
    );
    writeSnapshot(directory, 1, {});

    const inventory = inventoryMigrationTree(directory);
    expect(inventory.historicalCreatedTables).toEqual(["public.temporary_data"]);
    expect(inventory.historicalDroppedTables).toEqual(["public.temporary_data"]);
    expect(inventory.currentTables).toEqual([]);
    expect(inventory.currentColumns).toEqual([]);
  });

  test("detects table drift even when neither side has columns", () => {
    const directory = temporaryMigrationTree("table only drift");
    writeJournal(directory, [{ idx: 0, tag: "0000_create" }]);
    writeFileSync(
      resolve(directory, "0000_create.sql"),
      'CREATE TABLE "migration_only" ();\n',
    );
    writeSnapshot(directory, 0, {
      "public.migration_only": [],
    });

    const comparison = compareSchemaAndMigrationInventory(
      inventoryDrizzleSchema({
        schemaOnly: pgTable("schema_only", {}),
      }),
      inventoryMigrationTree(directory),
    );

    expect(comparison).toEqual({
      missingTablesInMigration: ["public.schema_only"],
      missingTablesInSchema: ["public.migration_only"],
      missingInMigration: [],
      missingInSchema: [],
      columnMismatches: [],
      constraintMismatches: [],
    });
  });

  test("detects sql type, nullability, and generated-column drift", () => {
    const directory = temporaryMigrationTree("column semantic drift");
    writeJournal(directory, [{ idx: 0, tag: "0000_create" }]);
    writeFileSync(
      resolve(directory, "0000_create.sql"),
      'CREATE TABLE "documents" ("body" varchar(64));\n',
    );
    writeSnapshot(directory, 0, {
      "public.documents": [{
        name: "body",
        type: "varchar(64)",
        notNull: false,
        generated: { as: "lower(body)", type: "stored" },
      }],
    });

    const comparison = compareSchemaAndMigrationInventory(
      inventoryDrizzleSchema({
        documents: pgTable("documents", {
          body: text("body").notNull(),
        }),
      }),
      inventoryMigrationTree(directory),
    );

    expect(comparison.columnMismatches).toEqual([{
      locator: "public.documents.body",
      schema: {
        sqlType: "text",
        notNull: true,
        generated: false,
        defaultSql: null,
        primaryKey: false,
      },
      migration: {
        sqlType: "varchar(64)",
        notNull: false,
        generated: true,
        defaultSql: null,
        primaryKey: false,
      },
    }]);
  });

  test("detects defaults, primary keys, uniqueness, and foreign-key semantic drift", () => {
    const directory = temporaryMigrationTree("constraint semantic drift");
    writeJournal(directory, [{ idx: 0, tag: "0000_create" }]);
    writeFileSync(resolve(directory, "0000_create.sql"), "-- fixture\n");
    writeSnapshot(directory, 0, {
      "public.parents": [{
        name: "id",
        type: "uuid",
        notNull: true,
        primaryKey: false,
      }],
      "public.children": [
        {
          name: "id",
          type: "uuid",
          notNull: true,
          primaryKey: false,
          default: "gen_random_uuid()",
        },
        {
          name: "parent_id",
          type: "uuid",
          notNull: true,
        },
        {
          name: "tenant_id",
          type: "uuid",
          notNull: true,
        },
        {
          name: "slug",
          type: "text",
          notNull: true,
          default: "'migration-default'",
        },
      ],
    }, {
      "public.children": {
        compositePrimaryKeys: {
          children_id_tenant_id_pk: {
            name: "children_id_tenant_id_pk",
            columns: ["tenant_id", "id"],
          },
        },
        uniqueConstraints: {
          children_slug_unique: {
            name: "children_slug_unique",
            columns: ["tenant_id", "slug"],
            nullsNotDistinct: false,
          },
        },
        indexes: {
          children_parent_id_unique: {
            name: "children_parent_id_unique",
            columns: [{
              expression: "slug",
              isExpression: false,
              asc: true,
              nulls: "last",
            }],
            isUnique: true,
            method: "btree",
            concurrently: false,
            with: {},
          },
        },
        foreignKeys: {
          children_parent_id_parents_id_fk: {
            name: "children_parent_id_parents_id_fk",
            tableFrom: "children",
            tableTo: "parents",
            columnsFrom: ["parent_id"],
            columnsTo: ["id"],
            onDelete: "restrict",
            onUpdate: "no action",
          },
        },
      },
    });

    const parents = pgTable("parents", {
      id: uuid("id").primaryKey(),
    });
    const children = pgTable("children", {
      id: uuid("id").defaultRandom().notNull(),
      parentId: uuid("parent_id").notNull().references(
        () => parents.id,
        { onDelete: "cascade" },
      ),
      tenantId: uuid("tenant_id").notNull(),
      slug: text("slug").notNull().default("schema-default"),
    }, (table) => [
      primaryKey({
        name: "children_id_tenant_id_pk",
        columns: [table.id, table.tenantId],
      }),
      unique("children_slug_unique").on(table.slug),
      uniqueIndex("children_parent_id_unique").on(table.parentId),
    ]);

    const comparison = compareSchemaAndMigrationInventory(
      inventoryDrizzleSchema({ parents, children }),
      inventoryMigrationTree(directory),
    );

    expect(comparison.columnMismatches.map((item) => item.locator)).toEqual([
      "public.children.slug",
      "public.parents.id",
    ]);
    expect(comparison.columnMismatches).toContainEqual({
      locator: "public.children.slug",
      schema: {
        sqlType: "text",
        notNull: true,
        generated: false,
        defaultSql: "'schema-default'",
        primaryKey: false,
      },
      migration: {
        sqlType: "text",
        notNull: true,
        generated: false,
        defaultSql: "'migration-default'",
        primaryKey: false,
      },
    });
    expect(comparison.constraintMismatches.map((item) => item.locator)).toEqual([
      "public.children#foreign_key:children_parent_id_parents_id_fk",
      "public.children#primary_key",
      "public.children#unique_constraint:children_slug_unique",
      "public.children#unique_index:children_parent_id_unique",
      "public.parents#primary_key",
    ]);
  });
});
