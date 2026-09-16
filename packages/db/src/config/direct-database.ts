import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { resolveInstance } from "@nautilo/config";
import * as schema from "../schema/index";

export { resolveAppDatabaseConnectionString, getSharedDirectDb } from "./database";

export type DirectDatabase = ReturnType<typeof createDirectDb>;
export type OfflineDirectDatabase = ReturnType<typeof createOfflineDirectDb>;
type CompilableOfflineDirectQuery = Readonly<{
  toSQL(): Readonly<{ sql: string; params: unknown[] }>;
  getSelectedFields?(): Readonly<Record<string, unknown>> | undefined;
}>;
export type OfflineDirectQuery<Result = unknown> =
  & CompilableOfflineDirectQuery
  & Readonly<{
    _: Readonly<{ result: Result }>;
  }>;
type OfflineDirectQuerySelectedFields<Query extends OfflineDirectQuery> =
  Query["_"] extends Readonly<{ selectedFields: infer Fields }>
    ? NonNullable<Fields>
    : Readonly<Record<never, never>>;
type OfflineDirectResultFieldName<
  SelectionKey extends PropertyKey,
  Field,
> = Field extends Readonly<{ fieldAlias: string }>
  ? SelectionKey
  : Field extends Readonly<{ _: Readonly<{ name: infer Name extends string }> }>
    ? Name
  : SelectionKey;
type NormalizeOfflineDirectQueryRow<
  Row,
  Fields,
  UnknownValue,
> =
  Row extends Readonly<Record<string, unknown>>
    ? Readonly<{
      [Key in keyof Row as OfflineDirectResultFieldName<
        Key,
        Key extends keyof Fields ? Fields[Key] : unknown
      >]: unknown extends Row[Key] ? UnknownValue : Row[Key];
    }>
    : never;
export type OfflineDirectQueryRow<
  Query extends OfflineDirectQuery,
  UnknownValue = unknown,
> =
  Query["_"]["result"] extends readonly (infer Row)[]
    ? NormalizeOfflineDirectQueryRow<
      Row,
      OfflineDirectQuerySelectedFields<Query>,
      UnknownValue
    >
    : never;

/**
 * Build schema-typed Drizzle statements without opening or owning a database
 * connection. Role-verified transport adapters use this compiler when they
 * must keep execution on their existing restricted handle.
 */
export function createOfflineDirectDb() {
  return drizzle.mock({ schema });
}

/**
 * Compile a Drizzle statement for a raw transport while preserving the
 * driver's result-column contract. Drizzle maps selection keys itself during
 * normal execution, but a raw executor only sees PostgreSQL column labels.
 */
export function compileOfflineDirectQuery(
  query: CompilableOfflineDirectQuery,
): Readonly<{ sql: string; params: unknown[] }> {
  const fields = query.getSelectedFields?.();
  if (fields) {
    const resultNames = new Set<string>();
    for (const [selectionKey, field] of Object.entries(fields)) {
      const resultName = offlineResultFieldName(field);
      if (resultName === undefined) {
        throw new TypeError(
          "Offline Drizzle result fields must have stable PostgreSQL column labels",
        );
      }
      if (offlineResultFieldAlias(field) && resultName !== selectionKey) {
        throw new TypeError(
          `Offline Drizzle aliased result field "${selectionKey}" must compile as the same PostgreSQL column label`,
        );
      }
      if (resultNames.has(resultName)) {
        throw new TypeError(
          `Offline Drizzle result field label "${resultName}" must be unique`,
        );
      }
      resultNames.add(resultName);
    }
  }
  return query.toSQL();
}

function offlineResultFieldAlias(field: unknown): boolean {
  return typeof field === "object" && field !== null && "fieldAlias" in field;
}

function offlineResultFieldName(field: unknown): string | undefined {
  if (typeof field !== "object" || field === null) return undefined;
  if ("fieldAlias" in field && typeof field.fieldAlias === "string") {
    return field.fieldAlias;
  }
  if ("name" in field && typeof field.name === "string") return field.name;
  return undefined;
}

/**
 * Direct Postgres URL for migrations, seeds, and Drizzle over `postgres-js`.
 *
 * Precedence: **`DB_DIRECT_CONNECTION`** env → `resolveInstance().db.directConnection`.
 */
export function resolveDirectDatabaseConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env["DB_DIRECT_CONNECTION"]?.trim();
  if (raw) return raw;
  return resolveInstance(env).db.directConnection;
}

/**
 * Create a Drizzle client over the direct Postgres wire protocol.
 * Used by migrations, seed scripts, persistence queries, and integration tests.
 */
export function createDirectDb(maxConnections = 5) {
  const conn = resolveDirectDatabaseConnectionString();
  const sql = postgres(conn, { max: maxConnections });
  const db = drizzle(sql, { schema });
  return Object.assign(db, {
    end: (options?: { timeout?: number }) => sql.end(options),
  });
}
