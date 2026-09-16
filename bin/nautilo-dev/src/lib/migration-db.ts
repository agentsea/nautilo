/**
 * M053: real `MigrationDb` implementation backed by `createDirectDb(1)`.
 *
 * Matches the seed/queries pattern (`createDirectDb` + explicit `end()`
 * in a `finally`) and uses `db.select(...).from(users)` rather than the
 * relational query API the codebase doesn't use.
 *
 * Tests substitute their own `MigrationDb` and never touch this file —
 * keeps the unit tests free of any postgres/drizzle dependency.
 */
import {
  createDirectDb,
  users,
  markMigrationTempPasswordRequired as markMigrationTempPasswordRequiredQuery,
  markPasswordChangeRequired,
  PASSWORD_CHANGE_REASON,
  and,
  eq,
  isNull,
  isNotNull,
  sql,
} from "@nautilo/db";
import type { MigrationDb, MigrationUser } from "./logto-migration";

export function createMigrationDb(): MigrationDb {
  const db = createDirectDb(1);
  let ended = false;
  return {
    listLocalUsers: async (onlyMissingExternalId: boolean) => {
      const externalIdPredicate = onlyMissingExternalId
        ? isNull(users.externalId)
        : isNotNull(users.externalId);
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          handle: users.handle,
          externalId: users.externalId,
        })
        .from(users)
        .where(and(externalIdPredicate, isNull(users.server)));
      return rows.map(toMigrationUser);
    },
    setExternalId: async (userId, externalId) => {
      await db
        .update(users)
        .set({ externalId })
        .where(eq(users.id, userId));
    },
    clearAllExternalIds: async () => {
      const result = await db
        .update(users)
        .set({ externalId: null })
        .where(and(isNotNull(users.externalId), isNull(users.server)))
        .returning({ id: users.id });
      return result.length;
    },
    findLocalUserByEmail: async (email: string) => {
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          handle: users.handle,
          externalId: users.externalId,
        })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.server)))
        .limit(1);
      const first = rows[0];
      return first ? toMigrationUser(first) : null;
    },
    findLocalUsersByEmail: async (email: string) => {
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          handle: users.handle,
          externalId: users.externalId,
        })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.server)));
      return rows.map(toMigrationUser);
    },
    findLocalUsersByHandle: async (handle: string) => {
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          handle: users.handle,
          externalId: users.externalId,
        })
        .from(users)
        .where(and(eq(users.handle, handle), isNull(users.server)));
      return rows.map(toMigrationUser);
    },
    findLocalUserById: async (userId: string) => {
      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          handle: users.handle,
          externalId: users.externalId,
        })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.server)))
        .limit(1);
      const first = rows[0];
      return first ? toMigrationUser(first) : null;
    },
    markOperatorPasswordResetRequired: async (userId: string) => {
      await markPasswordChangeRequired(db, {
        userId,
        reason: PASSWORD_CHANGE_REASON.OPERATOR_RESET,
      });
    },
    hasExternalIdColumn: async () => {
      const result = await db.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'external_id'`,
      );
      const rows = extractRows<{ column_name: string }>(result);
      return rows.length > 0;
    },
    hasLogtoAccountSecurityTable: async () => {
      const result = await db.execute<{ reg: string | null }>(
        sql`SELECT to_regclass('public.logto_account_security')::text AS reg`,
      );
      const rows = extractRows<{ reg: string | null }>(result);
      return Boolean(rows[0]?.reg);
    },
    markMigrationTempPasswordRequired: async (userId) => {
      await markMigrationTempPasswordRequiredQuery(db, userId);
    },
    backfillUserHandleIfNull: async (userId, handle) => {
      await db
        .update(users)
        .set({ handle })
        .where(
          and(
            eq(users.id, userId),
            isNull(users.handle),
            isNull(users.server),
          ),
        );
    },
    listUsersInHandleCollisionGroups: async () => {
      const result = await db.execute<{
        id: string;
        name: string;
        email: string | null;
        handle: string | null;
        external_id: string | null;
      }>(sql`
        SELECT u.id, u.name, u.email, u.handle, u.external_id
        FROM users u
        WHERE u.server IS NULL
          AND u.handle IS NOT NULL
          AND TRIM(u.handle::text) <> ''
          AND LOWER(TRIM(u.handle::text)) IN (
            SELECT LOWER(TRIM(handle::text)) AS hk
            FROM users
            WHERE server IS NULL
              AND handle IS NOT NULL
              AND TRIM(handle::text) <> ''
            GROUP BY LOWER(TRIM(handle::text))
            HAVING COUNT(*)::int > 1
          )
      `);
      const rows = extractRows<{
        id: string;
        name: string;
        email: string | null;
        handle: string | null;
        external_id: string | null;
      }>(result);
      return rows.map((r) =>
        toMigrationUser({
          id: r.id,
          name: r.name,
          email: r.email,
          handle: r.handle,
          externalId: r.external_id,
        }),
      );
    },
    end: async () => {
      if (ended) return;
      ended = true;
      await db.end();
    },
  };
}

function toMigrationUser(row: {
  id: string;
  name: string;
  email: string | null;
  handle: string | null;
  externalId: string | null;
}): MigrationUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    handle: row.handle,
    externalId: row.externalId,
  };
}

/**
 * Drizzle's `db.execute(sql\`...\`)` returns the postgres-js shape, which
 * is array-like with extra metadata. Normalize to a plain row list so
 * callers don't depend on the underlying driver shape.
 */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
