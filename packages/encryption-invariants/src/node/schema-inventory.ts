import {
  getTableColumns,
  is,
  isTable,
} from "drizzle-orm";
import {
  getTableConfig,
  getViewConfig,
  PgDialect,
  PgView,
} from "drizzle-orm/pg-core";

import type { InventoryObservation } from "../registry";

export type DrizzleSchemaObjectKind = "table" | "view";

export type DrizzleSchemaObjectObservation = InventoryObservation & {
  readonly surface: "db";
  readonly kind: DrizzleSchemaObjectKind;
  readonly schema: string;
  readonly name: string;
  readonly exportNames: readonly string[];
  readonly isExisting: boolean;
};

export type DrizzleColumnObservation = InventoryObservation & {
  readonly surface: "db";
  readonly kind: DrizzleSchemaObjectKind;
  readonly schema: string;
  readonly objectName: string;
  readonly columnName: string;
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly generated: boolean;
  readonly defaultSql: string | null;
  readonly primaryKey: boolean;
};

export type SchemaConstraintKind =
  | "foreign_key"
  | "primary_key"
  | "unique_constraint"
  | "unique_index";

export type IndexColumnSemantics = {
  readonly expression: string;
  readonly isExpression: boolean;
  readonly asc: boolean;
  readonly nulls: string;
};

export type SchemaConstraintObservation = {
  readonly locator: string;
  readonly tableLocator: string;
  readonly kind: SchemaConstraintKind;
  readonly name: string | null;
  readonly columns: readonly string[];
  readonly indexColumns?: readonly IndexColumnSemantics[];
  readonly nullsNotDistinct?: boolean;
  readonly referencedTable?: string;
  readonly referencedColumns?: readonly string[];
  readonly onDelete?: string;
  readonly onUpdate?: string;
  readonly where?: string | null;
  readonly method?: string;
  readonly concurrently?: boolean;
  readonly with?: Readonly<Record<string, unknown>>;
};

export type DrizzleSchemaInventory = {
  readonly objects: readonly DrizzleSchemaObjectObservation[];
  readonly columns: readonly DrizzleColumnObservation[];
  readonly constraints: readonly SchemaConstraintObservation[];
};

type DrizzleColumnLike = {
  readonly name: string;
  readonly notNull?: boolean;
  readonly generated?: unknown;
  readonly default?: unknown;
  readonly hasDefault?: boolean;
  readonly primary?: boolean;
  getSQLType(): string;
};

type MutableObjectObservation = {
  kind: DrizzleSchemaObjectKind;
  schema: string;
  name: string;
  exportNames: string[];
  isExisting: boolean;
  source: unknown;
  columns: readonly DrizzleColumnLike[];
  constraints: readonly SchemaConstraintObservation[];
};

const pgDialect = new PgDialect();

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function objectKey(value: Pick<DrizzleSchemaObjectObservation, "kind" | "schema" | "name">): string {
  return `${value.kind}:${value.schema}.${value.name}`;
}

function duplicateLocators(
  values: readonly { readonly locator: string }[],
): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.locator)) duplicates.add(value.locator);
    else seen.add(value.locator);
  }
  return [...duplicates].sort(compareText);
}

