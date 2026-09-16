import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

import type { InventoryObservation } from "../registry";
import type {
  DrizzleSchemaInventory,
  IndexColumnSemantics,
  SchemaConstraintObservation,
} from "./schema-inventory";

type MigrationJournalEntry = {
  readonly idx: number;
  readonly tag: string;
};

type MigrationJournal = {
  readonly entries: readonly MigrationJournalEntry[];
};

type SnapshotColumn = {
  readonly name: string;
  readonly type: string;
  readonly notNull?: boolean;
  readonly generated?: unknown;
  readonly default?: unknown;
  readonly primaryKey?: boolean;
};

type SnapshotPrimaryKey = {
  readonly name: string;
  readonly columns: readonly string[];
};

type SnapshotUniqueConstraint = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly nullsNotDistinct?: boolean;
};

type SnapshotIndex = {
  readonly name: string;
  readonly columns: readonly IndexColumnSemantics[];
  readonly isUnique?: boolean;
  readonly where?: string;
  readonly concurrently?: boolean;
  readonly method?: string;
  readonly with?: Readonly<Record<string, unknown>>;
};

type SnapshotForeignKey = {
  readonly name: string;
  readonly tableTo: string;
  readonly schemaTo?: string;
  readonly columnsFrom: readonly string[];
  readonly columnsTo: readonly string[];
  readonly onDelete?: string;
  readonly onUpdate?: string;
};

type SnapshotTable = {
  readonly name?: string;
  readonly schema?: string;
  readonly columns?: Readonly<Record<string, SnapshotColumn>>;
  readonly compositePrimaryKeys?: Readonly<Record<string, SnapshotPrimaryKey>>;
  readonly uniqueConstraints?: Readonly<Record<string, SnapshotUniqueConstraint>>;
  readonly indexes?: Readonly<Record<string, SnapshotIndex>>;
  readonly foreignKeys?: Readonly<Record<string, SnapshotForeignKey>>;
};

type MigrationSnapshot = {
  readonly tables?: Readonly<Record<string, SnapshotTable>>;
};

export type MigrationFileObservation = {
  readonly index: number;
  readonly tag: string;
  readonly path: string;
  readonly sha256: string;
};

export type MigrationSnapshotObservation = {
  readonly index: number;
  readonly path: string;
  readonly sha256: string;
};

export type MigratedTableObservation = InventoryObservation & {
  readonly surface: "db";
  readonly schema: string;
  readonly name: string;
  readonly locator: string;
};

export type MigratedColumnObservation = InventoryObservation & {
  readonly surface: "db";
  readonly schema: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly generated: boolean;
  readonly defaultSql: string | null;
  readonly primaryKey: boolean;
};

export type MigrationTreeInventory = {
  readonly migrations: readonly MigrationFileObservation[];
  readonly snapshots: readonly MigrationSnapshotObservation[];
  readonly missingSnapshotIndices: readonly number[];
  readonly latestSnapshotIndex: number;
  readonly currentTables: readonly MigratedTableObservation[];
  readonly currentColumns: readonly MigratedColumnObservation[];
  readonly currentConstraints: readonly SchemaConstraintObservation[];
  readonly historicalCreatedTables: readonly string[];
  readonly historicalDroppedTables: readonly string[];
};

export type SchemaMigrationComparison = {
  readonly missingTablesInMigration: readonly string[];
  readonly missingTablesInSchema: readonly string[];
  readonly missingInMigration: readonly string[];
  readonly missingInSchema: readonly string[];
  readonly columnMismatches: readonly SchemaMigrationColumnMismatch[];
  readonly constraintMismatches: readonly SchemaMigrationConstraintMismatch[];
};

export type SchemaMigrationColumnSemantics = {
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly generated: boolean;
  readonly defaultSql: string | null;
  readonly primaryKey: boolean;
};

export type SchemaMigrationColumnMismatch = {
  readonly locator: string;
  readonly schema: SchemaMigrationColumnSemantics;
  readonly migration: SchemaMigrationColumnSemantics;
};

export type SchemaMigrationConstraintMismatch = {
  readonly locator: string;
  readonly schema: SchemaConstraintObservation | null;
  readonly migration: SchemaConstraintObservation | null;
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`Invalid migration JSON: ${path.split("/").at(-1)}`, {
      cause: error,
    });
  }
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates].sort(compareText);
}

function sortedRecord(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => compareText(left, right)),
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function sameSemantics(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function snapshotDefaultSql(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
    || typeof value === "boolean"
  ) {
    return String(value);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Unsupported migration snapshot default");
  }
  return serialized;
}

