import { describe, expect, test } from "bun:test";
import { cryptoDomains, eq, memories, sql } from "@nautilo/db";

import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresRow,
} from "../../src/server/product-postgres";

function connection(
  currentRole: string,
  sessionRole: string,
): RecordProductPostgresConnection {
  return {
    async query<Row extends RecordProductPostgresRow>() {
      return [{
        current_role: currentRole,
        session_role: sessionRole,
      }] as unknown as readonly Row[];
    },
    async transaction<Result>(callback: (transaction: RecordProductPostgresConnection) => Promise<Result>) {
      return callback(this);
    },
  };
}

describe("Record product PostgreSQL role verification", () => {
  test("passes homogeneous schema array parameters to the product executor", async () => {
    let received: readonly unknown[] | undefined;
    const executor = {
      async query<Row extends RecordProductPostgresRow>(
        _statement: string,
        parameters?: readonly import("../../src/server/product-postgres").RecordProductPostgresScalar[],
      ) {
        received = parameters;
        return [] as readonly Row[];
      },
    };

    const result = executeTypedRecordProductQuery(
      executor,
      recordProductTypedDb.select({
        participants: cryptoDomains.participants,
      }).from(cryptoDomains).where(eq(
        cryptoDomains.participants,
        ["one", "two"],
      )),
    );
    await result;

    expect(received).toEqual(['{"one","two"}']);
    const typedRows: Promise<
      readonly Readonly<{ participants: string[] }>[]
    > = result;
    void typedRows;
    // @ts-expect-error The result shape must come from the Drizzle selection.
    const unrelatedRows: Promise<readonly { unrelated: string }[]> = result;
    void unrelatedRows;

    const fullSelection = executeTypedRecordProductQuery(
      executor,
      recordProductTypedDb.select().from(memories),
    );
    const rawLabelRows: Promise<
      readonly Readonly<{ content_revision: number }>[]
    > = fullSelection;
    void rawLabelRows;
    // @ts-expect-error Raw execution does not apply Drizzle's camel-case mapping.
    const mappedLabelRows: Promise<
      readonly Readonly<{ contentRevision: number }>[]
    > = fullSelection;
    void mappedLabelRows;

    const aliasedSelection = executeTypedRecordProductQuery(
      executor,
      recordProductTypedDb.select({
        domain_id: sql<string>`${cryptoDomains.id}`.as("domain_id"),
      }).from(cryptoDomains),
    );
    const exactAliasRows: Promise<
      readonly Readonly<{ domain_id: string }>[]
    > = aliasedSelection;
    void exactAliasRows;
    const aliasedRows = await aliasedSelection;
    void aliasedRows[0]?.domain_id;
    // @ts-expect-error The raw result exposes only the declared SQL alias.
    void aliasedRows[0]?.unrelated;
  });

  test("accepts only a direct nautilo product connection", async () => {
    const handle = await verifyRecordProductPostgresHandle(
      connection("nautilo", "nautilo"),
    );

    expect(handle.role).toBe("nautilo");
    expect(() => assertVerifiedRecordProductPostgresHandle(handle)).not.toThrow();
  });

  test.each([
    ["nautilo", "postgres"],
    ["nautilo_agent", "nautilo_agent"],
    ["nautilo_crypto", "nautilo_crypto"],
  ])("rejects current=%s session=%s", async (currentRole, sessionRole) => {
    let rejected: unknown;
    try {
      await verifyRecordProductPostgresHandle(
        connection(currentRole, sessionRole),
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(TypeError);
    expect((rejected as Error).message).toContain("invalid direct role");
  });
});