function renderSql(value: unknown): string {
  return pgDialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function drizzleDefaultSql(column: DrizzleColumnLike): string | null {
  if (column.hasDefault !== true || column.default === undefined) return null;
  if (
    typeof column.default === "object"
    && column.default !== null
    && "getSQL" in column.default
  ) {
    return renderSql(column.default);
  }
  if (typeof column.default === "string") return quoteSqlString(column.default);
  if (
    typeof column.default === "number"
    || typeof column.default === "bigint"
    || typeof column.default === "boolean"
  ) {
    return String(column.default);
  }
  const sqlType = column.getSQLType();
  if (sqlType === "json" || sqlType === "jsonb") {
    return `${quoteSqlString(JSON.stringify(column.default))}::${sqlType}`;
  }
  if (sqlType.endsWith("[]") && Array.isArray(column.default)) {
    const contents = column.default.map((item) =>
      String(item).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    ).join(",");
    return quoteSqlString(`{${contents}}`);
  }
  const serialized = JSON.stringify(column.default);
  if (serialized === undefined) {
    throw new Error(`Unsupported Drizzle default for column ${column.name}`);
  }
  return serialized;
}

function columnObservation(
  object: Pick<MutableObjectObservation, "kind" | "schema" | "name">,
  column: DrizzleColumnLike,
): DrizzleColumnObservation {
  const locator = `${object.schema}.${object.name}.${column.name}`;
  return {
    id: `db.${locator}`,
    surface: "db",
    locator,
    kind: object.kind,
    schema: object.schema,
    objectName: object.name,
    columnName: column.name,
    sqlType: column.getSQLType(),
    notNull: column.notNull === true,
    generated: column.generated !== undefined,
    defaultSql: drizzleDefaultSql(column),
    primaryKey: column.primary === true,
  };
}

function sortedRecord(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => compareText(left, right)),
  );
}

function tableConstraintObservations(
  table: Parameters<typeof getTableConfig>[0],
): readonly SchemaConstraintObservation[] {
  const config = getTableConfig(table);
  const schema = config.schema ?? "public";
  const tableLocator = `${schema}.${config.name}`;
  const constraints: SchemaConstraintObservation[] = [];

  const inlinePrimaryKeyColumns = config.columns
    .filter((column) => column.primary)
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
  for (const primaryKey of config.primaryKeys) {
    constraints.push({
      locator: `${tableLocator}#primary_key`,
      tableLocator,
      kind: "primary_key",
      name: primaryKey.getName(),
      columns: primaryKey.columns.map((column) => column.name),
    });
  }

  for (const column of config.columns.filter((item) => item.isUnique)) {
    const name = column.uniqueName ?? null;
    constraints.push({
      locator: `${tableLocator}#unique_constraint:${name ?? "unnamed"}`,
      tableLocator,
      kind: "unique_constraint",
      name,
      columns: [column.name],
      nullsNotDistinct: column.uniqueType === "nulls not distinct",
    });
  }
  for (const uniqueConstraint of config.uniqueConstraints) {
    const name = uniqueConstraint.getName() ?? null;
    constraints.push({
      locator: `${tableLocator}#unique_constraint:${name ?? "unnamed"}`,
      tableLocator,
      kind: "unique_constraint",
      name,
      columns: uniqueConstraint.columns.map((column) => column.name),
      nullsNotDistinct: uniqueConstraint.nullsNotDistinct,
    });
  }

  for (const index of config.indexes.filter((item) => item.config.unique)) {
    const name = index.config.name ?? null;
    const indexColumns = index.config.columns.map((column): IndexColumnSemantics => {
      if (
        typeof column === "object"
        && column !== null
        && "indexConfig" in column
      ) {
        const indexed = column as {
          readonly name?: string;
          readonly indexConfig?: {
            readonly order?: string;
            readonly nulls?: string;
          };
        };
        return {
          expression: indexed.name ?? "",
          isExpression: false,
          asc: indexed.indexConfig?.order !== "desc",
          nulls: indexed.indexConfig?.nulls ?? "last",
        };
      }
      return {
        expression: renderSql(column),
        isExpression: true,
        asc: true,
        nulls: "last",
      };
    });
    constraints.push({
      locator: `${tableLocator}#unique_index:${name ?? "unnamed"}`,
      tableLocator,
      kind: "unique_index",
      name,
      columns: indexColumns.map((column) => column.expression),
      indexColumns,
      where: index.config.where === undefined
        ? null
        : renderSql(index.config.where),
      method: index.config.method ?? "btree",
      concurrently: index.config.concurrently === true,
      with: sortedRecord(index.config.with),
    });
  }

  for (const foreignKey of config.foreignKeys) {
    const reference = foreignKey.reference();
    const foreignConfig = getTableConfig(reference.foreignTable);
    const name = foreignKey.getName();
    constraints.push({
      locator: `${tableLocator}#foreign_key:${name}`,
      tableLocator,
      kind: "foreign_key",
      name,
      columns: reference.columns.map((column) => column.name),
      referencedTable:
        `${foreignConfig.schema ?? "public"}.${foreignConfig.name}`,
      referencedColumns: reference.foreignColumns.map((column) => column.name),
      onDelete: foreignKey.onDelete ?? "no action",
      onUpdate: foreignKey.onUpdate ?? "no action",
    });
  }

  return constraints.sort((left, right) => compareText(left.locator, right.locator));
}