function snapshotConstraints(
  identity: { readonly schema: string; readonly name: string },
  table: SnapshotTable,
): SchemaConstraintObservation[] {
  const tableLocator = `${identity.schema}.${identity.name}`;
  const constraints: SchemaConstraintObservation[] = [];
  const inlinePrimaryKeyColumns = Object.values(table.columns ?? {})
    .filter((column) => column.primaryKey === true)
    .map((column) => column.name);
  if (inlinePrimaryKeyColumns.length > 0) {
    constraints.push({
      locator: `${tableLocator}#primary_key`,
      tableLocator,
      kind: "primary_key",
      name: null,
      columns: inlinePrimaryKeyColumns,
    });
  }
  for (const primaryKey of Object.values(table.compositePrimaryKeys ?? {})) {
    constraints.push({
      locator: `${tableLocator}#primary_key`,
      tableLocator,
      kind: "primary_key",
      name: primaryKey.name,
      columns: primaryKey.columns,
    });
  }
  for (const uniqueConstraint of Object.values(table.uniqueConstraints ?? {})) {
    constraints.push({
      locator:
        `${tableLocator}#unique_constraint:${uniqueConstraint.name}`,
      tableLocator,
      kind: "unique_constraint",
      name: uniqueConstraint.name,
      columns: uniqueConstraint.columns,
      nullsNotDistinct: uniqueConstraint.nullsNotDistinct === true,
    });
  }
  for (
    const index of Object.values(table.indexes ?? {})
      .filter((item) => item.isUnique === true)
  ) {
    constraints.push({
      locator: `${tableLocator}#unique_index:${index.name}`,
      tableLocator,
      kind: "unique_index",
      name: index.name,
      columns: index.columns.map((column) => column.expression),
      indexColumns: index.columns.map((column) => ({
        expression: column.expression,
        isExpression: column.isExpression,
        asc: column.asc,
        nulls: column.nulls,
      })),
      where: index.where ?? null,
      method: index.method ?? "btree",
      concurrently: index.concurrently === true,
      with: sortedRecord(index.with),
    });
  }
  for (const foreignKey of Object.values(table.foreignKeys ?? {})) {
    constraints.push({
      locator: `${tableLocator}#foreign_key:${foreignKey.name}`,
      tableLocator,
      kind: "foreign_key",
      name: foreignKey.name,
      columns: foreignKey.columnsFrom,
      referencedTable:
        `${foreignKey.schemaTo ?? identity.schema}.${foreignKey.tableTo}`,
      referencedColumns: foreignKey.columnsTo,
      onDelete: foreignKey.onDelete ?? "no action",
      onUpdate: foreignKey.onUpdate ?? "no action",
    });
  }
  return constraints.sort((left, right) => compareText(left.locator, right.locator));
}

function schemaAndName(
  qualifiedName: string,
  table: SnapshotTable,
): { schema: string; name: string } {
  const separator = qualifiedName.indexOf(".");
  const keySchema = separator >= 0 ? qualifiedName.slice(0, separator) : undefined;
  const keyName = separator >= 0 ? qualifiedName.slice(separator + 1) : qualifiedName;
  return {
    schema: table.schema?.trim() || keySchema || "public",
    name: table.name?.trim() || keyName,
  };
}

function currentSnapshotInventory(snapshot: MigrationSnapshot): {
  tables: MigratedTableObservation[];
  columns: MigratedColumnObservation[];
  constraints: SchemaConstraintObservation[];
} {
  const tables: MigratedTableObservation[] = [];
  const columns: MigratedColumnObservation[] = [];
  const constraints: SchemaConstraintObservation[] = [];

  for (const [qualifiedName, table] of Object.entries(snapshot.tables ?? {})) {
    const identity = schemaAndName(qualifiedName, table);
    const tableLocator = `${identity.schema}.${identity.name}`;
    tables.push({
      id: `db.${tableLocator}`,
      surface: "db",
      ...identity,
      locator: tableLocator,
    });

    for (const column of Object.values(table.columns ?? {})) {
      const locator = `${tableLocator}.${column.name}`;
      columns.push({
        id: `db.${locator}`,
        surface: "db",
        locator,
        schema: identity.schema,
        tableName: identity.name,
        columnName: column.name,
        sqlType: column.type,
        notNull: column.notNull === true,
        generated: column.generated !== undefined,
        defaultSql: snapshotDefaultSql(column.default),
        primaryKey: column.primaryKey === true,
      });
    }
    constraints.push(...snapshotConstraints(identity, table));
  }

  tables.sort((left, right) => compareText(left.locator, right.locator));
  columns.sort((left, right) => compareText(left.locator, right.locator));
  constraints.sort((left, right) => compareText(left.locator, right.locator));
  const duplicateConstraints = duplicateValues(
    constraints.map((constraint) => constraint.locator),
  );
  if (duplicateConstraints.length > 0) {
    throw new Error(
      `Duplicate migration constraint locators: ${duplicateConstraints.join(", ")}`,
    );
  }
  return { tables, columns, constraints };
}

