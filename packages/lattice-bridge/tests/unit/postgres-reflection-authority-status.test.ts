import { describe, expect, test } from "bun:test";
import { sql, type DirectDatabase } from "@nautilo/db";
import { PgDialect } from "drizzle-orm/pg-core";

import { readPostgresReflectionAuthorityStatus } from
  "../../src/server/reflection/postgres-authority-status.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const SINCE = new Date("2026-09-08T12:00:00.000Z");

function productDatabase(selectionSql?: Record<string, string>): DirectDatabase {
  const rows = [{
    verified_authority: "9007199254740993",
    reconciliation_pending: "4",
    retirement_pending: "5",
    terminal_or_stale: "6",
    verified_authority_window: "7",
    stale_window: "8",
  }];
  const select = (fields: Record<string, unknown>) => {
    if (selectionSql !== undefined) {
      for (const [field, expression] of Object.entries(fields)) {
        selectionSql[field] = new PgDialect().sqlToQuery(
          expression as Parameters<PgDialect["sqlToQuery"]>[0],
        ).sql;
      }
    }
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where"]) builder[method] = () => builder;
    builder["getSQL"] = () => sql``;
    builder["then"] = (
      resolve: (value: unknown[]) => unknown,
      reject: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return builder;
  };
  return { select } as unknown as DirectDatabase;
}

async function cryptoConnection(): Promise<Readonly<{
  connection: CryptoPostgresConnection;
  queries: { statement: string; parameters: readonly DatabaseScalar[] }[];
}>> {
  const queries: { statement: string; parameters: readonly DatabaseScalar[] }[] = [];
  const connection: CryptoPostgresConnection = {
    query: async <Row extends DatabaseRow = DatabaseRow>(
      statement: string,
      parameters: readonly DatabaseScalar[] = [],
    ): Promise<readonly Row[]> => {
      queries.push({ statement, parameters: [...parameters] });
      if (statement.includes("current_user::text")) {
        return [{
          current_user: "nautilo_crypto",
          session_user: "nautilo_crypto",
        }] as unknown as readonly Row[];
      }
      if (statement.includes("finished_at")) {
        return [{ count: "9" }] as unknown as readonly Row[];
      }
      return [
        { state: "awaiting_recipient", count: "1" },
        { state: "awaiting_device", count: "2" },
        { state: "grant_ready", count: "3" },
        { state: "claimed", count: "4" },
        { state: "running", count: "5" },
        { state: "publication_reconciliation", count: "6" },
      ] as unknown as readonly Row[];
    },
    transaction: async <Result>(
      callback: (transaction: CryptoPostgresConnection) => Promise<Result>,
    ) => callback(connection),
  };
  return { connection, queries };
}

describe("readPostgresReflectionAuthorityStatus", () => {
  test("classifies only authority-maintenance ledger and receipt aggregates", async () => {
    const crypto = await cryptoConnection();
    const handle = await verifyCryptoPostgresHandle(crypto.connection);
    const selectionSql: Record<string, string> = {};
    const status = await readPostgresReflectionAuthorityStatus({
      product: productDatabase(selectionSql),
      crypto: handle,
      now: NOW,
      since: SINCE,
      until: NOW,
    });

    expect(status).toEqual({
      dtoVersion: 1,
      scope: "authority_maintenance_only",
      current: {
        awaitingRecipient: "1",
        awaitingEligibleDeviceAndKeys: "2",
        readyOrRunning: "12",
        reconciliationPending: "10",
        retirementPending: "5",
        verifiedAuthority: "9007199254740993",
        terminalOrStale: "6",
      },
      last24h: {
        verifiedAuthority: "7",
        terminalOrStale: "17",
      },
    });
    const aggregateQueries = crypto.queries.filter((query) =>
      !query.statement.includes("current_user::text")
    );
    expect(aggregateQueries).toHaveLength(2);
    for (const query of aggregateQueries) {
      expect(query.parameters).toContain("reflection");
      expect(query.parameters).toContain("reflection.authority_reproject");
      expect(query.parameters).toContain("reflection.publication_reconcile");
      expect(query.parameters).not.toContain("stenographer.extraction");
    }
    for (const field of [
      "verified_authority",
      "reconciliation_pending",
      "verified_authority_window",
    ]) {
      const statement = selectionSql[field];
      expect(statement).toContain("target_crypto_object_id");
      expect(statement).toContain("target_representation_generation");
      expect(statement).toContain("target_access_namespace_ids");
      expect(statement).toContain("target_audience_set_commitment");
    }
    for (const field of ["terminal_or_stale", "stale_window"]) {
      const statement = selectionSql[field];
      expect(statement).toContain("target_crypto_object_id");
      expect(statement).toContain("target_representation_generation");
      expect(statement).not.toContain("target_access_namespace_ids");
      expect(statement).not.toContain("target_audience_set_commitment");
    }
    expect(selectionSql["retirement_pending"]).toContain("'quarantined'");
    expect(selectionSql["retirement_pending"]).toContain("target_crypto_retired_at");
    expect(selectionSql["reconciliation_pending"]).toContain(
      "IN ('crypto_complete', 'attached')",
    );
    expect(selectionSql["reconciliation_pending"]).not.toContain("pending', 'leased");
  });

  test("rejects an invalid observation window before querying", async () => {
    const crypto = await cryptoConnection();
    const handle = await verifyCryptoPostgresHandle(crypto.connection);
    let failure: unknown;
    try {
      await readPostgresReflectionAuthorityStatus({
        product: productDatabase(),
        crypto: handle,
        now: NOW,
        since: new Date(NOW.getTime() + 1),
        until: NOW,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe(
      "Invalid Reflection authority status window",
    );
  });
});