function tableObservation(
  exportName: string,
  value: unknown,
): MutableObjectObservation | undefined {
  if (!isTable(value)) return undefined;
  const config = getTableConfig(value);
  return {
    kind: "table",
    schema: config.schema ?? "public",
    name: config.name,
    exportNames: [exportName],
    isExisting: false,
    source: value,
    columns: Object.values(getTableColumns(value)) as DrizzleColumnLike[],
    constraints: tableConstraintObservations(value),
  };
}

function viewObservation(
  exportName: string,
  value: unknown,
): MutableObjectObservation | undefined {
  if (!is(value, PgView)) return undefined;
  const config = getViewConfig(value);
  return {
    kind: "view",
    schema: config.schema ?? "public",
    name: config.name,
    exportNames: [exportName],
    isExisting: config.isExisting,
    source: value,
    columns: Object.values(config.selectedFields) as DrizzleColumnLike[],
    constraints: [],
  };
}

/**
 * Enumerate the current Drizzle schema without opening a database connection.
 *
 * The caller supplies the schema module so this Node-only scanner remains
 * reusable in fixtures and does not pull `@nautilo/db` into the browser-safe
 * package entry point.
 */
export function inventoryDrizzleSchema(
  schemaExports: Readonly<Record<string, unknown>>,
): DrizzleSchemaInventory {
  const byObject = new Map<string, MutableObjectObservation>();

  for (const exportName of Object.keys(schemaExports).sort(compareText)) {
    const value = schemaExports[exportName];
    const observation = tableObservation(exportName, value)
      ?? viewObservation(exportName, value);
    if (!observation) continue;

    const key = objectKey(observation);
    const existing = byObject.get(key);
    if (!existing) {
      byObject.set(key, observation);
      continue;
    }
    if (existing.source !== observation.source) {
      throw new Error(
        `Conflicting Drizzle schema object: ${observation.kind} `
        + `${observation.schema}.${observation.name}`,
      );
    }
    existing.exportNames.push(exportName);
  }

  const internalObjects = [...byObject.values()].sort((left, right) =>
    compareText(left.schema, right.schema)
    || compareText(left.name, right.name)
    || compareText(left.kind, right.kind)
  );
  const columns = internalObjects
    .flatMap((object) => object.columns.map((column) => columnObservation(object, column)))
    .sort((left, right) => compareText(left.locator, right.locator));

  const duplicateColumns = new Set<string>();
  for (let index = 1; index < columns.length; index += 1) {
    if (columns[index - 1]!.locator === columns[index]!.locator) {
      duplicateColumns.add(columns[index]!.locator);
    }
  }
  if (duplicateColumns.size > 0) {
    throw new Error(
      `Duplicate Drizzle column locators: ${[...duplicateColumns].sort(compareText).join(", ")}`,
    );
  }
  const constraints = internalObjects
    .flatMap((object) => object.constraints)
    .sort((left, right) => compareText(left.locator, right.locator));
  const duplicateConstraints = duplicateLocators(constraints);
  if (duplicateConstraints.length > 0) {
    throw new Error(
      `Duplicate Drizzle constraint locators: ${duplicateConstraints.join(", ")}`,
    );
  }

  return {
    objects: internalObjects.map((object) => ({
      id: `db.${object.schema}.${object.name}`,
      surface: "db",
      locator: `${object.schema}.${object.name}`,
      kind: object.kind,
      schema: object.schema,
      name: object.name,
      exportNames: [...object.exportNames].sort(compareText),
      isExisting: object.isExisting,
    })),
    columns,
    constraints,
  };
}