function ddlTableLocators(sql: string, operation: "CREATE" | "DROP"): string[] {
  const expression = new RegExp(
    String.raw`\b${operation}\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+`
      + String.raw`(?:(?:"?([a-z_][a-z0-9_]*)"?)[.])?`
      + String.raw`"?([a-z_][a-z0-9_]*)"?`,
    "giu",
  );
  const locators: string[] = [];
  for (const match of sql.matchAll(expression)) {
    const schema = match[1] ?? "public";
    const name = match[2];
    if (name) locators.push(`${schema}.${name}`);
  }
  return locators;
}

/**
 * Inspect the committed Drizzle migration tree without running Drizzle or
 * connecting to PostgreSQL.
 */
export function inventoryMigrationTree(migrationsDirectory: string): MigrationTreeInventory {
  const journalPath = resolve(migrationsDirectory, "meta/_journal.json");
  const journal = parseJson<MigrationJournal>(journalPath);
  if (journal.entries.length === 0) {
    throw new Error("Migration journal must contain at least one entry");
  }

  const duplicateTags = duplicateValues(journal.entries.map((entry) => entry.tag));
  if (duplicateTags.length > 0) {
    throw new Error(`Duplicate migration journal tags: ${duplicateTags.join(", ")}`);
  }
  if (journal.entries.some((entry, index) => entry.idx !== index)) {
    throw new Error("Migration journal indices must be contiguous from zero");
  }

  const sqlFileNames = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+[.]sql$/u.test(name))
    .sort(compareText);
  const journalFileNames = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  const sqlFileNameSet = new Set(sqlFileNames);

  for (const entry of journal.entries) {
    if (!sqlFileNameSet.has(`${entry.tag}.sql`)) {
      throw new Error(`Journal tag has no matching SQL file: ${entry.tag}`);
    }
  }
  for (const sqlFileName of sqlFileNames) {
    if (!journalFileNames.has(sqlFileName)) {
      throw new Error(`SQL file has no matching journal entry: ${sqlFileName}`);
    }
  }

  const migrationSql = new Map<string, string>();
  const migrations = journal.entries.map((entry): MigrationFileObservation => {
    const path = `${entry.tag}.sql`;
    const contents = readFileSync(resolve(migrationsDirectory, path), "utf8");
    migrationSql.set(entry.tag, contents);
    return {
      index: entry.idx,
      tag: entry.tag,
      path,
      sha256: sha256(contents),
    };
  });

  const snapshotFileNames = readdirSync(resolve(migrationsDirectory, "meta"))
    .filter((name) => /^\d{4}_snapshot[.]json$/u.test(name))
    .sort(compareText);
  const snapshots = snapshotFileNames.map((path): MigrationSnapshotObservation => {
    const contents = readFileSync(resolve(migrationsDirectory, "meta", path), "utf8");
    return {
      index: Number.parseInt(path.slice(0, 4), 10),
      path: `meta/${path}`,
      sha256: sha256(contents),
    };
  });
  const latestMigrationIndex = journal.entries.at(-1)!.idx;
  const latestSnapshot = snapshots.at(-1);
  if (latestSnapshot?.index !== latestMigrationIndex) {
    throw new Error(
      `Latest migration index ${latestMigrationIndex} has no generated tail snapshot`,
    );
  }
  const latestSnapshotIndex = latestSnapshot.index;

  const snapshotIndexSet = new Set(snapshots.map((snapshot) => snapshot.index));
  const missingSnapshotIndices = journal.entries
    .map((entry) => entry.idx)
    .filter((index) => !snapshotIndexSet.has(index));
  const latestSnapshotPath = resolve(
    migrationsDirectory,
    "meta",
    `${String(latestSnapshotIndex).padStart(4, "0")}_snapshot.json`,
  );
  if (!existsSync(latestSnapshotPath)) {
    throw new Error(`Latest migration snapshot is missing: ${latestSnapshotIndex}`);
  }
  const current = currentSnapshotInventory(
    parseJson<MigrationSnapshot>(latestSnapshotPath),
  );

  const historicalCreatedTables = new Set<string>();
  const historicalDroppedTables = new Set<string>();
  for (const sql of migrationSql.values()) {
    for (const locator of ddlTableLocators(sql, "CREATE")) {
      historicalCreatedTables.add(locator);
    }
    for (const locator of ddlTableLocators(sql, "DROP")) {
      historicalDroppedTables.add(locator);
    }
  }

  return {
    migrations,
    snapshots,
    missingSnapshotIndices,
    latestSnapshotIndex,
    currentTables: current.tables,
    currentColumns: current.columns,
    currentConstraints: current.constraints,
    historicalCreatedTables: [...historicalCreatedTables].sort(compareText),
    historicalDroppedTables: [...historicalDroppedTables].sort(compareText),
  };
}

/** Compare only physical tables; exported existing views are intentionally external. */
export function compareSchemaAndMigrationInventory(
  schema: DrizzleSchemaInventory,
  migrations: MigrationTreeInventory,
): SchemaMigrationComparison {
  const schemaTableLocators = new Set(
    schema.objects
      .filter((object) => object.kind === "table")
      .map((object) => object.locator),
  );
  const migrationTableLocators = new Set(
    migrations.currentTables.map((table) => table.locator),
  );
  const schemaLocators = new Set(
    schema.columns
      .filter((column) => column.kind === "table")
      .map((column) => column.locator),
  );
  const migrationLocators = new Set(
    migrations.currentColumns.map((column) => column.locator),
  );
  const schemaColumns = new Map(
    schema.columns
      .filter((column) => column.kind === "table")
      .map((column) => [column.locator, column]),
  );
  const migrationColumns = new Map(
    migrations.currentColumns.map((column) => [column.locator, column]),
  );
  const columnMismatches: SchemaMigrationColumnMismatch[] = [];
  for (const locator of [...schemaLocators].sort(compareText)) {
    const schemaColumn = schemaColumns.get(locator);
    const migrationColumn = migrationColumns.get(locator);
    if (!schemaColumn || !migrationColumn) continue;
    if (
      schemaColumn.sqlType === migrationColumn.sqlType
      && schemaColumn.notNull === migrationColumn.notNull
      && schemaColumn.generated === migrationColumn.generated
      && schemaColumn.defaultSql === migrationColumn.defaultSql
      && schemaColumn.primaryKey === migrationColumn.primaryKey
    ) {
      continue;
    }
    columnMismatches.push({
      locator,
      schema: {
        sqlType: schemaColumn.sqlType,
        notNull: schemaColumn.notNull,
        generated: schemaColumn.generated,
        defaultSql: schemaColumn.defaultSql,
        primaryKey: schemaColumn.primaryKey,
      },
      migration: {
        sqlType: migrationColumn.sqlType,
        notNull: migrationColumn.notNull,
        generated: migrationColumn.generated,
        defaultSql: migrationColumn.defaultSql,
        primaryKey: migrationColumn.primaryKey,
      },
    });
  }
  const schemaConstraints = new Map(
    schema.constraints.map((constraint) => [constraint.locator, constraint]),
  );
  const migrationConstraints = new Map(
    migrations.currentConstraints.map((constraint) => [
      constraint.locator,
      constraint,
    ]),
  );
  const constraintLocators = new Set([
    ...schemaConstraints.keys(),
    ...migrationConstraints.keys(),
  ]);
  const constraintMismatches: SchemaMigrationConstraintMismatch[] = [];
  for (const locator of [...constraintLocators].sort(compareText)) {
    const schemaConstraint = schemaConstraints.get(locator) ?? null;
    const migrationConstraint = migrationConstraints.get(locator) ?? null;
    if (
      schemaConstraint !== null
      && migrationConstraint !== null
      && sameSemantics(schemaConstraint, migrationConstraint)
    ) {
      continue;
    }
    constraintMismatches.push({
      locator,
      schema: schemaConstraint,
      migration: migrationConstraint,
    });
  }
  return {
    missingTablesInMigration: [...schemaTableLocators]
      .filter((locator) => !migrationTableLocators.has(locator))
      .sort(compareText),
    missingTablesInSchema: [...migrationTableLocators]
      .filter((locator) => !schemaTableLocators.has(locator))
      .sort(compareText),
    missingInMigration: [...schemaLocators]
      .filter((locator) => !migrationLocators.has(locator))
      .sort(compareText),
    missingInSchema: [...migrationLocators]
      .filter((locator) => !schemaLocators.has(locator))
      .sort(compareText),
    columnMismatches,
    constraintMismatches,
  };
}
